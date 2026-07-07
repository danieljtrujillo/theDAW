import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp';
import './mobile.css';

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
