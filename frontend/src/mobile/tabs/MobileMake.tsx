/** Reduced MAKE: prompt + model + length -> generate on the desktop backend,
 *  watch progress, then preview the finished take streamed from the Library.
 *  Fully standalone REST — works with no desktop host peer (unlike DJ/Remote,
 *  so no RemoteGate here). The run itself lives in makeJobStore so switching
 *  tabs mid-generation does not lose it. */
import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Square } from 'lucide-react';
import { RangeControl } from '../ui/RangeControl';
import { useMakeJobStore } from '../state/makeJobStore';

/** Same built-ins as the desktop MAKE picker (suno excluded — its cloud flow
 *  is a separate panel, not the job API). Local checkpoints append below. */
const MODELS: Array<{ id: string; label: string }> = [
  { id: 'small', label: 'Small (ARC)' },
  { id: 'medium', label: 'Medium (ARC)' },
  { id: 'small-rf', label: 'Small-RF' },
  { id: 'medium-rf', label: 'Medium-RF' },
  { id: 'magenta-small', label: 'Magenta RT2' },
];

type LocalCkpt = { id: string; name: string; ckptPath: string };

function statusText(phase: string, pct: number): string {
  if (phase === 'starting') return 'STARTING';
  if (phase === 'queued') return 'QUEUED';
  if (phase === 'sampling') return `SAMPLING ${pct}%`;
  return 'SAVING';
}

export function MobileMake() {
  const [locals, setLocals] = useState<LocalCkpt[]>([]);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Form state lives in the store so it survives tab switches, like the run.
  const prompt = useMakeJobStore((s) => s.prompt);
  const model = useMakeJobStore((s) => s.model);
  const duration = useMakeJobStore((s) => s.duration);
  const setPrompt = useMakeJobStore((s) => s.setPrompt);
  const setModel = useMakeJobStore((s) => s.setModel);
  const setDuration = useMakeJobStore((s) => s.setDuration);

  const phase = useMakeJobStore((s) => s.phase);
  const pct = useMakeJobStore((s) => s.pct);
  const error = useMakeJobStore((s) => s.error);
  const entryId = useMakeJobStore((s) => s.entryId);
  const title = useMakeJobStore((s) => s.title);
  const submit = useMakeJobStore((s) => s.submit);
  const cancel = useMakeJobStore((s) => s.cancel);

  const busy = phase === 'starting' || phase === 'queued' || phase === 'sampling' || phase === 'saving';

  // Registered local checkpoints (resolves=true), same source as the desktop
  // picker's "Local checkpoints" optgroup. Best-effort: failures just leave
  // the built-in options.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch('/api/storage/checkpoints');
        if (!r.ok) return;
        const j = (await r.json()) as {
          registered?: Array<{ id?: string; name?: string; resolves?: boolean; ckpt_path?: string }>;
        };
        if (dead) return;
        setLocals(
          (j.registered ?? [])
            .filter((c) => c.resolves && c.id)
            .map((c) => ({
              id: c.id as string,
              name: c.name || (c.id as string),
              // For RF detection: the display name often defaults to the
              // checkpoint's parent folder, so the "-rf" marker only shows
              // in the file path (same rule as the desktop picker).
              ckptPath: c.ckpt_path || '',
            })),
        );
      } catch {
        /* offline / older backend — built-ins only */
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  const onCreate = () => {
    // Stop a still-playing previous take before its result card is replaced.
    audioRef.current?.pause();
    setPlaying(false);
    void submit({
      model,
      prompt,
      duration,
      localNames: Object.fromEntries(locals.map((c) => [c.id, c.ckptPath || c.name])),
    });
  };

  const togglePreview = () => {
    const el = audioRef.current;
    if (!el || !entryId) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    const src = `/api/library/audio/${entryId}`;
    if (!el.src.endsWith(src)) el.src = src;
    // Roll back the flag if play() rejects (autoplay policy, dead stream).
    setPlaying(true);
    void el.play().catch(() => setPlaying(false));
  };

  return (
    <section className="m-make" aria-label="Make">
      <label className="m-make-field">
        <span className="sr-only">Prompt</span>
        <textarea
          id="m-make-prompt"
          name="make-prompt"
          rows={4}
          placeholder="Describe the audio to create..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
        />
      </label>

      <label className="m-make-field">
        <span className="m-field-label">
          <span>Model</span>
        </span>
        <select
          id="m-make-model"
          name="make-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={busy}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {locals.length > 0 && (
            <optgroup label="Local checkpoints">
              {locals.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (local)
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      <RangeControl
        id="make-duration"
        label="Length"
        min={5}
        max={512}
        step={1}
        value={duration}
        unit="s"
        onChange={(v) => setDuration(Math.round(v))}
      />

      {!busy ? (
        <button type="button" className="m-btn m-go" disabled={!prompt.trim()} onClick={onCreate}>
          Create
        </button>
      ) : (
        <div className="m-make-run">
          <div className="m-make-runhead">
            <span>{statusText(phase, pct)}</span>
            <button type="button" className="m-make-stop" onClick={cancel}>
              <Square size={12} aria-hidden="true" /> Stop
            </button>
          </div>
          <div
            className="m-prog"
            role="progressbar"
            aria-label="Generation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase === 'sampling' || phase === 'saving' ? pct : undefined}
          >
            <span style={{ width: `${phase === 'queued' || phase === 'starting' ? 4 : pct}%` }} />
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="m-state is-inline">
          <h2>Generation failed</h2>
          <p>{error}</p>
        </div>
      )}

      {phase === 'done' && (
        <div className="m-make-done">
          {entryId ? (
            <button
              type="button"
              className="m-row is-done"
              aria-label={playing ? `Pause ${title}` : `Play ${title}`}
              onClick={togglePreview}
            >
              <span className="m-row-play" aria-hidden="true">
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </span>
              <span className="m-row-body">
                <span className="m-row-title">{title}</span>
                <span className="m-row-sub">Saved to Library</span>
              </span>
            </button>
          ) : (
            <p className="m-make-note">Finished. Open Library to play the new take.</p>
          )}
        </div>
      )}

      <audio ref={audioRef} onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} />
    </section>
  );
}
