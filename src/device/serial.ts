/**
 * Web Serial transport for the FY3200S. The only module that touches hardware.
 *
 * Two behaviours verified against the instrument shape this file (see
 * docs/PROTOCOL.md):
 *
 *   1. Setting commands are never acknowledged. Nothing may wait for a reply
 *      after a write, or the UI deadlocks.
 *   2. Query replies carry NO line terminator - `cf` answers with exactly
 *      `cf0000100000` and stops. So the reader cannot split on '\n'; it
 *      collects bytes and settles on a short idle gap instead.
 */

import {
  BAUD_RATE, COMMAND_INTERVAL_MS, TERMINATOR, USB_PRODUCT_ID, USB_VENDOR_ID,
  commandKey,
} from './fy3200s.ts';

export type ConnectionStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected';

export interface TransportHandlers {
  onStatus?(status: ConnectionStatus, detail?: string): void;
  /** Every command actually put on the wire. Drives the on-screen log. */
  onSent?(command: string): void;
  /** Raw text received, for the log. */
  onReceived?(text: string): void;
  onError?(message: string): void;
}

/** Milliseconds of silence that marks the end of an unterminated reply. */
const REPLY_IDLE_MS = 80;
/** Give up on a query after this long. */
const REPLY_TIMEOUT_MS = 700;

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

interface QueueEntry {
  key: string;
  command: string;
}

export class Fy3200sTransport {
  private port: SerialPort | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;

  /** Bytes received since the last query started. */
  private rxBuffer = '';
  private rxNotify: (() => void) | null = null;

  private queue: QueueEntry[] = [];
  private draining = false;
  /** Serialises queries against the drain loop so they never interleave. */
  private busy: Promise<unknown> = Promise.resolve();

  private status: ConnectionStatus = 'disconnected';

  constructor(private handlers: TransportHandlers = {}) {
    if (isWebSerialSupported()) {
      navigator.serial.addEventListener('disconnect', this.handleUnplug);
    }
  }

  get isConnected(): boolean {
    return this.status === 'connected';
  }

  get connectionStatus(): ConnectionStatus {
    return isWebSerialSupported() ? this.status : 'unsupported';
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }

  private handleUnplug = (event: Event): void => {
    // Only care if it was OUR port that vanished.
    if (this.port && (event as { target?: unknown }).target === this.port) {
      void this.teardown('the instrument was unplugged');
    }
  };

  /**
   * Show the browser's port picker and open the chosen port.
   *
   * MUST be called synchronously from a user gesture - `requestPort` throws if
   * the browser no longer considers the call user-initiated, so never put an
   * `await` between the click and this call.
   */
  async connect(): Promise<void> {
    if (!isWebSerialSupported()) {
      this.setStatus('unsupported');
      throw new Error('This browser has no Web Serial API. Use Chrome or Edge on desktop.');
    }
    this.setStatus('connecting');
    try {
      const port = await navigator.serial.requestPort({
        // Narrow the picker to the CH340 bridge inside the FY3200S, so students
        // are not choosing between every COM port on the machine.
        filters: [{ usbVendorId: USB_VENDOR_ID, usbProductId: USB_PRODUCT_ID }],
      });
      await this.openPort(port);
    } catch (error) {
      this.setStatus('disconnected');
      throw asError(error);
    }
  }

  /**
   * Reopen a port the user already granted on a previous visit, with no picker.
   * Returns false when there is nothing to reconnect to.
   */
  async tryReconnect(): Promise<boolean> {
    if (!isWebSerialSupported()) return false;
    const ports = await navigator.serial.getPorts();
    const match = ports.find((p) => {
      const info = p.getInfo();
      return info.usbVendorId === USB_VENDOR_ID && info.usbProductId === USB_PRODUCT_ID;
    });
    if (!match) return false;
    try {
      this.setStatus('connecting');
      await this.openPort(match);
      return true;
    } catch {
      this.setStatus('disconnected');
      return false;
    }
  }

  private async openPort(port: SerialPort): Promise<void> {
    await port.open({
      baudRate: BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    this.port = port;
    this.writer = port.writable?.getWriter() ?? null;
    if (!this.writer) throw new Error('serial port is not writable');
    this.readLoop = this.pumpReader();
    // The CH340 needs a moment after open, and the instrument drops a command
    // sent immediately after the port comes up.
    await delay(300);
    this.setStatus('connected');
  }

  private async pumpReader(): Promise<void> {
    if (!this.port?.readable) return;
    const decoder = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.length) {
          const text = decoder.decode(value, { stream: true });
          this.rxBuffer += text;
          this.handlers.onReceived?.(text);
          this.rxNotify?.();
        }
      }
    } catch (error) {
      // A read error during teardown is expected; report anything else.
      if (this.status === 'connected') {
        this.handlers.onError?.(asError(error).message);
      }
    } finally {
      try {
        this.reader?.releaseLock();
      } catch { /* already released */ }
      this.reader = null;
    }
  }

  async disconnect(): Promise<void> {
    await this.teardown();
  }

  private async teardown(detail?: string): Promise<void> {
    this.queue = [];
    const port = this.port;
    this.port = null;
    try {
      this.writer?.releaseLock();
    } catch { /* ignore */ }
    this.writer = null;
    try {
      await this.reader?.cancel();
    } catch { /* ignore */ }
    try {
      await this.readLoop;
    } catch { /* ignore */ }
    this.readLoop = null;
    try {
      await port?.close();
    } catch { /* ignore */ }
    this.setStatus('disconnected', detail);
  }

  /**
   * Queue a command, replacing any queued command for the same parameter.
   *
   * This coalescing is what makes sliders usable: a drag produces dozens of
   * values, but only the one the user landed on needs to reach a 9600-baud
   * link. Superseded values are dropped rather than transmitted and overwritten.
   */
  enqueue(command: string): void {
    const key = commandKey(command);
    const existing = this.queue.findIndex((e) => e.key === key);
    if (existing >= 0) {
      this.queue[existing] = { key, command };
    } else {
      this.queue.push({ key, command });
    }
    void this.drain();
  }

  /** Queue several commands, preserving their relative order. */
  enqueueAll(commands: readonly string[]): void {
    for (const command of commands) this.enqueue(command);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.isConnected) {
        // Re-read length each pass: entries can be replaced while we wait.
        const entry = this.queue.shift();
        if (!entry) break;
        await this.serialise(() => this.writeRaw(entry.command));
        await delay(COMMAND_INTERVAL_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Run `fn` with exclusive access to the port. */
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    // Swallow rejections on the chain itself so one failure cannot poison it.
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async writeRaw(command: string): Promise<void> {
    if (!this.writer) throw new Error('not connected');
    const bytes = new TextEncoder().encode(command + TERMINATOR);
    await this.writer.write(bytes);
    this.handlers.onSent?.(command);
  }

  /** Send a command immediately, bypassing the coalescing queue. */
  async sendNow(command: string): Promise<void> {
    await this.serialise(() => this.writeRaw(command));
    await delay(COMMAND_INTERVAL_MS);
  }

  /**
   * Send a query and collect its reply.
   *
   * The instrument answers queries with a bare, unterminated string, so we
   * gather bytes until the line goes quiet for REPLY_IDLE_MS rather than
   * waiting for a delimiter that never comes.
   */
  async query(command: string): Promise<string> {
    return this.serialise(async () => {
      this.rxBuffer = '';
      await this.writeRaw(command);

      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      let lastLength = -1;
      for (;;) {
        const settled = this.rxBuffer.length > 0 && this.rxBuffer.length === lastLength;
        if (settled || Date.now() > deadline) break;
        lastLength = this.rxBuffer.length;
        await this.waitForBytes(REPLY_IDLE_MS);
      }
      return this.rxBuffer.trim();
    });
  }

  /** Resolve as soon as bytes arrive, or after `ms` of silence. */
  private waitForBytes(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.rxNotify = null;
        resolve();
      }, ms);
      this.rxNotify = () => {
        clearTimeout(timer);
        this.rxNotify = null;
        resolve();
      };
    });
  }

  /** Commands still waiting to go out - the UI shows this as backpressure. */
  get pendingCount(): number {
    return this.queue.length;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
