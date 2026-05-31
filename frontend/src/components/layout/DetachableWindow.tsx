/**
 * DetachableWindow — render React children into a separate browser window via
 * a portal, so a panel can live on a second monitor while the main app keeps
 * running.
 *
 * IMPORTANT: the window MUST be opened by the caller *synchronously inside the
 * click handler* and passed in as `win`. Browsers block `window.open` that runs
 * outside a user gesture (e.g. from an effect after a state change) — that was
 * the original "pop-out does nothing" bug. This component only adopts the
 * already-open window: clone styles, mount a portal root, wire close detection.
 *
 * Because the portal renders in the opener's React + JS realm (window.open with
 * no URL is same-origin and shares our module scope), all zustand stores, the
 * MIDI bus, and the control-sync buses keep working in the detached window
 * exactly as in-app — same live state, just painted into another window's DOM.
 *
 * Stylesheets are cloned from the opener document so Tailwind + component CSS
 * apply in the popup. (Dev HMR injects styles dynamically; a popup opened
 * mid-session gets a snapshot — re-pop after a hot update if styles drift.)
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface DetachableWindowProps {
  /** A window already opened in a user-gesture click (see note above). */
  win: Window;
  title: string;
  /** Fired when the popup closes (manually or via unmount). */
  onClose: () => void;
  children: React.ReactNode;
}

function cloneStyles(src: Document, dst: Document): void {
  src.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    dst.head.appendChild(node.cloneNode(true));
  });
  dst.body.style.margin = '0';
  dst.body.style.background = '#07060c';
  dst.documentElement.style.height = '100%';
  dst.body.style.height = '100%';
}

export const DetachableWindow: React.FC<DetachableWindowProps> = ({
  win,
  title,
  onClose,
  children,
}) => {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    win.document.title = title;
    cloneStyles(document, win.document);

    const mount = win.document.createElement('div');
    mount.style.height = '100%';
    win.document.body.appendChild(mount);
    setHost(mount);

    // ←/→ page-nav is wired on the OPENER's window; key events in the popup go
    // to the popup. Forward arrows back to the opener so paging works from the
    // detached window too (the stores are shared, so both windows re-render).
    const forwardKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }));
      }
    };
    win.addEventListener('keydown', forwardKey);

    // Closing the popup (its X, or the opener navigating away) restores in-app.
    const handleClose = () => onClose();
    win.addEventListener('beforeunload', handleClose);
    // Some browsers don't fire beforeunload on manual close — poll as a backstop.
    const poll = window.setInterval(() => {
      if (win.closed) {
        window.clearInterval(poll);
        onClose();
      }
    }, 500);

    return () => {
      win.removeEventListener('keydown', forwardKey);
      win.removeEventListener('beforeunload', handleClose);
      window.clearInterval(poll);
      if (!win.closed) win.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!host) return null;
  return createPortal(children, host);
};
