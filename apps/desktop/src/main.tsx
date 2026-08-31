import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import { PetOverlay } from './pages/PetOverlay';
import { TrayCockpit } from './pages/TrayCockpit';
import { initPerformanceMode } from './lib/performance';
import { initPerfLog } from './lib/perf-log';
import { resolveDesktopWindowRoot } from './lib/windowRootRouting';
import './index.css';

initPerformanceMode();
initPerfLog();

function resolveRoot() {
  const requestedWindow = new URLSearchParams(window.location.search).get('window');
  let nativeWindowLabel: string | null = null;
  try {
    nativeWindowLabel = getCurrentWindow().label;
  } catch {
    // Browser-only preview has no native Tauri window label.
  }
  const root = resolveDesktopWindowRoot(requestedWindow, nativeWindowLabel);
  document.documentElement.dataset.window = root;

  switch (root) {
    case 'desktop-pet':
      return PetOverlay;
    case 'tray-cockpit':
      return TrayCockpit;
    case 'main':
    default:
      return App;
  }
}

const Root = resolveRoot();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
