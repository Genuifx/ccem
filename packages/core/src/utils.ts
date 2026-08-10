import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  decryptParsedV2Ciphertext,
  encryptV2WithKey,
  parseV2Ciphertext,
} from './crypto-v2-internal.js';

// Legacy key (for migration decryption only — hardcoded, same as pre-v2)
const LEGACY_ALGORITHM = 'aes-256-cbc';
const LEGACY_KEY = crypto.scryptSync('claude-code-env-manager-secret', 'salt', 32);

// v2 encryption: AES-256-GCM with per-install random key
let _installKey: Buffer | null = null;

/**
 * Get or create the per-install encryption key from ~/.ccem/.install-key.
 * The key is 32 random bytes, stored hex-encoded with mode 0600.
 * Shared between CLI and desktop since both use the same ~/.ccem/ directory.
 */
function getOrCreateInstallKey(): Buffer {
  if (_installKey) return _installKey;

  const keyPath = path.join(getCcemConfigDir(), '.install-key');
  if (fs.existsSync(keyPath)) {
    _installKey = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'hex');
    return _installKey;
  }

  // Create directory if needed, then write new key
  ensureCcemDir();
  _installKey = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, _installKey.toString('hex'), { mode: 0o600 });
  return _installKey;
}

/**
 * Encrypt plaintext using AES-256-GCM with the install-bound key.
 * Format: enc:v2:<nonce_hex>:<ciphertext_hex>:<auth_tag_hex>
 */
export const encrypt = (text: string): string => {
  if (!text) return text;
  return encryptV2WithKey(text, getOrCreateInstallKey(), crypto.randomBytes(12));
};

/**
 * Decrypt ciphertext. Auto-detects v2 (AES-256-GCM) vs legacy (AES-256-CBC).
 * Legacy format is kept solely for migration; on next save it gets re-encrypted as v2.
 */
export const decrypt = (text: string): string => {
  if (!text || !text.startsWith('enc:')) return text;

  // v2 format: enc:v2:nonce_hex:ciphertext_hex:tag_hex
  if (text.startsWith('enc:v2:')) {
    const parsed = parseV2Ciphertext(text);

    try {
      return decryptParsedV2Ciphertext(parsed, getOrCreateInstallKey());
    } catch {
      // AEAD auth tag failure = tampered data or wrong key.
      // Must NOT return the ciphertext as plaintext — that would silently
      // use a tampered/invalid value as the actual token.
      throw new Error('Failed to decrypt enc:v2: data (tampered or wrong install key)');
    }
  }

  // Legacy format: enc:iv_hex:ciphertext_hex (AES-256-CBC with hardcoded key)
  try {
    const parts = text.split(':');
    if (parts.length !== 3) return text;
    const iv = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, LEGACY_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return text;
  }
};

/**
 * 查找项目根目录（包含 .git 或 package.json 的目录）
 */
export const findProjectRoot = (): string => {
  let currentDir = process.cwd();
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    if (
      fs.existsSync(path.join(currentDir, '.git')) ||
      fs.existsSync(path.join(currentDir, 'package.json'))
    ) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  // 未找到项目标记，使用当前目录
  return process.cwd();
};

/**
 * 获取 Claude Code settings 文件路径
 */
export const getSettingsPath = (useLocal: boolean = true): string => {
  const projectRoot = findProjectRoot();
  const claudeDir = path.join(projectRoot, '.claude');
  const filename = useLocal ? 'settings.local.json' : 'settings.json';
  return path.join(claudeDir, filename);
};

/**
 * 确保 .claude 目录存在
 */
export const ensureClaudeDir = (): string => {
  const projectRoot = findProjectRoot();
  const claudeDir = path.join(projectRoot, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  return claudeDir;
};

/**
 * 获取用户主目录
 */
export const getHomeDir = (): string => {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || '';
};

/**
 * 获取全局 Claude 配置文件路径 (~/.claude.json)
 */
export const getGlobalClaudeConfigPath = (): string => {
  return path.join(getHomeDir(), '.claude.json');
};

/**
 * 获取全局 Claude settings 文件路径 (~/.claude/settings.json)
 */
export const getGlobalClaudeSettingsPath = (): string => {
  return path.join(getHomeDir(), '.claude', 'settings.json');
};

/**
 * 确保全局 ~/.claude 目录存在
 */
export const ensureGlobalClaudeDir = (): string => {
  const claudeDir = path.join(getHomeDir(), '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  return claudeDir;
};

/**
 * CCEM 配置目录路径 (~/.ccem/)
 */
export const getCcemConfigDir = (): string => {
  return path.join(getHomeDir(), '.ccem');
};

/**
 * CCEM 主配置文件路径 (~/.ccem/config.json)
 */
export const getCcemConfigPath = (): string => {
  return path.join(getCcemConfigDir(), 'config.json');
};

/**
 * 确保 ~/.ccem 目录存在
 */
export const ensureCcemDir = (): string => {
  const ccemDir = getCcemConfigDir();
  if (!fs.existsSync(ccemDir)) {
    fs.mkdirSync(ccemDir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(ccemDir, 0o700);
  }
  return ccemDir;
};

/**
 * 获取旧配置路径 (conf 包默认路径)
 * macOS: ~/Library/Preferences/claude-code-env-manager-nodejs/config.json
 * Linux: ~/.config/claude-code-env-manager-nodejs/config.json
 */
export const getLegacyConfigPath = (): string => {
  const home = getHomeDir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Preferences', 'claude-code-env-manager-nodejs', 'config.json');
  }
  return path.join(home, '.config', 'claude-code-env-manager-nodejs', 'config.json');
};
