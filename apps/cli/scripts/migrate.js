#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();

// 新配置路径
const newConfigDir = path.join(home, '.ccem');
const newConfigPath = path.join(newConfigDir, 'config.json');

// 旧配置路径
const legacyConfigPath = process.platform === 'darwin'
  ? path.join(home, 'Library', 'Preferences', 'claude-code-env-manager-nodejs', 'config.json')
  : path.join(home, '.config', 'claude-code-env-manager-nodejs', 'config.json');

const OFFICIAL_ENV_NAME = 'official';
const TRUSTED_OFFICIAL_BASE_URLS = new Set([
  'https://api.anthropic.com',
  'https://api.anthropic.com/',
]);
const DEFAULT_OFFICIAL_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
  ANTHROPIC_MODEL: 'opus',
};

function prepareMigratedConfig(content) {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('legacy config must be an object');
  }
  if (!parsed.registries || typeof parsed.registries !== 'object' || Array.isArray(parsed.registries)) {
    parsed.registries = {};
  }
  if (!Object.prototype.hasOwnProperty.call(parsed.registries, OFFICIAL_ENV_NAME)) {
    parsed.registries[OFFICIAL_ENV_NAME] = { ...DEFAULT_OFFICIAL_ENV };
  }
  const official = parsed.registries[OFFICIAL_ENV_NAME];
  if (
    !official
    || typeof official !== 'object'
    || Array.isArray(official)
    || !TRUSTED_OFFICIAL_BASE_URLS.has(official.ANTHROPIC_BASE_URL)
  ) {
    throw new Error('protected official environment has an untrusted endpoint');
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function migrate() {
  // 如果新配置已存在，跳过迁移
  if (fs.existsSync(newConfigPath)) {
    return;
  }

  // 如果旧配置不存在，跳过迁移
  if (!fs.existsSync(legacyConfigPath)) {
    return;
  }

  try {
    // 确保新目录存在
    if (!fs.existsSync(newConfigDir)) {
      fs.mkdirSync(newConfigDir, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') fs.chmodSync(newConfigDir, 0o700);

    // Validate the protected environment before creating the destination.
    const migrated = prepareMigratedConfig(fs.readFileSync(legacyConfigPath, 'utf-8'));
    fs.writeFileSync(newConfigPath, migrated, { flag: 'wx', mode: 0o600 });
    console.log('CCEM: 配置已迁移到 ~/.ccem/');
  } catch (err) {
    // 静默失败，不阻塞安装
    console.warn('CCEM: 配置迁移失败，请手动运行 ccem setup migrate');
  }
}

migrate();
