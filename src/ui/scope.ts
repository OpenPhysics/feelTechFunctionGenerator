/**
 * Canvas preview of the commanded waveforms, drawn like an oscilloscope screen.
 *
 * This shows what the instrument has been TOLD to produce, computed from the
 * settings - it is not a measurement. There is no ADC in the path, and the
 * FY3200S has no waveform readback. The label on the screen says so, because a
 * student with a real scope beside them must not confuse the two.
 *
 * The screen stays dark in both page themes, the way instrument displays do.
 */

import { WAVEFORMS, channelKey, type ChannelId, type InstrumentState } from '../device/types.ts';
import { maxFrequencyHz, type ModelId } from '../device/limits.ts';
import { sampleVolts, shapeFor } from '../waveform.ts';

const COLORS = {
  background: '#0a0f0e',
  grid: '#1c2a27',
  gridBright: '#2b3f3a',
  axis: '#3d564f',
  text: '#7e948e',
  textBright: '#cfe0db',
  ch1: '#f2d02c',
  ch2: '#3ac9e0',
  warn: '#e8894a',
} as const;

const DIVS_X = 10;
const DIVS_Y = 8;
/** Keep the trace inside this many divisions either side of centre. */
const USABLE_DIVS_Y = 3.6;
/** How many cycles of the reference channel to show. */
const CYCLES_SHOWN = 2.5;

export interface ScopeOptions {
  model: ModelId;
  ch1Enabled: boolean;
  ch2Enabled: boolean;
}

/** Round up to the nearest 1-2-5 decade step, the way scope ranges work. */
function niceStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const decade = 10 ** Math.floor(Math.log10(value));
  const scaled = value / decade;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * decade;
}

function formatVolts(v: number): string {
  const a = Math.abs(v);
  if (a >= 1) return `${v.toFixed(a >= 10 ? 1 : 2)} V`;
  return `${(v * 1000).toFixed(a >= 0.1 ? 0 : 1)} mV`;
}

function formatSeconds(s: number): string {
  if (s >= 1) return `${s.toFixed(2)} s`;
  if (s >= 1e-3) return `${(s * 1e3).toFixed(s >= 1e-2 ? 1 : 2)} ms`;
  if (s >= 1e-6) return `${(s * 1e6).toFixed(s >= 1e-5 ? 1 : 2)} µs`;
  return `${(s * 1e9).toFixed(0)} ns`;
}

export function formatHertz(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(hz >= 1e7 ? 2 : 3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(hz >= 1e4 ? 2 : 3)} kHz`;
  if (hz >= 1) return `${hz.toFixed(2)} Hz`;
  return `${hz.toFixed(2)} Hz`;
}

export class Scope {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private phase = 0;
  private lastFrame = 0;
  private state: InstrumentState | null = null;
  private options: ScopeOptions = { model: '24M', ch1Enabled: true, ch2Enabled: true };
  private reduceMotion: boolean;
  /** Plot area in CSS pixels. */
  private plot = { x: 0, y: 0, w: 0, h: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduceMotion = query.matches;
    query.addEventListener('change', (e) => {
      this.reduceMotion = e.matches;
      if (this.reduceMotion) this.stop();
      else this.start();
      this.draw();
    });

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  update(state: InstrumentState, options: ScopeOptions): void {
    this.state = state;
    this.options = options;
    this.draw();
  }

  start(): void {
    if (this.raf || this.reduceMotion) return;
    this.lastFrame = performance.now();
    const tick = (now: number) => {
      // A slow constant drift, like a scope with the trigger slightly off. Not
      // real time: at 24 MHz a true sweep would alias into noise.
      this.phase = (this.phase + (now - this.lastFrame) / 3000) % 1;
      this.lastFrame = now;
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Leave room for the axis labels down the left and along the bottom.
    const padLeft = 52;
    const padRight = 12;
    const padTop = 26;
    const padBottom = 30;
    this.plot = {
      x: padLeft,
      y: padTop,
      w: Math.max(10, w - padLeft - padRight),
      h: Math.max(10, h - padTop - padBottom),
    };
    this.draw();
  }

  /**
   * Choose the vertical and horizontal ranges so both traces fit.
   * The reference for the timebase is channel 1 - it is the phase reference on
   * the instrument, so it is the natural thing to lock the sweep to.
   */
  private computeRanges(state: InstrumentState) {
    const { ch1Enabled, ch2Enabled } = this.options;
    let peak = 0;
    let refHz = 0;
    for (const id of [1, 2] as ChannelId[]) {
      if (id === 1 && !ch1Enabled) continue;
      if (id === 2 && !ch2Enabled) continue;
      const ch = state[channelKey(id)];
      peak = Math.max(peak, ch.amplitudeVpp / 2 + Math.abs(ch.offsetV));
      if (id === 1 || refHz === 0) refHz = ch.frequencyHz;
    }
    if (ch1Enabled) refHz = state.ch1.frequencyHz;
    if (peak === 0) peak = 1;
    if (refHz <= 0) refHz = 1;

    const voltsPerDiv = niceStep(peak / USABLE_DIVS_Y);
    const window = CYCLES_SHOWN / refHz;
    const secondsPerDiv = niceStep(window / DIVS_X);
    return { voltsPerDiv, secondsPerDiv, window: secondsPerDiv * DIVS_X, refHz };
  }

  private draw(): void {
    const { ctx } = this;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    if (!this.state) return;
    const ranges = this.computeRanges(this.state);
    this.drawGraticule(ranges.voltsPerDiv, ranges.secondsPerDiv);

    const { ch1Enabled, ch2Enabled } = this.options;
    if (ch2Enabled) this.drawTrace(2, ranges, COLORS.ch2);
    if (ch1Enabled) this.drawTrace(1, ranges, COLORS.ch1);

    this.drawReadouts(ranges);
  }

  private drawGraticule(voltsPerDiv: number, secondsPerDiv: number): void {
    const { ctx, plot } = this;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    for (let i = 1; i < DIVS_X; i++) {
      const x = Math.round(plot.x + (plot.w * i) / DIVS_X) + 0.5;
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    for (let i = 1; i < DIVS_Y; i++) {
      const y = Math.round(plot.y + (plot.h * i) / DIVS_Y) + 0.5;
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
    }
    ctx.stroke();

    // Zero-volt axis, brighter than the rest of the grid.
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    const mid = Math.round(plot.y + plot.h / 2) + 0.5;
    ctx.moveTo(plot.x, mid);
    ctx.lineTo(plot.x + plot.w, mid);
    ctx.stroke();

    ctx.strokeStyle = COLORS.gridBright;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);

    // Voltage labels down the left edge.
    ctx.fillStyle = COLORS.text;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= DIVS_Y; i++) {
      const volts = (DIVS_Y / 2 - i) * voltsPerDiv;
      const y = plot.y + (plot.h * i) / DIVS_Y;
      ctx.fillText(formatVolts(volts), plot.x - 6, y);
    }

    // Time labels along the bottom, every other division to avoid crowding.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= DIVS_X; i += 2) {
      const x = plot.x + (plot.w * i) / DIVS_X;
      ctx.fillText(formatSeconds(secondsPerDiv * i), x, plot.y + plot.h + 6);
    }
    ctx.restore();
  }

  private drawTrace(
    id: ChannelId,
    ranges: { voltsPerDiv: number; window: number },
    color: string,
  ): void {
    const state = this.state;
    if (!state) return;
    const ch = state[channelKey(id)];
    const { ctx, plot } = this;

    const info = WAVEFORMS.find((wf) => wf.code === ch.waveform);
    if (!shapeFor(ch.waveform)) {
      this.drawUndrawable(id, color, info?.label ?? 'user waveform');
      return;
    }

    const voltsToY = (v: number) =>
      plot.y + plot.h / 2 - (v / ranges.voltsPerDiv) * (plot.h / DIVS_Y);

    // Phase 1 is a full cycle; channel 2's phase setting shifts it.
    const phaseOffset = id === 2 ? ch.phaseDeg / 360 : 0;
    const cyclesInWindow = ch.frequencyHz * ranges.window;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath();

    // Two samples per pixel keeps square edges and fast traces from aliasing
    // into a ragged mess.
    const steps = Math.ceil(plot.w * 2);
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const phase = frac * cyclesInWindow + this.phase + phaseOffset;
      const volts = sampleVolts(ch.waveform, phase, ch.amplitudeVpp, ch.offsetV, ch.dutyPct);
      if (volts === null) continue;
      const x = plot.x + frac * plot.w;
      const y = voltsToY(volts);
      // Clamp rather than let a clipped trace vanish: an off-screen level still
      // tells the student the signal is out of range.
      const clamped = Math.min(plot.y + plot.h + 2, Math.max(plot.y - 2, y));
      if (!started) {
        ctx.moveTo(x, clamped);
        started = true;
      } else {
        ctx.lineTo(x, clamped);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /** The arbitrary slots: say plainly that we cannot know the shape. */
  private drawUndrawable(id: ChannelId, color: string, label: string): void {
    const { ctx, plot } = this;
    const y = plot.y + plot.h / 2 + (id === 1 ? -14 : 14);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(plot.x + 8, y);
    ctx.lineTo(plot.x + plot.w - 8, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`CH${id} ${label} - stored in the instrument, shape unknown`, plot.x + 10, y - 4);
    ctx.restore();
  }

  private drawReadouts(ranges: { voltsPerDiv: number; secondsPerDiv: number }): void {
    const state = this.state;
    if (!state) return;
    const { ctx, plot } = this;

    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(
      `${formatVolts(ranges.voltsPerDiv)}/div   ${formatSeconds(ranges.secondsPerDiv)}/div`,
      plot.x, 7,
    );

    // Per-channel summary, right-aligned along the top.
    ctx.textAlign = 'right';
    const parts: Array<[string, string]> = [];
    if (this.options.ch1Enabled) {
      parts.push([COLORS.ch1, `CH1 ${formatHertz(state.ch1.frequencyHz)}`]);
    }
    if (this.options.ch2Enabled) {
      parts.push([COLORS.ch2, `CH2 ${formatHertz(state.ch2.frequencyHz)}`]);
    }
    let right = plot.x + plot.w;
    for (const [color, text] of parts.reverse()) {
      ctx.fillStyle = color;
      ctx.fillText(text, right, 7);
      right -= ctx.measureText(text).width + 14;
    }

    // Warn when a setting is beyond what this model can actually produce. The
    // instrument itself accepts anything you send it, so this notice is the only
    // thing standing between the student and an aliased trace.
    const overspec: string[] = [];
    for (const id of [1, 2] as ChannelId[]) {
      if (id === 1 && !this.options.ch1Enabled) continue;
      if (id === 2 && !this.options.ch2Enabled) continue;
      const ch = state[channelKey(id)];
      const cap = maxFrequencyHz(this.options.model, ch.waveform);
      if (ch.frequencyHz > cap) {
        overspec.push(`CH${id} above ${formatHertz(cap)} spec for this waveform`);
      }
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = overspec.length ? COLORS.warn : COLORS.text;
    ctx.fillText(
      overspec.length ? `! ${overspec.join('  ')}` : 'commanded settings - not a measurement',
      plot.x, plot.y + plot.h + 18,
    );
    ctx.restore();
  }
}
