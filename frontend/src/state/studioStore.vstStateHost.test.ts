// Run with: npx tsx src/state/studioStore.vstStateHost.test.ts
//
// F1b1: `processChain` must forward `stateHost` to `processVst` for every VST
// stage, the same way lib/vstClient's `processFileThroughVst` already does.
// Plugin state IS interchangeable between theDAW's live host and pedalboard —
// measured: parameters restore exactly, containers are byte-identical.
// `state_host` only selects which one renders the entry; it was never about
// whether the state could be reused. See effectChainStore.ts's `vstStateHost`
// for the one place that decision lives.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useStudioStore } from './studioStore.ts';
import { useEffectChainStore } from './effectChainStore.ts';
import { useAdvancedEditorSourceStore } from './advancedEditorStore.ts';

/**
 * R1 rework finding 1 (effectChainStore.ts ~117-119): the doc comment pinned
 * to `vstStateHost` itself — not the portability comment 16 lines above it —
 * still asserted the claim this ticket exists to delete: "hand an old sidecar
 * blob to a host that will reject it". Reads the function's own doc block
 * back so a regression here fails even though the block above it is correct.
 */
function vstStateHostDocDoesNotClaimRejection(): void {
  const src = readFileSync(new URL('./effectChainStore.ts', import.meta.url), 'utf8');
  const fnIdx = src.indexOf(
    'export const vstStateHost = (vst: VstNode | undefined): VstStateHost =>',
  );
  assert.ok(fnIdx >= 0, 'vstStateHost must still exist at its known signature');
  const docStart = src.lastIndexOf('/**', fnIdx);
  assert.ok(docStart >= 0, 'vstStateHost must still have a doc comment');
  const doc = src.slice(docStart, fnIdx);
  assert.ok(
    !/reject/i.test(doc),
    'vstStateHost doc must not claim a host will reject the other host state (false - states are interchangeable)',
  );
  assert.ok(
    doc.includes('does not gate reuse'),
    'vstStateHost doc must say state_host selects the renderer and does not gate reuse',
  );
}

/**
 * R1 rework finding 2 (studioStore.ts ~257-262): the comment above the
 * `state_host` append inside `processVst` — the function `processChain` now
 * feeds — still justified "no silent retry through pedalboard" with the same
 * false claim: "a blob that host cannot read". Reads the comment attached to
 * that exact line back so a regression here fails independently of the
 * interface doc comment above `processVst`'s type, which was already fixed.
 */
function processVstStateHostCommentDoesNotClaimUnreadableBlob(): void {
  const src = readFileSync(new URL('./studioStore.ts', import.meta.url), 'utf8');
  const lineIdx = src.indexOf("if (stateHost === 'thedaw') form.append('state_host', 'thedaw');");
  assert.ok(lineIdx >= 0, 'processVst must still gate state_host on stateHost === thedaw');
  const blockStart = src.lastIndexOf('\n\n', lineIdx) + 1;
  const comment = src.slice(blockStart, lineIdx);
  assert.ok(
    !/cannot read/i.test(comment),
    'processVst state_host comment must not claim a host cannot read the other host state (false - states are interchangeable)',
  );
  assert.ok(
    comment.includes('surfaced instead of masked'),
    'processVst state_host comment must justify no-retry by renderer choice, not blob unreadability',
  );
}

vstStateHostDocDoesNotClaimRejection();
processVstStateHostCommentDoesNotClaimUnreadableBlob();

// effectChainStore is `persist`-wrapped, but this file only ever touches it
// through the store's own top-level `setState`/`getState` — never through
// `addVst`/`setVstRawState` (the actions the persist wrapper's inner `set`
// warns through when storage is unavailable) — so unlike effectChainStore's
// OWN test, no localStorage/window shim is needed here. Leaving `window`
// undefined also matters for a second reason: playerStore.ts (pulled in
// transitively through studioStore) only registers its browser gesture
// listeners when `typeof window !== 'undefined'`, and a fake `window` without
// a real DOM would make that guard true and crash on `window.addEventListener`.

(async () => {
  type StudioState = ReturnType<typeof useStudioStore.getState>;
  type ProcessVstPayload = Parameters<StudioState['processVst']>[0];

  useAdvancedEditorSourceStore.setState({ sourceFile: new File(['RIFF'], 'source.wav', { type: 'audio/wav' }) });

  // (a) An entry marked `thedaw` (a live capture) forwards that exact host —
  // the render has to go back through the host that wrote the state.
  const liveCalls: ProcessVstPayload[] = [];
  useStudioStore.setState({
    processVst: async (payload: ProcessVstPayload) => {
      liveCalls.push(payload);
    },
  });
  useEffectChainStore.setState({
    chain: [
      {
        id: 'live-entry',
        effect: 'vst3',
        params: {},
        enabled: true,
        vst: {
          plugin_path: 'C:/plugins/Ozone 11.vst3',
          plugin_name: 'Ozone 11',
          raw_state: 'LIVE',
          state_host: 'thedaw',
        },
      },
    ],
  });
  await useStudioStore.getState().processChain();
  assert.equal(liveCalls.length, 1, 'the chain ran exactly one VST stage');
  assert.equal(liveCalls[0]?.stateHost, 'thedaw', 'a thedaw-captured entry forwards its own host');

  // (b) An entry with no `state_host` (every pre-existing project) defaults to
  // 'pedalboard' rather than sending nothing and leaving the backend to guess.
  const legacyCalls: ProcessVstPayload[] = [];
  useStudioStore.setState({
    processVst: async (payload: ProcessVstPayload) => {
      legacyCalls.push(payload);
    },
  });
  useEffectChainStore.setState({
    chain: [
      {
        id: 'legacy-entry',
        effect: 'vst3',
        params: {},
        enabled: true,
        vst: { plugin_path: 'C:/plugins/Vinyl.vst3', plugin_name: 'Vinyl' },
      },
    ],
  });
  await useStudioStore.getState().processChain();
  assert.equal(legacyCalls.length, 1, 'the chain ran exactly one VST stage');
  assert.equal(legacyCalls[0]?.stateHost, 'pedalboard', 'an unmarked entry defaults to pedalboard, not undefined');

  useEffectChainStore.setState({ chain: [] });
  console.log('studioStore: processChain forwards stateHost via vstStateHost');
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
