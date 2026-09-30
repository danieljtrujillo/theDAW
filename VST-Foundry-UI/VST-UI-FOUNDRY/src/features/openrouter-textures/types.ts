import type { Dispatch, SetStateAction } from 'react';

export type OpenRouterTab = 'openrouter';

export interface ImageModel {
  id: string;
  label: string;
}

export interface OpenRouterTextureParams {
  orModel?: string;
}

export interface OpenRouterTextureControls {
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  models: ImageModel[];
  error: string | null;
}
