// Stages the live VST host exe (native/vst-host/bin/thedaw-vst-host.exe) and its
// probe helper (vst3_probe.exe) into electron-ui/build-resources/vst-host/, which
// electron-builder.yml's Windows-only extraResources entry ships as
// resources/vst-host in the packaged app. main/index.ts's buildBackendEnv()
// points THEDAW_VST_HOST at that shipped exe so live VST works out of the box.
//
// The native host is built separately (native/vst-host/build.ps1) -- this
// script only copies whatever native/vst-host/bin/ already holds. When the
// host has not been built, this still creates the staging folder (with a
// README explaining why it's empty) and exits 0: a machine without the native
// toolchain must still be able to package the rest of the app, just without
// live VST (plugins still apply on freeze and export).
//
// Run: node scripts/stage-vst-host.mjs

import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..', '..')
const binDir = join(repoRoot, 'native', 'vst-host', 'bin')
const stageDir = resolve(__dirname, '..', 'build-resources', 'vst-host')

const EXE_NAME = 'thedaw-vst-host.exe'
const PROBE_NAME = 'vst3_probe.exe'

const README_NOT_BUILT = `The live VST host has not been built.

This packaged app will run without live VST plugin preview/monitoring;
plugins still apply on freeze and export. To ship the live host, build it
first:

  native/vst-host/build.ps1

then re-run packaging (or just this script: node scripts/stage-vst-host.mjs).
`

// Pure decision: given what exists in native/vst-host/bin, what should be
// staged. Kept free of fs/path so it can be unit-tested without a real build
// (see stage-vst-host.test.mjs).
export function planVstHostStaging({ exeExists, probeExists }) {
  if (!exeExists) {
    return {
      copy: [],
      writeReadme: true,
      message:
        `[stage-vst-host] ${EXE_NAME} not found -- packaging without live VST. ` +
        'Build it with native/vst-host/build.ps1.',
    }
  }
  const copy = [EXE_NAME]
  if (probeExists) copy.push(PROBE_NAME)
  return {
    copy,
    writeReadme: false,
    message: probeExists
      ? `[stage-vst-host] staged ${EXE_NAME} and ${PROBE_NAME}.`
      : `[stage-vst-host] staged ${EXE_NAME} (${PROBE_NAME} not found).`,
  }
}

function main() {
  const exeExists = existsSync(join(binDir, EXE_NAME))
  const probeExists = existsSync(join(binDir, PROBE_NAME))
  const plan = planVstHostStaging({ exeExists, probeExists })

  // Regenerate the stage dir from scratch every run: it is a persistent,
  // gitignored build artifact, and main() below only ever ADDS files, so a
  // stale exe/probe/README from a previous run (e.g. the host existed then,
  // doesn't now) would otherwise survive untouched.
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  for (const name of plan.copy) {
    copyFileSync(join(binDir, name), join(stageDir, name))
  }
  if (plan.writeReadme) {
    writeFileSync(join(stageDir, 'README.txt'), README_NOT_BUILT)
  }
  console.log(plan.message)
}

// Only run the staging routine when this file is executed directly (`node
// scripts/stage-vst-host.mjs`). stage-vst-host.test.mjs imports this module
// for the pure planVstHostStaging() above, and that import must not also copy
// files as a side effect.
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main()
}
