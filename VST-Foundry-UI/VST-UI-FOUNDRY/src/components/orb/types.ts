import type React from "react";
import type { UIElement, CanvasState, CustomParam } from "../../types";

// One tool the agent invoked, paired with its result. `inputJson` is the tool
// input as a JSON string (BCC stores it stringified so partial input deltas can
// accumulate before parse); the renderer try/pretty-prints it. `result`/`isError`
// arrive later via the matching tool_result frame (joined on `toolId`).
// `subCalls` holds a sub-agent's tools when this entry is a Task/Agent spawn
// (BCC parity: sub-agent activity nests under its card, off the main transcript).
export interface ToolCallEntry {
  toolId: string;
  name: string;
  inputJson: string;
  result?: string;
  isError?: boolean;
  status: "executing" | "success" | "error";
  subCalls?: ToolCallEntry[];
}

// Per-turn accounting from the CLI `result` event (BCC shows this under each
// assistant message). `costUsd` is the per-turn delta of cumulative session cost.
export interface TurnMeta {
  costUsd?: number;
  inTokens?: number;
  outTokens?: number;
  durationMs?: number;
  isError?: boolean;
}

// A live CLI control_request the user must answer (AskUserQuestion multiple
// choice, or a can_use_tool permission prompt). Mirrors BCC's PendingPermission.
export interface PendingControl {
  requestId: string;
  toolName: string;
  input: any;
  suggestions?: any[];
  reason?: string;
}

// A canvas element the user attached to a message as context (context menu
// "Add to Chat"). Name/type are snapshotted at attach time for display; the id
// points the model at the full definition inside appState.elements.
export interface ElementRef {
  id: string;
  name: string;
  type: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  image?: string; // base64
  refs?: ElementRef[]; // canvas elements referenced via "Add to Chat"
  toolCalls?: ToolCallEntry[];
  meta?: TurnMeta;
  groundingUrls?: Array<{ title: string; url: string }>;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  provider?: string;
  model: string;
  effort?: string;
  thinkingLevel?: string; // legacy field, kept for backward-compat reads
  claudeSessionId?: string | null;
  lastUpdated: number;
}

// Provider/model metadata returned by the backend discovery endpoints.
export interface ProviderInfo {
  id: string;
  label: string;
  requiresKey: boolean;
  isLocal: boolean;
  defaultModel: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  capabilities?: string[];
}

export interface AIAssistantOrbProps {
  elements: UIElement[];
  setElements: React.Dispatch<React.SetStateAction<UIElement[]>>;
  canvasState: CanvasState;
  setCanvasState: React.Dispatch<React.SetStateAction<CanvasState>>;
  // Persist an AI-authored CustomCode element into the reusable library so it
  // survives reloads and shows up in the sidebar palette.
  onRegisterModule?: (
    name: string,
    code: string,
    params?: CustomParam[],
  ) => void;
}

// Shared text-scale union used by the transcript's presentational components.
export type TextScale = "xs" | "sm" | "md" | "lg";
