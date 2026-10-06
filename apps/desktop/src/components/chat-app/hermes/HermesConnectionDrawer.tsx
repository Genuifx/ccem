import { useRef, type ReactNode } from 'react';
import { Content } from '@radix-ui/react-dialog';
import { X } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useLocale } from '@/locales';

// The existing dialog handles native-surface occlusion and Radix handles focus,
// Escape and outside clicks. Only its presentation changes to a side panel.
export function HermesConnectionDrawer({ title, description, accountRef, onClose, children }: {
  title: string; description: string; accountRef: string; onClose: () => void; children: ReactNode;
}) {
  const { t } = useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPortal>
      <DialogOverlay className="hermes-drawer-overlay" />
      <Content className="hermes-panel hermes-drawer" data-hermes-drawer={accountRef}
        onOpenAutoFocus={(event) => { event.preventDefault(); heading.current?.focus(); }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocus.current;
          if (target?.isConnected) target.focus({ preventScroll: true });
          else document.querySelector<HTMLButtonElement>('[data-hermes-add]')?.focus({ preventScroll: true });
        }}>
        <header className="hermes-drawer-header">
          <div><DialogTitle ref={heading} tabIndex={-1}>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></div>
          <Button size="icon" variant="ghost" aria-label={t('hermes.closeDetails')} onClick={onClose}><X aria-hidden="true" /></Button>
        </header>
        <div className="hermes-drawer-body">{children}</div>
      </Content>
    </DialogPortal>
  </Dialog>;
}
