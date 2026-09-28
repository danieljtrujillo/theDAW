import { useAppUiStore } from '../state/appUiStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useGenerateStore } from '../state/generateStore';
import { useEditorStore } from '../state/editorStore';
import {
    referenceContextEntry,
    type AssistantReference,
    type AssistantReferenceContext,
} from '../state/assistantReferenceStore';
import { FEATURES } from '../onboarding/featureRegistry';

export type EditorClipKind = 'midi' | 'audio';
export type EditorTrackKind = 'midi' | 'audio' | 'mixed' | 'empty';

export type EditorSummary = {
    trackCount: number;
    clipCount: number;
    /** Clips whose sourceKind is 'piano-roll' — editable MIDI, pre-rendered to audio for playback. */
    midiClipCount: number;
    audioClipCount: number;
    bpm: number;
    /** Project meter. Bars — and therefore editor_seek_bar — are counted from it. */
    timeSignature: { num: number; den: number };
    /** Grid division clip edits snap to ('off' | '1/4' | '1/8' | '1/16' | …). */
    snap: string;
    /** Active edit tool ('move' | 'cut' | 'split'). */
    tool: string;
    playheadSec: number;
    isPlaying: boolean;
    selectedClipId: string | null;
    /** The full multi-clip selection. Tools that act on "the selection"
     *  (editor_loop_selection) read this, not selectedClipId. */
    selectedClipIds: string[];
    /** Names editor_restore will accept, so the model never guesses one. */
    snapshotNames: string[];
    loop: { enabled: boolean; startSec: number; endSec: number } | null;
    markers: Array<{ id: string; sec: number; label: string }>;
    tracks: Array<{
        id: string;
        name: string;
        /** 'midi' when every clip is piano-roll, 'audio' when every clip is audio, 'mixed', or 'empty'. */
        kind: EditorTrackKind;
        volume: number;
        pan: number;
        mute: boolean;
        solo: boolean;
        armed: boolean;
        frozen: boolean;
        /** Default program (0-127) for MIDI clips on this track: a GM program, or a drum kit when `drums`; null = global default. */
        instrumentProgram: number | null;
        /** A drum track: its MIDI plays on the drum channel and `instrumentProgram` names a kit. */
        drums: boolean;
        /** Insert FX chain, in order (effect ids / labels). */
        fxChain: string[];
        clipCount: number;
    }>;
    clips: Array<{
        id: string;
        label: string;
        trackId: string;
        /** 'midi' = piano-roll clip with an editable note list; 'audio' = waveform. */
        kind: EditorClipKind;
        startSec: number;
        durationSec: number;
        muted: boolean;
        gain: number;
        fadeInSec: number;
        fadeOutSec: number;
        /** MIDI only: GM program (0-127) the clip plays through; null for audio. */
        instrumentProgram: number | null;
        /** MIDI only: number of notes in the piano-roll source; null for audio. */
        noteCount: number | null;
        /** MIDI only: BPM the notes were authored at; null for audio. */
        sourceBpm: number | null;
    }>;
    clipsTruncated: boolean;
    automationLaneCount: number;
    /** Master insert FX chain, in order. */
    masterFxChain: string[];
    dirty: boolean;
};

type RuntimeContext = {
    ui: {
        /** The REAL workspace tab (make/edit/mix/session/dj/vj/sway/foundry/underfit/nodefi/learn/tour). */
        activeTab: string;
        isLeftPanelOpen: boolean;
        docsOpen: boolean;
    };
    editor: EditorSummary;
    /** Registry ids locate_feature can ring, so the model does not have to guess one. */
    locatableFeatures: string[];
    chat: {
        selectedProvider: string;
        selectedModel: string;
    };
    generation: {
        isGenerating: boolean;
        jobStatus: string;
        statusLabel: string;
        progressPct: number;
        error: string | null;
    };
    params: Record<string, unknown>;
    attachments: Array<{ name: string; mime: string; size: number }>;
    /** The chips the user attached to THIS message, resolved against the live
     *  document. Absent/empty when they attached none. */
    references?: AssistantReferenceContext[];
};

/** Said once, where the references are, so the model cannot miss it. */
const REFERENCES_INSTRUCTION =
    'When references are present, act ONLY on these ids; never pick a clip by name. '
    + 'A reference with status "missing" no longer exists — say so and stop; do not substitute '
    + 'the current selection. Status "changed" means it moved or was renamed since the user '
    + 'pointed at it: use the facts below, not the label.';

export function formattheDAWAppContext(context: RuntimeContext): string {
    const references = context.references ?? [];
    const payload = {
        assistant_is_inside_running_app: true,
        important_behavior: [
            ...(references.length ? [REFERENCES_INSTRUCTION] : []),
            'The user is already talking to you from inside theDAW (by GANTASMO) frontend. Do not tell them to click UI manually when an action exists.',
            'If the user asks to navigate, emit a navigate action immediately.',
            'If the user asks where something is, emit locate_feature with an id from locatableFeatures below — it switches workspace, opens the panel the control lives in and rings the control itself. Do not describe a location you can point at.',
            'If the user asks for settings help, use currentGenerationParams below and explain what each relevant setting does.',
            'If the user asks to improve the prompt, propose a better prompt and emit set_prompt or improve_prompt if they ask you to apply it.',
            'If the user asks to change settings, emit concrete app actions; do not merely describe the settings.',
            'If a requested UI operation has no available action, explain the limitation and give the closest available action.',
            'editorState below is the live EDIT arrangement. Every clip has kind "midi" (piano-roll clip with an editable note list, noteCount, instrumentProgram) or "audio". Every track has kind midi/audio/mixed/empty, and drums true on a drum track, whose instrumentProgram is a drum kit number. Never assume a track is audio — read kind.',
        ],
        currentUI: context.ui,
        locatableFeatures: context.locatableFeatures,
        editorState: context.editor,
        chatProvider: context.chat,
        generationState: context.generation,
        currentGenerationParams: context.params,
        pendingAttachments: context.attachments,
        ...(references.length
            ? { references_instruction: REFERENCES_INSTRUCTION, references }
            : {}),
    };

    return `<current_app_context>\n${JSON.stringify(payload, null, 2)}\n</current_app_context>`;
}

type EditorStoreSnapshot = ReturnType<typeof useEditorStore.getState>;

const round2 = (n: number) => Math.round(n * 100) / 100;

const chainLabels = (chain: EditorStoreSnapshot['masterFxChain'] | undefined): string[] =>
    (chain ?? []).map((e) => (e.enabled ? '' : '(bypassed) ') + (e.label ?? e.effect));

/**
 * The editor state the assistant sees. One summarizer feeds BOTH the
 * `editorState` block of the app context and the `editor_get_state` action, so
 * the two can never disagree. Every clip carries `kind` — a MIDI clip in this
 * store is an AudioClip with sourceKind 'piano-roll' and mimeType 'audio/wav'
 * (it is pre-rendered for playback), so without `kind` the model has no way to
 * tell MIDI from audio and reports every track as audio.
 */
export function summarizeEditor(editor: EditorStoreSnapshot): EditorSummary {
    // Bounded so a huge arrangement cannot blow the prompt.
    const CLIP_CAP = 48;
    const TRACK_CAP = 24;
    const clipKind = (c: EditorStoreSnapshot['clips'][number]): EditorClipKind =>
        c.sourceKind === 'piano-roll' ? 'midi' : 'audio';
    const midiClipCount = editor.clips.filter((c) => clipKind(c) === 'midi').length;
    return {
        trackCount: editor.tracks.length,
        clipCount: editor.clips.length,
        midiClipCount,
        audioClipCount: editor.clips.length - midiClipCount,
        bpm: editor.bpm,
        timeSignature: {
            num: editor.timeSignature?.num ?? 4,
            den: editor.timeSignature?.den ?? 4,
        },
        snap: editor.snap,
        tool: editor.tool,
        playheadSec: round2(editor.playheadSec),
        isPlaying: editor.isPlaying,
        selectedClipId: editor.selectedClipId,
        selectedClipIds: (editor.selectedClipIds ?? []).slice(),
        // `listSnapshots` is an action on the store, not a field — read through
        // it rather than over `snapshots`, so the ordering stays the store's.
        snapshotNames: typeof editor.listSnapshots === 'function' ? editor.listSnapshots() : [],
        loop: editor.loopEnabled
            ? { enabled: true, startSec: editor.loopStart, endSec: editor.loopEnd }
            : null,
        markers: editor.markers.map((m) => ({ id: m.id, sec: round2(m.t), label: m.label })),
        tracks: editor.tracks.slice(0, TRACK_CAP).map((t) => {
            const own = editor.clips.filter((c) => c.trackId === t.id);
            const midi = own.filter((c) => clipKind(c) === 'midi').length;
            const kind: EditorTrackKind =
                own.length === 0 ? 'empty' : midi === own.length ? 'midi' : midi === 0 ? 'audio' : 'mixed';
            return {
                id: t.id,
                name: t.name,
                kind,
                volume: t.volume,
                pan: t.pan,
                mute: t.mute,
                solo: t.solo,
                armed: !!t.armed,
                frozen: !!t.frozenOriginal,
                instrumentProgram: t.instrumentProgram ?? null,
                drums: t.isPercussion === true,
                fxChain: chainLabels(t.fxChain),
                clipCount: own.length,
            };
        }),
        clips: editor.clips.slice(0, CLIP_CAP).map((c) => {
            const kind = clipKind(c);
            return {
                id: c.id,
                label: c.label,
                trackId: c.trackId,
                kind,
                startSec: round2(c.startSec),
                durationSec: round2(c.durationSec),
                muted: !!c.muted,
                gain: c.gain ?? 1,
                fadeInSec: c.fadeInSec ?? 0,
                fadeOutSec: c.fadeOutSec ?? 0,
                instrumentProgram: kind === 'midi' ? (c.instrumentProgram ?? null) : null,
                noteCount: kind === 'midi' ? (c.sourcePianoRoll?.length ?? 0) : null,
                sourceBpm: kind === 'midi' ? (c.sourceBpm ?? null) : null,
            };
        }),
        clipsTruncated: editor.clips.length > CLIP_CAP,
        automationLaneCount: editor.automationLanes.length,
        masterFxChain: chainLabels(editor.masterFxChain),
        dirty: editor.dirty,
    };
}

export function buildtheDAWAppContext(options: {
    selectedProvider: string;
    selectedModel: string;
    attachments?: Array<{ name: string; mime: string; size: number }>;
    /** Reference chips attached to this message. Resolved HERE, at send time,
     *  so a clip deleted while the user was typing goes out flagged missing
     *  rather than as a stale fact. */
    references?: AssistantReference[];
}): string {
    const ui = useAppUiStore.getState();
    const params = useGenerateParamsStore.getState();
    const generation = useGenerateStore.getState();
    const editor = useEditorStore.getState();

    const editorSummary = summarizeEditor(editor);

    return formattheDAWAppContext({
        ui: {
            activeTab: ui.centerTab,
            isLeftPanelOpen: ui.isLeftPanelOpen,
            docsOpen: ui.docsOpen,
        },
        editor: editorSummary,
        // Only the ids with a `locate`; the rest have no single control to ring
        // and locate_feature declines them.
        locatableFeatures: FEATURES.filter((f) => f.locate && !f.devOnly).map((f) => f.id),
        chat: {
            selectedProvider: options.selectedProvider,
            selectedModel: options.selectedModel,
        },
        generation: {
            isGenerating: generation.isGenerating,
            jobStatus: generation.jobStatus,
            statusLabel: generation.statusLabel,
            progressPct: generation.progressPct,
            error: generation.error,
        },
        params: {
            prompt: params.prompt,
            negativePrompt: params.negativePrompt,
            model: params.model,
            duration: params.duration,
            steps: params.steps,
            cfg: params.cfg,
            seed: params.seed,
            batch: params.batch,
            samplerType: params.samplerType,
            sigmaMax: params.sigmaMax,
            durationPaddingSec: params.durationPaddingSec,
            apgScale: params.apgScale,
            cfgRescale: params.cfgRescale,
            cfgNormThreshold: params.cfgNormThreshold,
            cfgIntervalMin: params.cfgIntervalMin,
            cfgIntervalMax: params.cfgIntervalMax,
            shiftMode: params.shiftMode,
            logsnrAnchorLength: params.logsnrAnchorLength,
            logsnrAnchorLogsnr: params.logsnrAnchorLogsnr,
            logsnrRate: params.logsnrRate,
            logsnrEnd: params.logsnrEnd,
            fluxMinLen: params.fluxMinLen,
            fluxMaxLen: params.fluxMaxLen,
            fluxAlphaMin: params.fluxAlphaMin,
            fluxAlphaMax: params.fluxAlphaMax,
            fullBaseShift: params.fullBaseShift,
            fullMaxShift: params.fullMaxShift,
            fullMinLen: params.fullMinLen,
            fullMaxLen: params.fullMaxLen,
            initNoise: params.initNoise,
            initType: params.initType,
            initAudioLoaded: !!params.initAudioFile,
            initAudioName: params.initAudioFile?.name ?? null,
            inpaintEnabled: params.inpaintEnabled,
            inpaintAudioLoaded: !!params.inpaintAudioFile,
            inpaintAudioName: params.inpaintAudioFile?.name ?? null,
            maskStart: params.maskStart,
            maskEnd: params.maskEnd,
            inversionSteps: params.inversionSteps,
            inversionGamma: params.inversionGamma,
            inversionUnconditional: params.inversionUnconditional,
            fileFormat: params.fileFormat,
            wavBitDepth: params.wavBitDepth,
            fileNaming: params.fileNaming,
            cutToDuration: params.cutToDuration,
            autoplay: params.autoplay,
            autoDownload: params.autoDownload,
            loraSlotCount: params.loras.length,
            loras: params.loras.map((slot) => ({
                name: slot.name,
                weight: slot.weight,
                fileLoaded: !!slot.file,
                fileName: slot.file?.name ?? null,
            })),
        },
        attachments: options.attachments ?? [],
        references: (options.references ?? []).map(referenceContextEntry),
    });
}


