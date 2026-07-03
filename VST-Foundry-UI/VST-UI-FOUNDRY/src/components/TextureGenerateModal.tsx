import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Wand2,
  Loader2,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import {
  AppConfig,
  Asset,
  SDConfig,
  SDStatus,
  TextureGenParams,
  LoraEntry,
} from '../types';
import {
  GeneratedTexture,
  QueueItem,
  ProviderTab,
  SdType,
  SDResources,
} from './texture-gen/types';
import { btnCls, STATUS_POLL_MS } from './texture-gen/constants';
import { buildParams as buildGenParams } from './texture-gen/buildParams';
import GenerateForm from './texture-gen/GenerateForm';
import ResultsGrid from './texture-gen/ResultsGrid';
import QueuePanel from './texture-gen/QueuePanel';

interface TextureGenerateModalProps {
  isOpen: boolean;
  onClose: () => void;
  target?: 'texture' | 'asset';
  onTexturesGenerated: (textures: GeneratedTexture[]) => void;
  onAssetsGenerated?: (assets: Asset[]) => void;
}

export default function TextureGenerateModal({
  isOpen,
  onClose,
  target = 'texture',
  onTexturesGenerated,
  onAssetsGenerated,
}: TextureGenerateModalProps) {
  // ---- Provider / tab state ----
  const [activeTab, setActiveTab] = useState<ProviderTab>('sd');
  const [sdType, setSdType] = useState<SdType>('a1111');

  // ---- Config & status ----
  const [config, setConfig] = useState<SDConfig | null>(null);
  const [sdStatus, setSdStatus] = useState<SDStatus | null>(null);
  const [sdResources, setSdResources] = useState<SDResources>({
    models: [],
    vaes: [],
    loras: [],
    samplers: [],
  });
  const [startingStopping, setStartingStopping] = useState(false);

  // ---- Shared prompt ----
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');

  // ---- SD params ----
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [steps, setSteps] = useState(25);
  const [cfgScale, setCfgScale] = useState(7);
  const [sampler, setSampler] = useState('');
  const [seed, setSeed] = useState(-1);
  const [batchCount, setBatchCount] = useState(1);
  const [nIter, setNIter] = useState(1);

  // ---- SD advanced ----
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [model, setModel] = useState('');
  const [vae, setVae] = useState('');
  const [loras, setLoras] = useState<LoraEntry[]>([]);
  const [addLoraOpen, setAddLoraOpen] = useState(false);

  // ---- Cloud params ----
  const [imageSize, setImageSize] = useState('1024x1024');
  const [count, setCount] = useState(1);
  const [quality, setQuality] = useState<'standard' | 'hd'>('standard');
  const [style, setStyle] = useState<'vivid' | 'natural'>('vivid');
  const [apiKey, setApiKey] = useState('');

  // ---- Generation state ----
  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'info' | 'success' | 'error'>(
    'info',
  );
  const [results, setResults] = useState<GeneratedTexture[]>([]);

  // ---- Queue ----
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const queueProcessingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const addLoraRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const provider = activeTab === 'sd' ? sdType : activeTab === 'dalle' ? 'openai' : 'gemini';
  const isSdTab = activeTab === 'sd';

  const sdInstance = config
    ? sdType === 'a1111'
      ? config.a1111
      : config.comfyui
    : null;
  const sdConfigured = !!(sdInstance && sdInstance.execPath && sdInstance.execPath.trim());

  const setStatus = (msg: string | null, kind: 'info' | 'success' | 'error' = 'info') => {
    setStatusMsg(msg);
    setStatusKind(kind);
  };

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------
  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`config ${res.status}`);
      const data: AppConfig = await res.json();
      if (data?.sd) {
        setConfig(data.sd);
        setSdType(data.sd.preferred || 'a1111');
      }
    } catch (err) {
      // Non-fatal: cloud providers still usable
      console.error('Failed to load config', err);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sd/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data: SDStatus = await res.json();
      setSdStatus(data);
    } catch (err) {
      setSdStatus({ running: false, type: null, port: null, startedAt: null });
    }
  }, []);

  const fetchResources = useCallback(async (type: SdType) => {
    try {
      const res = await fetch(`/api/sd/resources?type=${type}`);
      if (!res.ok) throw new Error(`resources ${res.status}`);
      const data: SDResources = await res.json();
      setSdResources({
        models: data.models || [],
        vaes: data.vaes || [],
        loras: data.loras || [],
        samplers: data.samplers || [],
      });
      // Initialise sampler if not yet set
      setSampler((s) => s || data.samplers?.[0]?.id || '');
    } catch (err) {
      setSdResources({ models: [], vaes: [], loras: [], samplers: [] });
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Lifecycle: open / close
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen) return;
    fetchConfig();
    fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Reset all transient state when the modal closes
  useEffect(() => {
    if (isOpen) return;
    // Abort any in-flight generation fetch
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    queueProcessingRef.current = false;
    setActiveTab('sd');
    setResults([]);
    setStatus(null);
    setGenerating(false);
    setStartingStopping(false);
    setAdvancedOpen(false);
    setAddLoraOpen(false);
    setQueue([]);
    // Reset form fields so stale values don't persist on next open
    setPrompt('');
    setNegativePrompt('');
    setWidth(512);
    setHeight(512);
    setSteps(25);
    setCfgScale(7);
    setSampler('');
    setSeed(-1);
    setBatchCount(1);
    setNIter(1);
    setModel('');
    setVae('');
    setLoras([]);
    setImageSize('1024x1024');
    setCount(1);
    setQuality('standard');
    setStyle('vivid');
    setApiKey('');
  }, [isOpen]);

  // Fetch SD resources when the SD tab is active & configured
  useEffect(() => {
    if (!isOpen || !isSdTab) return;
    fetchResources(sdType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isSdTab, sdType]);

  // Poll SD status only while the SD tab is active
  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (isOpen && isSdTab) {
      fetchStatus();
      pollTimerRef.current = setInterval(fetchStatus, STATUS_POLL_MS);
    }
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isOpen, isSdTab, fetchStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  // Close the "Add LoRA" dropdown on outside click
  useEffect(() => {
    if (!addLoraOpen) return;
    const handler = (e: MouseEvent) => {
      if (addLoraRef.current && !addLoraRef.current.contains(e.target as Node)) {
        setAddLoraOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [addLoraOpen]);

  // ---------------------------------------------------------------------------
  // SD process control
  // ---------------------------------------------------------------------------
  const handleStartSd = async () => {
    setStartingStopping(true);
    setStatus(`Starting ${sdType}...`, 'info');
    try {
      const res = await fetch('/api/sd/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdType }),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        throw new Error(data?.message || 'Failed to start');
      }
      setStatus(data?.message || 'Stable Diffusion started.', 'success');
      await fetchStatus();
    } catch (err: any) {
      setStatus(err?.message || 'Failed to start Stable Diffusion.', 'error');
    } finally {
      setStartingStopping(false);
    }
  };

  const handleStopSd = async () => {
    setStartingStopping(true);
    setStatus('Stopping Stable Diffusion...', 'info');
    try {
      const res = await fetch('/api/sd/stop', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        throw new Error(data?.message || 'Failed to stop');
      }
      setStatus(data?.message || 'Stable Diffusion stopped.', 'success');
      await fetchStatus();
    } catch (err: any) {
      setStatus(err?.message || 'Failed to stop Stable Diffusion.', 'error');
    } finally {
      setStartingStopping(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------
  const runItem = useCallback(async (item: QueueItem) => {
    setResults([]);
    const ac = new AbortController();
    abortControllerRef.current = ac;
    setQueue((q) => q.map((i) => i.id === item.id ? { ...i, status: 'running' } : i));
    setGenerating(true);
    setStatusMsg(`[Queue] ${item.label}`);
    setStatusKind('info');
    try {
      const res = await fetch('/api/textures/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.params),
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      const data = await res.json();
      if (ac.signal.aborted) return;
      if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
      const generated: GeneratedTexture[] = data?.results || [];
      if (generated.length === 0) throw new Error('No images returned');
      if (target === 'asset') {
        onAssetsGenerated?.(generated.map((g) => ({ id: g.id, name: g.name, url: g.url })));
      } else {
        onTexturesGenerated(generated);
      }
      setQueue((q) => q.map((i) => i.id === item.id ? { ...i, status: 'done', results: generated } : i));
      setStatusMsg(`Done: ${item.label} — ${generated.length} image(s) added`);
      setStatusKind('success');
    } catch (err: any) {
      if (ac.signal.aborted) return;
      setQueue((q) => q.map((i) => i.id === item.id ? { ...i, status: 'error', error: err?.message } : i));
      setStatusMsg(`Failed: ${item.label} — ${err?.message}`);
      setStatusKind('error');
    } finally {
      setGenerating(false);
      queueProcessingRef.current = false;
      if (abortControllerRef.current === ac) abortControllerRef.current = null;
    }
  }, [target, onAssetsGenerated, onTexturesGenerated]);

  // Auto-process queue: pick next pending item whenever we're idle.
  // queueProcessingRef is a synchronous re-entrancy guard — prevents a second
  // runItem call from starting in the same JS tick before generating flips to true.
  useEffect(() => {
    if (generating || queueProcessingRef.current) return;
    const next = queue.find((i) => i.status === 'pending');
    if (!next) return;
    queueProcessingRef.current = true;
    void runItem(next);
  }, [queue, generating, runItem]);

  const addToQueue = () => {
    if (!prompt.trim()) { setStatus('Enter a prompt before queuing.', 'error'); return; }
    if (isSdTab && !validateSd()) return;
    const params = buildParams();
    const label = prompt.trim().slice(0, 50) + (prompt.trim().length > 50 ? '…' : '');
    setQueue((q) => [...q, {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label,
      params,
      status: 'pending',
    }]);
  };

  const removeQueueItem = (id: string) => {
    setQueue((q) => q.filter((i) => i.id !== id || i.status === 'running'));
  };

  const clearDone = () => {
    setQueue((q) => q.filter((i) => i.status !== 'done'));
  };

  // ---------------------------------------------------------------------------
  // LoRA management
  // ---------------------------------------------------------------------------
  const availableLoras = sdResources.loras.filter(
    (l) => !loras.some((sel) => sel.name === l.id),
  );

  const addLora = (name: string) => {
    setLoras((prev) => [...prev, { name, weight: 1.0 }]);
    setAddLoraOpen(false);
  };

  const updateLoraWeight = (name: string, weight: number) => {
    setLoras((prev) =>
      prev.map((l) => (l.name === name ? { ...l, weight } : l)),
    );
  };

  const removeLora = (name: string) => {
    setLoras((prev) => prev.filter((l) => l.name !== name));
  };

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------
  const buildParams = (): TextureGenParams =>
    buildGenParams({
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
    });

  const validateSd = (): boolean => {
    if (isSdTab && !sdConfigured) {
      setStatus('No SD path configured. Go to Settings to configure Stable Diffusion.', 'error');
      return false;
    }
    if (isSdTab && !sdStatus?.running) {
      setStatus('Stable Diffusion is not running. Start it first.', 'error');
      return false;
    }
    return true;
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) { setStatus('Enter a prompt before generating.', 'error'); return; }
    if (!validateSd()) return;

    const ac = new AbortController();
    abortControllerRef.current = ac;

    setGenerating(true);
    setResults([]);
    setStatus('Generating...', 'info');

    try {
      const res = await fetch('/api/textures/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildParams()),
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      const data = await res.json();
      if (ac.signal.aborted) return;
      if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
      const generated: GeneratedTexture[] = data?.results || [];
      if (generated.length === 0) { setStatus('No images were generated.', 'error'); return; }
      setResults(generated);
      if (target === 'asset') {
        onAssetsGenerated?.(generated.map((g) => ({ id: g.id, name: g.name, url: g.url })));
        setStatus(`Added ${generated.length} image(s) to Asset Library`, 'success');
      } else {
        onTexturesGenerated(generated);
        setStatus(`Added ${generated.length} texture(s) to Texture Library`, 'success');
      }
    } catch (err: any) {
      if (ac.signal.aborted) return;
      setStatus(err?.message || 'Generation failed.', 'error');
    } finally {
      setGenerating(false);
      if (abortControllerRef.current === ac) abortControllerRef.current = null;
    }
  };

  if (!isOpen) return null;

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const tabBtn = (tab: ProviderTab, text: string) => (
    <button
      onClick={() => setActiveTab(tab)}
      className={`flex-1 px-3 py-2 text-[11px] uppercase font-bold tracking-wide transition-colors border-b-2 ${
        activeTab === tab
          ? 'text-app-accent border-app-accent bg-app-surface'
          : 'text-app-muted border-transparent hover:text-app-main hover:bg-app-surface/50'
      }`}
    >
      {text}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-app-base border border-app-border rounded-xl shadow-2xl w-150 max-w-[95vw] max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-app-border flex items-center justify-between bg-app-surface">
          <div className="flex items-center gap-2">
            <Wand2 className="w-4 h-4 text-app-accent" />
            <h2 className="text-sm font-bold text-app-main uppercase tracking-wide">
              {target === 'asset' ? 'Generate Asset' : 'Generate Texture'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-app-muted hover:text-white rounded hover:bg-app-surface-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Provider tabs */}
        <div className="flex border-b border-app-border">
          {tabBtn('sd', 'Stable Diffusion')}
          {tabBtn('dalle', 'DALL-E')}
          {tabBtn('gemini', 'Gemini')}
        </div>

        {/* Body (scroll) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Prompt + parameter inputs */}
          <GenerateForm
            isSdTab={isSdTab}
            sdType={sdType}
            setSdType={setSdType}
            sdConfigured={sdConfigured}
            sdStatus={sdStatus}
            startingStopping={startingStopping}
            onStartSd={handleStartSd}
            onStopSd={handleStopSd}
            prompt={prompt}
            setPrompt={setPrompt}
            negativePrompt={negativePrompt}
            setNegativePrompt={setNegativePrompt}
            width={width}
            setWidth={setWidth}
            height={height}
            setHeight={setHeight}
            steps={steps}
            setSteps={setSteps}
            cfgScale={cfgScale}
            setCfgScale={setCfgScale}
            sampler={sampler}
            setSampler={setSampler}
            seed={seed}
            setSeed={setSeed}
            batchCount={batchCount}
            setBatchCount={setBatchCount}
            nIter={nIter}
            setNIter={setNIter}
            sdResources={sdResources}
            activeTab={activeTab}
            imageSize={imageSize}
            setImageSize={setImageSize}
            count={count}
            setCount={setCount}
            quality={quality}
            setQuality={setQuality}
            style={style}
            setStyle={setStyle}
            apiKey={apiKey}
            setApiKey={setApiKey}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
            model={model}
            setModel={setModel}
            vae={vae}
            setVae={setVae}
            loras={loras}
            availableLoras={availableLoras}
            addLoraOpen={addLoraOpen}
            setAddLoraOpen={setAddLoraOpen}
            addLoraRef={addLoraRef}
            onAddLora={addLora}
            onUpdateLoraWeight={updateLoraWeight}
            onRemoveLora={removeLora}
          />

          {/* Generate / Queue buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className={`${btnCls} flex-1 flex items-center justify-center gap-2 py-2 text-xs ${
                generating ? 'opacity-70 pointer-events-none' : ''
              }`}
            >
              {generating && queue.filter((i) => i.status === 'running').length === 0 ? (
                <><Loader2 className="w-4 h-4 animate-spin" />Generating...</>
              ) : (
                <><Wand2 className="w-4 h-4" />Generate</>
              )}
            </button>
            <button
              onClick={addToQueue}
              className={`${btnCls} flex items-center justify-center gap-1.5 py-2 px-3 text-xs`}
              title="Add to queue"
            >
              + Queue
            </button>
          </div>

          {/* Status */}
          {statusMsg && (
            <div
              className={`flex items-start gap-2 p-2.5 rounded border text-xs ${
                statusKind === 'success'
                  ? 'border-green-600/40 bg-green-900/20 text-green-300'
                  : statusKind === 'error'
                    ? 'border-red-600/40 bg-red-900/20 text-red-300'
                    : 'border-app-border bg-app-surface text-app-muted'
              }`}
            >
              {statusKind === 'success' ? (
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : statusKind === 'error' ? (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <Loader2 className={`w-4 h-4 shrink-0 mt-0.5 ${generating ? 'animate-spin' : ''}`} />
              )}
              <span>{statusMsg}</span>
            </div>
          )}

          {/* Results (immediate generate) */}
          <ResultsGrid results={results} />

          {/* Queue */}
          <QueuePanel
            queue={queue}
            onClearDone={clearDone}
            onRemoveItem={removeQueueItem}
          />
        </div>
      </div>
    </div>
  );
}
