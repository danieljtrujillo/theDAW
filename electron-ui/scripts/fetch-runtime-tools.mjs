// Fetch the native binaries the packaged app bootstraps with:
//   - uv       (Astral) builds the Python venv and pulls a managed CPython 3.10
//   - ffmpeg   backs every audio I/O path in the backend
//   - ffprobe  media inspection companion to ffmpeg
//
// All of them land in electron-ui/resources/tools/ so electron-builder copies
// them into the installer under resources/tools/ (see electron-builder.yml ->
// extraResources). The directory is gitignored; this script repopulates it
// before each packaged build. It is idempotent: an existing, non-empty uv or
// node binary is left untouched, and an existing ffmpeg is kept only when it is
// the current release and passes the libsoxr + librubberband probe.
//
// The script is platform-aware and fetches binaries for the HOST platform:
//   - win32:  uv.exe from Astral, ffmpeg.exe + ffprobe.exe from gyan.dev's
//             FULL release build (the build winget's Gyan.FFmpeg installs,
//             which install/setup.ps1 offers)
//   - darwin: uv from the Astral release tarball for the host arch; ffmpeg +
//             ffprobe from evermeet.cx on Intel, and on Apple Silicon the
//             build scripts/build-ffmpeg-macos.sh made (see fetchFfmpegMac)
//   - linux:  unsupported here; the Linux path ships via Docker, so the script
//             exits with a clear message instead of fetching anything
//
// Run:  node scripts/fetch-runtime-tools.mjs            (everything)
//       node scripts/fetch-runtime-tools.mjs ffmpeg     (only the named tools:
//                                                        uv, node, ffmpeg)

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  existsSync,
  statSync,
  rmSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  cpSync,
  chmodSync,
  createWriteStream,
  renameSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const toolsDir = resolve(__dirname, '..', 'resources', 'tools')

// uv and the Node.js runtime (which runs the bundled VST Foundry fullstack
// server, node dist/server.cjs) are resolved to their newest releases at fetch
// time: uv's latest GitHub release, and the newest LTS on nodejs.org, the same
// line frontend/.nvmrc (lts/*) asks for. Each archive is checked against the
// SHA-256 its publisher posts, the version is logged, and a copy already in
// resources/tools is replaced when a newer release exists.
const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'theDAW-fetch-runtime-tools',
}

async function latestUvVersion() {
  const res = await fetch('https://api.github.com/repos/astral-sh/uv/releases/latest', {
    headers: GITHUB_HEADERS,
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`uv release lookup failed (${res.status} ${res.statusText})`)
  }
  const tag = String((await res.json()).tag_name || '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(tag)) throw new Error(`unexpected uv release tag '${tag}'`)
  return tag
}

function uvUrl(version) {
  const base = `https://github.com/astral-sh/uv/releases/download/${version}`
  if (process.platform === 'win32') {
    return `${base}/uv-x86_64-pc-windows-msvc.zip`
  }
  // darwin: pick the tarball matching the HOST arch.
  const triple =
    process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  return `${base}/uv-${triple}.tar.gz`
}

async function latestNodeLts() {
  const index = JSON.parse(await fetchText('https://nodejs.org/dist/index.json'))
  const lts = Array.isArray(index) ? index.find((r) => r && r.lts) : null
  if (!lts) throw new Error('no LTS release listed in https://nodejs.org/dist/index.json')
  return String(lts.version).replace(/^v/, '')
}

function nodeArchiveName(version) {
  if (process.platform === 'win32') return `node-v${version}-win-x64.zip`
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `node-v${version}-darwin-${arch}.tar.gz`
}

function nodeUrl(version) {
  return `https://nodejs.org/dist/v${version}/${nodeArchiveName(version)}`
}

// The archive's hash from nodejs.org's SHASUMS256.txt for that release.
async function nodeSha256(version) {
  const sums = await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  const name = nodeArchiveName(version)
  const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${name}`))
  const m = line ? line.match(/^[0-9a-fA-F]{64}/) : null
  if (!m) throw new Error(`no SHA-256 for ${name} in SHASUMS256.txt of v${version}`)
  return m[0].toLowerCase()
}

// The version an installed tool reports, or '' when it does not run.
function installedVersion(exe, args, pattern) {
  if (!present(exe)) return ''
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) return ''
  const m = (r.stdout || '').match(pattern)
  return m ? m[1] : ''
}

// FFmpeg must have libsoxr (Classical Upsample, Super-Res and High-Quality SRC
// resample through it) and librubberband (Chimera's time-stretch and pitch).
// gyan.dev's "essentials" build has rubberband but no soxr, so Windows takes
// the FULL release build, which carries everything essentials has plus soxr.
// It ships only as .7z. The latest release is read from gyan.dev's own
// release-version file at fetch time, the versioned archive is downloaded, and
// its SHA-256 is checked against the .sha256 file gyan.dev publishes beside it.
const GYAN_BASE = 'https://www.gyan.dev/ffmpeg/builds'
// evermeet.cx (Intel macOS, configured with --enable-libsoxr and
// --enable-librubberband) and Martin Riedl's build server (the only maintained
// static Apple Silicon build found; its published configuration has neither
// library, see fetchFfmpegMac). Both are resolved to their latest release at
// fetch time. Martin Riedl's /redirect/latest/ endpoint answers 404, so the
// newest build id is read from the build history page instead.
const EVERMEET_INFO = 'https://evermeet.cx/ffmpeg/info'
const RIEDL_BASE = 'https://ffmpeg.martin-riedl.de'
// Where scripts/build-ffmpeg-macos.sh leaves the Apple Silicon build: ffmpeg,
// ffprobe and the ffmpeg-libs/ folder of relinked dylibs they load.
const MAC_BUILT_DIR =
  process.env.THEDAW_MAC_FFMPEG_DIR || resolve(__dirname, '..', 'build-resources', 'ffmpeg-macos-arm64')

// The probes the backend runs (backend/lib/ffmpeg_tools.py): 50 ms of sine
// resampled through soxr, and 200 ms stretched through rubberband, both into
// the null muxer. A build without the library exits non-zero.
const SOXR_PROBE = [
  '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.05',
  '-af', 'aresample=48000:resampler=soxr', '-f', 'null', '-',
]
const RUBBERBAND_PROBE = [
  '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.2',
  '-af', 'rubberband=tempo=1.25', '-f', 'null', '-',
]

function log(msg) {
  process.stdout.write(`[fetch-tools] ${msg}\n`)
}

function warn(msg) {
  process.stderr.write(`[fetch-tools] WARNING: ${msg}\n`)
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`request failed (${res.status} ${res.statusText}) for ${url}`)
  }
  return await res.text()
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// The first line of `-version`, and whether the soxr and rubberband probes
// pass. version is '' when the binary does not run.
function probeFfmpeg(exe) {
  const run = (args) => spawnSync(exe, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  const ver = run(['-hide_banner', '-version'])
  const version = ver.status === 0 ? (ver.stdout || '').split(/\r?\n/)[0].trim() : ''
  if (!version) return { version: '', soxr: false, rubberband: false }
  return {
    version,
    soxr: run(SOXR_PROBE).status === 0,
    rubberband: run(RUBBERBAND_PROBE).status === 0,
  }
}

function describe(p) {
  return `${p.version || 'does not run'} (libsoxr: ${p.soxr ? 'yes' : 'NO'}, librubberband: ${p.rubberband ? 'yes' : 'NO'})`
}

// Download `url` to `dest` unless `dest` already holds a file that `verify`
// accepts, so a rerun never downloads the same archive twice. `verify` throws
// with the reason when the file is wrong; a freshly downloaded file that fails
// it is deleted.
async function downloadVerified(url, dest, verify) {
  if (present(dest)) {
    try {
      verify(dest)
      log(`reusing verified ${dest}`)
      return
    } catch {
      rmSync(dest, { force: true })
    }
  }
  await download(url, dest)
  try {
    verify(dest)
  } catch (err) {
    rmSync(dest, { force: true })
    throw err
  }
}

function sha256Verifier(expected) {
  return (path) => {
    const got = sha256Of(path)
    if (got !== expected) {
      throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${got}`)
    }
    log(`SHA-256 verified ${basename(path)} ${got}`)
  }
}

// The hash from a `.sha256` file: the first 64-hex-digit token.
async function publishedSha256(url) {
  const text = await fetchText(url)
  const m = text.match(/\b[0-9a-fA-F]{64}\b/)
  if (!m) throw new Error(`no SHA-256 found in ${url}`)
  return m[0].toLowerCase()
}

// A zero-byte or missing file means we still need to fetch it.
function present(p) {
  try {
    return existsSync(p) && statSync(p).size > 0
  } catch {
    return false
  }
}

// Streams to `<dest>.part` and renames on completion, so an interrupted
// download never leaves a file that looks finished, and a large archive is
// never held in memory. Progress is logged every 10%.
async function download(url, dest) {
  log(`downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status} ${res.statusText}) for ${url}`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  const part = `${dest}.part`
  let got = 0
  let nextMark = 10
  const body = Readable.fromWeb(res.body)
  body.on('data', (chunk) => {
    got += chunk.length
    if (total && (got / total) * 100 >= nextMark) {
      log(`  ${nextMark}% of ${(total / 1e6).toFixed(1)} MB`)
      nextMark += 10
    }
  })
  try {
    await pipeline(body, createWriteStream(part))
  } catch (err) {
    rmSync(part, { force: true })
    throw err
  }
  if (total && got !== total) {
    rmSync(part, { force: true })
    throw new Error(`download of ${url} ended at ${got} of ${total} bytes`)
  }
  renameSync(part, dest)
  log(`saved ${(got / 1e6).toFixed(1)} MB -> ${dest}`)
}

// .7z on Windows. Windows' own bsdtar (System32\tar.exe, libarchive with
// liblzma) reads 7z. It misparses a drive path like C:\... as a remote host,
// so it runs inside the archive's folder with relative names. 7-Zip, when
// installed (the GitHub windows runners have it), is the fallback.
function extract7z(archivePath, outDir) {
  mkdirSync(outDir, { recursive: true })
  const cwd = dirname(archivePath)
  const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const errors = []
  if (existsSync(bsdtar)) {
    const r = spawnSync(bsdtar, ['-xf', basename(archivePath), '-C', relative(cwd, outDir)], {
      cwd,
      stdio: ['ignore', 'inherit', 'pipe'],
      encoding: 'utf8',
    })
    if (r.status === 0) return
    errors.push(`${bsdtar} exited ${r.status}: ${(r.stderr || '').trim()}`)
  } else {
    errors.push(`${bsdtar} not found`)
  }
  const sevenZipCandidates = [
    '7z',
    join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe'),
  ]
  for (const sz of sevenZipCandidates) {
    const r = spawnSync(sz, ['x', '-y', `-o${outDir}`, archivePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    })
    if (r.status === 0) {
      log(`extracted with ${sz}`)
      return
    }
    errors.push(`${sz}: ${r.error ? r.error.message : `exited ${r.status}`}`)
  }
  throw new Error(`could not extract ${archivePath}:\n  ${errors.join('\n  ')}`)
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
  const have = installedVersion(dest, ['--version'], /uv (\d+\.\d+\.\d+)/)
  const latest = await latestUvVersion()
  if (have === latest) {
    log(`${binName} ${have} is the latest release, skipping`)
    return
  }
  log(have ? `${binName} ${have} -> ${latest}` : `${binName}: fetching ${latest}`)
  const work = join(tmpdir(), 'thedaw-fetch-uv')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const url = uvUrl(latest)
  const archive = join(work, process.platform === 'win32' ? 'uv.zip' : 'uv.tar.gz')
  // uv publishes a .sha256 file beside every release archive.
  await downloadVerified(url, archive, sha256Verifier(await publishedSha256(`${url}.sha256`)))
  extract(archive, work)
  const found = findFile(work, binName)
  if (!found) throw new Error(`${binName} not found in the downloaded archive`)
  install(found, dest)
  rmSync(work, { recursive: true, force: true })
}

async function fetchNode() {
  const binName = process.platform === 'win32' ? 'node.exe' : 'node'
  const dest = join(toolsDir, binName)
  const have = installedVersion(dest, ['--version'], /v(\d+\.\d+\.\d+)/)
  const latest = await latestNodeLts()
  if (have === latest) {
    log(`${binName} ${have} is the newest LTS, skipping`)
    return
  }
  log(have ? `${binName} ${have} -> ${latest} (newest LTS)` : `${binName}: fetching ${latest} (newest LTS)`)
  const work = join(tmpdir(), 'thedaw-fetch-node')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const url = nodeUrl(latest)
  const archive = join(work, process.platform === 'win32' ? 'node.zip' : 'node.tar.gz')
  await downloadVerified(url, archive, sha256Verifier(await nodeSha256(latest)))
  extract(archive, work)
  const found = findFile(work, binName)
  if (!found) throw new Error(`${binName} not found in the downloaded archive`)
  install(found, dest)
  rmSync(work, { recursive: true, force: true })
}

// Install the ffmpeg + ffprobe found under `root` into resources/tools.
function installFfmpegPair(root, ffmpegDest, ffprobeDest, names) {
  for (const [name, dest] of [[names.ffmpeg, ffmpegDest], [names.ffprobe, ffprobeDest]]) {
    const found = findFile(root, name)
    if (!found) throw new Error(`${name} not found in the downloaded archive`)
    install(found, dest)
  }
}

// Both probes must pass. A build that fails one is removed again, so it can
// never be packaged, and the fetch fails with what is missing.
function requireSoxrAndRubberband(ffmpegDest, ffprobeDest) {
  const p = probeFfmpeg(ffmpegDest)
  log(`probe ${ffmpegDest}: ${describe(p)}`)
  if (!p.version || !p.soxr || !p.rubberband) {
    rmSync(ffmpegDest, { force: true })
    rmSync(ffprobeDest, { force: true })
    throw new Error(
      `the fetched FFmpeg is missing what theDAW needs: ${describe(p)}. ` +
        'Classical Upsample, Super-Res and High-Quality SRC need libsoxr; Chimera needs librubberband.',
    )
  }
  return p
}

async function fetchFfmpegWin() {
  const ffmpeg = join(toolsDir, 'ffmpeg.exe')
  const ffprobe = join(toolsDir, 'ffprobe.exe')
  const version = (await fetchText(`${GYAN_BASE}/release-version`)).trim()
  if (!/^\d+(\.\d+)+$/.test(version)) {
    throw new Error(`unexpected gyan.dev release-version: ${JSON.stringify(version)}`)
  }
  const name = `ffmpeg-${version}-full_build.7z`
  if (present(ffmpeg) && present(ffprobe)) {
    const p = probeFfmpeg(ffmpeg)
    if (p.version.includes(`${version}-full_build`) && p.soxr && p.rubberband) {
      log(`ffmpeg.exe is the current full build: ${describe(p)}, skipping`)
      return
    }
    log(`replacing ffmpeg.exe ${describe(p)} with ${name}`)
  }
  const url = `${GYAN_BASE}/packages/${name}`
  const expected = await publishedSha256(`${url}.sha256`)
  const work = join(tmpdir(), 'thedaw-fetch-ffmpeg')
  mkdirSync(work, { recursive: true })
  const archive = join(work, name)
  await downloadVerified(url, archive, sha256Verifier(expected))
  const out = join(work, 'extracted')
  rmSync(out, { recursive: true, force: true })
  extract7z(archive, out)
  installFfmpegPair(out, ffmpeg, ffprobe, { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' })
  rmSync(out, { recursive: true, force: true })
  requireSoxrAndRubberband(ffmpeg, ffprobe)
  // The verified archive stays in the work folder, so a rerun reuses it.
}

// macOS. evermeet.cx builds Intel binaries with libsoxr and librubberband and
// does not build for Apple Silicon, and no maintained static Apple Silicon
// build has both (Martin Riedl's published configuration has neither). So:
//   - Intel: evermeet's latest release, which must pass both probes.
//   - Apple Silicon: the build scripts/build-ffmpeg-macos.sh made (the
//     macos-dmg release job runs it), copied with its ffmpeg-libs/ folder and
//     required to pass both probes. Without one, Martin Riedl's latest release
//     with its SHA-256 checked and a warning, so a local dev build still gets
//     an ffmpeg; THEDAW_MAC_FFMPEG_REQUIRED=1 (set by the release job) turns
//     that fallback into a failure.
async function fetchFfmpegMac() {
  if (process.arch === 'x64') return fetchFfmpegMacEvermeet()
  if (process.arch === 'arm64') {
    if (present(join(MAC_BUILT_DIR, 'ffmpeg')) && present(join(MAC_BUILT_DIR, 'ffprobe'))) {
      return installFfmpegMacBuilt()
    }
    if (process.env.THEDAW_MAC_FFMPEG_REQUIRED === '1') {
      throw new Error(
        `no built FFmpeg in ${MAC_BUILT_DIR}; run scripts/build-ffmpeg-macos.sh build first ` +
          '(the macos-dmg job in .github/workflows/release.yml does)',
      )
    }
    warn(`no built FFmpeg in ${MAC_BUILT_DIR} (scripts/build-ffmpeg-macos.sh build makes one); using Martin Riedl's build`)
    return fetchFfmpegMacRiedl()
  }
  throw new Error(`no macOS ffmpeg source configured for arch '${process.arch}'`)
}

// Copy the Apple Silicon build into resources/tools: ffmpeg and ffprobe load
// their dylibs from @loader_path/ffmpeg-libs, so the folder travels with them.
function installFfmpegMacBuilt() {
  const ffmpeg = join(toolsDir, 'ffmpeg')
  const ffprobe = join(toolsDir, 'ffprobe')
  const libsSrc = join(MAC_BUILT_DIR, 'ffmpeg-libs')
  const libsDest = join(toolsDir, 'ffmpeg-libs')
  rmSync(libsDest, { recursive: true, force: true })
  if (existsSync(libsSrc)) {
    cpSync(libsSrc, libsDest, { recursive: true })
    log(`installed ${libsDest}`)
  }
  install(join(MAC_BUILT_DIR, 'ffmpeg'), ffmpeg)
  install(join(MAC_BUILT_DIR, 'ffprobe'), ffprobe)
  requireSoxrAndRubberband(ffmpeg, ffprobe)
}

async function fetchFfmpegMacEvermeet() {
  const ffmpeg = join(toolsDir, 'ffmpeg')
  const ffprobe = join(toolsDir, 'ffprobe')
  const infos = {}
  for (const name of ['ffmpeg', 'ffprobe']) {
    infos[name] = JSON.parse(await fetchText(`${EVERMEET_INFO}/${name}/release`))
  }
  const version = infos.ffmpeg.version
  if (present(ffmpeg) && present(ffprobe)) {
    const p = probeFfmpeg(ffmpeg)
    if (p.version.startsWith(`ffmpeg version ${version} `) && p.soxr && p.rubberband) {
      log(`ffmpeg is evermeet ${version}: ${describe(p)}, skipping`)
      return
    }
    log(`replacing ffmpeg ${describe(p)} with evermeet ${version}`)
  }
  const work = join(tmpdir(), 'thedaw-fetch-ffmpeg')
  mkdirSync(work, { recursive: true })
  const out = join(work, 'extracted')
  rmSync(out, { recursive: true, force: true })
  for (const name of ['ffmpeg', 'ffprobe']) {
    const zip = infos[name].download.zip
    const archive = join(work, basename(new URL(zip.url).pathname))
    // evermeet publishes a GPG signature and the exact size, no SHA-256 file.
    await downloadVerified(zip.url, archive, (path) => {
      const size = statSync(path).size
      if (size !== zip.size) throw new Error(`size mismatch for ${path}: expected ${zip.size}, got ${size}`)
      log(`size verified ${basename(path)} ${size} bytes`)
    })
    extract(archive, out)
  }
  installFfmpegPair(out, ffmpeg, ffprobe, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  rmSync(out, { recursive: true, force: true })
  requireSoxrAndRubberband(ffmpeg, ffprobe)
}

async function fetchFfmpegMacRiedl() {
  const ffmpeg = join(toolsDir, 'ffmpeg')
  const ffprobe = join(toolsDir, 'ffprobe')
  const history = await fetchText(`${RIEDL_BASE}/info/history/macos/arm64/release`)
  const m = history.match(/\/info\/detail\/macos\/arm64\/(\d+_(\d+(?:\.\d+)+))/)
  if (!m) throw new Error('no release build found on the Martin Riedl build history page')
  const [, buildId, version] = m
  if (present(ffmpeg) && present(ffprobe)) {
    const p = probeFfmpeg(ffmpeg)
    if (p.version.startsWith(`ffmpeg version ${version}-`)) {
      log(`ffmpeg is Martin Riedl ${version}: ${describe(p)}, skipping`)
      warnMissing(p)
      return
    }
    log(`replacing ffmpeg ${describe(p)} with Martin Riedl ${version}`)
  }
  const work = join(tmpdir(), 'thedaw-fetch-ffmpeg')
  mkdirSync(work, { recursive: true })
  const out = join(work, 'extracted')
  rmSync(out, { recursive: true, force: true })
  for (const name of ['ffmpeg', 'ffprobe']) {
    const url = `${RIEDL_BASE}/download/macos/arm64/${buildId}/${name}.zip`
    const expected = await publishedSha256(`${url}.sha256`)
    const archive = join(work, `${name}-${version}-arm64.zip`)
    await downloadVerified(url, archive, sha256Verifier(expected))
    extract(archive, out)
  }
  installFfmpegPair(out, ffmpeg, ffprobe, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  rmSync(out, { recursive: true, force: true })
  const p = probeFfmpeg(ffmpeg)
  log(`probe ${ffmpeg}: ${describe(p)}`)
  if (!p.version) throw new Error(`the fetched ffmpeg does not run: ${ffmpeg}`)
  warnMissing(p)
}

function warnMissing(p) {
  if (p.soxr && p.rubberband) return
  warn(
    `the bundled Apple Silicon FFmpeg lacks ${[!p.soxr && 'libsoxr', !p.rubberband && 'librubberband']
      .filter(Boolean)
      .join(' and ')}. scripts/build-ffmpeg-macos.sh build makes one that has both. ` +
      'Without it, Classical Upsample, Super-Res and High-Quality SRC (libsoxr) and ' +
      "Chimera's rubberband stretch need a Homebrew ffmpeg (brew install ffmpeg), which the backend prefers when present.",
  )
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
  const known = ['uv', 'node', 'ffmpeg']
  const only = process.argv.slice(2)
  const unknown = only.filter((n) => !known.includes(n))
  if (unknown.length) throw new Error(`unknown tool(s): ${unknown.join(', ')}; expected ${known.join(', ')}`)
  const want = (name) => only.length === 0 || only.includes(name)
  if (want('uv')) await fetchUv()
  if (want('node')) await fetchNode()
  if (want('ffmpeg')) {
    if (process.platform === 'win32') {
      await fetchFfmpegWin()
    } else {
      await fetchFfmpegMac()
    }
  }
  log('done')
}

main().catch((err) => {
  process.stderr.write(`[fetch-tools] ERROR: ${err.message}\n`)
  process.exit(1)
})
