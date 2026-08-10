import crypto from 'crypto';
import chalk from 'chalk';
import Conf from 'conf';
import type { EnvConfig } from '@ccem/core';
import {
  assertOfficialEnvironmentInvariant,
  encrypt,
  getCcemConfigDir,
  normalizeEnvConfig,
} from '@ccem/core';

const config = new Conf({
  projectName: 'claude-code-env-manager',
  cwd: getCcemConfigDir(),  // 使用统一的配置目录
});

/**
 * Remote response encryption envelope.
 *
 * Two versions are supported:
 *   v2 (current):  base64(JSON{v:2,nonce,ciphertext,tag}) — AES-256-GCM,
 *                  authenticated. Tampering with tag/ciphertext MUST throw.
 *   v1 (legacy):   base64(iv(16) + AES-256-CBC ciphertext) — unauthenticated.
 *                  Kept only so older servers can still serve this client.
 *
 * Security rules:
 *   - If the envelope declares v:2, we NEVER fall back to v1 on auth failure.
 *     Falling back would let an attacker strip authentication by downgrading.
 *   - Malformed v2 envelopes throw — we do not try to interpret them as v1.
 *   - v1 is detected purely by failing to parse as v2 (no JSON / wrong shape).
 */

const REMOTE_CRYPTO_ALGORITHM_V2 = 'aes-256-gcm';
const REMOTE_CRYPTO_ALGORITHM_V1 = 'aes-256-cbc';

interface RemoteEnvelopeV2 {
  v: 2;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const isEnvelopeV2 = (value: unknown): value is RemoteEnvelopeV2 => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 2 &&
    typeof v.nonce === 'string' &&
    typeof v.ciphertext === 'string' &&
    typeof v.tag === 'string'
  );
};

const deriveRemoteKey = (secret: string): Buffer =>
  crypto.scryptSync(secret, 'ccem-salt', 32);

/**
 * Decrypt an AES-256-GCM v2 envelope. Throws on ANY authentication or
 * structural failure — callers must surface this as a hard error.
 */
const decryptV2Envelope = (
  envelope: RemoteEnvelopeV2,
  key: Buffer,
): string => {
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');

  if (nonce.length === 0 || ciphertext.length === 0 || tag.length === 0) {
    throw new Error('v2 envelope has empty nonce/ciphertext/tag');
  }

  const decipher = crypto.createDecipheriv(
    REMOTE_CRYPTO_ALGORITHM_V2,
    key,
    nonce,
  );
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
};

/**
 * Decrypt the legacy v1 format: base64(iv(16) + AES-256-CBC ciphertext).
 * Unauthenticated; kept only for backward compatibility with older servers.
 */
const decryptV1Legacy = (encryptedBase64: string, key: Buffer): string => {
  const combined = Buffer.from(encryptedBase64, 'base64');
  if (combined.length < 16) {
    throw new Error('v1 payload too short');
  }
  const iv = combined.subarray(0, 16);
  const encryptedHex = combined.subarray(16).toString('hex');
  const decipher = crypto.createDecipheriv(REMOTE_CRYPTO_ALGORITHM_V1, key, iv);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

/**
 * Decrypt a remote response payload. Auto-detects v2 (preferred) vs v1
 * (legacy fallback). v2 failures are fail-closed: we never silently drop
 * to v1 or return plaintext on tampering.
 *
 * Detection is split into two phases so that v2 authentication errors can
 * never be swallowed by the legacy fallback:
 *   Phase 1 (inside try/catch): only JSON + base64 parsing. If this fails,
 *     the payload is treated as legacy v1 raw bytes.
 *   Phase 2 (outside try/catch): version/shape decisions. Any object with a
 *     `v` field is validated fail-closed — no fallthrough to v1.
 *   Phase 3 (outside try/catch): GCM decryption runs unguarded; auth tag
 *     failure propagates as a hard error.
 */
export const decryptWithSecret = (encryptedBase64: string, secret: string): string => {
  const key = deriveRemoteKey(secret);

  // Phase 1: try to parse as JSON. If base64 or JSON fails, this is legacy v1.
  let parsedObj: unknown = null;
  try {
    const jsonStr = Buffer.from(encryptedBase64, 'base64').toString('utf8');
    parsedObj = JSON.parse(jsonStr);
  } catch {
    // Not valid JSON/base64 → treat as legacy v1 payload.
  }

  // Phase 2: version/shape decisions — all fail-closed, no v1 fallthrough.
  let envelopeV2: RemoteEnvelopeV2 | null = null;
  if (parsedObj !== null) {
    if (isEnvelopeV2(parsedObj)) {
      envelopeV2 = parsedObj;
    } else if (parsedObj && typeof parsedObj === 'object' && 'v' in parsedObj) {
      const version = (parsedObj as { v: unknown }).v;
      if (version === 2) {
        // v:2 declared but required fields missing → fail closed.
        throw new Error(
          'Malformed v2 envelope: missing required fields (nonce, ciphertext, tag)',
        );
      }
      throw new Error(`Unsupported remote envelope version: ${version}`);
    }
    // else: parsed JSON without a `v` field — not an envelope; fall to v1.
  }

  if (envelopeV2) {
    // Phase 3: committed to v2. Auth failure throws; no v1 retry.
    return decryptV2Envelope(envelopeV2, key);
  }

  return decryptV1Legacy(encryptedBase64, key);
};

/**
 * 生成不冲突的环境名称
 */
export const getUniqueImportedEnvironmentName = (
  baseName: string,
  existingNames: Set<string>,
): string => {
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let suffix = 1;
  let newName = `${baseName}-remote`;
  while (existingNames.has(newName)) {
    suffix++;
    newName = `${baseName}-remote-${suffix}`;
  }
  return newName;
};

interface RemoteResponse {
  encrypted: string;
}

interface RemoteEnvironments {
  environments: Record<string, EnvConfig>;
}

interface LoadResult {
  name: string;
  originalName: string;
  renamed: boolean;
}

export interface ResolvedCredentials {
  secret: string;
  key: string;
}

export interface CredentialOptionFlags {
  secret?: string;
  key?: string;
  credentialsStdin?: boolean;
}

/**
 * Read all of stdin as a UTF-8 string. Used by `load --credentials-stdin` so
 * the desktop app can pipe credentials without leaking them through argv.
 */
export const readAllStdin = (): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });

/**
 * Resolve credentials for `ccem load`, supporting two mutually-exclusive modes:
 *   - argv:     `--secret <value> [--key <value>]`
 *   - stdin:    `--credentials-stdin` with JSON `{"secret":"...","key":"..."}`
 *
 * argv credentials are kept for backward compatibility with user scripts.
 * The desktop app exclusively uses `--credentials-stdin` to avoid leaking keys
 * through process listings, crash dumps, and diagnostic collectors.
 *
 * Throws on mixed modes, missing secret, or malformed stdin JSON. Error
 * messages never echo the secret/key values themselves.
 */
export const resolveLoadCredentials = (
  options: CredentialOptionFlags,
  stdinInput: string,
): ResolvedCredentials => {
  if (options.credentialsStdin) {
    if (options.secret !== undefined || options.key !== undefined) {
      throw new Error('--credentials-stdin 与 --secret/--key 互斥，请二选一');
    }
    let parsed: { secret?: unknown; key?: unknown };
    try {
      parsed = JSON.parse(stdinInput);
    } catch {
      throw new Error('--credentials-stdin 输入不是合法 JSON');
    }
    if (
      parsed.secret === undefined ||
      typeof parsed.secret !== 'string' ||
      parsed.secret.length === 0
    ) {
      throw new Error('--credentials-stdin JSON 缺少必填字段 secret');
    }
    return {
      secret: parsed.secret,
      key: typeof parsed.key === 'string' ? parsed.key : '',
    };
  }

  if (options.secret === undefined || options.secret.length === 0) {
    throw new Error('必须提供 --secret 或 --credentials-stdin');
  }
  return {
    secret: options.secret,
    key: options.key ?? '',
  };
};

/**
 * 从远程 URL 加载环境配置
 * @param url    服务器地址（可含 ?key= 查询参数）
 * @param key    访问密钥（access key，用于服务器认证）；为空时回退用 secret 认证（兼容旧版）
 * @param secret 解密密钥（encryption secret，用于 AES-256-CBC 解密响应体）
 * @returns 本次导入的环境列表
 */
export const loadFromRemote = async (url: string, key: string, secret: string): Promise<LoadResult[]> => {
  // 1. 发送请求
  console.log(chalk.gray('Fetching from remote...'));

  const headerKey = key || secret;
  if (!key) {
    console.log(chalk.yellow('Warning: --key not provided; using --secret for authentication (deprecated). Use --key <access-key> --secret <encryption-secret>.'));
  }

  let response: Response;
  try {
    // 使用 X-CCEM-Key header 传递访问密钥（更安全）
    response = await fetch(url, {
      headers: {
        'X-CCEM-Key': headerKey,
      },
    });
  } catch (err) {
    console.error(chalk.red('Error: Failed to connect to server'));
    console.error(chalk.gray((err as Error).message));
    process.exit(1);
  }

  // 2. 检查响应状态
  if (response.status === 401) {
    console.error(chalk.red('Error: Invalid key (HTTP 401)'));
    process.exit(1);
  }

  if (response.status === 429) {
    console.error(chalk.red('Error: Too many requests, please try again later'));
    process.exit(1);
  }

  if (!response.ok) {
    console.error(chalk.red(`Error: Server returned HTTP ${response.status}`));
    process.exit(1);
  }

  // 3. 解析响应
  let data: RemoteResponse;
  try {
    data = await response.json() as RemoteResponse;
  } catch {
    console.error(chalk.red('Error: Invalid response format from server'));
    process.exit(1);
  }

  if (!data.encrypted) {
    console.error(chalk.red('Error: Invalid response format from server'));
    process.exit(1);
  }

  // 4. 解密
  let decrypted: RemoteEnvironments;
  try {
    const jsonStr = decryptWithSecret(data.encrypted, secret);
    decrypted = JSON.parse(jsonStr) as RemoteEnvironments;
  } catch {
    console.error(chalk.red('Error: Decryption failed, check your --secret'));
    process.exit(1);
  }

  if (!decrypted.environments || typeof decrypted.environments !== 'object') {
    console.error(chalk.red('Error: Invalid response format from server'));
    process.exit(1);
  }

  // 5. 导入到本地
  const registries = config.get('registries') as Record<string, EnvConfig> | undefined;
  assertOfficialEnvironmentInvariant(registries);
  const existingNames = new Set(Object.keys(registries));
  const results: LoadResult[] = [];

  for (const [name, envConfig] of Object.entries(decrypted.environments)) {
    const uniqueName = getUniqueImportedEnvironmentName(name, existingNames);
    const renamed = uniqueName !== name;

    const normalizedConfig = normalizeEnvConfig(envConfig);
    const configToSave: EnvConfig = { ...normalizedConfig };
    if (configToSave.ANTHROPIC_AUTH_TOKEN) {
      configToSave.ANTHROPIC_AUTH_TOKEN = encrypt(configToSave.ANTHROPIC_AUTH_TOKEN);
    }

    registries[uniqueName] = configToSave;
    existingNames.add(uniqueName);

    results.push({
      name: uniqueName,
      originalName: name,
      renamed,
    });
  }

  assertOfficialEnvironmentInvariant(registries);
  config.set('registries', registries);

  // 6. 输出结果
  console.log(chalk.green(`\nLoaded ${results.length} environment(s) from remote:`));
  for (const result of results) {
    if (result.renamed) {
      console.log(chalk.yellow(`  + ${result.originalName} → ${result.name} (renamed, local exists)`));
    } else {
      console.log(chalk.green(`  + ${result.name} (new)`));
    }
  }
  console.log(chalk.gray("\nRun 'ccem ls' to see all environments."));

  // 7. 返回本次导入结果
  return results;
};
