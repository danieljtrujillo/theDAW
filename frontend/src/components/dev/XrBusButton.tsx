/**
 * XR Bus tester, as a button rather than a dock tab.
 *
 * It simulates an XR headset or a phone driving the control bus, which is a
 * diagnostic for the two surfaces that consume the bus -- VJ and SLIDE. A
 * whole tab in the bottom dock for it cost every other panel a slot; a button
 * on the surfaces it tests puts it where it is used.
 *
 * Still dev-only, as the tab was: production builds render nothing.
 */
import React, { useState } from 'react';
import { Radio, X } from 'lucide-react';
import { XrBusPanel } from './XrBusTester';

export const XrBusButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [open, setOpen] = useState(false);
  if (!import.meta.env.DEV) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="XR Bus tester"
        title="XR Bus tester: simulate a headset or phone driving the control bus"
        className={`p-1 rounded border text-[9px] flex items-center gap-1 ${
          open
            ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
            : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'
        } ${className}`}
      >
        <Radio className="w-3 h-3" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="XR Bus tester"
          className="fixed inset-0 z-200 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-3xl h-[70vh] rounded-lg border border-cyan-500/30 bg-[#0a080f] shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close the XR Bus tester"
              className="absolute top-2 right-2 z-10 p-1 rounded text-zinc-400 hover:text-zinc-100"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="absolute inset-0 pt-8">
              <XrBusPanel />
            </div>
          </div>
        </div>
      )}
    </>
  );
};
