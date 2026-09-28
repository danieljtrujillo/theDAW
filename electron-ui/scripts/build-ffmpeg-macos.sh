#!/usr/bin/env bash
# Build FFmpeg for the Apple Silicon desktop app, on a macOS arm64 host.
#
# No maintained static Apple Silicon FFmpeg carries both libsoxr (Classical
# Upsample, Super-Res and High-Quality SRC resample through it) and
# librubberband (Chimera's time-stretch and pitch), so the macos-dmg job in
# .github/workflows/release.yml builds one:
#
#   1. The latest FFmpeg release is read from https://ffmpeg.org/releases/ and
#      its tarball is checked against the detached signature FFmpeg publishes,
#      made by the FFmpeg release signing key pinned below by fingerprint.
#   2. The external libraries come from Homebrew on the build host. FFmpeg's
#      own libraries are linked statically into ffmpeg and ffprobe.
#   3. Every non-system dylib the two binaries load, directly or through
#      another dylib, is copied into ffmpeg-libs/ beside them and relinked with
#      install_name_tool to @loader_path, Homebrew rpaths are deleted, and each
#      file is ad-hoc signed again (arm64 refuses to load an unsigned binary).
#      The app therefore never loads anything from the user's Homebrew.
#
# Libraries enabled are the ones theDAW's backend asks for (grep backend/ for
# -c:a / -c:v and filter names): libsoxr, librubberband, libmp3lame, libopus,
# libvorbis, libx264 and libx265 (VJ export). AAC, FLAC, ALAC, PCM, PNG, GIF,
# ProRes, WMA, VP8/VP9 and H.264 decoding, loudnorm, afir and the other audio
# filters are FFmpeg's own and need no library.
#
# Usage:
#   build-ffmpeg-macos.sh key      print the cache key: FFmpeg version + a hash
#                                  of every Homebrew formula version it links
#   build-ffmpeg-macos.sh build    build into $THEDAW_MAC_FFMPEG_DIR
#   build-ffmpeg-macos.sh verify   probe the result, check its links
#
# THEDAW_MAC_FFMPEG_DIR defaults to electron-ui/build-resources/ffmpeg-macos-arm64,
# which scripts/fetch-runtime-tools.mjs copies into resources/tools.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${THEDAW_MAC_FFMPEG_DIR:-$SCRIPT_DIR/../build-resources/ffmpeg-macos-arm64}"

# FFmpeg release signing key <ffmpeg-devel@ffmpeg.org>, published at
# https://ffmpeg.org/ffmpeg-devel.asc. Every release tarball's .asc is made by it.
FFMPEG_KEY_FPR="FCF986EA15E6E293A5644F10B4322F04D67658D8"

# Libraries FFmpeg links, and the tools the build needs.
FORMULAE=(libsoxr rubberband lame opus libvorbis x264 x265)
BUILD_TOOLS=(pkgconf gnupg)

log() { printf '[build-ffmpeg] %s\n' "$*"; }
die() { printf '[build-ffmpeg] ERROR: %s\n' "$*" >&2; exit 1; }

require_host() {
  [ "$(uname -s)" = "Darwin" ] || die "this builds the macOS app's FFmpeg and runs on macOS only"
  [ "$(uname -m)" = "arm64" ] || die "this builds the Apple Silicon FFmpeg and runs on an arm64 host only"
  command -v brew >/dev/null 2>&1 || die "Homebrew is required (brew not found)"
}

# The newest ffmpeg-X.Y[.Z].tar.xz on ffmpeg.org's release list.
latest_ffmpeg_version() {
  curl -fsSL https://ffmpeg.org/releases/ | python3 -c '
import re, sys
found = set(re.findall(r"ffmpeg-(\d+(?:\.\d+)+)\.tar\.xz(?!\.)", sys.stdin.read()))
if not found:
    sys.exit("no ffmpeg-*.tar.xz on https://ffmpeg.org/releases/")
print(max(found, key=lambda v: tuple(int(p) for p in v.split("."))))
'
}

# "formula version_revision" for every formula FFmpeg links, and their
# dependencies, as Homebrew would install them now.
formula_versions() {
  # bash 3.2 (the macOS /bin/bash) has no mapfile, so the list is read line by line.
  local f
  local -a all=()
  while IFS= read -r f; do
    [ -n "$f" ] && all+=("$f")
  done < <( { printf '%s\n' "${FORMULAE[@]}"; brew deps --union "${FORMULAE[@]}"; } | sort -u)
  brew info --json=v2 --formula "${all[@]}" | python3 -c '
import json, sys
for f in json.load(sys.stdin)["formulae"]:
    rev = f.get("revision") or 0
    version = f["versions"]["stable"] + ("_%d" % rev if rev else "")
    print(f["name"], version)
'
}

cmd_key() {
  require_host
  local version hash
  version="$(latest_ffmpeg_version)"
  hash="$(formula_versions | shasum -a 256 | cut -c1-16)"
  printf '%s-%s\n' "$version" "$hash"
}

cmd_build() {
  require_host
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
  log "installing: ${FORMULAE[*]} ${BUILD_TOOLS[*]}"
  brew install --quiet "${FORMULAE[@]}" "${BUILD_TOOLS[@]}"
  local brew_prefix version src
  brew_prefix="$(brew --prefix)"
  version="$(latest_ffmpeg_version)"
  log "FFmpeg $version"
  log "linking: $(formula_versions | tr '\n' ' ')"
  # Global, not local: the EXIT trap runs after this function returns.
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  local tarball="ffmpeg-$version.tar.xz"
  curl -fsSL -o "$work/$tarball" "https://ffmpeg.org/releases/$tarball"
  curl -fsSL -o "$work/$tarball.asc" "https://ffmpeg.org/releases/$tarball.asc"
  curl -fsSL -o "$work/ffmpeg-devel.asc" "https://ffmpeg.org/ffmpeg-devel.asc"
  export GNUPGHOME="$work/gnupg"
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --import "$work/ffmpeg-devel.asc"
  # Output is captured before grep -q reads it: under pipefail a writer cut
  # off by grep's early exit (SIGPIPE) would fail the check on a good match.
  local keys status
  keys="$(gpg --batch --with-colons --fingerprint)"
  grep -q "^fpr:::::::::$FFMPEG_KEY_FPR:" <<<"$keys" \
    || die "ffmpeg-devel.asc does not hold the pinned release key $FFMPEG_KEY_FPR"
  status="$(gpg --batch --status-fd 1 --verify "$work/$tarball.asc" "$work/$tarball" 2>/dev/null || true)"
  grep -q "^\[GNUPG:\] VALIDSIG $FFMPEG_KEY_FPR " <<<"$status" \
    || die "$tarball is not signed by the FFmpeg release key $FFMPEG_KEY_FPR"
  log "signature verified: $tarball by $FFMPEG_KEY_FPR"

  tar -xf "$work/$tarball" -C "$work"
  src="$work/ffmpeg-$version"
  (
    cd "$src"
    # Autodetected extras that would only add dylibs (ffplay's SDL, X11) are
    # off; VideoToolbox and AudioToolbox are system frameworks and stay on.
    ./configure \
      --prefix="$work/install" \
      --enable-gpl --enable-version3 \
      --disable-shared --enable-static \
      --disable-debug --disable-doc --disable-ffplay \
      --disable-sdl2 --disable-xlib --disable-libxcb \
      --enable-libsoxr --enable-librubberband \
      --enable-libmp3lame --enable-libopus --enable-libvorbis \
      --enable-libx264 --enable-libx265 \
      --extra-cflags="-I$brew_prefix/include" \
      --extra-ldflags="-L$brew_prefix/lib -Wl,-headerpad_max_install_names"
    make -j"$(sysctl -n hw.ncpu)"
    make install
  )

  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR/ffmpeg-libs"
  cp "$work/install/bin/ffmpeg" "$work/install/bin/ffprobe" "$OUT_DIR/"
  bundle_dylibs "$OUT_DIR" "$brew_prefix"
  log "built into $OUT_DIR"
}

# Copy every non-system dylib the binaries load into ffmpeg-libs/ and relink
# all of them to @loader_path; delete Homebrew rpaths; ad-hoc sign again.
bundle_dylibs() {
  python3 - "$1" "$2" <<'PY'
import os
import shutil
import subprocess
import sys

dest, brew = sys.argv[1], sys.argv[2]
libdir = os.path.join(dest, "ffmpeg-libs")
SYSTEM = ("/usr/lib/", "/System/")


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def load_refs(path):
    """Install names the file loads (its own id excluded)."""
    own = run("otool", "-D", path).splitlines()[1:]
    own = own[0].strip() if own else None
    refs = []
    for line in run("otool", "-L", path).splitlines()[1:]:
        ref = line.strip().split(" (")[0]
        if ref and ref != own:
            refs.append(ref)
    return refs


def rpaths(path):
    out, lines = [], run("otool", "-l", path).splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "cmd LC_RPATH":
            for follow in lines[i + 1 : i + 4]:
                follow = follow.strip()
                if follow.startswith("path "):
                    out.append(follow.split(" ", 1)[1].rsplit(" (offset", 1)[0])
    return out


def resolve(ref, origin):
    """The real file behind an install name, seen from `origin` (the
    original location of the file that loads it)."""
    base = os.path.dirname(origin)
    if ref.startswith("@loader_path/") or ref.startswith("@executable_path/"):
        return os.path.realpath(os.path.join(base, ref.split("/", 1)[1]))
    if ref.startswith("@rpath/"):
        tail = ref[len("@rpath/") :]
        for rp in rpaths(origin) + [os.path.join(brew, "lib")]:
            rp = rp.replace("@loader_path", base).replace("@executable_path", base)
            cand = os.path.join(rp, tail)
            if os.path.exists(cand):
                return os.path.realpath(cand)
        sys.exit(f"cannot resolve {ref} for {origin}")
    return os.path.realpath(ref) if os.path.exists(ref) else ref


copied = {}  # bundled name -> original real path
queue = [(os.path.join(dest, b), os.path.join(dest, b), True) for b in ("ffmpeg", "ffprobe")]
while queue:
    path, origin, is_binary = queue.pop()
    for ref in load_refs(path):
        if ref.startswith(SYSTEM):
            continue
        real = resolve(ref, origin)
        if real.startswith(SYSTEM):
            continue
        name = os.path.basename(ref)
        target = os.path.join(libdir, name)
        if name not in copied:
            shutil.copyfile(real, target)
            os.chmod(target, 0o755)
            run("install_name_tool", "-id", f"@loader_path/{name}", target)
            copied[name] = real
            queue.append((target, real, False))
        new = f"@loader_path/ffmpeg-libs/{name}" if is_binary else f"@loader_path/{name}"
        run("install_name_tool", "-change", ref, new, path)
    for rp in rpaths(path):
        if not rp.startswith("@"):
            run("install_name_tool", "-delete_rpath", rp, path)

files = [os.path.join(libdir, n) for n in sorted(copied)]
files += [os.path.join(dest, "ffmpeg"), os.path.join(dest, "ffprobe")]
for f in files:
    run("codesign", "--force", "--sign", "-", f)
for name, real in sorted(copied.items()):
    print(f"[build-ffmpeg] bundled {name} <- {real}")
PY
}

cmd_verify() {
  local ffmpeg="$OUT_DIR/ffmpeg" ffprobe="$OUT_DIR/ffprobe" fail=0 f links loads rpath_lines
  [ -x "$ffmpeg" ] && [ -x "$ffprobe" ] || die "no built ffmpeg/ffprobe in $OUT_DIR"
  # Each tool's output is captured before grep reads it (see cmd_build).
  for f in "$ffmpeg" "$ffprobe" "$OUT_DIR"/ffmpeg-libs/*.dylib; do
    [ -e "$f" ] || continue
    links="$(otool -L "$f" | tail -n +2)"
    if grep -Eq '/opt/homebrew|/usr/local|/Cellar/' <<<"$links"; then
      printf '[build-ffmpeg] ERROR: %s still links outside the bundle:\n' "$f" >&2
      grep -E '/opt/homebrew|/usr/local|/Cellar/' <<<"$links" >&2
      fail=1
    fi
    loads="$(otool -l "$f")"
    rpath_lines="$(grep -A2 'cmd LC_RPATH' <<<"$loads" || true)"
    if grep -Eq 'path (/opt/homebrew|/usr/local)' <<<"$rpath_lines"; then
      printf '[build-ffmpeg] ERROR: %s keeps a Homebrew rpath\n' "$f" >&2
      fail=1
    fi
    codesign --verify "$f" || { printf '[build-ffmpeg] ERROR: %s is not validly signed\n' "$f" >&2; fail=1; }
  done
  local version_text
  version_text="$("$ffmpeg" -hide_banner -version)"
  log "${version_text%%$'\n'*}"
  if "$ffmpeg" -hide_banner -nostdin -loglevel error -f lavfi -i sine=d=0.05 \
      -af aresample=48000:resampler=soxr -f null - </dev/null; then
    log "libsoxr: yes"
  else
    printf '[build-ffmpeg] ERROR: the soxr resample failed (no libsoxr)\n' >&2; fail=1
  fi
  if "$ffmpeg" -hide_banner -nostdin -loglevel error -f lavfi -i sine=d=0.2 \
      -af rubberband=tempo=1.25 -f null - </dev/null; then
    log "librubberband: yes"
  else
    printf '[build-ffmpeg] ERROR: the rubberband stretch failed (no librubberband)\n' >&2; fail=1
  fi
  local encoders enc
  encoders="$("$ffmpeg" -hide_banner -encoders 2>/dev/null)"
  for enc in libmp3lame libopus libvorbis libx264 libx265 aac flac alac prores_ks png; do
    if grep -Eq "^ [A-Z.]{6} $enc( |$)" <<<"$encoders"; then
      log "encoder $enc: yes"
    else
      printf '[build-ffmpeg] ERROR: encoder %s is missing\n' "$enc" >&2; fail=1
    fi
  done
  "$ffprobe" -hide_banner -version >/dev/null || { printf '[build-ffmpeg] ERROR: ffprobe does not run\n' >&2; fail=1; }
  [ "$fail" = 0 ] || die "verification failed for $OUT_DIR"
  log "verified $OUT_DIR"
}

case "${1:-}" in
  key) cmd_key ;;
  build) cmd_build ;;
  verify) cmd_verify ;;
  *) die "usage: $0 key|build|verify" ;;
esac
