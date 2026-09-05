import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createScoreClock, type ScoreClock } from '../../scoreTimeMap';
import { usePlayAlongStore } from '../../../../state/playAlongStore';
import { usePlayerStore } from '../../../../state/playerStore';
import { useLibraryStore } from '../../../../state/libraryStore';
import type { LibraryEntry } from '../../../../state/libraryEntry';
import { logError } from '../../../../state/logStore';

/** The play-along clock: the score clock (audible position, output latency
 *  removed) with the user's per-device offset folded in, so no view has to
 *  know the offset exists. Positive userOffsetMs = visuals later. */
export interface PlayAlongClock {
  /** Song time for drawing this frame, seconds. */
  read: () => number;
  /** Song time for judging an input event, seconds (input offset, not the
   *  visual one). Reserved for the Wave 4 judge. */
  readForJudge: () => number;
  /** Forget the extrapolation state after a seek or a track change. */
  reset: () => void;
}

export function createPlayAlongClock(): PlayAlongClock {
  const base: ScoreClock = createScoreClock();
  return {
    read: () => Math.max(0, base.read() - usePlayAlongStore.getState().userOffsetMs / 1000),
    readForJudge: () => Math.max(0, base.read() - usePlayAlongStore.getState().inputOffsetMs / 1000),
    reset: () => base.reset(),
  };
}

export interface PlayAlongHandle {
  /** The global player is holding THIS entry's audio. */
  isSameTrack: boolean;
  isPlaying: boolean;
  /** The player is holding a different track, so the view is parked. */
  otherTrackLoaded: boolean;
  /** Play/pause this entry; loads it into the player first when needed. */
  onTransport: () => Promise<void>;
  seek: (sec: number) => void;
  clock: PlayAlongClock;
}

/**
 * One frame callback against the play-along clock, exactly the way the PAGE
 * view drives its cursor: a rAF loop while our engine plays THIS entry (the
 * store only refreshes currentTime on 'timeupdate', ~4 Hz, far too coarse),
 * and a store subscription while paused so a seek lands the visuals under the
 * scrub head without burning a frame loop on an idle tab.
 *
 * `onFrame` is held in a ref, so an inline closure is fine. It re-checks the
 * engine's entry every frame: the engine can change track underneath a
 * mounted view.
 */
export function usePlayAlong(
  entry: LibraryEntry | null,
  onFrame: (sec: number) => void,
  opts?: { enabled?: boolean },
): PlayAlongHandle {
  const enabled = opts?.enabled ?? true;
  const entryId = entry?.id ?? null;
  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  // The EDIT timeline loads under the sentinel id 'editor-timeline', which can
  // never equal a library entry id, so its live transport is excluded here.
  const isSameTrack = !!entryId && engineEntryId === entryId;
  const otherTrackLoaded = !!entryId && !!engineEntryId && !isSameTrack;

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  // One clock per mount, created lazily: createScoreClock touches the audio
  // engine, which should not happen just because a view rendered.
  const clockRef = useRef<PlayAlongClock | null>(null);
  const getClock = useCallback((): PlayAlongClock => {
    if (!clockRef.current) clockRef.current = createPlayAlongClock();
    return clockRef.current;
  }, []);

  const frame = useCallback(() => {
    if (!entryId || usePlayerStore.getState().currentEntryId !== entryId) return;
    onFrameRef.current(getClock().read());
  }, [entryId, getClock]);

  // While playing: one rAF per frame.
  useEffect(() => {
    if (!enabled || !isSameTrack || !isPlaying) return;
    let raf = 0;
    const tick = () => {
      frame();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, isSameTrack, isPlaying, frame]);

  // While paused: seek() and seekByFraction() set currentTime synchronously,
  // so a subscription is enough to redraw under the scrub head.
  useEffect(() => {
    if (!enabled || !isSameTrack) return;
    getClock().reset();
    frame();
    return usePlayerStore.subscribe((s, prev) => {
      if (s.isPlaying) return;
      if (s.currentTime === prev.currentTime && s.currentEntryId === prev.currentEntryId) return;
      clockRef.current?.reset();
      frame();
    });
  }, [enabled, isSameTrack, frame, getClock]);

  // A change of the user's offset must show while paused too.
  useEffect(() => {
    if (!enabled || !isSameTrack) return;
    return usePlayAlongStore.subscribe((s, prev) => {
      if (s.userOffsetMs === prev.userOffsetMs) return;
      if (usePlayerStore.getState().isPlaying) return;
      frame();
    });
  }, [enabled, isSameTrack, frame]);

  // Play/pause the view's own track. When the engine holds something else the
  // same button loads this entry first, through the established library path,
  // so the footer and the visuals are never following different audio.
  const onTransport = useCallback(async () => {
    if (!entry) return;
    if (usePlayerStore.getState().currentEntryId === entry.id) {
      usePlayerStore.getState().toggle();
      return;
    }
    try {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      await usePlayerStore.getState().load(blob, { label: entry.title, entryId: entry.id });
      usePlayerStore.getState().play();
    } catch (e) {
      logError('score', `Could not load "${entry.title}" for play-along: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [entry]);

  const seek = useCallback((sec: number) => {
    usePlayerStore.getState().seek(sec);
  }, []);

  // Stable handle object so the clock getter is the same across renders; the
  // clock itself is created on first access.
  const clock = useMemo<PlayAlongClock>(
    () => ({
      read: () => getClock().read(),
      readForJudge: () => getClock().readForJudge(),
      reset: () => clockRef.current?.reset(),
    }),
    [getClock],
  );

  return { isSameTrack, isPlaying, otherTrackLoaded, onTransport, seek, clock };
}
