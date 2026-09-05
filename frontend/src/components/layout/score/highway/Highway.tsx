import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { LibraryEntry } from '../../../../state/libraryEntry';
import { logError, logInfo } from '../../../../state/logStore';
import {
  allowedModes,
  defaultPartVisibility,
  usePlayAlongStore,
  type HighwayDifficulty,
  type HighwaySkin,
  type PartDescriptor,
} from '../../../../state/playAlongStore';
import type { NotationArtifact } from '../../../../lib/notationClient';
import { ensureNoteChart, loadNoteChart, type NoteChart } from '../../../../lib/notechart';
import { measureCanvasBox } from '../../../../lib/canvasScale';
import { buildSchedule, codepointsOf, type Schedule } from './schedule';
import { buildGlyphAtlas, loadBravura, type GlyphAtlas } from './glyphAtlas';
import { HighwayScene } from './HighwayScene';
import { usePlayAlong } from '../playAlong/usePlayAlongClock';
import { PlayAlongTransport } from '../playAlong/PlayAlongTransport';
import { PartFilter } from '../playAlong/PartFilter';
import { applyInstrumentPreset, registerParts } from '../playAlong/partRegistry';

export interface HighwayProps {
  entry: LibraryEntry | null;
  /** The selected artifact: a note chart, or a sheet the chart is built from. */
  artifact: NotationArtifact;
  artifacts: NotationArtifact[];
  /** Called after a note chart was exported so the artifact list reloads. */
  onArtifactsChanged: () => void;
}

const SKINS: ReadonlyArray<{ id: HighwaySkin; label: string; title: string }> = [
  { id: 'notation', label: 'NOTATION', title: 'Note glyphs, one lane per visible part' },
  { id: 'blocks', label: 'BLOCKS', title: 'Exactly the notes the Beat Saber export contains' },
  { id: 'drums', label: 'DRUMS', title: 'Drum voices on their own lanes: kick, snare, hi-hat, toms, cymbals' },
];

const DIFFICULTIES: ReadonlyArray<{ value: HighwayDifficulty; label: string }> = [
  { value: 0, label: 'Easy' },
  { value: 1, label: 'Normal' },
  { value: 2, label: 'Hard' },
  { value: 3, label: 'Expert' },
  { value: 4, label: 'Expert+' },
];

const SPEED_MIN = 3;
const SPEED_MAX = 20;
const SPEED_STEP = 0.5;
const LEADIN_MIN = 1;
const LEADIN_MAX = 5;
const LEADIN_STEP = 0.25;
/** Cap on the device pixel ratio, like the repo's other canvases. */
const MAX_DPR = 2;
/** Context losses before the view gives up on WebGL. */
const CONTEXT_LOSS_LIMIT = 2;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const countVisible = (v: readonly boolean[]): number => v.filter(Boolean).length;

/**
 * HIGHWAY view: the gantasmo.notechart the Unity scene consumes, drawn in the
 * browser with three.js — pooled Bravura sprites (or Beat Saber blocks, or
 * drum pads) travelling toward a hit line, positioned each frame as a pure
 * function of the play-along clock. Builds the chart on demand through the
 * existing /export route, shares the PartFilter / instrument presets with the
 * strip through the play-along store, and falls back to a card (SWITCH TO
 * STRIP) when WebGL is unavailable or the context is lost twice.
 */
export const Highway: React.FC<HighwayProps> = ({ entry, artifact, artifacts, onArtifactsChanged }) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<HighwayScene | null>(null);
  const atlasRef = useRef<GlyphAtlas | null>(null);
  /** Codepoints ever asked of the atlas (a codepoint the font cannot draw
   *  stays `has() === false` forever, so "missing" is judged against this). */
  const requestedRef = useRef<Set<number>>(new Set());
  const lastTimeRef = useRef(0);
  const artifactsRef = useRef(artifacts);
  artifactsRef.current = artifacts;
  const onArtifactsChangedRef = useRef(onArtifactsChanged);
  onArtifactsChangedRef.current = onArtifactsChanged;

  const [chart, setChart] = useState<NoteChart | null>(null);
  const [chartError, setChartError] = useState('');
  const [status, setStatus] = useState('');
  const [webglFallback, setWebglFallback] = useState<{ title: string; detail: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [stats, setStats] = useState<{ items: number; hits: number } | null>(null);
  const [chartNonce, setChartNonce] = useState(0);
  const [sceneNonce, setSceneNonce] = useState(0);

  const approachSpeed = usePlayAlongStore((s) => s.approachSpeed);
  const leadInSec = usePlayAlongStore((s) => s.leadInSec);
  const skin = usePlayAlongStore((s) => s.skin);
  const difficulty = usePlayAlongStore((s) => s.difficulty);
  const setApproachSpeed = usePlayAlongStore((s) => s.setApproachSpeed);
  const setLeadInSec = usePlayAlongStore((s) => s.setLeadInSec);
  const setSkin = usePlayAlongStore((s) => s.setSkin);
  const setDifficulty = usePlayAlongStore((s) => s.setDifficulty);
  const setMode = usePlayAlongStore((s) => s.setMode);
  const stored = usePlayAlongStore((s) => s.partVisibility[artifact.id]);

  const parts = useMemo<PartDescriptor[]>(
    () => (chart ? chart.parts.map((p, i) => ({ name: p.name || `Part ${i + 1}`, isPercussion: p.isPercussion === true })) : []),
    [chart],
  );
  const visible = useMemo<boolean[]>(
    () => (stored && stored.length === parts.length ? stored : defaultPartVisibility(parts)),
    [stored, parts],
  );
  const visibleKey = visible.map((v) => (v ? '1' : '0')).join('');
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const hasPercussion = parts.some((p) => p.isPercussion);
  const percussionVisible = parts.some((p, i) => p.isPercussion && visible[i]);
  /** A stored 'drums' skin means nothing on a chart without a percussion part. */
  const effectiveSkin: HighwaySkin = skin === 'drums' && !hasPercussion ? 'notation' : skin;

  const title = chart?.source?.title || entry?.title || artifact.id;
  const canStrip = allowedModes(artifact.kind).includes('strip');

  // 1. The chart: load a note-chart artifact directly, or derive one from the
  //    selected sheet (exporting it when missing or predating the bs* fields).
  useEffect(() => {
    let cancelled = false;
    setChart(null);
    setChartError('');
    setStats(null);
    setStatus(artifact.kind === 'notechart' ? 'Loading note chart…' : 'Building note chart…');
    const run = async () => {
      try {
        let loaded: NoteChart;
        if (artifact.kind === 'notechart') {
          loaded = await loadNoteChart(artifact.id);
        } else {
          if (!entry) throw new Error('no library track for this score');
          const result = await ensureNoteChart(entry.id, artifact, artifactsRef.current);
          loaded = result.chart;
          if (result.created && !cancelled) {
            logInfo('score', `Built note chart ${result.artifact.id} for the highway`);
            onArtifactsChangedRef.current();
          }
        }
        if (cancelled) return;
        const descriptors: PartDescriptor[] = loaded.parts.map((p, i) => ({
          name: p.name || `Part ${i + 1}`,
          isPercussion: p.isPercussion === true,
        }));
        // Register before the first render that mounts PartFilter so the
        // instrument preset (when one is chosen) wins over the plain default.
        registerParts(artifact.id, descriptors);
        applyInstrumentPreset(artifact.id, usePlayAlongStore.getState().instrument);
        setChart(loaded);
        setStatus('');
      } catch (e) {
        if (cancelled) return;
        setStatus('');
        setChartError(errorText(e));
        logError('score', `Note chart unavailable for the highway: ${errorText(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.kind, entry?.id, chartNonce]);

  // 2. The scene: three.js + Bravura, the schedule for the current settings,
  //    the glyph atlas for exactly the codepoints it draws.
  useEffect(() => {
    if (!chart || webglFallback) return;
    let cancelled = false;
    let stage: 'renderer' | 'font' | 'webgl' = 'renderer';
    setReady(false);
    setStatus('Loading highway renderer…');
    const run = async () => {
      try {
        const [three] = await Promise.all([
          import('three'),
          (async () => {
            stage = 'font';
            await loadBravura();
          })(),
        ]);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const st = usePlayAlongStore.getState();
        const skinNow: HighwaySkin = st.skin === 'drums' && !chart.parts.some((p) => p.isPercussion) ? 'notation' : st.skin;
        const vis = visibleRef.current;
        const schedule = buildSchedule(chart, vis, { skin: skinNow, difficulty: st.difficulty });
        const cps = codepointsOf(schedule);
        requestedRef.current = new Set(cps);
        const atlas = buildGlyphAtlas(cps);
        stage = 'webgl';
        const scene = new HighwayScene(three, canvas, atlas, schedule, {
          approachSpeed: st.approachSpeed,
          leadInSec: st.leadInSec,
          skin: skinNow,
          laneCount: countVisible(vis),
        });
        scene.onContextLost = (count) => {
          if (count >= CONTEXT_LOSS_LIMIT) {
            setWebglFallback({
              title: 'WebGL unavailable on this machine',
              detail: `The graphics context was lost ${count} times; the browser is not keeping a WebGL surface alive for this tab.`,
            });
          } else {
            setStatus('Graphics context lost — waiting for the browser to restore it…');
          }
        };
        sceneRef.current = scene;
        atlasRef.current = atlas;
        const wrap = wrapRef.current;
        if (wrap) scene.resize(measureCanvasBox(wrap, { maxDpr: MAX_DPR }));
        scene.frame(lastTimeRef.current);
        setStats({ items: schedule.items.length, hits: schedule.hitCount });
        setStatus('');
        setReady(true);
      } catch (e) {
        if (cancelled) return;
        setStatus('');
        const detail = errorText(e);
        setWebglFallback(
          stage === 'webgl'
            ? { title: 'WebGL unavailable on this machine', detail }
            : { title: 'Highway renderer unavailable', detail },
        );
        logError('score', `Highway unavailable (${stage}): ${detail}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
      setReady(false);
      const scene = sceneRef.current;
      sceneRef.current = null;
      atlasRef.current = null;
      try {
        scene?.dispose();
      } catch {
        /* renderer already gone */
      }
    };
  }, [chart, webglFallback, sceneNonce]);

  // 3. Part visibility / skin / difficulty: a new schedule (and, when it draws
  //    a glyph the atlas has never seen, a new atlas).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene || !chart) return;
    const schedule: Schedule = buildSchedule(chart, visible, { skin: effectiveSkin, difficulty });
    const cps = codepointsOf(schedule);
    let missing = false;
    for (const cp of cps) {
      if (!requestedRef.current.has(cp)) {
        missing = true;
        break;
      }
    }
    if (missing) {
      for (const cp of cps) requestedRef.current.add(cp);
      const atlas = buildGlyphAtlas(requestedRef.current);
      atlasRef.current = atlas;
      scene.setAtlas(atlas);
    }
    scene.setSchedule(schedule);
    scene.setSettings({ skin: effectiveSkin, laneCount: countVisible(visible) });
    setStats({ items: schedule.items.length, hits: schedule.hitCount });
    // visibleKey stands in for `visible` (a fresh array per store write).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, chart, visibleKey, effectiveSkin, difficulty]);

  // 4. Speed and lead-in.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene) return;
    scene.setSettings({ approachSpeed, leadInSec });
  }, [ready, approachSpeed, leadInSec]);

  // 5. Size the WebGL surface to its box (device pixels, shell zoom included).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!ready || !wrap) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const scene = sceneRef.current;
        if (scene && wrapRef.current) scene.resize(measureCanvasBox(wrapRef.current, { maxDpr: MAX_DPR }));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ready]);

  // 6. One frame per clock tick (rAF while playing, store subscription while
  //    paused, so a seek redraws at the scrub head).
  const handle = usePlayAlong(entry, (sec) => {
    lastTimeRef.current = sec;
    sceneRef.current?.frame(sec);
  });

  const retryChart = useCallback(() => setChartNonce((n) => n + 1), []);
  const retryScene = useCallback(() => {
    setWebglFallback(null);
    setSceneNonce((n) => n + 1);
  }, []);

  // Skin radios: roving focus, arrows move among the enabled skins.
  const skinButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const skinEnabled = (id: HighwaySkin): boolean => id !== 'drums' || hasPercussion;
  const onSkinKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    for (let step = 1; step <= SKINS.length; step += 1) {
      const next = (index + dir * step + SKINS.length * step) % SKINS.length;
      if (skinEnabled(SKINS[next].id)) {
        setSkin(SKINS[next].id);
        skinButtonsRef.current[next]?.focus();
        return;
      }
    }
  };

  const statsText = (() => {
    if (!chart) return '';
    if (!stats) return `${parts.length} part${parts.length === 1 ? '' : 's'}`;
    if (effectiveSkin === 'drums' && !percussionVisible) return 'Drums skin: show the percussion part to see hits';
    if (effectiveSkin === 'blocks' && stats.items === 0) return 'No blocks at this difficulty for the visible parts';
    return `${stats.hits} hits · ${stats.items} items · ${countVisible(visible)}/${parts.length} parts`;
  })();

  const difficultyTitle = effectiveSkin === 'blocks'
    ? 'Which Beat Saber difficulty set to show'
    : 'Difficulty applies to the BLOCKS skin';

  return (
    <div className="h-full flex flex-col bg-[#0b0e14]">
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-b border-white/10 bg-[#0a080f] text-[10px] font-mono text-zinc-300">
        <span className="flex items-center gap-1">
          <label htmlFor="score-hw-speed" className="text-zinc-500 select-none" title="How fast notes approach the hit line">
            SPEED
          </label>
          <input
            id="score-hw-speed"
            name="score-hw-speed"
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={approachSpeed}
            onChange={(e) => setApproachSpeed(Number(e.target.value))}
            className="w-20 accent-emerald-400"
          />
          <span className="w-7 tabular-nums text-zinc-400">{approachSpeed.toFixed(1)}</span>
        </span>
        <span className="flex items-center gap-1">
          <label htmlFor="score-hw-leadin" className="text-zinc-500 select-none" title="Seconds of upcoming notes visible ahead of the hit line">
            LEAD-IN s
          </label>
          <input
            id="score-hw-leadin"
            name="score-hw-leadin"
            type="range"
            min={LEADIN_MIN}
            max={LEADIN_MAX}
            step={LEADIN_STEP}
            value={leadInSec}
            onChange={(e) => setLeadInSec(Number(e.target.value))}
            className="w-16 accent-emerald-400"
          />
          <span className="w-7 tabular-nums text-zinc-400">{leadInSec.toFixed(2)}</span>
        </span>
        <div role="radiogroup" aria-label="Highway skin" className="flex items-center gap-0.5 rounded border border-white/10 bg-black/30 p-0.5">
          {SKINS.map((s, i) => {
            const enabled = skinEnabled(s.id);
            const checked = effectiveSkin === s.id;
            return (
              <button
                key={s.id}
                ref={(el) => { skinButtonsRef.current[i] = el; }}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={!enabled}
                tabIndex={checked ? 0 : -1}
                title={enabled ? s.title : 'No percussion part in this chart'}
                onClick={() => { if (enabled) setSkin(s.id); }}
                onKeyDown={(e) => onSkinKey(e, i)}
                className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  checked
                    ? 'bg-emerald-500/20 text-emerald-100 border border-emerald-500/40'
                    : 'text-zinc-400 hover:text-zinc-100 border border-transparent'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <span className="flex items-center gap-1">
          <label htmlFor="score-hw-difficulty" className="text-zinc-500 select-none" title={difficultyTitle}>
            DIFFICULTY
          </label>
          <select
            id="score-hw-difficulty"
            name="score-hw-difficulty"
            value={difficulty}
            disabled={effectiveSkin !== 'blocks'}
            title={difficultyTitle}
            onChange={(e) => setDifficulty(Number(e.target.value) as HighwayDifficulty)}
            className="form-select text-[9px] px-1 py-0.5 disabled:opacity-40"
          >
            {DIFFICULTIES.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </span>
        {parts.length > 1 && <PartFilter artifactId={artifact.id} parts={parts} />}
        {statsText && <span className="ml-auto text-zinc-500 truncate" title={title}>{statsText}</span>}
      </div>

      <div ref={wrapRef} className="relative flex-1 min-h-0 overflow-hidden bg-[#0b0e14]">
        {webglFallback ? (
          <div className="h-full grid place-items-center p-4">
            <div className="max-w-sm rounded-lg border border-white/10 bg-black/40 p-4 text-[10px] font-mono text-zinc-300 space-y-2">
              <div className="text-[9px] font-black uppercase tracking-widest text-amber-300">{webglFallback.title}</div>
              <p className="leading-relaxed text-zinc-400 break-words">{webglFallback.detail}</p>
              <div className="flex flex-wrap gap-1.5">
                {canStrip && (
                  <button
                    type="button"
                    onClick={() => setMode('strip')}
                    className="btn-ghost text-[9px] py-1 px-2"
                    title="Read the score as a scrolling strip instead"
                  >
                    SWITCH TO STRIP
                  </button>
                )}
                <button type="button" onClick={retryScene} className="btn-ghost text-[9px] py-1 px-2" title="Try the WebGL renderer again">
                  RETRY
                </button>
              </div>
            </div>
          </div>
        ) : chartError ? (
          <div className="h-full grid place-items-center p-4">
            <div className="max-w-sm rounded-lg border border-white/10 bg-black/40 p-4 text-[10px] font-mono text-zinc-300 space-y-2">
              <div className="text-[9px] font-black uppercase tracking-widest text-rose-300">Note chart unavailable</div>
              <p className="leading-relaxed text-zinc-400 break-words">{chartError}</p>
              <p className="text-zinc-500">
                The highway reads the same gantasmo.notechart the Unity scene does; it is exported through the NOTECHART route from the selected sheet.
              </p>
              <button type="button" onClick={retryChart} className="btn-ghost text-[9px] py-1 px-2">
                RETRY
              </button>
            </div>
          </div>
        ) : (
          <>
            {chart && (
              <canvas
                ref={canvasRef}
                role="img"
                aria-label={`Note highway, ${title}`}
                className="block w-full h-full"
              />
            )}
            {status && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <span className="flex items-center gap-1.5 rounded border border-white/10 bg-black/60 px-2 py-1 text-[10px] font-mono text-zinc-300">
                  <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  {status}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <PlayAlongTransport
        entry={entry}
        isSameTrack={handle.isSameTrack}
        isPlaying={handle.isPlaying}
        otherTrackLoaded={handle.otherTrackLoaded}
        onTransport={handle.onTransport}
      />
    </div>
  );
};

export default Highway;
