import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Smoke test for packages/server/scripts/pack-metabot.sh.
//
// The script reaches up from packages/server/scripts/ to the repo root, so we
// invoke it as-is but redirect outputs into a temporary directory. Packaging
// tests must never overwrite the real publishable artifacts.

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const SCRIPT = path.join(PKG_DIR, 'scripts', 'pack-metabot.sh');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-pack-test-'));
const TARBALL_PATH = path.join(OUT_DIR, 'latest.tgz');
const BOOTSTRAP_PATH = path.join(OUT_DIR, 'install.sh');

let tarListing: string = '';

beforeAll(() => {
  execSync(`bash ${JSON.stringify(SCRIPT)}`, {
    env: {
      ...process.env,
      METABOT_PACK_OUTPUT_DIR: OUT_DIR,
    },
    stdio: 'pipe',
    // Pack script writes a few lines to stdout; capture them for failure
    // diagnostics but don't pollute test output on success.
  });
  tarListing = execSync(`tar tzf ${JSON.stringify(TARBALL_PATH)}`, { encoding: 'utf-8' });
}, 60_000);

afterAll(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
});

describe('pack-metabot.sh', () => {
  it('publishes a non-empty gzip tarball at static/install/latest.tgz', () => {
    expect(fs.existsSync(TARBALL_PATH)).toBe(true);
    const stat = fs.statSync(TARBALL_PATH);
    expect(stat.size).toBeGreaterThan(1024);
    // gzip magic — atomic-rename target landed.
    const head = fs.readFileSync(TARBALL_PATH).subarray(0, 2);
    expect(head[0]).toBe(0x1f);
    expect(head[1]).toBe(0x8b);
  });

  it('publishes the bootstrap install.sh at static/install/install.sh', () => {
    expect(fs.existsSync(BOOTSTRAP_PATH)).toBe(true);
    const head = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8').slice(0, 20);
    expect(head.startsWith('#!/usr/bin/env bash')).toBe(true);
    const mode = fs.statSync(BOOTSTRAP_PATH).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  it('bootstrap always extracts the tarball (no .git delegation that would `git pull` stale GitHub mirrors)', () => {
    const src = fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');
    // Look at non-comment lines only — explanatory prose may mention these
    // patterns even when the active code doesn't.
    const codeOnly = src
      .split('\n')
      .map((l) => l.replace(/(^|[^\\])#.*$/, '$1'))
      .filter((l) => l.trim().length > 0)
      .join('\n');

    // Active code must set the env gate so install.sh skips Phase 2 entirely.
    expect(codeOnly).toMatch(/export\s+METABOT_SKIP_GIT=1/);
    // No code path may delegate to the in-tree install.sh based on .git/ — that
    // would send GitHub-clone users into a stale-mirror git pull.
    expect(codeOnly).not.toMatch(
      /-d\s+"\$METABOT_HOME\/\.git"[\s\S]{0,200}exec\s+bash\s+"\$METABOT_HOME\/install\.sh"/,
    );
    // `--keep-newer-files` is a footgun with our deterministic
    // `--mtime='UTC 2026-01-01'`: local files modified after that date
    // silently survive, defeating the overlay refresh.
    expect(codeOnly).not.toContain('--keep-newer-files');
  });

  it('packaged install builds only the bridge runtime and the delegated CLI', () => {
    const installSh = execSync(`tar xOf ${JSON.stringify(TARBALL_PATH)} install.sh`, { encoding: 'utf-8' });
    expect(installSh).toContain('npm run build:bridge');
    expect(installSh).toContain('npm run build -w @xvirobotics/cli');
    expect(installSh).not.toContain('npm run build --workspaces');
  });

  it('rewrites root manifests for the runtime-only workspace subset', () => {
    const packageJson = execSync(`tar xOf ${JSON.stringify(TARBALL_PATH)} package.json`, { encoding: 'utf-8' });
    const pkg = JSON.parse(packageJson);
    expect(pkg.scripts.build).toBe('npm run build:bridge');
    expect(pkg.scripts['build:web']).toBeUndefined();
    expect(pkg.metabotEdition).toBeUndefined();
    expect(pkg.workspaces).toEqual(['packages/cli', 'packages/cli-core', 'packages/metamemory', 'packages/skill-hub']);

    const tsconfigJson = execSync(`tar xOf ${JSON.stringify(TARBALL_PATH)} tsconfig.json`, { encoding: 'utf-8' });
    const tsconfig = JSON.parse(tsconfigJson);
    const references = tsconfig.references.map((ref: { path: string }) => ref.path);
    expect(references).toContain('./tsconfig.bridge.json');
    expect(references).not.toContain('./packages/server');
    expect(references).not.toContain('./packages/web-ui');
  });

  it('embeds a non-sensitive runtime package manifest', () => {
    expect(tarListing).toContain('.metabot-package/manifest.json');
    const json = execSync(`tar xOf ${JSON.stringify(TARBALL_PATH)} .metabot-package/manifest.json`, {
      encoding: 'utf-8',
    });
    const manifest = JSON.parse(json);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      package: 'metabot-runtime',
      channel: 'install',
    });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('tarball includes the bot-host runtime entrypoints', () => {
    // Phase 2 / 3 entry points the bootstrap exec's into.
    expect(tarListing).toMatch(/(^|\n)\.?\/?install\.sh\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?ecosystem\.config\.cjs\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?package\.json\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?package-lock\.json\b/);
    expect(tarListing).toMatch(/(^|\n)\.?\/?bin\/metabot\b/);
  });

  it('tarball includes the four bot-host workspaces', () => {
    for (const ws of ['cli', 'cli-core', 'metamemory', 'skill-hub']) {
      expect(tarListing).toContain(`packages/${ws}/package.json`);
    }
  });

  it('tarball includes the packaged skill bundles', () => {
    expect(tarListing).toContain('packages/skills/metabot/SKILL.md');
    expect(tarListing).toContain('packages/skills/metabot-team/SKILL.md');
    for (const reference of ['memory', 'skills', 'agents', 't5t', 'runtime']) {
      expect(tarListing).toContain(`packages/skills/metabot/references/${reference}.md`);
    }
    expect(tarListing).not.toContain('packages/skills/metabot/README.md');
    expect(tarListing).not.toContain('packages/skills/metabot-team/README.md');
    expect(tarListing).not.toContain('src/skills/metabot-team/');
  });

  it('tarball includes engine sources without workspace or retired Skill mirrors', () => {
    expect(tarListing).toMatch(/(^|\n)\.?\/?src\//);
    expect(tarListing).not.toContain('src/skills/voice/');
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?AGENTS\.md$/m);
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?CLAUDE\.md$/m);
    expect(tarListing).not.toContain('src/workspace/');
  });

  it('packaged MetaBot Skills contain CLI definitions without workspace policy', () => {
    const bundle = [
      fs.readFileSync(path.join(REPO_ROOT, 'packages/skills/metabot/SKILL.md'), 'utf-8'),
      fs.readFileSync(path.join(REPO_ROOT, 'packages/skills/metabot-team/SKILL.md'), 'utf-8'),
    ].join('\n');
    expect(bundle).not.toMatch(/\b(?:subagent|spawn_agent|harness)\b/i);
    expect(bundle).not.toMatch(/\b(?:code review|ci\/cd|pull request)\b/i);
    expect(bundle).toContain('CLI and durable-state');
    expect(bundle).toContain('does not define Agent execution policy');
  });

  it('tarball excludes central-only workspaces (server, web-ui)', () => {
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?packages\/server\//);
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?packages\/web-ui\//);
  });

  it('tarball excludes build artifacts and vcs dirs', () => {
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?node_modules\//);
    expect(tarListing).not.toMatch(/(^|\n|\/)dist\//);
    expect(tarListing).not.toMatch(/(^|\n)\.?\/?\.git\//);
    expect(tarListing).not.toMatch(/\.tsbuildinfo\b/);
  });

  it('does not embed an internal default env unless explicitly requested', () => {
    expect(tarListing).not.toContain('.metabot-package/default.env');
  });

  it('can embed an internal default env when the pack env var is set', () => {
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'metabot-pack-secret-'));
    const secretPath = path.join(tmpDir, 'default.env');
    fs.writeFileSync(secretPath, 'METABOT_VOICE_REPLY_DEFAULT_ON=true\nVOLCENGINE_TTS_APPID=test-app\n');

    try {
      execSync(`bash ${JSON.stringify(SCRIPT)}`, {
        env: {
          ...process.env,
          METABOT_PACKAGE_DEFAULT_ENV_FILE: secretPath,
          METABOT_PACK_OUTPUT_DIR: OUT_DIR,
        },
        stdio: 'pipe',
      });
      const listing = execSync(`tar tzf ${JSON.stringify(TARBALL_PATH)}`, { encoding: 'utf-8' });
      expect(listing).toContain('.metabot-package/default.env');
      const content = execSync(`tar xOf ${JSON.stringify(TARBALL_PATH)} .metabot-package/default.env`, {
        encoding: 'utf-8',
      });
      expect(content).toContain('METABOT_VOICE_REPLY_DEFAULT_ON=true');
      expect(content).toContain('VOLCENGINE_TTS_APPID=test-app');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
