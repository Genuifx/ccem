import type { HistorySessionItem, HistorySource } from '@/features/conversations/types';

export type CcemSessionLinkSource = Extract<HistorySource, 'claude' | 'codex' | 'opencode'>;

export type CcemSessionLinkIdKind = 'runtime' | 'provider';
export type CcemSessionLinkFocus = 'events' | 'history' | 'live';

export interface CcemSessionLinkRef {
  source: CcemSessionLinkSource;
  id: string;
  idKind: CcemSessionLinkIdKind;
  runtimeId?: string | null;
  providerSessionId?: string | null;
  cwd?: string | null;
  focus?: CcemSessionLinkFocus | null;
}

export interface ParsedCcemSessionLink {
  source: CcemSessionLinkSource;
  idKind: CcemSessionLinkIdKind;
  id: string;
  runtimeId: string | null;
  providerSessionId: string | null;
  cwd: string | null;
  focus: CcemSessionLinkFocus | null;
}

export interface CcemSessionLinkNativeSessionRef {
  provider: CcemSessionLinkSource | string;
  runtime_id: string;
  provider_session_id?: string | null;
  project_dir?: string | null;
}

/** Exhaustive narrowing — explicitly enumerates valid link sources. Unknown/dsh → null. */
function toLinkSource(source: string): CcemSessionLinkSource | null {
  switch (source) {
    case 'claude': return 'claude';
    case 'codex': return 'codex';
    case 'opencode': return 'opencode';
    default: return null; // dsh, unknown — fail closed
  }
}

const VALID_ID_KINDS = new Set(['runtime', 'provider']);
const VALID_FOCUS = new Set(['events', 'history', 'live']);

function appendParam(params: URLSearchParams, key: string, value?: string | null) {
  const trimmed = value?.trim();
  if (trimmed) {
    params.set(key, trimmed);
  }
}

export function inferCcemSessionIdKind(
  session: Pick<HistorySessionItem, 'configSource'>
): CcemSessionLinkIdKind {
  return session.configSource === 'native' ? 'runtime' : 'provider';
}

export function buildCcemSessionLink(ref: CcemSessionLinkRef): string {
  const params = new URLSearchParams();
  params.set('source', ref.source);
  params.set('idKind', ref.idKind);
  params.set('id', ref.id);
  appendParam(params, 'runtimeId', ref.runtimeId);
  appendParam(params, 'providerSessionId', ref.providerSessionId);
  appendParam(params, 'cwd', ref.cwd);
  appendParam(params, 'focus', ref.focus);
  return `ccem://workspace/session?${params.toString().replace(/\+/g, '%20')}`;
}

export function buildCcemSessionLinkForHistorySession(session: HistorySessionItem): string | null {
  // Exhaustive narrowing — dsh/unknown fail closed (returns null).
  const source = toLinkSource(session.source);
  if (!source) return null;
  const idKind = inferCcemSessionIdKind(session);
  return buildCcemSessionLink({
    source,
    idKind,
    id: session.id,
    runtimeId: idKind === 'runtime' ? session.id : null,
    providerSessionId: idKind === 'provider' ? session.id : null,
    cwd: session.project,
    focus: idKind === 'runtime' ? 'live' : 'history',
  });
}

function readRequiredString(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim() ?? '';
  return value ? value : null;
}

function readOptionalString(params: URLSearchParams, key: string): string | null {
  return params.get(key)?.trim() || null;
}

export function parseCcemSessionLink(rawLink: string): ParsedCcemSessionLink | null {
  let url: URL;
  try {
    url = new URL(rawLink);
  } catch {
    return null;
  }

  if (url.protocol !== 'ccem:' || url.hostname !== 'workspace' || url.pathname !== '/session') {
    return null;
  }

  const source = readRequiredString(url.searchParams, 'source');
  const idKind = readRequiredString(url.searchParams, 'idKind');
  const id = readRequiredString(url.searchParams, 'id');
  if (!source || !idKind || !id || !VALID_ID_KINDS.has(idKind)) {
    return null;
  }
  const narrowedSource = toLinkSource(source);
  if (!narrowedSource) return null;

  const focus = readOptionalString(url.searchParams, 'focus');
  if (focus && !VALID_FOCUS.has(focus)) {
    return null;
  }

  return {
    source: narrowedSource,
    idKind: idKind as CcemSessionLinkIdKind,
    id,
    runtimeId: readOptionalString(url.searchParams, 'runtimeId'),
    providerSessionId: readOptionalString(url.searchParams, 'providerSessionId'),
    cwd: readOptionalString(url.searchParams, 'cwd'),
    focus: focus as CcemSessionLinkFocus | null,
  };
}

export function shouldPreferLiveSessionForCcemLink(parsed: ParsedCcemSessionLink): boolean {
  return parsed.focus !== 'history';
}

export function nativeSessionMatchesCcemSessionLink(
  parsed: ParsedCcemSessionLink,
  session: CcemSessionLinkNativeSessionRef,
): boolean {
  if (session.provider !== parsed.source) {
    return false;
  }
  if (
    parsed.cwd
    && normalizeCcemSessionProject(session.project_dir ?? '')
      !== normalizeCcemSessionProject(parsed.cwd)
  ) {
    return false;
  }

  const targetRuntimeId = parsed.runtimeId || (parsed.idKind === 'runtime' ? parsed.id : null);
  const targetProviderSessionId = parsed.providerSessionId || (parsed.idKind === 'provider' ? parsed.id : null);

  if (targetRuntimeId && session.runtime_id === targetRuntimeId) {
    return true;
  }
  if (targetProviderSessionId && session.provider_session_id === targetProviderSessionId) {
    return true;
  }
  return false;
}

function normalizeCcemSessionProject(project: string): string {
  return project.replace(/\\/g, '/').replace(/\/+$/, '').trim();
}
