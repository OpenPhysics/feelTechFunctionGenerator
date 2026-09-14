/**
 * Instrument limits, from the FY3200S Series User's Manual specification table
 * (see docs/PROTOCOL.md for the extract).
 *
 * The trap this file exists to prevent: on EVERY model in the series, only the
 * sine wave reaches the model's headline frequency. Square, triangle, pulse and
 * arbitrary are capped at 6 MHz regardless of whether you bought the 6 MHz unit
 * or the 25 MHz one. A UI that offers 24 MHz square would be lying.
 */

import { Waveform, type WaveformCode } from './types.ts';

/** Model variants, keyed by the number on the front panel. */
export const MODELS = {
  '6M': 6_000_000,
  '12M': 12_000_000,
  '20M': 20_000_000,
  '24M': 24_000_000,
  '25M': 25_000_000,
} as const;

export type ModelId = keyof typeof MODELS;

/** Ours. */
export const DEFAULT_MODEL: ModelId = '24M';

/** Every waveform other than sine is limited to this, on all models. */
const NON_SINE_MAX_HZ = 6_000_000;

/** Hard floor. The manual quotes 0 Hz but resolution is 10 mHz. */
export const MIN_FREQ_HZ = 0.01;

/** Frequency resolution: 0.01 Hz, i.e. the centiHz the wire format uses. */
export const FREQ_STEP_HZ = 0.01;

export const MIN_AMPLITUDE_VPP = 0.01; // 10 mVpp
export const MAX_AMPLITUDE_VPP = 20;   // 20 Vpp, no load
export const AMPLITUDE_STEP_V = 0.01;  // 10 mV resolution

export const MAX_OFFSET_V = 10;        // +/- 10 V
export const OFFSET_STEP_V = 0.01;     // 0.01 V resolution

export const MIN_DUTY_PCT = 0.1;
export const MAX_DUTY_PCT = 99.9;
export const DUTY_STEP_PCT = 0.1;

export const MIN_PHASE_DEG = 0;
export const MAX_PHASE_DEG = 359;
export const PHASE_STEP_DEG = 1;

/**
 * Highest frequency this model can actually produce for this waveform.
 * Sine gets the model's full range; everything else is capped at 6 MHz.
 */
export function maxFrequencyHz(model: ModelId, waveform: WaveformCode): number {
  return waveform === Waveform.Sine
    ? MODELS[model]
    : Math.min(MODELS[model], NON_SINE_MAX_HZ);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Round to a multiple of `step`, avoiding float dust like 0.30000000000000004. */
export function quantize(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

export function clampFrequency(
  hz: number, model: ModelId, waveform: WaveformCode,
): number {
  return quantize(
    clamp(hz, MIN_FREQ_HZ, maxFrequencyHz(model, waveform)),
    FREQ_STEP_HZ,
  );
}

export function clampAmplitude(vpp: number): number {
  return quantize(clamp(vpp, MIN_AMPLITUDE_VPP, MAX_AMPLITUDE_VPP), AMPLITUDE_STEP_V);
}

export function clampOffset(volts: number): number {
  return quantize(clamp(volts, -MAX_OFFSET_V, MAX_OFFSET_V), OFFSET_STEP_V);
}

export function clampDuty(pct: number): number {
  return quantize(clamp(pct, MIN_DUTY_PCT, MAX_DUTY_PCT), DUTY_STEP_PCT);
}

export function clampPhase(deg: number): number {
  // Phase wraps rather than clamps - 370 degrees is 10 degrees, not 359.
  if (Number.isNaN(deg)) return 0;
  const wrapped = ((Math.round(deg) % 360) + 360) % 360;
  return wrapped;
}
