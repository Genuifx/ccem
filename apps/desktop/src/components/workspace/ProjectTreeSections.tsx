import { memo } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronRight,
  ChevronsUp,
  FolderClosed,
  FolderOpen,
  MessageSquare,
  RefreshCw,
  SquarePen,
  X,
} from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { HistorySessionItem } from '@/features/conversations/types';
import type { ProjectClassification, ProjectNode, RecentSessionBucket } from './workspaceProjectTreeModel';

export const PROJECT_TREE_PAGE_SIZE = 6;
export const RECENT_BUCKET_PAGE_SIZE = 15;

type RenderSessionRow = (
  session: HistorySessionItem,
  options?: {
    pinnedSection?: boolean;
    recentSection?: boolean;
    activeTemporarySection?: boolean;
  },
) => ReactNode;

type ProjectActionCallbacks = {
  onMarkTemporary: (project: string) => void;
  onKeepMain: (project: string) => void;
  onResetProjectClassification: (project: string) => void;
  onOrganizeSidebar: () => void;
};

type ProjectNodeSectionKind = 'main' | 'temporary' | 'activeTemporary';

export const PinnedSessionsSection = memo(function PinnedSessionsSection({
  pinnedSessions,
  renderSessionRow,
  t,
}: {
  pinnedSessions: HistorySessionItem[];
  renderSessionRow: RenderSessionRow;
  t: (key: string) => string;
}) {
  // No pinned sessions, no section — keep the sidebar free of empty placeholders.
  if (pinnedSessions.length === 0) {
    return null;
  }

  return (
    <div className="px-0.5 pt-1">
      <div className="flex h-5 items-center justify-between px-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('workspace.pinnedSessions')}
        </span>
        <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-muted-foreground">
          {pinnedSessions.length}
        </span>
      </div>
      <div className="mt-1 pr-0.5">
        {pinnedSessions.map((session) => renderSessionRow(session, { pinnedSection: true }))}
      </div>
    </div>
  );
});

const RECENT_BUCKET_LABEL_KEYS = {
  running: 'workspace.recentRunning',
  today: 'workspace.recentToday',
  yesterday: 'workspace.recentYesterday',
  week: 'workspace.recentWeek',
  older: 'workspace.recentOlder',
} as const;

export const RecentSessionsSection = memo(function RecentSessionsSection({
  buckets,
  onLoadMoreBucket,
  onCollapseBucket,
  renderSessionRow,
  t,
}: {
  buckets: Array<RecentSessionBucket & { totalCount: number }>;
  onLoadMoreBucket: (bucketId: RecentSessionBucket['id']) => void;
  onCollapseBucket: (bucketId: RecentSessionBucket['id']) => void;
  renderSessionRow: RenderSessionRow;
  t: (key: string) => string;
}) {
  return (
    <div>
      {buckets.map((bucket) => {
        const hasMore = bucket.totalCount > bucket.sessions.length;
        const canCollapse = bucket.sessions.length > RECENT_BUCKET_PAGE_SIZE;
        return (
          <div key={bucket.id} data-recent-bucket={bucket.id} className="px-0.5 pt-1">
            <div className="flex h-5 items-center justify-between px-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t(RECENT_BUCKET_LABEL_KEYS[bucket.id])}
              </span>
              <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-muted-foreground">
                {bucket.totalCount}
              </span>
            </div>
            <div className="mt-1 pr-0.5">
              {bucket.sessions.map((session) => renderSessionRow(session, { recentSection: true }))}
            </div>
            {(hasMore || canCollapse) && (
              <div className="flex items-center gap-3 pl-2 pr-2 py-1.5 text-[11px]">
                {canCollapse && (
                  <button
                    type="button"
                    onClick={() => onCollapseBucket(bucket.id)}
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronsUp className="h-3 w-3" />
                    {t('workspace.collapseList')}
                  </button>
                )}
                {hasMore && (
                  <>
                    <button
                      type="button"
                      onClick={() => onLoadMoreBucket(bucket.id)}
                      className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {t('workspace.loadMore')}
                    </button>
                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/50">
                      {bucket.sessions.length}/{bucket.totalCount}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export const ProjectTreeContent = memo(function ProjectTreeContent({
  activeTemporaryProjectNodes,
  classificationsByProject,
  effectiveExpanded,
  getVisibleCount,
  getVisibleSessions,
  isLoading,
  mainProjectNodes,
  onCreateForProject,
  onDismissActiveTemporaryProject,
  pinnedSessionsCount,
  projectActions,
  recentBuckets,
  recentTotalCount,
  onLoadMoreRecentBucket,
  onCollapseRecentBucket,
  renderSessionRow,
  temporaryProjectNodes,
  toggleProject,
  collapseList,
  loadMore,
  t,
}: {
  activeTemporaryProjectNodes: ProjectNode[];
  classificationsByProject: Record<string, ProjectClassification | undefined>;
  effectiveExpanded: Set<string>;
  getVisibleCount: (project: string) => number;
  getVisibleSessions: (node: ProjectNode) => HistorySessionItem[];
  isLoading: boolean;
  mainProjectNodes: ProjectNode[];
  onCreateForProject?: (projectPath: string) => void;
  onDismissActiveTemporaryProject: (project: string) => void;
  pinnedSessionsCount: number;
  projectActions: ProjectActionCallbacks;
  /** When defined, the tree renders time-bucketed flat groups instead of project groups. */
  recentBuckets?: Array<RecentSessionBucket & { totalCount: number }>;
  recentTotalCount?: number;
  onLoadMoreRecentBucket?: (bucketId: RecentSessionBucket['id']) => void;
  onCollapseRecentBucket?: (bucketId: RecentSessionBucket['id']) => void;
  renderSessionRow: RenderSessionRow;
  temporaryProjectNodes: ProjectNode[];
  toggleProject: (project: string) => void;
  collapseList: (project: string) => void;
  loadMore: (project: string) => void;
  t: (key: string) => string;
}) {
  const isRecentMode = recentBuckets !== undefined;
  const hasProjectNodes =
    mainProjectNodes.length > 0
    || temporaryProjectNodes.length > 0
    || activeTemporaryProjectNodes.length > 0;
  const hasContent = isRecentMode ? (recentTotalCount ?? 0) > 0 : hasProjectNodes;

  const renderProjectNode = (
    node: ProjectNode,
    section: ProjectNodeSectionKind,
  ) => {
    const isActiveTemporary = section === 'activeTemporary';
    const isExpanded = effectiveExpanded.has(node.project);
    const visibleCount = getVisibleCount(node.project);
    const visible = getVisibleSessions(node);
    const hasMore = node.sessions.length > visible.length;
    const canCollapse = visibleCount > PROJECT_TREE_PAGE_SIZE;
    const classification = classificationsByProject[node.project];
    const isTemporary = classification?.bucket === 'temporary';
    const parentName = classification?.parentProjectName;
    const metaLabel = isTemporary
      ? parentName
        ? t('workspace.temporaryProjectParent').replace('{project}', parentName)
        : t('workspace.temporaryProjectLabel')
      : null;
    const showDismiss = isActiveTemporary;

    // Unified row vocabulary across main / temporary / activeTemporary sections.
    // Active-temporary carries no decorative glow, no border, no shadow — the
    // section location IS the active signal. Side-stripe borders and ghost-cards
    // are explicit bans; do not reintroduce them.
    const header = (
      <div
        className={cn(
          'group/project relative mx-1 flex items-center gap-2 rounded-md px-3 py-2 transition-colors duration-150',
          'hover:bg-muted/60',
          isExpanded && 'bg-muted/40'
        )}
      >
        <button
          type="button"
          onClick={() => toggleProject(node.project)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              isExpanded && 'rotate-90'
            )}
          />
          {isExpanded ? (
            <FolderOpen className={cn('h-4 w-4 shrink-0', isTemporary ? 'text-amber-500' : 'text-primary')} />
          ) : (
            <FolderClosed className={cn('h-4 w-4 shrink-0', isTemporary ? 'text-amber-500' : 'text-muted-foreground')} />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {node.projectName}
          </span>
          {metaLabel && (
            <span className="max-w-[82px] shrink-0 truncate text-[10px] text-muted-foreground">
              {metaLabel}
            </span>
          )}
        </button>
        {showDismiss && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDismissActiveTemporaryProject(node.project);
                }}
                aria-label={t('workspace.dismissActiveTemporaryProject')}
                className={cn(
                  'absolute right-2 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md',
                  'pointer-events-none text-muted-foreground opacity-0 transition-opacity duration-150',
                  'hover:bg-muted/80 hover:text-foreground focus:text-foreground',
                  'focus:pointer-events-auto focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/25',
                  'group-hover/project:pointer-events-auto group-hover/project:opacity-100'
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6} className="whitespace-nowrap">
              {t('workspace.dismissActiveTemporaryProject')}
            </TooltipContent>
          </Tooltip>
        )}
        {!showDismiss && onCreateForProject && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateForProject(node.project);
                }}
                aria-label={t('workspace.createInProject')}
                className={cn(
                  'absolute right-2 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md',
                  'pointer-events-none text-foreground/70 opacity-0 transition-opacity duration-150',
                  'hover:text-foreground focus:text-foreground',
                  'focus:pointer-events-auto focus:opacity-100 focus-visible:ring-1 focus-visible:ring-foreground/25',
                  'group-hover/project:pointer-events-auto group-hover/project:opacity-100'
                )}
              >
                <SquarePen className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6} className="whitespace-nowrap">
              {t('workspace.createInProject')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );

    return (
      <div
        key={node.project}
        data-project-motion-key={`project:${section}:${node.project}`}
        className="mb-0.5 [content-visibility:auto] [contain-intrinsic-size:44px]"
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            {classification?.bucket === 'temporary' ? (
              <ContextMenuItem onClick={() => projectActions.onKeepMain(node.project)}>
                <FolderClosed className="mr-2 h-3.5 w-3.5" />
                {t('workspace.keepProjectInMainList')}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onClick={() => projectActions.onMarkTemporary(node.project)}>
                <FolderClosed className="mr-2 h-3.5 w-3.5" />
                {t('workspace.markProjectTemporary')}
              </ContextMenuItem>
            )}
            {classification?.source === 'manual' && (
              <ContextMenuItem onClick={() => projectActions.onResetProjectClassification(node.project)}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t('workspace.resetProjectClassification')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={projectActions.onOrganizeSidebar}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              {t('workspace.organizeSidebar')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {isExpanded && (
          <div className="pb-1">
            {visible.map((session) => renderSessionRow(session))}
            {(hasMore || canCollapse) && (
              <div className="flex items-center gap-3 pl-9 py-1.5 text-[11px]">
                {canCollapse && (
                  <button
                    type="button"
                    onClick={() => collapseList(node.project)}
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronsUp className="h-3 w-3" />
                    {t('workspace.collapseList')}
                  </button>
                )}
                {hasMore && (
                  <>
                    <button
                      type="button"
                      onClick={() => loadMore(node.project)}
                      className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {t('workspace.loadMore')}
                    </button>
                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/50">
                      {visible.length}/{node.sessions.length}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <ScrollArea className="flex-1 min-h-0 py-1">
        {isLoading ? (
          <ProjectTreeSkeleton />
        ) : !hasContent ? (
          pinnedSessionsCount > 0 ? null : (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <MessageSquare className="w-8 h-8 text-muted-foreground/40 mb-3" />
              <p className="text-xs text-muted-foreground mb-1">{t('workspace.noHistory')}</p>
              <p className="text-xs text-muted-foreground/70">{t('workspace.noHistoryHint')}</p>
            </div>
          )
        ) : isRecentMode ? (
          <RecentSessionsSection
            buckets={recentBuckets ?? []}
            onLoadMoreBucket={onLoadMoreRecentBucket ?? (() => {})}
            onCollapseBucket={onCollapseRecentBucket ?? (() => {})}
            renderSessionRow={renderSessionRow}
            t={t}
          />
        ) : (
          <>
            {mainProjectNodes.map((node) => renderProjectNode(node, 'main'))}
            {temporaryProjectNodes.length > 0 && (
              <div className="mt-2 border-t border-border/45 pt-2">
                <div className="mb-1 flex h-5 items-center justify-between px-3">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {t('workspace.temporaryProjects')}
                  </span>
                  <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-muted-foreground">
                    {temporaryProjectNodes.length}
                  </span>
                </div>
                {temporaryProjectNodes.map((node) => renderProjectNode(node, 'temporary'))}
              </div>
            )}
          </>
        )}
        {!isRecentMode && activeTemporaryProjectNodes.length > 0 && (
          <div className="mt-2 border-t border-border/60 px-0.5 pb-1 pt-1.5">
            <div className="mb-0.5 flex h-5 items-center justify-between px-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t('workspace.activeTemporaryProjects')}
              </span>
              <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-muted-foreground">
                {activeTemporaryProjectNodes.length}
              </span>
            </div>
            {activeTemporaryProjectNodes.map((node) => renderProjectNode(node, 'activeTemporary'))}
          </div>
        )}
      </ScrollArea>
    </>
  );
});

function ProjectTreeSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-2 p-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 py-1.5">
            <div className="w-4 h-4 rounded bg-muted" />
            <div className="h-3.5 w-24 rounded bg-muted" />
            <div className="h-3 w-6 rounded-full bg-muted ml-auto" />
          </div>
          {i <= 2 &&
            [1, 2].map((j) => (
              <div key={j} className="flex items-center gap-2 py-1 pl-6">
                <div className="w-3.5 h-3.5 rounded bg-muted/60" />
                <div className="h-3 rounded bg-muted/60" style={{ width: `${60 + j * 20}px` }} />
                <div className="h-2.5 w-6 rounded bg-muted/40 ml-auto" />
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
