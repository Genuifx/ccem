import { memo } from 'react';
import type { ReactNode } from 'react';
import {
  Bot,
  ChevronsUp,
  FlaskConical,
  FolderClosed,
  FolderOpen,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  SquarePen,
  Timer,
  type LucideIcon,
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
import type { ProjectNode, RecentSessionBucket, SidebarGroupId } from './workspaceProjectTreeModel';

export const PROJECT_TREE_PAGE_SIZE = 6;
export const RECENT_BUCKET_PAGE_SIZE = 15;

type RenderSessionRow = (
  session: HistorySessionItem,
  options?: {
    pinnedSection?: boolean;
    recentSection?: boolean;
  },
) => ReactNode;

type ProjectActionCallbacks = {
  onMarkTemporary: (project: string) => void;
  onResetProjectClassification: (overrideKey: string) => void;
  onOrganizeSidebar: () => void;
};

type ProjectNodeSectionKind = 'main' | 'group';

const GROUP_ICONS: Readonly<Record<SidebarGroupId, LucideIcon>> = {
  chat: MessageSquare,
  agent: Bot,
  scheduled: Timer,
  temporary: FlaskConical,
};

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
  effectiveExpanded,
  getProjectOverrideKey,
  getVisibleCount,
  getVisibleSessions,
  groupLabel,
  groupNodes,
  isLoading,
  onCreateForProject,
  pinnedSessionsCount,
  projectActions,
  projectNodes,
  recentBuckets,
  recentTotalCount,
  onLoadMoreRecentBucket,
  onCollapseRecentBucket,
  renderSessionRow,
  toggleProject,
  collapseList,
  loadMore,
  t,
}: {
  effectiveExpanded: Set<string>;
  getProjectOverrideKey: (project: string) => string | undefined;
  getVisibleCount: (project: string) => number;
  getVisibleSessions: (node: ProjectNode) => HistorySessionItem[];
  groupLabel: (groupId: SidebarGroupId) => string;
  /** Fixed groups (projectless, agent, scheduled, temporary) listed below the main content. */
  groupNodes: ProjectNode[];
  isLoading: boolean;
  onCreateForProject?: (projectPath: string) => void;
  pinnedSessionsCount: number;
  projectActions: ProjectActionCallbacks;
  projectNodes: ProjectNode[];
  /** When defined, the tree renders time-bucketed flat groups instead of project groups. */
  recentBuckets?: Array<RecentSessionBucket & { totalCount: number }>;
  recentTotalCount?: number;
  onLoadMoreRecentBucket?: (bucketId: RecentSessionBucket['id']) => void;
  onCollapseRecentBucket?: (bucketId: RecentSessionBucket['id']) => void;
  renderSessionRow: RenderSessionRow;
  toggleProject: (project: string) => void;
  collapseList: (project: string) => void;
  loadMore: (project: string) => void;
  t: (key: string) => string;
}) {
  const isRecentMode = recentBuckets !== undefined;
  const hasPrimaryContent = isRecentMode ? (recentTotalCount ?? 0) > 0 : projectNodes.length > 0;
  const hasContent = hasPrimaryContent || groupNodes.length > 0;

  const renderProjectNode = (
    node: ProjectNode,
    section: ProjectNodeSectionKind,
  ) => {
    const isExpanded = effectiveExpanded.has(node.project);
    const visibleCount = getVisibleCount(node.project);
    const visible = getVisibleSessions(node);
    const hasMore = node.sessions.length > visible.length;
    const canCollapse = visibleCount > PROJECT_TREE_PAGE_SIZE;
    const groupId = node.kind === 'group' ? node.groupId : undefined;
    const GroupIcon = groupId ? GROUP_ICONS[groupId] : null;
    const overrideKey = groupId ? undefined : getProjectOverrideKey(node.project);
    const createPath = groupId ? undefined : node.createPath;

    // Projects and groups share one header vocabulary; the icon and the
    // divider above the groups carry the difference. Side-stripe borders and
    // ghost-cards are explicit bans; do not reintroduce them.
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
          aria-expanded={isExpanded}
          title={createPath}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {GroupIcon ? (
            <GroupIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : isExpanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <FolderClosed className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {groupId ? groupLabel(groupId) : node.projectName}
          </span>
          {groupId && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {node.sessions.length}
            </span>
          )}
        </button>
        {createPath && onCreateForProject && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateForProject(createPath);
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
        // WebKit can leave remounted content-visibility:auto subtrees unpainted
        // after the sidebar reopens. Rows are already paginated; paint groups eagerly.
        className="mb-0.5"
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            {!groupId && (
              <>
                <ContextMenuItem onClick={() => projectActions.onMarkTemporary(node.project)}>
                  <FlaskConical className="mr-2 h-3.5 w-3.5" />
                  {t('workspace.markProjectTemporary')}
                </ContextMenuItem>
                {overrideKey && (
                  <ContextMenuItem onClick={() => projectActions.onResetProjectClassification(overrideKey)}>
                    <RotateCcw className="mr-2 h-3.5 w-3.5" />
                    {t('workspace.resetProjectClassification')}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
              </>
            )}
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
              <div className="flex items-center gap-3 pl-3 py-1.5 text-[11px]">
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
        ) : (
          <>
            {isRecentMode ? (
              hasPrimaryContent && (
                <RecentSessionsSection
                  buckets={recentBuckets ?? []}
                  onLoadMoreBucket={onLoadMoreRecentBucket ?? (() => {})}
                  onCollapseBucket={onCollapseRecentBucket ?? (() => {})}
                  renderSessionRow={renderSessionRow}
                  t={t}
                />
              )
            ) : (
              projectNodes.map((node) => renderProjectNode(node, 'main'))
            )}
            {groupNodes.length > 0 && (
              <div
                data-sidebar-groups
                className={cn(hasPrimaryContent && 'mt-2 border-t border-border/45 pt-2')}
              >
                {groupNodes.map((node) => renderProjectNode(node, 'group'))}
              </div>
            )}
          </>
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
