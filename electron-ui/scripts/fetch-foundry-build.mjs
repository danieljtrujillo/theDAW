// Build the in-repo VST Foundry app (VST-Foundry-UI/VST-UI-FOUNDRY) and stage a
// PRODUCTION bundle that electron-builder ships into the installer under
// python/VST-Foundry-UI/VST-UI-FOUNDRY (see electron-builder.yml -> extraResources).
// At runtime the foundry sidecar runs `node dist/server.cjs` with the bundled
// node (see fetch-runtime-tools.mjs) — no npm, no dev server, no install step.
//
// The staged bundle is the minimal runtime: the compiled frontend + server
// (dist/), production-only node_modules (esbuild builds server.cjs with
// --packages=external, so express et al. must ship), and package.json.
//
// Run:  node scripts/fetch-foundry-build.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, rmSync, cpSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..') // stable-audio-3
const srcDir = resolve(repoRoot, 'VST-Foundry-UI', 'VST-UI-FOUNDRY')
const stageDir = resolve(__dirname, '..', 'resources', 'foundry-app')

function run(cmd, args, cwd) {
  // Windows npm resolves to npm.cmd; Node 20+ won't execFile a .cmd directly,
  // so route through cmd.exe (not shell:true, which is deprecated for arrays).
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd, stdio: 'inherit' })
  } else {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' })
  }
}

function main() {
  if (!existsSync(join(srcDir, 'package.json'))) {
    throw new Error(`[fetch-foundry] VST Foundry source not found at ${srcDir}`)
  }
  console.log(`[fetch-foundry] building VST Foundry from ${srcDir}`)

  if (!existsSync(join(srcDir, 'node_modules'))) {
    const hasLock = existsSync(join(srcDir, 'package-lock.json'))
    run('npm', [hasLock ? 'ci' : 'install'], srcDir)
  }
  run('npm', ['run', 'build'], srcDir)

  if (!existsSync(join(srcDir, 'dist', 'server.cjs'))) {
    throw new Error('[fetch-foundry] build did not produce dist/server.cjs')
  }

  // Assemble the staging dir: dist/ + package.json (+ lockfile), then install
  // production-only deps INTO it so the shipped node_modules stays lean.
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  cpSync(join(srcDir, 'dist'), join(stageDir, 'dist'), { recursive: true })
  copyFileSync(join(srcDir, 'package.json'), join(stageDir, 'package.json'))
  if (existsSync(join(srcDir, 'package-lock.json'))) {
    copyFileSync(join(srcDir, 'package-lock.json'), join(stageDir, 'package-lock.json'))
  }
  // Ship .env.example so the packaged app documents the optional AI keys.
  if (existsSync(join(srcDir, '.env.example'))) {
    copyFileSync(join(srcDir, '.env.example'), join(stageDir, '.env.example'))
  }

  console.log('[fetch-foundry] installing production dependencies into the bundle')
  const hasLock = existsSync(join(stageDir, 'package-lock.json'))
  run('npm', [hasLock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], stageDir)

  console.log(`[fetch-foundry] staged VST Foundry production bundle at ${stageDir}`)
}

main()
