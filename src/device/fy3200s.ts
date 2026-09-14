/**
 * FY3200S wire protocol: pure string building, no I/O.
 *
 * Keeping this module free of `navigator.serial` is what makes the whole
 * protocol testable in CI with no instrument attached. src/device/serial.ts is
 * the only file allowed to actually transmit.
 *
 * Wire format: ASCII, one command per line, terminated by \n, at 9600 8N1.
 * Channel 1 commands are prefixed `b`, channel 2 `d`. The unit does not
 * acknowledge setting commands - see docs/PROTOCOL.md.
 */

import {
  channelKey, waveformInfo,
  type ChannelId, type ChannelState, type InstrumentState, type WaveformCode,
} from './types.ts';
import {
  clampAmplitude, clampDuty, clampFrequency, clampOffset, clampPhase,
  type ModelId,
} from './limits.ts';

export const BAUD_RATE = 9600;

/** Line terminator the instrument expects. */
export const TERMINATOR = '\n';

/**
 * Milliseconds to leave between commands.
 *
 * Measured, not guessed: the unit landed 15/15 five-command batches with a 0 ms
 * gap, and bursts of 8 frequency changes never dropped one. The 9600-baud link
 * is itself the rate limiter (~1 ms per character). The libraries in the wild
 * are far more cautious than the hardware needs - python-feeltech waits 50 ms,
 * sds1004x_bode 500 ms. 20 ms is a safety margin over a measured zero, and
 * keeps the on-screen command log readable.
 */
export const COMMAND_INTERVAL_MS = 20;

/** USB IDs of the CH340 bridge inside the FY3200S, to filter the port picker. */
export const USB_VENDOR_ID = 0x1a86;
export const USB_PRODUCT_ID = 0x7523;

function prefix(channel: ChannelId): 'b' | 'd' {
  return channel === 1 ? 'b' : 'd';
}

/**
 * Frequency travels as an integer count of centihertz (0.01 Hz units), which is
 * exactly the instrument's 10 mHz resolution.
 *
 * 1 kHz -> 100000 -> "bf100000"
 */
export function encodeFrequency(channel: ChannelId, hz: number): string {
  const centiHz = Math.round(hz * 100);
  return `${prefix(channel)}f${centiHz}`;
}

/** Amplitude in volts peak-to-peak, two decimals (10 mV resolution). */
export function encodeAmplitude(channel: ChannelId, vpp: number): string {
  return `${prefix(channel)}a${vpp.toFixed(2)}`;
}

/** DC offset in volts, two decimals, signed. */
export function encodeOffset(channel: ChannelId, volts: number): string {
  return `${prefix(channel)}o${volts.toFixed(2)}`;
}

/** Duty cycle in tenths of a percent: 50.0 % -> 500 -> "bd500". */
export function encodeDuty(channel: ChannelId, pct: number): string {
  return `${prefix(channel)}d${Math.round(pct * 10)}`;
}

export function encodeWaveform(channel: ChannelId, code: WaveformCode): string {
  return `${prefix(channel)}w${code}`;
}

/**
 * Phase in whole degrees. Channel 1 is the phase reference on this instrument,
 * so only channel 2 has a meaningful phase - passing channel 1 is a programming
 * error rather than something to silently ignore.
 */
export function encodePhase(channel: ChannelId, deg: number): string {
  if (channel !== 2) {
    throw new Error('phase is settable on channel 2 only; channel 1 is the reference');
  }
  return `dp${Math.round(deg)}`;
}

/**
 * Query commands - the only ones the instrument answers. Replies echo the
 * command then a zero-padded value, with NO line terminator.
 *
 * These are undocumented in the manual and absent from every library I found;
 * they were discovered by enumerating the `c` prefix against the hardware.
 */
/** Read back channel 1 frequency. Reply: `cf` + 10 digits of centihertz. */
export const CMD_READ_FREQUENCY = 'cf';
/** Read back channel 1 duty cycle. Reply: `cd` + 3 digits of tenths-of-percent. */
export const CMD_READ_DUTY = 'cd';
/** Trigger a measurement on the external counter input. */
export const CMD_COUNTER_TRIGGER = 'ce';
/** Read the external counter. Reply: `cc` + 10 digits. */
export const CMD_COUNTER_READ = 'cc';
/**
 * Returns a constant (`ct06` on our unit) regardless of any setting, so it
 * serves as a cheap "is there really an FY3200S on this port?" handshake.
 */
export const CMD_IDENTIFY = 'ct';

/** True if `reply` looks like this instrument answering CMD_IDENTIFY. */
export function isIdentityReply(reply: string): boolean {
  // Accept any numeric suffix: the digits may well be model-dependent, and we
  // only have one unit to go on.
  return /^ct\d+$/.test(reply.trim());
}

/**
 * Parse a `cf` reply into hertz. Returns null if it isn't a frequency reply.
 * `cf0000100000` -> 1000
 */
export function parseFrequencyReply(reply: string): number | null {
  const match = /^cf(\d+)$/.exec(reply.trim());
  if (!match?.[1]) return null;
  return Number(match[1]) / 100;
}

/**
 * Parse a `cd` reply into percent. Returns null if it isn't a duty reply.
 * `cd500` -> 50, `cd001` -> 0.1
 */
export function parseDutyReply(reply: string): number | null {
  const match = /^cd(\d+)$/.exec(reply.trim());
  if (!match?.[1]) return null;
  return Number(match[1]) / 10;
}

/** Parse a `cc`/`ce` counter reply. Returns null if unparseable. */
export function parseCounterReply(reply: string): number | null {
  const match = /^c[ce](\d+)$/.exec(reply.trim());
  if (!match?.[1]) return null;
  return Number(match[1]);
}

/**
 * Every command needed to put one channel into the given state, in a safe
 * order: waveform first, because the instrument clamps frequency against the
 * waveform's own ceiling (6 MHz for everything but sine).
 */
export function encodeChannel(
  channel: ChannelId, state: ChannelState, model: ModelId,
): string[] {
  const cmds = [
    encodeWaveform(channel, state.waveform),
    encodeFrequency(channel, clampFrequency(state.frequencyHz, model, state.waveform)),
    encodeAmplitude(channel, clampAmplitude(state.amplitudeVpp)),
    encodeOffset(channel, clampOffset(state.offsetV)),
  ];
  if (waveformInfo(state.waveform).hasDuty) {
    cmds.push(encodeDuty(channel, clampDuty(state.dutyPct)));
  }
  if (channel === 2) {
    cmds.push(encodePhase(2, clampPhase(state.phaseDeg)));
  }
  return cmds;
}

/** Full instrument sync - used on connect, and by the "push all settings" button. */
export function encodeAll(state: InstrumentState, model: ModelId): string[] {
  return [...encodeChannel(1, state.ch1, model), ...encodeChannel(2, state.ch2, model)];
}

/**
 * Only the commands needed to move from `prev` to `next` on one channel.
 *
 * This is what keeps a dragged slider from flooding a 9600-baud link: one
 * parameter changed, so one command goes out, not six.
 */
export function diffChannel(
  channel: ChannelId, prev: ChannelState, next: ChannelState, model: ModelId,
): string[] {
  const cmds: string[] = [];

  // Waveform leads: it can change what frequency and duty are legal.
  if (prev.waveform !== next.waveform) {
    cmds.push(encodeWaveform(channel, next.waveform));
  }

  const prevFreq = clampFrequency(prev.frequencyHz, model, prev.waveform);
  const nextFreq = clampFrequency(next.frequencyHz, model, next.waveform);
  if (prevFreq !== nextFreq || prev.waveform !== next.waveform) {
    // Resend on a waveform change too: switching sine -> square at 20 MHz
    // silently re-clamps the frequency, so the unit needs telling.
    cmds.push(encodeFrequency(channel, nextFreq));
  }

  const prevAmp = clampAmplitude(prev.amplitudeVpp);
  const nextAmp = clampAmplitude(next.amplitudeVpp);
  if (prevAmp !== nextAmp) cmds.push(encodeAmplitude(channel, nextAmp));

  const prevOff = clampOffset(prev.offsetV);
  const nextOff = clampOffset(next.offsetV);
  if (prevOff !== nextOff) cmds.push(encodeOffset(channel, nextOff));

  if (waveformInfo(next.waveform).hasDuty) {
    const prevDuty = clampDuty(prev.dutyPct);
    const nextDuty = clampDuty(next.dutyPct);
    if (prevDuty !== nextDuty || prev.waveform !== next.waveform) {
      cmds.push(encodeDuty(channel, nextDuty));
    }
  }

  if (channel === 2) {
    const prevPhase = clampPhase(prev.phaseDeg);
    const nextPhase = clampPhase(next.phaseDeg);
    if (prevPhase !== nextPhase) cmds.push(encodePhase(2, nextPhase));
  }

  return cmds;
}

/** Only the commands needed to move the whole instrument from `prev` to `next`. */
export function diffAll(
  prev: InstrumentState, next: InstrumentState, model: ModelId,
): string[] {
  return [
    ...diffChannel(1, prev.ch1, next.ch1, model),
    ...diffChannel(2, prev.ch2, next.ch2, model),
  ];
}

/**
 * Which parameter a command sets, e.g. "bf100000" -> "1:f".
 *
 * The write queue uses this to coalesce: a newer command for the same key
 * supersedes an older queued one, so dragging a slider transmits the value the
 * user landed on rather than every value they swept through.
 */
export function commandKey(command: string): string {
  const ch = command.startsWith('d') ? '2' : '1';
  const param = command.slice(1, 2);
  return `${ch}:${param}`;
}

/** Sanity-check a hand-typed raw command before letting it near the port. */
export function isPlausibleCommand(command: string): boolean {
  return /^[a-z][a-z0-9][-0-9.]*$/.test(command.trim());
}

export { channelKey };
