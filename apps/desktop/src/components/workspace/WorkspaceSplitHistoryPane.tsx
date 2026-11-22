import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
import {
  parseAgyTranscriptModel,
  resolveAgyEffortLevels,
  type AgyModelCatalogItem,
} from '@/lib/agy-runtime';
import { clampEffortToSupportedLevels } from './workspaceSessionPreferences';
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
  model?: string | null;
}

interface WorkspaceSplitHistoryPaneProps {
  session: HistorySessionItem;
  /** Same env/permission/effort the single history view would start with. */
  initialControls: SplitHistoryResumeControls;
  agyModels?: AgyModelCatalogItem[];
  agyModelsLoading?: boolean;
  onRefreshAgyModels?: () => void;
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
  agyModels,
  agyModelsLoading,
  onRefreshAgyModels,
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
  const [model, setModel] = useState<string | null>(initialControls.model ?? null);
  const userEditedModelRef = useRef(Boolean(initialControls.model));
  const userEditedEffortRef = useRef(false);
  const provider = session.source === 'codex' ? 'codex' : session.source === 'agy' ? 'agy' : 'claude';

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

  useEffect(() => {
    if (session.source !== 'agy' || messages.length === 0) {
      return;
    }
    const lastModelMsg = [...messages].reverse().find((m) => m.model?.trim());
    const parsed = parseAgyTranscriptModel(lastModelMsg?.model, agyModels);
    if (!parsed) {
      return;
    }
    if (!userEditedModelRef.current) {
      setModel(parsed.model);
    }
    if (!userEditedEffortRef.current && parsed.effort) {
      const supported = resolveAgyEffortLevels(parsed.model, agyModels ?? []) as EffortLevel[];
      if (supported.length > 0) {
        setEffort(clampEffortToSupportedLevels(parsed.effort, supported));
      }
    }
  }, [agyModels, messages, session.source]);

  const handleEffortChange = useCallback((nextEffort: EffortLevel) => {
    userEditedEffortRef.current = true;
    setEffort(nextEffort);
  }, []);

  const handleModelChange = useCallback((nextModel: string) => {
    userEditedModelRef.current = true;
    setModel(nextModel);
    const supported = resolveAgyEffortLevels(nextModel, agyModels ?? []) as EffortLevel[];
    if (supported.length > 0) {
      setEffort((previous) => clampEffortToSupportedLevels(previous, supported));
    }
  }, [agyModels]);

  const handleSubmit = useCallback(async (payload: ComposerSubmitPayload) => {
    setIsResuming(true);
    try {
      const effectiveModel = provider === 'agy' ? (model ?? agyModels?.[0]?.id ?? null) : null;
      const supportedEfforts = provider === 'agy'
        ? (resolveAgyEffortLevels(effectiveModel, agyModels ?? []) as EffortLevel[])
        : null;
      const effectiveEffort = supportedEfforts && supportedEfforts.length > 0
        ? clampEffortToSupportedLevels(effort, supportedEfforts)
        : effort;
      return await onResume(
        payload,
        { envName, permMode, effort: effectiveEffort, model: effectiveModel },
        messages,
      );
    } finally {
      setIsResuming(false);
    }
  }, [agyModels, effort, envName, messages, model, onResume, permMode, provider]);

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
            model={model}
            agyModels={agyModels}
            agyModelsLoading={agyModelsLoading}
            environments={environments}
            enabledEnvironments={enabledEnvironments}
            onEnvChange={setEnvName}
            onPermModeChange={setPermMode}
            onEffortChange={handleEffortChange}
            onModelChange={handleModelChange}
            onRefreshAgyModels={onRefreshAgyModels}
          />
        )}
      />
    </div>
  );
});
