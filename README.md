# FeelTech FY3200S browser control

Control a FeelTech FY3200S function generator from a web page — waveform,
frequency, amplitude, DC offset, duty cycle and channel-2 phase — with a
scope-style preview of the signal you have commanded.

Built for a teaching lab: a student opens the page, clicks **Connect**, picks the
instrument, and starts changing the signal. Every command sent appears in a log on
the page, so the link between "drag this slider" and `bf100000` is visible rather
than hidden.

## Requirements

- **Chrome or Edge on desktop** (or another Chromium browser). This uses the
  [Web Serial API][webserial], which Firefox and Safari do not implement, and
  which is unavailable on iOS.
- The page must be served over **HTTPS or from localhost**. GitHub Pages is
  HTTPS, so the deployed page is fine.
- A FeelTech FY3200S connected by USB.

No drivers to install beyond the CH340 driver Windows already supplies, and no
software to install at all.

### Why Web Serial and not WebUSB

The FY3200S has no native USB stack — inside it is a **CH340 UART bridge**, which
is why it shows up as a COM port. WebUSB would have to `claimInterface()`, and the
OS refuses that for a device its own driver already owns. Making WebUSB work would
mean replacing the CH340 driver with WinUSB (via Zadig), breaking that COM port
for every other tool on the machine.

Web Serial talks *through* the existing driver, so nothing has to be swapped out.

## Using it

1. Open the page and pick your model from the dropdown — it sets the frequency
   ceiling, and **the instrument does not enforce its own limits** (see below).
2. Click **Connect** and choose `USB-SERIAL CH340` in the browser's dialog.
3. Change whatever you like. Commands go out as you move each control.

Notes worth knowing:

- **The preview is not a measurement.** It is drawn from the settings you have
  sent. The FY3200S cannot report its output, and there is no ADC in the path. Use
  a real oscilloscope to see what is actually coming out.
- **The instrument accepts out-of-spec settings silently.** Asking a
  FY3200S-24M for a 30 MHz square wave gets you a 30 MHz register value and an
  aliased signal, with no error. The page clamps to the datasheet and warns you
  when a value is beyond spec — that protection exists only in software.
- **"Show in preview" does not mute the output.** The serial protocol has no
  output-enable command; that is the front-panel 【CH1】/【CH2】 buttons only.
- **Push all settings** re-syncs the instrument after someone has used the front
  panel. The page cannot read the instrument's waveform, amplitude, offset or
  phase back, so it cannot detect such changes on its own.

## Development

```bash
npm install
npm run dev        # http://localhost:5173/feelTechFunctionGenerator/
npm test           # protocol encoder tests - no hardware needed
npm run typecheck
npm run build
```

The protocol layer is deliberately split so that most of it is testable without an
instrument:

| File | Role |
|---|---|
| `src/device/fy3200s.ts` | Pure command encoding. State in, command strings out. No I/O. |
| `src/device/limits.ts` | What the hardware can actually do, per model and per waveform. |
| `src/device/serial.ts` | The only file that touches `navigator.serial`. |
| `src/waveform.ts` | Pure waveform maths for the preview. |
| `src/ui/scope.ts` | Canvas rendering. |
| `tools/probe.py` | Talks to real hardware, for verifying the protocol. |

## The protocol

**[docs/PROTOCOL.md](docs/PROTOCOL.md)** documents the serial protocol as verified
against a real FY3200S-24M, including several things that are wrong or missing
elsewhere:

- The instrument has **undocumented readback commands** (`cf` for frequency, `cd`
  for duty cycle) that appear in no manual or library I could find.
- Its replies carry **no line terminator**, so a newline-based reader hangs.
- The widely-used `atx/python-feeltech` library has the **wrong waveform codes**
  for the basic shapes.
- Commands need **no inter-command delay**, despite existing libraries waiting
  50–500 ms.

To verify against your own unit, see the probing section of that document.

## Licence

MIT.

[webserial]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
