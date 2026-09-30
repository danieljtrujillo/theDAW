import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp';
import './mobile.css';
// T20 re-audit item 2: this is the companion entry point's module graph —
// lib/pairing.ts was never reachable from here, so initPairing() (which
// reads `#pair=<token>` from the URL, stores it, and strips it from the
// address bar) never ran on the phone. Side-effect-only import: pairing.ts
// runs initPairing() at module scope on load.
import '../lib/pairing';

// Remove the inline boot cover once React is ready to paint.
document.getElementById('boot-splash')?.remove();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <MobileApp />
    </StrictMode>,
  );
}
