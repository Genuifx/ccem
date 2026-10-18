import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Users,
} from '@/lib/lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';
import type {
  NativeSessionSummary,
  WorkspaceFileDiff,
  WorkspaceGitSnapshot,
  WorkspaceMediaPreview,
} from '@/lib/tauri-ipc';
import { cn } from '@/lib/utils';
import type {
  ConversationMessageData,
  SessionSubagentsPayload,
  SubagentMeta,
} from '@/features/conversations/types';
import { WorkspaceTranscriptList } from './WorkspaceTranscriptList';
import type { WorkspaceReviewModel } from './workspaceReview';
import { getSubagentDisplayMeta, resolveSubagentSelection } from './workspaceSubagents';
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel';

export type WorkspaceReviewDetailPage = 'files' | 'agents';

interface WorkspaceReviewDetailsProps {
  page: WorkspaceReviewDetailPage;
  session: NativeSessionSummary;
  model: WorkspaceReviewModel;
  onLoadDiff: (filePath: string, options?: { committed?: boolean }) => Promise<WorkspaceFileDiff>;
  onLoadMediaPreview?: (filePath: string) => Promise<WorkspaceMediaPreview>;
  onLoadSubagents?: (detailAgentId: string | null) => Promise<SessionSubagentsPayload>;
  isLive?: boolean;
  gitSnapshot?: WorkspaceGitSnapshot | null;
  requestedPath?: string;
  requestRevision?: number;
  requestedMode?: 'preview' | 'source' | 'diff';
  onRefreshGit?: () => void;
  isRefreshingGit?: boolean;
  /** When provided, the internal scope tab bar is hidden and this scope is used directly. */
  externalScope?: 'changes' | 'browse';
}

function AgentsDetail({
  onLoadSubagents,
  isLive,
}: Pick<WorkspaceReviewDetailsProps, 'onLoadSubagents' | 'isLive'>) {
  const { t } = useLocale();
  const [subagents, setSubagents] = useState<SubagentMeta[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<ConversationMessageData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const canLoad = Boolean(onLoadSubagents);
  const loadRef = useRef(onLoadSubagents);

  useEffect(() => {
    loadRef.current = onLoadSubagents;
  }, [onLoadSubagents]);

  const load = useCallback(async (agentId: string | null, poll = false) => {
    const loader = loadRef.current;
    if (!loader || (poll && inFlightRef.current)) return;
    inFlightRef.current = true;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    try {
      const payload = await loader(agentId);
      if (requestSeq !== requestSeqRef.current) return;
      setSubagents(payload.subagents ?? []);
      if (agentId) setAgentDetail(payload.detail ?? []);
      setError(null);
    } catch (loadError) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(String(loadError));
    } finally {
      if (requestSeq === requestSeqRef.current) { inFlightRef.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    void load(null);
    return () => {
      requestSeqRef.current += 1;
    };
  }, [canLoad, load]);

  useEffect(() => {
    const next = resolveSubagentSelection(subagents, selectedAgentId);
    if (next && next !== selectedAgentId) {
      setSelectedAgentId(next);
      setAgentDetail(null);
      void load(next);
    }
  }, [load, selectedAgentId, subagents]);

  useEffect(() => {
    if (!isLive || !canLoad) return;
    const intervalId = window.setInterval(() => void load(selectedAgentId, true), 1500);
    return () => window.clearInterval(intervalId);
  }, [isLive, canLoad, load, selectedAgentId]);

  const selectedIndex = subagents.findIndex((agent) => agent.agentId === selectedAgentId);
  const selected = selectedIndex >= 0 ? subagents[selectedIndex] : null;
  const selectedDisplay = selected ? getSubagentDisplayMeta(selected, selectedIndex) : null;

  return (
    <div className="flex min-h-0 flex-1" data-review-page="agents">
      <div className="flex w-[min(290px,38%)] shrink-0 flex-col border-r border-border-subtle/50">
        <ScrollArea className="min-h-0 flex-1">
          {error && subagents.length === 0 ? (
            <p className="px-4 py-5 text-xs text-destructive">{error}</p>
          ) : subagents.length === 0 ? (
            <p className="px-4 py-5 text-xs text-muted-foreground">
              {loading ? t('workspace.reviewLoading') : t('workspace.reviewNoSubagents')}
            </p>
          ) : (
            <div className="py-1.5">
              {subagents.map((agent, index) => {
                const display = getSubagentDisplayMeta(agent, index);
                const active = agent.agentId === selectedAgentId;
                return (
                  <button
                    key={agent.agentId}
                    type="button"
                    onClick={() => {
                      setSelectedAgentId(agent.agentId);
                      setAgentDetail(null);
                      void load(agent.agentId);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors',
                      active ? 'bg-primary/10' : 'hover:bg-surface-raised/55',
                    )}
                  >
                    {display.running ? (
                      <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                    ) : display.failed ? (
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{display.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{display.subtitle}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected && selectedDisplay ? (
          <>
            <div className="shrink-0 border-b border-border-subtle/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-semibold">{selectedDisplay.name}</p>
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  selected.status === 'running' && 'bg-primary/10 text-primary',
                  selected.status === 'completed' && 'bg-success/10 text-success',
                  selected.status === 'failed' && 'bg-destructive/10 text-destructive',
                )}>
                  {selectedDisplay.statusLabel}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{selectedDisplay.detail}</p>
              {selected.resultSummary ? <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground">{selected.resultSummary}</p> : null}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-4 py-3">
                {agentDetail && agentDetail.length > 0 ? (
                  <WorkspaceTranscriptList messages={agentDetail} isAwaitingResponse={selected.status === 'running'} />
                ) : error ? (
                  <p className="py-6 text-center text-xs text-destructive">{error}</p>
                ) : (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    {loading ? t('workspace.reviewLoading') : t('workspace.reviewNoAgentTrace')}
                  </p>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Users className="h-6 w-6 text-muted-foreground/35" />
            <p className="text-xs text-muted-foreground">{t('workspace.reviewSelectSubagent')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkspaceReviewDetails(props: WorkspaceReviewDetailsProps) {
  if (props.page === 'files') {
    return (
      <WorkspaceFilesPanel
        session={props.session}
        model={props.model}
        onLoadDiff={props.onLoadDiff}
        onLoadMediaPreview={props.onLoadMediaPreview}
        gitSnapshot={props.gitSnapshot}
        requestedPath={props.requestedPath}
        requestRevision={props.requestRevision}
        requestedMode={props.requestedMode}
        onRefreshGit={props.onRefreshGit}
        isRefreshingGit={props.isRefreshingGit}
        externalScope={props.externalScope}
      />
    );
  }
  return <AgentsDetail onLoadSubagents={props.onLoadSubagents} isLive={props.isLive} />;
}
