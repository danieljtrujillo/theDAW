import { TextureGenParams } from '../../types';

// Shared types for the Texture Generate modal and its sub-components.
// Extracted verbatim from the original TextureGenerateModal.tsx.

export interface GeneratedTexture {
  id: string;
  name: string;
  url: string;
  prompt?: string;
  provider?: string;
  createdAt?: number;
  isGenerated?: boolean;
}

export type QueueStatus = 'pending' | 'running' | 'done' | 'error';

export interface QueueItem {
  id: string;
  label: string;
  params: TextureGenParams;
  status: QueueStatus;
  results?: GeneratedTexture[];
  error?: string;
}

export interface SDResource {
  id: string;
  label: string;
}

export interface SDResources {
  models: SDResource[];
  vaes: SDResource[];
  loras: SDResource[];
  samplers: SDResource[];
}

export type ProviderTab = 'sd' | 'dalle' | 'gemini';
export type SdType = 'a1111' | 'comfyui';
