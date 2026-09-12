/**
 * Run every frontend test suite.
 *
 * Why this exists: `npm test` used to be a hand-maintained chain of
 * `npm run test:<name>` calls, so a `*.test.ts` file only ever ran if somebody
 * remembered to name it in TWO places (its own `test:*` script and the chain).
 * Nine suites were orphaned that way and went unrun for weeks. This runner
 * discovers the files instead, so a new test runs the moment it is written and
 * a forgotten registration can no longer hide a failing suite.
 *
 * The per-suite `test:*` scripts in package.json are still there and still the
 * way to run ONE suite while working on it (`npm run test:sing`). They are no
 * longer load-bearing for coverage.
 *
 * Each file runs in its own `tsx` process, exactly as the old chain did, so a
 * suite that mutates module state cannot leak into the next one. Files run a
 * few at a time; output is buffered and printed in discovery order so a run is
 * reproducible to read. Exit code is non-zero if any suite fails.
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(frontendDir, 'src')

/** How many suites run at once. Each is a separate node process. */
const CONCURRENCY = 4

/** Directories that never hold app tests. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite'])

async function findTests(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      found.push(...(await findTests(join(dir, entry.name))))
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      found.push(join(dir, entry.name))
    }
  }
  return found
}

function runOne(file) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [join(frontendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), file],
      { cwd: frontendDir, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (b) => {
      out += b
    })
    child.stderr.on('data', (b) => {
      out += b
    })
    child.on('error', (err) => done({ file, code: 1, out: `${out}\n${err.message}` }))
    child.on('close', (code) => done({ file, code: code ?? 1, out }))
  })
}

const files = (await findTests(srcDir)).sort()
if (files.length === 0) {
  console.error('run-tests: no *.test.ts(x) files found under src/')
  process.exit(1)
}
console.log(`running ${files.length} test suites\n`)

const results = []
let next = 0
async function worker() {
  while (next < files.length) {
    const mine = next++
    results[mine] = await runOne(files[mine])
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker))

let failed = 0
for (const result of results) {
  const name = relative(frontendDir, result.file).replace(/\\/g, '/')
  if (result.code === 0) {
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}`)
    console.log(
      result.out
        .trimEnd()
        .split('\n')
        .map((line) => `        ${line}`)
        .join('\n'),
    )
  }
}

console.log(`\n${files.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
