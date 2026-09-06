import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquareQuote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useLocale } from '@/locales';
import type { ComposerSessionReference, ComposerSessionSnapshot } from './composerSessionReferences';
import type { SessionReferenceClient } from './sessionReferenceClient';

export function ComposerSessionReferencePanel({
  session, workingDir, sourceRuntimeId, draftText, onClose, client,
}: {
  session: ComposerSessionReference;
  workingDir: string;
  sourceRuntimeId?: string | null;
  draftText: string;
  onClose: () => void;
  client: SessionReferenceClient;
}) {
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<ComposerSessionSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [text, setText] = useState(draftText);
  const [canSend, setCanSend] = useState(false);
  const busy = useRef(false);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    client.read(workingDir, session.runtime_id).then((result) => { if (!cancelled) setSnapshot(result); })
      .catch(() => { if (!cancelled) setError(true); });
    client.list(workingDir, sourceRuntimeId).then((rows) => { if (!cancelled) setCanSend(rows.some((row) => row.runtime_id === session.runtime_id && row.can_send)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [session.runtime_id, workingDir, sourceRuntimeId, client]);

  const send = async () => {
    if (busy.current || uncertain || !sourceRuntimeId || !text.trim()) return;
    busy.current = true;
    setSending(true);
    try {
      await client.send({
        workingDir, sourceRuntimeId, targetRuntimeId: session.runtime_id,
        text, clientMessageId: requestId.current,
      });
      toast.success(t('workspace.sessionReferenceSubmitted'));
      onClose();
    } catch {
      // IPC failure can occur after admission. Never replay an uncertain send.
      setUncertain(true);
    } finally { busy.current = false; setSending(false); }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !sending) onClose(); }}>
      <DialogContent className="max-w-xl" data-session-reference-panel>
        <DialogTitle>{handoff ? t('workspace.sessionReferenceSendTo') : t('workspace.sessionReferencePreview')} · {session.title}</DialogTitle>
        <DialogDescription>{handoff ? t('workspace.sessionReferenceHandoffHint') : t('workspace.sessionReferenceHint')}</DialogDescription>
        {handoff ? <Textarea aria-label={t('workspace.sessionReferenceHandoffText')} value={text}
          onChange={(event) => setText(event.target.value)} disabled={sending || uncertain}
          maxLength={12000} className="min-h-40" /> : (
          <div className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs" data-session-reference-preview>
            {error ? t('workspace.sessionReferenceReadFailed') : snapshot?.text ?? t('workspace.sessionReferenceLoading')}
          </div>
        )}
        {!handoff && snapshot?.truncated ? <p className="text-xs text-muted-foreground">{t('workspace.sessionReferenceTruncated')}</p> : null}
        {uncertain ? <p role="alert" className="text-sm text-destructive">{t('workspace.sessionReferenceSendUncertain')}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={sending}>{t('workspace.sessionReferenceClose')}</Button>
          {sourceRuntimeId && canSend && !uncertain ? (
            handoff
              ? <Button onClick={() => void send()} disabled={sending || !text.trim()}>{t('workspace.sessionReferenceConfirmSend')}</Button>
              : <Button variant="secondary" onClick={() => setHandoff(true)}>{t('workspace.sessionReferenceSendTo')}</Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ComposerSessionReferenceStrip({ references, disabled, onSelect }: {
  references: ComposerSessionReference[];
  disabled?: boolean;
  onSelect: (reference: ComposerSessionReference) => void;
}) {
  const { t } = useLocale();
  if (!references.length) return null;
  return <div className="mb-2 flex flex-wrap items-center gap-1.5" data-session-reference-strip>
    <span className="text-xs text-muted-foreground">{t('workspace.sessionReferenceOnly')}</span>
    {references.map((reference) => (
      <Button key={reference.runtime_id} size="sm" variant="outline" className="h-7 max-w-56 gap-1 text-xs"
        onClick={() => onSelect(reference)} disabled={disabled}>
        <MessageSquareQuote className="h-3 w-3" /><span className="truncate">{reference.title}</span>
      </Button>
    ))}
  </div>;
}
