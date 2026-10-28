import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react';
import { shallow } from 'zustand/shallow';
import type { PermissionModeName } from '@ccem/core/browser';
import { useLocale } from '@/locales';
import { useAppStore } from '@/store';
import { recoveryDraftKey } from '@/lib/recoveryDrafts';
import { fetchConversationDetail } from '@/features/conversations/historyData';
import type {
  ConversationMessageData,
  HistorySegment,
  HistorySessionItem,
} from '@/features/conversations/types';
import { ComposerControls, type EffortLevel } from './ComposerControls';
import type { ComposerSubmitPayload } from './composerAttachments';
import { WorkspaceSessionComposer } from './WorkspaceSessionComposer';
import type { ComposerSubmitResult } from './composerSubmissionResult';

const LazyConversationDetail = lazy(async () =>
  import('./WorkspaceConversationDetail').then((m) => ({ default: m.WorkspaceConversationDetail }))
);

export interface SplitHistoryResumeControls {
  envName: string;
  permMode: PermissionModeName;
  effort: EffortLevel;
}

interface WorkspaceSplitHistoryPaneProps {
  session: HistorySessionItem;
  /** Same env/permission/effort the single history view would start with. */
  initialControls: SplitHistoryResumeControls;
  /** Resume the provider session into a live runtime that takes this pane over. */
  onResume: (
    payload: ComposerSubmitPayload,
    controls: SplitHistoryResumeControls,
    seedMessages: ConversationMessageData[],
  ) => Promise<ComposerSubmitResult>;
}

/**
 * A split-view pane for a session with no live runtime: its provider
 * transcript plus a compact composer whose first send resumes it.
 */
export const WorkspaceSplitHistoryPane = memo(function WorkspaceSplitHistoryPane({
  session,
  initialControls,
  onResume,
}: WorkspaceSplitHistoryPaneProps) {
  const { t } = useLocale();
  const { environments, enabledEnvironments } = useAppStore((state) => ({
    environments: state.environments,
    enabledEnvironments: state.enabledEnvironments,
  }), shallow);
  const [messages, setMessages] = useState<ConversationMessageData[]>([]);
  const [segments, setSegments] = useState<HistorySegment[]>([]);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [text, setText] = useState('');
  const [isResuming, setIsResuming] = useState(false);
  const [envName, setEnvName] = useState(initialControls.envName);
  const [permMode, setPermMode] = useState<PermissionModeName>(initialControls.permMode);
  const [effort, setEffort] = useState<EffortLevel>(initialControls.effort);
  const provider = session.source === 'codex' ? 'codex' : 'claude';

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchConversationDetail(session)
      .then((detail) => {
        if (cancelled) return;
        setMessages(detail.messages);
        setSegments(detail.segments);
      })
      .catch((error) => console.error('Failed to load split pane transcript:', error))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const handleSubmit = useCallback(async (payload: ComposerSubmitPayload) => {
    setIsResuming(true);
    try {
      return await onResume(payload, { envName, permMode, effort }, messages);
    } finally {
      setIsResuming(false);
    }
  }, [effort, envName, messages, onResume, permMode]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense fallback={<div className="min-h-0 flex-1" />}>
        <LazyConversationDetail
          selectedSession={session}
          messages={messages}
          segments={segments}
          activeSegment={activeSegment}
          onActiveSegmentChange={setActiveSegment}
          isLoadingMessages={isLoading}
        />
      </Suspense>
      <WorkspaceSessionComposer
        compact
        value={text}
        onValueChange={setText}
        recoveryDraftKey={recoveryDraftKey('history', session.source, session.id)}
        onSubmit={handleSubmit}
        placeholder={t('workspace.splitResumePlaceholder')}
        canSubmit={text.trim().length > 0 && !isResuming}
        isSubmitting={isResuming}
        submitLabel={t('workspace.composeSend')}
        loadingLabel={t('common.loading')}
        provider={provider}
        workingDir={session.project || null}
        controls={(
          <ComposerControls
            provider={provider}
            envName={envName}
            permMode={permMode}
            effort={effort}
            environments={environments}
            enabledEnvironments={enabledEnvironments}
            onEnvChange={setEnvName}
            onPermModeChange={setPermMode}
            onEffortChange={setEffort}
          />
        )}
      />
    </div>
  );
});
