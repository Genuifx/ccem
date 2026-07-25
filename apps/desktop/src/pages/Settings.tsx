import { useState, useEffect, useRef } from 'react';
import { Moon, Sun, MonitorSmartphone, Lightbulb, Terminal, CheckCircle2, XCircle, Copy, Shield, ShieldCheck, ShieldOff, ShieldAlert, ShieldBan, Search, FolderOpen, X, Sparkles, Clock, Image, BellRing, RefreshCw, Download, RotateCw, Palette, AppWindow, Info, Bot, Gauge } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useAppStore } from '@/store';
import { invoke } from '@tauri-apps/api/core';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { toast } from 'sonner';
import { PERMISSION_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';
import { useLocale } from '../locales';
import { SettingsSkeleton } from '@/components/ui/skeleton-states';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { setPerformancePreference as applyPerformancePreference, type PerformancePreference } from '@/lib/performance';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import { useAppUpdate } from '@/components/app-update/appUpdateContext';
import {
  exportDoctorReportAsJson,
  getPerfSummary,
  clearPerfLog,
  recordPerfMark,
  type PerfSummary,
} from '@/lib/perf-log';
import {
  runDoctorPerfSmoke,
  type DoctorPerfSmokeReport,
  type DoctorPerfSmokeRun,
} from '@/lib/doctor-perf-smoke';
import { shallow } from 'zustand/shallow';
import type { CcemAgentSkillStatus, PlatformCapabilities } from '@/lib/tauri-ipc';

const MODE_DISPLAY_NAMES: Record<PermissionModeName, string> = {
  yolo: 'YOLO',
  dev: 'Developer',
  readonly: 'Read Only',
  safe: 'Safe',
  ci: 'CI / CD',
  audit: 'Audit',
};

function getModeIcon(mode: PermissionModeName): typeof Shield {
  const iconMap: Record<PermissionModeName, typeof Shield> = {
    yolo: ShieldOff,
    dev: ShieldCheck,
    readonly: ShieldBan,
    safe: ShieldAlert,
    ci: ShieldCheck,
    audit: Search,
  };
  return iconMap[mode] || Shield;
}

interface InstallStatusState {
  ccem: boolean | null;
  claude: boolean | null;
  codex: boolean | null;
  opencode: boolean | null;
  tmux: boolean | null;
}

type SectionId = 'appearance' | 'application' | 'notifications' | 'agentSkill' | 'ai' | 'permission' | 'about';

const CCEM_REPO_URL = 'https://github.com/Genuifx/claude-code-env-manager';

function normalizePerformanceMode(value: unknown): PerformancePreference {
  if (value === 'default' || value === 'reduced' || value === 'auto') {
    return value;
  }

  return 'auto';
}

function formatMessage(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.split(`{${key}}`).join(value),
    template
  );
}

export function Settings() {
  const { defaultMode, setDefaultMode, setPermissionMode, isLoadingSettings, defaultWorkingDir, environments } = useAppStore(
    (state) => ({
      defaultMode: state.defaultMode,
      setDefaultMode: state.setDefaultMode,
      setPermissionMode: state.setPermissionMode,
      isLoadingSettings: state.isLoadingSettings,
      defaultWorkingDir: state.defaultWorkingDir,
      environments: state.environments,
    }),
    shallow
  );
  const { t, lang, setLang } = useLocale();
  const {
    openDirectoryPicker,
    saveDefaultWorkingDir,
  } = useTauriCommands();
  const {
    state: updateState,
    checkForUpdate,
    downloadUpdate,
    restartForUpdate,
  } = useAppUpdate();
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const [performanceMode, setPerformanceMode] = useState<PerformancePreference>('auto');
  const [autoStart, setAutoStart] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);
  const [desktopPetEnabled, setDesktopPetEnabled] = useState(false);
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useState(true);
  const [notifyOnTaskCompleted, setNotifyOnTaskCompleted] = useState(true);
  const [notifyOnTaskFailed, setNotifyOnTaskFailed] = useState(true);
  const [notifyOnActionRequired, setNotifyOnActionRequired] = useState(true);
  const [installStatus, setInstallStatus] = useState<InstallStatusState>({
    ccem: null,
    claude: null,
    codex: null,
    opencode: null,
    tmux: null,
  });
  const [aiEnhanced, setAiEnhanced] = useState(false);
  const [aiEnvName, setAiEnvName] = useState<string | null>(null);
  const [webkitVersion, setWebkitVersion] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilities | null>(null);
  const [agentSkillStatus, setAgentSkillStatus] = useState<CcemAgentSkillStatus | null>(null);
  const [isAgentSkillLoading, setIsAgentSkillLoading] = useState(true);
  const [isAgentSkillInstalling, setIsAgentSkillInstalling] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>('appearance');
  const loaded = useRef(false);
  const updateStatus = updateState.status;
  const updateInfo = updateState.updateInfo;
  const updateError = updateState.error;
  const tmuxSupported = platformCapabilities?.tmuxSupported !== false;
  const tmuxInstallCommand = platformCapabilities?.tmuxInstallCommand ?? null;

  // Load CLI install status in parallel so the About card updates once.
  useEffect(() => {
    let cancelled = false;

    const loadInstallStatus = async () => {
      const [ccem, claude, codex, opencode, platform] = await Promise.allSettled([
        invoke<boolean>('check_ccem_installed'),
        invoke<boolean>('check_claude_installed'),
        invoke<boolean>('check_codex_installed'),
        invoke<boolean>('check_opencode_installed'),
        invoke<PlatformCapabilities>('get_platform_capabilities'),
      ]);
      const nextPlatformCapabilities = platform.status === 'fulfilled' ? platform.value : null;

      if (cancelled) {
        return;
      }

      setPlatformCapabilities(nextPlatformCapabilities);
      setInstallStatus({
        ccem: ccem.status === 'fulfilled' ? ccem.value : false,
        claude: claude.status === 'fulfilled' ? claude.value : false,
        codex: codex.status === 'fulfilled' ? codex.value : false,
        opencode: opencode.status === 'fulfilled' ? opencode.value : false,
        tmux: nextPlatformCapabilities?.tmuxSupported === false
          ? null
          : nextPlatformCapabilities?.tmuxInstalled ?? false,
      });
    };

    const cancelDeferredLoad = scheduleAfterFirstPaint(() => {
      void loadInstallStatus();
    }, { delayMs: 180, timeoutMs: 1200 });

    return () => {
      cancelled = true;
      cancelDeferredLoad();
    };
  }, []);

  // Surface runtime WebKit version for desktop debugging.
  useEffect(() => {
    const match = navigator.userAgent.match(/AppleWebKit\/([\d.]+)/i);
    setWebkitVersion(match?.[1] ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadAppVersion = async () => {
      try {
        const version = await invoke<string>('get_app_version');
        if (!cancelled) {
          setAppVersion(version);
        }
      } catch {
        if (!cancelled) {
          setAppVersion(null);
        }
      }
    };

    void loadAppVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadAgentSkillStatus = async () => {
      setIsAgentSkillLoading(true);
      try {
        const status = await invoke<CcemAgentSkillStatus>('get_ccem_agent_skill_status');
        if (!cancelled) {
          setAgentSkillStatus(status);
        }
      } catch {
        if (!cancelled) {
          setAgentSkillStatus(null);
        }
      } finally {
        if (!cancelled) {
          setIsAgentSkillLoading(false);
        }
      }
    };

    void loadAgentSkillStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await invoke<{
          theme: string;
          autoStart: boolean;
          startMinimized: boolean;
          closeToTray: boolean;
          desktopPetEnabled?: boolean;
          desktopNotificationsEnabled?: boolean;
          notifyOnTaskCompleted?: boolean;
          notifyOnTaskFailed?: boolean;
          notifyOnActionRequired?: boolean;
          defaultMode: string | null;
          performanceMode?: PerformancePreference;
          aiEnhanced: boolean;
          aiEnvName: string | null;
        }>('get_settings');
        const nextPerformanceMode = normalizePerformanceMode(settings.performanceMode);
        setTheme(settings.theme as 'light' | 'dark' | 'system');
        setPerformanceMode(nextPerformanceMode);
        setAutoStart(settings.autoStart);
        setStartMinimized(settings.startMinimized);
        setCloseToTray(settings.closeToTray);
        setDesktopPetEnabled(settings.desktopPetEnabled ?? false);
        setDesktopNotificationsEnabled(settings.desktopNotificationsEnabled ?? true);
        setNotifyOnTaskCompleted(settings.notifyOnTaskCompleted ?? true);
        setNotifyOnTaskFailed(settings.notifyOnTaskFailed ?? true);
        setNotifyOnActionRequired(settings.notifyOnActionRequired ?? true);
        setAiEnhanced(settings.aiEnhanced ?? false);
        setAiEnvName(settings.aiEnvName ?? null);
        applyPerformancePreference(nextPerformanceMode);
        localStorage.setItem('ccem-settings', JSON.stringify({
          ...settings,
          performanceMode: nextPerformanceMode,
        }));
        if (settings.defaultMode) {
          setDefaultMode(settings.defaultMode as PermissionModeName);
          setPermissionMode(settings.defaultMode as PermissionModeName);
        }
      } catch {
        // Fallback: load from localStorage
        const saved = localStorage.getItem('ccem-settings');
        if (saved) {
          try {
            const settings = JSON.parse(saved);
            setTheme(settings.theme || 'system');
            const nextPerformanceMode = normalizePerformanceMode(settings.performanceMode);
            setPerformanceMode(nextPerformanceMode);
            setAutoStart(settings.autoStart ?? false);
            setStartMinimized(settings.startMinimized ?? false);
            setCloseToTray(settings.closeToTray ?? true);
            setDesktopPetEnabled(Boolean(settings.desktopPetEnabled));
            setDesktopNotificationsEnabled(settings.desktopNotificationsEnabled ?? true);
            setNotifyOnTaskCompleted(settings.notifyOnTaskCompleted ?? true);
            setNotifyOnTaskFailed(settings.notifyOnTaskFailed ?? true);
            setNotifyOnActionRequired(settings.notifyOnActionRequired ?? true);
            applyPerformancePreference(nextPerformanceMode);
            if (settings.defaultMode) {
              setDefaultMode(settings.defaultMode as PermissionModeName);
            }
          } catch { /* ignore parse errors */ }
        }
      }
      loaded.current = true;
    };
    loadSettings();
  }, []);

  // Apply theme to DOM
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.remove('light');
    } else if (theme === 'light') {
      root.classList.add('light');
    } else {
      // system
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) {
        root.classList.remove('light');
      } else {
        root.classList.add('light');
      }
    }
  }, [theme]);

  useEffect(() => {
    applyPerformancePreference(performanceMode);
  }, [performanceMode]);

  const handleOpenExternal = (url: string) => {
    openExternal(url).catch((error) => {
      toast.error(formatMessage(t('settings.openExternalFailed'), { error: String(error) }));
    });
  };

  const handleCheckUpdate = async () => {
    await checkForUpdate();
  };

  const handleInstallUpdate = async () => {
    await downloadUpdate();
  };

  const handleRestartForUpdate = async () => {
    await restartForUpdate();
  };

  const handleInstallAgentSkill = async () => {
    setIsAgentSkillInstalling(true);
    try {
      const status = await invoke<CcemAgentSkillStatus>('install_ccem_agent_skill');
      setAgentSkillStatus(status);
      toast.success(t('settings.agentSkillInstallSuccess'));
    } catch (error) {
      toast.error(formatMessage(t('settings.agentSkillInstallFailed'), { error: String(error) }));
    } finally {
      setIsAgentSkillInstalling(false);
      setIsAgentSkillLoading(false);
    }
  };

  // Auto-save whenever settings change (skip initial load)
  useEffect(() => {
    if (!loaded.current) return;
    const settings = {
      theme,
      autoStart,
      startMinimized,
      closeToTray,
      desktopPetEnabled,
      desktopNotificationsEnabled,
      notifyOnTaskCompleted,
      notifyOnTaskFailed,
      notifyOnActionRequired,
      defaultMode,
      performanceMode,
      aiEnhanced,
      aiEnvName,
    };
    localStorage.setItem('ccem-settings', JSON.stringify(settings));
    (async () => {
      try {
        await invoke('save_settings', { settings });
      } catch (e) {
        toast.error(t('settings.saveFailed'));
      }
    })();
  }, [
    theme,
    autoStart,
    startMinimized,
    closeToTray,
    desktopPetEnabled,
    desktopNotificationsEnabled,
    notifyOnTaskCompleted,
    notifyOnTaskFailed,
    notifyOnActionRequired,
    defaultMode,
    performanceMode,
    aiEnhanced,
    aiEnvName,
    t,
  ]);

  // Delayed skeleton -- only shows if settings load takes >200ms
  if (isLoadingSettings) {
    return <SettingsSkeleton />;
  }

  const themeOptions: { key: 'light' | 'dark' | 'system'; icon: typeof Moon; label: string }[] = [
    { key: 'light', icon: Sun, label: t('settings.light') },
    { key: 'dark', icon: Moon, label: t('settings.dark') },
    { key: 'system', icon: MonitorSmartphone, label: t('settings.system') },
  ];

  const sections: { id: SectionId; icon: typeof Palette; label: string }[] = [
    { id: 'appearance', icon: Palette, label: t('settings.appearance') },
    { id: 'application', icon: AppWindow, label: t('settings.application') },
    { id: 'notifications', icon: BellRing, label: t('settings.notifications') },
    { id: 'agentSkill', icon: Bot, label: t('settings.agentSkill') },
    { id: 'ai', icon: Sparkles, label: t('settings.aiEnhancement') },
    { id: 'permission', icon: Shield, label: t('settings.defaultPermission') },
    { id: 'about', icon: Info, label: t('settings.about') },
  ];

  const activeSectionLabel = sections.find((s) => s.id === activeSection)?.label ?? '';

  const renderAppearanceSection = () => (
    <div className="space-y-5">
      {/* Theme */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('settings.theme')}
        </label>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-border-subtle bg-muted/30">
          {themeOptions.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setTheme(key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-all duration-150 active:scale-[0.97] ${
                theme === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border-subtle" />

      {/* Language */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          {t('settings.language') || '语言 / Language'}
        </label>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-border-subtle bg-muted/30">
          <button
            onClick={() => setLang('zh')}
            className={`px-3 py-1.5 rounded-md text-sm transition-all duration-150 active:scale-[0.97] ${
              lang === 'zh'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            中文
          </button>
          <button
            onClick={() => setLang('en')}
            className={`px-3 py-1.5 rounded-md text-sm transition-all duration-150 active:scale-[0.97] ${
              lang === 'en'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            English
          </button>
        </div>
      </div>

      <div className="border-t border-border-subtle" />

      {/* Performance Mode */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          {t('settings.performanceMode')}
        </label>
        <p className="text-sm text-muted-foreground mb-2">
          {t('settings.performanceModeDesc')}
        </p>
        <Select
          value={performanceMode}
          onValueChange={(value) => setPerformanceMode(value as PerformancePreference)}
        >
          <SelectTrigger className="w-full max-w-xs h-9 rounded-lg border border-border-subtle text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('settings.performanceModeAuto')}</SelectItem>
            <SelectItem value="reduced">{t('settings.performanceModeReduced')}</SelectItem>
            <SelectItem value="default">{t('settings.performanceModeDefault')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  const renderApplicationSection = () => (
    <div className="space-y-5">
      <ToggleSetting
        checked={autoStart}
        onChange={setAutoStart}
        title={t('settings.autoStart')}
        description={t('settings.autoStartDesc')}
      />
      <div className="border-t border-border-subtle" />
      <ToggleSetting
        checked={startMinimized}
        onChange={setStartMinimized}
        title={t('settings.startMinimized')}
        description={t('settings.startMinimizedDesc')}
      />
      <div className="border-t border-border-subtle" />
      <ToggleSetting
        checked={closeToTray}
        onChange={setCloseToTray}
        title={t('settings.closeToTray')}
        description={t('settings.closeToTrayDesc')}
      />
      <div className="border-t border-border-subtle" />
      <ToggleSetting
        checked={desktopPetEnabled}
        onChange={setDesktopPetEnabled}
        title={t('settings.desktopPetEnabled')}
        description={t('settings.desktopPetEnabledDesc')}
      />
    </div>
  );

  const renderNotificationsSection = () => (
    <div className="space-y-5">
      <ToggleSetting
        checked={desktopNotificationsEnabled}
        onChange={setDesktopNotificationsEnabled}
        title={t('settings.desktopNotificationsEnabled')}
        description={t('settings.desktopNotificationsEnabledDesc')}
      />

      <div className="border-t border-border-subtle" />

      <div className={`space-y-5 transition-opacity duration-150 ${desktopNotificationsEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <ToggleSetting
          checked={notifyOnTaskCompleted}
          onChange={setNotifyOnTaskCompleted}
          title={t('settings.notifyOnTaskCompleted')}
          description={t('settings.notifyOnTaskCompletedDesc')}
        />
        <div className="border-t border-border-subtle" />
        <ToggleSetting
          checked={notifyOnTaskFailed}
          onChange={setNotifyOnTaskFailed}
          title={t('settings.notifyOnTaskFailed')}
          description={t('settings.notifyOnTaskFailedDesc')}
        />
        <div className="border-t border-border-subtle" />
        <ToggleSetting
          checked={notifyOnActionRequired}
          onChange={setNotifyOnActionRequired}
          title={t('settings.notifyOnActionRequired')}
          description={t('settings.notifyOnActionRequiredDesc')}
        />
      </div>

      <div className="border-t border-border-subtle" />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="active:scale-[0.97] transition-transform"
          onClick={async () => {
            try {
              await invoke('send_test_notification');
              toast.success(t('settings.notificationTestSent'));
            } catch (error) {
              toast.error(t('settings.notificationTestFailed').replace('{error}', String(error)));
            }
          }}
        >
          <BellRing className="w-3.5 h-3.5 mr-1.5" />
          {t('settings.notificationTest')}
        </Button>
        <p className="text-sm text-muted-foreground">
          {t('settings.notificationHint')}
        </p>
      </div>
    </div>
  );

  const renderAgentSkillSection = () => {
    const overallState = isAgentSkillLoading
      ? 'loading'
      : agentSkillStatus?.upToDate
        ? 'current'
        : agentSkillStatus?.installed
          ? 'update'
          : 'missing';
    const installLabel = isAgentSkillInstalling
      ? t('settings.agentSkillInstalling')
      : agentSkillStatus?.upToDate
        ? t('settings.agentSkillReinstall')
        : agentSkillStatus?.installed
          ? t('settings.agentSkillUpdate')
          : t('settings.agentSkillInstall');

    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{t('settings.agentSkillTitle')}</div>
            <div className="text-sm text-muted-foreground mt-0.5">{t('settings.agentSkillDesc')}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <AgentSkillStatusBadge state={overallState} />
            <Button
              variant="outline"
              size="sm"
              className="active:scale-[0.97] transition-transform"
              disabled={isAgentSkillInstalling || isAgentSkillLoading}
              onClick={handleInstallAgentSkill}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isAgentSkillInstalling ? 'animate-spin' : ''}`} />
              {installLabel}
            </Button>
          </div>
        </div>

        <div className="border-t border-border-subtle" />

        <div className="space-y-3">
          {(agentSkillStatus?.targets ?? []).map((target) => {
            const targetState = target.upToDate ? 'current' : target.installed ? 'update' : 'missing';
            return (
              <div key={target.agent} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{target.agent}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">{target.path}</div>
                </div>
                <AgentSkillStatusBadge state={targetState} />
              </div>
            );
          })}
          {!isAgentSkillLoading && !agentSkillStatus && (
            <div className="text-sm text-muted-foreground">{t('settings.agentSkillStatusUnavailable')}</div>
          )}
        </div>
      </div>
    );
  };

  const renderAiSection = () => (
    <div className="space-y-5">
      {/* Default Working Directory */}
      <div>
        <div className="text-sm font-medium text-foreground">{t('settings.defaultWorkingDir')}</div>
        <div className="text-sm text-muted-foreground mt-0.5 mb-2">{t('settings.defaultWorkingDirDesc')}</div>
        {defaultWorkingDir ? (
          <div className="flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="text-sm font-mono text-foreground truncate flex-1">{defaultWorkingDir}</span>
            <Button
              variant="outline"
              size="sm"
              className="active:scale-[0.97] transition-transform h-7 text-xs"
              onClick={async () => {
                const path = await openDirectoryPicker();
                if (path) await saveDefaultWorkingDir(path);
              }}
            >
              {t('workspace.changeDir')}
            </Button>
            <button
              onClick={() => saveDefaultWorkingDir(null)}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="active:scale-[0.97] transition-transform"
            onClick={async () => {
              const path = await openDirectoryPicker();
              if (path) await saveDefaultWorkingDir(path);
            }}
          >
            <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
            {t('settings.selectDir')}
          </Button>
        )}
      </div>

      <div className="border-t border-border-subtle" />

      <ToggleSetting
        checked={aiEnhanced}
        onChange={setAiEnhanced}
        title={t('settings.aiEnhancementToggle')}
        description={t('settings.aiEnhancementToggleDesc')}
      />

      <div className="border-t border-border-subtle" />

      <div className={`space-y-5 transition-opacity duration-150 ${aiEnhanced ? '' : 'opacity-50 pointer-events-none'}`}>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('settings.aiEnhancementEnv')}
          </label>
          <p className="text-sm text-muted-foreground mb-2">{t('settings.aiEnhancementEnvDesc')}</p>
          <Select value={aiEnvName ?? '__default__'} onValueChange={(v) => setAiEnvName(v === '__default__' ? null : v)}>
            <SelectTrigger className="w-full max-w-xs h-9 rounded-lg border border-border-subtle text-sm">
              <SelectValue placeholder={t('settings.aiEnhancementEnvPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{t('settings.aiEnhancementEnvPlaceholder')}</SelectItem>
              {environments.map((env) => (
                <SelectItem key={env.name} value={env.name}>{env.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="border-t border-border-subtle" />

        <div>
          <p className="text-sm text-muted-foreground mb-2">{t('settings.aiEnhancementFeatures')}</p>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Search className="w-3.5 h-3.5 text-primary shrink-0" />
              {t('settings.aiEnhancementFeatureSkill')}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
              {t('settings.aiEnhancementFeatureCron')}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Image className="w-3.5 h-3.5 text-primary shrink-0" />
              {t('settings.aiEnhancementFeaturePoster')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderPermissionSection = () => (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <Lightbulb className="w-3.5 h-3.5 text-primary shrink-0" />
        {t('settings.defaultPermissionHint')}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {Object.entries(PERMISSION_PRESETS).map(([key]) => {
          const mode = key as PermissionModeName;
          const isActive = (defaultMode || 'dev') === mode;
          const ModeIcon = getModeIcon(mode);
          const displayName = MODE_DISPLAY_NAMES[mode] || key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => { setDefaultMode(mode); setPermissionMode(mode); }}
              className={`text-left p-3.5 rounded-lg cursor-pointer border transition-all duration-150 active:scale-[0.97] ${
                isActive
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                  : 'border-border-subtle hover:border-border hover:bg-muted/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <ModeIcon className={`w-3.5 h-3.5 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className={`text-sm font-semibold ${isActive ? 'text-primary' : 'text-foreground'}`}>
                  {displayName}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/60 ml-auto">
                  {key}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">
                {t(`environments.permMode_${key}_desc`)}
              </p>
              {isActive && (
                <p className="text-xs text-muted-foreground/80 leading-relaxed border-t border-border-subtle pt-2 mt-2">
                  {t(`environments.permMode_${key}_detail`)}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderAboutSection = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('settings.version')}
        </span>
        <span className="text-sm font-medium text-foreground">
          {appVersion ? `v${appVersion}` : t('settings.notAvailable')}
        </span>
      </div>
      <div className="border-t border-border-subtle" />
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('settings.webkitVersion')}
        </span>
        <span className="text-sm font-medium text-foreground font-mono">
          {webkitVersion ?? t('settings.notAvailable')}
        </span>
      </div>
      <div className="border-t border-border-subtle" />
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5" />
          {t('settings.cliStatus')}
        </span>
        <InstallStatusBadge status={installStatus.ccem} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('settings.claudeCodeStatus')}
        </span>
        <InstallStatusBadge status={installStatus.claude} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('settings.codexStatus')}
        </span>
        <InstallStatusBadge status={installStatus.codex} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('settings.opencodeStatus')}
        </span>
        <InstallStatusBadge status={installStatus.opencode} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('settings.tmuxStatus')}
        </span>
        <InstallStatusBadge
          status={installStatus.tmux}
          unsupported={platformCapabilities?.tmuxSupported === false}
        />
      </div>
      {installStatus.ccem === false && (
        <>
          <div className="border-t border-border-subtle" />
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                navigator.clipboard.writeText(t('settings.cliInstallCmd'));
                toast.success(t('settings.cliInstallCmd'));
              }}
              className="inline-flex items-center gap-1 text-xs font-mono text-primary hover:text-primary/80 border border-border-subtle px-2 py-1 rounded-md active:scale-[0.97] transition-all"
            >
              <Copy className="w-3 h-3" />
              {t('settings.cliInstallCmd')}
            </button>
          </div>
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Lightbulb className="w-3 h-3 text-primary shrink-0" />
            {t('settings.cliInstallHint')}
          </p>
        </>
      )}
      {tmuxSupported && installStatus.tmux === false && (
        <>
          <div className="border-t border-border-subtle" />
          {tmuxInstallCommand && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(tmuxInstallCommand);
                  toast.success(tmuxInstallCommand);
                }}
                className="inline-flex items-center gap-1 text-xs font-mono text-primary hover:text-primary/80 border border-border-subtle px-2 py-1 rounded-md active:scale-[0.97] transition-all"
              >
                <Copy className="w-3 h-3" />
                {tmuxInstallCommand}
              </button>
            </div>
          )}
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Lightbulb className="w-3 h-3 text-primary shrink-0" />
            {t('settings.tmuxInstallHint')}
          </p>
        </>
      )}
      {updateInfo && (
        <>
          <div className="border-t border-border-subtle" />
          <div className="rounded-lg border border-border-subtle px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {formatMessage(t('settings.updateAvailable'), { version: updateInfo.version })}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {updateInfo.channel === 'beta' ? t('settings.updateChannelBeta') : t('settings.updateChannelStable')}
                <span className="mx-1">·</span>
                <span className="font-mono">{updateInfo.releaseTag}</span>
              </p>
            </div>
            {updateStatus === 'ready' ? (
              <Button variant="outline" size="sm" className="active:scale-[0.97] transition-transform shrink-0" onClick={handleRestartForUpdate}>
                <RotateCw className="w-3.5 h-3.5 mr-1.5" />
                {t('settings.restartToUpdate')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="active:scale-[0.97] transition-transform shrink-0"
                disabled={updateStatus === 'downloading'}
                onClick={handleInstallUpdate}
              >
                <Download className="w-3.5 h-3.5 mr-1.5" />
                {updateStatus === 'downloading' ? t('settings.updateDownloading') : t('settings.downloadUpdate')}
              </Button>
            )}
          </div>
        </>
      )}
      {updateError && (
        <p className="text-xs text-destructive">
          {updateError}
        </p>
      )}
      <div className="border-t border-border-subtle" />
      <DiagnosticsPanel active={activeSection === 'about'} />
      <div className="border-t border-border-subtle" />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="active:scale-[0.97] transition-transform"
          disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
          onClick={handleCheckUpdate}
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${updateStatus === 'checking' ? 'animate-spin' : ''}`} />
          {updateStatus === 'checking' ? t('settings.checkingUpdate') : t('settings.checkUpdate')}
        </Button>
        <Button variant="outline" size="sm" className="active:scale-[0.97] transition-transform" onClick={() => handleOpenExternal(updateInfo?.releaseUrl ?? CCEM_REPO_URL)}>
          GitHub
        </Button>
        <Button variant="outline" size="sm" className="active:scale-[0.97] transition-transform" onClick={() => handleOpenExternal(`${CCEM_REPO_URL}/issues`)}>
          {t('settings.feedback')}
        </Button>
      </div>
    </div>
  );

  const renderSectionContent = () => {
    switch (activeSection) {
      case 'appearance':
        return renderAppearanceSection();
      case 'application':
        return renderApplicationSection();
      case 'notifications':
        return renderNotificationsSection();
      case 'agentSkill':
        return renderAgentSkillSection();
      case 'ai':
        return renderAiSection();
      case 'permission':
        return renderPermissionSection();
      case 'about':
        return renderAboutSection();
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full">
      {/* Left Navigation */}
      <nav className="w-52 shrink-0 border-r border-border-subtle bg-surface-sunken/50 p-3 space-y-0.5">
        {sections.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors duration-100 ${
                isActive
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Right Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <h2 className="text-xl font-semibold text-foreground tracking-tight mb-6">
          {activeSectionLabel}
        </h2>
        {renderSectionContent()}
      </div>
    </div>
  );
}

function InstallStatusBadge({ status, unsupported = false }: { status: boolean | null; unsupported?: boolean }) {
  const { t } = useLocale();

  if (unsupported) {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Info className="w-3.5 h-3.5" />
        {t('settings.notAvailable')}
      </span>
    );
  }

  if (status === null) {
    return <span className="text-xs text-muted-foreground">...</span>;
  }

  if (status) {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-success">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {t('settings.cliInstalled')}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
      <XCircle className="w-3.5 h-3.5" />
      {t('settings.cliNotInstalled')}
    </span>
  );
}

function AgentSkillStatusBadge({ state }: { state: 'loading' | 'current' | 'update' | 'missing' }) {
  const { t } = useLocale();

  if (state === 'loading') {
    return <span className="text-xs text-muted-foreground">...</span>;
  }

  if (state === 'current') {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-success shrink-0">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {t('settings.agentSkillCurrent')}
      </span>
    );
  }

  if (state === 'update') {
    return (
      <span className="flex items-center gap-1.5 text-sm font-medium text-primary shrink-0">
        <RefreshCw className="w-3.5 h-3.5" />
        {t('settings.agentSkillUpdateAvailable')}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground shrink-0">
      <XCircle className="w-3.5 h-3.5" />
      {t('settings.agentSkillMissing')}
    </span>
  );
}

function DiagnosticsPanel({ active }: { active: boolean }) {
  const { t } = useLocale();
  const [summary, setSummary] = useState<PerfSummary>(() => getPerfSummary());
  const [perfSmoke, setPerfSmoke] = useState<DoctorPerfSmokeReport | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isRunningSmoke, setIsRunningSmoke] = useState(false);

  // Auto-refresh while the About section is visible so the user can see
  // events accumulate without manually clicking Refresh.
  useEffect(() => {
    if (!active) return;
    setSummary(getPerfSummary());
    const id = window.setInterval(() => {
      setSummary(getPerfSummary());
    }, 3000);
    return () => {
      window.clearInterval(id);
    };
  }, [active]);

  const handleExport = async () => {
    setIsExporting(true);
    recordPerfMark('doctor:export-start');

    try {
      let backendReport: unknown;
      let backendError: string | undefined;

      try {
        backendReport = await invoke<unknown>('collect_doctor_report');
      } catch (error) {
        backendError = String(error);
      }

      const json = exportDoctorReportAsJson({
        backend: backendReport,
        backendError,
        perfSmoke: perfSmoke ?? undefined,
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const saved = await invoke<boolean>('save_file_dialog', {
        content: json,
        defaultName: `ccem-doctor-${stamp}.json`,
      });

      if (saved) {
        recordPerfMark('doctor:exported', backendError ? { backendError } : undefined);
        toast.success(t('settings.diagnosticsExported'));
      }
    } catch (error) {
      toast.error(t('settings.diagnosticsExportFailed').replace('{error}', String(error)));
    } finally {
      setIsExporting(false);
    }
  };

  const handleRunPerfSmoke = async () => {
    setIsRunningSmoke(true);
    recordPerfMark('doctor:perf-smoke-start');

    try {
      const report = await runDoctorPerfSmoke({
        invoke,
        perfSummary: getPerfSummary(),
      });
      setPerfSmoke(report);
      setSummary(getPerfSummary());
      recordPerfMark('doctor:perf-smoke-finished', {
        verdict: report.verdict,
        totalDurationMs: report.totalDurationMs,
      });

      if (report.verdict === 'pass') {
        toast.success(t('settings.diagnosticsPerfSmokePassed'));
      } else {
        toast.error(t('settings.diagnosticsPerfSmokeFailed'));
      }
    } catch (error) {
      toast.error(t('settings.diagnosticsPerfSmokeError').replace('{error}', String(error)));
    } finally {
      setIsRunningSmoke(false);
    }
  };

  const handleClear = () => {
    clearPerfLog();
    setSummary(getPerfSummary());
    toast.success(t('settings.diagnosticsCleared'));
  };

  const formatDuration = (value: number | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return `${Math.round(value)}ms`;
  };

  const rows: { type: keyof PerfSummary; label: string }[] = [
    { type: 'longtask', label: t('settings.diagnosticsLongtask') },
    { type: 'ipc', label: t('settings.diagnosticsIpcSlow') },
    { type: 'ipc-error', label: t('settings.diagnosticsIpcError') },
    { type: 'frame-drop', label: t('settings.diagnosticsFrameDrop') },
    { type: 'lcp', label: t('settings.diagnosticsLcp') },
    { type: 'error', label: t('settings.diagnosticsError') },
  ];

  const smokeRunLabels: Record<DoctorPerfSmokeRun['name'], string> = {
    workspaceOverview: t('settings.diagnosticsPerfSmokeWorkspaceOverview'),
    runtimeDecorations: t('settings.diagnosticsPerfSmokeRuntimeDecorations'),
    historySearch: t('settings.diagnosticsPerfSmokeHistorySearch'),
    conversationDetail: t('settings.diagnosticsPerfSmokeConversationDetail'),
    frontendLongTask: t('settings.diagnosticsPerfSmokeFrontendLongTask'),
  };

  const smokeStatusLabel = (status: DoctorPerfSmokeRun['status']) => {
    if (status === 'pass') return t('settings.diagnosticsPerfSmokeStatusPass');
    if (status === 'fail') return t('settings.diagnosticsPerfSmokeStatusFail');
    return t('settings.diagnosticsPerfSmokeStatusSkip');
  };

  const smokeStatusClass = (status: DoctorPerfSmokeRun['status']) => {
    if (status === 'pass') return 'text-emerald-600 dark:text-emerald-400';
    if (status === 'fail') return 'text-destructive';
    return 'text-muted-foreground';
  };

  const smokeVerdictLabel = isRunningSmoke
    ? t('settings.diagnosticsPerfSmokeRunning')
    : perfSmoke?.verdict === 'pass'
      ? t('settings.diagnosticsPerfSmokePassedShort')
      : perfSmoke?.verdict === 'fail'
        ? t('settings.diagnosticsPerfSmokeFailedShort')
        : t('settings.diagnosticsPerfSmokeIdle');

  const smokeVerdictClass = isRunningSmoke
    ? 'bg-primary/10 text-primary'
    : perfSmoke?.verdict === 'pass'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : perfSmoke?.verdict === 'fail'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground';

  const formatSmokeDuration = (run: DoctorPerfSmokeRun) => {
    if (run.status === 'skip') return '—';
    if (typeof run.durationMs !== 'number' || !Number.isFinite(run.durationMs)) {
      return smokeStatusLabel(run.status);
    }
    const duration = `${Math.round(run.durationMs)}ms`;
    if (typeof run.budgetMs === 'number' && Number.isFinite(run.budgetMs)) {
      return `${duration} / ${Math.round(run.budgetMs)}ms`;
    }
    return duration;
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium text-foreground">
          {t('settings.diagnosticsTitle')}
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('settings.diagnosticsDesc')}
        </p>
      </div>
      <div className="rounded-lg border border-border-subtle bg-muted/30 px-3 py-2 space-y-1.5">
        {rows.map(({ type, label }) => {
          const entry = summary[type];
          const count = entry?.count ?? 0;
          return (
            <div
              key={type}
              className="flex items-center justify-between text-xs text-muted-foreground"
            >
              <span>{label}</span>
              <span className="font-mono text-foreground tabular-nums">
                {count}
                {entry?.avgMs !== undefined && (
                  <span className="text-muted-foreground ml-2">
                    avg {formatDuration(entry.avgMs)} · max {formatDuration(entry.maxMs)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="rounded-lg border border-border-subtle bg-muted/30 px-3 py-2 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Gauge className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground truncate">
              {t('settings.diagnosticsPerfSmokeTitle')}
            </span>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium shrink-0 ${smokeVerdictClass}`}>
            {smokeVerdictLabel}
          </span>
        </div>
        {perfSmoke && (
          <div className="space-y-1.5">
            {perfSmoke.runs.map((run) => (
              <div
                key={run.name}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="text-muted-foreground truncate">
                  {smokeRunLabels[run.name]}
                </span>
                <span className="font-mono tabular-nums text-right shrink-0">
                  <span className={smokeStatusClass(run.status)}>
                    {smokeStatusLabel(run.status)}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    {formatSmokeDuration(run)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="active:scale-[0.97] transition-transform"
          disabled={isRunningSmoke || isExporting}
          onClick={handleRunPerfSmoke}
        >
          <Gauge className="w-3.5 h-3.5 mr-1.5" />
          {isRunningSmoke ? t('settings.diagnosticsPerfSmokeRunning') : t('settings.diagnosticsPerfSmokeRun')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="active:scale-[0.97] transition-transform"
          disabled={isExporting || isRunningSmoke}
          onClick={handleExport}
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          {t('settings.diagnosticsExport')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="active:scale-[0.97] transition-transform"
          onClick={handleClear}
        >
          {t('settings.diagnosticsClear')}
        </Button>
      </div>
    </div>
  );
}

function ToggleSetting({ checked, onChange, title, description }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">
          {title}
        </div>
        <div className="text-sm text-muted-foreground">
          {description}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
            checked ? 'translate-x-[22px]' : 'translate-x-[2px]'
          } mt-[2px]`}
        />
      </button>
    </div>
  );
}
