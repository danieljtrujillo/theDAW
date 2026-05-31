/**
 * DetachableWindow — render React children into a separate browser window via
 * a portal, so a panel can live on a second monitor while the main app keeps
 * running.
 *
 * Because the portal renders with the opener's React + JS realm (window.open
 * with no URL is same-origin and shares our module scope), all zustand stores,
 * the MIDI bus, and the control-sync buses keep working in the detached window
 * exactly as in-app — it's the same live state, just painted into another
 * window's DOM.
 *
 * Stylesheets are cloned from the opener document so Tailwind + the component
 * CSS apply in the popup. (Dev HMR injects styles dynamically; a popup opened
 * mid-session gets a snapshot — re-pop after a hot update if styles drift.)
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface DetachableWindowProps {
  title: string;
  /** window.open feature string (size/position). */
  features?: string;
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
  title,
  features,
  onClose,
  children,
}) => {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const win = window.open(
      '',
      title.replace(/\s+/g, '_'),
      features ?? 'width=540,height=820,menubar=no,toolbar=no,location=no,status=no',
    );
    if (!win) {
      // popup blocked — tell the caller so it can fall back to the in-app view
      onClose();
      return;
    }
    win.document.title = title;
    cloneStyles(document, win.document);

    const mount = win.document.createElement('div');
    mount.style.height = '100%';
    win.document.body.appendChild(mount);
    setHost(mount);

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
      win.removeEventListener('beforeunload', handleClose);
      window.clearInterval(poll);
      if (!win.closed) win.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!host) return null;
  return createPortal(children, host);
};
