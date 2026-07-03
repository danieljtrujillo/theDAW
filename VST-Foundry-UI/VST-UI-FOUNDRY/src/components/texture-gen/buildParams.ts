import { TextureGenParams, LoraEntry } from '../../types';
import { ProviderTab, SdType } from './types';

// Inputs required to assemble the generation request body. These mirror the
// closure variables the original inline buildParams() read from component state.
export interface BuildParamsArgs {
  provider: string;
  prompt: string;
  isSdTab: boolean;
  sdType: SdType;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  sampler: string;
  seed: number;
  batchCount: number;
  nIter: number;
  model: string;
  vae: string;
  loras: LoraEntry[];
  imageSize: string;
  count: number;
  activeTab: ProviderTab;
  quality: 'standard' | 'hd';
  style: 'vivid' | 'natural';
  apiKey: string;
}

// Pure builder for the /api/textures/generate request body. Logic extracted
// verbatim from the original TextureGenerateModal.tsx.
export function buildParams(args: BuildParamsArgs): TextureGenParams {
  const {
    provider,
    prompt,
    isSdTab,
    sdType,
    negativePrompt,
    width,
    height,
    steps,
    cfgScale,
    sampler,
    seed,
    batchCount,
    nIter,
    model,
    vae,
    loras,
    imageSize,
    count,
    activeTab,
    quality,
    style,
    apiKey,
  } = args;

  const base: TextureGenParams = {
    provider,
    prompt: prompt.trim(),
  };
  if (isSdTab) {
    base.sdType = sdType;
    base.negativePrompt = negativePrompt.trim() || undefined;
    base.width = width;
    base.height = height;
    base.steps = steps;
    base.cfgScale = cfgScale;
    base.sampler = sampler || undefined;
    base.seed = seed;
    base.batchCount = batchCount;
    base.nIter = nIter;
    if (model) base.model = model;
    if (vae) base.vae = vae;
    if (loras.length > 0) base.loras = loras;
  } else {
    base.imageSize = imageSize;
    base.count = count;
    if (activeTab === 'dalle') {
      base.quality = quality;
      base.style = style;
    }
    if (apiKey.trim()) base.apiKey = apiKey.trim();
  }
  return base;
}
