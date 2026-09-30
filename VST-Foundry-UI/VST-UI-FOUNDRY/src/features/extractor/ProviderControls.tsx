import type { useExtractorProvider } from "./useExtractorProvider";

export function ProviderControls({ provider, setProvider, model, setModel, availableModels, isLoading, error }: ReturnType<typeof useExtractorProvider>) {
  return <>
    <div className="flex items-center gap-1.5">
      <label htmlFor="extract-provider" className="text-xs text-app-muted">Provider</label>
      <select id="extract-provider" name="extract-provider" value={provider}
        onChange={(event) => { if (event.target.value === "gemini" || event.target.value === "openrouter") setProvider(event.target.value); }}
        className="bg-app-surface text-app-main text-sm py-1.5 px-3 rounded border border-app-border outline-none focus:border-app-accent">
        <option value="gemini">Gemini</option><option value="openrouter">OpenRouter</option>
      </select>
    </div>
    <div className="flex items-center gap-1.5">
      <label htmlFor="extract-model" className="text-xs text-app-muted">Model</label>
      <select id="extract-model" name="extract-model" value={model} disabled={isLoading || availableModels.length === 0}
        onChange={(event) => setModel(event.target.value)}
        className="bg-app-surface text-app-main text-sm py-1.5 px-3 rounded border border-app-border outline-none focus:border-app-accent max-w-50">
        {availableModels.length > 0 ? availableModels.map((entry) => <option key={entry.id} value={entry.id}>{entry.label || entry.id}</option>)
          : <option value="">{isLoading ? "Loading models…" : error || (provider === "openrouter" ? "No vision models available" : "No models available")}</option>}
      </select>
    </div>
  </>;
}
