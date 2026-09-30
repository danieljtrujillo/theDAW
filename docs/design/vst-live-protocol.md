# theDAW live VST host — architecture and wire protocol (v1)

Status: contract for batch 11 tickets T40a/T40b/T40c (native host), T41 (backend sessions), T42 (frontend node).
All three are built against this file. Change it only through the lead.

## Why

A `vst3` chain entry does nothing during playback today (`sabSupport.ts` says "live host not built
yet"); plugins only apply on freeze/render through pedalboard. This adds a real-time native host so
the user's real plugins (Ozone etc.) process the live signal, and the editor window belongs to the
same instance that is making the sound.

## Pieces

```
AudioWorkletNode (vst-bridge.worklet.js)  ── MessagePort ──  bridge client (main thread / Worker)
        ▲ live chain (rackEffects)                                   │ WebSocket (loopback, binary + JSON)
        │                                                            ▼
   liveMixer PDC  ◄── latency_samples ──  thedaw-vst-host.exe  (one process per chain entry)
                                           message thread: Win32 message loop + plugin editor window
                                           audio thread:   socket → IAudioProcessor::process → socket
Backend (FastAPI)  /api/vst/live/*  spawns / tracks / reaps host processes, returns ws_url
```

- **Host** = our own C++ program in `native/vst-host/`, written by us directly against the VST3 plugin
  interface (the `pluginterfaces` headers every VST3 plugin is compiled against). No framework:
  our own module loading, component/controller lifecycle, bus setup, process call, parameter
  queues, state streams, editor window (Win32) and WebSocket server. JUCE's
  `juce_VST3PluginFormat.cpp` / `extras/AudioPluginHost` and Steinberg's hosting samples are the
  study references for the approach and the edge cases; the code is ours.
- **One host process per live chain entry** (crash isolation; a plugin that dies takes only its
  own process). The backend caps concurrent sessions (default 24) with a clear error.
- **Transport**: WebSocket on `127.0.0.1:<dynamic port>` served by the host itself (our own minimal
  RFC 6455 server over Winsock: no TLS, no extensions, one client at a time, a new
  client replaces a dead one). Never port 3000. The host prints one line to stdout when ready:
  `{"ev":"listening","port":N,"pid":P,"protocol":1}`.
- Works without cross-origin isolation (MessagePort between worklet and bridge). A
  SharedArrayBuffer ring is an optional later optimization behind the same node contract.
- **State is shared with the offline path.** The offline renderer (pedalboard) stores a plugin's
  state as one blob (`raw_state`): a small container holding the VST3 component state and the
  controller state. The host reads and writes that same container format, so the chain entry keeps
  ONE field (`vst.raw_state`): what is dialed in live is what `/api/vst/process-file`
  renders on freeze/export, and states captured by the old editor path load in the live host.
  T40 must prove this round trip with a real plugin (host→pedalboard and pedalboard→host). If it
  does not hold for some plugin, the host reports `state_compat:false` in `ready` and the client
  keeps a separate `vst.live_state` for that entry.

## Host command line

```text
thedaw-vst-host --plugin <path.vst3> [--plugin-name <name> | --class-id <32 hex>]
                [--sample-rate 48000] [--block-size 512] [--channels 2]
                [--state-file <path>] [--port 0] [--idle-timeout 0]
                [--parent-pid <pid>] [--log <file>] [--host-name <name>] [--iid-log]
thedaw-vst-host --null-plugin [...]
thedaw-vst-host --render --plugin <path.vst3> --in <in.wav> --out <out.wav>
                [--plugin-name <name> | --class-id <32 hex>] [--state-file <path>]
                [--params-json <json|path>] [--midi-events <path>] [--block-size <n>]
                [--tail-seconds auto|N] [--host-name <name>] [--iid-log]
thedaw-vst-host --list --plugin <path.vst3>
thedaw-vst-host --selftest
thedaw-vst-host --version
thedaw-vst-host --help
```

- `--plugin-name` / `--class-id`: which audio-effect class inside a multi-plugin
  `.vst3`; without either the first audio-effect class is used, and when the
  file holds more than one a warning names them all. The two are mutually
  exclusive. An audio-effect class is the VST3 `kVstAudioEffectClass`
  ("Audio Module Class"), which instruments share, so an instrument loads the
  same way; there is no instrument flag.
- `--null-plugin`: no VST is loaded; audio passes through with 0 latency (used
  by tests). It and `--plugin` are mutually exclusive.
- Ranges: `--sample-rate` 8000 to 768000, `--block-size` 1 to 16384,
  `--channels` 1 to 8, `--port` 0 to 65535 with 3000 refused, `--idle-timeout`
  0 to 86400 seconds, `--parent-pid` a positive process id. Anything else exits 2.
- `--state-file`: read at start if present (restore), written atomically (temp +
  rename) on `shutdown`, on idle exit, and every time the client sends
  `get_state`.
- `--parent-pid`: exit when that process disappears. `--idle-timeout`: exit
  after N seconds with no client and no open editor; the host's own default is
  0, which never exits. The backend passes 120 unless `THEDAW_VST_LIVE_IDLE_SEC`
  names another value.
- `--host-name`: the name `IHostApplication::getName()` reports to the plugin.
  `--iid-log`: record every interface the plugin asks the host's objects for,
  and print the list. Both apply to a served session, a render and `--list`.
- `--list`: print the file's plugin classes as a JSON array of
  `{name, vendor, version, category, identifier, format}` and exit (no
  instantiation). It cannot be combined with `--render` or `--selftest`.
- `--version`: print `{"name":"thedaw-vst-host","version","protocol":1,"vst3":bool,"build"}`
  and exit.
- `--render`: see "Offline render mode" below.
- stdin: line-delimited JSON, `{"op":"shutdown"}` (write state file, exit 0).
  EOF on stdin = shutdown. Any other stdin op is logged and ignored.
- Must not flash a console window when spawned with `CREATE_NO_WINDOW`;
  stdout/stderr must work when piped.
- Exit codes: 0 clean, 1 the render could not be written, 2 bad args, 3 plugin
  file not found, 4 plugin failed to load/initialize, 5 unsupported bus layout,
  6 socket error, 7 unreadable input file.

## Offline render mode (`--render`)

- Reads a PCM 16/24/32-bit or 32-bit float RIFF/WAVE file, processes it with
  the plugin in `kOffline` mode faster than real time, compensates the plugin's
  reported latency, renders its tail, and writes a 32-bit float WAV at the
  input's rate and channel count. A JSON report line goes to stdout, with a
  `warnings` array.
- `--tail-seconds auto` (the default): the plugin's reported tail, capped at 30
  s; a plugin that reports an infinite tail gets 10 s. A number sets the tail
  from 0 to 600 s.
- `--params-json`: inline JSON when the value starts with `{` or `[`, otherwise
  the path of a JSON file.
- `--midi-events`: a text file of MIDI the plugin plays during the render (an
  instrument), one message per line, `<sample frame> <status> <data1> [<data2>]`
  in decimal. Blank lines and lines starting with `#` are skipped. A line that
  is not a channel voice message, or has a negative frame, is skipped and
  counted in a warning. A `--midi-events` file that cannot be read exits 7.
- The render refuses an output past 0xFFFF0000 data bytes (the largest WAV data
  chunk) before it allocates, and gives up after 3600 s of wall clock.
- The backend uses this mode for `POST /api/vst/process-file` and
  `POST /api/vst/render-midi` when the state was captured by this host
  (`state_host: "thedaw"`). For `render-midi` it stages `duration` seconds of
  silence at the request's rate and channel count, writes the track's messages
  at their sample frames to the `--midi-events` file, and passes
  `--block-size 1024` and `--tail-seconds 0`, since the duration already holds
  the release. The backend stops a render of either route that runs past
  300 s.

## Binary frames (audio) — little-endian, one WebSocket binary message per block

```
off  size  field
0    u32   magic  0x4C545356  ("VSTL")
4    u8    type   0 = audio_in (client→host)   1 = audio_out (host→client)
5    u8    channels (1..8; v1 frontend always sends 2)
6    u16   flags  bit0 = transport playing, bit1 = discontinuity (start/seek/loop wrap: host calls reset())
8    u32   seq    block counter chosen by the client; audio_out echoes the seq it answers
12   u32   frames per channel in this message (<= --block-size)
16   f64   position_samples  project timeline position of the first frame (AudioPlayHead)
24   f64   tempo_bpm         0 = unknown
32   ...   float32 planar: ch0[frames], ch1[frames], ...
```
- Exactly one `audio_out` per `audio_in`, same `seq`, same `frames`, in order.
- The output is the plugin's raw output. The plugin's reported latency is NOT compensated inside
  the host; the app's plugin-delay-compensation handles it (see `latency`).
- `frames` may be smaller than block-size — the host processes what it gets.
- Mono/stereo: the host negotiates the plugin's main bus to the requested channel count, falling
  back to stereo with up/down-mix (mono→dup, stereo→mono average) and reports what it did in `ready`.
- The host supplies an `AudioPlayHead` from `position_samples`, `tempo_bpm`, and the playing flag.

## Text frames (control) — UTF-8 JSON, one object per message

Client → host:
| op | fields | effect |
|---|---|---|
| `hello` | `protocol:1` | must be first; host answers `ready` |
| `set_state` | `state_b64` | restore component + controller state (audio thread parked while it runs) |
| `get_state` |  | host answers `state` (and refreshes the state file) |
| `set_param` | `index` (int) or `name`, `value` (normalized 0..1) | queued to the audio thread, delivered through the block's input parameter changes; the controller is told too |
| `get_params` |  | host answers `params` |
| `param_text` | `index` (int), `value` (normalized 0..1) | host answers `param_text` with the plugin's own text for that value; nothing is set |
| `open_editor` | `parent_hwnd?` (decimal string), `x?,y?,w?,h?` (physical px), `title?` | message thread creates the editor. No parent → floating top-level window titled with the plugin's name, always-on-top off, resizable if the plugin allows |
| `editor_rect` | `x,y,w,h` (physical px) | move/clip an embedded editor |
| `close_editor` |  | |
| `bypass` | `on:bool` | host-side soft bypass (keeps processing to preserve tails, outputs dry signal delayed by the plugin latency) |
| `midi` | `events: [{pos, data}]` | queued for the audio thread. `pos`: project timeline position in sample frames at the session's rate; `-1` (any negative number) = now. `data`: one channel voice message as 2 or 3 byte values, status first. See "MIDI (instrument sessions)" |
| `midi_panic` |  | drop every queued message and release every note the queue let through (see below). A panic that finds the queue full gets the `warning` `midi_panic: the MIDI queue is full` |
| `ping` | `t` | host answers `pong` with the same `t` |
| `shutdown` |  | write state file, exit 0 |

Host → client:
| ev | fields |
|---|---|
| `ready` | `protocol`, `plugin:{name,vendor,version,category,identifier,format}`, `latency_samples`, `tail_seconds`, `sample_rate`, `block_size`, `channels_in`, `channels_out`, `has_editor`, `state_compat:bool`, `accepts_midi:true`, `warnings:[...]` |
| `latency` | `latency_samples` — whenever the plugin reports a latency change (`restartComponent(kLatencyChanged)`); the client updates PDC |
| `params` | `list:[{index,name,label,default,value,steps,automatable,discrete,boolean,hidden,read_only,bypass,program_change,text}]` |
| `param` | `index`, `value`, `text` (the plugin's own words for the value). Sent when the user moves a control in the editor (`IComponentHandler::performEdit`), coalesced to at most 30 Hz per parameter. Once the client has asked for `params`, also sent about 120 ms after a `set_param` for every other parameter whose value moved (a program change or a macro moves others) |
| `param_text` | `index`, `value`, `text`. The answer to the `param_text` op |
| `param_gesture` | `index`, `begin:bool`. The user grabbed (`true`) or let go of (`false`) a control in the editor; the end goes out after the gesture's last `param` |
| `state` | `state_b64` |
| `editor` | `open:bool`, `w`, `h` (the editor's size; re-sent when the plugin resizes it) |
| `xrun` | `late_blocks`, `max_process_ms` — at most once per second, only when nonzero |
| `pong` | `t` |
| `warning` | `text` |
| `error` | `text`, `fatal:bool` |

## MIDI (instrument sessions)

An instrument runs in the same kind of session as an effect. The command line,
`POST /session` and `ready` carry no instrument field; the plugin plays notes
because the client sends it `midi` ops. `ready.accepts_midi` is `true` on a host
that takes `midi` and `midi_panic`. A host built before them has no such field
and answers `midi` with an `unknown op` error, so the client sends it no notes
(EDIT's instrument slot then reads Update).

- The client streams `audio_in` blocks to an instrument as it does to an
  effect. EDIT feeds the instrument's node a silent source. The host hands MIDI
  to the plugin only inside `audio_in` blocks, so queued messages wait while no
  block arrives.
- Placement: for each block the host takes every queued message whose `pos` is
  before `position_samples + frames` and gives it to the plugin at offset
  `pos - position_samples`, clamped into the block. A message whose position
  the block has already passed plays at offset 0. `pos: -1` plays at offset 0
  of the next block. Messages at one offset keep their arrival order.
- `pos` is on the same timeline and at the same rate as the frames'
  `position_samples`. EDIT stamps each message with its timeline position less
  the entry's live latency (`latency_samples` plus the bridge's buffering), so
  the plugin's output lands on the beat and the rest of the mix needs no delay
  compensation for it. EDIT never sends a `pos` below 0. The scheduler ticks
  every 25 ms, and EDIT sends one `midi` op for each tick that has messages.
- Accepted: channel voice messages only. The status byte is 0x80 to 0xEF;
  program change (0xC0) and channel pressure (0xD0) take one data byte, every
  other status two; data bytes are 0 to 127. System messages (0xF0 to 0xFF) and
  malformed events are dropped, and a message that finds the message thread's
  queue full is dropped as well. The host then sends one `warning` for the op:
  `midi: N message(s) were not channel voice messages or did not fit, and were dropped`.
  A `midi` op with no `events` array gets a recoverable `error`.
- Queue: up to 8192 messages wait across blocks, and one block carries up to
  1024; the rest wait for the next block. A message the audio thread finds no
  room for among the 8192 waiting is dropped with no `warning`.
- In the plugin (event bus 0): note-on, note-off (a note-on at velocity 0 is a
  note-off) and polyphonic pressure are VST3 events. Controller changes,
  channel pressure and pitch bend reach the parameters the plugin assigns them
  through its `IMidiMapping`; a controller the plugin assigns no parameter to
  does nothing. Program changes are dropped: the plugin plays the preset in its
  state.
- `midi_panic` (EDIT sends it on stop, seek and loop wrap): the host drops
  every waiting message, sends a note-off for every note it let through and has
  not seen released, and sends CC 64 = 0 on each channel that had such a note,
  in the next block.

### Articulations over `midi`

Articulations have no op of their own. They arrive as ordinary messages in the
`midi` ops, ahead of the notes they switch, on every channel the clip's notes
play on. The track's articulation switch picks the form:

- Keyswitch: a note-on at velocity 1 on the articulation's key, stamped one
  tick (1/960 of a beat) before the note, and its note-off 1 ms later.
  theDAW's default keys are ordinario 12 (C0), then legato 13, staccato 14,
  spiccato 15, marcato 16, pizzicato 17, tremolo 18, col legno 19, harmonics
  20, con sordino 21.
- UACC: CC 32 with the UACC value at the same place (ordinario 1, tremolo 11,
  marcato 52, pizzicato 56). Any other articulation falls back to its
  keyswitch. CC 32 reaches the plugin through its `IMidiMapping` like any other
  controller.

A switch goes out where the articulation changes. When any note of the track
has an articulation, the clip's first note gets its switch too, and a switch in
force where playback starts is sent there. The offline print
(`POST /api/vst/render-midi`) carries the same switches, with the keyswitch
note-off one tick after its note-on.

## Threads and real-time rules (host)

- Message thread (main): COM init, Win32 message loop, plugin creation/destruction, controller calls,
  editor windows (`IPlugView`, `IPlugFrame`), state get/set, re-setup on restart flags. Per-monitor-v2
  DPI awareness is on before any window exists.
- Audio thread: a realtime-priority thread (MMCSS "Pro Audio") that owns the client socket
  reads/writes and the `IAudioProcessor::process` call. No allocation, blocking locks, logging or
  JSON parsing inside the process call — control messages are parsed on the socket side and handed
  over through lock-free queues; parameter changes ride the block's `IParameterChanges`.
- Anything that must not overlap `process` (state set/get, `setProcessing/setActive` cycling on
  latency or bus changes) parks the audio thread first with a handshake, then resumes it.
- A plugin crash must never leave a half-written state file.

## Backend API (FastAPI, `/api/vst/live`)

- `POST /session` `{chain_entry_id, plugin_path, plugin_name?, sample_rate, block_size?=512, channels?=2, raw_state?}`
  → `{session_id, ws_url, pid, protocol:1}`. Idempotent per `chain_entry_id` while the process is
  alive (returns the existing session). Spawn is guarded by a lock; the port is read from the host's
  `listening` line (timeout 30 s → 504 with the log tail). `raw_state` is written to the session's
  state file before the spawn so the plugin starts with it.
- `GET /session/{id}` → `{alive, pid, port, started_at, log_tail}`; `GET /sessions`.
- `DELETE /session/{id}` → `{"op":"shutdown"}` on the host's stdin (it writes the state file),
  returns `{raw_state}` read from that file; force-kills after 5 s.
- `GET /host` → `{available:bool, path, version, reason?}` so the UI can say why live VST is off
  (host binary missing → how to build it).
- Host binary lookup order: env `THEDAW_VST_HOST`, `native/vst-host/bin/thedaw-vst-host.exe`.
  All sessions are killed on backend shutdown (lifespan hook); `--parent-pid` covers a backend crash.

## Frontend node contract

- `buildEffectChain` gets a `vst3` resolver branch (not a `RACK_EFFECTS` entry — `getRackEffect('vst3')`
  stays undefined). The factory is synchronous: it returns a passthrough `RackEffectInstance`
  immediately, opens the session in the background, and swaps the worklet in when `ready` arrives
  (the `makeChop` pattern). Offline contexts (`OfflineAudioContext`) always get passthrough — offline
  render keeps using `/api/vst/process-file`.
- Sessions live in a registry keyed by `ChainEntry.id` that outlives chain rebuilds: `dispose()` of
  an instance starts a 10 s grace timer instead of closing the session, so play/stop/seek (which
  rebuild every chain) reuse the running plugin. Removing the entry or closing the project closes it.
- The worklet batches 128-frame quanta into `block_size` blocks and plays processed audio
  `buffer_blocks` (default 2) behind. Latency declared to PDC =
  `plugin latency_samples + block_size * (buffer_blocks + 1)`, stored per entry in `vstLiveStore`
  and surfaced to `chainLatencyReport` so `syncTrackLatency` moves the compensation delays.
  An underrun outputs silence for that quantum and counts into an `xrun` stat shown on the FX row.
- A bypassed entry never opens a session. An entry whose host is unavailable shows the reason and
  stays passthrough (never silent).
- Editor: "Edit GUI" on a live entry sends `open_editor` to the live session (the instance that is
  sounding). `param` events update the entry's params; `state` is captured on editor close, on
  project save, and every 5 s while the editor is open, into `entry.vst.raw_state`.
- Instrument slot: an EDIT track's instrument is a `vst3` chain entry in the
  track's `instrument` field, hosted by the same registry keyed by its id. Its
  branch is a silent `ConstantSource` into the entry's node, whose output
  passes the clip envelope gain into the track. `lib/vstLive/instrumentLive`
  sends the track's MIDI over `midi` and sends `midi_panic` when the pass stops.
  It sends nothing to a session whose `ready` lacks `accepts_midi: true`.
