// Run with: npx tsx electron-ui/main/backendStop.test.ts
//
// The desktop shell's quit, replayed against a stand-in backend. The bug: the
// shell sent POST /api/admin/shutdown and force-killed the backend's tree 3 s
// later whatever the answer, while the backend now spends up to 15.6 s in its
// shutdown handlers (live VST hosts saving plugin state among them). The kill
// landed in the middle of those saves.
//
// Timings are scaled down (the real ones are asserted against
// backend/admin_routes.py at the end), so every sequence runs in well under a
// second.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  BACKEND_KILL_WAIT_MS,
  BACKEND_SHUTDOWN_GRACE_MS,
  stopBackend,
  type BackendStopper,
} from './backendStop.ts'

// electron-ui is a CommonJS package, so tsx runs this file as CJS: __dirname,
// and no top-level await (the sequences run inside main() below).
const HERE = __dirname
const REPO = path.resolve(HERE, '..', '..')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface FakeBackend {
  stopper: BackendStopper
  events: string[]
  exit(): void
}

/** A backend that answers the shutdown request with ``answer`` and, when told
 *  to, exits; ``forceKill`` exits it too unless ``killHangs``. The fake exits
 *  inside the kill, so the exit listener can settle before the kill resolves,
 *  as it can with a real taskkill; the kill cases below accept either. */
function fakeBackend(answer: 'accept' | 'refuse' | 'unreachable', killHangs = false): FakeBackend {
  const events: string[] = []
  const listeners: Array<() => void> = []
  let alive = true
  const exit = (): void => {
    if (!alive) return
    alive = false
    events.push('exit')
    for (const l of listeners) l()
  }
  const stopper: BackendStopper = {
    requestShutdown: async () => {
      events.push('request')
      if (answer === 'unreachable') throw new Error('ECONNREFUSED')
      return answer === 'accept'
    },
    onExit: (l) => {
      listeners.push(l)
    },
    forceKill: () => {
      events.push('kill')
      if (killHangs) return new Promise<void>(() => {})
      exit()
      return Promise.resolve()
    },
    log: () => {},
  }
  return { stopper, events, exit }
}

async function main(): Promise<void> {
  // An accepted shutdown whose handlers run for longer than the old fixed 3 s
  // (scaled here: 300 ms of a 1000 ms budget) is waited for, never killed.
  {
    const backend = fakeBackend('accept')
    const stopping = stopBackend(backend.stopper, 1000, 200)
    // The old shell killed at 3 s of a 17 s budget: 176 ms at this scale.
    await sleep(300)
    assert.deepEqual(backend.events, ['request'], 'the tree was killed while the handlers ran')
    backend.exit()
    assert.equal(await stopping, 'exited')
    assert.deepEqual(backend.events, ['request', 'exit'])
  }

  // A refused request (the backend answered, but not with success) kills at once:
  // nothing is running the handlers, so there is nothing to wait for.
  {
    const backend = fakeBackend('refuse')
    const started = Date.now()
    assert.notEqual(await stopBackend(backend.stopper, 5000, 200), 'deadline')
    assert.ok(Date.now() - started < 1000, 'a refused shutdown waited out the whole budget')
    assert.deepEqual(backend.events, ['request', 'kill', 'exit'])
  }

  // No answer at all (the backend is hung or already gone): kill at once too.
  {
    const backend = fakeBackend('unreachable')
    const started = Date.now()
    assert.notEqual(await stopBackend(backend.stopper, 5000, 200), 'deadline')
    assert.ok(Date.now() - started < 1000, 'an unanswered shutdown waited out the whole budget')
    assert.deepEqual(backend.events, ['request', 'kill', 'exit'])
  }

  // Accepted but never exits: killed once the budget runs out, not before.
  {
    const backend = fakeBackend('accept')
    const started = Date.now()
    assert.notEqual(await stopBackend(backend.stopper, 250, 200), 'deadline')
    assert.ok(Date.now() - started >= 240, 'killed before the budget ran out')
    assert.deepEqual(backend.events, ['request', 'kill', 'exit'])
  }

  // A kill that never finishes cannot hold the quit: the deadline lets it go.
  {
    const backend = fakeBackend('refuse', true)
    assert.equal(await stopBackend(backend.stopper, 5000, 150), 'deadline')
    assert.deepEqual(backend.events, ['request', 'kill'])
  }

  // The real grace outlasts what backend/admin_routes.py gives its handlers.
  {
    const admin = fs.readFileSync(path.join(REPO, 'backend', 'admin_routes.py'), 'utf8')
    const num = (name: string): number => {
      const m = admin.match(new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, 'm'))
      assert.ok(m, `${name} not found in backend/admin_routes.py`)
      return Number(m[1])
    }
    const needed = (num('_EXIT_DELAY_SEC') + num('SHUTDOWN_HANDLER_BUDGET_SEC')) * 1000
    assert.ok(
      BACKEND_SHUTDOWN_GRACE_MS > needed,
      `grace ${BACKEND_SHUTDOWN_GRACE_MS} ms does not outlast the backend's ${needed} ms`,
    )
    assert.ok(BACKEND_KILL_WAIT_MS > 0)
  }

  // main/index.ts stops its backend through stopBackend, not a timer of its own.
  {
    const index = fs.readFileSync(path.join(HERE, 'index.ts'), 'utf8')
    const body = index.slice(index.indexOf('function killBackend('))
    const end = body.indexOf('\n}\n')
    assert.ok(body.slice(0, end).includes('stopBackend('), 'killBackend does not use stopBackend')
  }

  console.log('backendStop.test.ts: all assertions passed')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
