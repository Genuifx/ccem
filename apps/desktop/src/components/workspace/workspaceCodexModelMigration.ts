import type {
  CodexModelMigrationPreflightResult,
  NativeProvider,
} from '@/lib/tauri-ipc';

export type CodexModelMigrationWarning = Extract<
  CodexModelMigrationPreflightResult,
  { status: 'affected' }
>;

interface CodexModelMigrationGateOptions {
  provider: NativeProvider;
  envName: string;
  workingDir: string;
  preflight: (
    envName: string,
    workingDir: string,
  ) => Promise<CodexModelMigrationPreflightResult>;
  confirm: (warning: CodexModelMigrationWarning) => Promise<boolean>;
  acknowledgedWarnings?: Set<string>;
}

interface StartAfterCodexModelMigrationGateOptions<T>
  extends CodexModelMigrationGateOptions {
  start: (codexMigrationProofToken?: string) => Promise<T>;
}

export type StartAfterCodexModelMigrationGateResult<T> =
  | { started: false; reason: 'cancelled' | 'preflight_changed' }
  | { started: true; value: T };

type CodexModelMigrationGateResult =
  | { allowed: false }
  | { allowed: true; proofToken?: string };

const CODEX_MIGRATION_PREFLIGHT_CHANGED = 'codex_migration_preflight_changed';
const MAX_PREFLIGHT_CHANGE_RETRIES = 3;

export function isCodexModelMigrationWarning(
  result: CodexModelMigrationPreflightResult,
): result is CodexModelMigrationWarning {
  return result.status === 'affected'
    && typeof result.proofToken === 'string'
    && result.proofToken.length > 0
    && (
      (result.model === 'gpt-5.4' && result.replacement === 'gpt-5.6-terra')
      || (result.model === 'gpt-5.4-mini' && result.replacement === 'gpt-5.6-luna')
    );
}

export function codexModelMigrationWarningKey(
  workingDir: string,
  warning: CodexModelMigrationWarning,
): string {
  return JSON.stringify([
    workingDir,
    warning.model,
    warning.replacement,
    warning.proofToken,
  ]);
}

export function isCodexMigrationPreflightChangedError(error: unknown): boolean {
  if (error === CODEX_MIGRATION_PREFLIGHT_CHANGED) {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === CODEX_MIGRATION_PREFLIGHT_CHANGED
    || candidate.message === CODEX_MIGRATION_PREFLIGHT_CHANGED;
}

async function readCodexModelMigrationPreflight(
  preflight: CodexModelMigrationGateOptions['preflight'],
  envName: string,
  workingDir: string,
): Promise<CodexModelMigrationPreflightResult | null> {
  try {
    return await preflight(envName, workingDir);
  } catch {
    return null;
  }
}

/**
 * Runs immediately before a native session is created.
 *
 * Probe failures intentionally fail open: this reminder must never turn an
 * unrelated Codex launch into an outage. A confirmation only remains valid if
 * the read-only proof is unchanged when it is checked again after the click.
 */
export async function runCodexModelMigrationGate({
  provider,
  envName,
  workingDir,
  preflight,
  confirm,
  acknowledgedWarnings,
}: CodexModelMigrationGateOptions): Promise<CodexModelMigrationGateResult> {
  if (provider !== 'codex') {
    return { allowed: true };
  }

  let result = await readCodexModelMigrationPreflight(preflight, envName, workingDir);
  while (result && isCodexModelMigrationWarning(result)) {
    const warningKey = codexModelMigrationWarningKey(workingDir, result);
    if (acknowledgedWarnings?.has(warningKey)) {
      return { allowed: true, proofToken: result.proofToken };
    }

    let shouldContinue = false;
    try {
      shouldContinue = await confirm(result);
    } catch {
      return { allowed: false };
    }
    if (!shouldContinue) {
      return { allowed: false };
    }

    const verifiedResult = await readCodexModelMigrationPreflight(
      preflight,
      envName,
      workingDir,
    );
    if (!verifiedResult || !isCodexModelMigrationWarning(verifiedResult)) {
      return { allowed: true };
    }

    if (codexModelMigrationWarningKey(workingDir, verifiedResult) === warningKey) {
      acknowledgedWarnings?.add(warningKey);
      return { allowed: true, proofToken: verifiedResult.proofToken };
    }

    result = verifiedResult;
  }

  return { allowed: true };
}

export async function startAfterCodexModelMigrationGate<T>({
  start,
  ...gateOptions
}: StartAfterCodexModelMigrationGateOptions<T>): Promise<StartAfterCodexModelMigrationGateResult<T>> {
  let preflightChangeCount = 0;
  while (preflightChangeCount < MAX_PREFLIGHT_CHANGE_RETRIES) {
    const gateResult = await runCodexModelMigrationGate(gateOptions);
    if (!gateResult.allowed) {
      return { started: false, reason: 'cancelled' };
    }

    try {
      return {
        started: true,
        value: await start(gateResult.proofToken),
      };
    } catch (error) {
      if (
        gateOptions.provider !== 'codex'
        || !isCodexMigrationPreflightChangedError(error)
      ) {
        throw error;
      }
      preflightChangeCount += 1;
    }
  }

  return { started: false, reason: 'preflight_changed' };
}
