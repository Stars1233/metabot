import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkillsToWorkDir } from '../src/api/skills-installer.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
} as any;

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe('skills installer', () => {
  it('keeps MetaBot Skills global-only and does not create workspace instructions', () => {
    const priorHome = process.env.HOME;
    const home = tempDir('metabot-home-');
    const workDir = tempDir('metabot-work-');
    try {
      process.env.HOME = home;
      installSkillsToWorkDir(workDir, logger);

      for (const root of ['.claude/skills', '.codex/skills', '.agents/skills']) {
        for (const skill of ['metabot', 'metabot-team', 'voice']) {
          expect(existsSync(join(workDir, root, skill))).toBe(false);
        }
      }
      expect(existsSync(join(workDir, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(workDir, 'CLAUDE.md'))).toBe(false);
      expect(existsSync(join(workDir, '.metabot/workspace-harness.sha256'))).toBe(false);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });

  it('leaves workspace instruction files untouched and retires only obsolete bookkeeping', () => {
    const workDir = tempDir('metabot-instructions-');
    writeFileSync(join(workDir, 'AGENTS.md'), 'codex rules\n');
    writeFileSync(join(workDir, 'CLAUDE.md'), 'claude rules\n');
    mkdirSync(join(workDir, '.metabot'), { recursive: true });
    writeFileSync(join(workDir, '.metabot/workspace-harness.sha256'), 'legacy-state\n');

    installSkillsToWorkDir(workDir, logger);

    expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf-8')).toBe('codex rules\n');
    expect(readFileSync(join(workDir, 'CLAUDE.md'), 'utf-8')).toBe('claude rules\n');
    expect(existsSync(join(workDir, '.metabot/workspace-harness.sha256'))).toBe(false);
  });

  it('retires project-level MetaBot mirrors into backups outside discovery roots', () => {
    const workDir = tempDir('metabot-mirrors-');
    const oldBundle = join(workDir, '.codex/skills/metabot');
    mkdirSync(oldBundle, { recursive: true });
    writeFileSync(join(oldBundle, 'SKILL.md'), 'custom old bundle\n');
    writeFileSync(join(oldBundle, 'local.md'), 'preserve me\n');

    installSkillsToWorkDir(workDir, logger);

    expect(existsSync(oldBundle)).toBe(false);
    const backupRoot = join(workDir, '.metabot/skill-backups');
    const backup = readdirSync(backupRoot).find((entry) => entry.startsWith('metabot.'));
    expect(backup).toBeTruthy();
    expect(readFileSync(join(backupRoot, backup!, 'SKILL.md'), 'utf-8')).toBe('custom old bundle\n');
    expect(readFileSync(join(backupRoot, backup!, 'local.md'), 'utf-8')).toBe('preserve me\n');
  });

  it('mirrors the minimal user-managed Lark profile to Claude, Codex, and Kimi roots', () => {
    const priorHome = process.env.HOME;
    const home = tempDir('metabot-lark-home-');
    const workDir = tempDir('metabot-lark-work-');
    try {
      process.env.HOME = home;
      for (const skill of ['lark-shared', 'lark-im', 'lark-doc']) {
        const source = join(home, '.agents/skills', skill);
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, 'SKILL.md'), `name: ${skill}\n`);
      }

      installSkillsToWorkDir(workDir, logger, { platform: 'feishu' });

      for (const root of ['.claude/skills', '.codex/skills', '.agents/skills']) {
        for (const skill of ['lark-shared', 'lark-im', 'lark-doc']) {
          expect(readFileSync(join(workDir, root, skill, 'SKILL.md'), 'utf-8')).toBe(`name: ${skill}\n`);
        }
      }
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
});
