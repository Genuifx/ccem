import { useEffect, useMemo, useRef, useState } from 'react';
import { Route, Plus, Trash2, Check, ChevronDown, Sparkles } from '@/lib/lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLocale } from '@/locales';
import { useRouterConfigEditor } from '@/hooks/useRouterConfig';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { BUILTIN_CLAUDE_AGENT_NAMES } from '@ccem/core/browser';
import { createReentryGuard, type ReentryGuard } from '@/lib/asyncGuard';
import {
  buildBudgetChoresProfile,
  buildSpecialtyProfile,
  isValidTemplateBindingKey,
  profileBindingTargets,
  profileSetBinding,
  profileSetName,
  profileToggleAllowed,
} from '@/lib/routerProfiles';
import type { RouterBindings, RouterProfile } from '@ccem/core/browser';

const BINDING_FOLLOW_DEFAULT = '__ccem_default__';
type BindingMap = Record<string, string>;

function bindingRows(
  t: (k: string) => string,
  extra: RouterBindings | BindingMap,
  includeAllAgents = false,
) {
  const rows: { key: string; label: string }[] = [
    { key: 'background', label: t('router.background') },
    { key: 'subagent:Explore', label: 'Explore' },
  ];
  const covered = new Set(rows.map((row) => row.key));
  const labelForKey = (key: string) => {
    if (key === 'subagent:*') return t('router.subagentAny');
    const name = key.startsWith('subagent:') ? key.slice('subagent:'.length) : key;
    return BUILTIN_CLAUDE_AGENT_NAMES.includes(name as (typeof BUILTIN_CLAUDE_AGENT_NAMES)[number])
      ? name
      : key;
  };
  for (const key of Object.keys(extra)) {
    if (!covered.has(key)) {
      rows.push({ key, label: labelForKey(key) });
      covered.add(key);
    }
  }
  if (includeAllAgents) {
    const wildcardKey = 'subagent:*';
    if (!covered.has(wildcardKey)) {
      rows.push({ key: wildcardKey, label: t('router.subagentAny') });
      covered.add(wildcardKey);
    }
    for (const name of BUILTIN_CLAUDE_AGENT_NAMES) {
      const key = `subagent:${name}`;
      if (!covered.has(key)) rows.push({ key, label: name });
    }
  }
  return rows;
}

function makeProfileId() {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function unionKeepingOrder(base: string[], additions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...base, ...additions]) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Profile name input with a LOCAL draft (smooth typing) that commits onBlur.
 * Reliable rollback: onCommit returns a promise; on rejection the draft is
 * explicitly reset to the authoritative value (the useEffect only re-syncs when
 * the store value actually changes, which it does NOT on a failed save).
 */
function ProfileNameInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => Promise<unknown> | unknown;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (!next || next === value) {
          setDraft(value);
          return;
        }
        try {
          const ret = onCommit(next);
          if (ret && typeof (ret as Promise<unknown>).then === 'function') {
            (ret as Promise<unknown>).catch(() => setDraft(value));
          }
        } catch {
          setDraft(value);
        }
      }}
      className="h-8 flex-1 rounded-md border-border/40 text-[12px]"
    />
  );
}

/**
 * Environments page → "默认路由规则" card. Owns the global RouterConfig defaults
 * (bindings / defaultAllowedEnvs / dynamicRouting) and named profile CRUD.
 *
 * Every change goes through useRouterConfigEditor.commit with a FUNCTIONAL
 * updater (computed from fresh base at execution time) so rapid queued edits
 * compose without stale-snapshot overwrites. Profile edits use the pure
 * helpers that union binding targets into allowedEnvs + bump revision.
 */
export function EnvironmentsRouterRules({ envNames }: { envNames: string[] }) {
  const { t } = useLocale();
  const { config, commit } = useRouterConfigEditor();
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  const [showDefaultAdvanced, setShowDefaultAdvanced] = useState(false);
  const [showDefaultAgentBindings, setShowDefaultAgentBindings] = useState(false);
  const [showProfileAdvanced, setShowProfileAdvanced] = useState(false);
  const [showProfileAgentBindings, setShowProfileAgentBindings] = useState(false);

  const defaultRows = useMemo(
    () => bindingRows(t, config?.bindings ?? {}, showDefaultAgentBindings),
    [t, config, showDefaultAgentBindings],
  );

  useEffect(() => {
    setShowProfileAdvanced(false);
    setShowProfileAgentBindings(false);
  }, [expandedProfile]);

  // --- §4.5 parameterized templates ("省钱杂活" / "特长分工") ---
  // Templates never hardcode an env name: the user MUST pick a target env (and,
  // for specialty, a legal logical key) before a profile is generated.
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateKind, setTemplateKind] = useState<'budget-chores' | 'specialty'>('budget-chores');
  const [templateEnv, setTemplateEnv] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [generating, setGenerating] = useState(false);
  const generateGuardRef = useRef<ReentryGuard | null>(null);
  if (!generateGuardRef.current) generateGuardRef.current = createReentryGuard();

  // Reset the draft whenever the dialog is (re)opened so a previous selection
  // never leaks into a new generation.
  useEffect(() => {
    if (templateOpen) {
      setTemplateKind('budget-chores');
      setTemplateEnv('');
      setTemplateKey('');
    }
  }, [templateOpen]);

  const templateKeyRows = useMemo(() => {
    const rows: { key: string; label: string }[] = [
      { key: 'background', label: t('router.background') },
      { key: 'subagent:*', label: t('router.subagentAny') },
    ];
    for (const name of BUILTIN_CLAUDE_AGENT_NAMES) rows.push({ key: `subagent:${name}`, label: name });
    return rows;
  }, [t]);

  const envChosen = templateEnv !== '' && envNames.includes(templateEnv);
  const keyChosen = templateKind !== 'specialty' || isValidTemplateBindingKey(templateKey);
  const canGenerate = envNames.length > 0 && envChosen && keyChosen && !generating;

  const generateFromTemplate = () => {
    const guard = generateGuardRef.current;
    if (!guard || !guard.begin()) return; // synchronous same-tick claim
    setGenerating(true);
    const id = makeProfileId();
    const name =
      templateKind === 'budget-chores'
        ? t('router.templateBudgetName')
        : t('router.templateSpecialtyName');
    const profile =
      templateKind === 'budget-chores'
        ? buildBudgetChoresProfile({ id, name, env: templateEnv, existingNames: envNames })
        : buildSpecialtyProfile({ id, name, env: templateEnv, key: templateKey, existingNames: envNames });
    if (!profile) {
      // Invalid env/key → refuse, do NOT fake success.
      guard.end();
      setGenerating(false);
      toast.error(t('environments.routerTemplateInvalid'));
      return;
    }
    void commit((base) => ({ profiles: [...base.profiles, profile] }))
      .then(() => {
        setExpandedProfile(profile.id);
        setTemplateOpen(false);
        toast.success(t('environments.routerTemplateCreated'));
      })
      .catch(() => {
        toast.error(t('settings.routerSaveFailed'));
      })
      .finally(() => {
        guard.end();
        setGenerating(false);
      });
  };

  if (!config) {
    return (
      <section className="mt-8 mb-8 rounded-2xl border border-border-subtle bg-surface-raised/50 p-6">
        <h2 className="text-[17px] font-semibold text-foreground tracking-[-0.37px] mb-1">
          {t('environments.routerRules')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </section>
    );
  }

  const fail = () => toast.error(t('settings.routerSaveFailed'));

  const setDefaultBinding = (key: string, value: string) => {
    void commit((base) => {
      const bindings = { ...(base.bindings as BindingMap) };
      if (value === BINDING_FOLLOW_DEFAULT) delete bindings[key];
      else bindings[key] = value;
      // Keep default binding targets inside defaultAllowedEnvs so copied
      // session snapshots pass session-level validation.
      const defaultAllowedEnvs = unionKeepingOrder(
        base.defaultAllowedEnvs,
        Object.values(bindings).filter(Boolean),
      ).filter((name) => envNames.includes(name));
      return { bindings: bindings as RouterBindings, defaultAllowedEnvs };
    }).catch(fail);
  };

  const toggleDefaultAllowed = (env: string) => {
    void commit((base) => {
      // Forced-on for default binding targets.
      const targets = Object.values(base.bindings as BindingMap).filter(Boolean);
      if (targets.includes(env)) return {}; // no-op patch
      const set = new Set(base.defaultAllowedEnvs);
      if (set.has(env)) set.delete(env);
      else set.add(env);
      return { defaultAllowedEnvs: envNames.filter((n) => set.has(n)) };
    }).catch(fail);
  };

  const setDynamic = (dynamicRouting: boolean) => {
    void commit({ dynamicRouting }).catch(fail);
  };

  const createProfile = () => {
    const profile: RouterProfile = {
      id: makeProfileId(),
      name: t('environments.routerNewProfileName'),
      revision: 1,
      bindings: {},
      allowedEnvs: [],
    };
    void commit((base) => ({ profiles: [...base.profiles, profile] }))
      .then(() => setExpandedProfile(profile.id))
      .catch(fail);
  };

  const deleteProfile = (id: string) => {
    void commit((base) => ({ profiles: base.profiles.filter((p) => p.id !== id) })).catch(fail);
  };

  const setProfileBinding = (id: string, key: string, value: string) => {
    const env = value === BINDING_FOLLOW_DEFAULT ? null : value;
    void commit((base) => ({
      profiles: base.profiles.map((p) => (p.id === id ? profileSetBinding(p, key, env) : p)),
    })).catch(fail);
  };

  const toggleProfileAllowed = (id: string, env: string, add: boolean) => {
    void commit((base) => ({
      profiles: base.profiles.map((p) => (p.id === id ? profileToggleAllowed(p, env, add) : p)),
    })).catch(fail);
  };

  const renameProfile = (id: string, name: string) =>
    commit((base) => ({
      profiles: base.profiles.map((p) => (p.id === id ? profileSetName(p, name) : p)),
    })).catch((err) => {
      // Surface the failure (reload-then-rethrow contract still rejects so the
      // input resets to the authoritative value).
      toast.error(t('settings.routerSaveFailed'));
      throw err;
    });

  const defaultBindingTargets = Object.values(config.bindings as BindingMap).filter(Boolean);

  return (
    <section className="mt-8 mb-8 rounded-2xl border border-border-subtle bg-surface-raised/50 p-6">
      <div className="mx-auto w-full max-w-[1240px]">
        <div className="mb-5 flex items-center gap-2">
          <Route className="h-4 w-4 text-primary/80" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold text-foreground tracking-[-0.37px] mb-1">
              {t('environments.routerRules')}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{t('environments.routerRulesHint')}</p>
          </div>
        </div>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="min-w-0 rounded-xl border border-border-subtle bg-background/35 p-4">
            <div className="mb-4">
              <div className="mb-1 text-sm font-medium text-foreground">{t('router.routeMyDefault')}</div>
              <p className="text-[12px] leading-5 text-muted-foreground">
                {t('settings.routerDefaultBindingsDesc')}
              </p>
            </div>

            <div id="router-default-agent-bindings" className="space-y-1">
              <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                {t('settings.routerDefaultBindings')}
              </div>
              {defaultRows.map((row) => {
                const value = (config.bindings as BindingMap)[row.key] ?? BINDING_FOLLOW_DEFAULT;
                return (
                  <div
                    key={row.key}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(160px,240px)] items-center gap-3"
                  >
                    <span className="min-w-0 truncate text-[12px] text-foreground/85" title={row.key}>
                      {row.label}
                    </span>
                    <Select value={value} onValueChange={(next) => setDefaultBinding(row.key, next)}>
                      <SelectTrigger
                        className="h-8 w-full rounded-md border-border/40 px-2 text-[12px]"
                        aria-label={`${row.label} · ${t('router.selectEnv')}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={BINDING_FOLLOW_DEFAULT}>{t('router.bindingDefault')}</SelectItem>
                        {envNames.map((name) => (
                          <SelectItem key={name} value={name}>{name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              aria-expanded={showDefaultAgentBindings}
              aria-controls="router-default-agent-bindings"
              onClick={() => setShowDefaultAgentBindings((visible) => !visible)}
              className="mt-2 flex w-full items-center gap-1 rounded-lg px-1 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className={cn('h-3 w-3 transition-transform', showDefaultAgentBindings && 'rotate-180')} />
              {t('environments.routerMoreAgents')}
            </button>

            <div className="my-3 border-t border-border-subtle" />

            <button
              type="button"
              aria-expanded={showDefaultAdvanced}
              aria-controls="router-default-advanced"
              onClick={() => setShowDefaultAdvanced((visible) => !visible)}
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:text-foreground"
            >
              <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', showDefaultAdvanced && 'rotate-180')} />
              <span className="text-[12px] font-medium text-foreground">{t('environments.routerAdvanced')}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {t('environments.routerAdvancedSummary', { count: config.defaultAllowedEnvs.length })}
              </span>
            </button>

            {showDefaultAdvanced ? (
              <div id="router-default-advanced" className="mt-2 space-y-3 rounded-lg bg-muted/20 p-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-foreground">
                      {t('settings.routerDynamicRouting')}
                    </div>
                    <div className="text-[11px] leading-4 text-muted-foreground">
                      {t('settings.routerDynamicRoutingDesc')}
                    </div>
                  </div>
                  <Switch
                    checked={config.dynamicRouting}
                    onCheckedChange={setDynamic}
                    aria-label={t('settings.routerDynamicRouting')}
                  />
                </div>

                {config.dynamicRouting ? (
                  <div className="border-t border-border-subtle pt-3">
                    <div className="mb-1 text-[11px] font-medium text-foreground">
                      {t('router.allowedEnvs')}
                    </div>
                    <p className="mb-2 text-[10px] leading-4 text-muted-foreground">
                      {t('environments.routerDefaultAllowedHint')}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {envNames.length === 0 ? (
                        <span className="text-[12px] text-muted-foreground/70">—</span>
                      ) : (
                        envNames.map((name) => {
                          const forced = defaultBindingTargets.includes(name);
                          const checked = forced || config.defaultAllowedEnvs.includes(name);
                          return (
                            <button
                              key={name}
                              type="button"
                              disabled={forced}
                              aria-pressed={checked}
                              title={forced ? t('router.allowedForced') : undefined}
                              onClick={() => toggleDefaultAllowed(name)}
                              className={cn(
                                'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] transition-colors',
                                checked ? 'bg-primary/[0.10] text-primary/80' : 'bg-muted/40 text-muted-foreground hover:bg-muted/70',
                                forced ? 'cursor-default opacity-80' : 'cursor-pointer',
                              )}
                            >
                              {checked ? <Check className="h-2.5 w-2.5" /> : null}
                              {name}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="min-w-0 rounded-xl border border-border-subtle bg-background/35 p-4">
            {/* Profiles CRUD */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <label className="block text-sm font-medium text-foreground">{t('settings.routerProfiles')}</label>
                <p className="text-[12px] text-muted-foreground">{t('settings.routerProfilesHint')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-[11px]"
                  disabled={envNames.length === 0}
                  title={envNames.length === 0 ? t('environments.routerTemplateNoEnv') : undefined}
                  onClick={() => setTemplateOpen(true)}
                >
                  <Sparkles className="h-3 w-3" />
                  {t('environments.routerFromTemplate')}
                </Button>
                <Button type="button" size="sm" variant="outline" className="h-7 rounded-full text-[11px]" onClick={createProfile}>
                  <Plus className="h-3 w-3" />
                  {t('environments.routerCreateProfile')}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              {config.profiles.length === 0 ? (
                <p className="text-[12px] text-muted-foreground/70 py-1">{t('environments.routerNoProfiles')}</p>
              ) : (
                config.profiles.map((profile) => {
                  const expanded = expandedProfile === profile.id;
                  const forcedTargets = profileBindingTargets(profile);
                  return (
                    <div key={profile.id} className="rounded-xl border border-border-subtle bg-background/40">
                      <div className="flex items-center gap-2 px-2.5 py-2">
                        <button
                          type="button"
                          onClick={() => setExpandedProfile(expanded ? null : profile.id)}
                          aria-expanded={expanded}
                          aria-controls={`router-profile-${profile.id}`}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
                          <span className="truncate text-[13px] font-medium text-foreground">{profile.name}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                            {t('environments.routerProfileSummary', { envs: profile.allowedEnvs.length, bindings: Object.keys(profile.bindings).length })}
                          </span>
                        </button>
                        <button
                          type="button"
                          title={t('common.delete')}
                          aria-label={t('common.delete')}
                          onClick={() => deleteProfile(profile.id)}
                          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {expanded ? (
                        <div id={`router-profile-${profile.id}`} className="space-y-2 border-t border-border-subtle px-2.5 py-2.5">
                          <div className="flex items-center gap-2">
                            <label className="w-16 shrink-0 text-[11px] text-muted-foreground">{t('environments.routerProfileName')}</label>
                            <ProfileNameInput value={profile.name} onCommit={(name) => renameProfile(profile.id, name)} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-[11px] font-medium text-muted-foreground">{t('router.bindings')}</div>
                            {bindingRows(t, profile.bindings, showProfileAgentBindings).map((row) => {
                              const value = (profile.bindings as BindingMap)[row.key] ?? BINDING_FOLLOW_DEFAULT;
                              return (
                                <div key={row.key} className="flex items-center gap-2">
                                  <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85">{row.label}</span>
                                  <Select
                                    value={value}
                                    onValueChange={(v) => setProfileBinding(profile.id, row.key, v)}
                                  >
                                    <SelectTrigger
                                      className="h-7 w-[150px] rounded-md border-border/40 px-2 text-[11px]"
                                      aria-label={`${row.label} · ${t('router.selectEnv')}`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={BINDING_FOLLOW_DEFAULT}>{t('router.bindingDefault')}</SelectItem>
                                      {envNames.map((name) => (
                                        <SelectItem key={name} value={name}>{name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              );
                            })}
                          </div>

                          <button
                            type="button"
                            aria-expanded={showProfileAgentBindings}
                            onClick={() => setShowProfileAgentBindings((visible) => !visible)}
                            className="flex w-full items-center gap-1 rounded-lg px-1 py-1 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <ChevronDown className={cn('h-3 w-3 transition-transform', showProfileAgentBindings && 'rotate-180')} />
                            {t('environments.routerMoreAgents')}
                          </button>

                          <button
                            type="button"
                            aria-expanded={showProfileAdvanced}
                            aria-controls={`router-profile-advanced-${profile.id}`}
                            onClick={() => setShowProfileAdvanced((visible) => !visible)}
                            className="flex w-full items-center gap-1 rounded-lg border-t border-border-subtle px-1 pt-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <ChevronDown className={cn('h-3 w-3 transition-transform', showProfileAdvanced && 'rotate-180')} />
                            {t('environments.routerAdvanced')}
                            <span className="ml-auto text-[10px] font-normal">
                              {t('environments.routerAllowedCount', { count: profile.allowedEnvs.length })}
                            </span>
                          </button>

                          {showProfileAdvanced ? (
                            <div id={`router-profile-advanced-${profile.id}`} className="rounded-lg bg-muted/20 p-2.5">
                              <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t('router.allowedEnvs')}</div>
                              <div className="flex flex-wrap gap-1">
                                {envNames.map((name) => {
                                  const forced = forcedTargets.includes(name);
                                  const checked = forced || profile.allowedEnvs.includes(name);
                                  return (
                                    <button
                                      key={name}
                                      type="button"
                                      disabled={forced}
                                      aria-pressed={checked}
                                      title={forced ? t('router.allowedForced') : undefined}
                                      onClick={() => toggleProfileAllowed(profile.id, name, !checked)}
                                      className={cn(
                                        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] transition-colors',
                                        checked ? 'bg-primary/[0.10] text-primary/80' : 'bg-muted/40 text-muted-foreground hover:bg-muted/70',
                                        forced ? 'cursor-default opacity-80' : 'cursor-pointer',
                                      )}
                                    >
                                      {checked ? <Check className="h-2.5 w-2.5" /> : null}
                                      {name}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* §4.5 parameterized template dialog — target env (and key) chosen first */}
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent
          className="max-w-[420px] rounded-2xl border border-[hsl(var(--glass-border-light))] bg-popover p-0"
          closeLabel={t('common.close')}
        >
          <DialogHeader className="space-y-1 px-5 pt-5 pb-2">
            <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <Sparkles className="h-4 w-4 text-primary/80" />
              {t('router.templateTitle')}
            </DialogTitle>
            <DialogDescription className="text-[12px] leading-relaxed text-muted-foreground">
              {t('router.templateDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 px-5 pb-3">
            {/* Template kind */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">{t('router.templateKind')}</label>
              <RadioGroup
                value={templateKind}
                onValueChange={(v) => setTemplateKind(v as 'budget-chores' | 'specialty')}
                className="gap-1"
                aria-label={t('router.templateKind')}
              >
                <label htmlFor="tpl-budget" className={cn('flex items-start gap-2 rounded-lg px-2 py-1.5 glass-dropdown-item cursor-pointer', templateKind === 'budget-chores' ? 'text-primary' : 'text-foreground/85')}>
                  <RadioGroupItem value="budget-chores" id="tpl-budget" className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium">{t('router.templateBudget')}</span>
                    <span className="block text-[10px] leading-4 text-muted-foreground">{t('router.templateBudgetDesc')}</span>
                  </span>
                </label>
                <label htmlFor="tpl-specialty" className={cn('flex items-start gap-2 rounded-lg px-2 py-1.5 glass-dropdown-item cursor-pointer', templateKind === 'specialty' ? 'text-primary' : 'text-foreground/85')}>
                  <RadioGroupItem value="specialty" id="tpl-specialty" className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium">{t('router.templateSpecialty')}</span>
                    <span className="block text-[10px] leading-4 text-muted-foreground">{t('router.templateSpecialtyDesc')}</span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            {/* Target env — required, never hardcoded */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">{t('router.templateTargetEnv')}</label>
              <p className="text-[10px] leading-4 text-muted-foreground/80">{t('router.templateTargetEnvHint')}</p>
              <Select value={templateEnv} onValueChange={setTemplateEnv}>
                <SelectTrigger
                  className="h-8 w-full rounded-lg border-border/45 text-[12px]"
                  aria-label={t('router.templateTargetEnv')}
                >
                  <SelectValue placeholder={t('router.selectEnv')} />
                </SelectTrigger>
                <SelectContent>
                  {envNames.map((name) => (
                    <SelectItem key={name} value={name}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Logical key — specialty only */}
            {templateKind === 'specialty' ? (
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">{t('router.templateBindingKey')}</label>
                <p className="text-[10px] leading-4 text-muted-foreground/80">{t('router.templateBindingKeyHint')}</p>
                <Select value={templateKey} onValueChange={setTemplateKey}>
                  <SelectTrigger
                    className="h-8 w-full rounded-lg border-border/45 text-[12px]"
                    aria-label={t('router.templateBindingKey')}
                  >
                    <SelectValue placeholder={t('router.templateBindingKey')} />
                  </SelectTrigger>
                  <SelectContent>
                    {templateKeyRows.map((row) => (
                      <SelectItem key={row.key} value={row.key}>{row.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <DialogFooter className="flex-row justify-end gap-2 border-t border-border/35 px-5 py-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 rounded-md text-[12px] text-muted-foreground hover:text-foreground"
              disabled={generating}
              onClick={() => setTemplateOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-md text-[12px]"
              disabled={!canGenerate}
              onClick={generateFromTemplate}
            >
              {generating ? t('common.processing') : t('router.templateGenerate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
