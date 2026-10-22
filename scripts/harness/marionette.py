"""
Drive headless Firefox from Python, with no geckodriver and no selenium.

## Why this exists

Some bugs only exist in a real engine. happy-dom (the unit/smoke harness) does NO layout, so every
element measures 0x0 and nothing about scrolling, paint or `content-visibility` can be observed
there. The scroll-drift investigation needed measurements that happy-dom cannot produce, and
`geckodriver` is not installed in this workspace — but Firefox's own **Marionette** server is, and
it is a plain TCP protocol.

This is deliberately dependency-free (stdlib only): no selenium, no pip install, nothing to clean
up beyond the browser process and its profile.

## The protocol gotcha that costs the most time

`marionetteProtocol: 3` frames BOTH directions as `<decimal-length>:<json>`. Sending a bare JSON
array (what most examples online show for protocol 2) is rejected by the server with
`No packet types for header: [0, 7, "WebDriver:` — a confusing error that looks like a command
name problem and is actually a framing problem. Prefix every command with its byte length.

Second gotcha: `WebDriver:NewSession` blocks until a session exists, and the FIRST connection
receives a hello packet (`{"applicationType":"gecko",...}`) that must be read before sending
anything.

## Usage

    from marionette import Firefox
    with Firefox() as f:
        f.navigate("file:///tmp/probe.html")
        print(f.js("return document.querySelectorAll('.row').length"))

`js()` returns the script's return value. Scripts run in the CONTENT scope, so install any
`window.__hook` AFTER navigating — before navigation the context is privileged and Marionette
answers `The command does not support browsing contexts in privileged scope`.

## Cleanup

`close()` quits Marionette and then reaps the process it started. It only ever touches the PID it
created — never `pkill -f`, which (measured, twice) matches the shell running the command and kills
the caller.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time

DEFAULT_BINARIES = (
    "firefox-developer-edition",
    "firefox",
    "firefox-esr",
)


def find_browser(explicit: str | None = None) -> str:
    """the first Firefox that exists on PATH — Developer Edition first, since that is what the
    operator runs, so a fix verified there is verified on the reported browser"""
    if explicit:
        return explicit
    for name in DEFAULT_BINARIES:
        path = shutil.which(name)
        if path:
            return path
    raise RuntimeError(
        "no Firefox on PATH (looked for %s). Pass an explicit path." % ", ".join(DEFAULT_BINARIES)
    )


class Firefox:
    """a headless Firefox driven over Marionette"""

    def __init__(
        self,
        binary: str | None = None,
        port: int = 2828,
        profile: str | None = None,
        window: str = "1200,900",
        launch: bool = True,
        boot_timeout: float = 40.0,
    ) -> None:
        self.port = port
        self.proc: subprocess.Popen | None = None
        self.log_path: str | None = None
        self._owns_profile = profile is None
        self.profile = profile or tempfile.mkdtemp(prefix="ffprof-")
        self.sock: socket.socket | None = None
        self._buf = b""
        self._mid = 0

        if launch:
            self.binary = find_browser(binary)
            self._launch(window)

        self._connect(boot_timeout)
        self._hello()
        self.command("WebDriver:NewSession", {"capabilities": {}})

    # ---- process -------------------------------------------------------

    def _launch(self, window: str) -> None:
        self.log_path = os.path.join(self.profile, "firefox.log")
        self._log = open(self.log_path, "w")
        self.proc = subprocess.Popen(
            [self.binary, "--headless", "--marionette", "--no-remote",
             "--profile", self.profile, "--window-size", window],
            stdout=self._log,
            stderr=subprocess.STDOUT,
        )

    def _connect(self, timeout: float) -> None:
        deadline = time.time() + timeout
        last: Exception | None = None
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                self.sock.settimeout(30)
                return
            except OSError as exc:  # not listening yet
                last = exc
                time.sleep(0.4)
        raise RuntimeError(f"Marionette never listened on {self.port}: {last}")

    # ---- framing -------------------------------------------------------

    def _read(self) -> list:
        while True:
            i = self._buf.find(b":")
            if i < 0:
                self._buf += self.sock.recv(65536)
                continue
            n = int(self._buf[:i])
            if len(self._buf) < i + 1 + n:
                self._buf += self.sock.recv(65536)
                continue
            msg = json.loads(self._buf[i + 1:i + 1 + n])
            self._buf = self._buf[i + 1 + n:]
            return msg

    def _hello(self) -> None:
        self._read()

    def command(self, name: str, params: dict | None = None):
        """send one command and return its value; raises with the server's own message"""
        self._mid += 1
        body = json.dumps([0, self._mid, name, params or {}]).encode()
        self.sock.sendall(str(len(body)).encode() + b":" + body)
        while True:
            msg = self._read()
            if msg[0] != 1 or msg[1] != self._mid:
                continue  # an event, not our reply
            if msg[2]:
                raise RuntimeError(f"{name}: {msg[2]}")
            return msg[3]

    # ---- page ----------------------------------------------------------

    def navigate(self, url: str) -> None:
        self.command("WebDriver:Navigate", {"url": url})

    def js(self, script: str, args: list | None = None, timeout_ms: int = 30000):
        """run a script in the CONTENT scope and return its value"""
        reply = self.command(
            "WebDriver:ExecuteScript",
            {"script": script, "args": args or [], "scriptTimeout": timeout_ms},
        )
        return reply.get("value") if isinstance(reply, dict) else reply

    def wait_for(self, script: str, timeout: float = 20.0, interval: float = 0.2):
        """poll a script until it returns something truthy, then return that value

        Polls rather than sleeping: a fixed sleep on a loaded machine expires before the condition
        and reports a misleading failure, which is the same trap as in the Node test suites.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            value = self.js(script)
            if value:
                return value
            time.sleep(interval)
        return None

    # ---- teardown ------------------------------------------------------

    def close(self) -> None:
        try:
            if self.sock:
                self.command("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        if self.proc:
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                # only OUR pid, recorded at launch — never a pattern match
                self.proc.kill()
                self.proc.wait(timeout=10)
        if self._owns_profile:
            shutil.rmtree(self.profile, ignore_errors=True)

    def __enter__(self) -> "Firefox":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
