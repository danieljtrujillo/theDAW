/**
 * Every package.json script that type-checks runs the TypeScript the package
 * declares (7), by its path, and none runs node_modules/.bin/tsc.
 *
 * @typescript/typescript6, the TypeScript 6 compiler API that two tests
 * import, depends on "@typescript/old" (npm:typescript@^6), whose bin is also
 * named tsc, and npm links that one into .bin/tsc: in this tree
 * `npx tsc --version` prints 6.0.3. A script or a check written as `tsc` or
 * `npx tsc` type-checks with TypeScript 6 and passes code TypeScript 7
 * rejects (TS2448 in djSemanticWaveformAnalysis.ts was one). `npm run
 * typecheck` is the one-command type check; `npm run lint` adds the class
 * check.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(frontendDir, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}

const TSC_BY_PATH = 'node ./node_modules/typescript/bin/tsc'

for (const name of ['typecheck', 'lint', 'lint:scripts']) {
  const script = pkg.scripts[name]
  assert.ok(script, `package.json has a ${name} script`)
  assert.ok(script.includes(TSC_BY_PATH), `${name} runs the declared TypeScript by its path: ${script}`)
}
assert.match(pkg.scripts.typecheck, /--noEmit/, 'typecheck only checks')

for (const [name, script] of Object.entries(pkg.scripts)) {
  assert.ok(!/(^|&&|\|\||;|\s)(npx\s+)?tsc(\s|$)/.test(script), `${name} runs .bin/tsc: ${script}`)
}

// The path is the declared major, whatever npm linked into .bin.
const declaredMajor = /(\d+)/.exec(pkg.devDependencies.typescript)?.[1]
assert.ok(declaredMajor, `a typescript devDependency: ${pkg.devDependencies.typescript}`)
const run = spawnSync(process.execPath, ['./node_modules/typescript/bin/tsc', '--version'], {
  cwd: frontendDir,
  encoding: 'utf8',
  timeout: 60_000,
})
assert.equal(run.status, 0, run.stderr)
const ranMajor = /Version (\d+)\./.exec(run.stdout)?.[1]
assert.equal(ranMajor, declaredMajor, `the scripts' tsc is TypeScript ${declaredMajor}: ${run.stdout.trim()}`)

console.log(`typescript version: the type-check scripts run TypeScript ${ranMajor}`)
