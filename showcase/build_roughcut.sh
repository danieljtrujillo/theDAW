#!/usr/bin/env bash
# Assemble the theDAW showcase from the warm-session clips, with burned-in subtitles,
# scored to "et tu machina_.mp3". Horizontal (16:9) and vertical (9:16, punch-in crops).
#   bash showcase/build_roughcut.sh h     (or v)
# Run from repo root. Clips are silent; the song is the only audio.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DIR="showcase/clips-recorded"
SONG="et tu machina_.mp3"
ORI="${1:-h}"
FONT="showcase/.font.ttf"
[ -f "$FONT" ] || cp /c/Windows/Fonts/segoeuib.ttf "$FONT"

# Per scene: id | seconds | h-crop | v-crop | start | subtitle
#   h-crop "full" or CW:CH:CX:CY ; v-crop is the 9:16 punch-in region ; start "" = clean tail.
# Order: a rapid-fire opening blast, then the full feature tour. Subtitles are lower-case
# and plain on purpose.
# A "song being made in theDAW" arc, built around Et Tu Machina: hook -> make -> arrange ->
# mix -> perform -> visualize -> lineage -> ecosystem. Order is the narrative; durations flex.
SCENES=(
  # hook
  "50_cymatics|5.0|1680:945:120:70|608:1080:656:0|0.5|Real-time cymatics visualizer"
  # genealogy — the 3D graph flies into the piano roll that opens make
  "01a_learn-2d-hero|1.9|full|608:1080:656:0|19.0|Interactive lineage graph"
  "65_3d-piano|3.5|full|608:1080:656:0|1.5|3D genealogy graph"
  # make — opens at the piano roll the 3D graph flew into
  "65_3d-piano|3.5|full|608:1080:656:0|5.0|Built-in piano roll"
  "08_make|1.4|full|608:1080:656:0||Generate audio from a text prompt"
  "23_chimera|1.6|full|608:1080:656:0||Blend multiple clips with Chimera"
  "25_init-audio|1.4|full|608:1080:656:0||Audio-to-audio generation"
  "21_inpaint|1.4|full|608:1080:656:0||Regenerate any section with inpainting"
  "45_saved-prompts|1.2|full|608:1080:656:0||Save and reuse prompts"
  "05_sequencer|1.3|full|608:1080:656:0||Built-in step sequencer"
  "58_spectrogram|1.9|full|608:1080:656:0||Mel, STFT, chroma, and CQT spectrograms"
  # arrange + edit
  "03_edit-stems|1.9|full|608:1080:656:0||Arrange stems on a timeline"
  "22_cut-edit|1.5|full|608:1080:656:0||Cut, split, and chop clips"
  "41_delete-clip|1.3|full|608:1080:656:0||Full multitrack editing"
  "31_edit-mix|1.4|full|608:1080:656:0||Live per-track mixing"
  "40_inpaint-region|1.4|full|608:1080:656:0||Paintbrush region inpainting"
  "59_commit-edit|1.5|full|608:1080:656:0||Render a 44.1 kHz master"
  # mix
  "07_mix-effects|1.4|full|608:1080:1312:0||Studio effects rack"
  "57_mix-all-effects|2.0|full|608:1080:400:0||Stack effects on any clip"
  "66_module-gui|1.7|full|608:1080:1312:0||14 pro studio instruments"
  "32_mix-chain|1.4|full|608:1080:400:0||Build a mastering chain"
  "27_lora|1.3|full|608:1080:1312:0||Load custom LoRA models"
  "39_design-mode|1.6|full|608:1080:656:0||Rearrange the entire interface"
  # perform (dj)
  "02_dj-console|1.5|full|540:960:690:90||Two-deck DJ console"
  "54_dj-perform|2.0|full|540:960:690:90||Hot cues, loops, and FX"
  "55_dj-automix|1.5|full|540:960:690:90||Hands-free automix"
  "56_dj-stems|1.4|full|540:960:690:90||Live stem control per deck"
  "33_dj-sampler|1.4|full|608:1080:300:0||Sampler and staging deck"
  # visualize
  "50_cymatics|5.0|1680:945:120:70|608:1080:656:0|6.8|Cymatic platform mode"
  "50_cymatics|5.0|1680:945:120:70|608:1080:656:0|12.5|Liquid-chrome mode"
  "50_cymatics|5.0|1680:945:120:70|608:1080:656:0|18.5|Ferrofluid valley mode"
  "12_slide-surface|1.5|full|608:1080:500:0||Performance slider surface"
  "19_vj-visualizer|3.5|full|608:1080:750:0||Live VJ visual engine"
  "70_vj-mobile|1.6|full|608:1080:1312:0||Mirror visuals to a phone"
  "04_visualize|1.2|full|608:1080:656:0||Live spectrum analyzer"
  "15_analyzer-scope|1.2|full|608:1080:656:0||Oscilloscope"
  "16_analyzer-radial|1.3|full|540:960:830:120||Radial analyzer"
  # ecosystem
  "14_catalogue|1.5|full|608:1080:300:0||Your entire audio library"
  "13_details|1.3|full|608:1080:300:0||Full metadata on every track"
  "24_focus|1.4|full|608:1080:656:0||Focus mode for any control"
  "17_controller|1.4|full|608:1080:656:0||Map any MIDI controller"
  "69_controller-vision|1.7|full|608:1080:656:0||Identify a controller from a photo"
  "20_train|1.7|full|608:1080:656:0||Train LoRAs on your own sound"
  "63_magenta-studio-live|1.8|full|608:1080:656:0||Magenta RT2 on a local GPU"
  "62_magenta-card|2.0|full|600:1080:540:0||The first non-Mac Magenta RT2 port"
  "10_suno-cloud|1.4|full|608:1080:560:0||Cloud generation via Suno"
  "44_url-import|1.3|full|608:1080:120:0||Import your own audio from a URL"
  "18_media-bucket|1.2|full|608:1080:120:0||Drop in any media file"
  "11_assistant-orb|2.6|full|608:1080:0:0||Analyze and automate through the Orb Assistant (dozens of local or API models)"
  "37_docs|1.5|full|608:1080:656:0||Built-in interactive docs"
  "38_settings|1.6|full|608:1080:656:0||Modular feature toggles"
)

# Output is upscaled 2x to 4K (3840x2160 / 2160x3840) via lanczos from the crisp
# supersampled-1080 source clips: highest quality, no native-4K reflow, no artifacts.
# Subtitle geometry (size, bottom offset, border, line spacing) is scaled 2x to match
# the larger canvas so text stays sharp and proportioned exactly as at 1080. WRAP is a
# character count, so it is resolution-independent and stays the same.
# Subtitles: bigger + raised off the bottom. Vertical sits higher (above the lower-third).
if [ "$ORI" = "v" ]; then W=2160; H=3840; SUBY="h-1000"; SUBSZ=104; WRAP=24; else W=3840; H=2160; SUBY="h-320"; SUBSZ=88; WRAP=48; fi
BORDERW=32; LSP=12

TMP="showcase/.roughtmp_${ORI}"
rm -rf "$TMP"; mkdir -p "$TMP"
CLIST="$TMP/clist.txt"; : > "$CLIST"   # clean segments
SLIST="$TMP/slist.txt"; : > "$SLIST"   # subtitled segments
SRT="$DIR/_showcase_${ORI}.srt"; : > "$SRT"

# Crop coords in SCENES are authored in 1920x1080 space. Clips can be shot at different widths
# across runs, so scale each clip's crop by ITS OWN source width / 1920.
scale_crop() { echo "$1" | awk -F: -v s="$2" '{printf "%d:%d:%d:%d", 2*int($1*s/2+0.5), 2*int($2*s/2+0.5), int($3*s+0.5), int($4*s+0.5)}'; }
srt_ts() { awk -v t="$1" 'BEGIN{h=int(t/3600); m=int((t-h*3600)/60); s=t-h*3600-m*60; printf "%02d:%02d:%06.3f", h, m, s}' | sed 's/\./,/'; }

i=0; cum=0
for row in "${SCENES[@]}"; do
  IFS='|' read -r id dur hcrop vcrop start sub <<< "$row"
  f="$DIR/${id}_h.mp4"; [ -f "$f" ] || f="$DIR/${id}_h.webm"
  if [ ! -f "$f" ]; then echo "skip (missing) ${id}"; continue; fi

  if [ "$ORI" = "v" ]; then crop="$vcrop"; elif [ "$hcrop" = "full" ]; then crop=""; else crop="$hcrop"; fi
  if [ -n "$crop" ]; then cw="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nk=1:nw=1 "$f")"; sf="$(awk -v w="${cw:-1920}" 'BEGIN{printf "%.5f", w/1920}')"; crop="$(scale_crop "$crop" "$sf")"; geom="crop=${crop},scale=${W}:${H}:flags=lanczos"; else geom="scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}"; fi

  clip_dur="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$f")"
  if [ -z "$start" ]; then start="$(python -c "print(max(0.0, ${clip_dur} - ${dur} - 0.3))")"; fi

  subfile="$TMP/sub_$(printf '%02d' "$i").txt"; printf '%s' "$sub" | fold -s -w "$WRAP" | sed 's/[[:space:]]*$//' > "$subfile"
  draw="drawtext=fontfile=${FONT}:textfile=${subfile}:x=(w-text_w)/2:y=${SUBY}:fontsize=${SUBSZ}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=${BORDERW}:line_spacing=${LSP}"
  cseg="$(printf 'cseg_%02d.mp4' "$i")"; sseg="$(printf 'sseg_%02d.mp4' "$i")"
  # ONE high-quality encode each (clean + subtitled) — no second re-encode pass.
  ffmpeg -y -loglevel error -ss "$start" -t "$dur" -i "$f" -an -vf "${geom},fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p "$TMP/$cseg"
  ffmpeg -y -loglevel error -ss "$start" -t "$dur" -i "$f" -an -vf "${geom},${draw},fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p "$TMP/$sseg"
  printf "file '%s'\n" "$cseg" >> "$CLIST"
  printf "file '%s'\n" "$sseg" >> "$SLIST"

  st="$cum"; en="$(awk -v a="$cum" -v b="$dur" 'BEGIN{printf "%.3f", a+b}')"
  printf '%d\n%s --> %s\n%s\n\n' "$((i + 1))" "$(srt_ts "$st")" "$(srt_ts "$en")" "$sub" >> "$SRT"
  cum="$en"
  echo "  + ${id} (${dur}s) — ${sub}"
  i=$((i + 1))
done

# concat (stream copy — NO extra generation) then mux the song (copy)
CLEAN_SILENT="$TMP/clean.mp4"; ffmpeg -y -loglevel error -f concat -safe 0 -i "$CLIST" -c copy "$CLEAN_SILENT"
SUB_SILENT="$TMP/subbed.mp4";  ffmpeg -y -loglevel error -f concat -safe 0 -i "$SLIST" -c copy "$SUB_SILENT"
VLEN="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$CLEAN_SILENT")"

CLEAN_OUT="$DIR/_showcase_${ORI}_clean.mp4"
ffmpeg -y -loglevel error -i "$CLEAN_SILENT" -i "$SONG" -map 0:v -map 1:a -t "$VLEN" -c:v copy -c:a aac -b:a 256k -shortest "$CLEAN_OUT"
OUT="$DIR/_showcase_${ORI}.mp4"
ffmpeg -y -loglevel error -i "$SUB_SILENT" -i "$SONG" -map 0:v -map 1:a -t "$VLEN" -c:v copy -c:a aac -b:a 256k -shortest "$OUT"
rm -rf "$TMP"
echo "wrote $OUT + $CLEAN_OUT + $SRT  (${VLEN}s, ${W}x${H})"
