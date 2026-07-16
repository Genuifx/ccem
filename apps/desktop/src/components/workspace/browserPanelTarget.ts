import type { BrowserSurfaceProfileSelection } from '@/lib/browserSurfaceIpc';

interface BrowserPanelTargetBase {
  requestId: number;
  initialUrl?: string | null;
}

export interface PreviewBrowserPanelTarget extends BrowserPanelTargetBase {
  backend: 'preview';
}

export type LoginBrowserPanelRequest = {
  workingDir: string;
  initialUrl?: string | null;
} & BrowserSurfaceProfileSelection;

export type LoginBrowserPanelTarget = BrowserPanelTargetBase & {
  backend: 'login';
  workingDir: string;
} & BrowserSurfaceProfileSelection;

export type BrowserPanelTarget = PreviewBrowserPanelTarget | LoginBrowserPanelTarget;
