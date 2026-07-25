import { useState } from 'react';
import { FolderOpen, Link2, Pencil, PlusSquare, RotateCcw, Trash2 } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocale } from '@/locales';
import type { TelegramTopicBinding } from '@/lib/tauri-ipc';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';

const INPUT_CLS =
  'w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 transition-all';

interface TelegramTopicBindingsEditorProps {
  bindings: TelegramTopicBinding[];
  environmentNames: string[];
  defaultWorkingDir: string | null;
  onChange: (bindings: TelegramTopicBinding[]) => void;
  onPickDirectory: () => Promise<string | null>;
  onQuickBind?: () => void;
}

interface BindingDraft {
  threadId: string;
  projectDir: string;
  preferredEnv: string;
  preferredPermMode: string;
}

const EMPTY_DRAFT: BindingDraft = {
  threadId: '',
  projectDir: '',
  preferredEnv: '__current__',
  preferredPermMode: '__app_default__',
};

const MODE_DISPLAY_NAMES: Record<PermissionModeName, string> = {
  yolo: 'YOLO',
  dev: 'Developer',
  readonly: 'Read Only',
  safe: 'Safe',
  ci: 'CI / CD',
  audit: 'Audit',
};

function toDraft(binding: TelegramTopicBinding): BindingDraft {
  return {
    threadId: String(binding.threadId),
    projectDir: binding.projectDir,
    preferredEnv: binding.preferredEnv || '__current__',
    preferredPermMode: binding.preferredPermMode || '__app_default__',
  };
}

export function TelegramTopicBindingsEditor({
  bindings,
  environmentNames,
  defaultWorkingDir,
  onChange,
  onPickDirectory,
  onQuickBind,
}: TelegramTopicBindingsEditorProps) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<BindingDraft>(EMPTY_DRAFT);
  const [editingThreadId, setEditingThreadId] = useState<number | null>(null);

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT);
    setEditingThreadId(null);
  };

  const handleSaveBinding = () => {
    const threadId = Number(draft.threadId);
    const projectDir = draft.projectDir.trim();
    if (!Number.isFinite(threadId) || threadId <= 0 || !projectDir) {
      return;
    }

    const nextBinding: TelegramTopicBinding = {
      threadId,
      projectDir,
      preferredEnv: draft.preferredEnv === '__current__' ? null : draft.preferredEnv,
      preferredPermMode:
        draft.preferredPermMode === '__app_default__' ? null : draft.preferredPermMode,
      activeRuntimeId:
        bindings.find((binding) => binding.threadId === threadId)?.activeRuntimeId ?? null,
      lastClaudeSessionId:
        bindings.find((binding) => binding.threadId === threadId)?.lastClaudeSessionId ?? null,
      createdAt:
        bindings.find((binding) => binding.threadId === threadId)?.createdAt ??
        new Date().toISOString(),
    };

    const remaining = bindings.filter((binding) => binding.threadId !== threadId);
    onChange([...remaining, nextBinding].sort((left, right) => left.threadId - right.threadId));
    resetDraft();
  };

  const handleEditBinding = (binding: TelegramTopicBinding) => {
    setDraft(toDraft(binding));
    setEditingThreadId(binding.threadId);
  };

  const handleDeleteBinding = (threadId: number) => {
    onChange(bindings.filter((binding) => binding.threadId !== threadId));
    if (editingThreadId === threadId) {
      resetDraft();
    }
  };

  return (
    <div className="mt-4 space-y-4 border-t glass-divider pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" />
            {t('settings.telegramTopicBindings')}
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t('settings.telegramTopicBindingsDesc')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onQuickBind ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="glass-btn-outline"
              onClick={onQuickBind}
            >
              <PlusSquare className="w-3.5 h-3.5 mr-1.5" />
              {t('settings.telegramQuickBind')}
            </Button>
          ) : null}
          <span className="text-xs px-2 py-1 rounded-full bg-black/5 dark:bg-white/[0.08] text-muted-foreground">
            {bindings.length}
          </span>
        </div>
      </div>

      {bindings.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/[0.1] px-4 py-5 text-sm text-muted-foreground">
          {t('settings.telegramTopicBindingsEmpty')}
        </div>
      ) : (
        <div className="space-y-2">
          {bindings.map((binding) => (
            <div
              key={binding.threadId}
              className="rounded-2xl border border-black/8 dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      #{binding.threadId}
                    </span>
                    {binding.activeRuntimeId ? (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                        {t('settings.telegramTopicActiveRuntime')}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm font-mono text-foreground break-all">
                    {binding.projectDir}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {binding.preferredEnv || t('settings.telegramUseCurrentEnv')} ·{' '}
                    {binding.preferredPermMode || t('settings.telegramUseDefaultPerm')}
                  </p>
                  {binding.lastClaudeSessionId ? (
                    <p className="text-[11px] text-muted-foreground break-all">
                      {t('settings.telegramTopicLastSession')}: {binding.lastClaudeSessionId}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="glass-btn-outline"
                    onClick={() => handleEditBinding(binding)}
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1.5" />
                    {t('common.edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="glass-btn-outline"
                    onClick={() => handleDeleteBinding(binding.threadId)}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-black/8 dark:border-white/[0.08] px-4 py-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">
              {t('settings.telegramTopicThreadId')}
            </label>
            <input
              type="number"
              className={INPUT_CLS}
              value={draft.threadId}
              onChange={(event) => setDraft((current) => ({ ...current, threadId: event.target.value }))}
              placeholder={t('settings.telegramTopicThreadIdPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">
              {t('settings.telegramTopicProjectDir')}
            </label>
            <div className="flex gap-2">
              <input
                className={`${INPUT_CLS} font-mono`}
                value={draft.projectDir}
                onChange={(event) => setDraft((current) => ({ ...current, projectDir: event.target.value }))}
                placeholder={defaultWorkingDir || t('settings.telegramTopicProjectDirPlaceholder')}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="glass-btn-outline shrink-0"
                onClick={async () => {
                  const path = await onPickDirectory();
                  if (path) {
                    setDraft((current) => ({ ...current, projectDir: path }));
                  }
                }}
              >
                <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
                {t('settings.selectDir')}
              </Button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">
              {t('settings.telegramDefaultEnv')}
            </label>
            <Select
              value={draft.preferredEnv}
              onValueChange={(value) => setDraft((current) => ({ ...current, preferredEnv: value }))}
            >
              <SelectTrigger className="w-full h-auto px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm">
                <SelectValue placeholder={t('settings.telegramUseCurrentEnv')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__current__">{t('settings.telegramUseCurrentEnv')}</SelectItem>
                {environmentNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground">
              {t('settings.telegramDefaultPerm')}
            </label>
            <Select
              value={draft.preferredPermMode}
              onValueChange={(value) => setDraft((current) => ({ ...current, preferredPermMode: value }))}
            >
              <SelectTrigger className="w-full h-auto px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm">
                <SelectValue placeholder={t('settings.telegramUseDefaultPerm')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__app_default__">{t('settings.telegramUseDefaultPerm')}</SelectItem>
                {Object.keys(PERMISSION_PRESETS).map((key) => (
                  <SelectItem key={key} value={key}>
                    {MODE_DISPLAY_NAMES[key as PermissionModeName] || key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="glass-btn-outline"
            onClick={handleSaveBinding}
            disabled={!draft.threadId.trim() || !draft.projectDir.trim()}
          >
            {editingThreadId === null
              ? t('settings.telegramTopicAddBinding')
              : t('settings.telegramTopicUpdateBinding')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="glass-btn-outline"
            onClick={resetDraft}
            disabled={editingThreadId === null && !draft.threadId && !draft.projectDir}
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            {t('settings.telegramTopicResetBinding')}
          </Button>
        </div>
      </div>
    </div>
  );
}
