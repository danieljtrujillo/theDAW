import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Info, X } from 'lucide-react';

/* ─── Hover tooltip (granular params) ────────────────────────────── */

export function HoverTip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const tipW = 260;
    const tipH = 80;
    let x = rect.left + rect.width / 2;
    let y = rect.top - 8;

    // keep on screen
    if (x - tipW / 2 < 8) x = tipW / 2 + 8;
    if (x + tipW / 2 > window.innerWidth - 8) x = window.innerWidth - tipW / 2 - 8;
    if (y - tipH < 8) y = rect.bottom + 8 + tipH; // flip below

    setPos({ x, y });
  }, []);

  return (
    <span
      ref={ref}
      className="inline-flex min-w-0"
      onMouseEnter={() => { reposition(); setShow(true); }}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      <AnimatePresence>
        {show && (
          <motion.div
            ref={tipRef}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="fixed z-[9999] pointer-events-none"
            style={{
              left: pos.x,
              top: pos.y,
              transform: 'translate(-50%, -100%)',
            }}
          >
            <div className="max-w-[260px] px-3 py-2 rounded-lg bg-zinc-900/95 border border-purple-500/20 shadow-2xl shadow-purple-900/20 backdrop-blur-sm">
              <p className="text-[10px] leading-relaxed text-zinc-300">{text}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

/* ─── Click-to-pin tooltip (sections / concepts) ─────────────────── */

export function InfoTip({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const lines = body.split('\n');

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="p-0 border-0 bg-transparent cursor-pointer flex items-center justify-center"
        aria-label={`Info: ${title}`}
      >
        <Info
          className={`w-3 h-3 transition-all duration-200 ${
            open
              ? 'text-purple-400 drop-shadow-[0_0_6px_rgba(139,92,246,0.6)]'
              : hovered
                ? 'text-purple-400/80 drop-shadow-[0_0_4px_rgba(139,92,246,0.4)]'
                : 'text-zinc-600'
          }`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute z-[9999] left-0 top-full mt-1.5"
            style={{ minWidth: '280px', maxWidth: '340px' }}
          >
            <div className="rounded-lg bg-zinc-900/95 border border-purple-500/25 shadow-2xl shadow-purple-900/30 backdrop-blur-sm overflow-hidden">
              {/* header */}
              <div className="flex items-center justify-between px-3 py-1.5 bg-purple-500/8 border-b border-purple-500/15">
                <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300">{title}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setOpen(false); }}
                  className="p-0.5 rounded hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              {/* body */}
              <div className="px-3 py-2.5 max-h-[280px] overflow-y-auto">
                {lines.map((line, i) => {
                  if (line.trim() === '') return <div key={i} className="h-1.5" />;
                  if (line.startsWith('•')) {
                    return (
                      <div key={i} className="flex gap-1.5 mb-0.5">
                        <span className="text-purple-400 text-[10px] leading-relaxed shrink-0">•</span>
                        <span className="text-[10px] leading-relaxed text-zinc-300">{line.slice(1).trim()}</span>
                      </div>
                    );
                  }
                  return (
                    <p key={i} className="text-[10px] leading-relaxed text-zinc-300 mb-0.5">{line}</p>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
