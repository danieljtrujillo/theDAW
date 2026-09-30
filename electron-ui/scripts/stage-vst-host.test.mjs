// Run with: node scripts/stage-vst-host.test.mjs
import assert from 'node:assert/strict'
import { planVstHostStaging } from './stage-vst-host.mjs'

// (a) Host built, probe built: copy both, no README, one message naming both.
{
  const plan = planVstHostStaging({ exeExists: true, probeExists: true })
  assert.deepEqual(plan.copy, ['thedaw-vst-host.exe', 'vst3_probe.exe'])
  assert.equal(plan.writeReadme, false)
  assert.match(plan.message, /thedaw-vst-host\.exe/)
  assert.match(plan.message, /vst3_probe\.exe/)
}

// (b) Host built, probe missing: still ship the host; the message says the
// probe is absent rather than silently dropping it.
{
  const plan = planVstHostStaging({ exeExists: true, probeExists: false })
  assert.deepEqual(plan.copy, ['thedaw-vst-host.exe'])
  assert.equal(plan.writeReadme, false)
  assert.match(plan.message, /thedaw-vst-host\.exe/)
  assert.match(plan.message, /not found/)
}

// (c) Host not built: nothing to copy, but packaging must still proceed -- a
// README explaining the gap is written instead, and the plan never claims to
// have staged anything.
{
  const plan = planVstHostStaging({ exeExists: false, probeExists: false })
  assert.deepEqual(plan.copy, [])
  assert.equal(plan.writeReadme, true)
  assert.match(plan.message, /not found/)
  assert.match(plan.message, /build\.ps1/)
}

// (d) Host not built but a stray probe is present: still no copy -- a probe
// without the host it accompanies is not a usable live-VST payload.
{
  const plan = planVstHostStaging({ exeExists: false, probeExists: true })
  assert.deepEqual(plan.copy, [])
  assert.equal(plan.writeReadme, true)
}

console.log('stage-vst-host: all assertions passed')
