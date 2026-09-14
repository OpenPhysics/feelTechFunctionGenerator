#!/usr/bin/env python3
"""
Hardware prober for the FeelTech FY3200S function generator.

Resolves the open questions in the serial protocol against a real instrument, so
that src/device/fy3200s.ts encodes commands the hardware actually accepts rather
than commands the internet believes it accepts.

Usage (device must be attached to WSL via usbipd, see docs/PROTOCOL.md):

    python3 tools/probe.py info                 # port opens? does the unit reply to writes?
    python3 tools/probe.py send 'bf100000'      # send one raw command, report any reply
    python3 tools/probe.py hold 'bf100000' 8    # send, then hold for N seconds so you can look
    python3 tools/probe.py test freq-format     # run a named investigation
    python3 tools/probe.py test all
    python3 tools/probe.py list                 # list investigations
    python3 tools/probe.py repl                 # interactive; run this one yourself

Every test prints WHAT TO LOOK FOR on the front panel before it changes anything,
then pauses on each step long enough to read the display.
"""

import argparse
import sys
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial is not installed: pip install pyserial")

DEFAULT_PORT = "/dev/ttyUSB0"
BAUD = 9600
# Conservative until 'delay' proves otherwise. python-feeltech uses 0.05,
# sds1004x_bode uses 0.5.
DEFAULT_DELAY = 0.12

WAVEFORMS = {
    0: "sine", 1: "square", 2: "triangle", 3: "arb1", 4: "arb2", 5: "arb3",
    6: "arb4", 7: "lorentz", 8: "multitone", 9: "rand noise", 10: "ECG",
    11: "trapezoid", 12: "sinc", 13: "narrow pulse", 14: "gauss noise",
    15: "AM", 16: "FM",
}


class FY:
    """Minimal transport. Deliberately dumb: it sends exactly what it is given."""

    def __init__(self, port=DEFAULT_PORT, delay=DEFAULT_DELAY, verbose=True):
        self.delay = delay
        self.verbose = verbose
        try:
            self.ser = serial.Serial(
                port, BAUD, bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
                timeout=0.5, write_timeout=2.0,
            )
        except serial.SerialException as e:
            sys.exit(f"cannot open {port}: {e}\n"
                     f"Is the device attached to WSL?  "
                     f"usbipd attach --wsl --busid 1-4  (from Admin PowerShell)")
        # The CH340 needs a moment after open; the FY also drops the first
        # command if you talk to it immediately.
        time.sleep(0.3)
        self.ser.reset_input_buffer()

    def send(self, cmd, read_reply=True):
        """Send one command. Returns whatever bytes came back (usually none)."""
        payload = cmd.encode("ascii") + b"\n"
        self.ser.write(payload)
        self.ser.flush()
        time.sleep(self.delay)
        reply = b""
        if read_reply:
            reply = self.ser.read(64)
        if self.verbose:
            shown = repr(reply) if reply else "(no reply)"
            print(f"    TX {payload!r:<24} RX {shown}")
        return reply

    def close(self):
        self.ser.close()


def banner(title, look_for):
    print()
    print("=" * 72)
    print(f"  {title}")
    print("=" * 72)
    print(f"  LOOK FOR: {look_for}")
    print("-" * 72)


def pause(seconds, note=""):
    if note:
        print(f"    >> {note}")
    time.sleep(seconds)


# --------------------------------------------------------------------------
# Investigations
# --------------------------------------------------------------------------

def t_echo(fy, dwell):
    """Does the unit echo, ACK, or stay silent on writes?"""
    banner("echo / ACK behaviour",
           "nothing on the panel; this reads the RX line only")
    print("  Sending a benign command three times and reading the RX buffer.")
    for _ in range(3):
        fy.send("bw0")
    print("  Sending deliberate garbage to see if errors are reported:")
    fy.send("zzz")
    fy.send("")
    print()
    print("  CONCLUSION: if every RX above is empty, the unit is write-only for")
    print("  setting commands and the web app must not wait for an ACK.")


def t_freq_format(fy, dwell):
    """Bare vs zero-padded centiHz. This is the one that bites."""
    banner("frequency encoding: bare vs zero-padded centiHz",
           "the CH1 frequency display after each step")
    trials = [
        ("bf100000",     "bare centiHz for 1 kHz  -> expect 1 kHz"),
        ("bf000100000",  "zero-padded to 9 digits -> expect 1 kHz"),
        ("bf0000100000", "zero-padded to 10 digits-> expect 1 kHz"),
        ("bf200000",     "bare centiHz for 2 kHz  -> expect 2 kHz"),
    ]
    for cmd, note in trials:
        print(f"\n  {note}")
        fy.send("bf0")           # zero first, so a no-op is visible as 0
        pause(0.4)
        fy.send(cmd)
        pause(dwell, "read the display now")


def t_freq_range(fy, dwell):
    """Resolution floor and the model's ceiling."""
    banner("frequency range and resolution",
           "CH1 frequency; note the LAST value that displays correctly")
    for hz in [0.01, 0.1, 1, 10, 1000, 100_000, 1_000_000,
               6_000_000, 12_000_000, 24_000_000, 30_000_000]:
        centi = round(hz * 100)
        print(f"\n  requesting {hz:>12,.2f} Hz")
        fy.send(f"bf{centi}")
        pause(dwell, "read the display now")
    print("\n  CONCLUSION: the highest value that displayed correctly is this")
    print("  unit's ceiling -> use it as the cap in src/device/limits.ts.")


def t_amplitude(fy, dwell):
    """Decimal places and accepted range."""
    banner("amplitude format and range",
           "CH1 amplitude display after each step")
    fy.send("bw0")
    fy.send("bf100000")
    pause(0.4)
    for cmd, note in [
        ("ba5.00",  "2 decimals   -> expect 5 V"),
        ("ba5.000", "3 decimals   -> expect 5 V"),
        ("ba5",     "no decimals  -> expect 5 V"),
        ("ba0.44",  "sub-volt     -> expect 0.44 V"),
        ("ba0.01",  "minimum?     -> expect 0.01 V"),
        ("ba10.00", "10 V"),
        ("ba20.00", "20 V - at or beyond the maximum?"),
    ]:
        print(f"\n  {note}")
        fy.send(cmd)
        pause(dwell, "read the display now")


def t_offset(fy, dwell):
    """Negative offset syntax."""
    banner("DC offset, especially negative values",
           "CH1 offset display; confirm the sign is right")
    fy.send("bw0")
    fy.send("ba5.00")
    pause(0.4)
    for cmd, note in [
        ("bo0.00",  "zero"),
        ("bo2.50",  "positive 2.5 V"),
        ("bo-2.50", "negative 2.5 V  <- the format in question"),
        ("bo-5.00", "negative 5 V"),
        ("bo0.00",  "back to zero"),
    ]:
        print(f"\n  {note}")
        fy.send(cmd)
        pause(dwell, "read the display now")


def t_waveform(fy, dwell):
    """Which codes this unit honours, and what shape each really is."""
    banner("waveform codes",
           "the waveform name/shape on the panel for each code")
    fy.send("bf100000")
    fy.send("ba5.00")
    pause(0.4)
    for code, expected in WAVEFORMS.items():
        print(f"\n  bw{code} -> expected '{expected}'")
        fy.send(f"bw{code}")
        pause(dwell, "read the display now")
    print("\n  CONCLUSION: record any code whose actual shape differs from the")
    print("  expected name, and the highest code this unit accepts.")


def t_duty(fy, dwell):
    """Tenths of a percent, or whole percent?"""
    banner("duty cycle units",
           "CH1 duty display; 'bd500' should read 50.0 % if units are 0.1 %")
    fy.send("bw1")          # square, where duty is meaningful
    fy.send("bf100000")
    pause(0.4)
    for cmd, note in [
        ("bd500", "tenths of a percent -> expect 50.0 %"),
        ("bd50",  "whole percent       -> expect 50 % if units are percent, 5.0 % if tenths"),
        ("bd250", "-> expect 25.0 % if tenths"),
        ("bd900", "-> expect 90.0 % if tenths"),
    ]:
        print(f"\n  {note}")
        fy.send(cmd)
        pause(dwell, "read the display now")


def t_phase(fy, dwell):
    """Is phase CH2-only on this family?"""
    banner("phase: does 'bp' exist, or is phase CH2-only via 'dp'?",
           "any phase reading on the panel; also watch CH2")
    fy.send("bw0"); fy.send("bf100000")
    fy.send("dw0"); fy.send("df100000")
    pause(0.4)
    for cmd, note in [
        ("dp0",   "CH2 phase 0 deg"),
        ("dp90",  "CH2 phase 90 deg  <- expected to work"),
        ("dp180", "CH2 phase 180 deg"),
        ("bp90",  "CH1 phase 90 deg  <- expected to be ignored/unsupported"),
    ]:
        print(f"\n  {note}")
        fy.send(cmd)
        pause(dwell, "read the display now")


def t_channel2(fy, dwell):
    """Confirm the 'd' prefix drives channel 2 independently."""
    banner("channel 2 via the 'd' prefix",
           "CH2 settings changing while CH1 stays put")
    print("\n  CH1 -> 1 kHz sine 5 V")
    fy.send("bw0"); fy.send("bf100000"); fy.send("ba5.00")
    pause(dwell, "note CH1")
    print("\n  CH2 -> 2 kHz square 3 V")
    fy.send("dw1"); fy.send("df200000"); fy.send("da3.00")
    pause(dwell, "confirm CH2 changed and CH1 did not")


def t_counter(fy, dwell):
    """Counter / measurement reads - the only commands that should reply."""
    banner("frequency counter: 'ce' trigger then 'cc' read",
           "nothing on the panel; we care about the RX bytes below")
    print("  NOTE: on this family the counter measures the EXTERNAL input.")
    print("  With nothing patched into the counter input, expect 0 or garbage -")
    print("  what matters here is the REPLY FORMAT and line ending.\n")
    for cmd in ["ce", "cc", "cf", "cg", "ca"]:
        print(f"  probing '{cmd}':")
        reply = fy.send(cmd)
        if reply:
            print(f"      decoded: {reply.decode('ascii', 'replace')!r}")
    print("\n  CONCLUSION: note which of these reply at all, and whether the")
    print("  reply is newline-terminated (the web app's reader splits on \\n).")


def t_delay(fy, dwell):
    """How fast can we push commands before the unit drops them?"""
    banner("minimum inter-command delay",
           "CH1 frequency after each burst - it must end on the LAST value")
    for delay in [0.20, 0.10, 0.05, 0.02, 0.005]:
        fy.delay = delay
        print(f"\n  burst of 6 frequency changes at {delay*1000:.0f} ms spacing,")
        print(f"  ending on 6 kHz - if the display shows anything else, commands")
        print(f"  were dropped at this rate:")
        for khz in [1, 2, 3, 4, 5, 6]:
            fy.send(f"bf{khz*100000}", read_reply=False)
        pause(dwell, "read the display now - is it 6 kHz?")
    fy.delay = DEFAULT_DELAY


TESTS = {
    "echo":        t_echo,
    "freq-format": t_freq_format,
    "freq-range":  t_freq_range,
    "amplitude":   t_amplitude,
    "offset":      t_offset,
    "waveform":    t_waveform,
    "duty":        t_duty,
    "phase":       t_phase,
    "channel2":    t_channel2,
    "counter":     t_counter,
    "delay":       t_delay,
}


def main():
    p = argparse.ArgumentParser(description=__doc__,
                               formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", default=DEFAULT_PORT)
    p.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                   help="seconds between commands")
    p.add_argument("--dwell", type=float, default=3.0,
                   help="seconds to hold each step so you can read the panel")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("info", help="open the port and characterise replies")
    sub.add_parser("list", help="list investigations")
    sub.add_parser("repl", help="interactive raw command prompt")
    s = sub.add_parser("send", help="send one raw command")
    s.add_argument("command")
    s = sub.add_parser("hold", help="send one command then wait")
    s.add_argument("command")
    s.add_argument("seconds", type=float, nargs="?", default=8.0)
    s = sub.add_parser("test", help="run an investigation (or 'all')")
    s.add_argument("name")

    a = p.parse_args()

    if a.cmd == "list":
        print("investigations:")
        for name, fn in TESTS.items():
            print(f"  {name:<14} {fn.__doc__.strip().splitlines()[0]}")
        return

    fy = FY(a.port, a.delay)
    try:
        if a.cmd == "info":
            print(f"port {a.port} open at {BAUD} 8N1, {a.delay*1000:.0f} ms spacing")
            t_echo(fy, a.dwell)
            t_counter(fy, a.dwell)
        elif a.cmd == "send":
            fy.send(a.command)
        elif a.cmd == "hold":
            fy.send(a.command)
            print(f"  holding {a.seconds} s - read the panel now")
            time.sleep(a.seconds)
        elif a.cmd == "repl":
            print("raw command prompt. one command per line, no newline needed.")
            print("'quit' to exit.")
            while True:
                try:
                    line = input("FY> ").strip()
                except (EOFError, KeyboardInterrupt):
                    break
                if line in ("quit", "exit"):
                    break
                if line:
                    fy.send(line)
        elif a.cmd == "test":
            names = list(TESTS) if a.name == "all" else [a.name]
            for n in names:
                if n not in TESTS:
                    sys.exit(f"unknown investigation {n!r}; try 'list'")
            for n in names:
                TESTS[n](fy, a.dwell)
            print("\n" + "=" * 72)
            print("  done - record the panel readings in docs/PROTOCOL.md")
            print("=" * 72)
    finally:
        fy.close()


if __name__ == "__main__":
    main()
