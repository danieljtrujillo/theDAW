import { useEffect, useRef, useState } from "react";
import { LS_PROVIDER_KEYS } from "../../components/orb/constants";

export type ExtractProvider = "gemini" | "openrouter";
export interface ExtractModel { id: string; label: string; capabilities: string[] }

const EXTRACT_DEFAULT_MODEL = "gemini-3.5-flash-lite";
const OPENROUTER_MODEL_PREFERENCE = [
  /^google\/gemini[^:]*flash[^:]*lite[^:]*$/,
  /^google\/gemini[^:]*flash[^:]*$/,
  /^google\/gemini/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entries(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value[field])) return value[field];
  return [];
}

function readApiKey(provider: ExtractProvider): string {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_PROVIDER_KEYS) || "{}");
    return isRecord(parsed) && typeof parsed[provider] === "string" ? parsed[provider] : "";
  } catch {
    return "";
  }
}

export function chooseExtractorModel(provider: ExtractProvider, models: ExtractModel[], previous: string, defaultModel: string): string {
  if (models.some((entry) => entry.id === previous)) return previous;
  if (provider === "openrouter") {
    for (const preference of OPENROUTER_MODEL_PREFERENCE) {
      const match = models.find((entry) => preference.test(entry.id));
      if (match) return match.id;
    }
  } else if (models.some((entry) => entry.id === EXTRACT_DEFAULT_MODEL)) return EXTRACT_DEFAULT_MODEL;
  return models.find((entry) => entry.id === defaultModel)?.id || models[0]?.id || "";
}

export function useExtractorProvider(isOpen: boolean) {
  const [provider, setProvider] = useState<ExtractProvider>("gemini");
  const previousModels = useRef<Partial<Record<ExtractProvider, string>>>({});
  const [state, setState] = useState({
    provider, apiKey: "", model: "", availableModels: [] as ExtractModel[],
    isLoading: true, error: "",
  });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const apiKey = readApiKey(provider);
    setState({ provider, apiKey, model: "", availableModels: [], isLoading: true, error: "" });
    const load = async () => {
      try {
        const url = `/api/assistant/models/${provider}${apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : ""}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error("Models unavailable");
        const data: unknown = await response.json();
        const availableModels = entries(data, "models").flatMap((entry): ExtractModel[] => {
          if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) return [];
          const capabilities = Array.isArray(entry.capabilities)
            ? entry.capabilities.filter((capability): capability is string => typeof capability === "string") : [];
          if (provider === "openrouter" && !capabilities.includes("vision")) return [];
          return [{ id: entry.id, label: typeof entry.label === "string" ? entry.label : entry.id, capabilities }];
        });
        if (cancelled) return;
        let defaultModel = "";
        try {
          const defaultsResponse = await fetch("/api/assistant/providers");
          if (defaultsResponse.ok) {
            const defaults: unknown = await defaultsResponse.json();
            const entry = entries(defaults, "providers").find((candidate) => isRecord(candidate) && candidate.id === provider);
            if (isRecord(entry) && typeof entry.defaultModel === "string") defaultModel = entry.defaultModel;
          }
        } catch { defaultModel = ""; }
        if (cancelled) return;
        const model = chooseExtractorModel(provider, availableModels, previousModels.current[provider] || "", defaultModel);
        previousModels.current[provider] = model;
        setState({ provider, apiKey, model, availableModels, isLoading: false, error: "" });
      } catch {
        if (!cancelled) setState({ provider, apiKey, model: "", availableModels: [], isLoading: false, error: "Could not load models" });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [isOpen, provider]);

  const current = state.provider === provider ? state : {
    provider, apiKey: "", model: "", availableModels: [], isLoading: true, error: "",
  };
  const setModel = (model: string) => {
    if (!current.availableModels.some((entry) => entry.id === model)) return;
    previousModels.current[provider] = model;
    setState((previous) => ({ ...previous, model }));
  };

  return { ...current, provider, setProvider, setModel, ready: !current.isLoading && !!current.model };
}
