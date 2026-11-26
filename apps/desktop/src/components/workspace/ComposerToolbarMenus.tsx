import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  Image,
  ListChecks,
  LoaderCircle,
  MessageSquareQuote,
  Paperclip,
  Plus,
} from '@/lib/lucide-react';
import { Antigravity, Claude, Codex, OpenCode } from '@lobehub/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { LaunchClient } from '@/store';
import type { WorkspaceComposerProvider } from './composerCapabilities';
import {
  MAX_SESSION_REFERENCES,
  type ComposerSessionReference,
} from './composerSessionReferences';
import type { SessionReferenceClient } from './sessionReferenceClient';

function renderActiveEngineIcon(provider: WorkspaceComposerProvider) {
  if (provider === 'codex') {
    return <Codex.Color size={16} className="shrink-0" />;
  }
  if (provider === 'agy') {
    return <Antigravity.Color size={16} className="shrink-0" />;
  }
  return <Claude.Color size={16} className="shrink-0" />;
}

export interface ComposerEnginePickerProps {
  provider: WorkspaceComposerProvider;
  codexInstalled: boolean;
  agyInstalled: boolean;
  opencodeInstalled: boolean;
  disabled?: boolean;
  onLaunchNewSession: (client: LaunchClient) => void;
}

export function ComposerEnginePicker({
  provider,
  codexInstalled,
  agyInstalled,
  opencodeInstalled,
  disabled = false,
  onLaunchNewSession,
}: ComposerEnginePickerProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);

  const engineItems: { client: LaunchClient; icon: ReactNode; label: string; installed: boolean }[] = [
    { client: 'claude', icon: <Claude.Color size={15} />, label: t('workspace.newSessionClaude'), installed: true },
    { client: 'codex', icon: <Codex.Color size={15} />, label: t('workspace.newSessionCodex'), installed: codexInstalled },
    { client: 'agy', icon: <Antigravity.Color size={15} />, label: t('workspace.newSessionAgy'), installed: agyInstalled },
    { client: 'opencode', icon: <OpenCode size={15} />, label: t('workspace.newSessionOpenCode'), installed: opencodeInstalled },
  ];

  const currentLabel = engineItems.find((item) => item.client === provider)?.label ?? t('workspace.newSessionClaude');
  const tooltipLabel = t('workspace.composerEngineTooltip').replace('{engine}', currentLabel);

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="composer-engine-trigger"
              aria-label={tooltipLabel}
              disabled={disabled}
              className={cn(
                'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[12px] text-foreground',
                'cursor-pointer outline-none transition-[background-color,box-shadow] duration-150',
                'hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-primary/30',
                'disabled:pointer-events-none disabled:opacity-45',
              )}
            >
              <span className="flex shrink-0 items-center">
                {renderActiveEngineIcon(provider)}
              </span>
              <span className="sr-only">{currentLabel}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {!open && <TooltipContent side="top">{tooltipLabel}</TooltipContent>}
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={12}
        className="min-w-[196px] p-1.5"
      >
        {engineItems.map((item) => {
          const isCurrent = item.client === provider;
          return (
            <DropdownMenuItem
              key={item.client}
              data-composer-engine-option={item.client}
              disabled={!item.installed}
              onSelect={() => {
                if (!item.installed) {
                  return;
                }
                onLaunchNewSession(item.client);
                setOpen(false);
              }}
              className={cn(
                'h-8 cursor-pointer gap-2.5 rounded-lg px-2 text-[12.5px] leading-none',
                'text-foreground/85 transition-colors',
                'hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] data-[highlighted]:bg-foreground/[0.05]',
                isCurrent && 'bg-primary/[0.07] font-medium text-primary hover:bg-primary/[0.1] focus:bg-primary/[0.1] data-[highlighted]:bg-primary/[0.1]',
              )}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
              {isCurrent && (
                <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
              )}
              {!item.installed && (
                <span className="text-2xs text-muted-foreground">({t('settings.cliNotInstalled')})</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ComposerQuickMenuProps {
  provider: WorkspaceComposerProvider;
  disabled?: boolean;
  supportsImages: boolean;
  workingDir?: string | null;
  currentRuntimeId?: string | null;
  sessionReferencesClient: SessionReferenceClient;
  selectedSessionIds: Set<string>;
  onAttachFiles: () => void | Promise<void>;
  onAttachImages: () => void;
  onSelectSessionReference: (session: ComposerSessionReference) => void;
  planModeEnabled: boolean;
  planButtonVisible: boolean;
  planModeHint?: string;
  planModeKind: 'session_permission' | 'command_prefix';
  onPlanModeEnabledChange?: (enabled: boolean) => void;
  routeDraftRow?: ReactNode;
}

export function ComposerQuickMenu({
  provider,
  disabled = false,
  supportsImages,
  workingDir,
  currentRuntimeId,
  sessionReferencesClient,
  selectedSessionIds,
  onAttachFiles,
  onAttachImages,
  onSelectSessionReference,
  planModeEnabled,
  planButtonVisible,
  planModeHint,
  planModeKind,
  onPlanModeEnabledChange,
  routeDraftRow,
}: ComposerQuickMenuProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'sessions'>('menu');
  const [sessions, setSessions] = useState<ComposerSessionReference[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState(false);
  const sessionRequestIdRef = useRef(0);

  useEffect(() => () => {
    sessionRequestIdRef.current += 1;
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      sessionRequestIdRef.current += 1;
      setView('menu');
      setSessionsLoading(false);
      setSessionsError(false);
    }
  };

  const canReferenceSessions = !disabled
    && provider === 'claude'
    && Boolean(workingDir)
    && selectedSessionIds.size < MAX_SESSION_REFERENCES;

  const resolvedPlanHint = planModeHint ?? (
    provider === 'agy'
      ? t('workspace.composerPlanModeHintAgy')
      : planModeKind === 'session_permission'
        ? t('workspace.composerPlanModeHintClaude')
        : t('workspace.composerPlanModeHintCodex')
  );

  const handleOpenSessions = () => {
    if (!canReferenceSessions || !workingDir) {
      return;
    }
    const requestId = ++sessionRequestIdRef.current;
    setView('sessions');
    setSessionsLoading(true);
    setSessionsError(false);
    void sessionReferencesClient
      .list(workingDir, currentRuntimeId)
      .then((rows) => {
        if (sessionRequestIdRef.current !== requestId) {
          return;
        }
        setSessions(rows);
      })
      .catch(() => {
        if (sessionRequestIdRef.current !== requestId) {
          return;
        }
        setSessions([]);
        setSessionsError(true);
      })
      .finally(() => {
        if (sessionRequestIdRef.current !== requestId) {
          return;
        }
        setSessionsLoading(false);
      });
  };

  const referenceButton = (
    <button
      type="button"
      data-testid="composer-quick-reference-session"
      disabled={!canReferenceSessions}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] outline-none',
        'transition-colors glass-dropdown-item',
        !canReferenceSessions && 'cursor-not-allowed opacity-50',
      )}
      onClick={handleOpenSessions}
    >
      <MessageSquareQuote className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">
        {t('workspace.composerReferenceSession')}
      </span>
      <kbd className="shrink-0 rounded border border-border/50 bg-background/60 px-1 py-px font-mono text-[10px] text-muted-foreground">
        @
      </kbd>
    </button>
  );

  const hasModeRows = planButtonVisible || Boolean(routeDraftRow);
  const triggerDisabled = disabled && !hasModeRows;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="composer-quick-menu-trigger"
          disabled={triggerDisabled}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground outline-none',
            'transition-colors hover:bg-foreground/[0.05] hover:text-foreground',
            'focus-visible:ring-2 focus-visible:ring-primary/30',
            'disabled:pointer-events-none disabled:opacity-45',
          )}
          aria-label={t('workspace.composerQuickMenuLabel')}
        >
          <Plus className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={12}
        className="w-[244px] rounded-xl border border-border/40 bg-popover p-1.5 shadow-md"
      >
        {view === 'menu' ? (
          <>
            <button
              type="button"
              data-testid="composer-quick-attach-files"
              disabled={disabled}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] outline-none',
                'transition-colors glass-dropdown-item',
                disabled && 'cursor-not-allowed opacity-50',
              )}
              onClick={() => {
                if (disabled) {
                  return;
                }
                handleOpenChange(false);
                void onAttachFiles();
              }}
            >
              <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">
                {t('workspace.composerAttachFiles')}
              </span>
            </button>

            {supportsImages ? (
              <button
                type="button"
                data-testid="composer-quick-attach-images"
                disabled={disabled}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] outline-none',
                  'transition-colors glass-dropdown-item',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
                onClick={() => {
                  if (disabled) {
                    return;
                  }
                  handleOpenChange(false);
                  onAttachImages();
                }}
              >
                <Image className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {t('workspace.composerAttachImages')}
                </span>
              </button>
            ) : null}

            {canReferenceSessions ? (
              referenceButton
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="block w-full" tabIndex={0}>
                    {referenceButton}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[260px] text-[12px] leading-5">
                  {t('workspace.sessionReferenceLimit')}
                </TooltipContent>
              </Tooltip>
            )}

            {hasModeRows ? (
              <div className="mx-2 my-1.5 h-px border-t border-border/50" />
            ) : null}

            {planButtonVisible ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors glass-dropdown-item">
                    <ListChecks className={cn(
                      'h-4 w-4 shrink-0 text-muted-foreground transition-colors',
                      planModeEnabled && 'text-foreground',
                    )} />
                    <span className={cn(
                      'flex-1 text-left transition-colors',
                      planModeEnabled && 'text-foreground',
                    )}>
                      {t('workspace.composerPlanModeShort')}
                    </span>
                    <kbd className="shrink-0 rounded border border-border/50 bg-background/60 px-1 py-px font-mono text-[10px] text-muted-foreground">
                      ⇧Tab
                    </kbd>
                    <Switch
                      checked={planModeEnabled}
                      onCheckedChange={(checked) => onPlanModeEnabledChange?.(checked)}
                      aria-label={t('workspace.composerPlanModeShort')}
                      className="data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted/85"
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[280px] text-[12px] leading-5">
                  {resolvedPlanHint}
                </TooltipContent>
              </Tooltip>
            ) : null}

            {routeDraftRow}
          </>
        ) : (
          <div data-testid="composer-quick-session-picker" className="flex flex-col">
            <div className="flex items-center gap-1.5 px-1 pb-1.5">
              <button
                type="button"
                aria-label={t('workspace.nativePromptBack')}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                onClick={() => {
                  sessionRequestIdRef.current += 1;
                  setSessionsLoading(false);
                  setSessionsError(false);
                  setView('menu');
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                {t('workspace.composerReferenceSessionTitle')}
              </span>
            </div>
            <div className="mx-1 mb-1 h-px border-t border-border/50" />
            {sessionsLoading ? (
              <div className="flex items-center gap-2 px-2.5 py-3 text-[12px] text-muted-foreground">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                <span>{t('common.loading')}</span>
              </div>
            ) : sessionsError ? (
              <p className="px-2.5 py-2.5 text-[12px] leading-4 text-muted-foreground">
                {t('workspace.sessionReferenceReadFailed')}
              </p>
            ) : sessions.length === 0 ? (
              <p className="px-2.5 py-2.5 text-[12px] leading-4 text-muted-foreground">
                {t('workspace.composerReferenceSessionEmpty')}
              </p>
            ) : (
              <div className="max-h-[220px] space-y-0.5 overflow-y-auto">
                {sessions.map((item) => {
                  const alreadySelected = selectedSessionIds.has(item.runtime_id);
                  return (
                    <button
                      key={item.runtime_id}
                      type="button"
                      data-composer-session-option={item.runtime_id}
                      disabled={alreadySelected}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] outline-none',
                        'transition-colors glass-dropdown-item',
                        alreadySelected && 'cursor-default opacity-60',
                      )}
                      onClick={() => {
                        if (alreadySelected) {
                          return;
                        }
                        onSelectSessionReference(item);
                        handleOpenChange(false);
                      }}
                    >
                      <MessageSquareQuote className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground/90">{item.title}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {item.provider} · {item.runtime_id.slice(-8)}
                        </span>
                      </span>
                      {alreadySelected && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
