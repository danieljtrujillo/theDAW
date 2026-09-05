/**
 * GanPluginStage — renders a loaded .gan web-plugin in the MIX Effect Stage
 * footprint (the same spot Studio Modules land). The plugin's UI is served from
 * the backend runtime (/api/plugin/<id>/runtime/index.html) and iframed here;
 * its control postMessages bubble to the app (a host can route them later). The
 * Owl is a separate native case; this is the generic loader surface.
 *
 * The runtime letterboxes its canvas to fit (aspect-ratio preserved), so an
 * oversized plugin never overflows — it just shrinks. EXPAND pops the plugin
 * out into its OWN window (like a native VST editor) via DetachableWindow, so a
 * dense surface (e.g. Ares) is readable at full size and nothing in the app can
 * cover its controls. While popped out, control messages are forwarded from the
 * popup back to the main window so the ares bridge (which listens on the main
 * window) keeps driving the chain.
 *
 * Reveal: the runtime keeps its canvas invisible until its artwork is decoded
 * and every element frame is laid out at its final scale, then fades in and
 * posts {type:'gan-ready'}. Until that arrives the stage shows a skeleton —
 * the plugin's artwork letterboxed exactly where the runtime will draw it
 * (instant from the HTTP cache on a re-open) under a soft pulse — and the
 * iframe sits at opacity 0, so the surface appears in one beat with every
 * control already on its art instead of popping in piecemeal.
 */
import { useEffect, useRef, useState } from 'react';
import { Blocks, ExternalLink } from 'lucide-react';
import { DetachableWindow } from '../layout/DetachableWindow';

/** The live plugin iframe, wherever it currently renders (in place or in the
 *  popped-out window). Hosts use this to push messages (e.g. live level) down
 *  to the runtime — a document.getElementById would miss the popup's DOM. */
let activeGanFrame: HTMLIFrameElement | null = null;
export function getGanStageFrame(): HTMLIFrameElement | null {
  return activeGanFrame && activeGanFrame.isConnected ? activeGanFrame : null;
}
const frameRef = (el: HTMLIFrameElement | null) => {
  if (el) activeGanFrame = el;
  else if (activeGanFrame && !activeGanFrame.isConnected) activeGanFrame = null;
};

/** A runtime composed before the reveal protocol existed (an older imported
 *  .gan) never posts gan-ready; reveal it this long after its load event. */
const LEGACY_REVEAL_MS = 1200;
/** Skeleton stays under the fading iframe for the runtime's opacity transition. */
const CROSSFADE_MS = 260;

/** The runtime's artwork sits beside its entry document. */
const artworkUrlFor = (entryUrl: string): string => entryUrl.replace(/[^/]*$/, 'background.png');

/**
 * The runtime iframe plus its reveal choreography. Keyed by url from the
 * parent so a plugin change remounts it with fresh state.
 */
function GanFrame({ url, name, id }: { url: string; name: string; id?: string }) {
  const [ready, setReady] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [artOk, setArtOk] = useState(true);
  const legacyTimer = useRef<number | null>(null);

  // gan-ready arrives from the runtime (posted to its parent: the main window
  // in place; the popup while detached, which forwards it here).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown } | null;
      if (d && typeof d === 'object' && d.type === 'gan-ready') setReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => setRevealed(true), CROSSFADE_MS);
    return () => window.clearTimeout(t);
  }, [ready]);

  useEffect(() => () => { if (legacyTimer.current != null) window.clearTimeout(legacyTimer.current); }, []);

  const onLoad = () => {
    if (legacyTimer.current != null) window.clearTimeout(legacyTimer.current);
    legacyTimer.current = window.setTimeout(() => setReady(true), LEGACY_REVEAL_MS);
  };

  return (
    <div className="relative w-full flex-1 min-h-0 bg-[#07080c]">
      {!revealed && (
        <div
          className="absolute inset-0 flex items-center justify-center overflow-hidden"
          aria-hidden="true"
        >
          {artOk && (
            <img
              src={artworkUrlFor(url)}
              alt=""
              draggable={false}
              onError={() => setArtOk(false)}
              className="w-full h-full object-contain select-none pointer-events-none"
            />
          )}
          <div className="absolute inset-0 bg-[#07080c]/35 animate-pulse pointer-events-none" />
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[9px] font-mono uppercase tracking-widest text-indigo-200/70">
            loading {name}…
          </span>
        </div>
      )}
      {/* data-ready lets hosts (MixView's level feed) hold their pushes until
          the runtime is actually up, instead of flooding frames that are
          still loading. */}
      <iframe
        ref={frameRef}
        id={id}
        src={url}
        title={name}
        onLoad={onLoad}
        data-ready={ready ? '1' : '0'}
        className={`absolute inset-0 w-full h-full border-0 block transition-opacity duration-200 ease-out ${ready ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
}

export function GanPluginStage({ url, name }: { url: string | null; name: string | null }) {
  const [win, setWin] = useState<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  // Losing the plugin (chain entry removed, another plugin picked) closes the
  // popped-out window with it.
  useEffect(() => {
    if (!url && win) setWin(null);
  }, [url, win]);

  // The .gan runtime posts control values (and its ready signal) to ITS parent
  // window — the popup while detached. The ares bridge and the reveal listener
  // live on the MAIN window, so forward.
  useEffect(() => {
    if (!win) return;
    const fwd = (e: MessageEvent) => {
      const d = e.data as { type?: unknown } | null;
      if (d && typeof d === 'object' && (d.type === 'updateValue' || d.type === 'gan-ready')) {
        window.postMessage(e.data, '*');
      }
    };
    win.addEventListener('message', fwd);
    return () => win.removeEventListener('message', fwd);
  }, [win]);

  if (!url) {
    return (
      <div className="h-full w-full min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4">
        <Blocks className="w-6 h-6 text-zinc-700" />
        <span className="text-[11px] text-zinc-500">Open a .gan plugin to load it here.</span>
        <span className="text-[9px] font-mono text-zinc-600">portable GANTASMO web-plugins</span>
      </div>
    );
  }

  const togglePopOut = () => {
    if (win) {
      setWin(null); // pop back in — unmounting DetachableWindow closes it
      return;
    }
    // Must run synchronously inside the click gesture or browsers block it.
    const w = window.open(
      '',
      'theDAW_GAN_STAGE',
      'width=1100,height=700,menubar=no,toolbar=no,location=no,status=no',
    );
    if (!w) {
      setPopupBlocked(true);
      return;
    }
    setPopupBlocked(false);
    setWin(w);
  };

  const title = name ?? 'GAN plugin';

  return (
    <div className="h-full w-full min-h-0 flex flex-col overflow-hidden bg-[#07080c]">
      <div className="flex items-center gap-2 px-2 py-1 shrink-0">
        <Blocks className="w-3 h-3 text-indigo-300 shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-widest text-indigo-300 truncate">{title}</span>
        <button
          onClick={togglePopOut}
          title={win ? 'Pop the plugin back into the app' : 'Pop out into its own window (like a VST editor)'}
          aria-label={win ? 'Pop plugin back in' : 'Pop plugin out into its own window'}
          aria-pressed={!!win}
          className="ml-auto inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-indigo-300 transition-colors shrink-0"
        >
          <ExternalLink className="w-3.5 h-3.5" /> {win ? 'Pop back in' : 'Pop out'}
        </button>
      </div>
      {popupBlocked && !win && (
        <div className="mx-2 mb-1 px-2 py-1 rounded border border-amber-500/50 bg-amber-500/15 text-amber-200 text-[9px] font-mono shrink-0">
          Pop-up blocked — allow pop-ups for this site, then click Pop out again.
        </div>
      )}
      {win ? (
        <>
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-indigo-200">
            <ExternalLink className="w-5 h-5" />
            <span className="text-[10px] font-mono uppercase tracking-widest">
              {name ?? 'Plugin'} is in a separate window
            </span>
            <button
              onClick={() => setWin(null)}
              className="px-3 py-1.5 rounded border border-indigo-500/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25 text-[9px] font-black uppercase tracking-widest"
            >
              Pop back in
            </button>
          </div>
          <DetachableWindow win={win} title={`theDAW — ${title}`} onClose={() => setWin(null)}>
            <div className="h-full w-full flex flex-col overflow-hidden bg-[#07080c]">
              <GanFrame key={url} url={url} name={title} />
            </div>
          </DetachableWindow>
        </>
      ) : (
        <GanFrame key={url} url={url} name={title} id="gan-stage-frame" />
      )}
    </div>
  );
}
