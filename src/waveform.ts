/**
 * Waveform shape maths. Pure functions, unit-testable, no canvas and no DOM.
 *
 * Each generator maps a phase in [0,1) to a value in roughly [-1,1]. The scope
 * renderer scales that by amplitude and shifts it by the DC offset, so these
 * functions only need to describe shape.
 *
 * These are honest approximations of what the instrument emits, not captures of
 * it. The four arbitrary slots and PRE11 are deliberately absent: their contents
 * live in the instrument's memory and we have no way to know them.
 */

import { Waveform, type WaveformCode } from './device/types.ts';

/** phase is in [0,1); duty is a fraction in (0,1). Returns roughly [-1,1]. */
export type ShapeFn = (phase: number, duty: number) => number;

const TAU = Math.PI * 2;

/** Deterministic value noise, so a "random" trace doesn't shimmer per frame. */
function hashNoise(x: number): number {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

const sine: ShapeFn = (p) => Math.sin(TAU * p);

const square: ShapeFn = (p, duty) => (p < duty ? 1 : -1);

/**
 * Triangle, with duty skewing the rise/fall split - which is what the
 * instrument does too: the manual shows DUTY=51% changing a TRGL wave, so duty
 * is not square-only. At duty 0.5 this is a symmetric triangle; at the extremes
 * it becomes a rising or falling sawtooth.
 */
const triangle: ShapeFn = (p, duty) => {
  const d = Math.min(0.999, Math.max(0.001, duty));
  return p < d ? (p / d) * 2 - 1 : ((1 - p) / (1 - d)) * 2 - 1;
};

/** Ramp up, hold, ramp down, hold - a trapezoid with 25% edges. */
const trapezoid: ShapeFn = (p) => {
  if (p < 0.25) return p / 0.25 * 2 - 1;
  if (p < 0.5) return 1;
  if (p < 0.75) return 1 - (p - 0.5) / 0.25 * 2;
  return -1;
};

/** A brief pulse whose width follows duty, scaled down so it reads as narrow. */
const narrowPulse: ShapeFn = (p, duty) => {
  const width = Math.min(0.5, Math.max(0.01, duty * 0.2));
  return p < width ? 1 : -1;
};

/** sin(x)/x centred in the cycle, over +/- 4 pi. */
const sinc: ShapeFn = (p) => {
  const x = (p - 0.5) * 8 * Math.PI;
  if (Math.abs(x) < 1e-6) return 1;
  return Math.sin(x) / x;
};

/** Lorentzian (Cauchy) pulse, centred, normalised to peak 1. */
const lorentz: ShapeFn = (p) => {
  const x = (p - 0.5) * 20;
  return 2 / (1 + x * x) - 1;
};

/** Crude synthetic PQRST complex - recognisable rather than clinical. */
const ecg: ShapeFn = (p) => {
  const bump = (centre: number, width: number, height: number) =>
    height * Math.exp(-((p - centre) ** 2) / (2 * width * width));
  return (
    bump(0.16, 0.022, 0.15) +   // P
    bump(0.30, 0.006, -0.18) +  // Q
    bump(0.33, 0.007, 1.0) +    // R
    bump(0.37, 0.008, -0.28) +  // S
    bump(0.55, 0.040, 0.26) -   // T
    0.08
  );
};

/** Fundamental plus two quieter harmonics. */
const multitone: ShapeFn = (p) =>
  (Math.sin(TAU * p) + 0.5 * Math.sin(TAU * 3 * p) + 0.33 * Math.sin(TAU * 5 * p)) / 1.83;

const randomNoise: ShapeFn = (p) => hashNoise(p * 997);

/** Box-Muller from two decorrelated hash samples, clipped to the screen. */
const gaussNoise: ShapeFn = (p) => {
  const u1 = (hashNoise(p * 613) + 1) / 2 || 1e-6;
  const u2 = (hashNoise(p * 1021 + 7) + 1) / 2;
  const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
  return Math.max(-1, Math.min(1, g / 3));
};

/** 100% modulated AM: a carrier inside an envelope. */
const am: ShapeFn = (p) =>
  Math.sin(TAU * 12 * p) * (0.5 + 0.5 * Math.sin(TAU * p));

/** FM: carrier frequency swept by a sine. */
const fm: ShapeFn = (p) => Math.sin(TAU * 8 * p + 3 * Math.sin(TAU * p));

const SHAPES: Partial<Record<WaveformCode, ShapeFn>> = {
  [Waveform.Sine]: sine,
  [Waveform.Square]: square,
  [Waveform.Triangle]: triangle,
  [Waveform.Trapezoid]: trapezoid,
  [Waveform.NarrowPulse]: narrowPulse,
  [Waveform.Sinc]: sinc,
  [Waveform.Lorentz]: lorentz,
  [Waveform.Ecg]: ecg,
  [Waveform.Multitone]: multitone,
  [Waveform.RandomNoise]: randomNoise,
  [Waveform.GaussNoise]: gaussNoise,
  [Waveform.Am]: am,
  [Waveform.Fm]: fm,
};

/** The shape function for a waveform, or null for the arbitrary/user slots. */
export function shapeFor(code: WaveformCode): ShapeFn | null {
  return SHAPES[code] ?? null;
}

/**
 * Sample a waveform in volts.
 *
 * @param phase     position in the cycle, [0,1)
 * @param amplitude peak-to-peak volts (the instrument specifies Vpp)
 * @param offset    DC offset in volts
 * @param dutyPct   duty cycle in percent
 */
export function sampleVolts(
  code: WaveformCode, phase: number, amplitude: number, offset: number, dutyPct: number,
): number | null {
  const shape = shapeFor(code);
  if (!shape) return null;
  const wrapped = phase - Math.floor(phase);
  // Shape returns +/-1 which is the full peak-to-peak swing, so half the Vpp.
  return shape(wrapped, dutyPct / 100) * (amplitude / 2) + offset;
}
