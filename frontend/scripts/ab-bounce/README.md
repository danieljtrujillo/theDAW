# ab-bounce — offline-render A/B harness

Renders one synthetic project twice — through the three inline bodies
`WaveformEditor.tsx` carried before ticket T11b (`legacyBodies.ts`, a verbatim
transcription of this repo's own code) and through `src/lib/renderCore.ts` —
then reports max |Δ| and RMS Δ per channel, for the rendered buffer and for the
encoded WAV. A case fails if either domain exceeds 1e-4 **or** the two sides are
not the same length and channel count.

Four groups of cases are no longer a plain legacy-vs-core diff, and each says
so up front:

- Since T14 a bounce is shifted forward by the latency its chains declare, so
  every case whose rack holds the compressor states `expectTrimSec: 0.006` and
  the legacy side is shifted by the same amount before the diff. The case still
  asserts identical audio — it just says where. A trim of the wrong size goes
  straight over the gate.
- Case **D** is the routing graph, which the legacy bodies predate entirely.
  Its reference is the core's own routing-less render of the same project times
  the gain the live graph is specified to apply (a send taps the same output as
  the main path, and a bus fader is one gain), so it asserts the routed render
  against a number written out by hand rather than against the renderer.
- Since T18 the shift is **per track**: the master scope holds `maxSec - own` on
  each strip's compensation delay, so every track lands where the timeline says
  rather than only the slowest one. One `expectTrimSec` per case cannot state
  that, so a case with tracks of DIFFERENT latencies builds its reference with
  `alignedLegacyMix` — one legacy render per latency group, each shifted by its
  own declared figure, summed — and leaves `expectTrimSec` at 0.
  - Case **E** is the two-track minimum of it: one compressed track, one dry
    one, nothing else. The dry track's reference shift is **exactly 0** (it is
    where it always should have been; before T18 the bounce printed it 6 ms
    early), the compressed one's is 0.006, and the case is bit-identical.
    Its dry track also carries a clip ending on the render's **last sample**, so
    the case asserts the padded context: a comp delay pushes that clip's last
    6 ms past the end of a window-sized render, where it would never be rendered
    and the trim would zero-fill it. Un-padded, case E reads max |Δ| 6.2e-1.
    A **stem** is deliberately NOT padded — it carries no comp, its own rack
    still prints it late, and the legacy body it is compared against truncates
    in the same place, so case C stays bit-identical. Padding it would put case
    C over the gate, which is the harness correctly reporting a divergence from
    the body it replaced.
  - Case **B** is the same assertion over the four-track mix. It carries a
    master reverb, which the reference convolves per part rather than over the
    sum; convolution is linear, so the two agree to about 3e-7 — one float32
    ULP at these amplitudes, and the same residual the case already showed
    before T18. Case E is the exact version of the claim.

  Case E is also what pins the comp delay's `channelCountMode: 'explicit'`. A
  `DelayNode` left on the default `'max'` follows its input's channel count,
  and when a clip's sources go inactive that count drops, Chrome reallocates
  the delay lines, and the samples still inside them are lost — measured at
  max |Δ| 3.3e-1 over the last 247 samples of a clip. Case E renders with
  `includeTrackMix: true`, so every comp's upstream is a `StereoPannerNode` and
  permanently 2-channel while it runs: a 2-channel upstream does **not** protect
  the node, because what drops is the count the delay computes from an input it
  no longer considers active. The same loss reproduces in a hand-built
  `source -> gain -> panner -> delay` graph, and both are exact with the count
  pinned to the bounce's stereo.

- Case **F** is COMPING (two of them), and the legacy bodies predate takes
  entirely, so there is no legacy render either. Its reference is the **live
  strip**, built by hand in `main.ts` (`liveStripRender`): `gain -> muteGain ->
  panner`, the shape `liveMixer.buildTrackNodes` makes, driven by the same
  `scheduleClipSources` and the same take resolver
  (`takeIndex -> peekDecoded(takes[i].audioBlob)`) the live scheduler builds,
  rendered offline from the top of the timeline. That is `export == preview`
  asserted as arithmetic: both sides decode through the one `lib/decodeCache` at
  44.1 kHz and therefore read the *same* buffers, so the only way to differ is
  to resolve a different take or to place a segment differently.
  - `F · comped` is a clip with two takes (220 Hz stereo / 880 Hz **mono**) and
    one boundary at 1.5 s with a 0.3 s crossfade, active take 1, with plain
    clips beside it on the same track and on a second track — so it also states
    that a comped clip changes nothing around it. The two takes are a whole tone
    generator and a channel count apart, so a wrongly resolved take is max |Δ|
    near full scale, never a rounding residual — measured at 1.247 / 7.980e-1
    with `renderCore`'s resolver mutated to answer take 0 for every index.
    It asserts the decode, the take resolution, the segment placement (the
    boundary at 1.5 s) and the crossfade across it: the same
    `scheduleClipSources` walks `compSegments` on both sides, so the case cannot
    go stale against the scheduler — it *is* the scheduler on both sides of the
    diff, with only the buffer supply and the strip differing.
  - `F · takes without a comp` is the same project with `comp = []`. Takes with
    no comp is take SWITCHING, which must render exactly as a clip with no takes
    at all: the single-buffer path, both sides.

Run from `frontend/`: `node scripts/ab-bounce/run.mjs` (exit 1 on any failure).
It starts Vite on an **OS-assigned free port** — never 3000 — and drives the
locally installed Playwright Chromium; nothing is downloaded and nothing leaves
the machine.

Typecheck it with `npm run lint:scripts` (`scripts/tsconfig.json`, which extends
the app config and includes `../src/*.d.ts` for the Vite ambient types). This
directory is outside the app's `tsconfig.json` `include` (`["src"]`) and outside
`scripts/run-tests.mjs`'s walk (`src/` only), so `npm run lint` and `npm test`
do **not** cover it — `lint:scripts` is what keeps it from rotting against the
modules it imports.
