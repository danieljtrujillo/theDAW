import { useState, useRef, useEffect, type ComponentType, type RefObject } from 'react'
import {
  Brain, Wrench, Eye, Mic, Headphones, Video, Image, Code, Globe,
  Braces, BookOpen, Zap, ChevronDown, Check, Loader2
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Capability =
  | 'tools' | 'reasoning' | 'vision' | 'audio_in' | 'audio_out'
  | 'video_in' | 'image_gen' | 'code' | 'web_search'
  | 'structured_output' | 'long_context' | 'fast'

export interface ModelInfo {
  id: string
  name: string
  capabilities: Capability[]
}

export interface ProviderOption {
  id: string
  label: string
  models: ModelInfo[]
}

export interface ProviderModelSelectorProps {
  providers: ProviderOption[]
  selectedProvider: string
  selectedModel: string
  onProviderChange: (providerId: string) => void
  onModelChange: (modelId: string) => void
  loading?: boolean
  claudeCodeModels?: Array<{ value: string; label: string }>
}

// ---------------------------------------------------------------------------
// Capability badge metadata
// Full Tailwind class strings to avoid purge issues with dynamic interpolation
// ---------------------------------------------------------------------------

const CAPABILITY_META: Record<Capability, { icon: ComponentType<any>; label: string; classes: string }> = {
  tools:             { icon: Wrench,     label: 'TOOL',  classes: 'border-blue-500/30 bg-blue-500/10 text-blue-400' },
  reasoning:         { icon: Brain,      label: 'RSN',   classes: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  vision:            { icon: Eye,        label: 'VIS',   classes: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  audio_in:          { icon: Mic,        label: 'STT',   classes: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400' },
  audio_out:         { icon: Headphones, label: 'TTS',   classes: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400' },
  video_in:          { icon: Video,      label: 'VID',   classes: 'border-red-500/30 bg-red-500/10 text-red-400' },
  image_gen:         { icon: Image,      label: 'IMG',   classes: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  code:              { icon: Code,       label: 'CODE',  classes: 'border-violet-500/30 bg-violet-500/10 text-violet-400' },
  web_search:        { icon: Globe,      label: 'WEB',   classes: 'border-teal-500/30 bg-teal-500/10 text-teal-400' },
  structured_output: { icon: Braces,     label: 'JSON',  classes: 'border-orange-500/30 bg-orange-500/10 text-orange-400' },
  long_context:      { icon: BookOpen,   label: '200K+', classes: 'border-purple-500/30 bg-purple-500/10 text-purple-400' },
  fast:              { icon: Zap,        label: 'FAST',  classes: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400' },
}

// ---------------------------------------------------------------------------
// Capability badge pill
// ---------------------------------------------------------------------------

function CapabilityBadge({ capability }: { capability: Capability }) {
  const meta = CAPABILITY_META[capability]
  if (!meta) return null
  const Icon = meta.icon
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1 py-0.5 text-[8px] uppercase font-bold leading-none rounded-sm border ${meta.classes}`}
    >
      <Icon className="w-2.5 h-2.5" />
      {meta.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Hook: close dropdown on outside click or Escape
// ---------------------------------------------------------------------------

function useDropdownDismiss(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!isOpen) return

    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [isOpen, onClose, ref])
}

// ---------------------------------------------------------------------------
// ProviderModelSelector
// ---------------------------------------------------------------------------

export function ProviderModelSelector({
  providers,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  loading = false,
  claudeCodeModels,
}: ProviderModelSelectorProps) {
  const [providerOpen, setProviderOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)

  const providerRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)

  useDropdownDismiss(providerRef, providerOpen, () => setProviderOpen(false))
  useDropdownDismiss(modelRef, modelOpen, () => setModelOpen(false))

  const activeProvider = providers.find(p => p.id === selectedProvider) || providers[0]

  // Resolve display name for the selected model
  const selectedModelDisplay = (() => {
    if (selectedProvider === 'claude' && claudeCodeModels) {
      const ccm = claudeCodeModels.find(m => m.value === selectedModel)
      if (ccm) return ccm.label
    }
    const modelObj = activeProvider?.models.find(m => m.id === selectedModel)
    if (modelObj) return modelObj.name
    return selectedModel
  })()

  const handleProviderSelect = (id: string) => {
    onProviderChange(id)
    setProviderOpen(false)
    // Close model dropdown too when switching providers
    setModelOpen(false)
  }

  const handleModelSelect = (id: string) => {
    onModelChange(id)
    setModelOpen(false)
  }

  return (
    <div className="space-y-1.5">
      {/* Provider selector */}
      <div ref={providerRef} className="relative">
        <label className="text-[10px] text-muted block mb-0.5">Provider</label>
        <button
          type="button"
          onClick={() => { setProviderOpen(v => !v); setModelOpen(false) }}
          className="w-full flex items-center justify-between gap-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-[11px] text-white hover:border-white/20 focus:outline-none focus:border-primary/50 transition-colors"
        >
          <span className="truncate">{activeProvider?.label ?? 'Select provider'}</span>
          <ChevronDown className={`w-3 h-3 shrink-0 text-muted transition-transform ${providerOpen ? 'rotate-180' : ''}`} />
        </button>

        {providerOpen && (
          <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded border border-white/10 backdrop-blur-xl bg-black/80 shadow-xl custom-scrollbar">
            {providers.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleProviderSelect(p.id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left transition-colors ${
                  p.id === selectedProvider
                    ? 'bg-primary/15 text-primary'
                    : 'text-white/80 hover:bg-white/5 hover:text-white'
                }`}
              >
                {p.id === selectedProvider && <Check className="w-3 h-3 shrink-0 text-primary" />}
                <span className={p.id === selectedProvider ? '' : 'ml-5'}>{p.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Model selector */}
      <div ref={modelRef} className="relative">
        <label className="text-[10px] text-muted block mb-0.5">Model</label>
        <button
          type="button"
          onClick={() => { setModelOpen(v => !v); setProviderOpen(false) }}
          disabled={loading}
          className="w-full flex items-center justify-between gap-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-[11px] font-mono text-primary hover:border-white/20 focus:outline-none focus:border-primary/50 transition-colors disabled:opacity-50"
        >
          <span className="truncate">{loading ? 'Loading...' : selectedModelDisplay}</span>
          {loading ? (
            <Loader2 className="w-3 h-3 shrink-0 animate-spin text-muted" />
          ) : (
            <ChevronDown className={`w-3 h-3 shrink-0 text-muted transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
          )}
        </button>

        {modelOpen && !loading && (
          <div className="absolute z-50 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded border border-white/10 backdrop-blur-xl bg-black/80 shadow-xl custom-scrollbar">
            {[...new Map((activeProvider?.models ?? []).map(m => [m.id, m])).values()].map(model => {
              const isClaudeCode = selectedProvider === 'claude' && claudeCodeModels
              const displayName = isClaudeCode
                ? (claudeCodeModels!.find(c => c.value === model.id)?.label ?? model.name)
                : model.name
              const isSelected = model.id === selectedModel

              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => handleModelSelect(model.id)}
                  className={`w-full flex items-start gap-2 px-2.5 py-1.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-primary/15'
                      : 'hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                    {isSelected && <Check className="w-3 h-3 text-primary" />}
                  </div>
                  <div className={`flex-1 min-w-0 ${isSelected ? '' : 'ml-[18px]'}`}>
                    <div className={`text-[11px] font-mono truncate ${isSelected ? 'text-primary' : 'text-white/80'}`}>
                      {displayName}
                    </div>
                    {model.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                        {model.capabilities.map(cap => (
                          <CapabilityBadge key={cap} capability={cap} />
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
