# Quest MIDI port isolation

The Quest MIDI bridge keeps the headset's established device-side port separate from the desktop listener:

- Host listener: `127.0.0.1:8766`
- Quest device port: `8765`
- ADB mapping: `tcp:8765` on the Quest to `tcp:8766` on the host
- Backend HTTP mapping: `tcp:8600` to `tcp:8600`

Set `theDAW_QUESTMIDI_PORT` to override the host listener port. Set `theDAW_QUESTMIDI_DEVICE_PORT` to override the Quest device port. Empty, non-numeric, zero, negative, and out-of-range values fall back to their respective defaults.

The Quest MIDI status response reports the resolved host port as `port` and the resolved Quest-side port as `device_port`.
