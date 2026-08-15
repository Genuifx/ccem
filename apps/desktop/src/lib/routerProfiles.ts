/**
 * Pure helpers for CCEM Router profile application, route labeling, and the
 * allowedEnvs draft model. Dependency-free (type-only core imports, erased at
 * runtime) so it can be transpiled + unit-tested in isolation by `node:test`.
 *
 * Design refs (docs/plans/2026-08-09-subagent-env-router-design.md):
 *  - §4.1 route table; §4.4 sourceProfileId (null = custom), profileRevision
 *  - §4.5 profile = named binding snapshot; allowedEnvs carries explicit
 *    dynamic-routing authorizations and must not be silently recompressed.
 */
import type {
  RouterBindings,
  RouterConfig,
  RouterProfile,
  RouterStatus,
  SessionRouterState,
  UpdateSessionRouterPatch,
} from '@ccem/core/browser';
// Value import: the reserved my-defaults source id is a shared wire contract
// with the Rust backend, owned by @ccem/core.
import { MY_DEFAULT_ROUTER_PROFILE_ID } from '@ccem/core/browser';

export { MY_DEFAULT_ROUTER_PROFILE_ID };

/** Built-in profile id meaning "no per-type bindings, default env only". */
export const DEFAULT_ONLY_PROFILE_ID = 'default-only';

export type RouteLabelKind = 'direct' | 'defaultOnly' | 'myDefault' | 'profile' | 'custom';

export interface RouteLabelInfo {
  kind: RouteLabelKind;
  profileId: string | null;
  /** Present only when kind === 'profile' (a user-defined profile name). */
  profileName: string | null;
}

function nonEmpty(values: Array<string | undefined | null>): string[] {
  return (values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0));
}

/**
 * Classify a session's route for display. The chip/pill label is derived from
 * this so a state WITH bindings is never mislabeled as the bare default env,
 * and a direct transport is always shown as "direct".
 */
export function resolveRouteLabel(
  router: SessionRouterState | null,
  profiles: ReadonlyArray<RouterProfile>,
): RouteLabelInfo {
  if (!router || router.launchTransport === 'direct') {
    return { kind: 'direct', profileId: null, profileName: null };
  }
  const sourceProfileId = router.sourceProfileId;
  if (sourceProfileId === DEFAULT_ONLY_PROFILE_ID) {
    return { kind: 'defaultOnly', profileId: sourceProfileId, profileName: null };
  }
  if (sourceProfileId === MY_DEFAULT_ROUTER_PROFILE_ID) {
    return { kind: 'myDefault', profileId: sourceProfileId, profileName: null };
  }
  if (sourceProfileId) {
    const matched = profiles.find((profile) => profile.id === sourceProfileId);
    if (matched && router.profileRevision === matched.revision) {
      return { kind: 'profile', profileId: sourceProfileId, profileName: matched.name };
    }
    // Missing or revised profile → this session still owns its older snapshot.
    return { kind: 'custom', profileId: null, profileName: null };
  }
  // sourceProfileId is null: infer bare main-env-only vs custom bindings.
  if (Object.keys(router.bindings).length === 0) {
    return { kind: 'defaultOnly', profileId: null, profileName: null };
  }
  return { kind: 'custom', profileId: null, profileName: null };
}

/**
 * Whether an incoming SessionRouterState should replace the existing one in the
 * store. Revision is monotonic: an older incoming (late fetch / out-of-order
 * event) is rejected. Same-revision updates still apply when any "live" field
 * (transport / defaultEnv / dynamicRouting / warnings) changed, so a degraded
 * listener or transport flip on the same revision is not dropped.
 */
export function shouldApplySessionRouter(
  existing: SessionRouterState | null,
  incoming: SessionRouterState,
): boolean {
  if (!existing) return true;
  if (incoming.revision < existing.revision) return false;
  if (incoming.revision > existing.revision) return true;
  if (incoming.launchTransport !== existing.launchTransport) return true;
  if (incoming.defaultEnv !== existing.defaultEnv) return true;
  if (incoming.dynamicRouting !== existing.dynamicRouting) return true;
  if (incoming.warnings.length !== existing.warnings.length) return true;
  if (incoming.warnings.some((w, i) => w !== existing.warnings[i])) return true;
  return false;
}

/**
 * Transport truth: an existing session's `launchTransport` is the authoritative
 * transport. Listener failures and global default edits never rewrite a
 * persisted session's launch transport, so the UI must keep showing/allowing
 * the route chip + session CAS for routed sessions. Only direct/new sessions
 * read as direct.
 */
export function isSessionRouted(router: SessionRouterState | null): router is SessionRouterState {
  return router != null && router.launchTransport === 'routed';
}

/**
 * The env value the status-strip chip should display/select. For a routed
 * session it is the router's defaultEnv (the very value a CAS edit changes), so
 * an A→B switch shows and checks B immediately — never the stale global
 * currentEnv. Direct/new sessions fall back to the global currentEnv.
 */
export function resolveDisplayEnv(
  currentEnv: string,
  activeRouter: SessionRouterState | null,
): string {
  return isSessionRouted(activeRouter) ? activeRouter.defaultEnv : currentEnv;
}

// ---------------------------------------------------------------------------
// Environment-delete reference query.
// `get_environment_router_references` returns authoritative references
// (router.bindings.<key>, router.profile:<id>, session:<runtimeId>) to an env.
// The delete-confirm dialog disables the final delete while references exist;
// on a query error the delete is still allowed (the backend rejects + the dialog
// stays open as the fallback).
// ---------------------------------------------------------------------------

export interface EnvReferenceQuery {
  status: 'loading' | 'loaded' | 'error';
  /** Meaningful only when status === 'loaded'. */
  refs: string[];
}

/** Whether the delete button may be enabled given the reference-query state. */
export function refQueryAllowsDelete(query: EnvReferenceQuery): boolean {
  if (query.status === 'loading') return false;
  if (query.status === 'error') return true; // unknown → attempt; backend rejects if referenced
  return query.refs.length === 0;
}

/**
 * Guard against stale responses: accept a reference list only when it is for the
 * env name the dialog is currently showing (prevents a late response for a
 * previous env or after close from leaking in).
 */
export function isFreshReferenceResponse(
  currentName: string,
  responseName: string,
): boolean {
  return currentName === responseName;
}

/**
 * A routed session can be edited via CAS only while its listener port is alive
 * (actualPort present). Routed + no port = degraded (show blocked/restart).
 */
export function isSessionCasCapable(
  router: SessionRouterState | null,
  actualPort: number | null | undefined,
): boolean {
  return isSessionRouted(router) && actualPort != null;
}

/**
 * Candidate environment names for selectors and allowed-env toggles.
 * Includes EVERY currently-existing environment (disabled ones too — a binding
 * target that is merely disabled must not vanish from the dropdown) plus any
 * name the session already references (so a dangling ref is visible+fixable).
 * De-duplicated, existing-env order preserved.
 */
export function computeCandidateEnvs(
  existingNames: ReadonlyArray<string>,
  router: SessionRouterState | null,
): string[] {
  const referenced: string[] = router
    ? nonEmpty([
        router.defaultEnv,
        ...router.allowedEnvs,
        ...Object.values(router.bindings),
      ])
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...existingNames, ...referenced]) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * The forced-on env set: default env + every binding target. These can never
 * be removed from allowedEnvs (the backend requires them to be present).
 */
export function computeAutoIncludedEnvs(
  defaultEnv: string,
  bindings: Readonly<RouterBindings> | Readonly<Record<string, string>>,
): string[] {
  const targets = nonEmpty(Object.values(bindings));
  return Array.from(new Set(nonEmpty([defaultEnv, ...targets])));
}

/**
 * Final allowedEnvs to send on apply = (explicit base set ∪ auto-included),
 * intersected with envs that currently EXIST. Preserves explicit
 * dynamic-routing-only authorizations; drops phantom (deleted) names so the
 * backend does not 502 on them. Disabled-but-existing envs are kept.
 */
export function computeFinalAllowedEnvs(
  baseAllowed: ReadonlyArray<string>,
  defaultEnv: string,
  bindings: Readonly<RouterBindings> | Readonly<Record<string, string>>,
  existingNames: ReadonlyArray<string>,
): string[] {
  const union = new Set<string>([
    ...nonEmpty([defaultEnv]),
    ...nonEmpty(Object.values(bindings)),
    ...nonEmpty(baseAllowed as Array<string | undefined>),
  ]);
  // Preserve existing-env order; only keep names that currently exist so the
  // backend never receives a phantom (deleted) environment reference.
  return existingNames.filter((name) => union.has(name));
}

/**
 * Build the CAS patch to apply a named profile (or the built-in default-only)
 * to a session. A profile is a BINDING SNAPSHOT — applying it swaps in the
 * profile's bindings but NEVER moves the session's current main `defaultEnv`
 * (so「省钱杂活」keeps main on `official` while Explore/background go cheap). The
 * current defaultEnv is always preserved AND unioned into `allowedEnvs` so the
 * session validator (`defaultEnv ∈ allowedEnvs`) passes; the profile's own
 * allowedEnvs (which already contain its binding targets) are unioned in too.
 */
export function buildProfileApplyPatch(
  router: SessionRouterState,
  profile: Readonly<RouterProfile>,
): UpdateSessionRouterPatch {
  const defaultEnv = router.defaultEnv;
  const allowedEnvs = Array.from(
    new Set(nonEmpty([defaultEnv, ...nonEmpty(profile.allowedEnvs)])),
  );

  return {
    defaultEnv,
    bindings: { ...profile.bindings } as RouterBindings,
    allowedEnvs,
    sourceProfileId: profile.id,
    profileRevision: profile.revision,
    // dynamicRouting intentionally omitted → preserved by the partial patch.
  };
}

/**
 * Re-seed a RUNNING routed session from the user's current RouterConfig
 * defaults — the virtual "my defaults" option in the session selectors. This
 * is deliberately NOT a faked RouterProfile: there is no stored profile, so
 * profileRevision stays null and the label keeps reading 「我的默认」.
 *
 * - The session's main env (defaultEnv) is preserved (omitted from the patch).
 * - bindings snapshot the CURRENT config bindings.
 * - allowedEnvs = union(current defaultEnv + config.defaultAllowedEnvs +
 *   config binding targets), de-duplicated, empties dropped.
 * - dynamicRouting follows the current config default.
 */
export function buildMyDefaultApplyPatch(
  router: SessionRouterState,
  config: Readonly<RouterConfig>,
): UpdateSessionRouterPatch {
  const bindingTargets = nonEmpty(Object.values(config.bindings));
  const allowedEnvs = Array.from(
    new Set(nonEmpty([router.defaultEnv, ...config.defaultAllowedEnvs, ...bindingTargets])),
  );

  return {
    bindings: { ...config.bindings } as RouterBindings,
    allowedEnvs,
    sourceProfileId: MY_DEFAULT_ROUTER_PROFILE_ID,
    profileRevision: null,
    dynamicRouting: config.dynamicRouting,
  };
}

/**
 * Build the CAS patch for a manual custom edit. sourceProfileId/profileRevision
 * are cleared (null) because the route has diverged from any named profile.
 */
export function buildCustomEditPatch(args: {
  defaultEnv: string;
  bindings: Readonly<RouterBindings> | Readonly<Record<string, string>>;
  allowedEnvs: ReadonlyArray<string>;
  dynamicRouting: boolean;
}): UpdateSessionRouterPatch {
  return {
    defaultEnv: args.defaultEnv,
    bindings: { ...args.bindings } as RouterBindings,
    allowedEnvs: [...args.allowedEnvs],
    sourceProfileId: null,
    profileRevision: null,
    dynamicRouting: args.dynamicRouting,
  };
}

// ---------------------------------------------------------------------------
// Global RouterConfig profile CRUD helpers.
//
// Invariants enforced here (mirrors Rust `validate_router_config`):
//  - A profile's allowedEnvs always contains every binding target (the backend
//    rejects otherwise), so setting a binding unions the target in.
//  - A binding target can never be removed from allowedEnvs via the toggle.
//  - Any substantive profile change bumps `revision` (checked-safe-integer) so
//    SessionRouterState.profileRevision stays meaningful.
// ---------------------------------------------------------------------------

/** Monotonically bump a profile revision, capped at MAX_SAFE_INTEGER. */
export function bumpRevision(revision: number): number {
  if (!Number.isFinite(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Math.trunc(revision)) + 1;
}

/** Envs forced-on by a profile's current bindings (cannot be removed). */
export function profileBindingTargets(profile: Readonly<RouterProfile>): string[] {
  return nonEmpty(Object.values(profile.bindings));
}

/**
 * Return a profile with a binding set (env) or removed (null). The target env
 * is unioned into allowedEnvs; revision is bumped. Existing allowedEnvs are
 * preserved (removing a binding never shrinks allowed — the user may keep the
 * env for dynamic routing).
 */
export function profileSetBinding(
  profile: Readonly<RouterProfile>,
  key: string,
  env: string | null,
): RouterProfile {
  const bindings = { ...(profile.bindings as Record<string, string>) };
  if (!env) delete bindings[key];
  else bindings[key] = env;
  const targets = profileBindingTargets({ ...profile, bindings });
  const allowedEnvs = unionKeepingOrder(profile.allowedEnvs, targets);
  return {
    ...profile,
    bindings: bindings as RouterBindings,
    allowedEnvs,
    revision: bumpRevision(profile.revision),
  };
}

/**
 * Add/remove an env from a profile's allowedEnvs. Removing a current binding
 * target is rejected (no-op, returns the same profile). Revision bumps only on
 * an actual change.
 */
export function profileToggleAllowed(
  profile: Readonly<RouterProfile>,
  env: string,
  add: boolean,
): RouterProfile {
  const has = profile.allowedEnvs.includes(env);
  if (add) {
    if (has) return profile;
    return { ...profile, allowedEnvs: [...profile.allowedEnvs, env], revision: bumpRevision(profile.revision) };
  }
  if (!has) return profile;
  if (profileBindingTargets(profile).includes(env)) return profile; // forced-on
  return {
    ...profile,
    allowedEnvs: profile.allowedEnvs.filter((name) => name !== env),
    revision: bumpRevision(profile.revision),
  };
}

/** Rename a profile; revision bumps only when the name actually changes. */
export function profileSetName(
  profile: Readonly<RouterProfile>,
  name: string,
): RouterProfile {
  const trimmed = name.trim();
  if (!trimmed || trimmed === profile.name) return profile;
  return { ...profile, name: trimmed, revision: bumpRevision(profile.revision) };
}

function unionKeepingOrder(base: ReadonlyArray<string>, additions: ReadonlyArray<string>): string[] {
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

/** Commit updater: either a plain patch or a function computed from fresh base. */
export type RouterConfigUpdater =
  | Partial<RouterConfig>
  | ((base: RouterConfig) => Partial<RouterConfig>);

/**
 * Apply an updater against a base config. Functional updaters read the FRESH
 * base at execution time, which is what makes serialized queued edits compose
 * (a later edit built on a stale snapshot cannot overwrite an earlier one).
 */
export function applyConfigUpdater(
  base: RouterConfig,
  updater: RouterConfigUpdater,
): RouterConfig {
  const patch = typeof updater === 'function' ? updater(base) : updater;
  return { ...base, ...patch };
}

/**
 * Resolve what the env-chip switch should do for a session. A ROUTED session
 * must NEVER fall through to the global `set_current_env` path (that would
 * bypass router semantics and leave the session's route table stale):
 *  - 'cas'     → routed + live port: CAS update_session_router defaultEnv
 *  - 'blocked' → routed but listener port gone: no state change (user recovers
 *                via the route popover's restart-direct action)
 *  - 'global'  → direct / new session: legacy global env switch
 */
export type EnvSwitchAction = 'cas' | 'blocked' | 'global';

export function resolveEnvSwitchAction(
  router: SessionRouterState | null,
  actualPort: number | null | undefined,
): EnvSwitchAction {
  if (!isSessionRouted(router)) return 'global';
  return actualPort != null ? 'cas' : 'blocked';
}

/**
 * Given the call-time decision was `cas` (routed session), resolve the CAS patch
 * to execute — or `failClosed` if the fresh session router is missing at queue
 * execution time. **Transport truth:** once we've committed to the CAS path we
 * must NEVER fall back to the global `set_current_env` path, even if the session
 * router vanished between the click and the serialized task running — doing so
 * would reroute a routed session's traffic via the global env and leave its
 * route table stale. Missing router ⇒ fail closed (caller toasts, no state
 * change). The patch keeps the fresh `allowedEnvs` (unioning the new main env)
 * and clears the profile link, preserving the route table otherwise in place.
 */
export type EnvSwitchCasExecution =
  | {
      kind: 'cas';
      router: SessionRouterState;
      patch: {
        defaultEnv: string;
        allowedEnvs: string[];
      };
    }
  | { kind: 'failClosed' };

export function resolveEnvSwitchCasPatch(
  fresh: SessionRouterState | null,
  envName: string,
): EnvSwitchCasExecution {
  if (!fresh) return { kind: 'failClosed' };
  const allowedEnvs = fresh.allowedEnvs.includes(envName)
    ? fresh.allowedEnvs
    : [...fresh.allowedEnvs, envName];
  return {
    kind: 'cas',
    router: fresh,
    patch: {
      defaultEnv: envName,
      allowedEnvs,
    },
  };
}

// ---------------------------------------------------------------------------
// Serialized commit queue for the global RouterConfig editor.
//
// `runConfigCommit` enforces the failure contract: if the backend rejects the
// save, it may already have persisted a partial/new config (Rust persists config
// before applying the listener), so the store's "last-good" is NOT assumed to be
// truth — we must reload settings+status, surface the persisted reality, THEN
// rethrow so the caller can revert its local draft.
//
// `createCommitQueue` serializes commits and NEVER lets a rejection poison the
// chain: a later queued commit still executes after an earlier one fails.
// ---------------------------------------------------------------------------

export interface ConfigCommitArgs {
  base: RouterConfig | null;
  updater: RouterConfigUpdater;
  save: (next: RouterConfig) => Promise<RouterStatus>;
  reload: () => Promise<unknown>;
  onCommit: (next: RouterConfig, status: RouterStatus) => void;
}

export async function runConfigCommit(args: ConfigCommitArgs): Promise<RouterConfig> {
  if (!args.base) {
    throw new Error('router config not loaded');
  }
  const next = applyConfigUpdater(args.base, args.updater);
  try {
    const status = await args.save(next);
    args.onCommit(next, status);
    return next;
  } catch (err) {
    // Backend may have persisted before rejecting — reload the real truth.
    await args.reload().catch(() => undefined);
    throw err;
  }
}

export interface CommitQueue {
  enqueue(task: () => Promise<RouterConfig>): Promise<RouterConfig>;
}

export function createCommitQueue(): CommitQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue(task) {
      // Swallow a previous rejection so this task still runs; keep the chain
      // resolved for the next enqueue even if this task rejects.
      const next = tail.catch(() => undefined).then(task);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-key serialized task queue map.
//
// Used to serialize SESSION-router CAS writes per runtime: the Popover and
// Composer entries can both call `useApplyRouteProfile` for the SAME runtime
// with the same snapshot revision. Without serialization the second CAS (the
// user's latest intent) hits ROUTER_REVISION_CONFLICT and is lost. Tasks under
// the SAME key run in submission order; each reads the FRESH store revision at
// execution time, so a rapid A→B lands B on the bumped revision. Different keys
// run independently (parallel). A failed task never poisons the chain, and a
// key's entry is released once its chain drains so the Map can't grow unbounded.
//
// Pure + dependency-free so the node:test harness can transpile it in isolation.
// ---------------------------------------------------------------------------

export interface KeyedCommitQueues {
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
}

export function createKeyedCommitQueues(): KeyedCommitQueues {
  // Per-key serialized chain (`tails`) + outstanding-task count (`counts`). The
  // count lets us release a key's entry only once its whole chain has drained.
  const tails = new Map<string, Promise<unknown>>();
  const counts = new Map<string, number>();

  return {
    enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev
        // A prior rejection must NOT poison this task (same contract as
        // createCommitQueue): swallow it, then run.
        .catch(() => undefined)
        .then(async () => {
          try {
            return await task();
          } finally {
            const remaining = (counts.get(key) ?? 1) - 1;
            if (remaining <= 0) {
              // Chain drained → release the key so the Map doesn't retain
              // entries for runtimes whose applies have finished.
              counts.delete(key);
              tails.delete(key);
            } else {
              counts.set(key, remaining);
            }
          }
        });
      // Keep the chain resolved for the next enqueue even if this task rejects.
      tails.set(key, next.catch(() => undefined));
      return next as Promise<T>;
    },
  };
}

/**
 * Module-level singleton per-runtime serializer, shared by EVERY session-router
 * CAS call site — profile apply (Popover radio + Composer menu), custom-edit
 * apply (Popover "应用更改"), and env hot-switch (status-strip chip). Two
 * mutations for the SAME runtime never race on a stale revision, so the user's
 * last intent always lands; different runtimes serialize independently. The
 * queued task MUST read the FRESH router/revision (and any bindings/allowed it
 * needs) from `useAppStore.getState()` at execution time — a prior queued
 * mutation will have bumped the revision.
 */
const sessionRouterMutationQueues: KeyedCommitQueues = createKeyedCommitQueues();

export function enqueueSessionRouterMutation<T>(
  runtimeId: string,
  task: () => Promise<T>,
): Promise<T> {
  return sessionRouterMutationQueues.enqueue(runtimeId, task);
}

// ---------------------------------------------------------------------------
// §4.5 gaps — "save session draft as my default" (L2) + parameterized profile
// templates "省钱杂活" / "特长分工" (L3 Profiles). Pure + dependency-free so the
// node:test harness can still transpile this file in isolation.
//
// Templates NEVER hardcode an environment name: the caller supplies the user's
// chosen target env (and, for specialty, a legal logical key). Invalid input →
// null (never a fake-success profile), so the UI can refuse + toast.
// ---------------------------------------------------------------------------

/**
 * Build the GLOBAL RouterConfig patch that promotes the current session draft to
 * the user's default. Writes bindings / dynamicRouting / defaultAllowedEnvs from
 * the draft.
 *
 * `defaultAllowedEnvs` reuses `computeFinalAllowedEnvs` so the saved default
 * carries the same forced-on default-env + binding targets + explicit
 * dynamic-only authorizations (intersected with envs that currently EXIST) as
 * the session apply path — no phantom names that would 502 the backend.
 */
export function buildSaveAsDefaultPatch(args: {
  defaultEnv: string;
  bindings: Readonly<RouterBindings> | Readonly<Record<string, string>>;
  baseAllowed: ReadonlyArray<string>;
  dynamicRouting: boolean;
  existingNames: ReadonlyArray<string>;
}): Partial<RouterConfig> {
  const defaultAllowedEnvs = computeFinalAllowedEnvs(
    args.baseAllowed,
    args.defaultEnv,
    args.bindings,
    args.existingNames,
  );
  return {
    bindings: { ...args.bindings } as RouterBindings,
    dynamicRouting: args.dynamicRouting,
    defaultAllowedEnvs,
  };
}

/**
 * Legal binding key for a template: `background`, `subagent:*`, or
 * `subagent:<name>` where name is 1..128 of [A-Za-z0-9._:-]. Mirrors the core
 * `isValidRouterBindingKey` grammar but is self-contained (no core runtime
 * import) so the isolated node:test transpile keeps working.
 */
const TEMPLATE_BINDING_KEY = /^(background|subagent:[A-Za-z0-9._:-]{1,128}|subagent:\*)$/u;

export function isValidTemplateBindingKey(key: unknown): key is string {
  return typeof key === 'string' && TEMPLATE_BINDING_KEY.test(key);
}

/**
 * A legal template target env: a non-empty name that currently EXISTS. Binding
 * targets may carry any non-empty stored reference (incl. non-alias names), so
 * we only require membership in the live env list — never the alias grammar.
 */
export function isValidTemplateEnv(
  env: unknown,
  existingNames: ReadonlyArray<string>,
): env is string {
  return typeof env === 'string' && env.trim().length > 0 && existingNames.includes(env);
}

export type RouterTemplateId = 'budget-chores' | 'specialty';

export interface TemplateProfileArgs {
  id: string;
  name: string;
  env: string;
  existingNames: ReadonlyArray<string>;
}

/**
 * 「省钱杂活」template: bind Explore + background (the cheap/chores traffic) to
 * the user-chosen env. Returns null when the env is empty/missing so the caller
 * refuses instead of committing a broken profile. allowedEnvs = [env] satisfies
 * the profile grammar (every binding target ∈ allowedEnvs); the user continues
 * editing (e.g. widening the allowed set) afterwards.
 */
export function buildBudgetChoresProfile(args: TemplateProfileArgs): RouterProfile | null {
  if (!isValidTemplateEnv(args.env, args.existingNames)) return null;
  const env = args.env;
  return {
    id: args.id,
    name: args.name,
    revision: 1,
    bindings: { 'subagent:Explore': env, background: env } as RouterBindings,
    allowedEnvs: [env],
  };
}

export interface SpecialtyProfileArgs extends TemplateProfileArgs {
  /** A legal logical key: `background`, `subagent:*`, or `subagent:<name>`. */
  key: string;
}

/**
 * 「特长分工」template: bind ONE legal logical key to the user-chosen env.
 * Returns null when env or key is invalid. Produces an editable one-binding
 * profile (allowedEnvs = [env]) the user refines afterwards.
 */
export function buildSpecialtyProfile(args: SpecialtyProfileArgs): RouterProfile | null {
  if (!isValidTemplateEnv(args.env, args.existingNames)) return null;
  if (!isValidTemplateBindingKey(args.key)) return null;
  const env = args.env;
  return {
    id: args.id,
    name: args.name,
    revision: 1,
    bindings: { [args.key]: env } as RouterBindings,
    allowedEnvs: [env],
  };
}
