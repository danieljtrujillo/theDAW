/**
 * The DJ tab's control-surface default layout and the rev-1 column-order fix
 * for its saved layouts. Plain data, imported by DJView and by
 * state/surfaceLayoutStore.test.ts.
 */
import type { ColumnOrderFix, SurfaceLayout } from '../state/surfaceLayoutStore';

/* ═══ Control-surface default layout ═════════════════════════════════════════
 * Reproduces the console arrangement as a structured rows/columns tree. Pinned
 * panels (hero waveforms, sampler, FX racks, Next lane, source tree, library)
 * host a whole component; every mixer + deck control is an individual widget the
 * user can relocate in Design Mode. Nothing moves until the user drags.
 * A DJ_LAYOUT_VERSION bump replaces every saved DJ layout (and a saved default)
 * with this tree; a change saved layouts can carry goes in a LAYOUT_REV upgrade
 * in surfaceLayoutStore instead. */
export const DJ_LAYOUT_VERSION = 24;

export const defaultDjLayout: SurfaceLayout = {
  version: DJ_LAYOUT_VERSION,
  root: 'root',
  nodes: {
    root: { id: 'root', type: 'container', axis: 'column', children: ['topDecks', 'heroP', 'browserDock'], fr: { topDecks: 5.25, heroP: 1.45, browserDock: 3.45 } },
    topDecks: { id: 'topDecks', type: 'container', axis: 'row', children: ['deckAcont', 'mixer', 'deckBcont'], fr: { deckAcont: 4.25, mixer: 2.75, deckBcont: 4.25 } },
    heroP: { id: 'heroP', type: 'panel', title: 'Waveforms', flow: 'row', widgets: [], pinned: 'hero' },
    browserDock: { id: 'browserDock', type: 'container', axis: 'row', children: ['browserLeft', 'libraryP'], fr: { browserLeft: 2.45, libraryP: 9.6 }, framed: true, frameTitle: 'Browser' },
    browserLeft: { id: 'browserLeft', type: 'container', axis: 'column', children: ['sourceTreeP', 'nextP'], fr: { sourceTreeP: 3.4, nextP: 1.25 } },
    // Left/right rails equalized by default (samplerP == browser).
    body: { id: 'body', type: 'container', axis: 'row', children: ['samplerP', 'center', 'browser'], fr: { samplerP: 2.0, center: 14.963177570093462, browser: 2.0 } },
    samplerP: { id: 'samplerP', type: 'panel', title: 'Sampler', flow: 'row', widgets: [], pinned: 'sampler', uniform: false },
    center: { id: 'center', type: 'container', axis: 'column', children: ['deckmix', 'fxrow'], fr: { deckmix: 5, fxrow: 2 } },
    deckmix: { id: 'deckmix', type: 'container', axis: 'row', children: ['deckAcont', 'mixer', 'deckBcont'], fr: { deckAcont: 4.17953863997903, mixer: 5.180662235484642, deckBcont: 4.439799124536327 } },
    // ── Deck A (pad-rows wrapped with spacer panels in cont-* containers) ──
    deckAcont: { id: 'deckAcont', type: 'container', axis: 'column', children: ['pdA-head', 'waveAOverview', 'cont-10-e11250c4', 'cont-A-transport', 'cont-A-stems', 'fxAP', 'perfAP'], fr: { 'pdA-head': 1.12, waveAOverview: 0.72, 'cont-10-e11250c4': 4.9, 'cont-A-transport': 1.02, 'cont-A-stems': 1.1, fxAP: 3.15, perfAP: 1.35 }, framed: true },
    'pdA-head': { id: 'pdA-head', type: 'panel', title: 'A', flow: 'row', widgets: ['spacer:s-2-7f6f8905', 'keylockA', 'keyA', 'bpmA', 'headerA'], widgetFr: { keylockA: 0.49871465295629847, keyA: 0.8892624085426142, bpmA: 0.8514435436029266, headerA: 2.255932370970932, 'spacer:s-2-7f6f8905': 0.8892624085426142 }, widgetJustify: { headerA: 'start' }, widgetMargins: { 'spacer:s-2-7f6f8905': { t: 0, r: 8, b: 0, l: 0 } }, mirror: false, uniform: false },
    'pdA-jog': { id: 'pdA-jog', type: 'panel', title: 'A · Jog', flow: 'row', widgets: ['jogA'], widgetMargins: { jogA: { t: 1, r: 4, b: 3, l: 4 } }, mirror: true },
    'pdA-mode': { id: 'pdA-mode', type: 'panel', title: 'A · Mode', flow: 'column', widgets: ['syncLockA', 'headCueA'], mirror: true, uniform: true },
    'pdA-trans': { id: 'pdA-trans', type: 'panel', title: 'A · Transport', flow: 'row', widgets: ['cueA', 'playA', 'stopA', 'ejectA', 'syncA'], uniform: true, mirror: true },
    'pdA-stems': { id: 'pdA-stems', type: 'panel', title: 'A · Stems', flow: 'row', widgets: ['stemBankA'], mirror: true },
    'pdA-hc': { id: 'pdA-hc', type: 'panel', title: 'A · Hotcues', flow: 'row', widgets: ['hcA1', 'hcA2', 'hcA3', 'hcA4'], uniform: true, mirror: true },
    'pdA-loop': { id: 'pdA-loop', type: 'panel', title: 'A · Loop', flow: 'row', widgets: ['loopA_0', 'loopA_1', 'loopA_2', 'loopA_3', 'loopA_4', 'loopOutA'], uniform: true, mirror: true },
    'pdA-perf': { id: 'pdA-perf', type: 'panel', title: 'A · Perf', flow: 'row', widgets: ['rollA_0', 'rollA_1', 'rollA_2', 'slipA', 'jumpA_0', 'jumpA_1', 'jumpA_2', 'jumpA_3'], uniform: true, mirror: true },
    // ── Deck B ──
    deckBcont: { id: 'deckBcont', type: 'container', axis: 'column', children: ['pdB-head', 'waveBOverview', 'cont-2-a0e79010', 'cont-B-transport', 'cont-B-stems', 'fxBP', 'perfBP'], fr: { 'pdB-head': 1.12, waveBOverview: 0.72, 'cont-2-a0e79010': 4.9, 'cont-B-transport': 1.02, 'cont-B-stems': 1.1, fxBP: 3.15, perfBP: 1.35 }, framed: true },
    waveAOverview: { id: 'waveAOverview', type: 'panel', title: 'A · Overview', flow: 'row', widgets: [], pinned: 'waveAOverview', mirror: true },
    waveBOverview: { id: 'waveBOverview', type: 'panel', title: 'B · Overview', flow: 'row', widgets: [], pinned: 'waveBOverview' },
    'pdB-head': { id: 'pdB-head', type: 'panel', title: 'B', flow: 'row', widgets: ['spacer:s-1-95993441', 'keylockB', 'keyB', 'bpmB', 'headerB'], widgetFr: { keylockB: 0.5522110739502047, keyB: 1.1040505388331472, bpmB: 1.039483463396507, headerB: 2.209123002601264, 'spacer:s-1-95993441': 0.4797473058342624 }, widgetJustify: { headerB: 'end' }, widgetMargins: { 'spacer:s-1-95993441': { t: 0, r: 0, b: 0, l: 64 } }, mirror: true, uniform: false },
    'pdB-jog': { id: 'pdB-jog', type: 'panel', title: 'B · Jog', flow: 'row', widgets: ['jogB'], widgetMargins: { jogB: { t: 1, r: 4, b: 3, l: 4 } } },
    'pdB-mode': { id: 'pdB-mode', type: 'panel', title: 'B · Mode', flow: 'column', widgets: ['syncLockB', 'headCueB'], uniform: true },
    'pdB-trans': { id: 'pdB-trans', type: 'panel', title: 'B · Transport', flow: 'row', widgets: ['cueB', 'playB', 'stopB', 'ejectB', 'syncB'], uniform: true },
    'pdB-stems': { id: 'pdB-stems', type: 'panel', title: 'B · Stems', flow: 'row', widgets: ['stemBankB'] },
    'pdB-hc': { id: 'pdB-hc', type: 'panel', title: 'B · Hotcues', flow: 'row', widgets: ['hcB1', 'hcB2', 'hcB3', 'hcB4'], uniform: true },
    'pdB-loop': { id: 'pdB-loop', type: 'panel', title: 'B · Loop', flow: 'row', widgets: ['loopB_0', 'loopB_1', 'loopB_2', 'loopB_3', 'loopB_4', 'loopOutB'], uniform: true },
    'pdB-perf': { id: 'pdB-perf', type: 'panel', title: 'B · Perf', flow: 'row', widgets: ['rollB_0', 'rollB_1', 'rollB_2', 'slipB', 'jumpB_0', 'jumpB_1', 'jumpB_2', 'jumpB_3'], uniform: true },
    // ── Mixer ──
    mixer: { id: 'mixer', type: 'container', axis: 'column', children: ['mixToggles', 'mixChans', 'mixXfade'], fr: { mixToggles: 1, mixChans: 6, mixXfade: 1.6 }, framed: true },
    mixToggles: { id: 'mixToggles', type: 'panel', title: 'Modes', flow: 'row', widgets: ['spacer:s-24-02c5d864', 'pitchRange', 'qtz', 'autoGain', 'automix', 'lim', 'midiMap', 'spacer:s-23-936b468e'], widgetMargins: { pitchRange: { t: 0, r: 5, b: 0, l: 5 }, qtz: { t: 0, r: 5, b: 0, l: 5 }, autoGain: { t: 0, r: 5, b: 0, l: 5 }, automix: { t: 0, r: 5, b: 0, l: 5 }, lim: { t: 0, r: 5, b: 0, l: 5 }, midiMap: { t: 0, r: 5, b: 0, l: 5 } }, uniform: true },
    mixChans: { id: 'mixChans', type: 'container', axis: 'row', children: ['eqAP', 'chAP', 'chBP', 'eqBP'], fr: { eqAP: 1.35, chAP: 1.15, chBP: 1.15, eqBP: 1.35 } },
    pchAP: { id: 'pchAP', type: 'panel', title: 'Pitch A', flow: 'column', widgets: ['pitchA'], widgetMargins: { pitchA: { t: 3, r: 4, b: 3, l: 4 } }, mirror: true },
    eqAP: { id: 'eqAP', type: 'panel', title: 'EQ A', flow: 'column', widgets: ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'], mirror: true },
    chAP: { id: 'chAP', type: 'panel', title: 'Ch A', flow: 'column', widgets: ['gainA', 'volA'], widgetFr: { gainA: 1, volA: 3 }, widgetMargins: { volA: { t: 8, r: 0, b: 8, l: 24 } }, mirror: true },
    chBP: { id: 'chBP', type: 'panel', title: 'Ch B', flow: 'column', widgets: ['gainB', 'volB'], widgetFr: { gainB: 1, volB: 3 }, widgetMargins: { volB: { t: 8, r: 24, b: 8, l: 0 } } },
    eqBP: { id: 'eqBP', type: 'panel', title: 'EQ B', flow: 'column', widgets: ['eqB.hi', 'eqB.mid', 'eqB.lo', 'fltB'] },
    pchBP: { id: 'pchBP', type: 'panel', title: 'Pitch B', flow: 'column', widgets: ['pitchB'], widgetMargins: { pitchB: { t: 3, r: 4, b: 3, l: 4 } }, uniform: false },
    mixXfade: { id: 'mixXfade', type: 'panel', title: 'Crossfade', flow: 'row', widgets: ['spacer:s-22-ffca8259', 'crossfader', 'spacer:s-21-cb584c7d'], widgetFr: { 'spacer:s-22-ffca8259': 0.4556701030927834, crossfader: 2.039175257731959, 'spacer:s-21-cb584c7d': 0.5051546391752577 }, widgetMargins: { crossfader: { t: 16, r: 0, b: 0, l: 0 } }, uniform: false },
    // ── FX row + rails ──
    fxrow: { id: 'fxrow', type: 'container', axis: 'row', children: ['fxAP', 'nextP', 'fxBP'], fr: { fxAP: 0.7703206562266971, nextP: 1.9175988068605512, fxBP: 0.812080536912752 } },
    fxAP: { id: 'fxAP', type: 'panel', title: 'Onboard FX A', flow: 'row', widgets: [], pinned: 'fxA', mirror: true },
    perfAP: { id: 'perfAP', type: 'panel', title: 'Performance Pads A', flow: 'row', widgets: [], pinned: 'perfA', mirror: true },
    nextP: { id: 'nextP', type: 'panel', title: 'Next', flow: 'row', widgets: [], pinned: 'next' },
    fxBP: { id: 'fxBP', type: 'panel', title: 'Onboard FX B', flow: 'row', widgets: [], pinned: 'fxB', uniform: false },
    perfBP: { id: 'perfBP', type: 'panel', title: 'Performance Pads B', flow: 'row', widgets: [], pinned: 'perfB', uniform: false },
    browser: { id: 'browser', type: 'container', axis: 'column', children: ['sourceTreeP', 'libraryP'], fr: { sourceTreeP: 2, libraryP: 3 } },
    sourceTreeP: { id: 'sourceTreeP', type: 'panel', title: 'Sources', flow: 'row', widgets: [], pinned: 'sourceTree' },
    libraryP: { id: 'libraryP', type: 'panel', title: 'Library', flow: 'row', widgets: [], pinned: 'library', uniform: true },
    // ── Deck B pad-row wrappers (pad row + spacer panel) ──
    'panel-1-eff655d2': { id: 'panel-1-eff655d2', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-25-e6518f32'] },
    'cont-2-a0e79010': { id: 'cont-2-a0e79010', type: 'container', axis: 'row', children: ['pdB-mode', 'pdB-jog', 'pchBP', 'panel-1-eff655d2'], fr: { 'pdB-mode': 0.38, 'pdB-jog': 1.56, pchBP: 0.45, 'panel-1-eff655d2': 0.6 } },
    'panel-B-transport-tail': { id: 'panel-B-transport-tail', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-B-transport-tail'] },
    'cont-B-transport': { id: 'cont-B-transport', type: 'container', axis: 'row', children: ['panel-B-transport-tail', 'pdB-trans'], fr: { 'panel-B-transport-tail': 0.48, 'pdB-trans': 2.51 } },
    'panel-B-stems-tail': { id: 'panel-B-stems-tail', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-B-stems-tail'] },
    'cont-B-stems': { id: 'cont-B-stems', type: 'container', axis: 'row', children: ['panel-B-stems-tail', 'pdB-stems'], fr: { 'panel-B-stems-tail': 0.48, 'pdB-stems': 2.51 } },
    'panel-3-e0911657': { id: 'panel-3-e0911657', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-32-4c52fb39'] },
    'cont-4-4f4c96d2': { id: 'cont-4-4f4c96d2', type: 'container', axis: 'row', children: ['pdB-hc', 'panel-3-e0911657'], fr: { 'pdB-hc': 1, 'panel-3-e0911657': 1 } },
    'panel-5-e8707245': { id: 'panel-5-e8707245', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-31-c7e28dbf'] },
    'cont-6-29de8ab7': { id: 'cont-6-29de8ab7', type: 'container', axis: 'row', children: ['pdB-loop', 'panel-5-e8707245'], fr: { 'pdB-loop': 1.3444976076555022, 'panel-5-e8707245': 0.6555023923444977 } },
    'panel-8-81228019': { id: 'panel-8-81228019', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-30-3282c3a3'] },
    'cont-9-aebcd780': { id: 'cont-9-aebcd780', type: 'container', axis: 'row', children: ['pdB-perf', 'panel-8-81228019'], fr: { 'pdB-perf': 1.5358851674641145, 'panel-8-81228019': 0.46411483253588537 } },
    // ── Deck A pad-row wrappers ──
    'cont-10-e11250c4': { id: 'cont-10-e11250c4', type: 'container', axis: 'row', children: ['panel-11-95a4a261', 'pchAP', 'pdA-jog', 'pdA-mode'], fr: { 'panel-11-95a4a261': 0.7, pchAP: 0.45, 'pdA-jog': 1.87, 'pdA-mode': 0.5 } },
    'panel-11-95a4a261': { id: 'panel-11-95a4a261', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-26-79f129b0'] },
    'panel-A-transport-head': { id: 'panel-A-transport-head', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-A-transport-head'] },
    'cont-A-transport': { id: 'cont-A-transport', type: 'container', axis: 'row', children: ['panel-A-transport-head', 'pdA-trans'], fr: { 'panel-A-transport-head': 1.15, 'pdA-trans': 2.37 } },
    'panel-A-stems-head': { id: 'panel-A-stems-head', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-A-stems-head'] },
    'cont-A-stems': { id: 'cont-A-stems', type: 'container', axis: 'row', children: ['panel-A-stems-head', 'pdA-stems'], fr: { 'panel-A-stems-head': 1.15, 'pdA-stems': 2.37 } },
    'panel-12-8772ebc6': { id: 'panel-12-8772ebc6', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-29-e3c2d4fe'] },
    'cont-13-90c67ecb': { id: 'cont-13-90c67ecb', type: 'container', axis: 'row', children: ['panel-12-8772ebc6', 'pdA-hc'], fr: { 'pdA-hc': 1.0814249363867683, 'panel-12-8772ebc6': 0.9185750636132315 } },
    'panel-15-4eb1b108': { id: 'panel-15-4eb1b108', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-28-3698f484'] },
    'cont-16-c9fc3a59': { id: 'cont-16-c9fc3a59', type: 'container', axis: 'row', children: ['panel-15-4eb1b108', 'pdA-loop'], fr: { 'pdA-loop': 1.3664122137404573, 'panel-15-4eb1b108': 0.6335877862595417 } },
    'panel-17-44cba1fb': { id: 'panel-17-44cba1fb', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-27-8799ff7e'] },
    'cont-18-cd01de17': { id: 'cont-18-cd01de17', type: 'container', axis: 'row', children: ['panel-17-44cba1fb', 'pdA-perf'], fr: { 'pdA-perf': 1.4885496183206104, 'panel-17-44cba1fb': 0.5114503816793893 } },
  },
};

/* DJ layouts saved before layout rev 1 were drawn with EQ A bottom to top (FLT,
 * LO, MID, HI) and hold Ch A as [volA, gainA]. The rev-1 upgrade keeps every
 * other mirrored column as the user saw it; these two panels take deck B's
 * top-to-bottom order, EQ A reading HI to LO and Ch A's gain above its fader. */
export const DJ_COLUMN_ORDER_FIX: ColumnOrderFix = {
  eqAP: ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'],
  chAP: ['gainA', 'volA'],
};
