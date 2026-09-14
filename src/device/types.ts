/** Shared vocabulary for the instrument. No I/O, no DOM. */

/** Channel 1 is the "main" channel, channel 2 the secondary one. */
export type ChannelId = 1 | 2;

/**
 * Waveform codes as sent in the `bw` / `dw` command.
 *
 * Taken from the instrument's own 【WAVE】 toggle order in the FY3200S manual,
 * where each shape is shown with the mnemonic the panel displays (SINE, SQUR,
 * PULS, TRGL, STW, NSTW, DC, then PRE1-PRE10, then ARB1-ARB4).
 *
 * NOTE: this deliberately disagrees with the widely-used `atx/python-feeltech`
 * library, which has `TRIANGLE = 2` and `ARB1..4 = 3..6`. The manual puts Pulse
 * at 2, Triangle at 3, the two sawtooths at 4 and 5, DC at 6, and the arbitrary
 * slots at 17-20. The manual is corroborated by the PRE1-PRE10 labels landing
 * exactly on 7-16, which is the one range the library agrees about. See
 * docs/PROTOCOL.md for the hardware verification.
 */
export const Waveform = {
  Sine: 0,
  Square: 1,
  Pulse: 2,
  Triangle: 3,
  RiseSawtooth: 4,
  FallSawtooth: 5,
  Dc: 6,
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
  Preset11: 17,      // PRE11 - exists on this unit but not in the manual
} as const;

export type WaveformCode = (typeof Waveform)[keyof typeof Waveform];

export interface WaveformInfo {
  code: WaveformCode;
  /** Shown in the UI. */
  label: string;
  /** The mnemonic the instrument's own display shows, so the page and the panel agree. */
  panel: string;
  /**
   * Whether the preview canvas can draw this shape from first principles.
   * False for anything whose shape lives in the instrument rather than in a
   * formula we know.
   */
  drawable: boolean;
  /** Duty cycle only means something for pulse-like shapes. */
  hasDuty: boolean;
}

/**
 * Ordered for the UI: the shapes a student actually reaches for come first,
 * then the exotic presets.
 *
 * The ARB1-ARB4 user slots are deliberately absent. The manual implies they
 * follow PRE10 at code 17, but code 17 displays PRE11 on this unit, so the
 * presets run past the manual's abridged list and the arbitrary slots are at
 * some higher code we have not identified. Offering a guess would select the
 * wrong waveform silently; the raw command box is the honest way to reach them.
 */
export const WAVEFORMS: readonly WaveformInfo[] = [
  { code: Waveform.Sine,         label: 'Sine',           panel: 'SINE',  drawable: true,  hasDuty: false },
  { code: Waveform.Square,       label: 'Square',         panel: 'SQUR',  drawable: true,  hasDuty: true  },
  { code: Waveform.Triangle,     label: 'Triangle',       panel: 'TRGL',  drawable: true,  hasDuty: true  },
  { code: Waveform.Pulse,        label: 'Pulse',          panel: 'PULS',  drawable: true,  hasDuty: true  },
  { code: Waveform.RiseSawtooth, label: 'Rising sawtooth',panel: 'STW',   drawable: true,  hasDuty: false },
  { code: Waveform.FallSawtooth, label: 'Falling sawtooth',panel: 'NSTW', drawable: true,  hasDuty: false },
  { code: Waveform.Dc,           label: 'DC level',       panel: 'DC',    drawable: true,  hasDuty: false },
  { code: Waveform.Trapezoid,    label: 'Trapezoid',      panel: 'PRE5',  drawable: true,  hasDuty: false },
  { code: Waveform.NarrowPulse,  label: 'Narrow pulse',   panel: 'PRE7',  drawable: true,  hasDuty: true  },
  { code: Waveform.Sinc,         label: 'Sinc',           panel: 'PRE6',  drawable: true,  hasDuty: false },
  { code: Waveform.Lorentz,      label: 'Lorentz pulse',  panel: 'PRE1',  drawable: true,  hasDuty: false },
  { code: Waveform.Ecg,          label: 'ECG',            panel: 'PRE4',  drawable: true,  hasDuty: false },
  { code: Waveform.Multitone,    label: 'Multitone',      panel: 'PRE2',  drawable: true,  hasDuty: false },
  { code: Waveform.RandomNoise,  label: 'Random noise',   panel: 'PRE3',  drawable: true,  hasDuty: false },
  { code: Waveform.GaussNoise,   label: 'Gaussian noise', panel: 'PRE8',  drawable: true,  hasDuty: false },
  { code: Waveform.Am,           label: 'AM',             panel: 'PRE9',  drawable: true,  hasDuty: false },
  { code: Waveform.Fm,           label: 'FM',             panel: 'PRE10', drawable: true,  hasDuty: false },
  { code: Waveform.Preset11,     label: 'Preset 11',      panel: 'PRE11', drawable: false, hasDuty: false },
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
