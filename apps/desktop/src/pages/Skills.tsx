import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { useLocale } from '../locales';
import { useAppStore } from '@/store';
import { SkillsSkeleton } from '@/components/ui/skeleton-states';
import { SkillCard, type DiscoverSkillInfo } from '@/components/skills/SkillCard';
import { InstallDialog } from '@/components/skills/InstallDialog';
import { EmptyState, ErrorBanner } from '@/components/ui/EmptyState';
import { useTauriEvent } from '@/hooks/useTauriEvents';
import { ccemMotion, clearMotionProps, getMotionTargets, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { toast } from 'sonner';
import {
  Search,
  Box,
  Loader2,
  Bot,
  Wrench,
  AlertTriangle,
  Settings,
  Shield,
  TrendingUp,
  Users,
} from '@/lib/lucide-react';
import { shallow } from 'zustand/shallow';

type FilterCategory = 'all' | 'official' | 'popular' | 'community' | 'installed';

interface StreamMessage {
  type: 'thinking' | 'tool' | 'result' | 'error';
  content: string;
}

interface CuratedSkill {
  name: string;
  package_id: string;
  skill_name: string;
  description: string;
  category: string;
  install_type: string;
}

const FILTERS: { key: FilterCategory; labelKey: string; icon?: typeof Shield }[] = [
  { key: 'all', labelKey: 'skills.filterAll' },
  { key: 'official', labelKey: 'skills.categoryOfficial', icon: Shield },
  { key: 'popular', labelKey: 'skills.categoryPopular', icon: TrendingUp },
  { key: 'community', labelKey: 'skills.categoryCommunity', icon: Users },
  { key: 'installed', labelKey: 'skills.filterInstalled' },
];

export function Skills() {
  const { t } = useLocale();
  const { isLoadingSkills, defaultWorkingDir, installedSkills, setInstalledSkills } = useAppStore(
    (state) => ({
      isLoadingSkills: state.isLoadingSkills,
      defaultWorkingDir: state.defaultWorkingDir,
      installedSkills: state.installedSkills,
      setInstalledSkills: state.setInstalledSkills,
    }),
    shallow
  );

  const [activeFilter, setActiveFilter] = useState<FilterCategory>('all');
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const isSearchingRef = useRef(false);
  const [streamMessages, setStreamMessages] = useState<StreamMessage[]>([]);
  const [results, setResults] = useState<DiscoverSkillInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [curatedSkills, setCuratedSkills] = useState<CuratedSkill[]>([]);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [uninstallingNames, setUninstallingNames] = useState<Set<string>>(new Set());
  const [installDialogState, setInstallDialogState] = useState<{
    open: boolean;
    packageId: string;
    skillName: string;
    displayName: string;
    installType: string;
  }>({ open: false, packageId: '', skillName: '', displayName: '', installType: 'skills' });

  const streamEndRef = useRef<HTMLDivElement>(null);
  const skillsMotionRef = useRef<HTMLDivElement>(null);
  const hasHydratedSkillsMotionRef = useRef(false);

  // Load curated skills on mount
  useEffect(() => {
    invoke<CuratedSkill[]>('get_curated_skills')
      .then(setCuratedSkills)
      .catch((err) => console.error('Failed to load curated skills:', err));
  }, []);

  const isSkillInstalled = useCallback(
    (skill: CuratedSkill | DiscoverSkillInfo) => {
      const name = 'skill_name' in skill ? skill.skill_name : skill.name;
      const displayName = 'name' in skill ? skill.name : '';
      return installedSkills.some(
        (s) =>
          s.name.toLowerCase() === (name || '').toLowerCase() ||
          s.name.toLowerCase() === displayName.toLowerCase()
      );
    },
    [installedSkills]
  );

  const scrollToBottom = useCallback(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const tryParseResults = useCallback((text: string) => {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          setResults(parsed.filter((s: any) => s.name && s.package_id));
        }
      } catch {
        // Not valid JSON yet
      }
    }
  }, []);

  // Stream event listeners
  useTauriEvent<string>('skill-search-stream', (line) => {
    if (!isSearchingRef.current) return;
    try {
      const data = JSON.parse(line);
      if (data.type === 'error') {
        setError(data.error || t('skills.searchError'));
        return;
      }
      if (data.type === 'assistant' && data.message?.content) {
        for (const block of data.message.content) {
          if (block.type === 'text' && block.text) {
            const jsonMatch = block.text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              tryParseResults(jsonMatch[0]);
            } else {
              setStreamMessages((prev) => [...prev, { type: 'thinking', content: block.text }]);
            }
          } else if (block.type === 'tool_use') {
            const cmd = block.input?.command || block.input?.pattern || '';
            const label = cmd ? `${t('skills.toolRunning')} ${cmd}` : t('skills.toolRunning');
            setStreamMessages((prev) => [...prev, { type: 'tool', content: label }]);
          }
        }
      } else if (data.type === 'content_block_delta' && data.delta?.text) {
        setStreamMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.type === 'thinking') {
            return [...prev.slice(0, -1), { ...last, content: last.content + data.delta.text }];
          }
          return [...prev, { type: 'thinking', content: data.delta.text }];
        });
      } else if (data.type === 'result') {
        const resultText = data.result || '';
        if (data.is_error) {
          setError(resultText);
        } else {
          tryParseResults(resultText);
        }
      } else if (data.type === 'system' && data.subtype === 'init') {
        setStreamMessages([{ type: 'thinking', content: t('skills.searchConnected') }]);
      }
    } catch {
      if (line.trim().startsWith('[')) {
        tryParseResults(line.trim());
      }
    }
    scrollToBottom();
  });

  useTauriEvent('skill-search-done', () => {
    if (isSearchingRef.current) {
      isSearchingRef.current = false;
      setIsSearching(false);
      setStreamMessages((prev) => {
        if (prev.length > 0) {
          return [...prev, { type: 'result' as const, content: t('skills.searchComplete') }];
        }
        return prev;
      });
    }
  });

  useTauriEvent<string>('skill-install-done', async (raw) => {
    try {
      const data = JSON.parse(raw);
      const pid = data.package_id || '';
      const skill = results.find((s) => s.package_id === pid);
      const displayName = skill?.name || pid;
      if (data.success) {
        setInstalledIds((prev) => new Set(prev).add(pid));
        toast.success(t('skills.installSuccess').replace('{name}', displayName));
        try {
          const skills = await invoke<any[]>('list_installed_skills');
          setInstalledSkills(skills);
        } catch {
          /* ignore */
        }
      } else {
        const msg = String(data.message || '');
        const clean = msg
          .replace(/\x1b\[[0-9;]*[a-zA-Z]|\[\?25[hl]|\[999D|\[J/g, '')
          .replace(/[◒◐◓◑■│┌└◇─╔╗╚╝║═█▓░▒███████╗╚══════╝]/g, '')
          .trim();
        toast.error(t('skills.installError').replace('{error}', clean || 'Installation failed'));
      }
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    } catch {
      /* malformed */
    }
  });

  useTauriEvent<string>('skill-uninstall-done', async (raw) => {
    try {
      const data = JSON.parse(raw);
      const skillName = data.name || '';
      if (data.success) {
        toast.success(t('skills.uninstallSuccess').replace('{name}', skillName));
        try {
          const skills = await invoke<any[]>('list_installed_skills');
          setInstalledSkills(skills);
        } catch {
          /* ignore */
        }
      } else {
        const msg = String(data.message || '');
        const clean = msg
          .replace(/\x1b\[[0-9;]*[a-zA-Z]|\[\?25[hl]|\[999D|\[J/g, '')
          .replace(/[◒◐◓◑■│┌└◇─╔╗╚╝║═█▓░▒███████╗╚══════╝]/g, '')
          .trim();
        toast.error(t('skills.uninstallError').replace('{error}', clean || 'Uninstall failed'));
      }
      setUninstallingNames((prev) => {
        const next = new Set(prev);
        next.delete(skillName);
        return next;
      });
    } catch {
      /* malformed */
    }
  });

  // Actions
  const handleSearch = async () => {
    if (!query.trim() || isSearching) return;
    isSearchingRef.current = true;
    setIsSearching(true);
    setStreamMessages([{ type: 'thinking', content: t('skills.searchStarting') }]);
    setResults([]);
    setError(null);
    setExpandedSkill(null);
    try {
      await invoke('search_skills_stream', { query: query.trim() });
    } catch (err) {
      setError(String(err));
      isSearchingRef.current = false;
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  const handleUninstall = (name: string) => {
    setUninstallingNames((prev) => new Set(prev).add(name));
    invoke('uninstall_skill', { name, global: true }).catch(() => {});
  };

  const openInstallDialog = (skill: DiscoverSkillInfo) => {
    setInstallDialogState({
      open: true,
      packageId: skill.package_id,
      skillName: skill.skill_name || skill.name,
      displayName: skill.name,
      installType: skill.install_type || 'skills',
    });
  };

  // Derived state
  const hasSearchContent = isSearching || results.length > 0 || streamMessages.length > 0 || error;

  const filteredCurated = curatedSkills.filter((s) => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'installed') return false;
    return s.category === activeFilter;
  });

  const groupedCurated = ['official', 'popular', 'community']
    .map((cat) => ({
      category: cat,
      skills: filteredCurated.filter((s) => s.category === cat),
    }))
    .filter((g) => g.skills.length > 0);

  const pluginSkills = installedSkills.filter((s) => s.scope === 'plugin');
  const globalSkills = installedSkills.filter((s) => s.scope === 'global');
  const projectSkills = installedSkills.filter((s) => s.scope === 'project');
  const skillsMotionKey = useMemo(() => {
    if (activeFilter === 'installed') {
      return `installed:${pluginSkills.length}:${globalSkills.length}:${projectSkills.length}`;
    }

    if (hasSearchContent) {
      const resultIds = results
        .slice(0, 12)
        .map((skill) => `${skill.package_id}/${skill.skill_name || skill.name}`)
        .join('|');
      return `search:${isSearching ? 'busy' : 'done'}:${resultIds}:${error ? 'error' : 'ok'}`;
    }

    return groupedCurated
      .map(({ category, skills }) => `${category}:${skills.length}`)
      .join('|');
  }, [
    activeFilter,
    error,
    globalSkills.length,
    groupedCurated,
    hasSearchContent,
    isSearching,
    pluginSkills.length,
    projectSkills.length,
    results,
  ]);

  useGSAP(() => {
    const root = skillsMotionRef.current;
    if (!root) {
      return;
    }

    const targets = [
      ...getMotionTargets(root, '[data-skill-motion-warning], [data-skill-motion-stream]', 2),
      ...getMotionTargets(root, '[data-skill-motion-section]', 4),
      ...getMotionTargets(root, '[data-skill-motion-card]', 12),
    ];

    if (!hasHydratedSkillsMotionRef.current) {
      hasHydratedSkillsMotionRef.current = true;
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
      { autoAlpha: 0, y: 8, scale: 0.985 },
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
  }, { scope: skillsMotionRef, dependencies: [skillsMotionKey] });

  if (isLoadingSkills) {
    return <SkillsSkeleton />;
  }

  return (
    <div ref={skillsMotionRef} className="page-transition-enter space-y-6">
      {/* Working directory warning */}
      {!defaultWorkingDir && (
        <div data-skill-motion-warning className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/15">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="text-sm text-amber-700 dark:text-amber-400 flex-1">
            {t('skills.needWorkingDir')}
          </span>
          <button
            onClick={() => emit('navigate-to-settings')}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            {t('skills.goToSettings')}
          </button>
        </div>
      )}

      {/* Search bar — Apple pill pattern */}
      <div className="relative">
        <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('skills.searchPlaceholder')}
          disabled={isSearching}
          className="w-full h-11 pl-12 pr-28 rounded-full bg-surface-raised border border-[hsl(var(--glass-border-light)/0.12)] text-foreground text-[15px] placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/20 transition-shadow disabled:opacity-60"
        />
        <button
          onClick={handleSearch}
          disabled={!query.trim() || isSearching}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-4 rounded-full bg-primary text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 active:scale-95 transition-all"
        >
          {isSearching ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            t('skills.search')
          )}
        </button>
      </div>

      {/* Search hint */}
      {!hasSearchContent && (
        <p className="text-xs text-muted-foreground/60 -mt-2 pl-5">
          {t('skills.searchHint')}
        </p>
      )}

      {/* Filter chips — Apple configurator-option-chip pattern */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mt-1">
        {FILTERS.map(({ key, labelKey, icon: Icon }) => {
          const isActive = activeFilter === key;
          return (
            <button
              key={key}
              onClick={() => {
                setActiveFilter(key);
                setExpandedSkill(null);
              }}
              className={`
                inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap
                transition-all active:scale-95
                ${isActive
                  ? 'bg-surface-raised border-2 border-primary text-foreground shadow-sm'
                  : 'bg-surface-raised/60 border border-[hsl(var(--glass-border-light)/0.12)] text-muted-foreground hover:text-foreground hover:border-[hsl(var(--glass-border-light)/0.25)]'
                }
              `}
            >
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {t(labelKey)}
              {key === 'installed' && installedSkills.length > 0 && (
                <span className="text-xs text-muted-foreground/60">
                  {installedSkills.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Error banner */}
      {error && (
        <div data-skill-motion-stream>
          <ErrorBanner
            message={error}
            onRetry={() => {
              setError(null);
              handleSearch();
            }}
            retryLabel={t('common.retry')}
          />
        </div>
      )}

      {/* Stream output — compact inline indicator */}
      {streamMessages.length > 0 && (
        <div data-skill-motion-stream className="rounded-xl bg-surface-raised/50 border border-[hsl(var(--glass-border-light)/0.08)] p-4 max-h-36 overflow-y-auto">
          <div className="space-y-1.5 text-sm">
            {streamMessages.map((msg, i) => (
              <div key={i} className="flex items-start gap-2">
                {msg.type === 'thinking' && (
                  <>
                    <Bot className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
                    <span className="text-muted-foreground/80 whitespace-pre-wrap line-clamp-2">
                      {msg.content}
                    </span>
                  </>
                )}
                {msg.type === 'tool' && (
                  <>
                    <Wrench className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" />
                    <span className="text-muted-foreground/70">{msg.content}</span>
                  </>
                )}
                {msg.type === 'result' && (
                  <>
                    <Box className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
                    <span className="text-emerald-600 dark:text-emerald-400">{msg.content}</span>
                  </>
                )}
              </div>
            ))}
            <div ref={streamEndRef} />
          </div>
        </div>
      )}

      {/* Main content area */}
      {activeFilter === 'installed' ? (
        <InstalledView
          pluginSkills={pluginSkills}
          globalSkills={globalSkills}
          projectSkills={projectSkills}
          expandedSkill={expandedSkill}
          setExpandedSkill={setExpandedSkill}
          uninstallingNames={uninstallingNames}
          onUninstall={handleUninstall}
          t={t}
        />
      ) : hasSearchContent && results.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {results.map((skill) => {
            const expandKey = `${skill.package_id}/${skill.skill_name || skill.name}`;
            return (
              <SkillCard
                key={expandKey}
                variant="discover"
                skill={skill}
                isInstalled={installedIds.has(skill.package_id) || isSkillInstalled(skill)}
                isInstalling={installingIds.has(skill.package_id)}
                isExpanded={expandedSkill === expandKey}
                onToggleExpand={() =>
                  setExpandedSkill((prev) => (prev === expandKey ? null : expandKey))
                }
                onInstall={() => openInstallDialog(skill)}
              />
            );
          })}
        </div>
      ) : !hasSearchContent ? (
        groupedCurated.length > 0 ? (
          <div className="space-y-8">
            {groupedCurated.map(({ category, skills }) => {
              const categoryLabels: Record<string, string> = {
                official: t('skills.categoryOfficial'),
                popular: t('skills.categoryPopular'),
                community: t('skills.categoryCommunity'),
              };
              return (
                <section key={category} data-skill-motion-section>
                  <h2 className="text-[17px] font-semibold text-foreground tracking-tight mb-4">
                    {categoryLabels[category]}
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {skills.map((skill) => {
                      const discoverInfo: DiscoverSkillInfo = {
                        name: skill.name,
                        package_id: skill.package_id,
                        skill_name: skill.skill_name,
                        description: skill.description,
                        install_type: skill.install_type,
                      };
                      const expandKey = `${skill.package_id}/${skill.skill_name}`;
                      return (
                        <SkillCard
                          key={expandKey}
                          variant="discover"
                          skill={discoverInfo}
                          isInstalled={isSkillInstalled(skill)}
                          isInstalling={installingIds.has(skill.package_id)}
                          isExpanded={expandedSkill === expandKey}
                          onToggleExpand={() =>
                            setExpandedSkill((prev) =>
                              prev === expandKey ? null : expandKey
                            )
                          }
                          onInstall={() => openInstallDialog(discoverInfo)}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Box}
            message={t('skills.noResults')}
            action={t('skills.tryDifferent')}
            onAction={() => document.querySelector<HTMLInputElement>('input[type="text"]')?.focus()}
          />
        )
      ) : null}

      {/* Install dialog */}
      <InstallDialog
        open={installDialogState.open}
        onOpenChange={(open) => setInstallDialogState((prev) => ({ ...prev, open }))}
        packageId={installDialogState.packageId}
        skillName={installDialogState.skillName}
        displayName={installDialogState.displayName}
        installType={installDialogState.installType}
      />
    </div>
  );
}

/* Installed skills sub-view */
function InstalledView({
  pluginSkills,
  globalSkills,
  projectSkills,
  expandedSkill,
  setExpandedSkill,
  uninstallingNames,
  onUninstall,
  t,
}: {
  pluginSkills: any[];
  globalSkills: any[];
  projectSkills: any[];
  expandedSkill: string | null;
  setExpandedSkill: (id: string | null) => void;
  uninstallingNames: Set<string>;
  onUninstall: (name: string) => void;
  t: (key: string) => string;
}) {
  const allEmpty =
    pluginSkills.length === 0 && globalSkills.length === 0 && projectSkills.length === 0;

  if (allEmpty) {
    return (
      <EmptyState icon={Box} message={t('skills.noSkills')} action={t('skills.addFirstSkill')} />
    );
  }

  const renderGroup = (label: string, skills: any[]) => {
    if (skills.length === 0) return null;
    return (
      <section data-skill-motion-section>
        <h2 className="text-[17px] font-semibold text-foreground tracking-tight mb-4">{label}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {skills.map((skill: any) => (
            <SkillCard
              key={skill.path}
              variant="installed"
              skill={skill}
              isExpanded={expandedSkill === skill.name}
              onToggleExpand={() =>
                setExpandedSkill(expandedSkill === skill.name ? null : skill.name)
              }
              isUninstalling={uninstallingNames.has(skill.name)}
              onUninstall={() => onUninstall(skill.name)}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-8">
      {renderGroup(t('skills.scopePlugin'), pluginSkills)}
      {renderGroup(t('skills.scopeGlobal'), globalSkills)}
      {renderGroup(t('skills.scopeProject'), projectSkills)}
    </div>
  );
}
