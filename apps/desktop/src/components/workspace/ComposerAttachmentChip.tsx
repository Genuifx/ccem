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
      <span className="shrink-0 rounded-lg bg-muted p-1.5 text-muted-foreground">
        {attachmentIcon(attachment)}
      </span>
    );

  return (
    <span
      data-composer-attachment-chip
      data-attachment-id={attachment.id}
      className="inline-flex max-w-[min(100%,320px)] items-center gap-2 rounded-xl border border-border/40 bg-surface py-1.5 pl-1.5 pr-2 text-left text-foreground"
      title={title}
    >
      {thumbnail}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium leading-4">
          {attachment.name}
        </span>
        <span className="block truncate text-[10px] leading-4 text-muted-foreground">
          {secondaryLabel}
        </span>
      </span>
      <button
        type="button"
        className="ml-0.5 shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        onClick={() => onRemove(attachment.id)}
        aria-label={t('workspace.composerRemoveAttachment')}
        title={t('workspace.composerRemoveAttachment')}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
