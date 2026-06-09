// theDAW launch-video capture — ONE warm session.
//
// Boots the app ONCE in a single headed (real-GPU) page, loads the hero audio /
// stems / decks ONCE, then clicks + drives the Zustand stores tab-by-tab through
// every scene while recording one continuous video. Each scene's stable hold is
// timestamped, and the long recording is sliced into per-scene clips afterward.
//
// Why one session: spawning a fresh context per shot re-runs the boot splash and
// congests the single-worker backend (the splash then bleeds into the clip). With
// the app already loaded and isBackendReady already true, switching tabs via the
// store never re-raises the splash — including the TRAIN tab, which always splashed
// under cold per-shot capture.
//
// Run from frontend/:  node _capture_clips.mjs        (all scenes)
//                      ONLY=20_train,02_dj-console node _capture_clips.mjs
// Output: showcase/clips-recorded/<id>_h.mp4  (+ the raw session webm, kept for re-slicing)
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const APP = 'http://localhost:5173';
const OUT = path.resolve(process.cwd(), '..', 'showcase', 'clips-recorded');
fs.mkdirSync(OUT, { recursive: true });

const HERO = {
  heroUrl: '/api/library/audio/62a72211-bfa6-490b-8a06-b87031578b67_00',
  heroLabel: 'Dark-Wave Outrun Dubstep',
  heroId: '62a72211-bfa6-490b-8a06-b87031578b67_00',
};
const DECK_B = { url: '/api/library/audio/81a3d137-2b6f-44fe-9e49-0f540d6ec3fc_00', label: 'Dark-Wave II' };
const STEM_BASE = '2d196d72-edc4-4ab2-bccc-35721ad73fe0_00';
const STEMS = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'].map((n) => ({
  name: n, url: `/api/library/stems/${STEM_BASE}__${n}/audio`,
}));

// Full coverage: every tab + every feature. Bottom-panel features are MAXIMIZED so
// the feature fills the work area (the MAKE chrome + chimera orbs are hidden), and
// the library is collapsed unless the scene is the catalogue itself. Lineage goes
// fullscreen. Order groups by tab so the warm page transitions cleanly.
const SCENES = [
  // ── MAKE: generation + every sub-feature ──
  { id: '08_make',           tab: 'make',  play: true,  hold: 6 },
  { id: '23_chimera',        tab: 'make',  play: false, chimeraBuild: true, hold: 6 },
  { id: '21_inpaint',        tab: 'make',  play: false, inpaint: true, hold: 6 },
  { id: '25_init-audio',     tab: 'make',  play: false, initAudio: true, hold: 6 },
  { id: '27_lora',           tab: 'make',  play: false, lora: true, hold: 6 },
  { id: '30_compare',        tab: 'make',  play: false, compare: true, hold: 6 },
  { id: '45_saved-prompts',  tab: 'make',  play: false, savedPrompts: true, hold: 6 },
  // ── EDIT: the multitrack editor in depth ──
  { id: '03_edit-stems',     tab: 'edit',  play: true,  buildStems: true, hold: 6 },
  { id: '31_edit-mix',       tab: 'edit',  play: true,  buildStems: true, editMix: true, hold: 6 },
  { id: '22_cut-edit',       tab: 'edit',  play: false, buildStems: true, cutEdit: true, hold: 6 },
  { id: '40_inpaint-region', tab: 'edit',  play: false, buildStems: true, inpaintRegion: true, hold: 6 },
  { id: '41_delete-clip',    tab: 'edit',  play: false, buildStems: true, deleteClip: true, hold: 6 },
  // ── MIX: effects browser + populated chain + the drag-to-arrange UI editor ──
  { id: '07_mix-effects',    tab: 'mix',   play: true,  studioSource: true, hold: 6 },
  { id: '32_mix-chain',      tab: 'mix',   play: true,  studioSource: true, mixChain: true, hold: 6 },
  { id: '39_design-mode',    tab: 'mix',   play: false, studioSource: true, designMode: true, hold: 7 },
  // ── DJ: console + sampler/side-list staged ──
  { id: '02_dj-console',     tab: 'dj',    play: true,  djDecks: true, levelAnim: true, hold: 7 },
  { id: '33_dj-sampler',     tab: 'dj',    play: true,  djDecks: true, djSampler: true, hold: 6 },
  // ── VJ / TRAIN ──
  { id: '19_vj-visualizer',  tab: 'vj',    play: true,  vjClip: true, vjTour: true, hold: 12 },
  { id: '20_train',          tab: 'train', play: false, hold: 6 },
  // ── LEARN: 2D click-a-node, 3D fly-around, per-track lineage ──
  { id: '01a_learn-2d-hero', tab: 'learn', play: false, learn: '2d', lineageFull: true, lineageHover: true, hold: 48 },
  { id: '01b_learn-3d-hero', tab: 'learn', play: false, learn: '3d', lineageFull: true, flyAround: true, hold: 13 },
  { id: '48_galaxy-preset',  tab: 'learn', play: false, learn: '3d', lineageFull: true, vizPreset: 'constellation', flyAround: true, hold: 11 },
  // ── bottom-panel features, each MAXIMIZED into a fullscreen hero ──
  { id: '04_visualize',      tab: 'make',  play: true,  bottomTab: 'spectral',   maximizePanel: true, hold: 6 },
  { id: '15_analyzer-scope', tab: 'make',  play: true,  bottomTab: 'spectral',   maximizePanel: true, modeBtn: 'Oscilloscope', hold: 6 },
  { id: '16_analyzer-radial',tab: 'make',  play: true,  bottomTab: 'spectral',   maximizePanel: true, modeBtn: 'Radial', hold: 6 },
  { id: '05_sequencer',      tab: 'make',  play: false, bottomTab: 'step-seq',   maximizePanel: true, seqFill: true, hold: 7 },
  { id: '06_piano-roll',     tab: 'make',  play: false, bottomTab: 'piano-roll', maximizePanel: true, pianoFill: true, sendToEditor: true, hold: 7 },
  { id: '12_slide-surface',  tab: 'make',  play: true,  bottomTab: 'slide',      maximizePanel: true, dragFader: true, hold: 7 },
  { id: '24_focus',          tab: 'make',  play: true,  bottomTab: 'slide',      maximizePanel: true, slideView: 'focus', hold: 6 },
  { id: '17_controller',     tab: 'make',  play: false, bottomTab: 'slide',      maximizePanel: true, slideView: 'controller', hold: 6 },
  { id: '18_media-bucket',   tab: 'make',  play: false, bottomTab: 'bucket',     maximizePanel: true, fillBucket: true, hold: 6 },
  { id: '44_url-import',     tab: 'make',  play: false, bottomTab: 'bucket',     maximizePanel: true, fillBucket: true, urlImport: true, hold: 6 },
  { id: '13_details',        tab: 'make',  play: false, bottomTab: 'details',    maximizePanel: true, detailsTrack: true, hold: 6 },
  // ── overlays / cloud / library actions / global chrome ──
  { id: '11_assistant-orb',  tab: 'make',  play: false, openOrb: true, hold: 6 },
  { id: '14_catalogue',      tab: 'make',  play: false, catalogue: true, scrollList: true, hold: 7 },
  { id: '42_lib-actions',    tab: 'make',  play: false, catalogue: true, libContext: true, hold: 6 },
  { id: '43_stems-modal',    tab: 'make',  play: false, catalogue: true, stemsModal: true, hold: 6 },
  { id: '10_suno-cloud',     tab: 'make',  play: false, sunoModel: true, hold: 6 },
  { id: '36_log',            tab: 'make',  play: true,  logPanel: true, hold: 5 },
  { id: '37_docs',           tab: 'make',  play: false, docsModal: true, hold: 6 },
  { id: '38_settings',       tab: 'make',  play: false, settingsModal: true, hold: 6 },
];

const SIZE = { width: 1920, height: 1080 };

// Per-scene store driving. Heavy one-time builds (hero/stems/decks/studio/bucket)
// are guarded by window.__cap so they run once across the whole session. Every other
// piece of state is set explicitly each scene so nothing bleeds in from the last one.
async function applyScene(spec) {
  const log = [];
  const imp = (p) => import(p);
  const C = (window.__cap = window.__cap || {});
  const appUi = (await imp('/src/state/appUiStore.ts')).useAppUiStore;
  const lib = (await imp('/src/state/libraryStore.ts')).useLibraryStore;
  const pMod = await imp('/src/state/playerStore.ts');
  const player = pMod.usePlayerStore;
  const edMod = await imp('/src/state/editorStore.ts');
  const editor = edMod.useEditorStore;
  const computePeaks = edMod.computePeaks;
  const bp = (await imp('/src/state/bottomPanelStore.ts')).useBottomPanelStore;

  // ── one-time: library + hero audio (kept playing the whole session) ──
  if (!C.heroLoaded) {
    try { if (lib.getState().entries.length === 0) await lib.getState().load(); } catch (e) { log.push('lib ' + e.message); }
    try { const c = pMod.getEngineCtx && pMod.getEngineCtx(); if (c && c.resume) await c.resume(); } catch (e) {}
    try {
      const blob = await (await fetch(spec.heroUrl)).blob();
      await player.getState().load(blob, { label: spec.heroLabel, entryId: spec.heroId });
      C.heroLoaded = true;
    } catch (e) { log.push('hero ' + e.message); }
  }
  try { if (!player.getState().isPlaying) player.getState().play(); } catch (e) {}

  // ── one-time heavy builds, triggered the first time their scene arrives ──
  if (spec.buildStems && !C.stemsBuilt) {
    let first = true;
    for (const s of spec.stems) {
      try {
        const blob = await (await fetch(s.url)).blob();
        const { peaks, duration } = await computePeaks(blob, 240);
        const tracks = editor.getState().tracks;
        let trackId;
        if (first && tracks.length && editor.getState().clips.filter((c) => c.trackId === tracks[0].id).length === 0) trackId = tracks[0].id;
        else trackId = editor.getState().addTrack({ name: s.name });
        first = false;
        const color = (editor.getState().tracks.find((t) => t.id === trackId) || {}).color || '#8b5cf6';
        const clipId = editor.getState().addClipToTrack({ trackId, label: s.name, audioBlob: blob, mimeType: 'audio/wav', sourceDuration: duration, offsetIntoSource: 0, durationSec: duration, startSec: 0, color });
        editor.getState().cachePeaks(clipId, peaks);
      } catch (e) { log.push('stem ' + s.name + ' ' + e.message); }
    }
    C.stemsBuilt = true;
  }
  if (spec.djDecks && !C.decksLoaded) {
    try {
      const dj = await imp('/src/state/djEngine.ts');
      await dj.loadDeck('A', spec.heroUrl, spec.heroLabel);
      await dj.loadDeck('B', spec.deckB.url, spec.deckB.label);
      for (const fn of ['play', 'playDeck', 'startDeck', 'togglePlay']) { try { if (typeof dj[fn] === 'function') { dj[fn]('A'); dj[fn]('B'); break; } } catch (e) {} }
      C.decksLoaded = true;
    } catch (e) { log.push('dj ' + e.message); }
  }
  if (spec.studioSource && !C.studioSet) {
    try {
      const studio = (await imp('/src/state/studioStore.ts')).useStudioStore;
      const blob = await (await fetch(spec.heroUrl)).blob();
      studio.getState().setSourceFile(new File([blob], 'hero.wav', { type: 'audio/wav' }));
      C.studioSet = true;
    } catch (e) { log.push('studio ' + e.message); }
  }
  if (spec.fillBucket && !C.bucketFilled) {
    try { const mb = (await imp('/src/state/mediaBucketStore.ts')).useMediaBucketStore; const b = await (await fetch(spec.heroUrl)).blob(); mb.getState().add(new File([b], 'Dark-Wave.wav', { type: 'audio/wav' })); C.bucketFilled = true; } catch (e) { log.push('bucket ' + e.message); }
  }

  // ── per-scene UI state (fully specified every time) ──
  if (spec.bottomTab) bp.setState({ activeTab: spec.bottomTab, isOpen: true, multiMaximized: !!spec.maximizePanel, multiHeight: Math.max(380, bp.getState().multiHeight || 0) });
  else bp.setState({ isOpen: false, multiMaximized: false });

  try { appUi.getState().setLibraryExpanded(!!spec.catalogue); } catch (e) {}

  try {
    const gp = (await imp('/src/state/generateParamsStore.ts')).useGenerateParamsStore;
    gp.getState().setField('model', spec.sunoModel ? 'suno' : 'medium');
    if (!C.srcFile) { const b = await (await fetch(spec.heroUrl)).blob(); C.srcFile = new File([b], 'source.wav', { type: 'audio/wav' }); }
    if (spec.inpaint) {
      gp.getState().setField('initAudioFile', C.srcFile);
      gp.getState().setField('inpaintAudioFile', C.srcFile);
      gp.getState().setField('inpaintEnabled', true);
    } else if (spec.initAudio) {
      gp.getState().setField('initAudioFile', C.srcFile);
      gp.getState().setField('initAudioEnabled', true);
      gp.getState().setField('inpaintEnabled', false);
    } else {
      gp.getState().setField('inpaintEnabled', false);
    }
    // Build a CHIMERA stack — fold the hero + two stems into 3 chimera tracks.
    if (spec.chimeraBuild && !C.chimeraBuilt) {
      const srcs = [{ u: spec.heroUrl, l: 'Dark-Wave Outrun' }, { u: spec.stems[0].url, l: 'Drums' }, { u: spec.stems[2].url, l: 'Vocals' }];
      for (const s of srcs) { try { const b = await (await fetch(s.u)).blob(); gp.getState().addChimeraClip({ blob: b, mimeType: 'audio/wav', label: s.l }); } catch (e) { log.push('chimera ' + e.message); } }
      try { gp.getState().setChimeraField('targetBpm', 124); gp.getState().setChimeraField('alignMode', 'weave'); } catch (e) {}
      C.chimeraBuilt = true;
    } else if (!spec.chimeraBuild) {
      try { if (gp.getState().chimera.clips.length) gp.getState().clearChimera(); } catch (e) {}
    }
  } catch (e) {}

  // EDIT mixing: solo/mute/pan the stems so the per-track faders read as a live mix.
  try {
    if (spec.editMix) {
      const ts = editor.getState().tracks;
      if (ts[0]) editor.getState().updateTrack(ts[0].id, { volume: 0.9, pan: -0.4 });
      if (ts[2]) editor.getState().toggleSolo(ts[2].id);
      if (ts[4]) editor.getState().updateTrack(ts[4].id, { mute: true });
      if (ts[1]) editor.getState().updateTrack(ts[1].id, { pan: 0.5, volume: 0.7 });
    }
  } catch (e) { log.push('editmix ' + e.message); }

  // MIX: stack a real processing chain so the chain column shows live modules.
  try {
    const ec = (await imp('/src/state/effectChainStore.ts')).useEffectChainStore;
    if (spec.mixChain && !C.mixChained) {
      for (const fx of ['mastering_chain', 'reverb_delay', 'sub_exciter', 'stereo_widener', 'compression', 'lofi_vinyl']) ec.getState().addEffect(fx);
      C.mixChained = true;
    } else if (!spec.mixChain) {
      try { if (ec.getState().chain.length) ec.getState().clearChain(); } catch (e) {}
    }
  } catch (e) { log.push('mixchain ' + e.message); }

  // DJ: load the sampler bank + stage tracks in the side list.
  try {
    if (spec.djSampler && !C.djStaged) {
      const samp = (await imp('/src/state/djSamplerStore.ts')).useDjSampler;
      const labels = ['Kick', 'Snare', 'Hat', 'Stab', 'Vox', 'FX'];
      for (let i = 0; i < labels.length; i++) { try { samp.getState().setPad(i, { entryId: spec.heroId, name: labels[i] }); } catch (e) {} }
      try { const sl = (await imp('/src/state/djSideListStore.ts')).useDjSideList; sl.getState().add({ entryId: spec.deckB.url, label: 'Dark-Wave II' }); sl.getState().add({ entryId: spec.heroId, label: 'Outrun Dubstep' }); } catch (e) {}
      C.djStaged = true;
    }
  } catch (e) { log.push('djsamp ' + e.message); }

  // Global chrome: LOG dock, DOCS modal, SETTINGS modal.
  try { bp.setState({ isLogOpen: !!spec.logPanel }); } catch (e) {}
  try { appUi.getState().setDocsOpen(!!spec.docsModal); } catch (e) {}
  if (spec.settingsModal) { try { window.dispatchEvent(new Event('stabledaw:open-settings')); } catch (e) {} }

  // EDIT cut/razor: switch to the cut tool and make SEVERAL real splits across stems so
  // it reads as a track actively being chopped up.
  try {
    if (spec.cutEdit) {
      editor.getState().setTool('cut');
      if (!C.didCut) {
        const clips = editor.getState().clips.slice();
        const fracs = [0.25, 0.5, 0.7];
        for (let i = 0; i < Math.min(4, clips.length); i++) {
          const c = clips[i];
          const f = fracs[i % fracs.length];
          try { editor.getState().splitClipAt(c.id, c.startSec + c.durationSec * f); } catch (e) {}
        }
        C.didCut = true;
      }
    } else {
      editor.getState().setTool('move');
    }
  } catch (e) { log.push('cut ' + e.message); }

  // PIANO ROLL: replace the seed with a dense, longer melody and start it playing so the
  // grid is full and the playhead moves.
  try {
    if (spec.pianoFill) {
      const piano = (await imp('/src/state/pianoRollStore.ts')).usePianoRollStore;
      piano.getState().setTotalSteps(64);
      const scale = [60, 62, 63, 65, 67, 68, 70, 72]; // C minor-ish, two octaves of motion
      const notes = [];
      for (let step = 0; step < 64; step += 2) {
        const n = scale[(step / 2) % scale.length];
        notes.push({ note: n, step, length: 2, velocity: 80 + (step % 5) * 6 });
        if (step % 4 === 0) notes.push({ note: n - 12, step, length: 4, velocity: 70 }); // bass line
        if (step % 8 === 0) notes.push({ note: n + 7, step, length: 2, velocity: 64 });  // harmony
      }
      piano.getState().replaceAll(notes.map((x) => ({ ...x })));
      piano.getState().setPlaying(true);
    }
  } catch (e) { log.push('piano ' + e.message); }

  // EDIT paintbrush INPAINT region + DELETE-from-timeline.
  try {
    if (spec.inpaintRegion) {
      const c = editor.getState().clips[0];
      if (c) { editor.getState().setInpaintSelection({ clipId: c.id, startSec: c.startSec + c.durationSec * 0.3, endSec: c.startSec + c.durationSec * 0.62 }); editor.getState().setSelected(c.id); }
    } else { try { editor.getState().clearInpaintSelection(); } catch (e) {} }
    if (spec.deleteClip && !C.didDelete) {
      const c = editor.getState().clips[0];
      if (c) { const rid = editor.getState().splitClipAt(c.id, c.startSec + c.durationSec * 0.5); if (rid) editor.getState().removeClip(rid); }
      C.didDelete = true;
    }
  } catch (e) { log.push('editops ' + e.message); }

  try {
    const ss = (await imp('/src/state/slideStore.ts')).useSlideStore;
    ss.getState().setView(spec.slideView || 'row');
  } catch (e) {}

  try { lib.getState().setSelectedEntry((spec.detailsTrack || spec.libContext) ? spec.heroId : null); } catch (e) {}

  if (spec.tab) appUi.getState().setCenterTab(spec.tab);
  await new Promise((r) => setTimeout(r, 250));
  return { tracks: editor.getState().tracks.length, clips: editor.getState().clips.length, playing: player.getState().isPlaying, log };
}

const onlyIds = (process.env.ONLY || '').split(',').filter(Boolean);
const VJ_SOURCE = path.join(OUT, '_vjsource.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickByTitle = (page, re) => page.evaluate((src) => { const rx = new RegExp(src, 'i'); const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.getAttribute('title') || '')); if (b) b.click(); }, re.source).catch(() => {});
const clickByText = (page, re) => page.evaluate((src) => { const rx = new RegExp(src, 'i'); const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent || '')); if (b) b.click(); }, re.source).catch(() => {});

const waitSplashGone = (page) => page.waitForFunction(() => {
  // LoadingScreen unmounts (AnimatePresence) once the backend is ready; it is the only
  // overlay carrying the "Stable Audio 3" wordmark. Test DOM PRESENCE, not offsetParent
  // — position:fixed elements always report offsetParent === null, so the old check
  // resolved instantly and the splash bled into the first clip.
  return ![...document.querySelectorAll('.fixed.inset-0')].some((e) => /Stable Audio 3/i.test(e.textContent || ''));
}, { timeout: 45000 }).catch(() => {});

// Per-scene DOM choreography that the stores can't do (graph fullscreen, analyzer
// mode buttons, the assistant orb, the VJ source import). Runs after the view mounts.
async function sceneActions(page, scene) {
  let err = null;
  if (scene.learn === '2d') {
    await clickByText(page, /genealogy/i);
    // Wait for the family-tree to actually finish loading (nodes present), not just a
    // fixed delay — the graph fetch can lag and otherwise we capture "Loading lineage…".
    await page.waitForFunction(() => {
      let n = 0;
      for (const g of document.querySelectorAll('svg g')) { const r = g.getBoundingClientRect(); if (r.width > 0 && r.width < 360 && r.height > 0 && r.height < 280) n++; }
      return n > 20;
    }, { timeout: 18000 }).catch(() => {});
    await sleep(1200);
    if (scene.lineageFull) { await clickByTitle(page, /full screen/i); await sleep(1500); }
    try {
      // The app lights a node's FULL lineage on HOVER (opacity 1 for the lineage, 0.12 for
      // the rest). Probe each node box — hover it, count how many boxes stay bright — to
      // rank nodes by lineage size, then keep the densest handful to hover during the hold.
      const boxes = await page.evaluate(() => {
        const out = [];
        for (const g of document.querySelectorAll('svg g')) {
          const r = g.getBoundingClientRect();
          if (r.width > 40 && r.width < 360 && r.height > 20 && r.height < 280) out.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
        }
        return out;
      });
      const scored = [];
      for (const b of boxes.slice(0, 90)) {
        await page.mouse.move(b.cx, b.cy); await sleep(60);
        const lit = await page.evaluate(() => { let n = 0; for (const g of document.querySelectorAll('svg g')) { if (parseFloat(getComputedStyle(g).opacity || '1') > 0.5) n++; } return n; });
        scored.push({ b, lit });
      }
      // When hovering, lit-count = the lineage size of that node. Densest = most lit.
      scored.sort((a, b) => b.lit - a.lit);
      const picks = [];
      for (const s of scored) { if (picks.every((p) => Math.hypot(p.cx - s.b.cx, p.cy - s.b.cy) > 60)) picks.push(s.b); if (picks.length >= 6) break; }
      scene._targets = picks;
      await page.mouse.move(960, 230);
      if (!picks.length) err = '2d:no-nodes';
    } catch (e) { err = '2d:' + e.message; }
  } else if (scene.learn === '3d') {
    await clickByText(page, /3d\s*graph/i);
    if (scene.lineageFull) { await clickByTitle(page, /full screen/i); await sleep(1400); }
    // No search, no refresh — just let the galaxy render; the fly-around happens during
    // the hold (see flyAround3d).
    await page.waitForSelector('#lineage-graph-search', { timeout: 12000 }).catch(() => {});
    await sleep(2200);
  } else if (scene.learn === 'track') {
    // per-track lineage: the Track tab shows the selected entry's ancestors + descendants
    await clickByText(page, /^\s*track\s*$/i); await sleep(1600);
    if (scene.lineageFull) { await clickByTitle(page, /full screen/i); await sleep(1200); }
    await sleep(1500);
  }
  if (scene.lora) { await clickByText(page, /^\s*lora\b/i); await sleep(800); }
  if (scene.compare) { await clickByText(page, /\bcompare\b/i); await sleep(800); }
  if (scene.savedPrompts) { await clickByText(page, /saved\s*\(/i); await sleep(900); }
  if (scene.designMode) { await clickByText(page, /edit layout/i); await sleep(1600); }
  if (scene.urlImport) {
    try { await page.fill('input[placeholder*="YouTube" i]', 'https://www.youtube.com/watch?v=2Vv-BfVoq4g'); } catch (e) { err = (err || '') + ' url:' + e.message; }
    await sleep(700);
  }
  if (scene.stemsModal) {
    // right-click a catalogue row → "Separate stems…" opens the modal (we don't run it)
    try {
      await page.mouse.click(360, 110, { button: 'right' }); await sleep(700);
      await clickByText(page, /separate stems/i); await sleep(1200);
    } catch (e) { err = (err || '') + ' stems:' + e.message; }
  }
  if (scene.vizPreset) {
    // open the 3D appearance drawer and pick a vivid preset (galaxy / constellation …)
    await clickByTitle(page, /appearance/i); await sleep(900);
    await page.evaluate((preset) => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === preset));
      if (sel) { sel.value = preset; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }, scene.vizPreset).catch(() => {});
    await sleep(1500);
  }
  if (scene.modeBtn) {
    await page.evaluate((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '') === t || (x.textContent || '').trim() === t[0]); if (b) b.click(); }, scene.modeBtn).catch(() => {});
    await sleep(700);
  }
  if (scene.openOrb) {
    try { await page.click('[aria-label="Toggle orb panel"]', { timeout: 3500 }); } catch (e) { err = (err || '') + ' orb:' + e.message; }
    try { await page.waitForSelector('input[placeholder="Ask anything..."]', { timeout: 4000 }); await page.fill('input[placeholder="Ask anything..."]', 'lo-fi boom bap, dusty rhodes chords, vinyl crackle, 84 bpm'); } catch (e) {}
    await sleep(700);
  }
  if (scene.seqFill) {
    // fill the step grid (RANDOM), add voices, and start it playing → no empty tracks
    await clickByTitle(page, /add track/i); await sleep(300);
    await clickByTitle(page, /add track/i); await sleep(300);
    await clickByTitle(page, /randomize all step/i); await sleep(400);
    await clickByTitle(page, /^\s*play\s*$/i); await sleep(300);
  }
  if (scene.sendToEditor) { await clickByText(page, /send to editor/i); await sleep(500); }
  if (scene.vjClip) {
    try {
      await clickByText(page, /import video|select.*video|video clip/i); await sleep(1600);
      await clickByText(page, /\bMEM\b/i); await sleep(800);
    } catch (e) { err = (err || '') + ' vj:' + e.message; }
    await sleep(1000);
  }
  return err;
}

// Walk the VJ control surface: cycle canvas formats + toggle every geometry / feedback /
// performance option so the whole rig is shown working, not a static panel.
async function vjTour(page, seconds) {
  const t0 = Date.now();
  const groups = [
    ['16:9', '4:3', '9:16', '1:1', '21:9', 'FREE'],
    ['MIRROR X', 'MIRROR Y', 'KALEIDO', 'SOFT EDGES', 'HDR', 'FB IO'],
    ['RADIAL', 'GRID', 'FEEDBACK', 'STROBE', 'CORRUPT'],
    ['HIGH', 'MED', 'LOW'],
  ];
  let gi = 0;
  while ((Date.now() - t0) / 1000 < seconds) {
    const g = groups[gi % groups.length];
    for (const label of g) {
      await page.evaluate((s) => { const rx = new RegExp(s, 'i'); const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent || '')); if (b) b.click(); }, label).catch(() => {});
      await sleep(260);
      if ((Date.now() - t0) / 1000 >= seconds) break;
    }
    gi++;
  }
}

// Undo cross-tab overlays so the next scene is clean (lineage fullscreen unmounts with
// the tab; the assistant orb is global and must be toggled back off).
async function sceneCleanup(page, scene) {
  if (scene.openOrb) { try { await page.click('[aria-label="Toggle orb panel"]', { timeout: 1500 }); } catch (e) {} await sleep(250); }
  if (scene.settingsModal || scene.docsModal) { try { await page.keyboard.press('Escape'); } catch (e) {} await sleep(250); }
}

// Slow, continuous drag over the 3D canvas → OrbitControls orbits the galaxy. Runs for
// the whole hold so the recorded window is a live fly-around, not a static frame.
async function flyAround3d(page, seconds) {
  const cx = 960, cy = 540;
  const t0 = Date.now();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  let i = 0;
  while ((Date.now() - t0) / 1000 < seconds) {
    const a = i * 0.22;
    await page.mouse.move(cx + Math.cos(a) * 300, cy + Math.sin(a) * 150, { steps: 10 });
    await sleep(110);
    i++;
  }
  await page.mouse.up();
}

// What happens DURING a scene's hold. Most scenes just sit (audio-reactive meters keep
// moving); the interactive ones drive their controls so the whole rig is shown working.
async function holdAction(page, scene) {
  const secs = scene.hold;
  const t0 = Date.now();
  if (scene.flyAround) return flyAround3d(page, secs);
  if (scene.vjTour) return vjTour(page, secs);
  if (scene.lineageHover) {
    // Hover the densest nodes one at a time; each lights its full family tree. ~equal time
    // per node so the recording walks through several big lineages.
    const tg = scene._targets || [];
    if (!tg.length) { await sleep(secs * 1000); return; }
    const per = secs / tg.length;
    for (const t of tg) {
      await page.mouse.move(960, 230); await sleep(150);
      await page.mouse.move(t.cx, t.cy);
      await sleep(Math.max(500, per * 1000 - 150));
    }
    return;
  }
  if (scene.levelAnim) {
    // Full DJ workout — sweep the crossfader + both decks' EQ / filter / pitch so every
    // knob and fader on the console is visibly moving.
    while ((Date.now() - t0) / 1000 < secs) {
      const p = (Date.now() - t0) / 1000;
      await page.evaluate(async (ph) => {
        try {
          const dj = await import('/src/state/djEngine.ts');
          dj.setCrossfade && dj.setCrossfade(Math.sin(ph * 1.1));
          if (dj.setDeckEq) { dj.setDeckEq('A', 'low', Math.sin(ph) * 12); dj.setDeckEq('A', 'mid', Math.cos(ph * 1.3) * 9); dj.setDeckEq('A', 'high', Math.sin(ph * 0.8) * 12); dj.setDeckEq('B', 'low', Math.cos(ph) * 12); dj.setDeckEq('B', 'high', Math.sin(ph * 1.2) * 12); }
          if (dj.setDeckFilter) { dj.setDeckFilter('A', Math.sin(ph * 0.7) * 0.7); dj.setDeckFilter('B', Math.cos(ph * 0.9) * 0.7); }
          if (dj.setDeckPitch) { dj.setDeckPitch('A', Math.sin(ph) * 6); dj.setDeckPitch('B', Math.cos(ph) * 6); }
        } catch (e) {}
      }, p);
      await sleep(130);
    }
    await page.evaluate(async () => { try { const dj = await import('/src/state/djEngine.ts'); dj.setCrossfade && dj.setCrossfade(0); } catch (e) {} });
    return;
  }
  if (scene.dragFader) {
    // grab the maximised SLIDE capsule faders and ride them up/down
    const xs = [220, 470, 720, 970, 1220, 1470];
    while ((Date.now() - t0) / 1000 < secs) {
      for (const x of xs) {
        await page.mouse.move(x, 560); await page.mouse.down();
        await page.mouse.move(x, 460, { steps: 6 }); await page.mouse.move(x, 660, { steps: 6 }); await page.mouse.move(x, 540, { steps: 4 });
        await page.mouse.up();
        if ((Date.now() - t0) / 1000 >= secs) break;
      }
    }
    return;
  }
  if (scene.scrollList) {
    let down = true;
    await page.mouse.move(960, 400);
    while ((Date.now() - t0) / 1000 < secs) { await page.mouse.wheel(0, down ? 260 : -260); await sleep(380); if (((Date.now() - t0) / 1000) > secs * 0.6) down = false; }
    return;
  }
  await sleep(secs * 1000);
}

const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required', '--start-maximized'] });
const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: SIZE } });
const page = await ctx.newPage();
const tRec = Date.now();       // recording starts at context/page creation → this is video t=0.
                               // (Anchoring AFTER the splash wait shifts every slice earlier by
                               // the boot duration and lands scene 1 inside the splash.)
page.on('filechooser', (fc) => { fc.setFiles(VJ_SOURCE).catch(() => {}); });

const scenes = onlyIds.length ? SCENES.filter((s) => onlyIds.includes(s.id)) : SCENES;
const marks = [];
const results = [];

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await sleep(2600);
await waitSplashGone(page);    // the ONLY splash wait — once, up front
await page.mouse.click(8, 8);

for (const scene of scenes) {
  let info = null, err = null;
  try {
    info = await page.evaluate(applyScene, { ...HERO, deckB: DECK_B, stems: STEMS, ...scene });
    await sleep(1200);                       // let the tab transition + view settle
    err = await sceneActions(page, scene);
    await sleep(500);
    const start = (Date.now() - tRec) / 1000; // stable-hold window begins here
    await holdAction(page, scene);
    const end = (Date.now() - tRec) / 1000;
    marks.push({ id: scene.id, start, end });
    await sceneCleanup(page, scene);
  } catch (e) { err = String(e).slice(0, 200); }
  results.push({ id: scene.id, info, err });
  console.log(`${scene.id}`, err ? ('ERR ' + err) : JSON.stringify(info));
}

const video = page.video();
await ctx.close();             // flush the recording
await browser.close();
const sessionWebm = path.join(OUT, '_session.webm');
try { const vp = await video.path(); fs.renameSync(vp, sessionWebm); } catch (e) { console.log('session rename', e.message); }

// Slice the one long recording into per-scene clips (trim the transition edges).
const { execFileSync } = await import('node:child_process');
for (const m of marks) {
  const ss = (m.start + 0.4).toFixed(2);
  const dur = Math.max(0.5, m.end - m.start - 0.6).toFixed(2);
  const out = path.join(OUT, `${m.id}_h.mp4`);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', ss, '-t', dur, '-i', sessionWebm,
      '-an', '-vf', 'scale=1920:1080,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
    console.log(`  sliced ${m.id}_h.mp4  (${dur}s @ ${ss}s)`);
  } catch (e) { console.log(`  slice FAIL ${m.id}`, e.message); }
}

fs.writeFileSync(path.join(OUT, '_capture-log.json'), JSON.stringify({ marks, results }, null, 2));
console.log('DONE ->', OUT);
