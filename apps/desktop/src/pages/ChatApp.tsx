import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from '@/lib/lucide-react';
import { useLocale } from '@/locales';
import { TelegramPanel } from '@/components/chat-app/telegram/TelegramPanel';
import { WecomPanel } from '@/components/chat-app/wecom/WecomPanel';
import { WeixinPanel } from '@/components/chat-app/weixin/WeixinPanel';
import { getRemotePlatformMeta, REMOTE_PLATFORM_ORDER, type RemotePlatformId } from '@/lib/remote-platforms';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import type { PlatformCapabilities } from '@/lib/tauri-ipc';
import { ccemMotion, clearMotionProps, getMotionTargets, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';

interface TabDef {
  id: RemotePlatformId;
  labelKey: string;
  panel: () => JSX.Element;
}

const panelByPlatform: Record<RemotePlatformId, () => JSX.Element> = {
  telegram: () => <TelegramPanel />,
  weixin: () => <WeixinPanel />,
  wecom: () => <WecomPanel />,
};

const tabs: TabDef[] = REMOTE_PLATFORM_ORDER.map((id) => ({
  id,
  labelKey: getRemotePlatformMeta(id).labelKey,
  panel: panelByPlatform[id],
}));

export function ChatApp() {
  const { t } = useLocale();
  const [activeTab, setActiveTab] = useState(tabs[0].id);
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilities | null>(null);
  const { getPlatformCapabilities } = useTauriCommands();
  const currentTab = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const showTmuxNotice = platformCapabilities?.tmuxSupported === true && !platformCapabilities.tmuxInstalled;
  const tmuxInstallCommand = platformCapabilities?.tmuxInstallCommand ?? null;
  const chatMotionRef = useRef<HTMLDivElement>(null);
  const hasHydratedChatMotionRef = useRef(false);

  useEffect(() => {
    getPlatformCapabilities()
      .then(setPlatformCapabilities)
      .catch(() => setPlatformCapabilities(null));
  }, [getPlatformCapabilities]);

  useGSAP(() => {
    const root = chatMotionRef.current;
    if (!root) {
      return;
    }

    const activeTabButton = root.querySelector<HTMLElement>('[data-chat-platform-active="true"]');
    const targets = [
      ...(activeTabButton ? [activeTabButton] : []),
      ...getMotionTargets(root, '[data-chat-platform-warning]', 1),
      ...getMotionTargets(root, '[data-chat-platform-panel]', 1),
    ];

    if (!hasHydratedChatMotionRef.current) {
      hasHydratedChatMotionRef.current = true;
      clearMotionProps(targets);
      return;
    }

    if (targets.length === 0) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(targets);
      return;
    }

    gsap.killTweensOf(targets);
    gsap.fromTo(
      targets,
      { autoAlpha: 0, y: 6, scale: 0.99 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        stagger: 0.025,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(targets),
      },
    );
  }, { scope: chatMotionRef, dependencies: [activeTab, showTmuxNotice] });

  return (
    <div ref={chatMotionRef} className="page-transition-enter space-y-6">
      {/* tmux warning */}
      {showTmuxNotice && (
        <div data-chat-platform-warning className="rounded-2xl border border-warning/20 bg-warning/5 px-5 py-4">
          <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('chatApp.tmuxOptionalTitle')}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t('chatApp.tmuxOptionalNotice')}</p>
              {tmuxInstallCommand && (
                <p className="mt-2 font-mono text-xs text-muted-foreground/70">{tmuxInstallCommand}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Platform selector — Apple configurator-chip style */}
      <div className="flex items-center gap-1.5">
        {tabs.map((tab) => {
          const meta = getRemotePlatformMeta(tab.id);
          const Icon = meta.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              data-chat-platform-tab={tab.id}
              data-chat-platform-active={isActive ? 'true' : 'false'}
              onClick={() => setActiveTab(tab.id)}
              className={`
                inline-flex items-center gap-2 rounded-full px-4 py-2
                text-sm font-medium transition-all duration-150
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2
                ${isActive
                  ? 'bg-primary text-white shadow-sm'
                  : 'bg-black/[0.04] dark:bg-white/[0.06] text-muted-foreground hover:text-foreground hover:bg-black/[0.07] dark:hover:bg-white/[0.1]'
                }
              `}
              aria-pressed={isActive}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {/* Active panel */}
      <div data-chat-platform-panel>
        {currentTab.panel()}
      </div>
    </div>
  );
}
