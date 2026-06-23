import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {migrateBrandKeys} from './lib/migrateBrandKeys';
import './index.css';

// Carry any legacy persisted storage over to the current key namespace before
// any store hydrates, so no local user data is lost.
migrateBrandKeys();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Drop the instant inline splash once React has painted its own (ferro) loading
// screen on top — a frame after mount so there's no flash of blank between them.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('boot-splash');
    if (splash) {
      splash.style.transition = 'opacity 0.4s ease';
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 450);
    }
  });
});

