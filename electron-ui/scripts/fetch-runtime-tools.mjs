// Fetch the native binaries the packaged app bootstraps with:
//   - uv       (Astral) builds the Python venv and pulls a managed CPython 3.10
//   - ffmpeg   backs every audio I/O path in the backend
//   - ffprobe  media inspection companion to ffmpeg
//
// All of them land in electron-ui/resources/tools/ so electron-builder copies
// them into the installer under resources/tools/ (see electron-builder.yml ->
// extraResources). The directory is gitignored; this script repopulates it
// before each packaged build. It is idempotent: an existing, non-empty binary
// is left untouched.
//
// The script is platform-aware and fetches binaries for the HOST platform:
//   - win32:  uv.exe from Astral, ffmpeg.exe + ffprobe.exe from gyan.dev
//             (the same upstreams install/setup.ps1 already trusts)
//   - darwin: uv from the Astral release tarball for the host arch, ffmpeg +
//             ffprobe static builds from Martin Riedl's build server
//   - linux:  unsupported here; the Linux path ships via Docker, so the script
//             exits with a clear message instead of fetching anything
//
// Run:  node scripts/fetch-runtime-tools.mjs

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  existsSync,
  statSync,
  rmSync,
  readdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const toolsDir = resolve(__dirname, '..', 'resources', 'tools')

// Pinned uv release. SYNC RULE: bump this deliberately after checking
// https://github.com/astral-sh/uv/releases — never float a 'latest' URL here,
// because an unpinned fetch makes two builds of the same commit differ.
// 0.11.26 was the latest stable release when this pin was written (2026-07).
const UV_VERSION = '0.11.26'

function uvUrl() {
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`
  if (process.platform === 'win32') {
    return `${base}/uv-x86_64-pc-windows-msvc.zip`
  }
  // darwin: pick the tarball matching the HOST arch.
  const triple =
    process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  return `${base}/uv-${triple}.tar.gz`
}

// Windows FFmpeg comes from gyan.dev exactly as before (matching
// install/setup.ps1). macOS FFmpeg + ffprobe come from Martin Riedl's static
// build server (https://ffmpeg.martin-riedl.de), pinned to the immutable
// versioned 8.1.1 release paths per arch. The server's
// /redirect/latest/macos/arm64/release/ convenience endpoint returned 404 when
// this was written (2026-07) while the versioned paths below were verified
// reachable, so the pin doubles as the reliability fix.
const FFMPEG_WIN_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const FFMPEG_MAC_URLS = {
  arm64: {
    ffmpeg: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1778761665_8.1.1/ffmpeg.zip',
    ffprobe: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1778761665_8.1.1/ffprobe.zip',
  },
  x64: {
    ffmpeg: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1778768838_8.1.1/ffmpeg.zip',
    ffprobe: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1778768838_8.1.1/ffprobe.zip',
  },
}

function log(msg) {
  process.stdout.write(`[fetch-tools] ${msg}\n`)
}

// A zero-byte or missing file means we still need to fetch it.
function present(p) {
  try {
    return existsSync(p) && statSync(p).size > 0
  } catch {
    return false
  }
}

async function download(url, dest) {
  log(`downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`download failed (${res.status} ${res.statusText}) for ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  log(`saved ${(buf.length / 1e6).toFixed(1)} MB -> ${dest}`)
}

// Archive extraction, per host platform:
//   - win32:  PowerShell Expand-Archive. Windows tar.exe misparses a drive
//             path like C:\... as an [user@]host:path remote, so
//             Expand-Archive is the reliable choice there.
//   - darwin: bsdtar (the system tar), which reads .zip and .tar.gz alike.
function extract(archivePath, outDir) {
  mkdirSync(outDir, { recursive: true })
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${outDir}' -Force`,
      ],
      { stdio: 'inherit' },
    )
  } else {
    execFileSync('tar', ['-xf', archivePath, '-C', outDir], { stdio: 'inherit' })
  }
}

// Depth-first search for the first file named `name` under `root`.
function findFile(root, name) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.toLowerCase() === name.toLowerCase()) return full
    }
  }
  return null
}

// Copy a found binary into resources/tools and make it executable. chmod is a
// no-op on Windows and required on macOS (archives do not always preserve the
// execute bit through extraction + copy).
function install(src, dest) {
  copyFileSync(src, dest)
  if (process.platform !== 'win32') chmodSync(dest, 0o755)
  log(`installed ${dest}`)
}

async function fetchUv() {
  const binName = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const dest = join(toolsDir, binName)
  if (present(dest)) {
    log(`${binName} already present, skipping`)
    return
  }
  const work = join(tmpdir(), 'thedaw-fetch-uv')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const url = uvUrl()
  const archive = join(work, process.platform === 'win32' ? 'uv.zip' : 'uv.tar.gz')
  await download(url, archive)
  extract(archive, work)
  const found = findFile(work, binName)
  if (!found) throw new Error(`${binName} not found in the downloaded archive`)
  install(found, dest)
  rmSync(work, { recursive: true, force: true })
}

async function fetchFfmpegWin() {
  const ffmpeg = join(toolsDir, 'ffmpeg.exe')
  const ffprobe = join(toolsDir, 'ffprobe.exe')
  if (present(ffmpeg) && present(ffprobe)) {
    log('ffmpeg.exe + ffprobe.exe already present, skipping')
    return
  }
  const work = join(tmpdir(), 'thedaw-fetch-ffmpeg')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const zip = join(work, 'ffmpeg.zip')
  await download(FFMPEG_WIN_URL, zip)
  extract(zip, work)
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    const found = findFile(work, exe)
    if (!found) throw new Error(`${exe} not found in the downloaded archive`)
    install(found, join(toolsDir, exe))
  }
  rmSync(work, { recursive: true, force: true })
}

async function fetchFfmpegMac() {
  const urls = FFMPEG_MAC_URLS[process.arch]
  if (!urls) {
    throw new Error(`no macOS ffmpeg source configured for arch '${process.arch}'`)
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const dest = join(toolsDir, name)
    if (present(dest)) {
      log(`${name} already present, skipping`)
      continue
    }
    const work = join(tmpdir(), `thedaw-fetch-${name}`)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    const zip = join(work, `${name}.zip`)
    await download(urls[name], zip)
    extract(zip, work)
    const found = findFile(work, name)
    if (!found) throw new Error(`${name} not found in the downloaded archive`)
    install(found, dest)
    rmSync(work, { recursive: true, force: true })
  }
}

async function main() {
  if (process.platform === 'linux') {
    process.stderr.write(
      '[fetch-tools] linux is not a packaged-desktop target; the Linux ' +
        'deployment ships via Docker. Nothing to fetch.\n',
    )
    process.exit(1)
  }
  mkdirSync(toolsDir, { recursive: true })
  await fetchUv()
  if (process.platform === 'win32') {
    await fetchFfmpegWin()
  } else {
    await fetchFfmpegMac()
  }
  log('done')
}

main().catch((err) => {
  process.stderr.write(`[fetch-tools] ERROR: ${err.message}\n`)
  process.exit(1)
})
