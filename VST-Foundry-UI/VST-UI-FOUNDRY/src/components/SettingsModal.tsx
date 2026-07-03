import React from 'react';
import { X, Check } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  fontScale: number;
  setFontScale: (scale: number) => void;
  colorblindMode: boolean;
  setColorblindMode: (mode: boolean) => void;
  currentTheme: string;
  setTheme: (theme: string) => void;
}

const THEMES = [
  {
    name: 'Midnight Purple',
    id: 'default',
    colors: {
      '--app-base': '#0a0a0c',
      '--app-surface': '#121116',
      '--app-surface-hover': '#1c1a24',
      '--app-main': '#f8fafc',
      '--app-muted': '#a1a1aa',
      '--app-border': '#221f2e',
      '--app-accent': '#a855f7',
      '--app-accent-hover': '#9333ea',
      '--app-accent-subtle': 'rgba(168, 85, 247, 0.2)',
    }
  },
  {
    name: 'Neon Green',
    id: 'neon-green',
    colors: {
      '--app-base': '#050a05',
      '--app-surface': '#0a140a',
      '--app-surface-hover': '#142814',
      '--app-main': '#f0fdf4',
      '--app-muted': '#86efac',
      '--app-border': '#166534',
      '--app-accent': '#22c55e',
      '--app-accent-hover': '#16a34a',
      '--app-accent-subtle': 'rgba(34, 197, 94, 0.2)',
    }
  },
  {
    name: 'Abyssal Blue',
    id: 'abyssal-blue',
    colors: {
      '--app-base': '#020617',
      '--app-surface': '#0f172a',
      '--app-surface-hover': '#1e293b',
      '--app-main': '#f8fafc',
      '--app-muted': '#94a3b8',
      '--app-border': '#334155',
      '--app-accent': '#3b82f6',
      '--app-accent-hover': '#2563eb',
      '--app-accent-subtle': 'rgba(59, 130, 246, 0.2)',
    }
  },
  {
    name: 'Crimson Forge',
    id: 'crimson-forge',
    colors: {
      '--app-base': '#1a0505',
      '--app-surface': '#2b0a0a',
      '--app-surface-hover': '#401212',
      '--app-main': '#fef2f2',
      '--app-muted': '#fca5a5',
      '--app-border': '#7f1d1d',
      '--app-accent': '#ef4444',
      '--app-accent-hover': '#dc2626',
      '--app-accent-subtle': 'rgba(239, 68, 68, 0.2)',
    }
  },
  {
    name: 'Solar Flare',
    id: 'solar-flare',
    colors: {
      '--app-base': '#1c1917',
      '--app-surface': '#292524',
      '--app-surface-hover': '#44403c',
      '--app-main': '#fffbeb',
      '--app-muted': '#fdba74',
      '--app-border': '#9a3412',
      '--app-accent': '#f97316',
      '--app-accent-hover': '#ea580c',
      '--app-accent-subtle': 'rgba(249, 115, 22, 0.2)',
    }
  },
  {
    name: 'Monochrome',
    id: 'monochrome',
    colors: {
      '--app-base': '#000000',
      '--app-surface': '#111111',
      '--app-surface-hover': '#222222',
      '--app-main': '#ffffff',
      '--app-muted': '#a3a3a3',
      '--app-border': '#404040',
      '--app-accent': '#ffffff',
      '--app-accent-hover': '#d4d4d4',
      '--app-accent-subtle': 'rgba(255, 255, 255, 0.2)',
    }
  },
  {
    name: 'Cyberpunk',
    id: 'cyberpunk',
    colors: {
      '--app-base': '#120428',
      '--app-surface': '#1f0940',
      '--app-surface-hover': '#32105c',
      '--app-main': '#fdf2f8',
      '--app-muted': '#f472b6',
      '--app-border': '#831843',
      '--app-accent': '#ec4899',
      '--app-accent-hover': '#db2777',
      '--app-accent-subtle': 'rgba(236, 72, 153, 0.2)',
    }
  },
  {
    name: 'Oceanic',
    id: 'oceanic',
    colors: {
      '--app-base': '#041f2e',
      '--app-surface': '#073347',
      '--app-surface-hover': '#0c4a66',
      '--app-main': '#ecfeff',
      '--app-muted': '#67e8f9',
      '--app-border': '#155e75',
      '--app-accent': '#06b6d4',
      '--app-accent-hover': '#0891b2',
      '--app-accent-subtle': 'rgba(6, 182, 212, 0.2)',
    }
  }
];

export const applyTheme = (themeId: string) => {
  const theme = THEMES.find(t => t.id === themeId) || THEMES[0];
  Object.entries(theme.colors).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });
};

export default function SettingsModal({
  isOpen,
  onClose,
  fontScale,
  setFontScale,
  colorblindMode,
  setColorblindMode,
  currentTheme,
  setTheme
}: SettingsModalProps) {
  const [sdConfig, setSdConfig] = React.useState<any>(null);
  const [sdSaving, setSdSaving] = React.useState(false);
  const [sdSaved, setSdSaved] = React.useState(false);
  const [sdError, setSdError] = React.useState(false);

  React.useEffect(() => {
    if (!isOpen) return;
    fetch('/api/config').then(r => r.json()).then(setSdConfig).catch(() => {});
  }, [isOpen]);

  const handleSdSave = async () => {
    if (!sdConfig) return;
    setSdSaving(true);
    setSdError(false);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sdConfig),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status} ${res.statusText}`);
      setSdSaved(true);
      setTimeout(() => setSdSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save SD settings', err);
      setSdError(true);
      setTimeout(() => setSdError(false), 3000);
    }
    setSdSaving(false);
  };

  const updateSdField = (path: string[], value: any) => {
    setSdConfig((prev: any) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      let obj = next;
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
      obj[path[path.length - 1]] = value;
      return next;
    });
  };

  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-app-base border border-app-border rounded-xl w-225 max-w-[95vw] max-h-[92vh] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-app-border bg-app-surface shrink-0">
          <h2 className="text-lg font-bold text-app-main tracking-tight">Accessibility & Theme Settings</h2>
          <button
            onClick={onClose}
            className="text-app-muted hover:text-white transition-colors p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6 flex-1 min-h-0">
          {/* Typography Scale */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-app-main uppercase tracking-wider">Typography Scale</h3>
            <div className="flex items-center gap-4">
              <span className="text-xs text-app-muted">A</span>
              <input
                type="range"
                min="0.8"
                max="1.5"
                step="0.05"
                value={fontScale}
                onChange={(e) => setFontScale(parseFloat(e.target.value))}
                className="flex-1 accent-app-accent"
              />
              <span className="text-lg text-app-main">A</span>
            </div>
            <div className="text-xs text-app-muted text-right">
              {Math.round(fontScale * 100)}%
            </div>
          </div>

          <div className="w-full h-px bg-app-border" />

          {/* Accessibility */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-app-main uppercase tracking-wider">Accessibility</h3>
            <label className="flex items-center gap-3 cursor-pointer group">
              <input type="checkbox" className="sr-only" checked={colorblindMode} onChange={(e) => setColorblindMode(e.target.checked)} />
              <div className={`w-10 h-5 rounded-full relative transition-colors ${colorblindMode ? 'bg-app-accent' : 'bg-app-surface border border-app-border'}`}>
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${colorblindMode ? 'translate-x-5' : 'translate-x-0'}`} />
              </div>
              <span className="text-sm text-app-main group-hover:text-white transition-colors">Colorblind Assist Mode</span>
            </label>
            <p className="text-xs text-app-muted mt-1">
              Enhances contrast and saturation for improved visual distinction.
            </p>
          </div>

          <div className="w-full h-px bg-app-border" />

          {/* Theme Selection */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-app-main uppercase tracking-wider">UI Theme</h3>
            <div className="grid grid-cols-4 gap-3">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  onClick={() => setTheme(theme.id)}
                  className={`flex flex-col items-center gap-2 p-2 rounded-lg border transition-all ${currentTheme === theme.id ? 'border-app-accent bg-app-surface shadow-[0_0_15px_rgba(168,85,247,0.3)]' : 'border-app-border hover:border-app-muted hover:bg-app-surface'}`}
                  title={theme.name}
                >
                  <div 
                    className="w-8 h-8 rounded-full border border-white/10 shadow-inner flex items-center justify-center relative overflow-hidden"
                    style={{ background: theme.colors['--app-surface'] }}
                  >
                    <div className="absolute inset-0 bg-linear-to-br from-transparent to-black/30" />
                    <div 
                      className="w-3 h-3 rounded-full relative z-10"
                      style={{ background: theme.colors['--app-accent'] }}
                    />
                  </div>
                  <span className="text-[10px] text-app-main text-center leading-tight">
                    {theme.name}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* ─── Stable Diffusion ─── */}
          {sdConfig && (
            <div className="border-t border-app-border pt-4 mt-4">
              <h3 className="text-xs font-bold uppercase text-app-accent mb-3">Stable Diffusion</h3>

              {/* Preferred engine */}
              <div className="mb-3">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">Preferred Engine</label>
                <div className="flex gap-2">
                  {(['a1111', 'comfyui'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => updateSdField(['sd', 'preferred'], t)}
                      className={`flex-1 py-1 rounded text-[10px] font-bold uppercase border transition-colors ${
                        sdConfig.sd?.preferred === t
                          ? 'bg-app-accent border-app-accent text-white'
                          : 'bg-app-surface border-app-border text-app-muted hover:border-app-accent'
                      }`}
                    >
                      {t === 'a1111' ? 'A1111 / Forge' : 'ComfyUI'}
                    </button>
                  ))}
                </div>
              </div>

              {/* A1111 section */}
              <div className="mb-3">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">A1111 / Forge Executable Path</label>
                <input
                  type="text"
                  className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                  placeholder="C:\stable-diffusion-webui\launch.py"
                  value={sdConfig.sd?.a1111?.execPath || ''}
                  onChange={(e) => updateSdField(['sd', 'a1111', 'execPath'], e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                  <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">A1111 Port</label>
                  <input
                    type="number"
                    className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                    value={sdConfig.sd?.a1111?.port || 7860}
                    onChange={(e) => updateSdField(['sd', 'a1111', 'port'], parseInt(e.target.value, 10) || 7860)}
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sdConfig.sd?.a1111?.autoStart || false}
                      onChange={(e) => updateSdField(['sd', 'a1111', 'autoStart'], e.target.checked)}
                      className="accent-app-accent"
                    />
                    <span className="text-app-muted text-[10px] uppercase font-bold">Auto-start</span>
                  </label>
                </div>
              </div>
              <div className="mb-3">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">A1111 Extra Args</label>
                <input
                  type="text"
                  className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                  placeholder="--api"
                  value={sdConfig.sd?.a1111?.extraArgs || ''}
                  onChange={(e) => updateSdField(['sd', 'a1111', 'extraArgs'], e.target.value)}
                />
              </div>
              <div className="mb-3">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">A1111 Python Path <span className="normal-case font-normal text-app-muted">(auto-detected if blank)</span></label>
                <input
                  type="text"
                  className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                  placeholder="auto — e.g. ...\venv\Scripts\python.exe"
                  value={sdConfig.sd?.a1111?.pythonPath || ''}
                  onChange={(e) => updateSdField(['sd', 'a1111', 'pythonPath'], e.target.value)}
                />
              </div>

              {/* ComfyUI section */}
              <div className="mb-3">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">ComfyUI Executable Path</label>
                <input
                  type="text"
                  className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                  placeholder="C:\ComfyUI\main.py"
                  value={sdConfig.sd?.comfyui?.execPath || ''}
                  onChange={(e) => updateSdField(['sd', 'comfyui', 'execPath'], e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                  <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">ComfyUI Port</label>
                  <input
                    type="number"
                    className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                    value={sdConfig.sd?.comfyui?.port || 8188}
                    onChange={(e) => updateSdField(['sd', 'comfyui', 'port'], parseInt(e.target.value, 10) || 8188)}
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sdConfig.sd?.comfyui?.autoStart || false}
                      onChange={(e) => updateSdField(['sd', 'comfyui', 'autoStart'], e.target.checked)}
                      className="accent-app-accent"
                    />
                    <span className="text-app-muted text-[10px] uppercase font-bold">Auto-start</span>
                  </label>
                </div>
              </div>

              <div className="mb-3">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">ComfyUI Python Path <span className="normal-case font-normal text-app-muted">(auto-detected if blank)</span></label>
                <input
                  type="text"
                  className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                  placeholder="auto — e.g. ...\venv\Scripts\python.exe"
                  value={sdConfig.sd?.comfyui?.pythonPath || ''}
                  onChange={(e) => updateSdField(['sd', 'comfyui', 'pythonPath'], e.target.value)}
                />
              </div>

              {/* Shared paths */}
              <div className="mb-3">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">Model Library Directory</label>
                <input
                  type="text"
                  className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                  placeholder="C:\AI\models\Stable-diffusion"
                  value={sdConfig.sd?.modelLibraryDir || ''}
                  onChange={(e) => updateSdField(['sd', 'modelLibraryDir'], e.target.value)}
                />
              </div>
              <div className="mb-4">
                <label className="text-app-muted text-[10px] uppercase font-bold block mb-1">Output Directory (optional)</label>
                <input
                  type="text"
                  className="bg-app-surface border border-app-border rounded px-2 py-1 text-app-main text-xs w-full"
                  placeholder="C:\AI\outputs\txt2img"
                  value={sdConfig.sd?.outputDir || ''}
                  onChange={(e) => updateSdField(['sd', 'outputDir'], e.target.value)}
                />
              </div>

              <button
                onClick={handleSdSave}
                disabled={sdSaving}
                className="btn-3d text-white px-4 py-1.5 rounded text-[10px] uppercase font-bold w-full"
              >
                {sdSaving ? 'Saving...' : sdError ? 'Save Failed — Retry' : sdSaved ? 'Saved!' : 'Save SD Settings'}
              </button>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-app-border bg-app-surface flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-app-accent text-white text-sm font-medium rounded-lg hover:bg-app-accent-hover transition-colors shadow-[0_2px_10px_rgba(168,85,247,0.3)]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
