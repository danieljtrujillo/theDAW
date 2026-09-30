// Run with: npx tsx src/components/layout/actionKeyFace.test.ts
import assert from 'node:assert/strict';
import { CENTER_TABS } from '../../state/appUiStore';
import {
  actionKeyFace,
  actionKind,
  generationCaption,
  type ActionKeyFace,
  type ActionKeyInput,
} from './actionKeyFace.ts';

/**
 * Every legend's width at 12px Orbitron 700 with no tracking, measured in the
 * running app (Chromium, 1366x768 and 1920x1080 agree). A new legend fails
 * below until it is measured and shown to fit.
 */
const LEGEND_WIDTH_PX: Record<string, number> = { CREATE: 57.3, PROCESS: 68.2, TRAIN: 41.6, STOP: 38.5, CHAIN: 42.7, SEND: 39.1 };
/** The key inside its plate: PlayerFooter's w-20 wrapper less 1px border and 1px padding a side. */
const KEY_INNER_PX = 80 - 4;
/** The least room a legend keeps from each side of the key. */
const LEGEND_SIDE_PX = 3;
/**
 * The label of a key dimmed by something outside itself: one waiting on the
 * other workspace's studio run, and UNDERFIT's TRAIN when the dashboard has no
 * run to repeat or is out of reach. TRAIN's own "starting a run…" is not one of
 * these — that key is latched on its own run, like every other busy key.
 */
const WAITING =
  /: waiting for the (EDIT process|MIX chain) to finish$|^Train: (set up the first run|the Underfit dashboard is not answering|restart the backend)/;

const IDLE: ActionKeyInput = {
  centerTab: 'make',
  model: 'small',
  isGenerating: false,
  progressPct: 0,
  statusLabel: 'READY',
  sunoSubmitting: false,
  isProcessing: false,
  isChainProcessing: false,
  trainingRun: null,
  trainingLink: 'ok',
  lastRunName: null,
  startingRun: false,
  vjTargetActive: false,
};

/** Asserts what every face must hold, and returns it. */
const face = (input: ActionKeyInput): ActionKeyFace => {
  const f = actionKeyFace(input);
  assert.match(f.legend, /^[A-Z]+$/, `legend "${f.legend}" is one word`);
  assert.ok(
    f.label.toLowerCase().startsWith(f.legend.toLowerCase()),
    `label "${f.label}" starts with its legend "${f.legend}"`,
  );
  assert.doesNotMatch(f.label, /\d+%/, `label "${f.label}" carries no percentage`);
  const w = LEGEND_WIDTH_PX[f.legend];
  assert.ok(w !== undefined, `legend "${f.legend}" has a measured width`);
  assert.ok(w + 2 * LEGEND_SIDE_PX <= KEY_INNER_PX, `legend "${f.legend}" (${w}px) fits the ${KEY_INNER_PX}px key`);
  if (f.disabled) {
    assert.ok(f.on || WAITING.test(f.label), `busy key "${f.label}" is its own run, or names the run it waits for`);
  }
  if (WAITING.test(f.label)) assert.ok(f.disabled && !f.on, 'a waiting key is busy and unlatched');
  if (f.progress) assert.ok(f.on, 'progress only shows on a latched key');
  if (f.on) assert.ok(f.progress, 'every live run shows progress on the foot');
  if (f.progressText) assert.equal(f.progress?.kind, 'fill', 'a description only for measured progress');
  if (f.caption) assert.equal(f.kind, 'create', 'only CREATE prints a caption');
  return f;
};

// (a) Every tab's idle key: MIX, DJ, EDIT and UNDERFIT have their own action,
// every other workspace creates. The tab list is appUiStore's own.
{
  const expected: Record<string, [string, string]> = { mix: ['CHAIN', 'chain'], dj: ['SEND', 'send'], edit: ['PROCESS', 'process'], underfit: ['TRAIN', 'train'] };
  for (const tab of CENTER_TABS) {
    const f = face({ ...IDLE, centerTab: tab });
    const [legend, glyph] = expected[tab] ?? ['CREATE', 'create'];
    assert.equal(f.legend, legend, `${tab} legend`);
    assert.equal(f.glyph, glyph, `${tab} glyph`);
    assert.equal(f.on, false, `${tab} rests unlatched`);
    // UNDERFIT's runs start in its dashboard, so its key rests dimmed.
    assert.equal(f.disabled, tab === 'underfit', `${tab} rests ${tab === 'underfit' ? 'dimmed' : 'enabled'}`);
    assert.equal(f.progress, null, `${tab} rests with no progress`);
    assert.equal(f.caption, null, `${tab} rests with no caption`);
  }
  assert.equal(actionKind('underfit'), 'train');
  assert.equal(actionKind('not-a-tab'), 'create');
}

// (b) Each face has its own glyph, STOP included.
{
  const glyphs = [
    face(IDLE),
    face({ ...IDLE, centerTab: 'edit' }),
    face({ ...IDLE, centerTab: 'underfit' }),
    face({ ...IDLE, centerTab: 'mix' }),
    face({ ...IDLE, centerTab: 'dj' }),
    face({ ...IDLE, isGenerating: true }),
  ].map((f) => f.glyph);
  assert.equal(new Set(glyphs).size, glyphs.length, `glyphs are distinct: ${glyphs.join(', ')}`);
}

// (c) A CREATE run replayed in generateStore's order: submit, pre-flight, the
// paced progress, the sampler, completion, then a second run the user stops
// and the backend cancels (STOP -> CANCELLING... -> CANCELLED, confirmCancel).
// The name holds still through every tick; the stage is the caption.
{
  let s: ActionKeyInput = { ...IDLE };
  let f = face(s);
  assert.equal(f.legend, 'CREATE');
  assert.equal(f.label, 'Create: submit SMALL to /api/generate-jobs');
  assert.equal(f.caption, null);

  s = { ...s, isGenerating: true, statusLabel: 'SUBMITTING JOB...', progressPct: 0 };
  f = face(s);
  assert.equal(f.legend, 'STOP');
  assert.equal(f.glyph, 'stop');
  assert.equal(f.on, true);
  assert.equal(f.disabled, false, 'STOP takes a press');
  assert.deepEqual(f.progress, { kind: 'pending' }, 'no measured progress yet');
  assert.equal(f.progressText, null);
  assert.equal(f.label, 'Stop and cancel the generation job');
  assert.deepEqual(f.caption, { text: 'SUBMITTING JOB...', tone: 'running' }, 'the pre-flight stage is on screen');
  const stopName = f.label;

  s = { ...s, statusLabel: 'CHECKING MODELS...', progressPct: 1.2 };
  assert.deepEqual(face(s).caption, { text: 'CHECKING MODELS...', tone: 'running' });

  s = { ...s, statusLabel: 'QUEUED...', progressPct: 3.6 };
  f = face(s);
  assert.deepEqual(f.progress, { kind: 'fill', pct: 4 });
  assert.equal(f.progressText, '4% done');
  assert.equal(f.label, stopName, 'the name holds still');
  assert.deepEqual(f.caption, { text: 'QUEUED...', tone: 'running' });

  s = { ...s, statusLabel: 'SAMPLING 4/8', progressPct: 57.5 };
  f = face(s);
  assert.deepEqual(f.progress, { kind: 'fill', pct: 58 });
  assert.equal(f.progressText, '58% done');
  assert.equal(f.caption, null, 'the sampler stage is the percentage, not a caption');
  for (let pct = 58; pct <= 99; pct += 3) {
    const tick = face({ ...s, progressPct: pct });
    assert.equal(tick.label, stopName, `the name holds still at ${pct}%`);
    assert.equal(tick.progressText, `${pct}% done`);
  }

  s = { ...s, isGenerating: false, statusLabel: 'COMPLETE', progressPct: 100 };
  f = face(s);
  assert.equal(f.legend, 'CREATE');
  assert.equal(f.on, false);
  assert.equal(f.progress, null, 'a finished run leaves no bar behind at 100%');
  assert.equal(f.progressText, null);
  assert.equal(f.label, 'Create: submit SMALL to /api/generate-jobs');
  assert.deepEqual(f.caption, { text: 'COMPLETE', tone: 'complete' }, 'the outcome holds until the next press');

  // The second run: STOP is pressed mid-sampling. cancelGeneration returns the
  // key to CREATE at once, confirmCancel writes CANCELLING... and, once the job
  // reports cancelled, CANCELLED.
  s = { ...s, isGenerating: true, statusLabel: 'SAMPLING 2/8', progressPct: 31 };
  assert.equal(face(s).legend, 'STOP');
  // CANCELLING... is the job still winding down, so its dot pulses like a live
  // stage; STOPPED and CANCELLED are settled.
  for (const [status, tone] of [['STOPPED', 'stopped'], ['CANCELLING...', 'running'], ['CANCELLED', 'stopped']] as const) {
    s = { ...s, isGenerating: false, statusLabel: status, progressPct: 0 };
    f = face(s);
    assert.equal(f.legend, 'CREATE', `${status}: the key is CREATE again`);
    assert.equal(f.on, false);
    assert.equal(f.disabled, false, `${status}: CREATE takes a press while the job winds down`);
    assert.equal(f.label, 'Create: submit SMALL to /api/generate-jobs');
    assert.deepEqual(f.caption, { text: status, tone }, `${status} reads as ${tone}, never a failure or a success`);
  }
}

// (c2) A Magenta run is cancelled the same way, so STOP reads the same.
{
  const run = face({ ...IDLE, model: 'magenta-small', isGenerating: true, statusLabel: 'STARTING MAGENTA ENGINE...' });
  assert.equal(run.legend, 'STOP');
  assert.equal(run.label, 'Stop and cancel the generation job');
  assert.deepEqual(run.caption, { text: 'STARTING MAGENTA ENGINE...', tone: 'running' });
  assert.equal(face({ ...IDLE, model: 'magenta-small', isGenerating: true, progressPct: 50 }).label, run.label, 'the name holds still');
}

// (d) The outcomes that used to print under CREATE are on screen again, as the
// caption, and the key's name holds still.
{
  for (const status of ['PROMPT REQUIRED', 'NO USABLE MODEL', 'FAILED', 'SERVER RESET', 'CHIMERA FAILED']) {
    const f = face({ ...IDLE, statusLabel: status });
    assert.equal(f.legend, 'CREATE');
    assert.equal(f.label, 'Create: submit SMALL to /api/generate-jobs', `${status}: the name holds still`);
    assert.deepEqual(f.caption, { text: status, tone: 'failed' }, `${status} is on screen`);
  }
  for (const stage of ['RENDERING CHIMERA...', 'HEALING SEAMS...']) {
    assert.deepEqual(face({ ...IDLE, isGenerating: true, statusLabel: stage }).caption, { text: stage, tone: 'running' });
  }
  assert.equal(generationCaption('READY', false), null);
  assert.equal(generationCaption('IDLE', false), null, 'an internal IDLE prints nothing');
  assert.equal(generationCaption('SAMPLING 2/8', true), null);
  assert.deepEqual(
    generationCaption('CHECKING MODELS...', false),
    { text: 'CHECKING MODELS...', tone: 'stopped' },
    'a stage left behind by a run that ended without an outcome never reads as complete',
  );
}

// (e) Progress is clamped and rounded; anything unmeasurable is pending.
{
  const run = { ...IDLE, isGenerating: true, statusLabel: 'SAMPLING 8/8' };
  assert.deepEqual(face({ ...run, progressPct: 140 }).progress, { kind: 'fill', pct: 100 });
  assert.equal(face({ ...run, progressPct: 140 }).progressText, '100% done');
  assert.deepEqual(face({ ...run, progressPct: 0.4 }).progress, { kind: 'pending' });
  assert.deepEqual(face({ ...run, progressPct: -5 }).progress, { kind: 'pending' });
  assert.deepEqual(face({ ...run, progressPct: Number.NaN }).progress, { kind: 'pending' });
  assert.equal(face({ ...run, progressPct: Number.NaN }).progressText, null);
}

// (f) UNDERFIT, replayed in underfitRunsStore's order: no dashboard run at all
// (TRAIN rests dimmed, since the first run needs the dashboard's form), a run
// exists (TRAIN repeats it, named), the press is out (busy), a run goes live
// (STOP, latched, pulsing foot, named), the press sends its kill (busy while it
// is out), the run is killed (TRAIN again).
{
  const tab = { ...IDLE, centerTab: 'underfit' };
  const rest = face(tab);
  assert.equal(rest.legend, 'TRAIN');
  assert.equal(rest.disabled, true, 'with no run to repeat there is nothing to start');
  assert.equal(rest.on, false);
  assert.match(rest.label, /^Train: set up the first run in the Underfit dashboard above/);
  assert.match(face({ ...tab, trainingLink: 'dashboard-down' }).label, /^Train: the Underfit dashboard is not answering/);
  assert.match(face({ ...tab, trainingLink: 'backend-old' }).label, /restart the backend so this key can start and stop runs$/);

  // A run exists: the key repeats its settings, and names the run it copies.
  const repeat = face({ ...tab, lastRunName: 'drums-lora' });
  assert.equal(repeat.legend, 'TRAIN');
  assert.equal(repeat.glyph, 'train');
  assert.equal(repeat.disabled, false, 'a press starts a run');
  assert.equal(repeat.on, false);
  assert.equal(repeat.label, 'Train again with the settings of "drums-lora"');

  // A run to repeat is no use while the dashboard is unreachable.
  assert.equal(face({ ...tab, lastRunName: 'drums-lora', trainingLink: 'dashboard-down' }).disabled, true);
  assert.equal(face({ ...tab, lastRunName: 'drums-lora', trainingLink: 'backend-old' }).disabled, true);

  // The start request is out: latched and busy, so a second press sends nothing.
  const starting = face({ ...tab, lastRunName: 'drums-lora', startingRun: true });
  assert.equal(starting.legend, 'TRAIN');
  assert.equal(starting.on && starting.disabled, true);
  assert.equal(starting.label, 'Train: starting a run…');
  assert.deepEqual(starting.progress, { kind: 'pending' });

  const running = face({ ...tab, lastRunName: 'drums-lora', trainingRun: { name: 'drums-lora', others: 0, stopping: false } });
  assert.equal(running.legend, 'STOP');
  assert.equal(running.glyph, 'stop');
  assert.equal(running.on, true);
  assert.equal(running.disabled, false, 'a press stops the run');
  assert.deepEqual(running.progress, { kind: 'pending' }, 'the dashboard reports no percentage here, so the foot pulses');
  assert.equal(running.label, 'Stop the Underfit training run "drums-lora"');
  assert.equal(
    face({ ...tab, trainingRun: { name: 'drums-lora', others: 2, stopping: false } }).label,
    'Stop the Underfit training run "drums-lora"; 2 other runs keep training',
  );
  assert.match(face({ ...tab, trainingRun: { name: 'a', others: 1, stopping: false } }).label, /; 1 other run keeps training$/);

  const stopping = face({ ...tab, trainingRun: { name: 'drums-lora', others: 0, stopping: true } });
  assert.equal(stopping.legend, 'STOP');
  assert.equal(stopping.on && stopping.disabled, true, 'busy while the kill is out, so a second press sends nothing');
  assert.equal(stopping.label, 'Stop the Underfit training run "drums-lora": stopping…');

  assert.equal(face({ ...tab, lastRunName: 'drums-lora' }).legend, 'TRAIN', 'the killed run leaves the key');
}

// (g) EDIT: a running process cannot be started again, so the key is busy and
// latched; while MIX's chain renders it waits, unlatched.
{
  const running = face({ ...IDLE, centerTab: 'edit', isProcessing: true });
  assert.equal(running.legend, 'PROCESS');
  assert.equal(running.on, true);
  assert.equal(running.disabled, true, 'a press while processing does nothing');
  assert.deepEqual(running.progress, { kind: 'pending' });
  assert.equal(running.progressText, null);
  assert.equal(running.label, 'Process audio: processing…');

  const waiting = face({ ...IDLE, centerTab: 'edit', isChainProcessing: true });
  assert.equal(waiting.legend, 'PROCESS');
  assert.equal(waiting.disabled, true);
  assert.equal(waiting.on, false);
  assert.equal(waiting.label, 'Process audio: waiting for the MIX chain to finish');
}

// (h) MIX: the chain run latches the key, makes it busy and pulses its foot;
// while EDIT's process renders it waits, unlatched.
{
  const running = face({ ...IDLE, centerTab: 'mix', isChainProcessing: true });
  assert.equal(running.legend, 'CHAIN');
  assert.equal(running.on, true);
  assert.equal(running.disabled, true);
  assert.deepEqual(running.progress, { kind: 'pending' });
  assert.equal(running.label, 'Chain: processing the effect chain…');

  const waiting = face({ ...IDLE, centerTab: 'mix', isProcessing: true });
  assert.equal(waiting.legend, 'CHAIN');
  assert.equal(waiting.disabled, true);
  assert.equal(waiting.on, false);
  assert.equal(waiting.label, 'Chain: waiting for the EDIT process to finish');
}

// (h2) A chain run replayed in studioStore's order: isChainProcessing rises, then
// each stage raises and drops isProcessing. MIX holds its busy, latched CHAIN
// through every stage and gap; EDIT waits through all of it and never reads as
// its own run.
{
  const flags: Array<Pick<ActionKeyInput, 'isProcessing' | 'isChainProcessing'>> = [
    { isChainProcessing: true, isProcessing: false },
    { isChainProcessing: true, isProcessing: true },
    { isChainProcessing: true, isProcessing: false },
    { isChainProcessing: true, isProcessing: true },
    { isChainProcessing: true, isProcessing: false },
  ];
  for (const [i, f] of flags.entries()) {
    const mix = face({ ...IDLE, ...f, centerTab: 'mix' });
    assert.equal(mix.label, 'Chain: processing the effect chain…', `stage ${i}: MIX holds its run`);
    assert.equal(mix.on && mix.disabled, true);
    const edit = face({ ...IDLE, ...f, centerTab: 'edit' });
    assert.equal(edit.label, 'Process audio: waiting for the MIX chain to finish', `stage ${i}: EDIT waits`);
    assert.equal(edit.on, false);
  }
  const done = { isChainProcessing: false, isProcessing: false };
  assert.equal(face({ ...IDLE, ...done, centerTab: 'mix' }).disabled, false, 'the chain done, CHAIN takes a press');
  assert.equal(face({ ...IDLE, ...done, centerTab: 'edit' }).disabled, false, 'the chain done, PROCESS takes a press');
}

// (i) A run belongs to its own workspace. Start a generation on MAKE, walk
// through the other action tabs, come back: each tab shows its own action at
// rest, and MAKE still shows the run.
{
  const generating = { ...IDLE, isGenerating: true, progressPct: 22, statusLabel: 'QUEUED...' };
  assert.equal(face(generating).legend, 'STOP');
  for (const [tab, legend] of [['edit', 'PROCESS'], ['underfit', 'TRAIN'], ['mix', 'CHAIN'], ['dj', 'SEND']] as const) {
    const f = face({ ...generating, centerTab: tab });
    assert.equal(f.legend, legend, `${tab} during a MAKE run`);
    assert.equal(f.on, false, `${tab} is not latched by a MAKE run`);
    assert.equal(f.disabled, face({ ...IDLE, centerTab: tab }).disabled, `${tab} is held exactly as it rests, never by a MAKE run`);
    assert.equal(f.progress, null, `${tab} carries no MAKE progress`);
    assert.equal(f.caption, null, `${tab} carries no MAKE caption`);
  }
  assert.equal(face({ ...generating, centerTab: 'vj' }).legend, 'STOP', 'VJ creates, so it shows the run');
  const others = face({ ...IDLE, isProcessing: true, trainingRun: { name: 'r', others: 0, stopping: false }, isChainProcessing: true });
  assert.equal(others.on, false, 'MAKE ignores the other runs');
  assert.equal(others.disabled, false, 'MAKE is not held by a studio run');
  assert.equal(others.progress, null, 'MAKE carries no other run progress');
}

// (j) DJ names where the set goes, whether or not a VJ tab is there to take it.
{
  assert.equal(face({ ...IDLE, centerTab: 'dj', vjTargetActive: true }).label, 'Send the active setlist to the VJ performance');
  assert.match(face({ ...IDLE, centerTab: 'dj', vjTargetActive: false }).label, /queued and delivers when the VJ tab opens/);
}

// (k) P0: CREATE's label never claims /api/generate-jobs for a cloud model —
// generateStore.submitGeneration routes Suno/Lyria elsewhere (or not at all).
{
  assert.equal(face({ ...IDLE, model: 'suno' }).label, 'Create: submit to Suno (its own render queue)');
  assert.doesNotMatch(face({ ...IDLE, model: 'suno' }).label, /generate-jobs/);
  assert.equal(
    face({ ...IDLE, model: 'lyria' }).label,
    'Create: use the controls inside the Lyria tab — this key has no route into it',
  );
  assert.doesNotMatch(face({ ...IDLE, model: 'lyria' }).label, /generate-jobs/);
  // generateStore never sets isGenerating for a cloud model (there is no
  // pollable job), so this combination cannot happen in the running app; it
  // only pins the branch order (the sunoSubmitting busy check runs first).
  assert.equal(face({ ...IDLE, model: 'suno', isGenerating: true }).legend, 'STOP');
}

// (l) A Suno submit in flight (sunoStore.submitting) has no job to cancel, so
// the key must NOT read STOP (a press there implies "abort the run") — it
// renders busy/disabled instead.
{
  const f = face({ ...IDLE, model: 'suno', sunoSubmitting: true });
  assert.equal(f.legend, 'CREATE', 'never STOP — a Suno submit cannot be cancelled from the footer');
  assert.notEqual(f.glyph, 'stop');
  assert.equal(f.disabled, true);
  assert.equal(f.on, true);
  assert.match(f.label, /Suno/i);
  assert.equal(f.caption?.tone, 'running');
  // isGenerating: true alongside it changes nothing — the Suno busy check
  // runs before the isGenerating/STOP branch.
  assert.equal(face({ ...IDLE, model: 'suno', sunoSubmitting: true, isGenerating: true }).legend, 'CREATE');
  // sunoSubmitting only means something for model 'suno': Lyria and local
  // models ignore it (it can never actually be true for them in the app).
  assert.equal(face({ ...IDLE, model: 'lyria', sunoSubmitting: true }).legend, 'CREATE');
  assert.doesNotMatch(face({ ...IDLE, model: 'lyria', sunoSubmitting: true }).label, /Suno/i);
  assert.equal(face({ ...IDLE, model: 'small', sunoSubmitting: true }).legend, 'CREATE');
  assert.equal(face({ ...IDLE, model: 'small', sunoSubmitting: true }).disabled, false);
}

console.log('actionKeyFace: all assertions passed');
