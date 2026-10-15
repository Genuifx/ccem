import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureCcemAgentHome, getCcemAgentHome } from '@ccem/core';

// Encryption setup
const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = crypto.scryptSync('claude-code-env-manager-secret', 'salt', 32);

export const encrypt = (text: string): string => {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `enc:${iv.toString('hex')}:${encrypted}`;
};

export const decrypt = (text: string): string => {
  if (!text || !text.startsWith('enc:')) return text;
  try {
    const parts = text.split(':');
    if (parts.length !== 3) return text;
    const iv = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
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
 * 获取 CCEM 专属 Claude 配置文件路径
 */
export const getGlobalClaudeConfigPath = (): string => {
  return path.join(getCcemAgentHome('claude'), '.claude.json');
};

/**
 * 获取 CCEM 专属 Claude settings 文件路径
 */
export const getGlobalClaudeSettingsPath = (): string => {
  return path.join(getCcemAgentHome('claude'), 'settings.json');
};

/**
 * 确保 CCEM 专属 Claude 目录存在
 */
export const ensureGlobalClaudeDir = (): string => {
  return ensureCcemAgentHome('claude');
};
