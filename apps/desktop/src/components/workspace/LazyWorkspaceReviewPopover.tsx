import { lazy } from 'react';

type WorkspaceReviewPopoverModule = typeof import('./WorkspaceReviewPopover');

let workspaceReviewPopoverPreload: Promise<WorkspaceReviewPopoverModule> | null = null;

export function preloadWorkspaceReviewPopover(): Promise<WorkspaceReviewPopoverModule> {
  workspaceReviewPopoverPreload ??= import('./WorkspaceReviewPopover');
  return workspaceReviewPopoverPreload;
}

export const LazyWorkspaceReviewPopover = lazy(async () => {
  const module = await preloadWorkspaceReviewPopover();
  return { default: module.WorkspaceReviewPopover };
});
