import React from 'react';
import {
  Play,
  Square,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import CustomSelect from '../CustomSelect';
import NumberField from './NumberField';
import { labelCls, inputCls, btnCls, CLOUD_SIZES } from './constants';
import { ProviderTab, SdType, SDResource, SDResources } from './types';
import { SDStatus, LoraEntry } from '../../types';

interface GenerateFormProps {
  // ---- SD sub-options + status ----
  isSdTab: boolean;
  sdType: SdType;
  setSdType: React.Dispatch<React.SetStateAction<SdType>>;
  sdConfigured: boolean;
  sdStatus: SDStatus | null;
  startingStopping: boolean;
  onStartSd: () => void;
  onStopSd: () => void;

  // ---- Prompt ----
  prompt: string;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;
  negativePrompt: string;
  setNegativePrompt: React.Dispatch<React.SetStateAction<string>>;

  // ---- SD basic params ----
  width: number;
  setWidth: React.Dispatch<React.SetStateAction<number>>;
  height: number;
  setHeight: React.Dispatch<React.SetStateAction<number>>;
  steps: number;
  setSteps: React.Dispatch<React.SetStateAction<number>>;
  cfgScale: number;
  setCfgScale: React.Dispatch<React.SetStateAction<number>>;
  sampler: string;
  setSampler: React.Dispatch<React.SetStateAction<string>>;
  seed: number;
  setSeed: React.Dispatch<React.SetStateAction<number>>;
  batchCount: number;
  setBatchCount: React.Dispatch<React.SetStateAction<number>>;
  nIter: number;
  setNIter: React.Dispatch<React.SetStateAction<number>>;
  sdResources: SDResources;

  // ---- Cloud params ----
  activeTab: ProviderTab;
  imageSize: string;
  setImageSize: React.Dispatch<React.SetStateAction<string>>;
  count: number;
  setCount: React.Dispatch<React.SetStateAction<number>>;
  quality: 'standard' | 'hd';
  setQuality: React.Dispatch<React.SetStateAction<'standard' | 'hd'>>;
  style: 'vivid' | 'natural';
  setStyle: React.Dispatch<React.SetStateAction<'vivid' | 'natural'>>;
  apiKey: string;
  setApiKey: React.Dispatch<React.SetStateAction<string>>;

  // ---- Advanced ----
  advancedOpen: boolean;
  setAdvancedOpen: React.Dispatch<React.SetStateAction<boolean>>;
  model: string;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  vae: string;
  setVae: React.Dispatch<React.SetStateAction<string>>;
  loras: LoraEntry[];
  availableLoras: SDResource[];
  addLoraOpen: boolean;
  setAddLoraOpen: React.Dispatch<React.SetStateAction<boolean>>;
  addLoraRef: React.RefObject<HTMLDivElement | null>;
  onAddLora: (name: string) => void;
  onUpdateLoraWeight: (name: string, weight: number) => void;
  onRemoveLora: (name: string) => void;
}

// Prompt + parameter inputs for the Texture Generate modal (SD toggle/status,
// prompt, negative prompt, basic params and the advanced/LoRA section).
// Presentational only — all state and handlers are owned by the parent modal.
// Sections are returned in a fragment so they remain direct children of the
// parent's `space-y-4` scroll container, preserving the original spacing.
export default function GenerateForm({
  isSdTab,
  sdType,
  setSdType,
  sdConfigured,
  sdStatus,
  startingStopping,
  onStartSd,
  onStopSd,
  prompt,
  setPrompt,
  negativePrompt,
  setNegativePrompt,
  width,
  setWidth,
  height,
  setHeight,
  steps,
  setSteps,
  cfgScale,
  setCfgScale,
  sampler,
  setSampler,
  seed,
  setSeed,
  batchCount,
  setBatchCount,
  nIter,
  setNIter,
  sdResources,
  activeTab,
  imageSize,
  setImageSize,
  count,
  setCount,
  quality,
  setQuality,
  style,
  setStyle,
  apiKey,
  setApiKey,
  advancedOpen,
  setAdvancedOpen,
  model,
  setModel,
  vae,
  setVae,
  loras,
  availableLoras,
  addLoraOpen,
  setAddLoraOpen,
  addLoraRef,
  onAddLora,
  onUpdateLoraWeight,
  onRemoveLora,
}: GenerateFormProps) {
  return (
    <>
      {/* SD sub-options + status */}
      {isSdTab && (
        <>
          <div className="flex items-center gap-4">
            {(['a1111', 'comfyui'] as SdType[]).map((t) => (
              <label
                key={t}
                className="flex items-center gap-1.5 cursor-pointer text-xs text-app-main"
              >
                <input
                  type="radio"
                  name="sdType"
                  checked={sdType === t}
                  onChange={() => setSdType(t)}
                  className="accent-app-accent"
                />
                <span className="uppercase font-bold text-[10px] tracking-wide">
                  {t === 'a1111' ? 'Automatic1111' : 'ComfyUI'}
                </span>
              </label>
            ))}
          </div>

          {!sdConfigured ? (
            <div className="flex items-start gap-2 p-2.5 rounded border border-yellow-600/40 bg-yellow-900/20 text-yellow-300 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                No SD path configured. Go to Settings to configure Stable Diffusion.
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between p-2.5 rounded border border-app-border bg-app-surface">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    sdStatus?.running
                      ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.7)]'
                      : 'bg-red-500'
                  }`}
                />
                <span className="text-app-main">
                  {sdStatus?.running
                    ? `Running on port ${sdStatus.port ?? '?'}${
                        sdStatus.type ? ` (${sdStatus.type})` : ''
                      }`
                    : 'Stopped'}
                </span>
              </div>
              <button
                onClick={sdStatus?.running ? onStopSd : onStartSd}
                disabled={startingStopping}
                className={`${btnCls} flex items-center gap-1 ${
                  startingStopping ? 'opacity-60 pointer-events-none' : ''
                }`}
              >
                {startingStopping ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : sdStatus?.running ? (
                  <Square className="w-3 h-3" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
                {sdStatus?.running ? 'Stop' : 'Start'}
              </button>
            </div>
          )}
        </>
      )}

      {/* Prompt */}
      <div>
        <div className={labelCls}>Prompt</div>
        <textarea
          className={`${inputCls} resize-y min-h-16`}
          placeholder="Describe the texture you want to generate..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />
      </div>

      {isSdTab && (
        <div>
          <div className={labelCls}>Negative Prompt</div>
          <textarea
            className={`${inputCls} resize-y min-h-11`}
            placeholder="What to avoid..."
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            rows={2}
          />
        </div>
      )}

      {/* Basic params */}
      {isSdTab ? (
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Width" value={width} onChange={setWidth} min={64} max={2048} step={8} />
          <NumberField label="Height" value={height} onChange={setHeight} min={64} max={2048} step={8} />
          <NumberField label="Steps" value={steps} onChange={setSteps} min={1} max={150} />
          <NumberField label="CFG Scale" value={cfgScale} onChange={setCfgScale} min={1} max={30} step={0.5} />
          <div>
            <div className={labelCls}>Sampler</div>
            <CustomSelect
              value={sampler}
              onChange={setSampler}
              options={
                sdResources.samplers.length > 0
                  ? sdResources.samplers.map((s) => ({ value: s.id, label: s.label }))
                  : [{ value: '', label: 'Default' }]
              }
            />
          </div>
          <div>
            <div className={labelCls}>Seed (-1 = random)</div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                className={inputCls}
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value))}
              />
              <button
                onClick={() => setSeed(-1)}
                title="Randomize seed"
                className={`${btnCls} flex items-center justify-center px-1.5`}
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
          </div>
          <NumberField label="Batch Size" value={batchCount} onChange={setBatchCount} min={1} max={16} />
          <NumberField label="Iterations" value={nIter} onChange={setNIter} min={1} max={32} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={labelCls}>Size</div>
            <CustomSelect
              value={imageSize}
              onChange={setImageSize}
              options={CLOUD_SIZES.map((s) => ({ value: s, label: s }))}
            />
          </div>
          <NumberField label="Count" value={count} onChange={setCount} min={1} max={4} />
          {activeTab === 'dalle' && (
            <>
              <div>
                <div className={labelCls}>Quality</div>
                <CustomSelect
                  value={quality}
                  onChange={(v) => setQuality(v as 'standard' | 'hd')}
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'hd', label: 'HD' },
                  ]}
                />
              </div>
              <div>
                <div className={labelCls}>Style</div>
                <CustomSelect
                  value={style}
                  onChange={(v) => setStyle(v as 'vivid' | 'natural')}
                  options={[
                    { value: 'vivid', label: 'Vivid' },
                    { value: 'natural', label: 'Natural' },
                  ]}
                />
              </div>
            </>
          )}
          <div className="col-span-2">
            <div className={labelCls}>API Key (optional override)</div>
            <input
              type="password"
              className={inputCls}
              placeholder="Leave blank to use server-configured key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Advanced (SD only) */}
      {isSdTab && (
        <div className="border border-app-border rounded">
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-app-muted hover:text-app-main transition-colors"
          >
            {advancedOpen ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            <span className="text-[10px] uppercase font-bold tracking-wide">
              Advanced
            </span>
          </button>

          {advancedOpen && (
            <div className="p-3 pt-0 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className={labelCls}>Model / Checkpoint</div>
                  <CustomSelect
                    value={model}
                    onChange={setModel}
                    options={[
                      { value: '', label: 'Current / Default' },
                      ...sdResources.models.map((m) => ({ value: m.id, label: m.label })),
                    ]}
                  />
                </div>
                <div>
                  <div className={labelCls}>VAE</div>
                  <CustomSelect
                    value={vae}
                    onChange={setVae}
                    options={[
                      { value: '', label: 'Automatic' },
                      ...sdResources.vaes.map((v) => ({ value: v.id, label: v.label })),
                    ]}
                  />
                </div>
              </div>

              {/* LoRAs */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className={`${labelCls} mb-0`}>LoRAs</div>
                  <div className="relative" ref={addLoraRef}>
                    <button
                      onClick={() => setAddLoraOpen((o) => !o)}
                      disabled={availableLoras.length === 0}
                      className={`${btnCls} ${
                        availableLoras.length === 0 ? 'opacity-50 pointer-events-none' : ''
                      }`}
                    >
                      + Add LoRA
                    </button>
                    {addLoraOpen && availableLoras.length > 0 && (
                      <div className="absolute right-0 top-full mt-1 w-56 max-h-48 overflow-y-auto bg-app-surface border border-app-border rounded-md shadow-[0_4px_20px_rgba(0,0,0,0.5)] z-9999">
                        {availableLoras.map((l) => (
                          <div
                            key={l.id}
                            onClick={() => onAddLora(l.id)}
                            className="px-2 py-1.5 text-xs text-app-main cursor-pointer hover:bg-app-accent hover:text-white transition-colors truncate"
                          >
                            {l.label}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {loras.length === 0 ? (
                  <div className="text-[10px] text-app-muted italic px-1 py-1">
                    No LoRAs selected.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {loras.map((l) => (
                      <div
                        key={l.name}
                        className="flex items-center gap-2 bg-app-surface border border-app-border rounded px-2 py-1.5"
                      >
                        <span className="text-xs text-app-main truncate flex-1" title={l.name}>
                          {l.name}
                        </span>
                        <input
                          type="range"
                          min={0.1}
                          max={1.5}
                          step={0.05}
                          value={l.weight}
                          onChange={(e) => onUpdateLoraWeight(l.name, Number(e.target.value))}
                          className="w-24 accent-app-accent"
                        />
                        <span className="text-[10px] text-app-muted w-8 text-right tabular-nums">
                          {l.weight.toFixed(2)}
                        </span>
                        <button
                          onClick={() => onRemoveLora(l.name)}
                          className="text-app-muted hover:text-red-400 transition-colors"
                          title="Remove LoRA"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
