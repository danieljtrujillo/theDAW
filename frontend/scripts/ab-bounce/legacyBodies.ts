/**
 * THROWAWAY A/B REFERENCE — the three offline-render bodies of
 * `components/audio/WaveformEditor.tsx` as they stood at batch-6 baseline
 * `cce9375`, BEFORE ticket T11b routed them through `lib/renderCore`.
 *
 * Every statement below is a verbatim transcription of this repo's own code
 * (A: WaveformEditor.tsx:2070-2114, B: :2641-2828, C: :2979-3039). Nothing is
 * from `oss-refs/`. The ONLY edits are the ones needed to call the bodies from
 * outside a React component:
 *
 *   - the component's `clips` / `tracks` / `masterFxChain` / `selection`
 *     closures and `useEditorStore.getState()` reads become parameters;
 *   - `trackById` is rebuilt from the passed `tracks`;
 *   - `getTotalDurationSec()` is inlined as its editorStore body
 *     (`clips.length === 0 ? 60 : max(max(startSec+durationSec), 30)`);
 *   - the `setIsRendering` / `logInfo` / library-import / saveFile / backend
 *     VST3 hops around each body are dropped — they are consumer code that
 *     T11b does not touch, and they render no audio.
 *
 * This file exists only so the A/B can render the OLD graph and the NEW one in
 * the same page and diff the samples. It is not shipped and nothing imports it
 * from `src/`.
 */
import { applyFadeAutomation } from '../../src/lib/clipFade';
import { decodeClipBlob, peekDecoded } from '../../src/lib/decodeCache';
import {
  buildEffectChain, ensureChopModule, teleportXYZ, SPATIAL_TELEPORT, type ChainHandle,
} from '../../src/lib/rackEffects';
import { sliceChunks } from '../../src/lib/audioAnalysis';
import { encodeWav } from '../../src/lib/wavEncode';
import { computeClipSchedule } from '../../src/state/liveMixer';
import * as liveMixer from '../../src/state/liveMixer';
import {
  clipPeakGain, sampleLane,
  type AudioClip, type EditorTrack, type AutomationLane as AutomationLaneT,
} from '../../src/state/editorStore';
import type { ChainEntry } from '../../src/state/effectChainStore';

export interface Project {
  clips: AudioClip[];
  tracks: EditorTrack[];
  masterFxChain: ChainEntry[];
  automationLanes: AutomationLaneT[];
}

/** The blob the body produced AND the buffer it produced it from, so the A/B
 *  can diff the render itself as well as the 16-bit file the app writes. The
 *  only change to the three transcriptions below. */
export interface Rendered { blob: Blob; rendered: AudioBuffer }

/* ── A — sendSelectionToInit (WaveformEditor.tsx:2070-2114) ───────────────── */

export async function legacySendSelectionToInit(
  project: Project, selection: AudioClip[],
): Promise<Rendered> {
  const trackById = new Map(project.tracks.map((t) => [t.id, t]));

  const sr = 44100;
  const totalDur = Math.max(...selection.map((c) => c.startSec + c.durationSec), 1);
  const offline = new OfflineAudioContext(2, Math.ceil(totalDur * sr), sr);
  const decodeCtx = new AudioContext({ sampleRate: 44100 });
  try {
    for (const clip of selection) await decodeClipBlob(decodeCtx, clip.audioBlob);
  } finally {
    decodeCtx.close().catch(() => {});
  }

  for (const clip of selection) {
    if (clip.muted) continue;
    const track = trackById.get(clip.trackId);
    if (!track || track.mute) continue;
    const buf = peekDecoded(decodeCtx, clip.audioBlob);
    if (!buf) continue;
    const schedule = computeClipSchedule(clip, buf.duration);
    if (!schedule) continue;
    const gain = offline.createGain();
    const panner = offline.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, track.pan));
    gain.connect(panner).connect(offline.destination);

    applyFadeAutomation(gain.gain, clip, clip.startSec, 0, {
      peak: track.volume * clipPeakGain(clip),
      effectiveDurationSec: schedule.durationSec,
    });
    for (const seg of schedule.segments) {
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = seg.playbackRate;
      src.connect(gain);
      src.start(clip.startSec + seg.targetStart, seg.sourceOffset, seg.sourceDuration);
    }
  }

  const rendered = await offline.startRendering();
  return { blob: encodeWav(rendered), rendered };
}

/* ── B — commitEdit (WaveformEditor.tsx:2641-2828) ────────────────────────── */

export async function legacyCommitEdit(project: Project): Promise<Rendered> {
  const { clips, tracks, masterFxChain } = project;

  // editorStore.getTotalDurationSec, inlined.
  const dur = clips.length === 0
    ? 60
    : Math.max(...clips.map((c) => c.startSec + c.durationSec), 30);
  const sr = 44100;
  const offline = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const anySolo = tracks.some((t) => t.solo);
  const decodeCtx = new AudioContext({ sampleRate: 44100 });
  try {
    for (const c of clips) await decodeClipBlob(decodeCtx, c.audioBlob);
  } finally {
    decodeCtx.close().catch(() => {});
  }
  const usesChop = [masterFxChain, ...tracks.map((t) => t.fxChain ?? [])]
    .some((ch) => ch.some((e) => e.effect === 'chop' && e.enabled));
  if (usesChop) {
    try { await ensureChopModule(offline); } catch { /* falls back to passthrough */ }
  }

  const masterBus = offline.createGain();
  const masterFx = buildEffectChain(offline, masterBus, offline.destination, masterFxChain);

  const lanes = project.automationLanes.filter((l) => l.enabled && l.points.length > 0);
  const scheduleParamLane = (param: AudioParam, lane: AutomationLaneT, clampFn: (v: number) => number) => {
    liveMixer.applyEnvelopeEvents(param, liveMixer.laneEnvelopeEvents(lane, 0, 0, 0, 0), clampFn);
  };

  const trackNodeById = new Map<string, { gain: GainNode; panner: StereoPannerNode; fx: ChainHandle }>();
  for (const track of tracks) {
    if (track.mute) continue;
    if (anySolo && !track.solo) continue;
    const tgain = offline.createGain();
    const volLane = lanes.find((l) => l.target.kind === 'trackVolume' && l.target.trackId === track.id);
    if (volLane) scheduleParamLane(tgain.gain, volLane, (v) => Math.max(0, v));
    else tgain.gain.value = track.volume;
    const panner = offline.createStereoPanner();
    const panLane = lanes.find((l) => l.target.kind === 'trackPan' && l.target.trackId === track.id);
    if (panLane) scheduleParamLane(panner.pan, panLane, (v) => Math.max(-1, Math.min(1, v)));
    else panner.pan.value = Math.max(-1, Math.min(1, track.pan));
    const fx = buildEffectChain(offline, tgain, panner, track.fxChain ?? []);
    panner.connect(masterBus);
    trackNodeById.set(track.id, { gain: tgain, panner, fx });
  }

  for (const c of clips) {
    if (c.muted) continue;
    const tn = trackNodeById.get(c.trackId);
    if (!tn) continue;
    const buf = peekDecoded(decodeCtx, c.audioBlob);
    if (!buf) continue;
    const schedule = computeClipSchedule(c, buf.duration);
    if (!schedule) continue;

    const clipGain = offline.createGain();
    applyFadeAutomation(clipGain.gain, c, c.startSec, 0, {
      peak: clipPeakGain(c),
      effectiveDurationSec: schedule.durationSec,
    });
    clipGain.connect(tn.gain);
    for (const seg of schedule.segments) {
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = seg.playbackRate;
      src.connect(clipGain);
      src.start(c.startSec + seg.targetStart, seg.sourceOffset, seg.sourceDuration);
    }
  }

  const chunkCache = new Map<Blob, ReturnType<typeof sliceChunks>>();
  for (const track of tracks) {
    const tn = trackNodeById.get(track.id);
    if (!tn) continue;
    const teleEntries = (track.fxChain ?? []).filter(
      (e) => e.enabled && e.effect === 'spatializer' && Math.round(e.params?.motion ?? 0) === SPATIAL_TELEPORT,
    );
    if (teleEntries.length === 0) continue;
    const insts = tn.fx.instances();
    const trackClips = clips.filter((c) => c.trackId === track.id && !c.muted);
    for (const entry of teleEntries) {
      const li = insts.find((x) => x.id === entry.id);
      if (!li?.inst.scheduleTeleport) continue;
      const spread = entry.params?.motionDepth ?? 5;
      const events: { when: number; x: number; y: number; z: number }[] = [];
      let idx = 0;
      for (const c of trackClips) {
        const buf = peekDecoded(decodeCtx, c.audioBlob);
        if (!buf) continue;
        const offset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const cdur = Math.min(c.durationSec, buf.duration - offset);
        if (cdur <= 0) continue;
        let chunks = chunkCache.get(c.audioBlob);
        if (!chunks) { chunks = sliceChunks(buf); chunkCache.set(c.audioBlob, chunks); }
        for (const chunk of chunks) {
          if (chunk.tSec < offset || chunk.tSec >= offset + cdur) continue;
          const pos = teleportXYZ(idx, chunk.loudness, chunk.brightness, spread);
          events.push({ when: c.startSec + (chunk.tSec - offset), x: pos.x, y: pos.y, z: pos.z });
          idx += 1;
        }
      }
      if (events.length > 0) {
        events.sort((a, b) => a.when - b.when);
        li.inst.scheduleTeleport(events);
      }
    }
  }

  const fxTargets: { handle: ChainHandle; entryId: string; baseParams: Record<string, number>; lanes: AutomationLaneT[] }[] = [];
  const groupFx = (
    kind: 'trackFx' | 'masterFx',
    handle: ChainHandle,
    chain: { id: string; enabled: boolean; params: Record<string, number> }[],
    trackId?: string,
  ) => {
    for (const entry of chain) {
      if (!entry.enabled) continue;
      const entryLanes = lanes.filter(
        (l) => l.target.kind === kind && l.target.entryId === entry.id && (kind === 'masterFx' || l.target.trackId === trackId),
      );
      if (entryLanes.length > 0) fxTargets.push({ handle, entryId: entry.id, baseParams: entry.params, lanes: entryLanes });
    }
  };
  groupFx('masterFx', masterFx, masterFxChain);
  for (const track of tracks) {
    const tn = trackNodeById.get(track.id);
    if (!tn) continue;
    groupFx('trackFx', tn.fx, track.fxChain ?? [], track.id);
  }

  if (fxTargets.length > 0) {
    const applyFxAt = (t: number) => {
      for (const tgt of fxTargets) {
        const merged: Record<string, number> = { ...tgt.baseParams };
        for (const lane of tgt.lanes) {
          const v = sampleLane(lane, t);
          if (v != null && lane.target.paramKey) merged[lane.target.paramKey] = v;
        }
        tgt.handle.updateParams(tgt.entryId, merged);
      }
    };
    applyFxAt(0);
    const q = 128 / sr;
    const times = new Set<number>();
    for (const tgt of fxTargets) {
      for (const lane of tgt.lanes) {
        for (const p of lane.points) {
          if (p.t <= 0 || p.t >= dur) continue;
          times.add(Math.min(dur - q, Math.ceil(p.t / q) * q));
        }
      }
    }
    for (const tq of [...times].sort((a, b) => a - b)) {
      if (tq <= 0 || tq >= dur) continue;
      offline.suspend(tq).then(() => { applyFxAt(tq); offline.resume(); }).catch(() => {});
    }
  }

  const rendered = await offline.startRendering();
  return { blob: encodeWav(rendered), rendered };
}

/* ── C — renderTrackStem (WaveformEditor.tsx:2979-3039) ───────────────────── */

export async function legacyRenderTrackStem(
  project: Project, trackId: string,
): Promise<Rendered & { durationSec: number }> {
  const track = project.tracks.find((t) => t.id === trackId)!;
  const trackClips = project.clips.filter((c) => c.trackId === trackId);
  const vsts = (track.fxChain ?? []).filter((e) => e.enabled && e.effect === 'vst3' && e.vst);
  const dur = Math.max(...trackClips.map((c) => c.startSec + c.durationSec), 0.1);
  const sr = 44100;
  const offline = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);

  const decodeCtx = new AudioContext({ sampleRate: sr });
  try {
    for (const c of trackClips) await decodeClipBlob(decodeCtx, c.audioBlob);
  } finally {
    decodeCtx.close().catch(() => {});
  }

  const rackChain = (track.fxChain ?? []).filter((e) => e.effect !== 'vst3');
  if (rackChain.some((e) => e.effect === 'chop' && e.enabled)) {
    try {
      await ensureChopModule(offline);
    } catch {
      /* falls back to passthrough */
    }
  }
  const trackInput = offline.createGain();
  const fx = buildEffectChain(offline, trackInput, offline.destination, rackChain);
  for (const c of trackClips) {
    if (c.muted) continue;
    const buf = peekDecoded(decodeCtx, c.audioBlob);
    if (!buf) continue;
    const schedule = computeClipSchedule(c, buf.duration);
    if (!schedule) continue;
    const clipGain = offline.createGain();
    applyFadeAutomation(clipGain.gain, c, c.startSec, 0, {
      peak: clipPeakGain(c),
      effectiveDurationSec: schedule.durationSec,
    });
    clipGain.connect(trackInput);
    for (const seg of schedule.segments) {
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = seg.playbackRate;
      src.connect(clipGain);
      src.start(c.startSec + seg.targetStart, seg.sourceOffset, seg.sourceDuration);
    }
  }

  let rendered: AudioBuffer;
  try {
    rendered = await offline.startRendering();
  } finally {
    fx.dispose();
  }
  const blob: Blob = encodeWav(rendered, { float32: vsts.length > 0 });
  return { blob, rendered, durationSec: dur };
}
