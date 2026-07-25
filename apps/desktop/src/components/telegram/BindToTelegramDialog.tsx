import { useEffect, useState } from 'react';
import { Bot, FolderOpen, Loader2, PlusSquare } from '@/lib/lucide-react';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';
import { toast } from 'sonner';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '@/locales';
import { useAppStore } from '@/store';
import type { TelegramForumTopic, TelegramTopicBinding } from '@/lib/tauri-ipc';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CREATE_NEW_TOPIC_VALUE = '__create__';
const MANUAL_TOPIC_VALUE = '__manual__';
const CURRENT_ENV_VALUE = '__current__';
const DEFAULT_PERM_VALUE = '__default__';

interface BindToTelegramDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProjectDir?: string | null;
  initialEnvName?: string | null;
  initialPermMode?: string | null;
  onBound?: (binding: TelegramTopicBinding) => void;
}

function topicOptionValue(threadId: number): string {
  return `topic:${threadId}`;
}

function parseTopicSelection(value: string): number | null {
  if (!value.startsWith('topic:')) {
    return null;
  }
  const parsed = Number(value.slice('topic:'.length));
  return Number.isFinite(parsed) ? parsed : null;
}

function topicLabel(topic: TelegramForumTopic): string {
  const boundSuffix = topic.isBound && topic.boundProject
    ? ` · ${topic.boundProject.split('/').pop() || topic.boundProject}`
    : '';
  return `${topic.name} · #${topic.threadId}${boundSuffix}`;
}

export function BindToTelegramDialog({
  open,
  onOpenChange,
  initialProjectDir,
  initialEnvName,
  initialPermMode,
  onBound,
}: BindToTelegramDialogProps) {
  const { t } = useLocale();
  const { environments, currentEnv, permissionMode, defaultWorkingDir } = useAppStore((state) => ({
    environments: state.environments,
    currentEnv: state.currentEnv,
    permissionMode: state.permissionMode,
    defaultWorkingDir: state.defaultWorkingDir,
  }));
  const {
    openDirectoryPicker,
    getTelegramForumTopics,
    bindTelegramTopic,
    getTelegramSettings,
  } = useTauriCommands();

  const [projectDir, setProjectDir] = useState('');
  const [envName, setEnvName] = useState<string | null>(null);
  const [permMode, setPermMode] = useState<string | null>(null);
  const [topicSelection, setTopicSelection] = useState(CREATE_NEW_TOPIC_VALUE);
  const [manualThreadId, setManualThreadId] = useState('');
  const [knownTopics, setKnownTopics] = useState<TelegramForumTopic[]>([]);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const [isLoadingTopics, setIsLoadingTopics] = useState(false);
  const [bindPrereqError, setBindPrereqError] = useState<string | null>(null);
  const [isCheckingPrereqs, setIsCheckingPrereqs] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    setProjectDir(initialProjectDir ?? defaultWorkingDir ?? '');
    setEnvName(initialEnvName ?? currentEnv ?? null);
    setPermMode(
      initialPermMode && initialPermMode in PERMISSION_PRESETS
        ? initialPermMode
        : permissionMode ?? null
    );
    setTopicSelection(CREATE_NEW_TOPIC_VALUE);
    setManualThreadId('');
    setKnownTopics([]);
    setTopicsError(null);
    setBindPrereqError(null);
    setIsLoadingTopics(true);
    setIsCheckingPrereqs(true);

    void getTelegramForumTopics()
      .then((topics) => {
        if (cancelled) {
          return;
        }
        setKnownTopics(topics);
        if (topics.length > 0) {
          setTopicSelection(topicOptionValue(topics[0].threadId));
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setTopicsError(String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTopics(false);
        }
      });

    void getTelegramSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        const hasBotToken = Boolean(settings.botToken?.trim());
        if (!hasBotToken) {
          setBindPrereqError(t('telegram.bindRequiresBotToken'));
          return;
        }
        if (settings.allowedChatId == null) {
          setBindPrereqError(t('telegram.bindRequiresAllowedChatId'));
          return;
        }
        setBindPrereqError(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setBindPrereqError(
          t('telegram.bindSettingsLoadFailed').replace('{error}', String(error))
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingPrereqs(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    open,
    initialProjectDir,
    initialEnvName,
    initialPermMode,
    defaultWorkingDir,
    currentEnv,
    permissionMode,
    getTelegramForumTopics,
    getTelegramSettings,
    t,
  ]);

  const selectedThreadId =
    topicSelection === MANUAL_TOPIC_VALUE
      ? Number(manualThreadId)
      : parseTopicSelection(topicSelection);
  const shouldCreateNewTopic = topicSelection === CREATE_NEW_TOPIC_VALUE;
  const canSubmit =
    !bindPrereqError &&
    !isCheckingPrereqs &&
    projectDir.trim().length > 0 &&
    (shouldCreateNewTopic ||
      (topicSelection === MANUAL_TOPIC_VALUE
        ? Number.isFinite(selectedThreadId) && selectedThreadId !== null && selectedThreadId > 0
        : selectedThreadId !== null));

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSubmitting(true);
    try {
      const binding = await bindTelegramTopic({
        projectDir: projectDir.trim(),
        envName,
        permMode,
        threadId: shouldCreateNewTopic ? null : selectedThreadId,
        createNewTopic: shouldCreateNewTopic,
      });
      onBound?.(binding);
      toast.success(
        t('telegram.bindTopicSuccess').replace('{threadId}', String(binding.threadId))
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(
        t('telegram.bindTopicFailed').replace('{error}', String(error))
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            {t('telegram.bindDialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('telegram.bindDialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="telegram-bind-project">{t('telegram.bindProjectDir')}</Label>
            <div className="flex gap-2">
              <Input
                id="telegram-bind-project"
                value={projectDir}
                onChange={(event) => setProjectDir(event.target.value)}
                placeholder={t('settings.telegramTopicProjectDirPlaceholder')}
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={async () => {
                  const path = await openDirectoryPicker();
                  if (path) {
                    setProjectDir(path);
                  }
                }}
              >
                <FolderOpen className="mr-1.5 h-4 w-4" />
                {t('settings.selectDir')}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="telegram-bind-env">{t('telegram.bindEnv')}</Label>
              <Select
                value={envName ?? CURRENT_ENV_VALUE}
                onValueChange={(value) => {
                  setEnvName(value === CURRENT_ENV_VALUE ? null : value);
                }}
              >
                <SelectTrigger id="telegram-bind-env">
                  <SelectValue placeholder={t('settings.telegramUseCurrentEnv')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CURRENT_ENV_VALUE}>
                    {t('settings.telegramUseCurrentEnv')}
                  </SelectItem>
                  {environments.map((environment) => (
                    <SelectItem key={environment.name} value={environment.name}>
                      {environment.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="telegram-bind-perm">{t('telegram.bindPermMode')}</Label>
              <Select
                value={permMode ?? DEFAULT_PERM_VALUE}
                onValueChange={(value) => {
                  setPermMode(value === DEFAULT_PERM_VALUE ? null : value);
                }}
              >
                <SelectTrigger id="telegram-bind-perm">
                  <SelectValue placeholder={t('settings.telegramUseDefaultPerm')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_PERM_VALUE}>
                    {t('settings.telegramUseDefaultPerm')}
                  </SelectItem>
                  {Object.keys(PERMISSION_PRESETS).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {mode as PermissionModeName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="telegram-bind-topic">{t('telegram.bindTopic')}</Label>
            <Select value={topicSelection} onValueChange={setTopicSelection}>
              <SelectTrigger id="telegram-bind-topic">
                <SelectValue placeholder={t('telegram.bindTopicPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CREATE_NEW_TOPIC_VALUE}>
                  {t('telegram.bindTopicCreateNew')}
                </SelectItem>
                <SelectItem value={MANUAL_TOPIC_VALUE}>
                  {t('telegram.bindTopicManual')}
                </SelectItem>
                {knownTopics.map((topic) => (
                  <SelectItem key={topic.threadId} value={topicOptionValue(topic.threadId)}>
                    {topicLabel(topic)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {topicSelection === MANUAL_TOPIC_VALUE ? (
              <Input
                value={manualThreadId}
                onChange={(event) => setManualThreadId(event.target.value)}
                placeholder={t('telegram.bindThreadIdPlaceholder')}
                inputMode="numeric"
              />
            ) : null}

            <p className="text-xs text-muted-foreground">
              {isLoadingTopics ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('telegram.bindTopicsLoading')}
                </span>
              ) : topicsError ? (
                t('telegram.bindTopicsHintError').replace('{error}', topicsError)
              ) : (
                t('telegram.bindTopicsHint')
              )}
            </p>
            {bindPrereqError ? (
              <p className="text-xs text-destructive">
                {bindPrereqError}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                {t('common.loading')}
              </>
            ) : shouldCreateNewTopic ? (
              <>
                <PlusSquare className="mr-1.5 h-4 w-4" />
                {t('telegram.bindTopicCreateAction')}
              </>
            ) : (
              t('telegram.bindSubmit')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
