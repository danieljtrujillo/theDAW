import type { ProviderInfo, ModelInfo } from "./types";

// Normalize a provider record from the backend into a consistent shape.
// Tolerates both the documented contract (requiresKey/isLocal/defaultModel)
// and the alternate backend field names (has_key/is_local/default_model).
export function normalizeProviders(raw: any[]): ProviderInfo[] {
  return (raw || []).map((p) => {
    const isLocal = p.isLocal ?? p.is_local ?? false;
    let requiresKey: boolean;
    if (typeof p.requiresKey === "boolean") {
      requiresKey = p.requiresKey;
    } else if (typeof p.has_key === "boolean") {
      // has_key=true means the server already has a usable key for this provider
      requiresKey = !isLocal && !p.has_key;
    } else {
      requiresKey = false;
    }
    return {
      id: p.id,
      label: p.label ?? p.id,
      requiresKey: p.id === "claude" ? false : requiresKey,
      isLocal,
      defaultModel: p.defaultModel ?? p.default_model ?? "",
    };
  });
}

export function normalizeModels(raw: any[]): ModelInfo[] {
  return (raw || []).map((m: any) => ({
    id: m.id,
    label: m.label ?? m.name ?? m.id,
    capabilities: m.capabilities,
  }));
}
