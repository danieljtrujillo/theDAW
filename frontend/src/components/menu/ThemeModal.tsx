/**
 * Change Theme modal (opened from the hamburger menu). Recolors the EDIT
 * layout's backgrounds and borders via editThemeStore. Selecting a swatch
 * applies immediately, so the modal doubles as a live preview. A custom
 * background image can be chosen too.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, ImagePlus, Palette } from 'lucide-react';
import { useEditThemeStore } from '../../state/editThemeStore';
import {
  EDIT_THEMES,
  CUSTOM_IMAGE_ID,
  resolveEditThemeVars,
  type EditTheme,
} from '../../lib/editThemes';

const GROUP_ORDER = ['Dark', 'Metal', 'Light', 'Pastel', 'Gradient'];

function swatchStyle(theme: EditTheme): React.CSSProperties {
  const { vars } = resolveEditThemeVars(theme.id, null);
  return { background: vars['--et-root-bg'], borderColor: `rgb(${vars['--et-line']} / 0.5)` };
}
function swatchInnerStyle(theme: EditTheme): React.CSSProperties {
  const { vars } = resolveEditThemeVars(theme.id, null);
  return { background: vars['--et-panel'], borderColor: `rgb(${vars['--et-line']} / 0.35)` };
}

export function ThemeModal({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const themeId = useEditThemeStore((s) => s.themeId);
  const customImage = useEditThemeStore((s) => s.customImage);
  const setTheme = useEditThemeStore((s) => s.setTheme);
  const setCustomImage = useEditThemeStore((s) => s.setCustomImage);
  const fileRef = useRef<HTMLInputElement>(null);

  const grouped = useMemo(() => {
    const by: Record<string, EditTheme[]> = {};
    for (const t of EDIT_THEMES) (by[t.group] ||= []).push(t);
    return GROUP_ORDER.filter((g) => by[g]?.length).map((g) => ({ group: g, themes: by[g] }));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onPickImage = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') setCustomImage(reader.result);
      };
      reader.readAsDataURL(file);
    },
    [setCustomImage],
  );

  if (!open) return null;
  const activeIsImage = themeId === CUSTOM_IMAGE_ID && !!customImage;

  return createPortal(
    <div
      className="fixed inset-0 z-[300] grid place-items-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change theme"
        className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0f0d16] shadow-2xl p-4"
      >
        <div className="flex items-center gap-2 mb-3">
          <Palette className="w-4 h-4 text-teal-300" />
          <h2 className="text-[12px] font-mono uppercase tracking-widest text-zinc-200">Change Theme</h2>
          <span className="text-[9px] font-mono text-zinc-500">EDIT layout backgrounds &amp; borders</span>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="ml-auto p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {grouped.map(({ group, themes }) => (
          <div key={group} className="mb-3 last:mb-0">
            <div className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 px-0.5 mb-1.5">{group}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {themes.map((t) => {
                const active = themeId === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    title={t.label}
                    className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
                      active ? 'border-teal-500/60 bg-teal-500/10' : 'border-white/10 hover:border-white/25 hover:bg-white/5'
                    }`}
                  >
                    <span className="relative w-8 h-8 rounded border shrink-0 overflow-hidden" style={swatchStyle(t)}>
                      <span className="absolute left-1 right-1 bottom-1 h-2.5 rounded-[2px] border" style={swatchInnerStyle(t)} />
                    </span>
                    <span className="min-w-0 flex-1 text-[10px] text-zinc-200 truncate">{t.label}</span>
                    {active ? <Check className="w-3.5 h-3.5 text-teal-300 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div className="mt-3 pt-3 border-t border-white/10">
          <div className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 px-0.5 mb-1.5">Image</div>
          <label htmlFor="theme-modal-image-input" className="sr-only">
            Editor background image
          </label>
          <input
            ref={fileRef}
            id="theme-modal-image-input"
            name="theme-modal-image"
            type="file"
            accept="image/*"
            onChange={onPickImage}
            className="hidden"
            aria-label="Choose editor background image"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              className={`flex flex-1 items-center gap-2 rounded-lg border p-2 transition-colors ${
                activeIsImage ? 'border-teal-500/60 bg-teal-500/10' : 'border-white/10 hover:border-white/25 hover:bg-white/5'
              }`}
            >
              <span
                className="w-8 h-8 rounded border border-white/20 shrink-0 bg-cover bg-center"
                style={customImage ? { backgroundImage: `url("${customImage}")` } : { background: 'linear-gradient(135deg,#39304f,#1a1526)' }}
              />
              <span className="flex items-center gap-1.5 text-[10px] text-zinc-200">
                <ImagePlus className="w-3.5 h-3.5 text-zinc-400" />
                {customImage ? 'Change background image…' : 'Choose background image…'}
              </span>
            </button>
            {customImage ? (
              <button
                onClick={() => setCustomImage(null)}
                aria-label="Remove background image"
                title="Remove background image"
                className="p-2 rounded-lg border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
