import { useLocale } from '@/locales';
import { FileText, Image as ImageIcon, Paperclip, X } from '@/lib/lucide-react';
import { getComposerImageAttachmentSrc, type ComposerAttachment, type ComposerImageAttachment } from './composerAttachments';

function attachmentIcon(attachment: ComposerAttachment) {
  if (attachment.kind === 'text') {
    return <FileText className="h-3.5 w-3.5" />;
  }

  if (attachment.kind === 'image') {
    return <ImageIcon className="h-3.5 w-3.5" />;
  }

  return <Paperclip className="h-3.5 w-3.5" />;
}

export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ComposerAttachmentChip({
  attachment,
  onRemove,
  onImageClick,
}: {
  attachment: ComposerAttachment;
  onRemove: (id: string) => void;
  onImageClick?: (attachment: ComposerImageAttachment) => void;
}) {
  const { t } = useLocale();

  const secondaryLabel = attachment.kind === 'file'
    ? attachment.displayPath
    : attachment.kind === 'image'
      ? formatImageSize(attachment.byteSize)
      : `${attachment.lineCount} lines`;

  const title = attachment.kind === 'file'
    ? attachment.absolutePath
    : attachment.name;

  const imageSrc = attachment.kind === 'image'
    ? getComposerImageAttachmentSrc(attachment)
    : null;
  const thumbnail = attachment.kind === 'image' && imageSrc
    ? (
      <button
        type="button"
        className="shrink-0 overflow-hidden rounded-lg border border-border/45 bg-background/80 outline-none transition-[border-color,box-shadow] hover:border-primary/45 focus-visible:ring-2 focus-visible:ring-primary/40"
        onClick={() => onImageClick?.(attachment as ComposerImageAttachment)}
        aria-label={t('workspace.composerImagePreviewOpen')}
        title={t('workspace.composerImagePreviewOpen')}
      >
        <img
          src={imageSrc}
          alt={attachment.name}
          className="h-11 w-16 object-contain"
        />
      </button>
    )
    : (
      <span className="rounded-md bg-background/80 p-1 text-muted-foreground">
        {attachmentIcon(attachment)}
      </span>
    );

  return (
    <span
      data-composer-attachment-chip
      data-attachment-id={attachment.id}
      className="inline-flex max-w-full items-center gap-2 rounded-xl bg-muted/55 px-2.5 py-1.5 text-left text-foreground"
      title={title}
    >
      {thumbnail}
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium leading-4">
          {attachment.name}
        </span>
        <span className="block truncate text-[9px] leading-3.5 text-muted-foreground/85">
          {secondaryLabel}
        </span>
      </span>
      <button
        type="button"
        className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
        onClick={() => onRemove(attachment.id)}
        aria-label={t('workspace.composerRemoveAttachment')}
        title={t('workspace.composerRemoveAttachment')}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
