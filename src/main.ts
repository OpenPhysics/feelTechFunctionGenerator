/**
 * Wiring. Owns no logic of its own beyond connecting the pieces:
 *
 *   store -> diff -> transport      (only changed parameters are transmitted)
 *   store -> scope + controls       (redraw on every change)
 *
 * Everything the instrument understands lives in device/fy3200s.ts; everything
 * it can physically do lives in device/limits.ts.
 */

import {
  CMD_READ_DUTY, CMD_READ_FREQUENCY, diffAll, encodeAll, isPlausibleCommand,
  parseDutyReply, parseFrequencyReply,
} from './device/fy3200s.ts';
import { MODELS, type ModelId } from './device/limits.ts';
import { Fy3200sTransport, isWebSerialSupported, type ConnectionStatus } from './device/serial.ts';
import { Store, type AppState } from './state.ts';
import { ChannelPanel } from './ui/controls.ts';
import { CommandLog } from './ui/log.ts';
import { Scope, formatHertz } from './ui/scope.ts';

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const store = new Store();
const log = new CommandLog(need('log'));

const statusPill = need('status-pill');
const statusText = need('status-text');
const connectButton = need<HTMLButtonElement>('connect-button');
const modelSelect = need<HTMLSelectElement>('model-select');
const rawInput = need<HTMLInputElement>('raw-input');
const rawSend = need<HTMLButtonElement>('raw-send');
const readBack = need<HTMLButtonElement>('read-back');
const pushAll = need<HTMLButtonElement>('push-all');
const logClear = need<HTMLButtonElement>('log-clear');

const transport = new Fy3200sTransport({
  onStatus: (status, detail) => renderStatus(status, detail),
  onSent: (command) => log.add('tx', command),
  onReceived: (text) => log.add('rx', text.replace(/[\r\n]+/g, '')),
  onError: (message) => log.add('error', message),
});

const scope = new Scope(need<HTMLCanvasElement>('scope'));
const panels = [new ChannelPanel(store, 1), new ChannelPanel(store, 2)];
const channels = need('controls');
for (const panel of panels) channels.append(panel.root);

/* ---------------------------------------------------------------- status --- */

function renderStatus(status: ConnectionStatus, detail?: string): void {
  statusPill.classList.toggle('is-connected', status === 'connected');
  statusPill.classList.toggle('is-connecting', status === 'connecting');
  statusPill.classList.remove('is-error');

  const labels: Record<ConnectionStatus, string> = {
    unsupported: 'Web Serial unavailable',
    disconnected: 'Not connected',
    connecting: 'Connecting…',
    connected: 'Connected',
  };
  statusText.textContent = labels[status];
  connectButton.textContent = status === 'connected' ? 'Disconnect' : 'Connect';
  connectButton.disabled = status === 'connecting' || status === 'unsupported';

  const hardwareOnly = status !== 'connected';
  rawSend.disabled = hardwareOnly;
  readBack.disabled = hardwareOnly;
  pushAll.disabled = hardwareOnly;

  if (detail) log.add('info', detail);
}

/* ------------------------------------------------------------ transmitting - */

/**
 * Send only what changed.
 *
 * The instrument is on a 9600-baud link and has no output-enable command, so
 * resending every parameter on every slider tick would both flood the link and
 * needlessly re-clamp values. `diffAll` is what keeps this to one command per
 * actual change.
 */
function onStateChanged(next: AppState, prev: AppState): void {
  for (const panel of panels) panel.refresh();
  scope.update(next.instrument, {
    model: next.model,
    ch1Enabled: next.ch1Enabled,
    ch2Enabled: next.ch2Enabled,
  });
  modelSelect.value = next.model;

  if (!transport.isConnected) return;
  // A model change alters the legal ranges but not the instrument's own state,
  // so resend everything to make the hardware agree with the clamped values.
  const commands = next.model === prev.model
    ? diffAll(prev.instrument, next.instrument, next.model)
    : encodeAll(next.instrument, next.model);
  transport.enqueueAll(commands);
}

store.subscribe(onStateChanged);

/* ------------------------------------------------------------------ events - */

connectButton.addEventListener('click', () => {
  if (transport.isConnected) {
    void transport.disconnect();
    return;
  }
  // No await before requestPort: the browser only shows the picker while the
  // click is still considered a user gesture.
  transport.connect().then(
    () => {
      // A click that arrived while a reconnect was already opening the port
      // returns without starting a second open. Only the attempt that actually
      // connected should push settings.
      if (!transport.isConnected) return;
      log.add('info', 'connected at 9600 baud, 8N1');
      // The instrument has no way to report its waveform, amplitude or offset,
      // so the only way to make hardware and page agree is to push our state.
      transport.enqueueAll(encodeAll(store.get().instrument, store.get().model));
    },
    (error: Error) => {
      // A cancelled picker is a normal outcome, not a failure worth shouting about.
      if (error.name === 'NotFoundError') {
        log.add('info', 'no device selected');
        return;
      }
      statusPill.classList.add('is-error');
      statusText.textContent = 'Connection failed';
      log.add('error', error.message);
    },
  );
});

modelSelect.addEventListener('change', () => {
  const model = modelSelect.value as ModelId;
  if (!(model in MODELS)) return;
  store.update((draft) => {
    draft.model = model;
  });
});

rawSend.addEventListener('click', sendRaw);
rawInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendRaw();
});

function sendRaw(): void {
  const command = rawInput.value.trim();
  if (!command) return;
  if (!isPlausibleCommand(command)) {
    log.add('error', `"${command}" is not a valid command (try bf100000, ba5.00, bw0)`);
    return;
  }
  transport.sendNow(command).then(
    () => { rawInput.value = ''; },
    (error: Error) => log.add('error', error.message),
  );
}

/**
 * Read what the instrument reports back.
 *
 * Only frequency and duty cycle can be read: the FY3200S has no readback for
 * waveform, amplitude, offset or phase. This is on a button rather than polled,
 * because these queries live in the instrument's measurement command family and
 * are best not fired continuously.
 */
readBack.addEventListener('click', () => {
  void (async () => {
    try {
      const freqReply = await transport.query(CMD_READ_FREQUENCY);
      const hz = parseFrequencyReply(freqReply);
      log.add('info', hz === null
        ? `could not read frequency (got "${freqReply}")`
        : `instrument reports channel 1 at ${formatHertz(hz)}`);

      const dutyReply = await transport.query(CMD_READ_DUTY);
      const duty = parseDutyReply(dutyReply);
      if (duty !== null) {
        log.add('info', `instrument reports channel 1 duty cycle ${duty.toFixed(1)} %`);
      }
    } catch (error) {
      log.add('error', (error as Error).message);
    }
  })();
});

pushAll.addEventListener('click', () => {
  const app = store.get();
  transport.enqueueAll(encodeAll(app.instrument, app.model));
  log.add('info', 'resent every setting');
});

logClear.addEventListener('click', () => log.clear());

/* ------------------------------------------------------------------- start - */

function start(): void {
  if (!isWebSerialSupported()) {
    need('unsupported-banner').hidden = false;
    renderStatus('unsupported');
  } else if (!window.isSecureContext) {
    // http:// on anything but localhost: the API exists but every call fails.
    need('insecure-banner').hidden = false;
  }

  const app = store.get();
  modelSelect.value = app.model;
  for (const panel of panels) panel.refresh();
  scope.update(app.instrument, {
    model: app.model,
    ch1Enabled: app.ch1Enabled,
    ch2Enabled: app.ch2Enabled,
  });
  scope.start();

  log.add('info', 'ready — click Connect and choose the USB-SERIAL CH340 device');

  // Reopen a port granted on a previous visit, so a page refresh mid-lab does
  // not mean clicking through the picker again.
  if (isWebSerialSupported()) {
    void transport.tryReconnect().then((reconnected) => {
      if (!reconnected) return;
      log.add('info', 'reconnected to a previously authorised port');
      transport.enqueueAll(encodeAll(store.get().instrument, store.get().model));
    });
  }
}

start();
