import { useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { ccemMotion, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { Home, Terminal, Globe, BarChart3, Box, Settings, MessageSquare, MessageCircleMore, Clock, Bug } from '@/lib/lucide-react';
// import { PetEntry } from '@/components/pet/PetEntry';

interface SideRailProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  onTabPrefetch?: (tab: string) => void;
  glassMuted?: boolean;
}

interface NavItemDef {
  id: string;
  labelKey: string;
  icon: typeof Home;
  shortcut: string;
}

interface NavGroupDef {
  titleKey: string;
  items: NavItemDef[];
}

const navGroupDefs: NavGroupDef[] = [
  {
    titleKey: '',
    items: [
      { id: 'workspace', labelKey: 'sideRail.workspace', icon: Home, shortcut: '1' },
    ],
  },
  {
    titleKey: 'sideRail.groupWorkspace',
    items: [
      { id: 'sessions', labelKey: 'sideRail.sessions', icon: Terminal, shortcut: '2' },
      { id: 'environments', labelKey: 'sideRail.environments', icon: Globe, shortcut: '3' },
      { id: 'skills', labelKey: 'sideRail.skills', icon: Box, shortcut: '4' },
      { id: 'history', labelKey: 'sideRail.history', icon: MessageSquare, shortcut: '5' },
      { id: 'cron', labelKey: 'sideRail.cron', icon: Clock, shortcut: '6' },
      { id: 'chat-app', labelKey: 'sideRail.chatApp', icon: MessageCircleMore, shortcut: '7' },
    ],
  },
  {
    titleKey: 'sideRail.groupInsights',
    items: [
      { id: 'analytics', labelKey: 'sideRail.analytics', icon: BarChart3, shortcut: '8' },
      { id: 'proxy-debug', labelKey: 'sideRail.proxyDebug', icon: Bug, shortcut: '9' },
    ],
  },
];

const bottomItemDefs: NavItemDef[] = [
  { id: 'settings', labelKey: 'sideRail.settings', icon: Settings, shortcut: ',' },
];

function NavButton({
  item,
  label,
  isActive,
  onClick,
  onPrefetch,
  buttonRef,
}: {
  item: NavItemDef;
  label: string;
  isActive: boolean;
  onClick: () => void;
  onPrefetch?: () => void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      ref={buttonRef}
      data-testid={`nav-${item.id}`}
      data-sidebar-nav-item={item.id}
      aria-label={label}
      onClick={onClick}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      title={`${label} (⌘${item.shortcut})`}
      className={cn(
        'sidebar-nav-item group relative w-full flex items-center gap-2.5 px-2.5 h-[30px] rounded-lg',
        'transition-colors duration-[var(--duration-fast)]',
        isActive
          ? 'sidebar-nav-active text-foreground'
          : 'text-sidebar-foreground hover:text-foreground hover:bg-white/[0.06]'
      )}
    >
      <Icon className="w-[18px] h-[18px] shrink-0" strokeWidth={isActive ? 2 : 1.8} />
      <span className="text-[13px] leading-none truncate">{label}</span>
      <span className="ml-auto text-[11px] font-mono opacity-0 group-hover:opacity-100 transition-opacity duration-[var(--duration-fast)] text-muted-foreground">
        ⌘{item.shortcut}
      </span>
    </button>
  );
}

export function SideRail({ activeTab, onTabChange, onTabPrefetch, glassMuted }: SideRailProps) {
  const { t } = useLocale();
  const railRef = useRef<HTMLElement | null>(null);
  const activeIndicatorRef = useRef<HTMLSpanElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  const setButtonRef = useCallback((id: string) => (node: HTMLButtonElement | null) => {
    if (node) {
      buttonRefs.current.set(id, node);
      return;
    }
    buttonRefs.current.delete(id);
  }, []);

  useGSAP(() => {
    const rail = railRef.current;
    const indicator = activeIndicatorRef.current;
    const activeButton = buttonRefs.current.get(activeTab);
    if (!rail || !indicator || !activeButton) {
      if (indicator) {
        gsap.set(indicator, { autoAlpha: 0 });
      }
      return;
    }

    const railRect = rail.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const y = buttonRect.top - railRect.top;

    if (shouldReduceMotion()) {
      gsap.set(indicator, {
        autoAlpha: 1,
        y,
        height: buttonRect.height,
        width: buttonRect.width,
      });
      return;
    }

    gsap.to(indicator, {
      autoAlpha: 1,
      y,
      height: buttonRect.height,
      width: buttonRect.width,
      duration: ccemMotion.duration.base,
      ease: ccemMotion.ease.standard,
      overwrite: 'auto',
    });
  }, { dependencies: [activeTab], scope: railRef });

  return (
    <aside ref={railRef} className={cn(
      'h-full shrink-0 flex flex-col glass-sidebar-panel glass-noise relative rounded-xl overflow-hidden',
      'w-[200px] transition-[opacity,transform,background,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]',
      glassMuted && "glass-sidebar-muted"
    )}>
      <span
        ref={activeIndicatorRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-0 z-[1] rounded-lg border border-white/[0.08] bg-white/[0.065] shadow-[0_14px_34px_-26px_hsl(var(--primary)/0.65)]"
      />

      {/* Liquid glass aurora blobs */}
      <div className="sidebar-aurora" aria-hidden="true">
        <div className="sidebar-aurora-blob sidebar-aurora-blob-1" />
        <div className="sidebar-aurora-blob sidebar-aurora-blob-2" />
        <div className="sidebar-aurora-blob sidebar-aurora-blob-3" />
      </div>

      {/* Traffic light + sidebar toggle spacer; remaining area stays draggable */}
      <div className="sidebar-top-drag-region h-[52px] shrink-0 flex items-end pb-2 pr-3">
        <div data-tauri-drag-region className="h-9 flex-1 rounded-full" />
      </div>

      {/* Nav groups */}
      <nav className="relative z-10 flex-1 flex flex-col gap-4 overflow-y-auto px-3">
        {navGroupDefs.map((group, gi) => (
          <div key={gi}>
            {group.titleKey && (
              <div className="px-2.5 mb-1.5 text-[11px] font-semibold text-sidebar-foreground/40 uppercase tracking-wider">
                {t(group.titleKey)}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavButton
                  key={item.id}
                  item={item}
                  label={t(item.labelKey)}
                  isActive={activeTab === item.id}
                  onClick={() => onTabChange(item.id)}
                  onPrefetch={() => onTabPrefetch?.(item.id)}
                  buttonRef={setButtonRef(item.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom items */}
      <div className="relative z-10 flex flex-col gap-0.5 px-3 py-3 border-t border-white/[0.08]">
        {/* <PetEntry /> */}
        {bottomItemDefs.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            label={t(item.labelKey)}
            isActive={activeTab === item.id}
            onClick={() => onTabChange(item.id)}
            onPrefetch={() => onTabPrefetch?.(item.id)}
            buttonRef={setButtonRef(item.id)}
          />
        ))}
      </div>
    </aside>
  );
}
