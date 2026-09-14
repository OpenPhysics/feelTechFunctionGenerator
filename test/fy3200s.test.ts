import { describe, expect, it } from 'vitest';
import {
  COMMAND_INTERVAL_MS, commandKey, diffAll, diffChannel, encodeAll,
  encodeAmplitude, encodeChannel, encodeDuty, encodeFrequency, encodeOffset,
  encodePhase, encodeWaveform, isPlausibleCommand,
} from '../src/device/fy3200s.ts';
import {
  clampFrequency, maxFrequencyHz, clampAmplitude, clampOffset, clampDuty,
  clampPhase, quantize,
} from '../src/device/limits.ts';
import {
  WAVEFORMS, Waveform, defaultChannelState, defaultInstrumentState, type ChannelState,
} from '../src/device/types.ts';
import { sampleVolts, shapeFor } from '../src/waveform.ts';

describe('frequency encoding', () => {
  it('sends centihertz', () => {
    expect(encodeFrequency(1, 1000)).toBe('bf100000');
    expect(encodeFrequency(1, 1)).toBe('bf100');
    expect(encodeFrequency(1, 0.01)).toBe('bf1');
  });

  it('uses the d prefix for channel 2', () => {
    expect(encodeFrequency(2, 1000)).toBe('df100000');
  });

  it('rounds to the 10 mHz resolution rather than emitting a fraction', () => {
    expect(encodeFrequency(1, 1.234)).toBe('bf123');
    expect(encodeFrequency(1, 24_000_000)).toBe('bf2400000000');
  });
});

describe('amplitude, offset, duty, phase encoding', () => {
  it('formats amplitude to the 10 mV resolution', () => {
    expect(encodeAmplitude(1, 5)).toBe('ba5.00');
    expect(encodeAmplitude(1, 0.44)).toBe('ba0.44');
    expect(encodeAmplitude(2, 20)).toBe('da20.00');
  });

  it('keeps the sign on a negative offset', () => {
    expect(encodeOffset(1, -2.5)).toBe('bo-2.50');
    expect(encodeOffset(1, 0)).toBe('bo0.00');
    expect(encodeOffset(2, 10)).toBe('do10.00');
  });

  it('sends duty cycle in tenths of a percent', () => {
    expect(encodeDuty(1, 50)).toBe('bd500');
    expect(encodeDuty(1, 99.9)).toBe('bd999');
    expect(encodeDuty(2, 25.5)).toBe('dd255');
  });

  it('refuses to set phase on channel 1, which is the reference', () => {
    expect(() => encodePhase(1, 90)).toThrow(/channel 2 only/);
    expect(encodePhase(2, 90)).toBe('dp90');
    expect(encodePhase(2, 0)).toBe('dp0');
  });

  it('encodes waveform codes', () => {
    expect(encodeWaveform(1, Waveform.Sine)).toBe('bw0');
    expect(encodeWaveform(1, Waveform.Square)).toBe('bw1');
    expect(encodeWaveform(2, Waveform.Triangle)).toBe('dw3');
  });
});

describe('waveform code table', () => {
  it('follows the instrument manual, not python-feeltech', () => {
    // python-feeltech claims 2=triangle and 3..6=arb1..4. The panel's own WAVE
    // order says otherwise; getting this wrong emits the wrong shape entirely.
    expect(Waveform.Pulse).toBe(2);
    expect(Waveform.Triangle).toBe(3);
    expect(Waveform.RiseSawtooth).toBe(4);
    expect(Waveform.FallSawtooth).toBe(5);
    expect(Waveform.Dc).toBe(6);
  });

  it('places the presets at PREn = n + 6, verified up to PRE11', () => {
    // dw17 displayed PRE11 on the hardware, which pins the whole run: PRE1 = 7.
    expect(Waveform.Lorentz).toBe(7);        // PRE1
    expect(Waveform.Preset11).toBe(17);      // PRE11
  });

  it('does not guess at the ARB1-ARB4 codes', () => {
    // The manual implies ARB1 = 17, but 17 is PRE11 on this unit. Shipping a
    // guess would silently select the wrong waveform.
    const labels = WAVEFORMS.map((w) => w.label);
    expect(labels.some((l) => l.startsWith('Arbitrary'))).toBe(false);
  });

  it('keeps the PRE1-PRE10 presets on 7..16, the one range the library agrees on', () => {
    expect(Waveform.Lorentz).toBe(7);
    expect(Waveform.Fm).toBe(16);
  });

  it('exposes every code in the UI list exactly once', () => {
    const codes = WAVEFORMS.map((w) => w.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(Object.keys(Waveform).length);
  });

  it('keeps drawable and shapeFor in agreement for every entry', () => {
    for (const info of WAVEFORMS) {
      expect(shapeFor(info.code) === null).toBe(!info.drawable);
    }
  });

  it('labels each entry with the mnemonic the panel shows', () => {
    for (const info of WAVEFORMS) expect(info.panel).toMatch(/^[A-Z0-9]+$/);
  });
});

describe('waveform shapes', () => {
  it('scales by half the peak-to-peak amplitude and adds the offset', () => {
    // A sine at its quarter-cycle peak with 10 Vpp should reach +5 V.
    expect(sampleVolts(Waveform.Sine, 0.25, 10, 0, 50)).toBeCloseTo(5, 6);
    expect(sampleVolts(Waveform.Sine, 0.75, 10, 0, 50)).toBeCloseTo(-5, 6);
    expect(sampleVolts(Waveform.Sine, 0.25, 10, 2.5, 50)).toBeCloseTo(7.5, 6);
  });

  it('honours duty on a square wave', () => {
    expect(sampleVolts(Waveform.Square, 0.1, 10, 0, 25)).toBeCloseTo(5, 6);
    expect(sampleVolts(Waveform.Square, 0.4, 10, 0, 25)).toBeCloseTo(-5, 6);
  });

  it('outputs a steady level for DC, set entirely by the offset', () => {
    for (const phase of [0, 0.25, 0.5, 0.9]) {
      expect(sampleVolts(Waveform.Dc, phase, 10, 3, 50)).toBeCloseTo(3, 6);
    }
  });

  it('runs the sawtooths in opposite directions', () => {
    const rise = sampleVolts(Waveform.RiseSawtooth, 0.9, 10, 0, 50)!;
    const fall = sampleVolts(Waveform.FallSawtooth, 0.9, 10, 0, 50)!;
    expect(rise).toBeGreaterThan(0);
    expect(fall).toBeLessThan(0);
    expect(rise).toBeCloseTo(-fall, 6);
  });

  it('wraps phase, so continuous animation never runs off the end', () => {
    expect(sampleVolts(Waveform.Sine, 1.25, 10, 0, 50))
      .toBeCloseTo(sampleVolts(Waveform.Sine, 0.25, 10, 0, 50)!, 6);
    expect(sampleVolts(Waveform.Sine, -0.75, 10, 0, 50))
      .toBeCloseTo(sampleVolts(Waveform.Sine, 0.25, 10, 0, 50)!, 6);
  });

  it('returns null for an unknown preset rather than inventing a shape', () => {
    expect(sampleVolts(Waveform.Preset11, 0.3, 10, 0, 50)).toBeNull();
  });

  it('keeps every drawable shape inside the peak-to-peak envelope', () => {
    for (const info of WAVEFORMS.filter((w) => w.drawable)) {
      for (let i = 0; i < 64; i++) {
        const v = sampleVolts(info.code, i / 64, 10, 0, 50);
        expect(v).not.toBeNull();
        // Allow a little headroom: sinc and ECG overshoot slightly by design.
        expect(Math.abs(v!)).toBeLessThanOrEqual(6.5);
      }
    }
  });
});

describe('limits', () => {
  it('lets only sine reach the model ceiling', () => {
    expect(maxFrequencyHz('24M', Waveform.Sine)).toBe(24_000_000);
    expect(maxFrequencyHz('24M', Waveform.Square)).toBe(6_000_000);
    expect(maxFrequencyHz('24M', Waveform.Triangle)).toBe(6_000_000);
    expect(maxFrequencyHz('24M', Waveform.Preset11)).toBe(6_000_000);
  });

  it('caps sine at the model, not at 24 MHz universally', () => {
    expect(maxFrequencyHz('6M', Waveform.Sine)).toBe(6_000_000);
    expect(maxFrequencyHz('25M', Waveform.Sine)).toBe(25_000_000);
  });

  it('clamps a request above the waveform ceiling', () => {
    expect(clampFrequency(20_000_000, '24M', Waveform.Square)).toBe(6_000_000);
    expect(clampFrequency(20_000_000, '24M', Waveform.Sine)).toBe(20_000_000);
  });

  it('clamps below the resolution floor', () => {
    expect(clampFrequency(0, '24M', Waveform.Sine)).toBe(0.01);
    expect(clampFrequency(-5, '24M', Waveform.Sine)).toBe(0.01);
  });

  it('clamps amplitude, offset and duty to the datasheet ranges', () => {
    expect(clampAmplitude(50)).toBe(20);
    expect(clampAmplitude(0)).toBe(0.01);
    expect(clampOffset(-99)).toBe(-10);
    expect(clampOffset(99)).toBe(10);
    expect(clampDuty(0)).toBe(0.1);
    expect(clampDuty(100)).toBe(99.9);
  });

  it('wraps phase instead of clamping it', () => {
    expect(clampPhase(370)).toBe(10);
    expect(clampPhase(-90)).toBe(270);
    expect(clampPhase(360)).toBe(0);
  });

  it('survives NaN from an empty numeric input', () => {
    expect(clampAmplitude(NaN)).toBe(0.01);
    expect(clampPhase(NaN)).toBe(0);
    expect(clampFrequency(NaN, '24M', Waveform.Sine)).toBe(0.01);
  });

  it('quantizes without float dust', () => {
    expect(quantize(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(quantize(1.006, 0.01)).toBe(1.01);
    expect(quantize(1.004, 0.01)).toBe(1);
  });
});

describe('channel sync', () => {
  it('sends waveform before frequency so the clamp is applied correctly', () => {
    const state = { ...defaultChannelState(), waveform: Waveform.Square };
    const cmds = encodeChannel(1, state, '24M');
    expect(cmds[0]).toBe('bw1');
    expect(cmds[1]).toBe('bf100000');
  });

  it('omits duty for waveforms where it is meaningless', () => {
    const sine = encodeChannel(1, defaultChannelState(), '24M');
    expect(sine.some((c) => c.startsWith('bd'))).toBe(false);

    const square = encodeChannel(1, { ...defaultChannelState(), waveform: Waveform.Square }, '24M');
    expect(square).toContain('bd500');
  });

  it('sets phase on channel 2 only', () => {
    expect(encodeChannel(1, defaultChannelState(), '24M').some((c) => c.includes('p'))).toBe(false);
    expect(encodeChannel(2, defaultChannelState(), '24M')).toContain('dp0');
  });

  it('syncs both channels', () => {
    const cmds = encodeAll(defaultInstrumentState(), '24M');
    expect(cmds.filter((c) => c.startsWith('b')).length).toBeGreaterThan(0);
    expect(cmds.filter((c) => c.startsWith('d')).length).toBeGreaterThan(0);
  });
});

describe('diffing', () => {
  const base: ChannelState = defaultChannelState();

  it('sends nothing when nothing changed', () => {
    expect(diffChannel(1, base, { ...base }, '24M')).toEqual([]);
  });

  it('sends one command for one changed parameter', () => {
    expect(diffChannel(1, base, { ...base, frequencyHz: 2000 }, '24M')).toEqual(['bf200000']);
    expect(diffChannel(1, base, { ...base, amplitudeVpp: 1 }, '24M')).toEqual(['ba1.00']);
  });

  it('resends frequency on a waveform change, because the ceiling moved', () => {
    const highSine = { ...base, waveform: Waveform.Sine, frequencyHz: 20_000_000 };
    const highSquare = { ...highSine, waveform: Waveform.Square };
    const cmds = diffChannel(1, highSine, highSquare, '24M');
    expect(cmds).toEqual(['bw1', 'bf600000000', 'bd500']);
  });

  it('ignores a change below the instrument resolution', () => {
    // 1000.000 Hz vs 1000.001 Hz both quantize to the same centiHz.
    expect(diffChannel(1, base, { ...base, frequencyHz: 1000.001 }, '24M')).toEqual([]);
  });

  it('diffs the whole instrument', () => {
    const prev = defaultInstrumentState();
    const next = structuredClone(prev);
    next.ch2.phaseDeg = 90;
    expect(diffAll(prev, next, '24M')).toEqual(['dp90']);
  });
});

describe('write queue helpers', () => {
  it('keys commands by channel and parameter so newer values supersede older', () => {
    expect(commandKey('bf100000')).toBe('1:f');
    expect(commandKey('bf200000')).toBe('1:f');
    expect(commandKey('df200000')).toBe('2:f');
    expect(commandKey('ba5.00')).toBe('1:a');
    expect(commandKey('dp90')).toBe('2:p');
  });

  it('paces commands without being slower than the hardware needs', () => {
    // Measured on the instrument: 15/15 five-command batches landed with a 0 ms
    // gap, so this is a safety margin, not a hardware requirement. Keep it small
    // enough that a slider feels live.
    expect(COMMAND_INTERVAL_MS).toBeGreaterThan(0);
    expect(COMMAND_INTERVAL_MS).toBeLessThanOrEqual(50);
  });

  it('validates hand-typed raw commands', () => {
    expect(isPlausibleCommand('bf100000')).toBe(true);
    expect(isPlausibleCommand('bo-2.50')).toBe(true);
    expect(isPlausibleCommand('ce')).toBe(true);
    expect(isPlausibleCommand('')).toBe(false);
    expect(isPlausibleCommand('rm -rf /')).toBe(false);
    expect(isPlausibleCommand('BF100000')).toBe(false);
  });
});
