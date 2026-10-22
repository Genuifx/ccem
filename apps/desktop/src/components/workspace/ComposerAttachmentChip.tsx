import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import {
  File,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Package,
  X,
} from '@/lib/lucide-react';
import {
  getComposerFileKind,
  getComposerImageAttachmentSrc,
  type ComposerAttachment,
  type ComposerFileKind,
  type ComposerImageAttachment,
} from './composerAttachments';

const NEUTRAL_TONE = 'bg-muted text-muted-foreground';

// Only kinds worth telling apart at a glance get a tint; the rest stay neutral.
const FILE_KIND_ICONS: Record<ComposerFileKind, { Icon: typeof File; tone: string }> = {
  image: { Icon: FileImage, tone: 'bg-info/10 text-info' },
  code: { Icon: FileCode, tone: 'bg-primary/10 text-primary' },
  data: { Icon: FileJson, tone: 'bg-warning/15 text-warning' },
  spreadsheet: { Icon: FileSpreadsheet, tone: 'bg-success/10 text-success' },
  document: { Icon: FileText, tone: NEUTRAL_TONE },
  archive: { Icon: Package, tone: NEUTRAL_TONE },
  file: { Icon: File, tone: NEUTRAL_TONE },
};

function attachmentIcon(attachment: ComposerAttachment) {
  if (attachment.kind === 'text') return { Icon: FileText, tone: NEUTRAL_TONE };
  if (attachment.kind === 'image') return { Icon: ImageIcon, tone: FILE_KIND_ICONS.image.tone };
  return FILE_KIND_ICONS[getComposerFileKind(attachment.name)];
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

  const { Icon, tone } = attachmentIcon(attachment);
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
      <span className={cn('shrink-0 rounded-lg p-1.5', tone)}>
        <Icon className="h-3.5 w-3.5" />
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
