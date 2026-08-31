export interface BrowserPanelNativeSurfaceParticipantOptions {
  isActive?: () => boolean;
  occlude: () => Promise<void> | void;
  restore: () => Promise<void> | void;
}

/**
 * Builds the acknowledgement-bearing BrowserPanel participant used by trusted
 * host overlays. Occlusion is one Mode 2 transaction so Agent cancellation is
 * acknowledged before CEF becomes hidden. BrowserPanel owns the exact-lease
 * decision to resume Agent control after this participant restores the surface.
 */
export function createBrowserPanelNativeSurfaceParticipant(
  options: BrowserPanelNativeSurfaceParticipantOptions,
) {
  const isActive = options.isActive ?? (() => true);
  return {
    async hide() {
      if (!isActive()) return;
      await options.occlude();
    },
    async restore() {
      if (!isActive()) return;
      await options.restore();
    },
  };
}
