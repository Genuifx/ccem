import { describe, expect, it } from 'vitest';
import * as browserEntry from '../browser.js';
import {
  BUILTIN_CLAUDE_AGENT_NAMES,
  BUILTIN_ROUTER_PROFILES,
  DEFAULT_ONLY_ROUTER_PROFILE,
  DEFAULT_ROUTER_CONFIG,
  MY_DEFAULT_ROUTER_PROFILE_ID,
  createDefaultRouterConfig,
  isValidRouterBindingKey,
  isValidRouterEnvironmentAlias,
  findRouterEnvironmentReferences,
  normalizeRouterConfig,
  renameRouterEnvironmentReferences,
  validateRouterBindings,
} from '../index.js';

describe('router shared contract', () => {
  it('exports the router contract from both Node and browser entry points', () => {
    expect(browserEntry.DEFAULT_ROUTER_CONFIG).toEqual(DEFAULT_ROUTER_CONFIG);
    expect(browserEntry.MY_DEFAULT_ROUTER_PROFILE_ID).toBe('my-default');
    expect(MY_DEFAULT_ROUTER_PROFILE_ID).toBe('my-default');
    expect(browserEntry.isValidRouterBindingKey('subagent:Explore')).toBe(true);
  });

  it('uses the frozen v2.2 defaults without naming a user environment', () => {
    expect(DEFAULT_ROUTER_CONFIG).toEqual({
      port: 17820,
      bindings: {},
      profiles: [],
      dynamicRouting: true,
      defaultAllowedEnvs: [],
    });
    expect(JSON.stringify(DEFAULT_ROUTER_CONFIG)).not.toContain('official');
    expect(JSON.stringify(DEFAULT_ROUTER_CONFIG)).not.toContain('glm');
  });

  it('creates independent mutable default values', () => {
    const first = createDefaultRouterConfig();
    const second = createDefaultRouterConfig();

    first.bindings['subagent:Explore'] = 'local-test-env';
    first.defaultAllowedEnvs.push('local-test-env');

    expect(second).toEqual(DEFAULT_ROUTER_CONFIG);
    expect(DEFAULT_ROUTER_CONFIG).toEqual({
      port: 17820,
      bindings: {},
      profiles: [],
      dynamicRouting: true,
      defaultAllowedEnvs: [],
    });
  });

  it('strips legacy global enable and backend-owned capability flags from persisted router config', () => {
    const normalized = normalizeRouterConfig({
      enabled: true,
      oauthRoutingEnabled: true,
    } as unknown as Parameters<typeof normalizeRouterConfig>[0]);

    expect(normalized).not.toHaveProperty('enabled');
    expect(normalized).not.toHaveProperty('oauthRoutingEnabled');
  });

  it('only ships the environment-agnostic default-only profile', () => {
    expect(BUILTIN_ROUTER_PROFILES).toEqual([DEFAULT_ONLY_ROUTER_PROFILE]);
    expect(DEFAULT_ONLY_ROUTER_PROFILE).toMatchObject({
      id: 'default-only',
      revision: 1,
      bindings: {},
      allowedEnvs: [],
    });
    expect(JSON.stringify(BUILTIN_ROUTER_PROFILES)).not.toContain('official');
    expect(JSON.stringify(BUILTIN_ROUTER_PROFILES)).not.toContain('glm');
  });

  it('publishes the built-in Claude 2.1.220 Agent roster', () => {
    expect(BUILTIN_CLAUDE_AGENT_NAMES).toEqual([
      'claude',
      'Explore',
      'general-purpose',
      'Plan',
      'statusline-setup',
    ]);
  });
});

describe('router binding validation', () => {
  it.each([
    'a',
    'primary',
    'search-env_v2.1',
    'A'.repeat(64),
  ])('accepts dynamic environment alias %s', (envName) => {
    expect(isValidRouterEnvironmentAlias(envName)).toBe(true);
  });

  it.each([
    '',
    ' ',
    'search env',
    'search/env',
    '搜索',
    'A'.repeat(65),
    'search\nenv',
  ])('rejects dynamic environment alias %s', (envName) => {
    expect(isValidRouterEnvironmentAlias(envName)).toBe(false);
  });

  it.each([
    'background',
    'subagent:*',
    'subagent:Explore',
    'subagent:general-purpose',
    'subagent:superpowers:code-reviewer',
  ])('accepts %s', (key) => {
    expect(isValidRouterBindingKey(key)).toBe(true);
  });

  it.each([
    '',
    'main',
    'ccem:glm',
    'subagent:',
    'subagent: Explore',
    'subagent:Explore ',
    'subagent:my custom reviewer',
    `subagent:${'A'.repeat(129)}`,
    'subagent:Explore\nbackground',
    'subagent:Explore\u0000',
    'subagent:Explore</CCEM-ROUTE>',
    'subagent:<CCEM-ROUTE>ccem:secret</CCEM-ROUTE>',
  ])('rejects %s', (key) => {
    expect(isValidRouterBindingKey(key)).toBe(false);
  });

  it('validates binding keys while allowing any non-empty stored environment reference', () => {
    expect(validateRouterBindings({
      background: 'cheap-env',
      'subagent:Explore': '团队 Search / 日本',
    })).toEqual([]);

    expect(validateRouterBindings({
      main: 'default-env',
      'subagent:Plan': '',
    })).toEqual([
      "Invalid router binding key 'main'",
      "Router binding 'subagent:Plan' must target a non-empty environment reference",
    ]);
  });
});

describe('router config normalization', () => {
  it('fills missing fields without replacing provided values', () => {
    expect(normalizeRouterConfig({
      enabled: true,
      port: 18123,
      bindings: { 'subagent:Explore': 'search-env' },
      defaultAllowedEnvs: ['main-env', 'search-env', 'main-env'],
    } as unknown as Parameters<typeof normalizeRouterConfig>[0])).toEqual({
      port: 18123,
      bindings: { 'subagent:Explore': 'search-env' },
      profiles: [],
      dynamicRouting: true,
      defaultAllowedEnvs: ['main-env', 'search-env'],
    });
  });

  it('clones nested values and preserves user-defined profiles', () => {
    const input = {
      profiles: [{
        id: 'budget',
        name: 'Budget',
        revision: 3,
        bindings: { background: 'cheap-env' },
        allowedEnvs: ['main-env', 'cheap-env'],
      }],
    };

    const normalized = normalizeRouterConfig(input);
    input.profiles[0].bindings.background = 'changed-after-normalize';

    expect(normalized.profiles).toEqual([{
      id: 'budget',
      name: 'Budget',
      revision: 3,
      bindings: { background: 'cheap-env' },
      allowedEnvs: ['main-env', 'cheap-env'],
    }]);
  });

  it('preserves non-alias environment references in bindings, profiles, and allowed lists', () => {
    const longEnvironmentName = 'A'.repeat(65);

    expect(normalizeRouterConfig({
      bindings: { background: '团队 Search / 日本' },
      defaultAllowedEnvs: ['团队 Search / 日本', longEnvironmentName],
      profiles: [{
        id: 'legacy-names',
        name: 'Legacy names',
        revision: 1,
        bindings: { 'subagent:Explore': longEnvironmentName },
        allowedEnvs: [longEnvironmentName],
      }],
    })).toMatchObject({
      bindings: { background: '团队 Search / 日本' },
      defaultAllowedEnvs: ['团队 Search / 日本', longEnvironmentName],
    });
  });

  it('fails closed for invalid ports, profiles, bindings, and empty references', () => {
    expect(() => normalizeRouterConfig({ port: 0 })).toThrow(/port/i);
    expect(() => normalizeRouterConfig({
      bindings: { main: 'env' },
    })).toThrow(/binding key/i);
    expect(() => normalizeRouterConfig({
      bindings: { background: '' },
    })).toThrow(/non-empty environment reference/i);
    expect(() => normalizeRouterConfig({
      defaultAllowedEnvs: [''],
    })).toThrow(/non-empty environment references/i);
    expect(() => normalizeRouterConfig({
      profiles: [{
        id: 'broken',
        name: '',
        revision: -1,
        bindings: {},
        allowedEnvs: [''],
      }],
    })).toThrow(/profile/i);
    for (const reservedId of ['default-only', 'my-default']) {
      expect(() => normalizeRouterConfig({
        profiles: [{
          id: reservedId,
          name: 'Must not shadow built-ins',
          revision: 1,
          bindings: {},
          allowedEnvs: [],
        }],
      })).toThrow(/reserved/i);
    }
  });
});

describe('router environment references', () => {
  const router = normalizeRouterConfig({
    bindings: {
      background: 'legacy',
      'subagent:Explore': 'search',
    },
    defaultAllowedEnvs: ['primary', 'legacy'],
    profiles: [{
      id: 'focused',
      name: 'Focused',
      revision: 2,
      bindings: { 'subagent:Plan': 'legacy' },
      allowedEnvs: ['legacy', 'primary'],
    }],
  });

  it('finds every persisted router reference with stable locations', () => {
    expect(findRouterEnvironmentReferences(router, 'legacy')).toEqual([
      'router.bindings.background',
      'router.defaultAllowedEnvs',
      'router.profiles[focused].bindings.subagent:Plan',
      'router.profiles[focused].allowedEnvs',
    ]);
  });

  it('renames every reference without mutating input and deduplicates allowlists', () => {
    const renamed = renameRouterEnvironmentReferences(router, 'legacy', 'primary');

    expect(findRouterEnvironmentReferences(renamed, 'legacy')).toEqual([]);
    expect(renamed.bindings.background).toBe('primary');
    expect(renamed.defaultAllowedEnvs).toEqual(['primary']);
    expect(renamed.profiles[0]).toMatchObject({
      revision: 3,
      bindings: { 'subagent:Plan': 'primary' },
      allowedEnvs: ['primary'],
    });
    expect(router.bindings.background).toBe('legacy');
  });

  it('saturates a renamed profile revision at the safe integer maximum', () => {
    const renamed = renameRouterEnvironmentReferences({
      ...router,
      profiles: [{ ...router.profiles[0], revision: Number.MAX_SAFE_INTEGER }],
    }, 'legacy', 'primary');

    expect(renamed.profiles[0].revision).toBe(Number.MAX_SAFE_INTEGER);
  });
});
