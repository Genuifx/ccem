import { useState, useEffect } from 'react';
import { Bot, Play, Square, MessageSquareWarning, ChevronDown, ChevronUp, FolderOpen, Circle } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
import { toast } from 'sonner';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { TelegramBridgeStatus, TelegramSettings } from '@/lib/tauri-ipc';
import { TelegramTopicBindingsEditor } from './TelegramTopicBindingsEditor';
import { BindToTelegramDialog } from '@/components/telegram/BindToTelegramDialog';
import { shallow } from 'zustand/shallow';

const MODE_DISPLAY_NAMES: Record<PermissionModeName, string> = {
  yolo: 'YOLO',
  dev: 'Developer',
  readonly: 'Read Only',
  safe: 'Safe',
  ci: 'CI / CD',
  audit: 'Audit',
};

const INPUT_CLS =
  'w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 transition-all';

function parseTelegramUserIdsInput(input: string): { values: number[]; invalid: string[] } {
  const parts = input
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const values: number[] = [];
  const invalid: string[] = [];

  for (const part of parts) {
    if (!/^-?\d+$/.test(part)) {
      invalid.push(part);
      continue;
    }
    values.push(Number(part));
  }

  return { values, invalid };
}

function telegramStatusEqual(left: TelegramBridgeStatus, right: TelegramBridgeStatus) {
  return left.configured === right.configured
    && left.running === right.running
    && left.botUsername === right.botUsername
    && left.lastError === right.lastError
    && left.allowedChatId === right.allowedChatId;
}

function ToggleSetting({ checked, onChange, title, description }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer group">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`glass-toggle ${checked ? 'checked' : ''}`}
      />
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </label>
  );
}

export function TelegramPanel() {
  const { t } = useLocale();
  const { defaultWorkingDir, environments } = useAppStore(
    (state) => ({
      defaultWorkingDir: state.defaultWorkingDir,
      environments: state.environments,
    }),
    shallow
  );
  const {
    openDirectoryPicker,
    getTelegramSettings,
    saveTelegramSettings,
    getTelegramBridgeStatus,
    startTelegramBridge,
    stopTelegramBridge,
  } = useTauriCommands();

  const [telegramSettings, setTelegramSettings] = useState<TelegramSettings>({
    enabled: false,
    botToken: '',
    allowedUserIds: [],
    allowedChatId: null,
    notificationsChatId: null,
    notificationsThreadId: null,
    defaultEnvName: null,
    defaultPermMode: null,
    defaultWorkingDir: null,
    topicBindings: [],
    preferences: {
      showToolCalls: true,
      showLowRiskTools: false,
      flushIntervalMs: 3000,
    },
  });
  const [telegramStatus, setTelegramStatus] = useState<TelegramBridgeStatus>({
    configured: false,
    running: false,
  });
  const [telegramAllowedUserIdsInput, setTelegramAllowedUserIdsInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quickBindOpen, setQuickBindOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadTelegram = async () => {
      try {
        const [settings, status] = await Promise.all([
          getTelegramSettings(),
          getTelegramBridgeStatus(),
        ]);
        if (cancelled) return;
        setTelegramSettings({
          enabled: settings.enabled ?? false,
          botToken: settings.botToken ?? '',
          allowedUserIds: settings.allowedUserIds ?? [],
          allowedChatId: settings.allowedChatId ?? null,
          notificationsChatId: settings.notificationsChatId ?? null,
          notificationsThreadId: settings.notificationsThreadId ?? null,
          defaultEnvName: settings.defaultEnvName ?? null,
          defaultPermMode: settings.defaultPermMode ?? null,
          defaultWorkingDir: settings.defaultWorkingDir ?? null,
          topicBindings: settings.topicBindings ?? [],
          preferences: settings.preferences ?? {
            showToolCalls: true,
            showLowRiskTools: false,
            flushIntervalMs: 3000,
          },
        });
        setTelegramAllowedUserIdsInput((settings.allowedUserIds ?? []).join(', '));
        setTelegramStatus((current) => (telegramStatusEqual(current, status) ? current : status));
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load telegram bridge state:', error);
        }
      }
    };

    void loadTelegram();
    const intervalId = window.setInterval(() => {
      void getTelegramBridgeStatus().then((status) => {
        if (!cancelled) {
          setTelegramStatus((current) => (telegramStatusEqual(current, status) ? current : status));
        }
      }).catch(() => {});
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [getTelegramBridgeStatus, getTelegramSettings]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const parsedAllowedUserIds = parseTelegramUserIdsInput(telegramAllowedUserIdsInput);
      if (parsedAllowedUserIds.invalid.length > 0) {
        toast.error(
          t('settings.telegramAllowedUserIdsInvalid')
            .replace('{value}', parsedAllowedUserIds.invalid.join(', '))
        );
        return;
      }

      await saveTelegramSettings({
        enabled: telegramSettings.enabled,
        botToken: telegramSettings.botToken?.trim() || null,
        allowedUserIds: parsedAllowedUserIds.values,
        allowedChatId: telegramSettings.allowedChatId,
        notificationsChatId: telegramSettings.notificationsChatId,
        notificationsThreadId: telegramSettings.notificationsThreadId,
        defaultEnvName: telegramSettings.defaultEnvName || null,
        defaultPermMode: telegramSettings.defaultPermMode || null,
        defaultWorkingDir: telegramSettings.defaultWorkingDir || null,
        topicBindings: telegramSettings.topicBindings ?? [],
        preferences: telegramSettings.preferences ?? {
          showToolCalls: true,
          showLowRiskTools: false,
          flushIntervalMs: 3000,
        },
      });
      setTelegramSettings((current) => ({
        ...current,
        allowedUserIds: parsedAllowedUserIds.values,
      }));
      setTelegramAllowedUserIdsInput(parsedAllowedUserIds.values.join(', '));
      setTelegramStatus(await getTelegramBridgeStatus());
      toast.success(t('settings.telegramSaved'));
    } catch (error) {
      toast.error(t('settings.telegramSaveFailed').replace('{error}', String(error)));
    } finally {
      setIsSaving(false);
    }
  };

  const handleStart = async () => {
    setIsToggling(true);
    try {
      const status = await startTelegramBridge();
      setTelegramStatus(status);
      toast.success(t('settings.telegramStarted'));
    } catch (error) {
      toast.error(t('settings.telegramStartFailed').replace('{error}', String(error)));
    } finally {
      setIsToggling(false);
    }
  };

  const handleStop = async () => {
    setIsToggling(true);
    try {
      const status = await stopTelegramBridge();
      setTelegramStatus(status);
      toast.success(t('settings.telegramStopSuccess'));
    } catch (error) {
      toast.error(t('settings.telegramStopFailed').replace('{error}', String(error)));
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <>
      <div className="space-y-5">
        {/* ─── Status Hero ─── */}
        <div className="rounded-2xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {/* Status indicator */}
              <div className={`
                flex h-10 w-10 items-center justify-center rounded-full
                ${telegramStatus.running
                  ? 'bg-success/10'
                  : 'bg-muted/10'
                }
              `}>
                <Circle
                  className={`h-3 w-3 ${
                    telegramStatus.running
                      ? 'fill-success text-success'
                      : 'fill-muted-foreground/40 text-muted-foreground/40'
                  }`}
                />
              </div>

              <div>
                <div className="flex items-center gap-2.5">
                  <h3 className="text-base font-semibold text-foreground tracking-tight">
                    {t('settings.telegramTitle')}
                  </h3>
                  <span className={`
                    inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium
                    ${telegramStatus.running
                      ? 'bg-success/10 text-success'
                      : telegramStatus.configured
                        ? 'bg-warning/10 text-warning'
                        : 'bg-muted/50 text-muted-foreground'
                    }
                  `}>
                    {telegramStatus.running
                      ? t('settings.telegramRunning')
                      : telegramStatus.configured
                        ? t('settings.telegramConfigured')
                        : t('settings.telegramNotConfigured')
                    }
                  </span>
                </div>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {telegramStatus.botUsername
                    ? `@${telegramStatus.botUsername}`
                    : t('settings.telegramDesc')
                  }
                </p>
              </div>
            </div>

            {/* Primary action */}
            <div className="flex items-center gap-2">
              {telegramStatus.running ? (
                <Button
                  variant="outline"
                  className="rounded-full px-5"
                  onClick={handleStop}
                  disabled={isToggling}
                >
                  <Square className="mr-1.5 h-3.5 w-3.5" />
                  {t('settings.telegramStop')}
                </Button>
              ) : (
                <Button
                  className="rounded-full px-5"
                  onClick={handleStart}
                  disabled={isToggling || !(telegramSettings.botToken || '').trim()}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {t('settings.telegramStart')}
                </Button>
              )}
            </div>
          </div>

          {/* Error display */}
          {telegramStatus.lastError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-destructive/5 px-3.5 py-2.5">
              <MessageSquareWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <p className="text-xs text-destructive">{telegramStatus.lastError}</p>
            </div>
          )}
        </div>

        {/* ─── Configuration Section ─── */}
        <div className="rounded-2xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] p-5 space-y-5">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <h4 className="text-sm font-semibold text-foreground">{t('settings.telegramBotToken')}</h4>
          </div>

          <div className="space-y-4">
            <ToggleSetting
              checked={telegramSettings.enabled}
              onChange={(value) => setTelegramSettings((current) => ({ ...current, enabled: value }))}
              title={t('settings.telegramEnabled')}
              description={t('settings.telegramEnabledDesc')}
            />

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted-foreground">
                {t('settings.telegramBotToken')}
              </label>
              <input
                type="password"
                className={INPUT_CLS}
                value={telegramSettings.botToken ?? ''}
                onChange={(event) => setTelegramSettings((current) => ({ ...current, botToken: event.target.value }))}
                placeholder={t('settings.telegramBotTokenPlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted-foreground">
                {t('settings.telegramAllowedUserIds')}
              </label>
              <input
                type="text"
                className={INPUT_CLS}
                value={telegramAllowedUserIdsInput}
                onChange={(event) => setTelegramAllowedUserIdsInput(event.target.value)}
                placeholder={t('settings.telegramAllowedUserIdsPlaceholder')}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('settings.telegramAllowedUserIdsDesc')}
              </p>
              {telegramSettings.enabled && telegramAllowedUserIdsInput.trim().length === 0 && (
                <p className="text-[11px] text-warning">
                  {t('settings.telegramAllowedUserIdsWarning')}
                </p>
              )}
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end pt-1">
            <Button
              variant="outline"
              className="rounded-full px-5"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? t('common.loading') : t('settings.telegramSave')}
            </Button>
          </div>
        </div>

        {/* ─── Advanced Settings (Collapsible) ─── */}
        <div className="rounded-2xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAdvanced((current) => !current)}
            className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
          >
            <div>
              <p className="text-sm font-semibold text-foreground">{t('settings.telegramAdvanced')}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.telegramAdvancedDesc')}</p>
            </div>
            {showAdvanced ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {showAdvanced && (
            <div className="border-t border-black/[0.06] dark:border-white/[0.08] px-5 py-5">
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {/* Left column */}
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-muted-foreground">
                      {t('settings.telegramAllowedChatId')}
                    </label>
                    <input
                      type="number"
                      className={INPUT_CLS}
                      value={telegramSettings.allowedChatId ?? ''}
                      onChange={(event) => setTelegramSettings((current) => ({
                        ...current,
                        allowedChatId: event.target.value ? Number(event.target.value) : null,
                      }))}
                      placeholder={t('settings.telegramAllowedChatIdPlaceholder')}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t('settings.telegramAllowedChatIdDesc')}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-muted-foreground">
                      {t('settings.telegramNotificationsChatId')}
                    </label>
                    <input
                      type="number"
                      className={INPUT_CLS}
                      value={telegramSettings.notificationsChatId ?? ''}
                      onChange={(event) => setTelegramSettings((current) => ({
                        ...current,
                        notificationsChatId: event.target.value ? Number(event.target.value) : null,
                      }))}
                      placeholder={t('settings.telegramNotificationsChatIdPlaceholder')}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t('settings.telegramNotificationsChatIdDesc')}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-muted-foreground">
                      {t('settings.telegramNotificationsThreadId')}
                    </label>
                    <input
                      type="number"
                      className={INPUT_CLS}
                      value={telegramSettings.notificationsThreadId ?? ''}
                      onChange={(event) => setTelegramSettings((current) => ({
                        ...current,
                        notificationsThreadId: event.target.value ? Number(event.target.value) : null,
                      }))}
                      placeholder={t('settings.telegramNotificationsThreadIdPlaceholder')}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t('settings.telegramNotificationsThreadIdDesc')}
                    </p>
                  </div>
                </div>

                {/* Right column */}
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-muted-foreground">
                      {t('settings.telegramDefaultEnv')}
                    </label>
                    <Select
                      value={telegramSettings.defaultEnvName || '__current__'}
                      onValueChange={(value) => setTelegramSettings((current) => ({
                        ...current,
                        defaultEnvName: value === '__current__' ? null : value,
                      }))}
                    >
                      <SelectTrigger className="w-full h-auto px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm">
                        <SelectValue placeholder={t('settings.telegramUseCurrentEnv')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__current__">{t('settings.telegramUseCurrentEnv')}</SelectItem>
                        {environments.map((env) => (
                          <SelectItem key={env.name} value={env.name}>{env.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-muted-foreground">
                      {t('settings.telegramDefaultPerm')}
                    </label>
                    <Select
                      value={telegramSettings.defaultPermMode || '__app_default__'}
                      onValueChange={(value) => setTelegramSettings((current) => ({
                        ...current,
                        defaultPermMode: value === '__app_default__' ? null : value,
                      }))}
                    >
                      <SelectTrigger className="w-full h-auto px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm">
                        <SelectValue placeholder={t('settings.telegramUseDefaultPerm')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__app_default__">{t('settings.telegramUseDefaultPerm')}</SelectItem>
                        {Object.keys(PERMISSION_PRESETS).map((key) => (
                          <SelectItem key={key} value={key}>{MODE_DISPLAY_NAMES[key as PermissionModeName] || key}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-muted-foreground">
                      {t('settings.telegramWorkingDir')}
                    </label>
                    <div className="flex gap-2">
                      <input
                        className={`${INPUT_CLS} font-mono`}
                        value={telegramSettings.defaultWorkingDir ?? ''}
                        onChange={(event) => setTelegramSettings((current) => ({ ...current, defaultWorkingDir: event.target.value || null }))}
                        placeholder={defaultWorkingDir || t('settings.telegramWorkingDirPlaceholder')}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 rounded-xl"
                        onClick={async () => {
                          const path = await openDirectoryPicker();
                          if (path) {
                            setTelegramSettings((current) => ({ ...current, defaultWorkingDir: path }));
                          }
                        }}
                      >
                        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                        {t('settings.selectDir')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Save in advanced too */}
              <div className="mt-5 flex justify-end">
                <Button
                  variant="outline"
                  className="rounded-full px-5"
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? t('common.loading') : t('settings.telegramSave')}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ─── Topic Bindings ─── */}
        {showAdvanced && (
          <TelegramTopicBindingsEditor
            bindings={telegramSettings.topicBindings ?? []}
            environmentNames={environments.map((env) => env.name)}
            defaultWorkingDir={defaultWorkingDir || null}
            onChange={(topicBindings) => setTelegramSettings((current) => ({ ...current, topicBindings }))}
            onPickDirectory={openDirectoryPicker}
            onQuickBind={() => setQuickBindOpen(true)}
          />
        )}
      </div>

      <BindToTelegramDialog
        open={quickBindOpen}
        onOpenChange={setQuickBindOpen}
        initialProjectDir={telegramSettings.defaultWorkingDir ?? defaultWorkingDir ?? null}
        initialEnvName={telegramSettings.defaultEnvName ?? null}
        initialPermMode={telegramSettings.defaultPermMode ?? null}
        onBound={(binding) => {
          setTelegramSettings((current) => {
            const topicBindings = [
              ...(current.topicBindings ?? []).filter((item) => item.threadId !== binding.threadId),
              binding,
            ].sort((left, right) => left.threadId - right.threadId);
            return { ...current, topicBindings };
          });
        }}
      />
    </>
  );
}
