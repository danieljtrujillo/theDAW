/**
 * What each row of the footer track menu does. TrackMenu imports this module
 * on the first choice, so the footer does not load every workspace's stores
 * at boot. The menu only calls a row it built as enabled; the checks here are
 * for the few facts that can change between the menu opening and the click.
 *
 * A row that replaces something (the piano roll's notes, the lyrics, the
 * entry itself) asks first, before anything starts. Long jobs log when they
 * start and when they end (the LOG panel), and a row whose result lives on
 * another tab switches there when the result is ready.
 */
import type { LibraryEntry } from '../../state/libraryEntry';
import { useLibraryStore } from '../../state/libraryStore';
import { usePlayerStore } from '../../state/playerStore';
import { useAppUiStore, type CenterTab } from '../../state/appUiStore';
import { useBottomPanelStore, type BottomPanelTab } from '../../state/bottomPanelStore';
import { useAdvancedEditorSourceStore } from '../../state/advancedEditorStore';
import { useStudioStore } from '../../state/studioStore';
import { useMorphStore } from '../../state/morphEngine';
import { useMetamorphPanelRequest } from '../../state/metamorphPanelRequestStore';
import { useShardIndexStore } from '../../state/shardIndexStore';
import { useNodefiStore } from '../../state/nodefiStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { useVirtuosoStore } from '../../state/virtuosoStore';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { artifactTake } from '../../lib/takeNotes';
import { importTake } from '../../lib/rollTakes';
import { useMidiSongBoxRequest } from '../../state/midiSongBoxStore';
import { useDjSideList } from '../../state/djSideListStore';
import { useDjSampler } from '../../state/djSamplerStore';
import { useSetlistStore } from '../../state/setlistStore';
import { useDjDeckLoad } from '../../state/djDeckLoadStore';
import { sendToDjAutomix } from '../../state/djAutomixStore';
import { useMediaBucketStore } from '../../state/mediaBucketStore';
import { usePlayAlongStore } from '../../state/playAlongStore';
import { useFeatureToggleStore } from '../../state/featureToggleStore';
import { useEditorStore, beginUndoStep, computePeaks } from '../../state/editorStore';
import { planStemInsert, skippedAggregatesNote, stemClipPlacement } from './clipDoubleClick';
import { useLyricsStore } from '../../state/lyricsStore';
import { useTrackMenuJobs } from '../../state/trackMenuJobStore';
import { sendTrackToVj } from '../../state/vjSetBus';
import { startQueue } from '../../state/playlistQueue';
import { logError, logInfo, logWarn } from '../../state/logStore';
import {
  midiIdToSendable,
  sendAudioToChimera,
  sendAudioToEditor,
  sendAudioToInit,
  sendAudioToInpaint,
  sendMidiIdToTarget,
  stemRowToSendable,
  type SendableAudio,
} from '../../lib/sendToTargets';
import { sunoActions } from '../../suno/sunoActions';
import { ensureStems, listStems, type SeparateOpts } from '../../lib/djStems';
import { fetchRhythm } from '../../lib/rhythmSeed';
import {
  LyricsUnavailableError,
  importLyrics,
  lyricsExportUrl,
  pollLyricsJob,
  pollVocalJob,
  startAlign,
  startTranscribe,
} from '../../lib/lyricsClient';
import { pollLyricAnalysisJob, startLyricAnalysis } from '../../lib/lyricAnalysisClient';
import {
  convertMidiToMusicXml,
  exportArtifact,
  listNotationArtifacts,
  makeArrangement,
  makeChordTrack,
  makeTabs,
  notationPackUrl,
} from '../../lib/notationClient';
import { refreshCoverArt } from '../../lib/mediaLibrary';
import { saveFile } from '../../lib/saveFile';
import { saveWholeLineage } from '../../lib/lineageFamily';
import { convertLibraryEntry, entryAudioFileName, entryFileName, loadConvertFormats } from '../../convert/convertClient';
import { placesApi } from '../../lib/placesClient';
import { backendHttpBase } from '../../lib/backendBase';
import { fetchMidiBytesWithRetry } from '../../lib/fetchRetry';
import { fetchVocalArtifact, type ArtifactNote } from '../../lib/vocalExport';
import { deriveLyrics, deriveStyle } from '../../catalog/catalogSearch';
import {
  audioExtForMime,
  parseStemRowId,
  type TrackMenuRow,
  type TrackMenuRunningJob,
  type TrackMenuStem,
  type TrackMenuSubjectKind,
} from './trackMenuModel';

const SRC = 'track-menu';

export interface TrackMenuSubject {
  kind: TrackMenuSubjectKind;
  /** The footer's label for the track. */
  label: string;
  entry: LibraryEntry | null;
  /** Object URL of the loaded bytes, for a track that is not a library entry. */
  loadedUrl: string | null;
}

export interface TrackMenuActionContext {
  /** The audio file's absolute path, when the probe found one. */
  audioPath: string | null;
  /** The entry's stems, as the probe listed them. */
  stems: TrackMenuStem[];
  /** The lyrics text the backend serves for the entry ('' when none). */
  lyricsText: string;
  /** What the Stop row stops. */
  runningJob: TrackMenuRunningJob;
  /** The stem settings picked in the stems dialog for this run. */
  stemOptions?: SeparateOpts;
  /** The file picked for Load lyrics. */
  lyricsFile?: File;
  openLineage: (entryId: string) => void;
  openMetaEditor: (entry: LibraryEntry) => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const openCenter = (tab: CenterTab) => useAppUiStore.getState().setCenterTab(tab);
const openDock = (tab: BottomPanelTab) => useBottomPanelStore.getState().showTab(tab);

const selectAndOpen = (entryId: string, tab: BottomPanelTab) => {
  useLibraryStore.getState().setSelectedEntry(entryId);
  openDock(tab);
};

/** SCORE re-reads its artifact list when the selected entry changes. A job's new
 *  artifact on the entry that is already selected needs that change to show. */
const showScoreFor = (entryId: string) => {
  const lib = useLibraryStore.getState();
  if (lib.selectedEntryId === entryId) {
    lib.setSelectedEntry(null);
    window.setTimeout(() => useLibraryStore.getState().setSelectedEntry(entryId), 0);
  } else {
    lib.setSelectedEntry(entryId);
  }
  openDock('score');
};

/** The route's own error text when it sent one. */
async function answerError(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = body && typeof body.detail === 'string' ? body.detail : null;
  return new Error(detail ? `${what} answered ${res.status}: ${detail}` : `${what} answered ${res.status}`);
}

async function readBlob(subject: TrackMenuSubject): Promise<Blob> {
  if (subject.entry) return useLibraryStore.getState().fetchAudioBlob(subject.entry);
  if (!subject.loadedUrl) throw new Error('the footer holds no readable audio for this track');
  const res = await fetch(subject.loadedUrl);
  if (!res.ok) throw new Error(`reading the loaded audio failed (${res.status})`);
  return res.blob();
}

const fileNameFor = (subject: TrackMenuSubject, blob: Blob): string =>
  subject.entry ? entryAudioFileName(subject.entry) : entryFileName(subject.label, audioExtForMime(blob.type), 'track');

const sendable = (subject: TrackMenuSubject): SendableAudio => ({
  label: subject.entry?.title || subject.label || 'track',
  fetcher: () => readBlob(subject),
  mimeType: subject.entry?.mimeType,
  entryId: subject.entry?.id,
});

const requireEntry = (subject: TrackMenuSubject): LibraryEntry => {
  if (!subject.entry) throw new Error('it is not a library entry');
  return subject.entry;
};

/** The settings picked in the stems dialog, else the saved stem defaults. */
const stemOptions = (ctx: TrackMenuActionContext): SeparateOpts => {
  if (ctx.stemOptions) return ctx.stemOptions;
  const s = useFeatureToggleStore.getState().settings.stems;
  const count = ([2, 4, 6, 12] as const).find((n) => n === s.default_count) ?? 4;
  return { stems: count, device: s.device, quality: s.quality };
};

async function copyText(text: string, what: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  logInfo(SRC, `Copied the ${what}`);
}

/**
 * Notes in milliseconds into the piano roll (lib/rollTakes), at the ticks they
 * were heard on: never snapped to 16ths, since APPLY is where the roll
 * quantises. The roll takes the track's tempo with its fraction, so each note
 * plays at the second it sits at in the track.
 */
const importTakeToRoll = (notes: ArtifactNote[], bpm: number, prefix: string): void => {
  importTake(artifactTake(notes), bpm, prefix);
};

/** A playlist that flows by key and BPM from the entry, the entry first. */
export async function suggestFrom(entry: LibraryEntry): Promise<Array<{ id: string; title: string }>> {
  const res = await fetch('/api/library/suggest-playlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seed_id: entry.id, target_duration_sec: 3600, harmonic: true, flow: 'steady' }),
  });
  if (!res.ok) throw await answerError(res, 'the playlist suggester');
  const body = (await res.json()) as { tracks?: Array<{ id: string; title?: string }>; reason?: string };
  const rest = (body.tracks ?? []).filter((t) => t.id && t.id !== entry.id);
  if (rest.length === 0) throw new Error(body.reason || 'the suggester found no analyzed track to follow it');
  // The suggester answers over the WHOLE library, so most of what it names is
  // on no loaded page: `entries` cannot title those, and they used to show as
  // raw uuids. Ask the store by id instead — one fetch per row it has to go
  // and get, all of them at once, bounded by the suggester's own result size.
  const lib = useLibraryStore.getState();
  const rows = await Promise.all(
    rest.map(async (t) => {
      if (t.title) return { id: t.id, title: t.title };
      const known = lib.getById(t.id) ?? (await lib.ensureEntry(t.id));
      return { id: t.id, title: known?.title || t.id };
    }),
  );
  return [{ id: entry.id, title: entry.title }, ...rows];
}

/**
 * Star / unstar an entry and confirm the change landed. The store logs a failed
 * save and resolves, so the RECORD is what says whether it worked — and that
 * record has to be read BY ID: a row on an evicted page is in no `entries`, so
 * checking there reported "saved" for every one of them.
 */
export async function toggleFavoriteChecked(entryId: string, starring: boolean): Promise<void> {
  await useLibraryStore.getState().toggleFavorite(entryId);
  const lib = useLibraryStore.getState();
  const now = lib.getById(entryId) ?? (await lib.ensureEntry(entryId));
  if (now && now.favorite !== starring) throw new Error('the library did not save the change');
}

/** A point near the top left of what the NodeF.I. canvas shows, in graph units. */
const nodefiDropPoint = (offset: number) => {
  const { x, y, zoom } = useNodefiStore.getState().viewport;
  const z = zoom || 1;
  return { x: (120 - x) / z, y: (120 + offset - y) / z };
};

async function firstArtifact(entryId: string, kinds: string[]): Promise<{ id: string; kind: string }> {
  const artifacts = await listNotationArtifacts(entryId);
  for (const kind of kinds) {
    const hit = artifacts.find((a) => a.kind === kind);
    if (hit) return hit;
  }
  throw new Error(`it has no ${kinds.join(' or ')} artifact yet`);
}

/** LOOM shards for the entry, cutting them when it has none. The shard store
 *  logs its own failure and answers an empty list, so the status tells a
 *  failed cut from a track with no bars. */
async function shardsFor(entryId: string): Promise<number> {
  const rows = await useShardIndexStore.getState().ensureEntry(entryId, { run: true });
  if (rows.length === 0 && useShardIndexStore.getState().status[entryId] === 'error') {
    throw new Error('LOOM could not cut its shards');
  }
  return rows.length;
}

/** The question a row asks before it runs, or null to run at once. */
function questionFor(row: TrackMenuRow, subject: TrackMenuSubject, ctx: TrackMenuActionContext, title: string): string | null {
  const rollNotes = usePianoRollStore.getState().notes.length;
  const replacingRoll = rollNotes > 0 ? `Replace the ${rollNotes} note${rollNotes === 1 ? '' : 's'} in the piano roll` : null;
  switch (row.id) {
    case 'midi-detect':
      return replacingRoll && `${replacingRoll} with the notes detected in "${title}"?`;
    case 'melody-roll':
      return replacingRoll && `${replacingRoll} with the vocal melody of "${title}"?`;
    case 'load-lyrics': {
      const has = !!(ctx.lyricsText.trim() || subject.entry?.lyrics?.trim());
      return has ? `Replace the lyrics of "${title}" with ${ctx.lyricsFile?.name ?? 'the chosen file'}?` : null;
    }
    case 'delete':
      return `Delete "${title}" and its files from the library? This cannot be undone.`;
    default:
      return null;
  }
}

async function runStemKey(
  action: string,
  stemId: string,
  subject: TrackMenuSubject,
  ctx: TrackMenuActionContext,
): Promise<void> {
  const entry = requireEntry(subject);
  const stem = ctx.stems.find((s) => s.id === stemId);
  if (!stem) throw new Error('that stem is no longer listed');
  const audio = stemRowToSendable({ id: stem.id, stem_name: stem.name, parent_title: entry.title });
  switch (action) {
    case 'edit':
      openCenter('edit');
      await sendAudioToEditor(audio, 'editor-new-track');
      return;
    case 'init':
      openCenter('make');
      await sendAudioToInit(audio);
      return;
    case 'inpaint':
      openCenter('make');
      await sendAudioToInpaint(audio);
      return;
    case 'chimera':
      openCenter('make');
      await sendAudioToChimera([audio]);
      return;
    case 'save':
      await saveFile({
        url: `/api/library/stems/${encodeURIComponent(stem.id)}/audio`,
        suggestedName: entryFileName(`${entry.title} - ${stem.name}`, stem.ext || 'wav'),
        kind: 'audio',
      });
      return;
    default:
      throw new Error(`no action is wired for stem key ${action}`);
  }
}

async function run(row: TrackMenuRow, subject: TrackMenuSubject, ctx: TrackMenuActionContext, title: string): Promise<void> {
  if (row.id.startsWith('convert:')) {
    const formatId = row.id.slice('convert:'.length);
    const catalog = await loadConvertFormats();
    const format = catalog.formats.find((f) => f.id === formatId);
    if (!format) throw new Error(`FFmpeg no longer lists ${formatId}`);
    if (subject.entry) {
      await convertLibraryEntry(subject.entry.id, format, subject.entry.title);
      return;
    }
    const blob = await readBlob(subject);
    const form = new FormData();
    form.append('file', blob, entryFileName(subject.label, audioExtForMime(blob.type), 'track'));
    form.append('format', format.id);
    const res = await fetch('/api/convert/file', { method: 'POST', body: form });
    if (!res.ok) throw await answerError(res, 'conversion');
    const out = new Blob([await res.arrayBuffer()], { type: res.headers.get('content-type') ?? format.mime });
    await saveFile({ blob: out, suggestedName: entryFileName(subject.label, format.ext, 'converted'), kind: format.kind });
    return;
  }

  const stemKey = parseStemRowId(row.id);
  if (stemKey) {
    await runStemKey(stemKey.action, stemKey.stemId, subject, ctx);
    return;
  }

  switch (row.id) {
    /* ── play ── */
    case 'play-library': {
      const entry = requireEntry(subject);
      const ids = useLibraryStore.getState().getFiltered().map((e) => e.id);
      let at = ids.indexOf(entry.id);
      if (at < 0) {
        ids.unshift(entry.id);
        at = 0;
      }
      await startQueue(ids, at);
      return;
    }
    case 'play-mix': {
      const list = await suggestFrom(requireEntry(subject));
      await startQueue(list.map((t) => t.id), 0);
      logInfo(SRC, `Playing a ${list.length}-track mix built from "${title}"`);
      return;
    }

    /* ── open in ── */
    case 'edit-new-track':
    case 'edit-append':
      openCenter('edit');
      await sendAudioToEditor(sendable(subject), row.id === 'edit-new-track' ? 'editor-new-track' : 'editor-first-track');
      return;
    case 'edit-stems': {
      const entry = requireEntry(subject);
      const opts = stemOptions(ctx);
      const refs = await ensureStems(entry.id, opts);
      if (refs.length === 0) throw new Error('separation produced no stems');
      // Sums of the other stems (`drums` over the LARSNET kit parts,
      // `no_vocals` over everything but the vocal) are left off: placing one
      // beside its members puts that audio in EDIT twice at double level. A
      // run that reports no roles at all is placed whole, as before.
      const plan = planStemInsert(refs);
      // Download and decode everything first, so the store writes below land in
      // one coalescing burst and the whole batch is a single undo step.
      const decoded: Array<{ name: string; blob: Blob; peaks: Float32Array; duration: number }> = [];
      for (const ref of plan.insert) {
        const res = await fetch(ref.url);
        if (!res.ok) {
          logWarn(SRC, `Stem ${ref.name} of "${title}" could not be read (${res.status})`);
          continue;
        }
        const blob = await res.blob();
        const { peaks, duration } = await computePeaks(blob, 240);
        decoded.push({ name: ref.name, blob, peaks, duration });
      }
      if (decoded.length === 0) throw new Error('no stem audio could be read');
      // There is no parent clip on the timeline here, so the stems go in at the
      // EDIT CURSOR — where the user is working — rather than at 0, which would
      // bury them under whatever already starts the arrangement.
      const startSec = Math.max(0, useEditorStore.getState().editCursorSec);
      beginUndoStep();
      for (const { name: stemName, blob, peaks, duration } of decoded) {
        const editor = useEditorStore.getState();
        const name = `${entry.title} · ${stemName}`;
        const trackId = editor.addTrack({ name });
        const color = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#8b5cf6';
        const clipId = editor.addClipToTrack({
          trackId,
          label: name,
          audioBlob: blob,
          mimeType: 'audio/wav',
          sourceDuration: duration,
          // The whole stem, from its head, at the cursor: the same placement
          // helper the timeline's explode path uses, given a full-length window.
          ...stemClipPlacement({ startSec, durationSec: duration, offsetIntoSource: 0 }, duration, startSec),
          color,
        });
        editor.cachePeaks(clipId, peaks);
      }
      const placed = decoded.length;
      const note = skippedAggregatesNote(plan.skipped);
      logInfo(
        SRC,
        `Placed ${placed} stem track${placed === 1 ? '' : 's'} of "${title}" in EDIT at ${startSec.toFixed(2)}s`
        + ` (${opts.stems}-stem, ${opts.quality})${note ? ` — ${note}` : ''}`,
      );
      openCenter('edit');
      return;
    }
    case 'mix-source': {
      openCenter('mix');
      const blob = await readBlob(subject);
      const file = new File([blob], fileNameFor(subject, blob), { type: blob.type || subject.entry?.mimeType || 'audio/wav' });
      // The footer already holds this audio, so the player is left as it is
      // (MIX's own file picker also loads the file into the footer).
      useAdvancedEditorSourceStore.getState().setSource(file);
      useStudioStore.getState().setSourceFile(file);
      logInfo(SRC, `"${title}" is the MIX source`);
      return;
    }
    case 'morph-a':
    case 'morph-b': {
      openCenter('edit');
      const blob = await readBlob(subject);
      const source = { id: subject.entry ? `lib:${subject.entry.id}` : `footer:${subject.label}`, title, blob };
      if (row.id === 'morph-a') await useMorphStore.getState().loadA(source);
      else await useMorphStore.getState().loadB(source);
      useMetamorphPanelRequest.getState().request();
      return;
    }
    case 'loom-crate': {
      const entry = requireEntry(subject);
      useShardIndexStore.getState().addToCrate(entry.id);
      openCenter('loom');
      const count = await shardsFor(entry.id);
      logInfo(SRC, `"${title}" is in the LOOM crate with ${count} shard${count === 1 ? '' : 's'}`);
      return;
    }
    case 'nodefi-library': {
      const entry = requireEntry(subject);
      const nodefi = useNodefiStore.getState();
      const at = nodefiDropPoint(0);
      const id = nodefi.addNode('input', at.x, at.y);
      nodefi.updateParam(id, 'libraryId', entry.id);
      openCenter('nodefi');
      return;
    }
    case 'nodefi-stems': {
      const entry = requireEntry(subject);
      const stems = await listStems(entry.id);
      if (stems.length === 0) throw new Error('it has no stems yet');
      const nodefi = useNodefiStore.getState();
      stems.forEach((stem, i) => {
        const at = nodefiDropPoint(i * 110);
        const id = nodefi.addNode('stem', at.x, at.y);
        nodefi.updateParam(id, 'libraryId', entry.id);
        nodefi.updateParam(id, 'stem', stem.name);
      });
      openCenter('nodefi');
      return;
    }
    case 'sway':
      openCenter('sway');
      return;
    case 'vj-send': {
      const entry = requireEntry(subject);
      sendTrackToVj({ entryId: entry.id, label: entry.title, url: entry.audioUrl, kind: 'audio' });
      logInfo(SRC, `Sent "${title}" to the VJ set`);
      return;
    }
    case 'media-bucket': {
      const blob = await readBlob(subject);
      useMediaBucketStore.getState().add(new File([blob], fileNameFor(subject, blob), { type: blob.type || 'audio/wav' }));
      return;
    }

    /* ── dock ── */
    case 'dock-details': {
      const entry = requireEntry(subject);
      useLibraryStore.getState().setSelectedEntry(entry.id);
      const panel = useBottomPanelStore.getState();
      if (panel.detailsPane === 'media') panel.setDetailsPane('split');
      openDock('details');
      return;
    }
    case 'dock-score':
      selectAndOpen(requireEntry(subject).id, 'score');
      return;
    case 'dock-sing': {
      const panel = useBottomPanelStore.getState();
      if (panel.singPane === 'score') panel.setSingPane('sing');
      selectAndOpen(requireEntry(subject).id, 'sing');
      return;
    }
    case 'dock-study':
      useBottomPanelStore.getState().setSingPane('analysis');
      selectAndOpen(requireEntry(subject).id, 'sing');
      return;
    case 'dock-lyric':
      selectAndOpen(requireEntry(subject).id, 'lyric');
      return;
    case 'dock-midi': {
      // The song box is MidiPanel's own state: the request puts this entry in
      // it whatever the box held, when the panel mounts or at once.
      const entry = requireEntry(subject);
      useMidiSongBoxRequest.getState().request(entry.id);
      selectAndOpen(entry.id, 'midi');
      return;
    }
    case 'dock-draw':
      selectAndOpen(requireEntry(subject).id, 'draw');
      return;
    case 'dock-levels':
      openDock('levels');
      return;
    case 'dock-spectral':
      openDock('spectral');
      return;

    /* ── MAKE ── */
    case 'make-init':
      openCenter('make');
      await sendAudioToInit(sendable(subject));
      return;
    case 'make-inpaint':
      openCenter('make');
      await sendAudioToInpaint(sendable(subject));
      return;
    case 'make-chimera':
      openCenter('make');
      await sendAudioToChimera([sendable(subject)]);
      return;
    case 'make-prompt': {
      const entry = requireEntry(subject);
      const res = await fetch(`/api/analysis/${encodeURIComponent(entry.id)}/prompt`);
      if (!res.ok) throw res.status === 404 ? new Error('it has no analysis yet') : await answerError(res, 'prompt inference');
      const body = (await res.json()) as { prompt_guess?: string };
      if (!body.prompt_guess) throw new Error('the analysis gave no prompt');
      useGenerateParamsStore.getState().setField('prompt', body.prompt_guess);
      openCenter('make');
      logInfo(SRC, `The prompt inferred from "${title}" is in the MAKE prompt field`);
      return;
    }
    case 'suno-cover':
      sunoActions.sendToCover(requireEntry(subject));
      return;
    case 'suno-mashup':
      sunoActions.sendToMashup(requireEntry(subject));
      return;

    /* ── MIDI ── */
    case 'midi-convert': {
      const entry = requireEntry(subject);
      const fromStems = useFeatureToggleStore.getState().settings.midi.from_stems;
      const res = await fetch(`/api/midi/${encodeURIComponent(entry.id)}/run?from_stems=${fromStems ? 'true' : 'false'}`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        detail?: unknown;
        results?: Array<{ ok?: boolean; error?: string }>;
      };
      if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `MIDI conversion answered ${res.status}`);
      const results = body.results ?? [];
      const failed = results.filter((r) => !r.ok);
      if (body.status === 'failed') throw new Error(failed[0]?.error || 'no MIDI engine is installed');
      if (body.status === 'partial') {
        logWarn(SRC, `Convert to MIDI for "${title}": ${failed.length} of ${results.length} targets failed (${failed[0]?.error ?? 'no detail'})`);
      } else {
        logInfo(SRC, `Converted "${title}" to MIDI (${results.length} target${results.length === 1 ? '' : 's'})`);
      }
      return;
    }
    case 'midi-roll':
      await sendMidiIdToTarget(`${requireEntry(subject).id}__full`, 'piano-roll');
      return;
    case 'midi-step':
      await sendMidiIdToTarget(`${requireEntry(subject).id}__full`, 'step-seq');
      return;
    case 'midi-groove': {
      const entry = requireEntry(subject);
      const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${encodeURIComponent(`${entry.id}__full`)}`, { label: entry.title });
      if (!useVirtuosoStore.getState().setGrooveFromBytes(buf, entry.title)) throw new Error('its MIDI has no notes to learn from');
      openDock('midi');
      logInfo(SRC, `The Virtuoso groove now follows "${title}"`);
      return;
    }
    case 'midi-detect': {
      const blob = await readBlob(subject);
      const form = new FormData();
      form.append('file', blob, fileNameFor(subject, blob));
      const res = await fetch('/api/vocal/audio-to-notes', { method: 'POST', body: form });
      if (!res.ok) throw await answerError(res, 'note detection');
      const body = (await res.json()) as { notes?: ArtifactNote[] };
      const notes = body.notes ?? [];
      if (notes.length === 0) throw new Error('no notes were detected');
      // importNotes, not placeRecording: a whole track is longer than the
      // roll's default grid, and importNotes fits the grid to the notes.
      importTakeToRoll(notes, usePianoRollStore.getState().bpm || 120, 'detect');
      openDock('midi');
      logInfo(SRC, `Put ${notes.length} notes detected in "${title}" in the piano roll (${usePianoRollStore.getState().totalSteps} steps)`);
      return;
    }
    case 'melody-roll': {
      const entry = requireEntry(subject);
      const doc = await fetchVocalArtifact(entry.id);
      if (!doc) throw new Error('it has no vocal melody yet');
      if (doc.notes.length === 0) throw new Error('its vocal melody has no notes');
      importTakeToRoll(doc.notes, doc.timing?.tempo_bpm || usePianoRollStore.getState().bpm || 120, 'melody');
      openDock('midi');
      logInfo(SRC, `Put the ${doc.notes.length} notes of the vocal melody of "${title}" in the piano roll`);
      return;
    }
    case 'synth-edit':
    case 'synth-init':
    case 'synth-inpaint':
    case 'synth-chimera': {
      const entry = requireEntry(subject);
      const audio = midiIdToSendable(`${entry.id}__full`, `${entry.title} (MIDI synth)`);
      if (row.id === 'synth-edit') {
        openCenter('edit');
        await sendAudioToEditor(audio, 'editor-new-track');
      } else if (row.id === 'synth-init') {
        openCenter('make');
        await sendAudioToInit(audio);
      } else if (row.id === 'synth-inpaint') {
        openCenter('make');
        await sendAudioToInpaint(audio);
      } else {
        openCenter('make');
        await sendAudioToChimera([audio]);
      }
      return;
    }

    /* ── analyze and extract ── */
    case 'run-analysis': {
      const entry = requireEntry(subject);
      const res = await fetch(`/api/analysis/${encodeURIComponent(entry.id)}/run`, { method: 'POST' });
      if (!res.ok) throw await answerError(res, 'analysis');
      const body = (await res.json()) as { bpm?: number | null; key?: string | null; scale?: string | null };
      const bits = [body.bpm ? `${Math.round(body.bpm)} BPM` : null, body.key ? `${body.key} ${body.scale ?? ''}`.trim() : null]
        .filter(Boolean)
        .join(', ');
      logInfo(SRC, `Analyzed "${title}"${bits ? `: ${bits}` : ''}`);
      await useLibraryStore.getState().refresh();
      return;
    }
    case 'run-stems': {
      const entry = requireEntry(subject);
      const opts = stemOptions(ctx);
      const refs = await ensureStems(entry.id, opts);
      logInfo(SRC, `"${title}" has ${refs.length} stem${refs.length === 1 ? '' : 's'} (${opts.stems}-stem, ${opts.quality})`);
      return;
    }
    case 'run-rhythm': {
      const result = await fetchRhythm(requireEntry(subject).id, { run: true });
      logInfo(SRC, `Meter map for "${title}": ${result.status}`);
      return;
    }
    case 'run-shards': {
      const count = await shardsFor(requireEntry(subject).id);
      logInfo(SRC, `"${title}" has ${count} LOOM shard${count === 1 ? '' : 's'}`);
      return;
    }
    case 'run-transcribe':
    case 'run-align': {
      const entry = requireEntry(subject);
      try {
        // Align sends the record's own lyrics field; without one the backend
        // aligns the words it serves for the entry (embedded or tagged).
        const { jobId } =
          row.id === 'run-transcribe'
            ? await startTranscribe(entry.id, { isolate: true })
            : await startAlign(entry.id, { isolate: true, text: entry.lyrics?.trim() || undefined });
        const job = await pollLyricsJob(jobId);
        if (job.status !== 'done') throw new Error(job.error || job.message || job.status);
      } catch (e) {
        if (e instanceof LyricsUnavailableError) {
          logWarn(SRC, 'Transcription is not installed yet. Install it from the SING tab, then try again');
          return;
        }
        throw e;
      }
      logInfo(SRC, `${row.id === 'run-transcribe' ? 'Transcribed' : 'Aligned'} the lyrics of "${title}"`);
      await useLibraryStore.getState().refresh();
      return;
    }
    case 'run-devices': {
      const started = await startLyricAnalysis(requireEntry(subject).id, { force: true, llm: false });
      if (!started.job) throw new Error('the lyric analysis did not start');
      const job = started.job.status === 'done' ? started.job : await pollLyricAnalysisJob(started.job.id);
      if (job.status !== 'done') throw new Error(job.error || job.message || job.status);
      logInfo(SRC, `Found the rhyme and wordplay in "${title}". Open Lyric study to read it`);
      return;
    }
    case 'run-melody': {
      const entry = requireEntry(subject);
      const res = await fetch('/api/vocal/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: entry.id, isolate: true, transcribe: false }),
      });
      if (!res.ok) throw await answerError(res, 'vocal preparation');
      const body = (await res.json()) as { job?: { id?: string }; job_id?: string; id?: string };
      const jobId = body.job?.id ?? body.job_id ?? body.id;
      if (!jobId) throw new Error('vocal preparation gave no job id');
      // The Stop row reads this while the job runs.
      useTrackMenuJobs.getState().setVocal(entry.id, jobId);
      let job;
      try {
        job = await pollVocalJob(jobId);
      } finally {
        if (useTrackMenuJobs.getState().vocal[entry.id] === jobId) useTrackMenuJobs.getState().setVocal(entry.id, null);
      }
      if (job.status === 'cancelled') {
        logInfo(SRC, `The vocal melody job for "${title}" was stopped`);
        return;
      }
      if (job.status !== 'done') throw new Error(job.error || job.message || job.status);
      logInfo(SRC, `Extracted the vocal melody of "${title}". Vocal notes into the roll loads it into the piano roll`);
      return;
    }
    case 'run-chords': {
      const entry = requireEntry(subject);
      await makeChordTrack(entry.id, { source: 'auto' });
      usePlayAlongStore.getState().setMode('chords');
      logInfo(SRC, `Built the chord track of "${title}"`);
      showScoreFor(entry.id);
      return;
    }
    case 'run-sheet': {
      const entry = requireEntry(subject);
      await convertMidiToMusicXml(entry.id, `${entry.id}__full`);
      logInfo(SRC, `Made sheet music of "${title}"`);
      showScoreFor(entry.id);
      return;
    }
    case 'run-tabs': {
      const entry = requireEntry(subject);
      const midi = await firstArtifact(entry.id, ['midi']);
      await makeTabs(entry.id, {
        source_artifact_id: midi.id,
        instrument: 'guitar',
        tuning_name: 'guitar-standard',
        capo: 0,
        difficulty: 'medium',
      });
      logInfo(SRC, `Arranged guitar tab of "${title}"`);
      showScoreFor(entry.id);
      return;
    }
    case 'run-arrange': {
      const entry = requireEntry(subject);
      const midi = await firstArtifact(entry.id, ['midi']);
      await makeArrangement(entry.id, { style: 'piano-reduction', source_artifact_id: midi.id });
      logInfo(SRC, `Arranged a piano reduction of "${title}"`);
      showScoreFor(entry.id);
      return;
    }
    case 'run-beatsaber': {
      const entry = requireEntry(subject);
      const source = await firstArtifact(entry.id, ['musicxml', 'midi']);
      await exportArtifact(entry.id, source.id, 'beatsaber', {
        difficulties: ['Normal', 'Hard'],
        bpm_source: 'analysis',
        version: 2,
        include_audio: true,
      });
      logInfo(SRC, `Exported a Beat Saber map of "${title}"`);
      showScoreFor(entry.id);
      return;
    }
    case 'stop-job': {
      const entry = requireEntry(subject);
      const { stems, vocalJobId } = ctx.runningJob;
      if (!stems && !vocalJobId) throw new Error('nothing is running for it');
      if (stems) {
        const res = await fetch(`/api/stems/${encodeURIComponent(entry.id)}/abort`, { method: 'POST' });
        if (!res.ok) throw await answerError(res, 'the stem separation stop');
        logInfo(SRC, `Asked the stem separation of "${title}" to stop`);
      }
      if (vocalJobId) {
        const res = await fetch(`/api/vocal/jobs/${encodeURIComponent(vocalJobId)}/cancel`, { method: 'POST' });
        if (!res.ok) throw await answerError(res, 'the vocal melody stop');
        logInfo(SRC, `Cancelled the vocal melody job for "${title}"`);
      }
      return;
    }

    /* ── DJ ── */
    case 'dj-deck-a':
    case 'dj-deck-b':
      useDjDeckLoad.getState().request(row.id === 'dj-deck-a' ? 'A' : 'B', requireEntry(subject).id);
      openCenter('dj');
      return;
    case 'dj-next': {
      const entry = requireEntry(subject);
      useDjSideList.getState().add({ entryId: entry.id, label: entry.title });
      logInfo(SRC, `Staged "${title}" in DJ Next`);
      return;
    }
    case 'dj-pad': {
      const entry = requireEntry(subject);
      const pads = useDjSampler.getState().pads;
      const free = Array.from({ length: 10 }, (_, i) => i).find((i) => !pads[i]);
      if (free === undefined) throw new Error('all sampler pads are taken');
      useDjSampler.getState().setPad(free, { entryId: entry.id, name: entry.title });
      logInfo(SRC, `"${title}" is on DJ sampler pad ${free === 9 ? 0 : free + 1}`);
      return;
    }
    case 'dj-set': {
      const entry = requireEntry(subject);
      const sets = useSetlistStore.getState();
      if (!sets.activeId) throw new Error('no DJ set is active');
      sets.append(sets.activeId, [{ entryId: entry.id, label: entry.title, kind: 'audio' }]);
      logInfo(SRC, `Appended "${title}" to the DJ set "${sets.setlists[sets.activeId]?.name ?? ''}"`);
      return;
    }
    case 'dj-automix': {
      const list = await suggestFrom(requireEntry(subject));
      sendToDjAutomix(list.map((t) => ({ entryId: t.id, label: t.title })));
      return;
    }

    /* ── save ── */
    case 'save-copy': {
      if (subject.entry) {
        await saveFile({
          url: useLibraryStore.getState().getAudioUrl(subject.entry),
          suggestedName: entryAudioFileName(subject.entry),
          kind: 'audio',
        });
        return;
      }
      const blob = await readBlob(subject);
      await saveFile({ blob, suggestedName: fileNameFor(subject, blob), kind: 'audio' });
      return;
    }
    case 'save-bundle': {
      const entry = requireEntry(subject);
      await saveFile({ url: `/api/library/${encodeURIComponent(entry.id)}/bundle`, suggestedName: entryFileName(entry.title, 'zip'), kind: 'zip' });
      return;
    }
    case 'save-midi': {
      const entry = requireEntry(subject);
      const res = await fetch(`/api/midi/file/${encodeURIComponent(`${entry.id}__full`)}`);
      if (!res.ok) throw await answerError(res, 'its MIDI file');
      await saveFile({ blob: await res.blob(), suggestedName: entryFileName(entry.title, 'mid'), kind: 'midi' });
      return;
    }
    case 'save-metadata': {
      const entry = requireEntry(subject);
      const blob = new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json' });
      await saveFile({ blob, suggestedName: entryFileName(entry.title, 'json'), kind: 'library-metadata' });
      return;
    }
    case 'save-lineage': {
      // The whole family, never the lineage window's capped answer; its size
      // goes to the status bar and the LOG before the Save dialog opens.
      const entry = requireEntry(subject);
      await saveWholeLineage(entry, entryFileName(`${entry.title}-lineage`, 'json'));
      return;
    }
    case 'save-lrc':
    case 'save-txt': {
      const entry = requireEntry(subject);
      const fmt = row.id === 'save-lrc' ? 'lrc' : 'txt';
      await saveFile({ url: lyricsExportUrl(entry.id, fmt), suggestedName: entryFileName(entry.title, fmt), kind: 'lyrics' });
      return;
    }
    case 'save-score-pack': {
      const entry = requireEntry(subject);
      const sheet = await firstArtifact(entry.id, ['musicxml']);
      await saveFile({ url: notationPackUrl(sheet.id), suggestedName: entryFileName(`${entry.title}_score`, 'zip'), kind: 'zip' });
      return;
    }
    case 'save-meter-map': {
      const entry = requireEntry(subject);
      const res = await fetch(`/api/rhythm/${encodeURIComponent(entry.id)}`);
      if (!res.ok) throw await answerError(res, 'the meter map');
      const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
      await saveFile({ blob, suggestedName: entryFileName(`${entry.title} - meter map`, 'json'), kind: 'meter-map' });
      return;
    }
    case 'save-spectrogram': {
      const audio = await readBlob(subject);
      // The audio goes up as a file part: the route's base64 text field is
      // capped at 1MB by the form parser, which a whole song passes.
      const form = new FormData();
      form.append('audio_file', audio, fileNameFor(subject, audio));
      const res = await fetch('/api/spectrogram', { method: 'POST', body: form });
      if (!res.ok) throw await answerError(res, 'the spectrogram');
      const body = (await res.json()) as { mel?: string };
      if (!body.mel) throw new Error('the spectrogram came back empty');
      const bytes = Uint8Array.from(atob(body.mel), (c) => c.charCodeAt(0));
      await saveFile({
        blob: new Blob([bytes], { type: 'image/png' }),
        suggestedName: entryFileName(`${title} mel spectrogram`, 'png'),
        kind: 'image',
      });
      return;
    }

    /* ── copy and show ── */
    case 'show-in-folder':
      if (!ctx.audioPath) throw new Error('its file path is not known');
      await placesApi.reveal(ctx.audioPath);
      return;
    case 'copy-path':
      if (!ctx.audioPath) throw new Error('its file path is not known');
      await copyText(ctx.audioPath, 'file path');
      return;
    case 'copy-link':
      await copyText(new URL(requireEntry(subject).audioUrl, backendHttpBase()).toString(), 'stream link');
      return;
    case 'copy-title':
      await copyText(title, 'title');
      return;
    case 'copy-prompt':
      await copyText(requireEntry(subject).prompt, 'prompt');
      return;
    case 'copy-style':
      await copyText(deriveStyle(requireEntry(subject)).trim(), 'style');
      return;
    case 'copy-lyrics': {
      const text = deriveLyrics(requireEntry(subject)).trim() || ctx.lyricsText.trim();
      if (!text) throw new Error('it has no lyrics');
      await copyText(text, 'lyrics');
      return;
    }

    /* ── library ── */
    case 'show-in-library': {
      const entry = requireEntry(subject);
      useLibraryStore.getState().setSelectedEntry(entry.id);
      useAppUiStore.getState().setRightPanelOpen(true);
      // The rail mounts LibraryView on its next render, and the listener that
      // selects the row, scrolls to it and opens DETAILS lives there.
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('thedaw:reveal-library-entry', { detail: { entryId: entry.id } }));
      }, 150);
      return;
    }
    case 'lineage-graph':
      ctx.openLineage(requireEntry(subject).id);
      return;
    case 'favorite': {
      const entry = requireEntry(subject);
      const starring = !entry.favorite;
      await toggleFavoriteChecked(entry.id, starring);
      if (starring) logInfo(SRC, `Starred "${title}". Stems, lyrics, MIDI and a score are queued for it`);
      return;
    }
    case 'like':
    case 'dislike': {
      const entry = requireEntry(subject);
      const rating = row.id === 'like' ? 'like' : 'dislike';
      await useLibraryStore.getState().setRating(entry.id, entry.rating === rating ? null : rating);
      return;
    }
    case 'edit-meta':
      ctx.openMetaEditor(requireEntry(subject));
      return;
    case 'load-lyrics': {
      const entry = requireEntry(subject);
      const file = ctx.lyricsFile;
      if (!file) throw new Error('no file was chosen');
      const text = await file.text();
      if (!text.trim()) throw new Error(`${file.name} is empty`);
      const fmt: 'lrc' | 'txt' = /\.lrc$/i.test(file.name) || /^\s*\[\d{1,2}:\d{2}/m.test(text) ? 'lrc' : 'txt';
      const lyrics = useLyricsStore.getState();
      if (lyrics.entryId === entry.id) {
        // SING has this entry open: its store imports, so SING shows the new words.
        await lyrics.importText(fmt, text);
        const failed = useLyricsStore.getState().error;
        if (failed) throw new Error(failed);
      } else {
        const saved = await importLyrics(entry.id, fmt, text);
        // Through the store's own action, not a raw `setState` of `entries`.
        // `entries` is a PROJECTION of the page cache: writing it directly left
        // the cached page row holding the old lyrics, so the next re-projection
        // (a page load, a filter change, a refresh) silently put them back.
        // `upsertEntry` patches the cache and re-projects, and — unlike
        // `updateEntry` — does not write to the backend a second time, which is
        // right here because `importLyrics` above already persisted them.
        useLibraryStore.getState().upsertEntry({ ...entry, lyrics: saved.text });
      }
      logInfo(SRC, `Loaded the lyrics of "${title}" from ${file.name}`);
      return;
    }
    case 'run-cover':
      await refreshCoverArt(requireEntry(subject).id);
      await useLibraryStore.getState().refresh();
      logInfo(SRC, `"${title}" uses the picture from its file as its cover`);
      return;
    case 'import': {
      const blob = await readBlob(subject);
      const ext = audioExtForMime(blob.type);
      const imported = await useLibraryStore.getState().importEntry({
        blob,
        filename: entryFileName(subject.label, ext, 'track'),
        mimeType: blob.type || `audio/${ext}`,
        metadata: { title: subject.label || 'Imported track', source: 'import' },
      });
      // A loose track the player still shows becomes that entry, so the menu
      // offers the library actions for it from now on.
      const player = usePlayerStore.getState();
      if (subject.kind === 'loose' && player.currentEntryId === null && player.currentLabel === subject.label) {
        usePlayerStore.setState({ currentEntryId: imported.id });
      }
      logInfo(SRC, `Saved "${title}" to the library`);
      return;
    }
    case 'delete': {
      const entry = requireEntry(subject);
      if (usePlayerStore.getState().currentEntryId === entry.id) usePlayerStore.getState().stop();
      await useLibraryStore.getState().removeEntry(entry.id);
      return;
    }

    default:
      throw new Error(`no action is wired for ${row.id}`);
  }
}

/** Run one menu row on the footer track. Failures land in the LOG. */
export async function runTrackMenuRow(
  row: TrackMenuRow,
  subject: TrackMenuSubject,
  ctx: TrackMenuActionContext,
): Promise<void> {
  if (!row.enabled) return;
  const title = subject.entry?.title || subject.label || 'the track';
  const question = questionFor(row, subject, ctx, title);
  if (question && !window.confirm(question)) return;
  if (row.longJob) logInfo(SRC, `${row.label}: started for "${title}"`);
  try {
    await run(row, subject, ctx, title);
  } catch (e) {
    logError(SRC, `${row.label} failed for "${title}": ${message(e)}`);
  }
}
