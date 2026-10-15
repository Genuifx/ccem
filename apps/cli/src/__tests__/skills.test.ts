import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SKILL_PRESETS,
  SKILL_GROUPS,
  getSkillsByGroup,
  getGroupOrder,
  parseGitHubUrl,
  getSkillsDir,
  ensureSkillsDir,
  downloadSkillWithGit,
  installFromPluginMarketplace,
  listInstalledSkills,
  removeSkill,
} from '../skills.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('skills', () => {
  let tempDir: string;
  const execFileSyncMock = execFileSync as unknown as Mock;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-skills-test-')));
    vi.stubEnv('HOME', tempDir);
    vi.stubEnv('CCEM_AGENT_HOME', path.join(tempDir, 'agents'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('SKILL_PRESETS', () => {
    it('should have official skills', () => {
      const official = SKILL_PRESETS.filter(s => s.group === 'official');
      expect(official.length).toBeGreaterThan(0);
    });

    it('should have featured skills', () => {
      const featured = SKILL_PRESETS.filter(s => s.group === 'featured');
      expect(featured.length).toBeGreaterThan(0);
    });

    it('should have valid structure for all presets', () => {
      for (const preset of SKILL_PRESETS) {
        expect(preset.name).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(['official', 'featured', 'others']).toContain(preset.group);
        expect(preset.install).toBeDefined();
        expect(['preset', 'github', 'plugin']).toContain(preset.install.type);
      }
    });
  });

  describe('SKILL_GROUPS', () => {
    it('should have all group metadata', () => {
      expect(SKILL_GROUPS.official).toBeDefined();
      expect(SKILL_GROUPS.official.label).toBe('官方');
      expect(SKILL_GROUPS.featured).toBeDefined();
      expect(SKILL_GROUPS.others).toBeDefined();
    });
  });

  describe('getSkillsByGroup', () => {
    it('should filter skills by group', () => {
      const official = getSkillsByGroup('official');
      expect(official.every(s => s.group === 'official')).toBe(true);

      const featured = getSkillsByGroup('featured');
      expect(featured.every(s => s.group === 'featured')).toBe(true);
    });
  });

  describe('getGroupOrder', () => {
    it('should return groups in correct order', () => {
      const order = getGroupOrder();
      expect(order).toEqual(['official', 'featured', 'others']);
    });
  });

  describe('parseGitHubUrl', () => {
    it('should parse short format owner/repo', () => {
      const result = parseGitHubUrl('anthropics/skills');
      expect(result).toEqual({
        owner: 'anthropics',
        repo: 'skills',
        branch: 'main',
        path: '',
      });
    });

    it('should parse full GitHub URL', () => {
      const result = parseGitHubUrl('https://github.com/anthropics/skills');
      expect(result).toEqual({
        owner: 'anthropics',
        repo: 'skills',
        branch: 'main',
        path: '',
      });
    });

    it('should parse URL with tree/branch/path', () => {
      const result = parseGitHubUrl(
        'https://github.com/anthropics/skills/tree/main/skills/frontend-design'
      );
      expect(result).toEqual({
        owner: 'anthropics',
        repo: 'skills',
        branch: 'main',
        path: 'skills/frontend-design',
      });
    });

    it('should parse URL with different branch', () => {
      const result = parseGitHubUrl(
        'https://github.com/owner/repo/tree/develop/src/path'
      );
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        branch: 'develop',
        path: 'src/path',
      });
    });

    it('should return null for invalid URL', () => {
      expect(parseGitHubUrl('invalid-url')).toBeNull();
      expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
    });

    it('should handle .git suffix', () => {
      const result = parseGitHubUrl('https://github.com/owner/repo.git');
      expect(result?.repo).toBe('repo');
    });

    it('should reject URLs that only contain github.com in an unsafe host or path', () => {
      expect(parseGitHubUrl('https://evil.test/github.com/owner/repo')).toBeNull();
      expect(parseGitHubUrl('https://github.com.evil.test/owner/repo')).toBeNull();
    });

    it('should reject shell metacharacters and whitespace in GitHub URL parts', () => {
      expect(parseGitHubUrl('https://github.com/owner/repo;touch')).toBeNull();
      expect(parseGitHubUrl('https://github.com/owner/repo/tree/main;rm/skills/foo')).toBeNull();
      expect(parseGitHubUrl('owner/repo name')).toBeNull();
    });

    it('should reject unsafe repository paths', () => {
      expect(parseGitHubUrl('https://github.com/owner/repo/tree/main/../secret')).toBeNull();
      expect(parseGitHubUrl('https://github.com/owner/repo/tree/main//secret')).toBeNull();
      expect(parseGitHubUrl('https://github.com/owner/repo/tree/main//')).toBeNull();
    });
  });

  describe('getSkillsDir', () => {
    it('should return .claude/skills path relative to cwd', () => {
      const result = getSkillsDir();
      expect(result).toBe(path.join(tempDir, '.claude', 'skills'));
    });
  });

  describe('ensureSkillsDir', () => {
    it('should create skills directory if not exists', () => {
      const result = ensureSkillsDir();
      expect(result).toBe(path.join(tempDir, '.claude', 'skills'));
      expect(fs.existsSync(result)).toBe(true);
    });

    it('should return existing skills directory', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });

      const result = ensureSkillsDir();
      expect(result).toBe(skillsDir);
    });

    it('should clean up temp directories', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(path.join(skillsDir, '.tmp-12345'));

      ensureSkillsDir();

      expect(fs.existsSync(path.join(skillsDir, '.tmp-12345'))).toBe(false);
    });
  });

  describe('listInstalledSkills', () => {
    it('should return empty array if skills dir not exists', () => {
      const result = listInstalledSkills();
      expect(result).toEqual([]);
    });

    it('should list installed skills', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(path.join(skillsDir, 'skill-a'));
      fs.mkdirSync(path.join(skillsDir, 'skill-b'));

      const result = listInstalledSkills();
      expect(result.length).toBe(2);
      expect(result.map(s => s.name)).toContain('skill-a');
      expect(result.map(s => s.name)).toContain('skill-b');
    });

    it('should ignore hidden directories', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(path.join(skillsDir, 'visible-skill'));
      fs.mkdirSync(path.join(skillsDir, '.hidden-dir'));

      const result = listInstalledSkills();
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('visible-skill');
    });
  });

  describe('removeSkill', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('should return false for non-existent skill', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });

      const result = removeSkill('non-existent');
      expect(result).toBe(false);
    });

    it('should remove existing skill', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      const skillPath = path.join(skillsDir, 'test-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, 'skill.md'), 'content');

      const result = removeSkill('test-skill');
      expect(result).toBe(true);
      expect(fs.existsSync(skillPath)).toBe(false);
    });

    it('should reject path traversal without deleting outside skills dir', () => {
      const outsidePath = path.join(tempDir, '.claude', 'outside-skill');
      fs.mkdirSync(outsidePath, { recursive: true });
      fs.writeFileSync(path.join(outsidePath, 'skill.md'), 'content');

      const result = removeSkill('../outside-skill');

      expect(result).toBe(false);
      expect(fs.existsSync(outsidePath)).toBe(true);
    });

    it('should reject absolute paths without deleting outside skills dir', () => {
      const outsidePath = path.join(tempDir, 'outside-skill');
      fs.mkdirSync(outsidePath, { recursive: true });
      fs.writeFileSync(path.join(outsidePath, 'skill.md'), 'content');

      const result = removeSkill(outsidePath);

      expect(result).toBe(false);
      expect(fs.existsSync(outsidePath)).toBe(true);
    });

    it('should reject names with path separators', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      const slashPath = path.join(skillsDir, 'parent', 'child');
      fs.mkdirSync(slashPath, { recursive: true });

      const slashResult = removeSkill('parent/child');
      const backslashResult = removeSkill('parent\\child');

      expect(slashResult).toBe(false);
      expect(backslashResult).toBe(false);
      expect(fs.existsSync(slashPath)).toBe(true);
    });

    it('should reject blank skill names', () => {
      const result = removeSkill('   ');

      expect(result).toBe(false);
    });

    it('should reject hidden directory names without deleting them', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      const hiddenPath = path.join(skillsDir, '.hidden-skill');
      fs.mkdirSync(hiddenPath, { recursive: true });

      const result = removeSkill('.hidden-skill');

      expect(result).toBe(false);
      expect(fs.existsSync(hiddenPath)).toBe(true);
    });

    it('should reject symlinks that resolve outside skills dir', () => {
      const skillsDir = path.join(tempDir, '.claude', 'skills');
      const outsidePath = path.join(tempDir, 'outside-target');
      const linkPath = path.join(skillsDir, 'linked-skill');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(outsidePath, { recursive: true });

      try {
        fs.symlinkSync(outsidePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return;
      }

      const result = removeSkill('linked-skill');

      expect(result).toBe(false);
      expect(fs.existsSync(linkPath)).toBe(true);
      expect(fs.existsSync(outsidePath)).toBe(true);
    });
  });

  describe('downloadSkillWithGit', () => {
    it('should call git with argv arrays and safe branch/path values', () => {
      const result = downloadSkillWithGit(
        'owner',
        'repo',
        'feature/safe-branch',
        'skills/test-skill',
        'test-skill'
      );

      expect(result).toBe(false);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'git',
        ['init'],
        expect.objectContaining({ stdio: 'pipe' })
      );
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'git',
        ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'],
        expect.objectContaining({ stdio: 'pipe' })
      );
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'git',
        ['pull', '--depth=1', 'origin', 'feature/safe-branch'],
        expect.objectContaining({ stdio: 'pipe' })
      );
      for (const call of execFileSyncMock.mock.calls) {
        expect(call[0]).toBe('git');
        expect(Array.isArray(call[1])).toBe(true);
      }
    });

    it('should reject unsafe git parameters before running a process', () => {
      expect(downloadSkillWithGit('owner', 'repo', 'main;rm -rf /', 'skills/foo', 'foo')).toBe(false);
      expect(downloadSkillWithGit('owner', 'repo', 'main', '../secret', 'foo')).toBe(false);
      expect(downloadSkillWithGit('owner', 'repo', 'main', 'skills/foo', '../foo')).toBe(false);

      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('installFromPluginMarketplace', () => {
    it('should call claude with argv arrays for marketplace installation', () => {
      execFileSyncMock.mockReturnValue(''); // Empty process inventory during first-use migration.
      const result = installFromPluginMarketplace(
        'obra/superpowers-marketplace',
        'superpowers@superpowers-marketplace'
      );

      expect(result).toBe(true);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'claude',
        ['plugin', 'marketplace', 'add', 'obra/superpowers-marketplace'],
        expect.objectContaining({ stdio: 'inherit', env: expect.objectContaining({ CLAUDE_CONFIG_DIR: path.join(tempDir, 'agents', 'claude') }) })
      );
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'claude',
        ['plugin', 'install', 'superpowers@superpowers-marketplace'],
        expect.objectContaining({ stdio: 'inherit', env: expect.objectContaining({ CLAUDE_CONFIG_DIR: path.join(tempDir, 'agents', 'claude') }) })
      );
      for (const call of execFileSyncMock.mock.calls.filter((call) => call[0] !== 'ps')) {
        expect(call[0]).toBe('claude');
        expect(Array.isArray(call[1])).toBe(true);
      }
    });

    it('should reject unsafe marketplace and package values before running a process', () => {
      expect(installFromPluginMarketplace('obra/superpowers-marketplace;rm', 'superpowers')).toBe(false);
      expect(installFromPluginMarketplace('obra/superpowers-marketplace', '../superpowers')).toBe(false);
      expect(installFromPluginMarketplace('/absolute/marketplace', 'superpowers')).toBe(false);

      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });
});
