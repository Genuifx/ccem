import type { HistorySessionItem, HistorySource } from '@/features/conversations/types';

export type CcemSessionLinkIdKind = 'runtime' | 'provider';
export type CcemSessionLinkFocus = 'events' | 'history' | 'live';

export interface CcemSessionLinkRef {
  source: Extract<HistorySource, 'claude' | 'codex' | 'opencode'>;
  id: string;
  idKind: CcemSessionLinkIdKind;
  runtimeId?: string | null;
  providerSessionId?: string | null;
  cwd?: string | null;
  focus?: CcemSessionLinkFocus | null;
}

export interface ParsedCcemSessionLink {
  source: Extract<HistorySource, 'claude' | 'codex' | 'opencode'>;
  idKind: CcemSessionLinkIdKind;
  id: string;
  runtimeId: string | null;
  providerSessionId: string | null;
  cwd: string | null;
  focus: CcemSessionLinkFocus | null;
}

export interface CcemSessionLinkNativeSessionRef {
  provider: Extract<HistorySource, 'claude' | 'codex' | 'opencode'> | string;
  runtime_id: string;
  provider_session_id?: string | null;
  project_dir?: string | null;
}

const VALID_SOURCES = new Set(['claude', 'codex', 'opencode']);
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

export function buildCcemSessionLinkForHistorySession(session: HistorySessionItem): string {
  const idKind = inferCcemSessionIdKind(session);
  return buildCcemSessionLink({
    source: session.source,
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
  if (!source || !idKind || !id || !VALID_SOURCES.has(source) || !VALID_ID_KINDS.has(idKind)) {
    return null;
  }

  const focus = readOptionalString(url.searchParams, 'focus');
  if (focus && !VALID_FOCUS.has(focus)) {
    return null;
  }

  return {
    source: source as ParsedCcemSessionLink['source'],
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
