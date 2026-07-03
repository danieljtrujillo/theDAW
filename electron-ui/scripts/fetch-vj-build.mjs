// Produce the VJ (gantasmo/VJ-9000) production build that the packaged app
// serves statically, and stage it at electron-ui/resources/vj-dist so
// electron-builder copies it into the installer under python/vj-dist (see
// electron-builder.yml -> extraResources). At runtime the backend's VJ sidecar
// resolves that folder (_REPO_ROOT/"vj-dist") and mounts it at /vj-app, so no
// Node.js is needed on the end-user machine.
//
// Source resolution (first that exists wins):
//   1. env VJ_PROJECT — an explicit path to a VJ checkout
//   2. a sibling GANTASMO-LIVE-VJ checkout next to this repo (dev machines)
//   3. otherwise: git clone gantasmo/VJ-9000 (branch VJ_REF, default main)
//
// The VJ build must be compiled with vite base '/vj-app/' (VJ-9000's
// vite.config does this for `command === 'build'`), so a checkout/clone that
// predates that change will not serve correctly under the subpath.
//
// Run:  node scripts/fetch-vj-build.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, rmSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..') // stable-audio-3
const stageDir = resolve(__dirname, '..', 'resources', 'vj-dist')

const VJ_REPO = process.env.VJ_REPO || 'https://github.com/gantasmo/VJ-9000.git'
// The active VJ branch that carries the '/vj-app/' build base. Update to 'main'
// once that branch is merged. Only used for the clone fallback (a local VJ
// checkout, when present, is built directly and this ref is ignored).
const VJ_REF = process.env.VJ_REF || 'feat/vj-redesign-vfx'

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const gitCmd = process.platform === 'win32' ? 'git.exe' : 'git'

function run(cmd, args, cwd) {
  // On Windows npm/git resolve to .cmd/.exe shims; Node 20+ refuses to
  // execFile a .cmd directly. Route through cmd.exe explicitly (rather than
  // shell:true, which is deprecated for arg arrays) so the shim resolves.
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd, stdio: 'inherit' })
  } else {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' })
  }
}

function resolveSource() {
  const candidates = [
    process.env.VJ_PROJECT && resolve(process.env.VJ_PROJECT),
    join(repoRoot, '..', 'GANTASMO-LIVE-VJ'), // JoshOG/GANTASMO-LIVE-VJ
    join(repoRoot, '..', '..', 'GANTASMO-LIVE-VJ'), // StableAudio/GANTASMO-LIVE-VJ
    join(repoRoot, 'vj'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) return { path: c, cloned: false }
  }
  // Nothing local — clone the public repo into a temp dir.
  const dest = join(tmpdir(), `vj-9000-${VJ_REF}`)
  rmSync(dest, { recursive: true, force: true })
  console.log(`[fetch-vj] cloning ${VJ_REPO}@${VJ_REF} -> ${dest}`)
  run(gitCmd, ['clone', '--depth', '1', '--branch', VJ_REF, VJ_REPO, dest])
  return { path: dest, cloned: true }
}

function main() {
  const { path: src, cloned } = resolveSource()
  console.log(`[fetch-vj] building VJ from ${src}${cloned ? ' (clone)' : ' (local checkout)'}`)

  if (!existsSync(join(src, 'node_modules'))) {
    console.log('[fetch-vj] installing VJ dependencies (npm ci)')
    // ci needs a lockfile; fall back to install when absent.
    const hasLock = existsSync(join(src, 'package-lock.json'))
    run(npmCmd, [hasLock ? 'ci' : 'install'], src)
  }
  run(npmCmd, ['run', 'build'], src)

  const built = join(src, 'dist')
  if (!existsSync(join(built, 'index.html'))) {
    throw new Error(`[fetch-vj] build did not produce ${built}/index.html`)
  }
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(dirname(stageDir), { recursive: true })
  cpSync(built, stageDir, { recursive: true })
  console.log(`[fetch-vj] staged VJ build at ${stageDir}`)
}

main()
