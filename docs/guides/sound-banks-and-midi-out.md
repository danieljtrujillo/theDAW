# Sound banks and MIDI out

theDAW plays MIDI parts on its soundfont synths, which load the bundled General
MIDI bank and any SF2, SF3 or DLS sound bank the user adds or downloads. A track
can also send its MIDI to an external device or host through a MIDI output
port, or play through a VST3 instrument in its EDIT instrument slot. This guide
covers the sound banks, how a track or clip picks a sound, MIDI out, MIDI thru,
and the limits on printing a VST3 instrument.

## The bundled General MIDI bank

The soundfont synths always hold the bundled General MIDI bank, which ships with
the app. Its bank 0 is the General MIDI set of 128 instruments, listed in every
instrument select by number and name, from "1. Acoustic Grand Piano" on. Its
variation banks (bank select 1 to 26) and its drum kits follow, grouped as the
bank's name and "bank N", or the bank's name and "kits". The Sound banks dialog
lists the bundled bank first, marked Bundled with its preset count. It has no
Remove button.

## Adding a sound bank of your own

The Banks button beside an Instrument select opens the Sound banks dialog. The
button shows how many banks of your own are loaded. In the strip along the top
of the MIDI tab the button shows only its icon, and its name is Sound banks.
Add sound bank… picks an .sf2, .sf3 or .dls file. theDAW copies the file into
the soundfonts folder of its data folder and reads the bank's presets, showing
"Reading the bank…" while it works. The file you picked stays where it was. The
new bank's presets appear in every instrument select at once, one group per
bank inside the file, and the LOG names the bank, its preset count and its
first bank select number. When a bank cannot be added, the reason shows in red
under the dialog's list and in the LOG.

Each row of the dialog shows the bank's name, its format, its preset count, the
bank select numbers it plays from and its size. The row of a downloaded bank
starts with Downloaded. Under the list, "Bank files theDAW has seen" lists bank
files on this machine that theDAW remembers and that are not loaded now, for
example one added from its path and later removed, each with an Add button. The
copies theDAW stores and the banks it downloads are not in that list.

A sound bank file can be at most 4,294,967,304 bytes (4 GiB plus 8 bytes), the
largest size a RIFF file can have. A larger file is refused. Bytes after the
end of the bank's own data are not kept. A file with another extension is
refused with "A sound bank is an .sf2, .sf3 or .dls file.", and a file theDAW
cannot read is refused with a message that it is not a sound bank theDAW can
read.

Add sound bank… sends the file through `POST /api/soundfonts/upload`. The Add
buttons under "Bank files theDAW has seen" use `POST /api/soundfonts/add-path`,
which reads a path on this machine and answers only this machine's own UI and
the desktop app. `GET /api/soundfonts` lists the banks, and
`DELETE /api/soundfonts/{id}` removes one.

## Bank select numbers of a sound bank

Each sound bank you add gets bank select numbers of its own when it is added,
and keeps them. User banks take numbers from 32 to 119, as many as the bank's
melodic banks need, and no two banks overlap. The bundled bank uses 0 to 26 and
120. The dialog row shows the numbers, for example "bank select 32-35". A preset
plays at its bank's numbers live, in renders and in exported MIDI files. When no
range is free, adding a bank fails with "No bank select range is free for this
bank: remove a sound bank first."

A drum kit is chosen by its program number alone. A kit in your own bank whose
program number a bundled kit also has is listed with "(bundled kit plays)",
because the bundled kit plays in its place.

## Removing a sound bank

A bank you added has a Remove button. It takes the bank off the list and
deletes the stored copy; the file you added it from stays. A downloaded bank has
a Delete button, which asks "Delete from disk?" with Delete and Keep. Delete
removes the downloaded file, which can be downloaded again from Settings, Sound
banks.

Parts that play a removed bank's presets fall back to the bundled bank's preset
at the same bank and program. A select that holds a preset from a bank that is
not listed shows it as "Bank" with the bank number and program number, for
example "Bank 2 · 49". A project opened on a machine that lacks the bank plays
the same way.

## Downloading orchestral sound banks in Settings

Settings has a Sound banks section that lists orchestral sound banks with their
licence before anything downloads. Each row shows the bank's name, format and
size, a state word (Available, Downloading, Installed, Failed or External), a
summary, and "Licence:" with the licence name as a link and one line on what it
allows.

- theDAW Orchestra (SF3, CC0 1.0 Universal): strings, woodwinds, brass, harp
  and orchestral percussion from VSCO 2 CE and VCSL. Sustained parts swell
  between dynamic layers on CC 1. The download takes the newest release of
  gantasmo/theDAW whose tag starts with soundbank-orchestra, with the bank's
  manifest (theDAW-Orchestra.json) and attribution file. When no published
  release carries the bank, the download fails and the row reads Failed.
- Sonatina Symphonic Orchestra (SF2), Creative Commons Sampling Plus 1.0: one
  SF2 per section and articulation, in a zip of 512,093,492 bytes. The zip is
  unpacked and only its bank and text files are kept.
- Sonatina Symphonic Orchestra (SFZ, current) and Virtual Playing Orchestra 3:
  SFZ libraries, which the soundfont synths cannot load. Their rows read
  External and have an Open download page button. They play in an SFZ player
  such as sfizz, loaded as a VST3 instrument in an EDIT track's instrument slot.

A downloadable row has a Download button (Download again once installed,
Downloading while it runs) and a Source link. Downloads land in the soundbanks
folder of theDAW's data folder, one folder per bank. Each bank file is listed in
every instrument select the moment its download finishes, at bank select numbers
of its own. A bank downloaded in an earlier session is listed the next time the
app reads the bank list. The routes are `GET /api/models/soundbanks` and
`POST /api/models/soundbanks/{id}/download`.

## Playback gain of a sound bank

A sound bank can carry a build manifest with a playback gain for each preset.
The downloaded theDAW Orchestra has one. A bank added from its path (an Add
button under "Bank files theDAW has seen", or the assistant) with a manifest of
the same name beside it (theDAW-Orchestra.json beside theDAW-Orchestra.sf3)
keeps that manifest. Add sound bank… sends the bank file alone, so a bank added
that way plays at its own level. The app adds each preset's gain after the
synth, live and in renders, which lifts a quiet preset to the level its build
measured against the bundled bank. A bank without a manifest plays at its own
level.

A playback gain is held to 24 dB either way. A lift is capped so that one
velocity-127 note at CC 7 = 127 stays under -0.3 dBFS. While a lifted preset
plays, a safety limiter at the end of the master chain holds the whole sum
under -0.3 dBFS, and a render or bounce limits its sum the same way. Audio that
stays under the ceiling passes the limiter unchanged. A drum channel that picks
a kit the bundled bank also holds plays the bundled kit at unity gain.

## Choosing a sound for a track or a clip

An EDIT track that holds MIDI shows an instrument select in its header. It
lists Default (the sound of the global Instrument select), External only,
Instruments (the 128 General MIDI instruments), Drum kits, and then each sound
bank's presets grouped by bank. On a drum track Drum kits comes before
Instruments. Picking a bank preset sets the track's program together with its
bank. The first key in the row (a piano, or a drum on a drum track) makes the
track a drum track, and the cable key after it opens the track's MIDI out
panel. After the select, a dot and one word say how the track sounds on the
next play: Live (it plays live, on EDIT's synths or through its VST3
instrument), Bounce (its rendered audio plays) or Port (External only). Rev
sets the track's synth reverb send (CC 91) from 0 to 127; blank leaves the
synth's own.

A single MIDI clip can play a sound of its own. Right-click the clip and choose
Instrument to open the Clip instrument picker. It lists Track default to follow
the track, then the General MIDI instruments (the drum kits on a drum track),
then the sound banks' presets.

The Instrument select in the strip along the top of the MIDI tab, in the
arpeggiator (ARP) and in the Vocal2MIDI column (VOICE) sets the global sound
that Default follows. It lists Basic (sawtooth), the Synth voices, the
Orchestra instruments by family, General MIDI and the sound banks' presets.

A project (.tasmo) stores a preset as its bank id, its bank inside that file
and its program. A track whose instrument slot holds a VST3 instrument plays its
MIDI through the plugin in place of the soundfont synths; the guide on VST3
plugins covers the slot.

## MIDI out to an external device or host

The cable key in an EDIT track's header opens the track's MIDI out panel, titled
with the track's name and "MIDI out".

- Output port: None (inside theDAW), or one of the MIDI output ports the system
  offers through Web MIDI. A saved port that is not open is listed with "(not
  open)" and the cable key turns amber. A saved port is found again by its id,
  else by its name. A track whose port is not open sends nothing to it, and the
  LOG names the track when playback starts.
- Channel: 1 to 16, the channel the track's notes go out on. Bent lanes and
  expressive notes take the channels after it, wrapping past 16. It can be set
  once a port is chosen.
- Expression: "Off: on the track's channel", or "Rotate across" 1 to 15
  channels (8 by default). Notes with their own pressure, timbre or bend each
  get a channel of their own from that many, MPE-style.
- Send clock and song position: the port gets MIDI clock at 24 per quarter note
  following EDIT's tempo map, a Song Position Pointer where playback starts,
  with Start when playback starts at the top and Continue anywhere else, and
  Stop where it stops. It is sent whenever EDIT plays, arrangements with no
  MIDI included. The checkbox can be set once a port is chosen.

While EDIT plays, the port gets everything the track's live MIDI does: bank
select and program (each program change with CC 0 and CC 32 before it), notes,
the pitch wheel and bend range, controllers, and each expressive note's
pressure on its member channel. Each message is stamped with the moment it
sounds. A stop or a seek sends a note-off for every note the port still holds.
The track still plays on its sound inside theDAW; pull the track fader down to
hear the port alone. A project saves the port, its name, the channel, the clock
setting and the Expression setting with the track.

## External only tracks

External only in a track's instrument select makes the track play through its
MIDI out port alone. It reads "External only (MIDI out port)" until a port is
set, then names the port. No synth of theDAW's sounds the track, its VST3
instrument slot plays nothing, and no program change or bank select goes to the
port, so the external instrument keeps its own patch. With no port set, the
track's MIDI clips make no sound. The status word reads Port. Picking any sound
of theDAW's in the select ends External only.

An External only track's articulated notes play shaped on the track's own
channel, a staccato at half its length for example. No keyswitch, UACC value or
General MIDI preset change is sent. A bounce, freeze or export leaves the
track's MIDI clips out, because theDAW's audio holds no sound of them. The
arrangement's MIDI export still writes their notes, and the track's audio clips
play and render as on any track.

## MIDI thru

Settings, Inputs & outputs, has a MIDI out row with a select for the MIDI thru
output port. It forwards everything that arrives on theDAW's MIDI inputs
(hardware ports, the Quest bridge and the Audima Labs Sway surface) to one
output port, byte for byte. The row notes "thru only — no clock is sent". The
first choice, Don't send MIDI, is the default and forwards nothing. The choice
is saved on the server, so the browser and the desktop app share it. A browser
without Web MIDI shows "Web MIDI is unavailable in this browser".

## Printing a VST3 instrument: length and size limits

Every bounce, freeze and export prints each VST3 instrument track through
`POST /api/vst/render-midi`. theDAW sends one track per request at 44.1 kHz
stereo, from the track's first clip in scope to its last MIDI message plus 4
seconds of release. The LOG shows "Printing VST instruments for the bounce"
with a count. A print that fails stops the bounce with the message Track "name"
could not be printed through its instrument, where name is the track's name,
followed by the reason.

The route takes at most 64 tracks per request. Each track may run at most 3,600
seconds (one hour) with its tail and carry at most 1,000,000 MIDI messages. The
sample rate must be 8,000 to 192,000 Hz and the channel count 1 to 8.

The audio a request asks for, all its tracks together, is counted as seconds
times sample rate times channels times 4 bytes (32-bit float samples). That
count must stay within the byte budget set by the backend's
`THEDAW_VST_RENDER_MAX_BYTES` environment variable, 2 GiB (2,147,483,648 bytes)
by default. A value that is not a whole number above 0 keeps the default. The
same budget caps the audio uploaded to `POST /api/vst/process-file` when the
plugin's state was captured by theDAW's own live host. A request past the
budget is refused before any plugin loads, with a message that names the bytes
it would hold and the budget.

| One stereo track, default budget | Longest span the budget allows |
|---|---|
| 44.1 kHz | 6,086.9 s (101.4 min); the one-hour limit applies first |
| 48 kHz | 5,592.4 s (93.2 min); the one-hour limit applies first |
| 96 kHz | 2,796.2 s (46.6 min) |
| 192 kHz | 1,398.1 s (23.3 min) |

For one stereo track the budget is the tighter limit only above about 74.6 kHz.
theDAW's own prints run at 44.1 kHz stereo, so a print covers at most one hour:
3,596 seconds of part plus the 4-second tail. A print of a state that theDAW's
live host captured renders through theDAW's own host, which stops a render that
runs past 300 seconds.

## Sound banks and the assistant

The in-app assistant has actions for this guide's features.
`editor_list_sound_banks` lists the user's sound banks, each with its bank
select offset and presets. `editor_load_sound_bank` adds an .sf2, .sf3 or .dls
bank from a path on this machine. `editor_set_track_instrument` puts a scanned
VST3 instrument in a track's instrument slot, switches the slot on or off, or
empties it.
