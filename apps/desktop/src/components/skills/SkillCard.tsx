import { Check, ChevronDown, Download, FolderOpen, Loader2, Package, Plug, Trash2 } from '@/lib/lucide-react';
import { useLocale } from '@/locales';

export interface DiscoverSkillInfo {
  name: string;
  package_id: string;
  skill_name?: string;
  description: string;
  source?: string;
  install_type?: string;
}

interface DiscoverCardProps {
  variant: 'discover';
  skill: DiscoverSkillInfo;
  isInstalled?: boolean;
  isInstalling?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onInstall: () => void;
}

interface InstalledCardProps {
  variant: 'installed';
  skill: {
    name: string;
    description: string;
    path: string;
    scope: string;
    agents?: string[];
    source?: string;
    version?: string;
  };
  isExpanded: boolean;
  onToggleExpand: () => void;
  isUninstalling?: boolean;
  onUninstall: () => void;
}

type SkillCardProps = DiscoverCardProps | InstalledCardProps;

export function SkillCard(props: SkillCardProps) {
  if (props.variant === 'discover') {
    return <DiscoverCard {...props} />;
  }

  return <InstalledCard {...props} />;
}

function DiscoverCard({
  skill,
  isInstalled,
  isInstalling,
  isExpanded,
  onToggleExpand,
  onInstall,
}: DiscoverCardProps) {
  const { t } = useLocale();

  return (
    <div
      data-skill-motion-card
      className={`
        group rounded-2xl border bg-surface-raised transition-all duration-200
        ${isExpanded
          ? 'border-primary/20 shadow-sm'
          : 'border-[hsl(var(--glass-border-light)/0.10)] hover:border-[hsl(var(--glass-border-light)/0.22)]'
        }
      `}
    >
      {/* Card header — clickable to expand */}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        className="w-full text-left p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 rounded-2xl"
      >
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="w-9 h-9 rounded-xl bg-primary/8 flex items-center justify-center shrink-0 mt-0.5">
            <Package className="w-4.5 h-4.5 text-primary/70" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[15px] font-semibold text-foreground tracking-tight truncate">
                {skill.name}
              </span>
              {skill.source && (
                <span className="px-2 py-0.5 text-[11px] rounded-full bg-surface-raised border border-[hsl(var(--glass-border-light)/0.12)] text-muted-foreground shrink-0">
                  {skill.source}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground/80 leading-relaxed line-clamp-2">
              {skill.description}
            </p>
          </div>

          {/* Expand indicator */}
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground/40 shrink-0 mt-1 transition-transform duration-200 ${
              isExpanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {/* Expandable preview panel */}
      <div
        aria-hidden={!isExpanded}
        className={`overflow-hidden transition-all duration-200 ease-out ${
          isExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="px-5 pb-5 pt-0">
          <div className="border-t border-[hsl(var(--glass-border-light)/0.08)] pt-4 space-y-3">
            {/* Package ID */}
            {skill.package_id && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground/50">{t('skills.skillSource')}:</span>
                <code className="text-xs font-mono text-muted-foreground/70 bg-surface-sunken px-2 py-0.5 rounded">
                  {skill.package_id}
                </code>
              </div>
            )}

            {/* Usage hint */}
            <div className="rounded-lg bg-surface-sunken/50 p-3">
              <p className="text-xs text-muted-foreground/60 leading-relaxed">
                {t('skills.usageHint')}
              </p>
              <code className="block mt-1.5 text-xs font-mono text-foreground/80">
                /{skill.skill_name || skill.name}
              </code>
            </div>
          </div>
        </div>
      </div>

      {/* Action footer */}
      <div className="px-5 pb-4 flex items-center justify-end">
        {isInstalled ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground/60">
            <Check className="w-3.5 h-3.5" />
            {t('skills.installed')}
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onInstall();
            }}
            disabled={isInstalling}
            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-full bg-primary text-white text-sm font-medium hover:bg-primary/90 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isInstalling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            {isInstalling ? t('skills.installing') : t('skills.install')}
          </button>
        )}
      </div>
    </div>
  );
}

function InstalledCard({
  skill,
  isExpanded,
  onToggleExpand,
  isUninstalling,
  onUninstall,
}: InstalledCardProps) {
  const { t } = useLocale();

  const scopeLabel =
    skill.scope === 'plugin'
      ? t('skills.scopePlugin')
      : skill.scope === 'global'
        ? t('skills.scopeGlobal')
        : t('skills.scopeProject');

  return (
    <div
      data-skill-motion-card
      className={`
        group rounded-2xl border bg-surface-raised transition-all duration-200
        ${isExpanded
          ? 'border-primary/20 shadow-sm'
          : 'border-[hsl(var(--glass-border-light)/0.10)] hover:border-[hsl(var(--glass-border-light)/0.22)]'
        }
      `}
    >
      {/* Card header — clickable to expand */}
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={isExpanded}
        className="w-full text-left p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 rounded-2xl"
      >
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div className="w-9 h-9 rounded-xl bg-primary/8 flex items-center justify-center shrink-0 mt-0.5">
            {skill.scope === 'plugin' ? (
              <Plug className="w-4.5 h-4.5 text-primary/70" />
            ) : (
              <Package className="w-4.5 h-4.5 text-primary/70" />
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[15px] font-semibold text-foreground tracking-tight truncate">
                {skill.name}
              </span>
              <span className="px-2 py-0.5 text-[11px] rounded-full bg-surface-raised border border-[hsl(var(--glass-border-light)/0.12)] text-muted-foreground shrink-0">
                {scopeLabel}
              </span>
            </div>
            {skill.description && (
              <p className="text-sm text-muted-foreground/80 leading-relaxed line-clamp-2">
                {skill.description}
              </p>
            )}
          </div>

          {/* Expand indicator */}
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground/40 shrink-0 mt-1 transition-transform duration-200 ${
              isExpanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>

      {/* Expandable preview panel */}
      <div
        aria-hidden={!isExpanded}
        className={`overflow-hidden transition-all duration-200 ease-out ${
          isExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="px-5 pb-5 pt-0">
          <div className="border-t border-[hsl(var(--glass-border-light)/0.08)] pt-4 space-y-3">
            {/* Path */}
            <div className="flex items-center gap-2">
              <FolderOpen className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
              <span className="text-xs font-mono text-muted-foreground/60 truncate">
                {skill.path}
              </span>
            </div>

            {/* Agents */}
            {skill.agents && skill.agents.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground/50">{t('skills.selectAgents')}:</span>
                {skill.agents.map((agent) => (
                  <span
                    key={agent}
                    className="px-2 py-0.5 text-[11px] rounded-full bg-primary/8 text-primary font-medium"
                  >
                    {agent}
                  </span>
                ))}
              </div>
            )}

            {/* Source */}
            {skill.source && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground/50">{t('skills.skillSource')}:</span>
                <span className="text-xs text-muted-foreground/70">{skill.source}</span>
              </div>
            )}

            {/* Usage hint */}
            <div className="rounded-lg bg-surface-sunken/50 p-3">
              <p className="text-xs text-muted-foreground/60 leading-relaxed">
                {t('skills.usageHint')}
              </p>
              <code className="block mt-1.5 text-xs font-mono text-foreground/80">
                /{skill.name}
              </code>
            </div>
          </div>
        </div>
      </div>

      {/* Action footer */}
      <div className="px-5 pb-4 flex items-center justify-end">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUninstall();
          }}
          disabled={isUninstalling}
          className="inline-flex items-center gap-1.5 text-sm text-destructive/80 hover:text-destructive transition-colors disabled:opacity-50"
        >
          {isUninstalling ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Trash2 className="w-3.5 h-3.5" />
          )}
          {isUninstalling ? t('skills.uninstalling') : t('skills.uninstall')}
        </button>
      </div>
    </div>
  );
}
