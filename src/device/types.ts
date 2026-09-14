/** Shared vocabulary for the instrument. No I/O, no DOM. */

/** Channel 1 is the "main" channel, channel 2 the secondary one. */
export type ChannelId = 1 | 2;

/**
 * Waveform codes as sent in the `bw` / `dw` command.
 *
 * VERIFIED ON HARDWARE (FY3200S-24M). Codes 2, 3, 4 and 5 were read off the
 * front panel as TRGL, ARB1, ARB2 and ARB3 respectively, and code 17 as PRE11.
 *
 * This matches `atx/python-feeltech`. It does NOT match the order in which the
 * front-panel 【WAVE】 button cycles through shapes, which is where an earlier
 * version of this file went wrong: the manual's WAVE sequence lists Pulse,
 * Triangle, rising/falling sawtooth and DC at positions 2-6, but that is the
 * panel's browsing order, not the protocol's numbering. The two are unrelated.
 *
 * Consequence worth knowing: the Pulse and DC shapes reachable from the front
 * panel have no known code in this range. Do not guess at one - reach them from
 * the panel, or hunt for the code with the raw command box.
 */
export const Waveform = {
  Sine: 0,
  Square: 1,
  Triangle: 2,
  Arb1: 3,
  Arb2: 4,
  Arb3: 5,
  Arb4: 6,
  Lorentz: 7,        // PRE1
  Multitone: 8,      // PRE2
  RandomNoise: 9,    // PRE3
  Ecg: 10,           // PRE4
  Trapezoid: 11,     // PRE5
  Sinc: 12,          // PRE6
  NarrowPulse: 13,   // PRE7
  GaussNoise: 14,    // PRE8
  Am: 15,            // PRE9
  Fm: 16,            // PRE10
  Preset11: 17,      // PRE11 - present on this unit, absent from the manual
} as const;

export type WaveformCode = (typeof Waveform)[keyof typeof Waveform];

export interface WaveformInfo {
  code: WaveformCode;
  /** Shown in the UI. */
  label: string;
  /** The mnemonic the instrument's own display shows, so the page and panel agree. */
  panel: string;
  /**
   * Whether the preview canvas can draw this shape from first principles.
   * False for anything whose shape lives in the instrument rather than in a
   * formula we know - the four user slots, and the one preset the manual omits.
   */
  drawable: boolean;
  /**
   * Duty cycle only means something for some shapes. The manual documents it for
   * square and triangle, and states it is invalid for sine.
   *
   * Note the instrument stores a duty value for every waveform regardless - `cd`
   * reads back whatever you last sent even on a sine - so this flag is about
   * which control to offer, not about what the hardware will accept.
   */
  hasDuty: boolean;
}

/** Ordered for the UI: the everyday shapes, then the presets, then the user slots. */
export const WAVEFORMS: readonly WaveformInfo[] = [
  { code: Waveform.Sine,        label: 'Sine',           panel: 'SINE',  drawable: true,  hasDuty: false },
  { code: Waveform.Square,      label: 'Square',         panel: 'SQUR',  drawable: true,  hasDuty: true  },
  { code: Waveform.Triangle,    label: 'Triangle',       panel: 'TRGL',  drawable: true,  hasDuty: true  },
  { code: Waveform.Trapezoid,   label: 'Trapezoid',      panel: 'PRE5',  drawable: true,  hasDuty: false },
  { code: Waveform.NarrowPulse, label: 'Narrow pulse',   panel: 'PRE7',  drawable: true,  hasDuty: false },
  { code: Waveform.Sinc,        label: 'Sinc',           panel: 'PRE6',  drawable: true,  hasDuty: false },
  { code: Waveform.Lorentz,     label: 'Lorentz pulse',  panel: 'PRE1',  drawable: true,  hasDuty: false },
  { code: Waveform.Ecg,         label: 'ECG',            panel: 'PRE4',  drawable: true,  hasDuty: false },
  { code: Waveform.Multitone,   label: 'Multitone',      panel: 'PRE2',  drawable: true,  hasDuty: false },
  { code: Waveform.RandomNoise, label: 'Random noise',   panel: 'PRE3',  drawable: true,  hasDuty: false },
  { code: Waveform.GaussNoise,  label: 'Gaussian noise', panel: 'PRE8',  drawable: true,  hasDuty: false },
  { code: Waveform.Am,          label: 'AM',             panel: 'PRE9',  drawable: true,  hasDuty: false },
  { code: Waveform.Fm,          label: 'FM',             panel: 'PRE10', drawable: true,  hasDuty: false },
  { code: Waveform.Preset11,    label: 'Preset 11',      panel: 'PRE11', drawable: false, hasDuty: false },
  { code: Waveform.Arb1,        label: 'Arbitrary 1',    panel: 'ARB1',  drawable: false, hasDuty: false },
  { code: Waveform.Arb2,        label: 'Arbitrary 2',    panel: 'ARB2',  drawable: false, hasDuty: false },
  { code: Waveform.Arb3,        label: 'Arbitrary 3',    panel: 'ARB3',  drawable: false, hasDuty: false },
  { code: Waveform.Arb4,        label: 'Arbitrary 4',    panel: 'ARB4',  drawable: false, hasDuty: false },
];

export function waveformInfo(code: WaveformCode): WaveformInfo {
  const found = WAVEFORMS.find((w) => w.code === code);
  if (!found) throw new Error(`unknown waveform code ${code}`);
  return found;
}

/** Everything the user can set on one channel. */
export interface ChannelState {
  waveform: WaveformCode;
  frequencyHz: number;
  amplitudeVpp: number;
  offsetV: number;
  /** Percent, 0-100. Only honoured for pulse-like waveforms. */
  dutyPct: number;
  /** Degrees. Channel 2 only - channel 1 is the phase reference. */
  phaseDeg: number;
}

export interface InstrumentState {
  ch1: ChannelState;
  ch2: ChannelState;
}

export function defaultChannelState(): ChannelState {
  return {
    waveform: Waveform.Sine,
    frequencyHz: 1000,
    amplitudeVpp: 5,
    offsetV: 0,
    dutyPct: 50,
    phaseDeg: 0,
  };
}

export function defaultInstrumentState(): InstrumentState {
  const ch2 = defaultChannelState();
  // A different default on CH2 makes the two-trace preview immediately legible.
  ch2.frequencyHz = 2000;
  ch2.amplitudeVpp = 3;
  return { ch1: defaultChannelState(), ch2 };
}

/** Key for indexing InstrumentState by channel. */
export function channelKey(id: ChannelId): 'ch1' | 'ch2' {
  return id === 1 ? 'ch1' : 'ch2';
}
