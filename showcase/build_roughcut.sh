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
SCENES=(
  "03_edit-stems|1.5|full|608:1080:656:0||six stems from one track"
  "02_dj-console|1.5|full|540:960:690:90||a real two-deck dj console"
  "01a_learn-2d-hero|1.9|full|608:1080:656:0|19.0|every track remembers its lineage"
  "05_sequencer|1.3|full|608:1080:656:0||a step sequencer"
  "08_make|1.4|full|608:1080:656:0||generate audio from a prompt"
  "04_visualize|1.2|full|608:1080:656:0||live spectrum"
  "32_mix-chain|1.5|full|608:1080:400:0||stack studio effects"
  "17_controller|1.4|full|608:1080:656:0||map any midi controller"
  "06_piano-roll|1.3|full|608:1080:300:0||a piano roll"
  "01b_learn-3d-hero|1.8|full|608:1080:656:0||fly through the 3d lineage"
  "23_chimera|1.7|full|608:1080:656:0||fuse clips into a chimera"
  "21_inpaint|1.5|full|608:1080:656:0||repaint any section"
  "25_init-audio|1.5|full|608:1080:656:0||seed it with your own audio"
  "22_cut-edit|1.9|full|608:1080:656:0||cut and arrange on a timeline"
  "41_delete-clip|1.5|full|608:1080:656:0||edit like a daw"
  "31_edit-mix|1.5|full|608:1080:656:0||mix the stems live"
  "07_mix-effects|1.5|full|608:1080:1312:0||a full studio effects rack"
  "39_design-mode|1.9|full|608:1080:656:0||rearrange the entire interface"
  "33_dj-sampler|1.6|full|608:1080:300:0||sampler and staging deck"
  "19_vj-visualizer|2.0|800:450:1120:230|608:1080:1312:0||drive live visuals"
  "20_train|1.7|full|608:1080:656:0||train your own model"
  "15_analyzer-scope|1.3|full|608:1080:656:0||oscilloscope"
  "16_analyzer-radial|1.3|full|540:960:830:120||radial analyzer"
  "12_slide-surface|1.6|full|608:1080:500:0||performance sliders"
  "24_focus|1.5|full|608:1080:656:0||focus on one control"
  "40_inpaint-region|1.5|full|608:1080:656:0||paintbrush inpainting"
  "18_media-bucket|1.3|full|608:1080:120:0||drop in any file"
  "44_url-import|1.5|full|608:1080:120:0||or pull from a link"
  "13_details|1.4|full|608:1080:300:0||full metadata on everything"
  "42_lib-actions|1.7|full|608:1080:300:0||browse the whole catalogue"
  "11_assistant-orb|1.7|full|608:1080:0:0||an assistant that runs the app"
  "14_catalogue|1.7|full|608:1080:300:0||your entire library"
  "10_suno-cloud|1.7|full|608:1080:560:0||or render in the cloud"
  "27_lora|1.3|full|608:1080:1312:0||load loras"
  "45_saved-prompts|1.3|full|608:1080:656:0||save your prompts"
  "36_log|1.3|full|608:1080:1312:0||watch every job run"
  "37_docs|1.6|full|608:1080:656:0||documented from the inside"
  "38_settings|1.6|full|608:1080:656:0||modular, all of it"
)

if [ "$ORI" = "v" ]; then W=1080; H=1920; SUBY="h-360"; SUBSZ=42; else W=1920; H=1080; SUBY="h-78"; SUBSZ=32; fi

TMP="showcase/.roughtmp_${ORI}"
rm -rf "$TMP"; mkdir -p "$TMP"
LIST="$TMP/list.txt"
: > "$LIST"
i=0
for row in "${SCENES[@]}"; do
  IFS='|' read -r id dur hcrop vcrop start sub <<< "$row"
  f="$DIR/${id}_h.mp4"; [ -f "$f" ] || f="$DIR/${id}_h.webm"
  if [ ! -f "$f" ]; then echo "skip (missing) ${id}"; continue; fi

  if [ "$ORI" = "v" ]; then crop="$vcrop"; elif [ "$hcrop" = "full" ]; then crop=""; else crop="$hcrop"; fi
  if [ -n "$crop" ]; then geom="crop=${crop},scale=${W}:${H}"; else geom="scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}"; fi

  subfile="$TMP/sub_$(printf '%02d' "$i").txt"
  printf '%s' "$sub" > "$subfile"
  draw="drawtext=fontfile=${FONT}:textfile=${subfile}:x=(w-text_w)/2:y=${SUBY}:fontsize=${SUBSZ}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=14:line_spacing=6"

  clip_dur="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$f")"
  if [ -z "$start" ]; then start="$(python -c "print(max(0.0, ${clip_dur} - ${dur} - 0.3))")"; fi
  seg="$(printf 'seg_%02d.mp4' "$i")"
  ffmpeg -y -loglevel error -ss "$start" -t "$dur" -i "$f" -an \
    -vf "${geom},${draw},fps=30,format=yuv420p" -c:v libx264 -preset veryfast -crf 20 "$TMP/$seg"
  printf "file '%s'\n" "$seg" >> "$LIST"
  echo "  + ${id} (${dur}s) — ${sub}"
  i=$((i + 1))
done

SILENT="$TMP/cat.mp4"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$LIST" -c copy "$SILENT"
VLEN="$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$SILENT")"

OUT="$DIR/_showcase_${ORI}.mp4"
ffmpeg -y -loglevel error -i "$SILENT" -i "$SONG" -map 0:v -map 1:a -t "$VLEN" \
  -c:v copy -c:a aac -b:a 256k -shortest "$OUT"
rm -rf "$TMP"
echo "wrote $OUT  (${VLEN}s, ${W}x${H})"
