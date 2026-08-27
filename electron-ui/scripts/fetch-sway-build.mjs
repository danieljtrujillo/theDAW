// Produce the SwayCommand embed build that the packaged app serves statically,
// and stage it at electron-ui/resources/sway-dist so electron-builder copies it
// into the installer under python/sway-dist (see electron-builder.yml ->
// extraResources). At runtime the backend's sway module resolves that folder
// (_REPO_ROOT/"sway-dist") and mounts it at /sway-app, so the SWAY tab works
// with no Node.js on the end-user machine.
//
// SwayCommand is a PRIVATE repo under a different account
// (danieljtrujillo/SwayCommand) than theDAW (gantasmo/*). That has one
// consequence worth stating plainly: GitHub Actions' built-in secrets.GITHUB_TOKEN
// is scoped to the repo running the workflow and CANNOT read it. CI therefore
// needs a fine-grained PAT with `Contents: read` on SwayCommand, exposed as
// SWAY_REPO_TOKEN. Without it this script fails with that sentence rather than
// a bare `git clone` authentication error.
//
// Source resolution (first that works wins):
//   1. env SWAY_DIST      - a prebuilt dist-embed directory; staged as-is
//   2. env SWAY_PROJECT   - an explicit path to a SwayCommand checkout
//   3. a sibling SwayCommand checkout next to this repo (dev machines)
//   4. a release asset downloaded with SWAY_REPO_TOKEN (CI)
//
// The embed build must be compiled with base '/sway-app/'; SwayCommand's
// `npm run build:renderer:embed` does that. A checkout predating that script
// cannot produce a servable bundle and this script says so.
//
// Run:  node scripts/fetch-sway-build.mjs      (npm run fetch:sway)

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const stageDir = resolve(__dirname, '..', 'resources', 'sway-dist')

const SWAY_REPO = process.env.SWAY_REPO || 'danieljtrujillo/SwayCommand'
// Pin the release the packaged app ships. Bump deliberately; a moving target
// makes a build non-reproducible and a stale cockpit invisible.
const SWAY_RELEASE = process.env.SWAY_RELEASE || 'latest'
const TOKEN_ENV = 'SWAY_REPO_TOKEN'

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Node >=20.12 refuses to spawn a .cmd without a shell (the CVE-2024-27980
// fix), so npm.cmd raises EINVAL through execFileSync on Windows. Every npm
// invocation here goes through a shell for that reason; the arguments are all
// literals, so there is nothing to quote.
const npmOpts = process.platform === 'win32' ? { shell: true } : {}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', ...(cmd === npmCmd ? npmOpts : {}) })
}

function fail(message) {
  console.error(`[fetch-sway] ${message}`)
  process.exit(1)
}

/** A SwayCommand checkout, or null. Only counts if it has a package.json. */
function resolveCheckout() {
  const explicit = process.env.SWAY_PROJECT
  if (explicit) {
    const p = resolve(explicit)
    if (!existsSync(join(p, 'package.json'))) {
      fail(`SWAY_PROJECT=${p} does not look like a SwayCommand checkout (no package.json).`)
    }
    return p
  }
  for (const name of ['SwayCommand', 'swaycommand']) {
    const p = resolve(repoRoot, '..', name)
    if (existsSync(join(p, 'package.json'))) return p
  }
  return null
}

// Known-bug patches applied to the staged bundle after every fetch, so pulling
// a fresh build cannot silently reintroduce them. Each entry must match EXACTLY
// once; zero matches means upstream fixed it (log + skip), more than once means
// the bundle changed shape (fail loudly rather than patch blind).
//
// available(): in embed mode the cockpit never requests its own MIDIAccess (the
// host relays raw bytes over postMessage), so `n` stays null and the splash's
// MIDI row reported "WebMIDI unavailable" forever — while relayed MIDI was
// audibly playing. `l` is the in-iframe/embed flag in the same scope; embed IS
// available by construction. Fixed upstream in SwayCommand this stays a no-op.
const BUNDLE_PATCHES = [
  {
    reason: 'embed splash: MIDI row must reflect the host relay, not the absent local MIDIAccess',
    find: 'supported:c,get available(){return!!n}',
    replace: 'supported:c,get available(){return l||!!n}',
  },
]

function patchStagedBundle() {
  const bundlePath = join(stageDir, 'embed.bundle.js')
  if (!existsSync(bundlePath)) return
  let js = readFileSync(bundlePath, 'utf8')
  let applied = 0
  for (const p of BUNDLE_PATCHES) {
    const n = js.split(p.find).length - 1
    if (n === 0) {
      console.log(`[fetch-sway] patch not needed (fixed upstream?): ${p.reason}`)
      continue
    }
    if (n > 1) fail(`bundle patch matched ${n} times, expected 1: ${p.reason}`)
    js = js.replace(p.find, p.replace)
    applied += 1
  }
  if (applied) {
    writeFileSync(bundlePath, js, 'utf8')
    console.log(`[fetch-sway] applied ${applied} bundle patch(es)`)
  }
}

function stage(builtDir, provenance) {
  if (!existsSync(join(builtDir, 'index.html'))) {
    fail(`${builtDir} has no index.html - the embed build did not produce a servable bundle.`)
  }
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(dirname(stageDir), { recursive: true })
  cpSync(builtDir, stageDir, { recursive: true })
  patchStagedBundle()
  // Stamp provenance so a stale artifact is a readable version in the SWAY tab
  // rather than a mystery cockpit that is missing a scene. The backend reads
  // this via sidecar.read_build_stamp().
  const stampPath = join(stageDir, 'build.json')
  if (!existsSync(stampPath)) {
    writeFileSync(stampPath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  }
  console.log(`[fetch-sway] staged SwayCommand embed build at ${stageDir}`)
}

function buildFromCheckout(src) {
  console.log(`[fetch-sway] building the embed bundle from ${src}`)
  if (!existsSync(join(src, 'node_modules'))) {
    console.log('[fetch-sway] installing SwayCommand dependencies (npm ci)')
    // Skip Electron's ~180MB binary: the embed build is renderer-only.
    execFileSync(npmCmd, ['ci'], {
      cwd: src,
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
      ...npmOpts,
    })
  }
  try {
    run(npmCmd, ['run', 'build:renderer:embed'], src)
  } catch (err) {
    console.error(`[fetch-sway] underlying error: ${err && err.message ? err.message : err}`)
    fail(
      'npm run build:renderer:embed failed or does not exist in this SwayCommand ' +
        'checkout. The embed target is what compiles the cockpit with base ' +
        "'/sway-app/'; a checkout predating it cannot be served under the subpath.",
    )
  }
  let sha = 'unknown'
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src }).toString().trim()
  } catch {
    /* not a git checkout; provenance degrades to 'unknown' */
  }
  stage(join(src, 'dist-embed'), {
    source: 'checkout',
    path: src,
    sha,
    stagedAt: new Date().toISOString(),
  })
}

async function downloadRelease() {
  const token = (process.env[TOKEN_ENV] || '').trim()
  if (!token) {
    fail(
      `No SwayCommand source found and ${TOKEN_ENV} is not set.\n` +
        `  ${SWAY_REPO} is private, so GitHub Actions' built-in GITHUB_TOKEN cannot read it.\n` +
        `  Fix one of these:\n` +
        `    - clone SwayCommand beside this repo (dev machines), or\n` +
        `    - set SWAY_PROJECT to a checkout, or\n` +
        `    - set SWAY_DIST to a prebuilt dist-embed directory, or\n` +
        `    - add a fine-grained PAT with 'Contents: read' on ${SWAY_REPO}\n` +
        `      as the ${TOKEN_ENV} repository secret (CI).`,
    )
  }
  const api = `https://api.github.com/repos/${SWAY_REPO}/releases/${
    SWAY_RELEASE === 'latest' ? 'latest' : `tags/${SWAY_RELEASE}`
  }`
  // Never log the composed URL or the token.
  console.log(`[fetch-sway] resolving ${SWAY_REPO} release ${SWAY_RELEASE}`)
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'theDAW-fetch-sway',
  }
  const relRes = await fetch(api, { headers })
  if (!relRes.ok) {
    fail(
      `GitHub returned HTTP ${relRes.status} for the release lookup. ` +
        `Check that ${TOKEN_ENV} has 'Contents: read' on ${SWAY_REPO} and has not expired.`,
    )
  }
  const rel = await relRes.json()
  const asset = (rel.assets || []).find((a) => a.name === 'dist-embed.zip')
  if (!asset) {
    fail(
      `Release ${rel.tag_name || SWAY_RELEASE} has no dist-embed.zip asset. ` +
        'SwayCommand must publish the embed bundle as a release asset by that name.',
    )
  }
  const tmp = resolve(repoRoot, 'electron-ui', 'resources', '.sway-download')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const zipPath = join(tmp, 'dist-embed.zip')
  const assetRes = await fetch(asset.url, {
    headers: { ...headers, accept: 'application/octet-stream' },
  })
  if (!assetRes.ok) fail(`Asset download failed with HTTP ${assetRes.status}.`)
  writeFileSync(zipPath, Buffer.from(await assetRes.arrayBuffer()))
  // tar ships with Windows 10+ and every supported macOS/Linux, so no unzip dep.
  run('tar', ['-xf', zipPath, '-C', tmp])
  const extracted = existsSync(join(tmp, 'index.html')) ? tmp : join(tmp, 'dist-embed')
  stage(extracted, {
    source: 'release',
    repo: SWAY_REPO,
    tag: rel.tag_name || SWAY_RELEASE,
    stagedAt: new Date().toISOString(),
  })
  rmSync(tmp, { recursive: true, force: true })
}

async function main() {
  const prebuilt = process.env.SWAY_DIST
  if (prebuilt) {
    const p = resolve(prebuilt)
    console.log(`[fetch-sway] staging prebuilt bundle from SWAY_DIST=${p}`)
    stage(p, { source: 'SWAY_DIST', path: p, stagedAt: new Date().toISOString() })
    return
  }
  const checkout = resolveCheckout()
  if (checkout) {
    buildFromCheckout(checkout)
    return
  }
  await downloadRelease()
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err))
})
