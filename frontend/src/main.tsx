import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {migrateBrandKeys} from './lib/migrateBrandKeys';
import {logInfo, logWarn, logError} from './state/logStore';
import {useBootStatusStore} from './state/bootStatusStore';
import './index.css';

// Carry any legacy persisted storage over to the current key namespace before
// any store hydrates, so no local user data is lost.
migrateBrandKeys();

// Surface uncaught errors + promise rejections in the LOG panel so VERBOSE mode
// is useful for troubleshooting (previously these never reached the panel).
window.addEventListener('error', (e) => {
  const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
  logError('window', `${e.message}${where}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as {message?: string} | string | undefined;
  logError('promise', typeof r === 'string' ? r : (r?.message ?? String(r)));
});

// The packaged Electron main streams first-run bootstrap progress + errors to
// window.setStatus / window.addLog (electron-ui/main/index.ts). Define them so
// that output reaches BOTH the loading screen and the LOG panel, instead of
// vanishing (which made a failed first-run setup look like a silent hang).
const bootBridge = window as unknown as {
  setStatus?: (text: string) => void;
  addLog?: (text: string, cls?: string) => void;
};
bootBridge.setStatus = (text) => {
  useBootStatusStore.getState().setStatus(text);
  logInfo('bootstrap', text);
};
bootBridge.addLog = (text, cls) => {
  useBootStatusStore.getState().pushLog(text);
  // The Electron main historically tags failures 'err' (see sendLoadingLog
  // call sites); accept both spellings so setup failures actually surface.
  if (cls === 'error' || cls === 'err') {
    useBootStatusStore.getState().setError(text);
    logError('bootstrap', text);
  } else if (cls === 'warn') {
    logWarn('bootstrap', text);
  } else {
    logInfo('bootstrap', text);
  }
};

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

