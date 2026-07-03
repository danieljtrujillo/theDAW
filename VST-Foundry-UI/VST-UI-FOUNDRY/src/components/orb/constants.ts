// Effort levels accepted by the Claude Code provider.
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

// LocalStorage keys
export const LS_PROVIDER = "vst-foundry-provider";
export const LS_MODEL = "vst-foundry-model";
export const LS_PROVIDER_KEYS = "vst-foundry-provider-api-keys";
export const LS_EFFORT = "vst-foundry-effort";
export const LS_LEGACY_KEY = "vst-foundry-custom-api-key";
export const LS_SESSIONS = "vst-foundry-assistant-sessions";

export const DEFAULT_PROVIDER = "claude";
// Must be a full model id the backend/CLI accepts.
// CLI aliases like "opus"/"sonnet" are unreliable on this machine, so use the
// full id; the server also normalizes any stale value to a valid full id.
export const DEFAULT_MODEL = "claude-opus-4-8";
