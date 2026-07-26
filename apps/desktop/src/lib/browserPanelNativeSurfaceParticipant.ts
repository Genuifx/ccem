export type BrowserPanelNativeBackend = 'preview' | 'login';

export interface BrowserPanelNativeSurfaceParticipantOptions {
  backend: BrowserPanelNativeBackend;
  isActive?: () => boolean;
  preparePreviewHide: () => void;
  pausePreview: () => Promise<void> | void;
  hidePreview: () => Promise<void> | void;
  occludeLogin: () => Promise<void> | void;
  restore: () => Promise<void> | void;
}

/**
 * Builds the acknowledgement-bearing BrowserPanel participant used by trusted
 * host overlays. Login Browser occlusion is one backend transaction so Agent
 * cancellation is acknowledged before CEF becomes hidden. Preview Browser has
 * no equivalent native transaction, so its pause ACK is awaited before hide.
 * Restore intentionally never resumes Agent authority.
 */
export function createBrowserPanelNativeSurfaceParticipant(
  options: BrowserPanelNativeSurfaceParticipantOptions,
) {
  const isActive = options.isActive ?? (() => true);
  return {
    prepareHide() {
      if (!isActive()) return;
      if (options.backend === 'preview') options.preparePreviewHide();
    },
    async hide() {
      if (!isActive()) return;
      if (options.backend === 'login') {
        await options.occludeLogin();
        return;
      }
      await options.pausePreview();
      await options.hidePreview();
    },
    async restore() {
      if (!isActive()) return;
      await options.restore();
    },
  };
}
