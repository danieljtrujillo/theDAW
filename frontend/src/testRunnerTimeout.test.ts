/**
 * scripts/run-tests.mjs stops a suite that never exits and counts it failed.
 *
 * A jsdom suite whose assertion failed inside a polling interval kept node
 * alive, and with no per-suite limit `npm test` waited on it forever. This
 * replays that: a suite that fails and leaves an interval running, run
 * through the real runner with a short limit, must end the run with a
 * failure and the runner's own timeout line, next to a suite that passes.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'run-tests-timeout-'))
try {
  const hanging = join(dir, 'hangs.test.ts')
  writeFileSync(
    hanging,
    "setInterval(() => undefined, 1000)\nconsole.error('assertion failed inside the poll')\n",
  )
  const passing = join(dir, 'passes.test.ts')
  writeFileSync(passing, "console.log('ok')\n")

  const started = Date.now()
  const run = spawnSync(process.execPath, [join(frontendDir, 'scripts', 'run-tests.mjs'), hanging, passing], {
    cwd: frontendDir,
    env: { ...process.env, FRONTEND_TEST_TIMEOUT_MS: '3000' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const elapsed = Date.now() - started

  assert.equal(run.error, undefined, `the runner itself never finished: ${run.error?.message}`)
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout, /FAIL {2}.*hangs\.test\.ts/)
  assert.match(run.stdout, /run-tests: stopped after 3000 ms without exiting/)
  assert.match(run.stdout, /assertion failed inside the poll/)
  assert.match(run.stdout, /PASS {2}.*passes\.test\.ts/)
  assert.match(run.stdout, /1 passed, 1 failed/)
  assert.ok(elapsed < 45_000, `the run took ${elapsed} ms`)
  console.log('testRunnerTimeout: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
