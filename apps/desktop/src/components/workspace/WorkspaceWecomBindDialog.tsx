import { useEffect, useMemo, useState } from 'react';
import { Bot, LoaderCircle, Send } from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import { Switch } from '@/components/ui/switch';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '@/locales';
import type {
  BotBindingInfo,
  NativeSessionSummary,
  WecomTaskBindingOption,
  WecomTaskBindingTargetType,
} from '@/lib/tauri-ipc';
import { providerDisplayName } from './ComposerControls';

const MANUAL_TARGET_VALUE = '__manual__';

interface WorkspaceWecomBindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: NativeSessionSummary;
  onBound?: (binding: BotBindingInfo) => void | Promise<void>;
}

function targetValue(type: WecomTaskBindingTargetType, peerId: string) {
  return `${type}:${peerId}`;
}

function parseTargetValue(value: string): { type: WecomTaskBindingTargetType; peerId: string } | null {
  const [type, ...rest] = value.split(':');
  if ((type !== 'user' && type !== 'group') || rest.length === 0) {
    return null;
  }
  const peerId = rest.join(':').trim();
  return peerId ? { type, peerId } : null;
}

function firstTarget(options: WecomTaskBindingOption[]) {
  return options
    .flatMap((option) => option.targets)
    .find((target) => target.isDefault)
    ?? options[0]?.targets[0]
    ?? null;
}

export function WorkspaceWecomBindDialog({
  open,
  onOpenChange,
  session,
  onBound,
}: WorkspaceWecomBindDialogProps) {
  const { t } = useLocale();
  const {
    bindSessionToBot,
    getWecomTaskBindingOptions,
  } = useTauriCommands();
  const [options, setOptions] = useState<WecomTaskBindingOption[]>([]);
  const [selectedBotId, setSelectedBotId] = useState('');
  const [targetSelection, setTargetSelection] = useState(MANUAL_TARGET_VALUE);
  const [targetType, setTargetType] = useState<WecomTaskBindingTargetType>('user');
  const [peerId, setPeerId] = useState('');
  const [sendTaskCard, setSendTaskCard] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const selectedOption = useMemo(
    () => options.find((option) => option.botId === selectedBotId) ?? null,
    [options, selectedBotId],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    void getWecomTaskBindingOptions()
      .then((items) => {
        if (cancelled) {
          return;
        }
        setOptions(items);
        const first = items[0];
        setSelectedBotId(first?.botId ?? '');
        setSendTaskCard(first?.autoSendCard ?? true);
        const target = firstTarget(items);
        if (target) {
          setTargetSelection(targetValue(target.targetType, target.peerId));
          setTargetType(target.targetType);
          setPeerId(target.peerId);
        } else {
          setTargetSelection(MANUAL_TARGET_VALUE);
          setTargetType('user');
          setPeerId('');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(String(error));
          setOptions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getWecomTaskBindingOptions, open]);

  const handleBotChange = (botId: string) => {
    setSelectedBotId(botId);
    const option = options.find((item) => item.botId === botId);
    setSendTaskCard(option?.autoSendCard ?? true);
    const target = option?.targets.find((candidate) => candidate.isDefault)
      ?? option?.targets[0]
      ?? null;
    if (target) {
      setTargetSelection(targetValue(target.targetType, target.peerId));
      setTargetType(target.targetType);
      setPeerId(target.peerId);
    } else {
      setTargetSelection(MANUAL_TARGET_VALUE);
      setTargetType('user');
      setPeerId('');
    }
  };

  const handleTargetSelectionChange = (value: string) => {
    setTargetSelection(value);
    if (value === MANUAL_TARGET_VALUE) {
      return;
    }
    const parsed = parseTargetValue(value);
    if (parsed) {
      setTargetType(parsed.type);
      setPeerId(parsed.peerId);
    }
  };

  const canSubmit = Boolean(selectedOption?.botId.trim() && peerId.trim()) && !isSubmitting;

  const handleSubmit = async () => {
    if (!selectedOption) {
      toast.error(t('workspace.wecomBindNoBot'));
      return;
    }
    const peer = peerId.trim();
    if (!peer) {
      toast.error(t('workspace.wecomBindNoTarget'));
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await bindSessionToBot({
        runtime_id: session.runtime_id,
        platform: 'wecom',
        peer_id: `${targetType === 'group' ? 'group' : 'single'}:${peer}`,
        bot_id: selectedOption.botId.trim(),
        task_title: `${providerDisplayName(session.provider)} session`,
        task_summary: session.project_dir,
        send_task_card: sendTaskCard,
      });
      if (!sendTaskCard) {
        toast.success(t('workspace.wecomBindBound'));
      } else if (result.delivery_status === 'delivered') {
        toast.success(t('workspace.wecomBindDelivered'));
      } else {
        toast.error(
          t('workspace.wecomBindFailed').replace(
            '{error}',
            result.last_delivery_error || result.delivery_status,
          ),
        );
      }
      await onBound?.(result);
      onOpenChange(false);
    } catch (error) {
      toast.error(t('workspace.wecomBindFailed').replace('{error}', String(error)));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            {t('workspace.wecomBindDialogTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="workspace-wecom-bind-bot">{t('workspace.wecomBindBot')}</Label>
            <Select
              value={selectedBotId}
              onValueChange={handleBotChange}
              disabled={isLoading || options.length === 0}
            >
              <SelectTrigger id="workspace-wecom-bind-bot">
                <SelectValue placeholder={t('workspace.wecomBindBotPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.botId} value={option.botId}>
                    {option.name || option.botId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="workspace-wecom-bind-target">{t('workspace.wecomBindTarget')}</Label>
            <Select
              value={targetSelection}
              onValueChange={handleTargetSelectionChange}
              disabled={!selectedOption}
            >
              <SelectTrigger id="workspace-wecom-bind-target">
                <SelectValue placeholder={t('workspace.wecomBindTargetPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MANUAL_TARGET_VALUE}>
                  {t('workspace.wecomBindTargetManual')}
                </SelectItem>
                {selectedOption?.targets.map((target) => (
                  <SelectItem
                    key={targetValue(target.targetType, target.peerId)}
                    value={targetValue(target.targetType, target.peerId)}
                  >
                    {target.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_1fr]">
            <div className="grid gap-2">
              <Label htmlFor="workspace-wecom-bind-target-type">
                {t('workspace.wecomBindTargetType')}
              </Label>
              <Select
                value={targetType}
                onValueChange={(value) => setTargetType(value as WecomTaskBindingTargetType)}
              >
                <SelectTrigger id="workspace-wecom-bind-target-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t('workspace.wecomBindTargetUser')}</SelectItem>
                  <SelectItem value="group">{t('workspace.wecomBindTargetGroup')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="workspace-wecom-bind-peer">
                {t('workspace.wecomBindPeerId')}
              </Label>
              <Input
                id="workspace-wecom-bind-peer"
                value={peerId}
                onChange={(event) => {
                  setPeerId(event.target.value);
                  setTargetSelection(MANUAL_TARGET_VALUE);
                }}
                placeholder={t('workspace.wecomBindPeerIdPlaceholder')}
                className="font-mono"
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
            <Label htmlFor="workspace-wecom-bind-send-card">
              {t('workspace.wecomBindSendCard')}
            </Label>
            <Switch
              id="workspace-wecom-bind-send-card"
              checked={sendTaskCard}
              onCheckedChange={setSendTaskCard}
            />
          </div>

          {isLoading ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              {t('workspace.wecomBindLoading')}
            </p>
          ) : loadError ? (
            <p className="text-xs text-destructive">
              {t('workspace.wecomBindLoadFailed').replace('{error}', loadError)}
            </p>
          ) : options.length === 0 ? (
            <p className="text-xs text-destructive">
              {t('workspace.wecomBindNoBot')}
            </p>
          ) : null}
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
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? (
              <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-4 w-4" />
            )}
            {t('workspace.wecomBindSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
