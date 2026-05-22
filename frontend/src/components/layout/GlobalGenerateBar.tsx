import React from 'react';
import { Play, X } from 'lucide-react';
import { useGenerateStore } from '../../state/generateStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';

/**
 * The pinned CREATE-tab CTA. Sits as a flex sibling of <ProcessingLog />.
 *
 * Generation progress lives inside the button itself:
 *   - "RUN GENERATION" when idle
 *   - "ABORT (42%)" while running, with a thin progress strip drawn behind the label
 *
 * The Output Status Monitor card was deleted — its play/download controls now
 * live in the ProcessingLog header (see ProcessingLog.tsx). The footer track
 * info still shows model + duration + filename for the current track.
 */
export const GlobalGenerateBar: React.FC = () => {
  const isGenerating = useGenerateStore((s) => s.isGenerating);
  const statusLabel = useGenerateStore((s) => s.statusLabel);
  const progressPct = useGenerateStore((s) => s.progressPct);
  const submitGeneration = useGenerateStore((s) => s.submitGeneration);
  const cancelPolling = useGenerateStore((s) => s.cancelPolling);
  const model = useGenerateParamsStore((s) => s.model);

  const handleClick = () => {
    if (isGenerating) {
      cancelPolling();
      return;
    }
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
  };

  return (
    <button
      onClick={handleClick}
      className={`relative w-full overflow-hidden font-black uppercase tracking-widest text-[12px] flex items-center justify-center gap-2 transition-colors flex-shrink-0 ${
        isGenerating
          ? 'bg-red-600/30 border-t border-red-500/50 text-red-300 hover:bg-red-600/50'
          : 'bg-purple-600 hover:bg-purple-500 text-white'
      }`}
      style={{ height: '40px' }}
      title={isGenerating ? 'Abort the current generation' : `Submit ${model.toUpperCase()} job to /api/generate-jobs`}
    >
      {isGenerating && (
        <div
          className="absolute inset-y-0 left-0 bg-red-500/30 transition-[width] duration-200"
          style={{ width: `${Math.max(2, progressPct)}%` }}
        />
      )}
      <span className="relative z-10 flex items-center gap-2">
        {isGenerating ? <X className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
        {isGenerating ? `ABORT (${progressPct}%)` : 'RUN GENERATION'}
        {!isGenerating && statusLabel !== 'READY' && (
          <span className="text-[8px] font-mono opacity-60 ml-2 normal-case tracking-normal">{statusLabel}</span>
        )}
      </span>
    </button>
  );
};
