import { useAppUiStore } from '../state/appUiStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useGenerateStore } from '../state/generateStore';

type RuntimeContext = {
    ui: {
        activeView: string;
        isLeftPanelOpen: boolean;
        docsOpen: boolean;
    };
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
};

export function formatStableDAWAppContext(context: RuntimeContext): string {
    const payload = {
        assistant_is_inside_running_app: true,
        important_behavior: [
            'The user is already talking to you from inside the StableDAW frontend. Do not tell them to click UI manually when an action exists.',
            'If the user asks to navigate, emit a navigate action immediately.',
            'If the user asks for settings help, use currentGenerationParams below and explain what each relevant setting does.',
            'If the user asks to improve the prompt, propose a better prompt and emit set_prompt or improve_prompt if they ask you to apply it.',
            'If the user asks to change settings, emit concrete app actions; do not merely describe the settings.',
            'If a requested UI operation has no available action, explain the limitation and give the closest available action.',
        ],
        currentUI: context.ui,
        chatProvider: context.chat,
        generationState: context.generation,
        currentGenerationParams: context.params,
        pendingAttachments: context.attachments,
    };

    return `<current_app_context>\n${JSON.stringify(payload, null, 2)}\n</current_app_context>`;
}

export function buildStableDAWAppContext(options: {
    selectedProvider: string;
    selectedModel: string;
    attachments?: Array<{ name: string; mime: string; size: number }>;
}): string {
    const ui = useAppUiStore.getState();
    const params = useGenerateParamsStore.getState();
    const generation = useGenerateStore.getState();

    return formatStableDAWAppContext({
        ui: {
            activeView: ui.activeView,
            isLeftPanelOpen: ui.isLeftPanelOpen,
            docsOpen: ui.docsOpen,
        },
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
    });
}
