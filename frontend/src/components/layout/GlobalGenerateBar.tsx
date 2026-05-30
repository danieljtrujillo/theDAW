import React from 'react';
import { Play, X } from 'lucide-react';
import { useGenerateStore } from '../../state/generateStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { useStudioStore } from '../../state/studioStore';
import { useTrainingStore } from '../../state/trainingStore';
import { useAppUiStore } from '../../state/appUiStore';

const TAB_CONFIG = {
  create: {
    idle: 'RUN GENERATION',
    active: 'ABORT',
    idleColor: 'bg-purple-600 hover:bg-purple-500 text-white',
    activeColor: 'bg-red-600/30 border-t border-red-500/50 text-red-300 hover:bg-red-600/50',
  },
  edit: {
    idle: 'PROCESS AUDIO',
    active: 'PROCESSING...',
    idleColor: 'bg-blue-700 hover:bg-blue-600 text-white',
    activeColor: 'bg-blue-600/30 border-t border-blue-500/50 text-blue-300 hover:bg-blue-600/50',
  },
  train: {
    idle: 'ENGAGE BACKPROP',
    active: 'ABORT TRAINING',
    idleColor: 'bg-rose-700 hover:bg-rose-600 text-white',
    activeColor: 'bg-rose-600/30 border-t border-rose-500/50 text-rose-300 hover:bg-rose-600/50',
  },
  library: {
    idle: 'RUN GENERATION',
    active: 'ABORT',
    idleColor: 'bg-purple-600 hover:bg-purple-500 text-white',
    activeColor: 'bg-red-600/30 border-t border-red-500/50 text-red-300 hover:bg-red-600/50',
  },
} as const;

export const GlobalGenerateBar: React.FC = () => {
  const activeView = useAppUiStore((s) => s.activeView);
  const setActiveView = useAppUiStore((s) => s.setActiveView);

  // CREATE
  const isGenerating = useGenerateStore((s) => s.isGenerating);
  const statusLabel = useGenerateStore((s) => s.statusLabel);
  const progressPct = useGenerateStore((s) => s.progressPct);
  const submitGeneration = useGenerateStore((s) => s.submitGeneration);
  const cancelPolling = useGenerateStore((s) => s.cancelPolling);
  const model = useGenerateParamsStore((s) => s.model);

  // EDIT
  const isProcessing = useStudioStore((s) => s.isProcessing);

  // TRAIN
  const isTraining = useTrainingStore((s) => s.isTraining);

  const tab = activeView as keyof typeof TAB_CONFIG;
  const cfg = TAB_CONFIG[tab] ?? TAB_CONFIG.create;

  const isActive =
    tab === 'create' ? isGenerating :
    tab === 'edit'   ? isProcessing :
    tab === 'train'  ? isTraining   : false;

  const handleClick = () => {
    if (tab === 'create' || tab === 'library') {
      if (tab === 'library') setActiveView('create');
      if (isGenerating) { cancelPolling(); return; }
      const params = useGenerateParamsStore.getState();
      void submitGeneration({
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        model: params.model,
        duration: params.duration,
        steps: params.steps,
        cfg: params.cfg,
        seed: params.seed,
        batch: params.batch,
        initNoise: params.initNoise,
        initType: params.initType,
        initAudioFile: params.initAudioFile,
        inpaintAudioFile: params.inpaintAudioFile,
        inpaintEnabled: params.inpaintEnabled,
        maskStart: params.maskStart,
        maskEnd: params.maskEnd,
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
        inversionSteps: params.inversionSteps,
        inversionGamma: params.inversionGamma,
        inversionUnconditional: params.inversionUnconditional,
        fileFormat: params.fileFormat,
        fileNaming: params.fileNaming,
        cutToDuration: params.cutToDuration,
        loras: params.loras,
      });
    } else if (tab === 'edit') {
      void useStudioStore.getState().triggerPendingProcess();
    } else if (tab === 'train') {
      void useTrainingStore.getState().triggerTraining();
    }
  };

  const title =
    tab === 'create' ? (isGenerating ? 'Abort the current generation' : `Submit ${model.toUpperCase()} job to /api/generate-jobs`) :
    tab === 'edit'   ? (isProcessing ? 'Cancel processing' : 'Process audio with selected effect') :
    tab === 'train'  ? (isTraining ? 'Abort training' : 'Submit LoRA training job') :
    'Switch to CREATE and run generation';

  return (
    <button
      onClick={handleClick}
      className={`relative w-full overflow-hidden font-black uppercase tracking-widest text-[12px] flex items-center justify-center gap-2 transition-colors shrink-0 ${
        isActive ? cfg.activeColor : cfg.idleColor
      }`}
      style={{ height: '40px' }}
      title={title}
    >
      {tab === 'create' && isGenerating && (
        <div
          className="absolute inset-y-0 left-0 bg-red-500/30 transition-[width] duration-200"
          style={{ width: `${Math.max(2, progressPct)}%` }}
        />
      )}
      <span className="relative z-10 flex items-center gap-2">
        {isActive ? <X className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
        {isActive
          ? tab === 'create' ? `ABORT (${progressPct}%)` : cfg.active
          : cfg.idle}
        {tab === 'create' && !isGenerating && statusLabel !== 'READY' && (
          <span className="text-[8px] font-mono opacity-60 ml-2 normal-case tracking-normal">{statusLabel}</span>
        )}
      </span>
    </button>
  );
};

