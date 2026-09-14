/**
 * The control panel: one block of controls per channel, plus presets.
 *
 * Each parameter gets both a slider and a numeric box. The slider is for
 * exploring - sweeping a frequency and watching what happens is the point of the
 * exercise - and the box is for the moment a student needs exactly 440 Hz.
 */

import {
  WAVEFORMS, channelKey, waveformInfo,
  type ChannelId, type ChannelState, type WaveformCode,
} from '../device/types.ts';
import {
  MAX_AMPLITUDE_VPP, MAX_DUTY_PCT, MAX_OFFSET_V, MAX_PHASE_DEG,
  MIN_AMPLITUDE_VPP, MIN_DUTY_PCT, MIN_FREQ_HZ, MIN_PHASE_DEG,
  maxFrequencyHz,
} from '../device/limits.ts';
import type { Store } from '../state.ts';
import { formatHertz } from './scope.ts';

/** Slider positions for frequency; mapped logarithmically onto the real range. */
const FREQ_SLIDER_STEPS = 1000;

/**
 * Frequency spans 0.01 Hz to 24 MHz - nine decades. A linear slider would spend
 * its whole travel above 1 MHz and make everything a student cares about
 * unreachable, so the travel is logarithmic.
 */
function freqToSlider(hz: number, maxHz: number): number {
  const lo = Math.log10(MIN_FREQ_HZ);
  const hi = Math.log10(maxHz);
  const clamped = Math.min(maxHz, Math.max(MIN_FREQ_HZ, hz));
  return Math.round(((Math.log10(clamped) - lo) / (hi - lo)) * FREQ_SLIDER_STEPS);
}

function sliderToFreq(position: number, maxHz: number): number {
  const lo = Math.log10(MIN_FREQ_HZ);
  const hi = Math.log10(maxHz);
  const hz = 10 ** (lo + (position / FREQ_SLIDER_STEPS) * (hi - lo));
  // Snap to something a human would have typed, so the readout is not
  // 999.9713 Hz when you meant a kilohertz.
  const decade = 10 ** Math.floor(Math.log10(hz));
  const snapped = Math.round(hz / (decade / 100)) * (decade / 100);
  return Math.min(maxHz, Math.max(MIN_FREQ_HZ, snapped));
}

interface SliderRowOptions {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  /** Read the current value out of channel state. */
  read: (ch: ChannelState) => number;
  /** Write a new value into channel state. */
  write: (ch: ChannelState, value: number) => void;
}

/** A label + range slider + numeric box, kept in sync with the store. */
class SliderRow {
  readonly root: HTMLDivElement;
  private slider: HTMLInputElement;
  private box: HTMLInputElement;
  private hint: HTMLSpanElement;

  constructor(
    private options: SliderRowOptions,
    private store: Store,
    private channel: ChannelId,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'control-row';

    const label = document.createElement('label');
    label.className = 'control-label';
    label.textContent = options.label;

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = String(options.min);
    this.slider.max = String(options.max);
    this.slider.step = String(options.step);
    this.slider.className = 'control-slider';
    this.slider.setAttribute('aria-label', `${options.label} slider`);

    this.box = document.createElement('input');
    this.box.type = 'number';
    this.box.min = String(options.min);
    this.box.max = String(options.max);
    this.box.step = String(options.step);
    this.box.className = 'control-box';
    this.box.setAttribute('aria-label', options.label);

    const unit = document.createElement('span');
    unit.className = 'control-unit';
    unit.textContent = options.unit;

    this.hint = document.createElement('span');
    this.hint.className = 'control-hint';

    const id = `ch${channel}-${options.label.replace(/\W+/g, '-').toLowerCase()}`;
    this.box.id = id;
    label.htmlFor = id;

    const inputs = document.createElement('div');
    inputs.className = 'control-inputs';
    inputs.append(this.slider, this.box, unit);

    this.root.append(label, inputs, this.hint);

    this.slider.addEventListener('input', () => {
      this.commit(Number(this.slider.value));
    });
    // 'change' rather than 'input': committing on every keystroke fights the
    // user, because a half-typed "1" in a "15" is a legal value that clamps.
    this.box.addEventListener('change', () => {
      this.commit(Number(this.box.value));
    });
  }

  private commit(value: number): void {
    this.store.updateChannel(this.channel, (ch) => this.options.write(ch, value));
  }

  refresh(ch: ChannelState, enabled: boolean, hint = ''): void {
    const value = this.options.read(ch);
    // Never overwrite the box while it is being typed into.
    if (document.activeElement !== this.box) {
      this.box.value = value.toFixed(this.options.decimals);
    }
    if (document.activeElement !== this.slider) {
      this.slider.value = String(value);
    }
    this.slider.disabled = !enabled;
    this.box.disabled = !enabled;
    this.root.classList.toggle('is-disabled', !enabled);
    this.hint.textContent = hint;
  }
}

/** The frequency row needs its own log-mapped slider and unit handling. */
class FrequencyRow {
  readonly root: HTMLDivElement;
  private slider: HTMLInputElement;
  private box: HTMLInputElement;
  private units: HTMLSelectElement;
  private hint: HTMLSpanElement;
  private maxHz = 24_000_000;

  constructor(private store: Store, private channel: ChannelId) {
    this.root = document.createElement('div');
    this.root.className = 'control-row';

    const label = document.createElement('label');
    label.className = 'control-label';
    label.textContent = 'Frequency';

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = String(FREQ_SLIDER_STEPS);
    this.slider.step = '1';
    this.slider.className = 'control-slider';
    this.slider.setAttribute('aria-label', 'Frequency slider, logarithmic');

    this.box = document.createElement('input');
    this.box.type = 'number';
    this.box.step = 'any';
    this.box.min = '0';
    this.box.className = 'control-box';
    const id = `ch${channel}-frequency`;
    this.box.id = id;
    label.htmlFor = id;

    this.units = document.createElement('select');
    this.units.className = 'control-unit-select';
    this.units.setAttribute('aria-label', 'Frequency unit');
    for (const [text, factor] of [['Hz', 1], ['kHz', 1e3], ['MHz', 1e6]] as const) {
      const option = document.createElement('option');
      option.value = String(factor);
      option.textContent = text;
      this.units.append(option);
    }

    this.hint = document.createElement('span');
    this.hint.className = 'control-hint';

    const inputs = document.createElement('div');
    inputs.className = 'control-inputs';
    inputs.append(this.slider, this.box, this.units);
    this.root.append(label, inputs, this.hint);

    this.slider.addEventListener('input', () => {
      this.set(sliderToFreq(Number(this.slider.value), this.maxHz));
    });
    this.box.addEventListener('change', () => {
      this.set(Number(this.box.value) * Number(this.units.value));
    });
    this.units.addEventListener('change', () => {
      // Changing the unit reinterprets the number already in the box, which is
      // what you want when you type 5 and then pick kHz.
      this.set(Number(this.box.value) * Number(this.units.value));
    });
  }

  private set(hz: number): void {
    this.store.updateChannel(this.channel, (ch) => {
      ch.frequencyHz = hz;
    });
  }

  refresh(ch: ChannelState, enabled: boolean, maxHz: number): void {
    this.maxHz = maxHz;
    if (document.activeElement !== this.slider) {
      this.slider.value = String(freqToSlider(ch.frequencyHz, maxHz));
    }
    if (document.activeElement !== this.box && document.activeElement !== this.units) {
      // Show the value in whichever unit keeps it readable.
      const factor = ch.frequencyHz >= 1e6 ? 1e6 : ch.frequencyHz >= 1e3 ? 1e3 : 1;
      this.units.value = String(factor);
      const scaled = ch.frequencyHz / factor;
      this.box.value = String(Number(scaled.toFixed(6)));
    }
    this.slider.disabled = !enabled;
    this.box.disabled = !enabled;
    this.units.disabled = !enabled;
    this.hint.textContent = `up to ${formatHertz(maxHz)} for this waveform`;
  }
}

export interface PresetDefinition {
  label: string;
  description: string;
  apply: (ch: ChannelState) => void;
}

/**
 * One-click starting points. These are the setups a demonstrator reaches for at
 * the start of a lab, and they double as a way back to something sane after a
 * student has explored into the weeds.
 */
export const PRESETS: readonly PresetDefinition[] = [
  {
    label: '1 kHz sine',
    description: '1 kHz sine at 5 Vpp, no offset - the default starting point',
    apply: (ch) => {
      ch.waveform = 0; ch.frequencyHz = 1000; ch.amplitudeVpp = 5; ch.offsetV = 0;
    },
  },
  {
    label: '440 Hz sine',
    description: 'Concert A, for anything involving audio',
    apply: (ch) => {
      ch.waveform = 0; ch.frequencyHz = 440; ch.amplitudeVpp = 2; ch.offsetV = 0;
    },
  },
  {
    label: '1 kHz square',
    description: '1 kHz square at 50% duty - for logic and timing work',
    apply: (ch) => {
      ch.waveform = 1; ch.frequencyHz = 1000; ch.amplitudeVpp = 5;
      ch.offsetV = 0; ch.dutyPct = 50;
    },
  },
  {
    label: '100 Hz triangle',
    description: 'Slow triangle, useful for sweeping a circuit by hand',
    apply: (ch) => {
      ch.waveform = 2; ch.frequencyHz = 100; ch.amplitudeVpp = 4; ch.offsetV = 0;
    },
  },
  {
    label: '0-5 V logic',
    description: '1 kHz square swinging 0 to 5 V, via a 2.5 V offset',
    apply: (ch) => {
      ch.waveform = 1; ch.frequencyHz = 1000; ch.amplitudeVpp = 5;
      ch.offsetV = 2.5; ch.dutyPct = 50;
    },
  },
];

/** All the controls for one channel. */
export class ChannelPanel {
  readonly root: HTMLElement;
  private enableBox: HTMLInputElement;
  private waveform: HTMLSelectElement;
  private frequency: FrequencyRow;
  private amplitude: SliderRow;
  private offset: SliderRow;
  private duty: SliderRow;
  private phase: SliderRow | null = null;

  constructor(private store: Store, private channel: ChannelId) {
    this.root = document.createElement('section');
    this.root.className = `channel channel-${channel}`;

    const header = document.createElement('header');
    header.className = 'channel-header';

    const title = document.createElement('h2');
    title.textContent = channel === 1 ? 'Channel 1 (main)' : 'Channel 2';

    const enableLabel = document.createElement('label');
    enableLabel.className = 'channel-toggle';
    this.enableBox = document.createElement('input');
    this.enableBox.type = 'checkbox';
    // Honest wording: the serial protocol has no output-enable command, so this
    // only governs the preview. Claiming it muted the output would be a lie.
    enableLabel.append(this.enableBox, document.createTextNode('Show in preview'));
    this.enableBox.addEventListener('change', () => {
      const on = this.enableBox.checked;
      this.store.update((draft) => {
        if (this.channel === 1) draft.ch1Enabled = on;
        else draft.ch2Enabled = on;
      });
    });

    header.append(title, enableLabel);

    const waveRow = document.createElement('div');
    waveRow.className = 'control-row';
    const waveLabel = document.createElement('label');
    waveLabel.className = 'control-label';
    waveLabel.textContent = 'Waveform';
    this.waveform = document.createElement('select');
    this.waveform.className = 'control-select';
    this.waveform.id = `ch${channel}-waveform`;
    waveLabel.htmlFor = this.waveform.id;
    for (const info of WAVEFORMS) {
      const option = document.createElement('option');
      option.value = String(info.code);
      option.textContent = info.drawable ? info.label : `${info.label} (shape unknown)`;
      this.waveform.append(option);
    }
    this.waveform.addEventListener('change', () => {
      const code = Number(this.waveform.value) as WaveformCode;
      this.store.updateChannel(this.channel, (ch) => {
        ch.waveform = code;
      });
    });
    const waveInputs = document.createElement('div');
    waveInputs.className = 'control-inputs';
    waveInputs.append(this.waveform);
    waveRow.append(waveLabel, waveInputs);

    this.frequency = new FrequencyRow(store, channel);
    this.amplitude = new SliderRow({
      label: 'Amplitude', unit: 'Vpp',
      min: MIN_AMPLITUDE_VPP, max: MAX_AMPLITUDE_VPP, step: 0.01, decimals: 2,
      read: (ch) => ch.amplitudeVpp,
      write: (ch, v) => { ch.amplitudeVpp = v; },
    }, store, channel);
    this.offset = new SliderRow({
      label: 'DC offset', unit: 'V',
      min: -MAX_OFFSET_V, max: MAX_OFFSET_V, step: 0.01, decimals: 2,
      read: (ch) => ch.offsetV,
      write: (ch, v) => { ch.offsetV = v; },
    }, store, channel);
    this.duty = new SliderRow({
      label: 'Duty cycle', unit: '%',
      min: MIN_DUTY_PCT, max: MAX_DUTY_PCT, step: 0.1, decimals: 1,
      read: (ch) => ch.dutyPct,
      write: (ch, v) => { ch.dutyPct = v; },
    }, store, channel);

    this.root.append(header, waveRow, this.frequency.root, this.amplitude.root,
      this.offset.root, this.duty.root);

    if (channel === 2) {
      this.phase = new SliderRow({
        label: 'Phase', unit: '°',
        min: MIN_PHASE_DEG, max: MAX_PHASE_DEG, step: 1, decimals: 0,
        read: (ch) => ch.phaseDeg,
        write: (ch, v) => { ch.phaseDeg = v; },
      }, store, channel);
      this.root.append(this.phase.root);
    } else {
      const note = document.createElement('p');
      note.className = 'channel-note';
      note.textContent =
        'Channel 1 is the instrument’s phase reference, so phase is set on channel 2.';
      this.root.append(note);
    }

    const presets = document.createElement('div');
    presets.className = 'presets';
    const presetLabel = document.createElement('span');
    presetLabel.className = 'control-label';
    presetLabel.textContent = 'Presets';
    presets.append(presetLabel);
    for (const preset of PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-button';
      button.textContent = preset.label;
      button.title = preset.description;
      button.addEventListener('click', () => {
        this.store.updateChannel(this.channel, (ch) => preset.apply(ch));
      });
      presets.append(button);
    }
    this.root.append(presets);
  }

  refresh(): void {
    const app = this.store.get();
    const ch = app.instrument[channelKey(this.channel)];
    const enabled = this.channel === 1 ? app.ch1Enabled : app.ch2Enabled;
    const info = waveformInfo(ch.waveform);

    this.enableBox.checked = enabled;
    if (document.activeElement !== this.waveform) {
      this.waveform.value = String(ch.waveform);
    }

    this.frequency.refresh(ch, true, maxFrequencyHz(app.model, ch.waveform));
    this.amplitude.refresh(ch, true);
    this.offset.refresh(ch, true);
    this.duty.refresh(
      ch, info.hasDuty,
      info.hasDuty ? '' : `not used for a ${info.label.toLowerCase()} wave`,
    );
    this.phase?.refresh(ch, true, 'relative to channel 1');
  }
}
