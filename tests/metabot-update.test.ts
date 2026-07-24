import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METABOT_BIN = path.join(REPO_ROOT, 'bin', 'metabot');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-update-test-'));
}

describe('metabot update source selection', () => {
  it('uses the GitHub Release installer for package-managed installs', () => {
    const tmp = makeTempDir();
    const fakeBin = path.join(tmp, 'bin');
    const metabotHome = path.join(tmp, 'metabot');
    const marker = path.join(tmp, 'marker.txt');
    const releaseEnv = path.join(tmp, 'release-env.txt');
    const curlArgs = path.join(tmp, 'curl-args.txt');

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(metabotHome, { recursive: true });
    fs.mkdirSync(path.join(metabotHome, '.git'), { recursive: true });
    fs.mkdirSync(path.join(metabotHome, '.metabot-package'), { recursive: true });
    fs.writeFileSync(
      path.join(metabotHome, '.metabot-package', 'manifest.json'),
      '{"schemaVersion":1,"package":"metabot-runtime"}\n',
    );
    fs.writeFileSync(path.join(metabotHome, 'install.sh'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" > "$CURL_ARGS_FILE"',
        "cat <<'SH'",
        '#!/usr/bin/env bash',
        'printf "package:%s\\n" "$METABOT_HOME" > "$MARKER"',
        'printf "%s\\n%s\\n%s\\n" "$METABOT_PACKAGE_TARBALL_URL" "$METABOT_PACKAGE_CHECKSUMS_URL" "$METABOT_EXPECTED_PACKAGE_VERSION" > "$RELEASE_ENV"',
        'SH',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    execFileSync('bash', [METABOT_BIN, 'update'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        METABOT_HOME: metabotHome,
        MARKER: marker,
        RELEASE_ENV: releaseEnv,
        CURL_ARGS_FILE: curlArgs,
      },
      stdio: 'pipe',
    });

    expect(fs.readFileSync(marker, 'utf-8').trim()).toBe(`package:${metabotHome}`);
    expect(fs.readFileSync(curlArgs, 'utf-8')).toContain(
      'https://github.com/xvirobotics/metabot/releases/latest/download/install.sh',
    );
    expect(fs.readFileSync(releaseEnv, 'utf-8').split('\n').slice(0, 2)).toEqual([
      'https://github.com/xvirobotics/metabot/releases/latest/download/metabot-runtime.tgz',
      'https://github.com/xvirobotics/metabot/releases/latest/download/SHA256SUMS',
    ]);
  });

  it('can pin an immutable GitHub Release and propagates exact asset URLs', () => {
    const tmp = makeTempDir();
    const fakeBin = path.join(tmp, 'bin');
    const metabotHome = path.join(tmp, 'metabot');
    const marker = path.join(tmp, 'marker.txt');
    const curlArgs = path.join(tmp, 'curl-args.txt');

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(path.join(metabotHome, '.metabot-package'), { recursive: true });
    fs.writeFileSync(
      path.join(metabotHome, '.metabot-package', 'manifest.json'),
      '{"schemaVersion":1,"package":"metabot-personal-edition","version":"1.1.0"}\n',
    );
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" > "$CURL_ARGS_FILE"',
        "cat <<'SH'",
        '#!/usr/bin/env bash',
        'printf "%s\\n%s\\n%s\\n" "$METABOT_PACKAGE_TARBALL_URL" "$METABOT_PACKAGE_CHECKSUMS_URL" "$METABOT_EXPECTED_PACKAGE_VERSION" > "$MARKER"',
        'SH',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    execFileSync('bash', [METABOT_BIN, 'update', '--package', '--version', '1.2.0'], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        METABOT_HOME: metabotHome,
        MARKER: marker,
        CURL_ARGS_FILE: curlArgs,
      },
      stdio: 'pipe',
    });

    expect(fs.readFileSync(marker, 'utf-8').trim().split('\n')).toEqual([
      'https://github.com/xvirobotics/metabot/releases/download/v1.2.0/metabot-runtime.tgz',
      'https://github.com/xvirobotics/metabot/releases/download/v1.2.0/SHA256SUMS',
      '1.2.0',
    ]);
    expect(fs.readFileSync(curlArgs, 'utf-8')).toContain(
      'https://github.com/xvirobotics/metabot/releases/download/v1.2.0/install.sh',
    );
  });

  it('rejects invalid or git-pinned release selections before download', () => {
    const tmp = makeTempDir();
    const metabotHome = path.join(tmp, 'metabot');
    fs.mkdirSync(path.join(metabotHome, '.git'), { recursive: true });

    expect(() =>
      execFileSync('bash', [METABOT_BIN, 'update', '--package', '--version', 'latest'], {
        env: { ...process.env, METABOT_HOME: metabotHome },
        stdio: 'pipe',
      }),
    ).toThrow();
    expect(() =>
      execFileSync('bash', [METABOT_BIN, 'update', '--git', '--version', '1.2.0'], {
        env: { ...process.env, METABOT_HOME: metabotHome },
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('fails when the release installer download fails', () => {
    const tmp = makeTempDir();
    const fakeBin = path.join(tmp, 'bin');
    const metabotHome = path.join(tmp, 'metabot');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(path.join(metabotHome, '.metabot-package'), { recursive: true });
    fs.writeFileSync(
      path.join(metabotHome, '.metabot-package', 'manifest.json'),
      '{"schemaVersion":1,"package":"metabot-personal-edition","version":"1.1.0"}\n',
    );
    fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/usr/bin/env bash\nexit 22\n', { mode: 0o755 });

    expect(() =>
      execFileSync('bash', [METABOT_BIN, 'update', '--package'], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          METABOT_HOME: metabotHome,
        },
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('defaults source checkouts to git and keeps explicit source overrides', () => {
    const source = fs.readFileSync(METABOT_BIN, 'utf-8');
    expect(source).toContain('METABOT_UPDATE_SOURCE:-auto');
    expect(source).toContain('if [[ -f "$METABOT_HOME/.metabot-package/manifest.json" ]]');
    expect(source).toContain('elif [[ -d "$METABOT_HOME/.git" ]]');
    expect(source).toContain('metabot update --git');
    expect(source).toContain('metabot update --package');
    expect(source).toContain('METABOT_EXPECTED_PACKAGE_VERSION');
    expect(source).toContain('releases/download/v${update_version}');
    expect(source).toContain('exec "$METABOT_HOME/bin/metabot" update --git');
    expect(source).toContain("require('./package.json').metabotEdition");
    expect(source).toContain('npm run build -w @xvirobotics/metabot-core-server');
    expect(source).toContain('npm run build -w @xvirobotics/metabot-core-web-ui');
    expect(source).toContain('pm2 restart metabot-core --update-env');
  });
});

describe('metabot doctor command', () => {
  it('is exposed as an agent-native diagnostic command', () => {
    const source = fs.readFileSync(METABOT_BIN, 'utf-8');
    expect(source).toContain('cmd_doctor()');
    expect(source).toContain('Usage: metabot doctor [--json]');
    expect(source).toContain('metabot doctor     Agent-readable runtime diagnostics (--json)');
    expect(source).toContain('doctor)       shift; cmd_doctor "$@" ;;');
    expect(source).toContain('"schemaVersion": 1');
  });

  it('checks Codex agent feature readiness', () => {
    const source = fs.readFileSync(METABOT_BIN, 'utf-8');
    expect(source).toContain('def channel_summary(status_json):');
    expect(source).toContain('check("channel_connections"');
    expect(source).toContain('"ok" if channels_ok else');
    expect(source).toContain('"bridge_health", "channel_connections"');
    expect(source).toContain('parse_codex_feature_list');
    expect(source).toContain('codex_agent_features');
    expect(source).toContain('"multi_agent"');
    expect(source).toContain('"memories"');
    expect(source).toContain('"skillsDirExists"');
    expect(source).toContain('"mcpServerCount"');
  });
});

describe('Codex install defaults', () => {
  it('initializes Codex multi-agent and memory defaults for Codex installs', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');
    expect(source).toContain('ensure_codex_agent_defaults()');
    expect(source).toContain('codex_config_set_feature_default "$config" "multi_agent" "true"');
    expect(source).toContain('codex_config_set_feature_default "$config" "memories" "true"');
    expect(source).toContain('codex_config_set_feature_default "$config" "guardian_approval" "true"');
    expect(source).toContain('mkdir -p "$codex_home/skills" "$codex_home/memories" "$codex_home/agents"');
  });
});

describe('workspace and packaged Skill ownership', () => {
  it('leaves workspace instructions user-owned across install and update', () => {
    const installer = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');
    const updater = fs.readFileSync(METABOT_BIN, 'utf-8');
    const windowsInstaller = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf-8');

    for (const source of [installer, updater, windowsInstaller]) {
      expect(source).not.toContain('src/workspace/AGENTS.md');
      expect(source).not.toContain('src/workspace/CLAUDE.md');
      expect(source).not.toContain('workspace-harness-sync');
    }
    expect(installer).toContain('Retired project-level $SKILL mirror');
    expect(updater).toContain('Retired project-level $skill mirror');
    expect(windowsInstaller).toContain('Retired project-level $skill mirror');
  });

  it('installs only canonical global MetaBot Skills and retires voice', () => {
    const installer = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');
    const updater = fs.readFileSync(METABOT_BIN, 'utf-8');
    const windowsInstaller = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf-8');

    for (const source of [installer, updater]) {
      expect(source).toContain('packages/skills/metabot');
      expect(source).toContain('packages/skills/metabot-team');
      expect(source).toContain('Retired voice Skill');
      expect(source).not.toContain('src/skills/metabot-team');
      expect(source).not.toContain('src/skills/voice');
    }
    expect(windowsInstaller).toContain('packages\\skills\\metabot');
    expect(windowsInstaller).toContain('packages\\skills\\metabot-team');
    expect(windowsInstaller).toContain('Retired voice Skill');
    expect(windowsInstaller).not.toContain('src\\skills\\metabot-team');
    expect(windowsInstaller).not.toContain('src\\skills\\voice');
  });
});
