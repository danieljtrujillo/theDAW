# thedaw-vst-host

Our own native host so the user's real VST3 plugins process the live signal
during playback. One process per live chain entry; the editor window belongs to
the same instance that is making the sound.

The wire protocol, command line and exit codes are specified in
`docs/design/vst-live-protocol.md`. That file is the contract — this one only
documents how the implementation realises it.

No frameworks and no third-party code: C++17, Win32 and Winsock. The WebSocket
server, frame codec, JSON reader/writer, SHA-1, base64 and lock-free queues are
all in `src/`.

## Build

```powershell
# engine only (no VST3 layer) -- build tree lands in native/vst-host/build
.\build.ps1 -Vst3 OFF

# with the VST3 hosting layer once src/vst3 exists
.\build.ps1 -Vst3 ON

# other options -- -BuildDir wins over $env:THEDAW_VST_BUILD_DIR, which wins
# over the default above, so a scratch volume needs no edit to this script
.\build.ps1 -Vst3 OFF -BuildDir D:\somewhere\else -Config RelWithDebInfo -Clean
```

The script configures, builds, and copies the binary to
`native/vst-host/bin/thedaw-vst-host.exe` (gitignored). Only sources and that one
binary ever live in the worktree.

`THEDAW_VST3` defaults to ON when `src/vst3/CMakeLists.txt` exists and OFF
otherwise. With it OFF, `src/vst3_stub` is linked instead and every VST3 entry
point reports `VST3 layer not built` with exit-code hint 4 (or 3 when the plugin
file does not exist). `--version` prints `"vst3": true|false` so callers can tell
which binary they have.

MSVC settings: `/W4 /WX`, `/O2` release, static CRT (`/MT`), `UNICODE`.

## How the exe gets built

`thedaw-vst-host.exe` is never committed — `native/vst-host/bin/` is
gitignored, per the Build section above — so it has to come into existence
one of three ways, and whichever tool you're running tells you which one
applies.

### Locally

Run `.\build.ps1` yourself. It needs CMake and the Visual Studio Build Tools
(MSVC) installed; see Build, above, for the exact invocations. The result
lands at `native/vst-host/bin/thedaw-vst-host.exe`, which is gitignored, so a
local build is never committed.

### From CI

The `build-vst-host` workflow (`.github/workflows/build-vst-host.yml`) runs on
`workflow_dispatch`, on pushes to `main` that touch `native/vst-host/**`, and
on pull requests touching those same paths. It builds Release x64 with the
VST3 layer and `/WX` both on, runs `--selftest`, then runs
`tests/test_vst_host_native.py` and `tests/test_vst3_probe.py`, and uploads
the `thedaw-vst-host-win64` artifact: the host exe, `vst3_probe.exe`, and a
`SHA256SUMS` file. Downloading that artifact and unzipping it into `bin/` is a
manual, user-initiated step — theDAW never downloads a binary on its own.

### At launch

`theDAW.bat` runs `scripts/check_vst_host.py` and prints one of its three
status lines verbatim. If the exe is missing and CMake is on PATH, it then
asks — via `install\setup.ps1 -VstHost` — whether to build it now. Declining,
or the build failing, never stops theDAW from starting; live VST hosting is
simply unavailable for that session.

It asks once, not every launch. Declining at the prompt writes
`native/vst-host/.build-declined` (gitignored; one timestamped line), and
while that file exists the launcher skips the offer — the status line still
prints. To be asked again, delete it, or run `install\setup.ps1 -VstHost`
yourself: run by hand the script always asks, because only the launcher
consults the marker. A successful build deletes it. Writing and deleting it
are both best-effort — if the write fails you are simply asked again. A
launch with no console to ask at (redirected stdin) declines without writing
anything, so a real console still gets the offer afterwards.

Set `THEDAW_SKIP_VST_HOST_BUILD=1` to suppress the offer outright, marker or
no marker; the status line is printed either way. `theDAW.sh` only ever
prints the not-available line; it does not offer to build.

## Running

```
thedaw-vst-host --plugin <path.vst3> [--plugin-name <name> | --class-id <32 hex>]
                [--sample-rate 48000] [--block-size 512] [--channels 2]
                [--state-file <path>] [--port 0] [--idle-timeout 0]
                [--parent-pid <pid>] [--log <file>]
thedaw-vst-host --null-plugin [...]      passthrough host, loads no plugin
thedaw-vst-host --list --plugin <path>   plugin classes as JSON
thedaw-vst-host --selftest               built-in vectors
thedaw-vst-host --version | --help
```

The server binds **127.0.0.1 only**, never port 3000, and prints exactly one line
to stdout when it is ready:

```json
{"ev":"listening","port":54321,"pid":1234,"protocol":1}
```

`--port 0` (the default) takes an OS-assigned port. `--idle-timeout 0` (the
default) disables the idle exit; the backend passes a real value.

## Threads

| Thread | Owns |
| --- | --- |
| message (main) | DPI, COM/OLE, Win32 message loop, plugin creation, controller calls, editor windows, state get/set, all JSON |
| audio | the client socket (reads **and** writes) and the `process()` call; MMCSS "Pro Audio" |
| acceptor | `accept()` and the HTTP upgrade, then hands the socket to the audio thread |
| logger | drains the audio thread's lock-free note ring into the log file |
| stdin, parent watchdog | detached; they only post a quit to the message window |

The message loop waits with `MsgWaitForMultipleObjectsEx`, so the audio thread
wakes it with `SetEvent` (realtime safe) rather than `PostMessage`, and plugin
editors still get a normal message pump.

### Realtime rules

* Every audio-thread buffer is allocated in `Session::start()` and sized for
  `maxBlockSize x 8 channels`. The hot path does no allocation, takes no lock and
  never logs or parses JSON.
* Incoming text messages are copied into preallocated slots of a lock-free SPSC
  ring and handled on the message thread. Only a control message larger than the
  reserved slot (a big `set_state` blob) can force one allocation, and
  `set_state` parks the audio thread anyway.
* Outgoing messages go the other way through a second SPSC ring; the audio thread
  is the only writer to the socket, so no send lock exists.
* The audio thread reports faults as fixed-size notice codes; the message thread
  turns them into `error` JSON.
* `xrun` is derived from two atomics (late blocks, worst process time) that the
  message thread samples, so it is naturally coalesced to at most one event per
  second and only sent when nonzero.

### Park handshake

Anything that must not overlap `process()` — `set_state`, `get_state`, a
`reprepare()` after `onRestartRequired`, a latency change that resizes the bypass
delay, and shutdown — parks the audio thread first: the message thread raises a
flag and waits for an acknowledgement, and the audio thread stops reading the
socket until it is resumed. Blocks queue up in the TCP receive buffer while
parked, so nothing is lost. Parks longer than 5 ms are logged with their
duration.

The audio thread polls the socket with a 2 ms receive timeout, which is what
bounds park latency and how long a queued control reply waits.

## Implementation notes the contract leaves open

* **`audio_out` channel count echoes the `audio_in` it answers.** The host maps
  wire channels to the plugin's `channelsIn` and back from `channelsOut`, so a
  client always gets back the layout it sent, whatever the plugin negotiated.
  `ready` still reports `channels_in`/`channels_out` so the client knows what the
  plugin actually runs.
* **`flags` in `audio_out` is reserved and sent as 0.** Both defined bits describe
  the client-to-host direction. `seq`, `frames`, `position_samples` and
  `tempo_bpm` are echoed.
* **Mono/stereo conversion is bit exact for a passthrough**: mono duplicates, and
  stereo averages as `(l + r) * 0.5`, so dup-then-average returns the original
  samples exactly in IEEE-754.
* **Soft bypass** keeps calling `process()` (tails survive) and crossfades over
  10 ms to the dry input delayed by `latencySamples` through a preallocated delay
  line. The crossfade is computed as `wet + g * (dry - wet)`, which is exact at
  both ends and whenever `dry == wet`, so toggling bypass on a passthrough never
  perturbs a sample.
* **`get_state` writes the state file before it answers.** The reply is therefore
  a guarantee that the new bytes are on disk, which is what lets the backend's
  `DELETE /session` read the file immediately after.
* **State file format** is the plugin's raw state container, byte for byte — the
  same blob `state_b64` carries base64-encoded, and the same one pedalboard uses
  as `raw_state`. Writes are atomic (temp file, flush, `MoveFileExW` replace), so
  a crash can never leave a half-written state file.
* **Frames are little-endian**; the host is Windows/x86-64 only, so the codec is a
  byte copy rather than a byte swap.

## Security

The socket is the whole attack surface, so:

* It binds the loopback address only, and `SO_REUSEADDR` is deliberately not set
  (on Windows it would let another process steal the port).
* Origins are checked before anything else. Accepted: no `Origin` header, `null`,
  `file://`, and non-http schemes (Electron `app://` and friends). Accepted over
  http(s) only for exactly `localhost`, `127.0.0.1` and `[::1]` on any port; every
  other http(s) origin gets 403. Host names are compared whole, so
  `http://localhost.evil.com` is refused, and a `403` is returned in preference to
  `409` so a hostile page cannot probe whether a session is live.
* One client at a time. A second connection gets HTTP 409 while a live one
  exists; the slot is released as soon as the audio thread sees the socket close.
* Frame handling is bounded: 8 MB maximum message, control frames capped at 125
  bytes and never fragmented, reserved bits must be zero, client frames must be
  masked, non-minimal 16/64-bit lengths and lengths with the high bit set are
  rejected. Violations close with 1002 (or 1009 for oversize).
* The handshake is capped at 16 KB, 64 headers and a 5 second read timeout, and
  `Sec-WebSocket-Key` must decode to exactly 16 bytes.
* Audio messages are validated against the negotiated block size and channel
  count before a single byte is copied.
* Calls into plugin code from the message thread run under a structured-exception
  guard; a faulting plugin produces `error{fatal:true}` and exit code 4 instead of
  a silent process death.

## Tests

```powershell
# built-in known-answer vectors: SHA-1, base64, JSON, frame headers, WebSocket
# framing and handshake, SPSC queue, channel map, bypass delay alignment
.\bin\thedaw-vst-host.exe --selftest
```

```bash
# end-to-end over a real loopback socket; skips cleanly when the exe is absent
uv run pytest tests/test_vst_host_native.py
```

`tests/vst_host_client.py` is the reusable client (spawn helper, frame
pack/unpack, control helpers) and is also handy from a REPL when poking at a real
plugin. Set `THEDAW_VST_HOST` to test a binary somewhere other than `bin/`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | clean exit (shutdown, stdin EOF, idle timeout, parent gone) |
| 2 | bad arguments |
| 3 | plugin file not found |
| 4 | plugin failed to load or initialize, or faulted |
| 5 | unsupported bus layout |
| 6 | socket error |
