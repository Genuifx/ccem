import { describe, expect, it, vi } from 'vitest';
import { normalizeRouterConfig, type CcemConfig } from '@ccem/core';
import {
  deleteEnvironmentFromConfig,
  deleteEnvironmentWithAuthority,
  renameEnvironmentInConfig,
  renameEnvironmentWithAuthority,
} from '../environmentMutations.js';

function sampleConfig(): CcemConfig {
  return {
    registries: {
      official: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      legacy: {
        ANTHROPIC_BASE_URL: 'https://partner.example.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'encrypted-token',
      },
    },
    current: 'legacy',
    defaultMode: 'dev',
    router: normalizeRouterConfig({
      bindings: { background: 'legacy' },
      defaultAllowedEnvs: ['official', 'legacy'],
      profiles: [{
        id: 'focused',
        name: 'Focused',
        revision: 1,
        bindings: { 'subagent:Explore': 'legacy' },
        allowedEnvs: ['official', 'legacy'],
      }],
    }),
  };
}

describe('CLI environment config mutations', () => {
  it('renames registry, current environment, and all router references in one value', () => {
    const original = sampleConfig();
    const renamed = renameEnvironmentInConfig(original, 'legacy', 'partner');

    expect(renamed.registries).toHaveProperty('partner');
    expect(renamed.registries).not.toHaveProperty('legacy');
    expect(renamed.current).toBe('partner');
    expect(renamed.router).toMatchObject({
      bindings: { background: 'partner' },
      defaultAllowedEnvs: ['official', 'partner'],
      profiles: [{
        revision: 2,
        bindings: { 'subagent:Explore': 'partner' },
        allowedEnvs: ['official', 'partner'],
      }],
    });
    expect(original.current).toBe('legacy');
    expect(original.router?.bindings.background).toBe('legacy');
  });

  it('rejects delete while any persisted router reference exists', () => {
    expect(() => deleteEnvironmentFromConfig(sampleConfig(), 'legacy'))
      .toThrow(/router\.bindings\.background/);
  });

  it('deletes an unreferenced environment and falls current back to official', () => {
    const config = sampleConfig();
    config.router = normalizeRouterConfig();

    const deleted = deleteEnvironmentFromConfig(config, 'legacy');
    expect(deleted.registries).not.toHaveProperty('legacy');
    expect(deleted.current).toBe('official');
  });
});

describe('environment mutation authority', () => {
  it('delegates rename and delete directly to Desktop whenever a descriptor exists', async () => {
    const renameRemote = vi.fn(async () => ({ operation: 'rename' as const }));
    const deleteRemote = vi.fn(async () => ({ operation: 'delete' as const }));
    const readLocalConfig = vi.fn(sampleConfig);

    await expect(renameEnvironmentWithAuthority(readLocalConfig, 'legacy', 'partner', {
      descriptorExists: () => true,
      stateExists: () => true,
      renameRemote,
    })).resolves.toEqual({ authority: 'desktop', result: { operation: 'rename' } });
    await expect(deleteEnvironmentWithAuthority(sampleConfig(), 'legacy', {
      descriptorExists: () => true,
      stateExists: () => true,
      deleteRemote,
    })).resolves.toEqual({ authority: 'desktop', result: { operation: 'delete' } });
    expect(renameRemote).toHaveBeenCalledWith('legacy', 'partner');
    expect(deleteRemote).toHaveBeenCalledWith('legacy');
    expect(readLocalConfig).not.toHaveBeenCalled();
  });

  it('does not fall back to local mutation when a Desktop RPC fails', async () => {
    await expect(renameEnvironmentWithAuthority(sampleConfig(), 'legacy', 'partner', {
      descriptorExists: () => true,
      stateExists: () => false,
      renameRemote: vi.fn(async () => { throw new Error('rpc failed'); }),
    })).rejects.toThrow('rpc failed');
  });

  it('fails closed when native state exists but Desktop is offline', async () => {
    const readLocalConfig = vi.fn(sampleConfig);
    await expect(deleteEnvironmentWithAuthority(readLocalConfig, 'legacy', {
      descriptorExists: () => false,
      stateExists: () => true,
    })).rejects.toThrow(/start CCEM Desktop|Desktop.*required/i);
    expect(readLocalConfig).not.toHaveBeenCalled();
  });

  it('uses the local atomic config mutation only when no native state exists', async () => {
    const result = await renameEnvironmentWithAuthority(sampleConfig(), 'legacy', 'partner', {
      descriptorExists: () => false,
      stateExists: () => false,
    });

    expect(result.authority).toBe('local');
    if (result.authority === 'local') {
      expect(result.config.registries).toHaveProperty('partner');
      expect(result.config.router?.bindings.background).toBe('partner');
    }
  });
});
