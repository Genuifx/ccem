import type { Segment } from '@/components/types';
import type { RecoveryDraft } from '@/lib/recoveryDrafts';
import type { ComposerImageAttachment } from './composerAttachments';

export function toRecoveredComposerDraft(draft: RecoveryDraft) {
  const images = new Map(draft.attachments
    .filter((attachment): attachment is ComposerImageAttachment => attachment.kind === 'image')
    .map(attachment => [attachment.placeholder, attachment]));
  const segments = draft.text.split(/(\[Image #\d+\])/g).filter(Boolean).map((part): Segment => {
    const image = images.get(part);
    return image ? {
      type: 'chip', trigger: '', value: part, displayText: part,
      data: { kind: 'image', attachmentId: image.id, placeholder: part, name: image.name },
    } : { type: 'text', text: part };
  });
  return {
    recoveryId: draft.id,
    segments,
    attachments: draft.attachments,
    annotations: draft.annotations ?? [],
  };
}
