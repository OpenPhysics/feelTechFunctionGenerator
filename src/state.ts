/**
 * The single source of truth for what the instrument has been told.
 *
 * Every change flows through `update`, which hands subscribers both the old and
 * new state. That is what lets main.ts diff them and transmit only the commands
 * that actually changed, instead of resending the whole instrument on every
 * keystroke.
 */

import {
  Waveform, channelKey, defaultInstrumentState,
  type ChannelId, type ChannelState, type InstrumentState, type WaveformCode,
} from './device/types.ts';
import {
  clampDuty, clampFrequency, clampOutput, clampPhase,
  DEFAULT_MODEL, FREQ_STEP_HZ, MODELS, maxFrequencyHz, type ModelId,
} from './device/limits.ts';

export interface AppState {
  instrument: InstrumentState;
  model: ModelId;
  ch1Enabled: boolean;
  ch2Enabled: boolean;
}

export type Listener = (next: AppState, prev: AppState) => void;

const STORAGE_KEY = 'fy3200s.settings.v1';

const WAVEFORM_CODES = new Set<number>(Object.values(Waveform));

function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && Object.hasOwn(MODELS, value);
}

function isWaveformCode(value: unknown): value is WaveformCode {
  return typeof value === 'number' && WAVEFORM_CODES.has(value);
}

function initialState(): AppState {
  return {
    instrument: defaultInstrumentState(),
    model: DEFAULT_MODEL,
    ch1Enabled: true,
    ch2Enabled: true,
  };
}

export class Store {
  private state: AppState = initialState();
  private listeners = new Set<Listener>();

  constructor() {
    this.restore();
  }

  get(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a mutation to a draft, then notify with both versions. */
  update(mutate: (draft: AppState) => void): void {
    const prev = this.state;
    const draft = structuredClone(prev);
    mutate(draft);
    this.normalise(draft);
    this.state = draft;
    this.persist();
    for (const listener of this.listeners) listener(draft, prev);
  }

  /** Convenience for the common case of editing one channel. */
  updateChannel(id: ChannelId, mutate: (channel: ChannelState) => void): void {
    this.update((draft) => {
      mutate(draft.instrument[channelKey(id)]);
    });
  }

  /**
   * Force every value into something the instrument can actually do.
   *
   * This runs on every update rather than at the input layer, so a value that
   * became illegal indirectly - switching sine to square with the frequency at
   * 20 MHz - is corrected too.
   */
  private normalise(draft: AppState): void {
    for (const key of ['ch1', 'ch2'] as const) {
      const ch = draft.instrument[key];
      const requestedHz = ch.frequencyHz;
      const cap = maxFrequencyHz(draft.model, ch.waveform);
      const reducedNow = Number.isFinite(requestedHz) && requestedHz > cap;
      ch.frequencyHz = clampFrequency(requestedHz, draft.model, ch.waveform);
      // A later edit that leaves the frequency sitting on the ceiling must keep
      // the banner. Comparing the stored value with the cap can never succeed,
      // because this function has already lowered it.
      if (reducedNow) ch.frequencyReduced = true;
      else if (!Number.isFinite(requestedHz) || requestedHz < cap - FREQ_STEP_HZ / 2) {
        ch.frequencyReduced = false;
      } else {
        ch.frequencyReduced = ch.frequencyReduced === true;
      }
      const levels = clampOutput(ch.amplitudeVpp, ch.offsetV);
      ch.amplitudeVpp = levels.amplitudeVpp;
      ch.offsetV = levels.offsetV;
      ch.dutyPct = clampDuty(ch.dutyPct);
      ch.phaseDeg = clampPhase(ch.phaseDeg);
    }
    // Channel 1 is the instrument's phase reference; its own phase is always 0.
    draft.instrument.ch1.phaseDeg = 0;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Private windows and blocked site data both throw here. Losing the
      // remembered settings is not worth breaking the page over.
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<AppState>;
      const merged: AppState = { ...initialState(), ...saved };
      // Guard against a stale or hand-edited payload. An unknown model makes
      // maxFrequencyHz return undefined and the next command carries NaN;
      // an unknown waveform code is the same class of failure.
      if (!merged.instrument?.ch1 || !merged.instrument?.ch2) return;
      if (!isModelId(merged.model)) return;
      if (!isWaveformCode(merged.instrument.ch1.waveform)) return;
      if (!isWaveformCode(merged.instrument.ch2.waveform)) return;
      this.normalise(merged);
      this.state = merged;
    } catch {
      // Corrupt payload: fall back to defaults rather than failing to start.
    }
  }
}
