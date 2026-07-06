/**
 * EDIT-layout theme picker — a small toolbar control that opens a popover of
 * color-theme swatches (Dark / Metal / Light / Pastel / Gradient) plus a
 * "custom image" option. Writes to editThemeStore; WaveformEditor applies the
 * resulting CSS variables to its root. The popover is portaled to <body> so it
 * is not itself re-colored by the active theme.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Palette, Check, ImagePlus, X } from 'lucide-react';
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
  return {
    background: vars['--et-root-bg'],
    borderColor: `rgb(${vars['--et-line']} / 0.5)`,
  };
}

function swatchInnerStyle(theme: EditTheme): React.CSSProperties {
  const { vars } = resolveEditThemeVars(theme.id, null);
  return { background: vars['--et-panel'], borderColor: `rgb(${vars['--et-line']} / 0.35)` };
}

export function EditThemePicker(): React.ReactElement {
  const themeId = useEditThemeStore((s) => s.themeId);
  const customImage = useEditThemeStore((s) => s.customImage);
  const setTheme = useEditThemeStore((s) => s.setTheme);
  const setCustomImage = useEditThemeStore((s) => s.setCustomImage);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const grouped = useMemo(() => {
    const by: Record<string, EditTheme[]> = {};
    for (const t of EDIT_THEMES) (by[t.group] ||= []).push(t);
    return GROUP_ORDER.filter((g) => by[g]?.length).map((g) => ({ group: g, themes: by[g] }));
  }, []);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 288;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ top: r.bottom + 6, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => place();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

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
      setOpen(false);
    },
    [setCustomImage],
  );

  const activeIsImage = themeId === CUSTOM_IMAGE_ID && !!customImage;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Editor color theme"
        title="Editor color theme: recolor the EDIT layout backgrounds and borders"
        className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
          ${open ? 'bg-purple-600/20 border-purple-500/40 text-purple-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
      >
        <Palette className="w-3 h-3" /> THEME
      </button>

      {/* Accessible, visually-hidden file input for the custom-image option. */}
      <label htmlFor="edit-theme-image-input" className="sr-only">
        Editor background image
      </label>
      <input
        ref={fileRef}
        id="edit-theme-image-input"
        name="edit-theme-image"
        type="file"
        accept="image/*"
        onChange={onPickImage}
        className="hidden"
        aria-label="Choose editor background image"
      />

      {open && pos
        ? createPortal(
            <div
              ref={popRef}
              role="menu"
              aria-label="Editor color themes"
              style={{ top: pos.top, left: pos.left, width: 288 }}
              className="fixed z-[200] rounded-lg border border-white/10 bg-[#0f0d16] shadow-2xl p-2.5 max-h-[70vh] overflow-y-auto"
            >
              {grouped.map(({ group, themes }) => (
                <div key={group} className="mb-2 last:mb-0">
                  <div className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 px-0.5 mb-1">
                    {group}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {themes.map((t) => {
                      const active = themeId === t.id;
                      return (
                        <button
                          key={t.id}
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => {
                            setTheme(t.id);
                            setOpen(false);
                          }}
                          title={t.label}
                          className={`flex items-center gap-2 rounded border p-1.5 text-left transition-colors
                            ${active ? 'border-purple-500/60 bg-purple-500/10' : 'border-white/10 hover:border-white/25 hover:bg-white/5'}`}
                        >
                          <span
                            className="relative w-7 h-7 rounded border shrink-0 overflow-hidden"
                            style={swatchStyle(t)}
                          >
                            <span
                              className="absolute left-1 right-1 bottom-1 h-2 rounded-[2px] border"
                              style={swatchInnerStyle(t)}
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[10px] text-zinc-200 truncate leading-tight">
                              {t.label}
                            </span>
                          </span>
                          {active ? <Check className="w-3 h-3 text-purple-300 shrink-0" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Custom image */}
              <div className="mt-2 pt-2 border-t border-white/10">
                <div className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 px-0.5 mb-1">
                  Image
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    role="menuitemradio"
                    aria-checked={activeIsImage}
                    onClick={() => fileRef.current?.click()}
                    className={`flex flex-1 items-center gap-2 rounded border p-1.5 transition-colors
                      ${activeIsImage ? 'border-purple-500/60 bg-purple-500/10' : 'border-white/10 hover:border-white/25 hover:bg-white/5'}`}
                  >
                    <span
                      className="w-7 h-7 rounded border border-white/20 shrink-0 bg-cover bg-center"
                      style={
                        customImage
                          ? { backgroundImage: `url("${customImage}")` }
                          : { background: 'linear-gradient(135deg,#39304f,#1a1526)' }
                      }
                    />
                    <span className="flex items-center gap-1.5 text-[10px] text-zinc-200">
                      <ImagePlus className="w-3 h-3 text-zinc-400" />
                      {customImage ? 'Change image…' : 'Choose image…'}
                    </span>
                  </button>
                  {customImage ? (
                    <button
                      onClick={() => setCustomImage(null)}
                      aria-label="Remove background image"
                      title="Remove background image"
                      className="p-1.5 rounded border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
