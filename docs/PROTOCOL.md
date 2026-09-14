# FY3200S serial protocol

Verified against a **FeelTech FY3200S-24M** on 2026-09-14, over its CH340
USB-serial bridge (`1a86:7523`).

Where a claim below is marked *unverified*, it comes from documentation or from
`atx/python-feeltech` and has not been confirmed on hardware. Everything else was
observed directly, with the method stated.

Reproduce any of it with `tools/probe.py` (see [Probing](#probing) below).

## Link settings

| | |
|---|---|
| Baud rate | 9600 |
| Framing | 8 data bits, no parity, 1 stop bit |
| Flow control | none |
| Terminator (host → instrument) | `\n` (0x0A) |
| Terminator (instrument → host) | **none** — see [Queries](#queries) |

Allow ~300 ms after opening the port before the first command: the CH340 needs a
moment to settle, and the instrument drops a command sent immediately on open.

## Writes are never acknowledged

Setting commands produce **no reply at all** — not an ACK, not an echo, not an
error. Deliberate garbage (`zzz\n`, or a bare `\n`) is also silently swallowed.

> Nothing in the host software may wait for a response after a write, or it will
> hang forever. There is also no way to detect a malformed command, which is why
> `isPlausibleCommand` in `src/device/fy3200s.ts` screens hand-typed input.

## Channels

Channel 1 (the "main" channel, `MF=` on the display) takes commands prefixed
**`b`**. Channel 2 (the "subsidiary" channel, `SF=`) takes the same commands
prefixed **`d`**.

The channels are genuinely independent: setting channel 2's duty cycle with
`dd250` left channel 1's duty readback (`cd`) unchanged at its previous value.

## Setting commands

| Purpose | Syntax | Units | Example | Status |
|---|---|---|---|---|
| Waveform | `bw<code>` | see [Waveform codes](#waveform-codes) | `bw0` → sine | verified for 0 and 17 |
| Frequency | `bf<n>` | centihertz (0.01 Hz), **no zero-padding** | `bf100000` → 1 kHz | **verified** |
| Amplitude | `ba<v>` | volts peak-to-peak, 2 decimals | `ba12.34` → 12.34 V | **verified** |
| DC offset | `bo<v>` | volts, 2 decimals, signed | `bo0.00` → 0.00 V | verified for 0; negative form *unverified* |
| Duty cycle | `bd<n>` | tenths of a percent | `bd500` → 50.0 % | **verified** |
| Phase | `dp<deg>` | whole degrees, **channel 2 only** | `dp90` | *unverified* |

### Frequency encoding — the one that bites

Frequency is a plain integer count of centihertz with **no padding**:

```
1 Hz        -> bf100
1 kHz       -> bf100000
12345.67 Hz -> bf1234567
```

This was settled by readback rather than by reading the panel. Sending
`bf100000` and then querying `cf` returns `cf0000100000`, i.e. 100000 centiHz =
1000.00 Hz exactly. Zero-padded forms (`bf000100000`, as `sds1004x_bode` sends)
were not needed.

`python-feeltech` sends the bare form and is correct here.

### Amplitude and offset

Two decimals, matching the instrument's 10 mV resolution. `ba12.34` put 12.34 V
on the display. Since the encoder always emits `toFixed(2)`, the 3-decimal and
bare-integer variants were not worth further hardware time and remain untested.

### Duty cycle

Tenths of a percent, confirmed by readback across the full range:

```
bd500 -> cd500   (50.0 %)
bd250 -> cd250   (25.0 %)
bd999 -> cd999   (99.9 %)
bd001 -> cd001   ( 0.1 %)
```

Per the manual, duty applies to square, pulse **and triangle** (a triangle at
51 % duty is shown in the manual), but not to sine.

## Waveform codes

The instrument's own 【WAVE】 toggle order, from the manual:

| Code | Panel | Shape |
|---|---|---|
| 0 | `SINE` | sine — **verified** |
| 1 | `SQUR` | square — *unverified* |
| 2 | `PULS` | pulse — *unverified, and see below* |
| 3 | `TRGL` | triangle — *unverified* |
| 4 | `STW` | rising sawtooth — *unverified* |
| 5 | `NSTW` | falling sawtooth — *unverified* |
| 6 | `DC` | DC level, set by the offset — *unverified* |
| 7 … | `PRE1` … | built-in presets, `PREn` = code `n + 6` — **verified at PRE1 and PRE11** |
| ? | `ARB1`–`ARB4` | user/arbitrary slots — code unknown, above 17 |

### Codes 1–6 are not yet confirmed

Only code 0 (`SINE`) and the `PREn` run are confirmed. One panel reading of `bw2`
reported `SINE` rather than the expected `PULS`, but that reading is not
trustworthy: the two display lines are easy to confuse, and other readings in the
same session turned out to be of the subsidiary channel.

Two hypotheses were tested and eliminated:

- **Zero-padding.** `bw2` and `bw02` behave identically; the instrument parses
  either. Padding is not the explanation.
- **Duty-acceptance fingerprinting.** The idea was that sine would refuse a duty
  change while pulse-like shapes accept it, giving an automated discriminator.
  It does not work: `cd` stores whatever duty you send for **every** waveform,
  sine included. Duty is a stored parameter, not a shape-gated one.

Since the instrument has no waveform readback, confirming these codes needs the
front panel. The easiest route is the web UI itself: each waveform option is
labelled with the mnemonic the panel should display (`Triangle (TRGL)`), so
selecting one and glancing at the instrument confirms or refutes it in a second.

If a mismatch turns up, fix the table in `src/device/types.ts` — it is the single
place the mapping is defined, and `test/fy3200s.test.ts` guards it.

### Do not trust `python-feeltech` here

That library declares `TRIANGLE = 2` and `ARB1..ARB4 = 3..6`. The manual
contradicts it, and the manual is corroborated: the library's own
`LORENTZ..FM = 7..16` mapping is exactly `PRE1..PRE10`, which is the range both
sources agree on.

### The presets run past the manual

The manual documents `PRE1`–`PRE10` (codes 7–16) and then shows `ARB1`–`ARB4`.
On this unit, **code 17 displays `PRE11`**, so the preset list is longer than the
manual's abridged table and the arbitrary slots sit somewhere above 17. Their
exact codes are *unverified*; reach them with the raw command box rather than
guessing.

## Queries

Five commands reply. All are in the `c` (counter/measurement) family.

| Command | Reply | Meaning |
|---|---|---|
| `cf` | `cf` + 10 digits | channel 1 frequency, in centihertz |
| `cd` | `cd` + 3 digits | channel 1 duty cycle, in tenths of a percent |
| `ce` | `ce` + 10 digits | external frequency measurement |
| `cc` | `cc` + 10 digits | external counter |
| `ct` | `ct06` | constant on this unit, regardless of any setting |

**None of these are documented in the manual or present in any library I found**;
they were discovered by enumerating the `c` prefix. `cf` and `cd` track the
instrument exactly, which is what made most of this document verifiable without
reading the front panel.

`ct` never changed for any setting, so it serves as a cheap "is there really an
FY3200S on this port?" handshake. Accept any digits — `06` may be
model-dependent, and only one unit was available.

### Replies have no terminator

```
TX  b'cf\n'
RX  b'cf0000100000'        # 12 bytes, then silence. No \n, no \r.
```

A reader that splits on newlines will wait forever. `src/device/serial.ts`
collects bytes and settles on an 80 ms idle gap instead.

### The `c` family changes the instrument's mode

During probing the unit was found switched into its external-frequency function
(`Ext=0Hz` / `FUNC:EXT.FREQ` on the display), which takes the panel away from the
channel parameters until a front-panel button restores it.

`ce` is the likely culprit — it is the measurement-enable command — but the cause
was not isolated. Treat the whole `c` family as **mode-affecting**: expose
readback on an explicit button, never poll it, and do not send `ce`/`cc` as part
of normal operation.

Press **【CH1】** on the instrument to get back to the `MF=` display.

## The instrument does not enforce its own limits

This matters more than anything else here.

The FY3200S-24M is specified for sine to 24 MHz and **everything else to 6 MHz**.
It nonetheless accepts, and reports back, whatever you send:

```
square, request 30,000,000 Hz -> cf reports 30,000,000.00 Hz
```

No clamping, no error, on any waveform. The DDS simply loads the register and
emits an aliased signal. **Range enforcement is entirely the host's job** — that
is what `src/device/limits.ts` is for, and why the preview warns when a setting
is beyond spec rather than silently drawing a clean trace.

### Specifications (FY3200S manual)

| | |
|---|---|
| Sine | 0–6/12/20/**24**/25 MHz by model |
| Square, triangle, pulse, sawtooth, arbitrary | 0–6 MHz **on every model** |
| Frequency resolution | 0.01 Hz (10 mHz) |
| Amplitude | 10 mVpp – 20 Vpp (no load), 10 mV resolution |
| DC offset | ±10 V, 0.01 V resolution |
| Duty cycle | 0.1 % – 99.9 % |
| Phase | 0–359°, 1° resolution |

## Timing

Commands need **no inter-command delay**. Measured:

- Bursts of 8 frequency changes at gaps from 200 ms down to 0 ms: the final value
  always landed.
- A 5-command batch (`bw` `bf` `ba` `bo` `bd`) at a 0 ms gap, repeated 15 times:
  **15/15** fully landed, confirmed by `cf` and `cd` readback.

At 9600 baud a 10-character command already occupies ~10 ms of wire time, which
paces things by itself. The libraries in the wild are far more cautious than the
hardware requires — `python-feeltech` waits 50 ms, `sds1004x_bode` 500 ms.

`COMMAND_INTERVAL_MS` is set to 20 ms: a safety margin over a measured zero that
still leaves sliders feeling live.

## There is no output enable

Nothing in the protocol turns an output on or off — that is the front-panel
【CH1】/【CH2】 buttons only. The "Show in preview" checkbox in the web UI is
therefore labelled honestly: it affects the drawing, not the hardware.

Likewise there is **no readback for waveform, amplitude, offset or phase**, so
the page cannot discover the instrument's full state. It pushes its own state on
connect instead, and "Push all settings" re-syncs after someone has used the
front panel.

## Probing

The instrument is on Windows COM4. To reach it from WSL2, from an
**Administrator** PowerShell:

```powershell
usbipd bind   --busid 1-4        # once per machine
usbipd attach --wsl --busid 1-4  # once per boot
```

It appears as `/dev/ttyUSB0` (the `ch341` driver binds automatically; membership
of the `dialout` group is enough, no sudo). **While attached, COM4 is unavailable
to Windows** — so Chrome cannot use it. Release it with:

```powershell
usbipd detach --busid 1-4
```

Then:

```bash
python3 tools/probe.py info              # replies, counter behaviour
python3 tools/probe.py list              # the available investigations
python3 tools/probe.py test freq-format
python3 tools/probe.py send 'bf100000'
python3 tools/probe.py repl              # interactive
```
