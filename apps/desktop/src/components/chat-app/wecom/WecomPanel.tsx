import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Circle,
  FolderOpen,
  KeyRound,
  Pencil,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
  Users,
} from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocale } from '@/locales';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import type { WecomBotConfig, WecomBridgeStatus, WecomSettings } from '@/lib/tauri-ipc';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';

const INPUT_CLS =
  'h-8 w-full rounded-lg bg-black/[0.03] dark:bg-white/[0.05] border border-black/[0.08] dark:border-white/[0.08] px-2.5 py-1 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all';

const TEXTAREA_CLS = `${INPUT_CLS} min-h-[44px] resize-y leading-snug py-1.5`;

const DEFAULT_USER_ACCESS_POLICY =
  '允许普通用户提交工作内容、项目进展、下周计划等材料，并请求生成、整理或润色周报。拒绝与该范围无关的任务，包括执行命令、修改文件、读取敏感信息、操作代码仓库、部署发布或访问外部系统。';

const MODE_DISPLAY_NAMES: Record<PermissionModeName, string> = {
  yolo: 'YOLO',
  dev: 'Developer',
  readonly: 'Read Only',
  safe: 'Safe',
  ci: 'CI / CD',
  audit: 'Audit',
};

function blankBot(): WecomBotConfig {
  return {
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `bot-${Date.now()}`,
    name: '',
    botId: '',
    secret: '',
    enabled: true,
    workspaceDir: '',
    adminUserIds: [],
    allowedUserIds: [],
    allowedGroupChatIds: [],
    allowedIntents: [],
    userAccessPolicy: DEFAULT_USER_ACCESS_POLICY,
    requireMention: false,
    mentionPatterns: [],
    adminPermMode: 'dev',
    userPermMode: 'readonly',
    defaultEnvName: null,
    taskBindingDefaultTargetType: null,
    taskBindingDefaultPeerId: null,
    taskBindingAutoSendCard: true,
    wsUrl: 'wss://openws.work.weixin.qq.com',
  };
}

function splitLines(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)));
}

function joinLines(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

interface ToggleSettingProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  disabled?: boolean;
}

function ToggleSetting({ checked, onChange, title, disabled }: ToggleSettingProps) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 group">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`glass-toggle ${checked ? 'checked' : ''}`}
      />
      <span className="text-xs font-medium text-foreground">{title}</span>
    </label>
  );
}

interface SectionHeaderProps {
  title: string;
}

function SectionHeader({ title }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70">{title}</span>
      <div className="h-px flex-1 bg-border/40" />
    </div>
  );
}

interface DisclosureProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Disclosure({ title, open, onToggle, children }: DisclosureProps) {
  return (
    <div className="border-t border-border/30 pt-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-md py-1 text-left transition-colors hover:text-foreground/80"
      >
        <SectionHeader title={title} />
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function WecomPanel() {
  const { t } = useLocale();
  const environments = useAppStore((state) => state.environments);
  const {
    openDirectoryPicker,
    getWecomSettings,
    saveWecomSettings,
    getWecomBridgeStatus,
    startWecomBridge,
    stopWecomBridge,
  } = useTauriCommands();

  const [settings, setSettings] = useState<WecomSettings>({ enabled: false, bots: [] });
  const [status, setStatus] = useState<WecomBridgeStatus>({
    configured: false,
    running: false,
    activeBotCount: 0,
    bots: [],
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());

  const envNames = useMemo(() => environments.map((env) => env.name).sort(), [environments]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [nextSettings, nextStatus] = await Promise.all([
          getWecomSettings(),
          getWecomBridgeStatus(),
        ]);
        if (cancelled) return;
        setSettings({
          enabled: nextSettings.enabled ?? false,
          bots: (nextSettings.bots ?? []).map((bot) => ({ ...blankBot(), ...bot })),
        });
        setStatus(nextStatus);
      } catch (error) {
        if (!cancelled) console.error('Failed to load WeCom settings:', error);
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void getWecomBridgeStatus()
        .then((nextStatus) => {
          if (!cancelled) setStatus(nextStatus);
        })
        .catch(() => {});
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [getWecomBridgeStatus, getWecomSettings]);

  const updateBot = (id: string, patch: Partial<WecomBotConfig>) => {
    setSettings((current) => ({
      ...current,
      bots: current.bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot)),
    }));
  };

  const persistSettings = async () => {
    const normalized: WecomSettings = {
      enabled: settings.enabled,
      bots: settings.bots.map((bot) => ({
        ...bot,
        name: bot.name?.trim() ?? '',
        botId: bot.botId.trim(),
        secret: bot.secret?.trim() || null,
        workspaceDir: bot.workspaceDir.trim(),
        adminUserIds: splitLines(joinLines(bot.adminUserIds)),
        allowedUserIds: splitLines(joinLines(bot.allowedUserIds)),
        allowedGroupChatIds: splitLines(joinLines(bot.allowedGroupChatIds)),
        mentionPatterns: splitLines(joinLines(bot.mentionPatterns)),
        allowedIntents: bot.allowedIntents ?? [],
        userAccessPolicy: bot.userAccessPolicy?.trim() || DEFAULT_USER_ACCESS_POLICY,
        wsUrl: bot.wsUrl?.trim() || 'wss://openws.work.weixin.qq.com',
        defaultEnvName: bot.defaultEnvName || null,
        taskBindingDefaultTargetType: bot.taskBindingDefaultTargetType || null,
        taskBindingDefaultPeerId: bot.taskBindingDefaultPeerId?.trim() || null,
        taskBindingAutoSendCard: bot.taskBindingAutoSendCard ?? true,
      })),
    };
    await saveWecomSettings(normalized);
    setSettings(normalized);
    setStatus(await getWecomBridgeStatus());
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await persistSettings();
      toast.success(t('settings.wecomSaved'));
    } catch (error) {
      toast.error(t('settings.wecomSaveFailed').replace('{error}', String(error)));
    } finally {
      setIsSaving(false);
    }
  };

  const handleStart = async () => {
    setIsToggling(true);
    try {
      await persistSettings();
      setStatus(await startWecomBridge());
      toast.success(t('settings.wecomStarted'));
    } catch (error) {
      toast.error(t('settings.wecomStartFailed').replace('{error}', String(error)));
    } finally {
      setIsToggling(false);
    }
  };

  const handleStop = async () => {
    setIsToggling(true);
    try {
      setStatus(await stopWecomBridge());
      toast.success(t('settings.wecomStopSuccess'));
    } catch (error) {
      toast.error(t('settings.wecomStopFailed').replace('{error}', String(error)));
    } finally {
      setIsToggling(false);
    }
  };

  const runningLabel = status.running
    ? t('settings.wecomRunning').replace('{count}', String(status.activeBotCount ?? 0))
    : t('settings.wecomStopped');

  const addBot = () => {
    const newBot = blankBot();
    setEditingIds((prev) => new Set(prev).add(newBot.id));
    setSettings((current) => ({ ...current, bots: [...current.bots, newBot] }));
  };

  const removeBot = (id: string) => {
    setEditingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSettings((current) => ({ ...current, bots: current.bots.filter((item) => item.id !== id) }));
  };

  const enterEdit = (id: string) => setEditingIds((prev) => new Set(prev).add(id));
  const leaveEdit = (id: string) => setEditingIds((prev) => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });

  return (
    <div className="space-y-4">
      {/* Status / control plane */}
      <div className="glass-card glass-noise rounded-2xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="relative inline-flex h-2.5 w-2.5">
              {status.running && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-success/25" />
              )}
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                  status.running ? 'bg-success' : 'bg-muted-foreground/35'
                }`}
              />
            </span>
            <div>
              <div className="text-sm font-semibold text-foreground">{runningLabel}</div>
              {status.lastError && <div className="mt-0.5 text-xs text-destructive">{status.lastError}</div>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ToggleSetting
              checked={settings.enabled}
              onChange={(enabled) => setSettings((current) => ({ ...current, enabled }))}
              title={t('settings.wecomEnable')}
            />
            <div className="mx-1 h-4 w-px bg-border/50" />
            <Button variant="secondary" size="sm" onClick={handleSave} disabled={isSaving || isToggling}>
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {t('common.save')}
            </Button>
            {status.running ? (
              <Button variant="destructive" size="sm" onClick={handleStop} disabled={isToggling}>
                <Square className="mr-1.5 h-3.5 w-3.5" />
                {t('settings.stopBridge')}
              </Button>
            ) : (
              <Button size="sm" onClick={handleStart} disabled={isToggling || settings.bots.length === 0}>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                {t('settings.startBridge')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Bot list */}
      <div className="space-y-3">
        {settings.bots.map((bot, index) => {
          const botStatus = status.bots?.find((item) => item.id === bot.id || item.botId === bot.botId);
          return (
            <BotCard
              key={bot.id}
              bot={bot}
              index={index}
              botStatus={botStatus}
              envNames={envNames}
              isEditing={editingIds.has(bot.id)}
              onUpdate={(patch) => updateBot(bot.id, patch)}
              onRemove={() => removeBot(bot.id)}
              onEnterEdit={() => enterEdit(bot.id)}
              onLeaveEdit={() => leaveEdit(bot.id)}
              onPickWorkspace={async () => {
                const picked = await openDirectoryPicker();
                if (picked) updateBot(bot.id, { workspaceDir: picked });
              }}
            />
          );
        })}
      </div>

      {/* Empty / add */}
      <div className="flex items-center justify-between gap-3">
        {settings.bots.length === 0 && (
          <div className="text-2xs text-muted-foreground">{t('settings.wecomNoBots')}</div>
        )}
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={addBot}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('settings.wecomAddBot')}
        </Button>
      </div>
    </div>
  );
}

interface BotStatusItem {
  id?: string;
  botId?: string;
  running?: boolean;
}

interface BotCardProps {
  bot: WecomBotConfig;
  index: number;
  botStatus?: BotStatusItem;
  envNames: string[];
  isEditing: boolean;
  onUpdate: (patch: Partial<WecomBotConfig>) => void;
  onRemove: () => void;
  onEnterEdit: () => void;
  onLeaveEdit: () => void;
  onPickWorkspace: () => Promise<void>;
}

function BotCard({
  bot,
  index,
  botStatus,
  envNames,
  isEditing,
  onUpdate,
  onRemove,
  onEnterEdit,
  onLeaveEdit,
  onPickWorkspace,
}: BotCardProps) {
  const { t } = useLocale();
  const [showPolicy, setShowPolicy] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const displayName = bot.name || t('settings.wecomBotTitle').replace('{index}', String(index + 1));

  return (
    <div className="glass-card glass-noise rounded-2xl p-4 transition-all duration-150 hover:border-primary/10">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">{displayName}</div>
            <div className="text-2xs text-muted-foreground/70">{bot.botId || t('settings.wecomBotId')}</div>
          </div>
          {botStatus?.running && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-2xs font-medium text-success">
              <Circle className="h-1.5 w-1.5 fill-success" />
              {t('settings.running')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ToggleSetting
            checked={bot.enabled}
            onChange={(enabled) => onUpdate({ enabled })}
            title={t('settings.enabled')}
          />
          {isEditing ? (
            <Button variant="ghost" size="sm" className="h-8 px-2.5" onClick={onLeaveEdit}>
              {t('settings.wecomDone')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-8 px-2.5" onClick={onEnterEdit}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              {t('common.edit')}
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove} aria-label={t('settings.wecomRemoveBot')}>
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {isEditing ? (
        <BotEditView
          bot={bot}
          envNames={envNames}
          onUpdate={onUpdate}
          onPickWorkspace={onPickWorkspace}
          showPolicy={showPolicy}
          setShowPolicy={setShowPolicy}
          showAdvanced={showAdvanced}
          setShowAdvanced={setShowAdvanced}
        />
      ) : (
        <BotReadView bot={bot} />
      )}
    </div>
  );
}

function BotReadView({ bot }: { bot: WecomBotConfig }) {
  const { t } = useLocale();

  const formatCount = (count: number, label: string) => `${count} ${label}`;

  return (
    <div className="space-y-3">
      <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-3">
        <ReadRow label={t('settings.wecomBotId')} value={bot.botId || t('settings.wecomNotSet')} mono />
        <ReadRow label={t('settings.wecomWorkspace')} value={bot.workspaceDir || t('settings.wecomNotSet')} mono />
        <ReadRow
          label={t('settings.wecomEnv')}
          value={bot.defaultEnvName || t('settings.telegramUseCurrentEnv')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span>{formatCount(bot.adminUserIds.length, t('settings.wecomAdminUsersCount'))}</span>
        <span className="text-border/60">·</span>
        <span>{formatCount(bot.allowedUserIds.length, t('settings.wecomAllowedUsersCount'))}</span>
        <span className="text-border/60">·</span>
        <span>{formatCount(bot.allowedGroupChatIds.length, t('settings.wecomAllowedGroupsCount'))}</span>
        <span className="text-border/60">·</span>
        <span>{formatCount(bot.mentionPatterns.length, t('settings.wecomMentionPatternsCount'))}</span>
      </div>

      <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-3">
        <ReadRow label={t('settings.wecomAdminPerm')} value={MODE_DISPLAY_NAMES[bot.adminPermMode as PermissionModeName] ?? bot.adminPermMode} />
        <ReadRow label={t('settings.wecomUserPerm')} value={MODE_DISPLAY_NAMES[bot.userPermMode as PermissionModeName] ?? bot.userPermMode} />
        <ReadRow
          label={t('settings.wecomRequireMention')}
          value={bot.requireMention ? t('settings.wecomRequired') : t('settings.wecomNotRequired')}
        />
        <ReadRow
          label={t('settings.wecomTaskBindingDefault')}
          value={formatTaskBindingDefault(bot, t)}
          mono
        />
      </div>
    </div>
  );
}

interface ReadRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

function ReadRow({ label, value, mono }: ReadRowProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/60">{label}</span>
      <span className={`truncate text-sm text-foreground ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

interface BotEditViewProps {
  bot: WecomBotConfig;
  envNames: string[];
  onUpdate: (patch: Partial<WecomBotConfig>) => void;
  onPickWorkspace: () => Promise<void>;
  showPolicy: boolean;
  setShowPolicy: (v: boolean) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
}

function BotEditView({
  bot,
  envNames,
  onUpdate,
  onPickWorkspace,
  showPolicy,
  setShowPolicy,
  showAdvanced,
  setShowAdvanced,
}: BotEditViewProps) {
  const { t } = useLocale();

  return (
    <div className="space-y-4">
      {/* Identity */}
      <div className="space-y-2.5">
        <SectionHeader title={t('settings.wecomSectionIdentity')} />
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={t('settings.wecomBotName')}>
            <input className={INPUT_CLS} value={bot.name ?? ''} onChange={(e) => onUpdate({ name: e.target.value })} />
          </Field>
          <Field label={t('settings.wecomBotId')}>
            <input className={INPUT_CLS} value={bot.botId} onChange={(e) => onUpdate({ botId: e.target.value })} />
          </Field>
          <Field label={t('settings.wecomSecret')}>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
              <input
                type="password"
                className={`${INPUT_CLS} pl-8`}
                value={bot.secret ?? ''}
                onChange={(e) => onUpdate({ secret: e.target.value })}
              />
            </div>
          </Field>
        </div>
      </div>

      {/* Access */}
      <div className="space-y-2.5">
        <SectionHeader title={t('settings.wecomSectionAccess')} />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label={t('settings.wecomWorkspace')}>
            <div className="flex gap-2">
              <input
                className={INPUT_CLS}
                value={bot.workspaceDir}
                onChange={(e) => onUpdate({ workspaceDir: e.target.value })}
              />
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onPickWorkspace} aria-label={t('common.browse')}>
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Field>
          <Field label={t('settings.wecomAdminUsers')}>
            <textarea
              className={TEXTAREA_CLS}
              value={joinLines(bot.adminUserIds)}
              onChange={(e) => onUpdate({ adminUserIds: splitLines(e.target.value) })}
              rows={1}
            />
          </Field>
          <Field label={t('settings.wecomAllowedUsers')}>
            <textarea
              className={TEXTAREA_CLS}
              value={joinLines(bot.allowedUserIds)}
              onChange={(e) => onUpdate({ allowedUserIds: splitLines(e.target.value) })}
              rows={1}
            />
          </Field>
          <Field label={t('settings.wecomAllowedGroups')}>
            <textarea
              className={TEXTAREA_CLS}
              value={joinLines(bot.allowedGroupChatIds)}
              onChange={(e) => onUpdate({ allowedGroupChatIds: splitLines(e.target.value) })}
              rows={1}
            />
          </Field>
        </div>
      </div>

      {/* Runtime */}
      <div className="space-y-2.5">
        <SectionHeader title={t('settings.wecomSectionRuntime')} />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <Field label={t('settings.wecomEnv')}>
            <Select
              value={bot.defaultEnvName ?? '__current__'}
              onValueChange={(value) => onUpdate({ defaultEnvName: value === '__current__' ? null : value })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__current__">{t('settings.telegramUseCurrentEnv')}</SelectItem>
                {envNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('settings.wecomAdminPerm')}>
            <Select value={bot.adminPermMode} onValueChange={(value) => onUpdate({ adminPermMode: value as PermissionModeName })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(PERMISSION_PRESETS).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {MODE_DISPLAY_NAMES[mode as PermissionModeName] ?? mode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('settings.wecomUserPerm')}>
            <Select value={bot.userPermMode} onValueChange={(value) => onUpdate({ userPermMode: value as PermissionModeName })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(PERMISSION_PRESETS).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {MODE_DISPLAY_NAMES[mode as PermissionModeName] ?? mode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('settings.wecomMentionPatterns')}>
            <textarea
              className={TEXTAREA_CLS}
              value={joinLines(bot.mentionPatterns)}
              onChange={(e) => onUpdate({ mentionPatterns: splitLines(e.target.value) })}
              rows={1}
            />
          </Field>
          <div className="flex items-end">
            <ToggleSetting
              checked={bot.requireMention}
              onChange={(requireMention) => onUpdate({ requireMention })}
              title={t('settings.wecomRequireMention')}
            />
          </div>
        </div>
      </div>

      {/* Task binding */}
      <div className="space-y-2.5">
        <SectionHeader title={t('settings.wecomSectionTaskBinding')} />
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={t('settings.wecomTaskBindingTargetType')}>
            <Select
              value={bot.taskBindingDefaultTargetType ?? 'user'}
              onValueChange={(value) => onUpdate({ taskBindingDefaultTargetType: value as 'user' | 'group' })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t('settings.wecomTaskBindingUser')}</SelectItem>
                <SelectItem value="group">{t('settings.wecomTaskBindingGroup')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('settings.wecomTaskBindingPeerId')}>
            <input
              className={INPUT_CLS}
              value={bot.taskBindingDefaultPeerId ?? ''}
              onChange={(e) => onUpdate({ taskBindingDefaultPeerId: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <ToggleSetting
              checked={bot.taskBindingAutoSendCard ?? true}
              onChange={(taskBindingAutoSendCard) => onUpdate({ taskBindingAutoSendCard })}
              title={t('settings.wecomTaskBindingAutoSendCard')}
            />
          </div>
        </div>
      </div>

      {/* Policy */}
      <Disclosure title={t('settings.wecomSectionPolicy')} open={showPolicy} onToggle={() => setShowPolicy(!showPolicy)}>
        <div className="space-y-2">
          <textarea
            className={`${TEXTAREA_CLS} min-h-[88px]`}
            value={bot.userAccessPolicy || DEFAULT_USER_ACCESS_POLICY}
            onChange={(e) => onUpdate({ userAccessPolicy: e.target.value })}
          />
          <div className="flex items-center gap-2 text-2xs text-muted-foreground/70">
            <Users className="h-3 w-3" />
            {t('settings.wecomUserBoundary')}
          </div>
        </div>
      </Disclosure>

      {/* Advanced */}
      <Disclosure title={t('settings.wecomAdvanced')} open={showAdvanced} onToggle={() => setShowAdvanced(!showAdvanced)}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('settings.wecomWsUrl')}>
            <input
              className={INPUT_CLS}
              value={bot.wsUrl ?? 'wss://openws.work.weixin.qq.com'}
              onChange={(e) => onUpdate({ wsUrl: e.target.value })}
            />
          </Field>
          <Field label={t('settings.wecomAllowedIntents')}>
            <textarea
              className={TEXTAREA_CLS}
              value={joinLines(bot.allowedIntents)}
              onChange={(e) => onUpdate({ allowedIntents: splitLines(e.target.value) })}
              rows={1}
            />
          </Field>
        </div>
      </Disclosure>
    </div>
  );
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/70">{label}</Label>
      {children}
    </div>
  );
}

function formatTaskBindingDefault(bot: WecomBotConfig, t: (key: string) => string): string {
  const peerId = bot.taskBindingDefaultPeerId?.trim();
  if (!peerId) return t('settings.wecomNotSet');
  const targetType = bot.taskBindingDefaultTargetType === 'group'
    ? t('settings.wecomTaskBindingGroup')
    : t('settings.wecomTaskBindingUser');
  return `${targetType}: ${peerId}`;
}
