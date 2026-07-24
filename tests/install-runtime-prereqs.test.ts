import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf-8');
const PS_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf-8');

function extractBashFunction(name: string): string {
  const startMarker = `${name}() {`;
  const start = SH_SOURCE.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing ${name} in install.sh`);
  const end = SH_SOURCE.indexOf('\n}\n', start);
  if (end === -1) throw new Error(`Missing end of ${name} in install.sh`);
  return SH_SOURCE.slice(start, end + 3);
}

describe('installer runtime prerequisites', () => {
  it('enforces the Node.js 22.19.0 semantic-version floor', () => {
    const versionFunction = extractBashFunction('version_at_least');
    const script = `${versionFunction}
version_at_least v22.19.0 22.19.0
! version_at_least v22.18.9 22.19.0
version_at_least v23.0.0 22.19.0
`;
    expect(() => execFileSync('bash', ['-c', script])).not.toThrow();
    expect(SH_SOURCE).toContain('MIN_NODE_VERSION="22.19.0"');
    expect(PS_SOURCE).toContain('$MinimumNodeVersion = "22.19.0"');
    expect(PS_SOURCE).toContain('Test-VersionAtLeast $NodeVer $MinimumNodeVersion');
  });

  it('installs and verifies Kimi Code 0.27+ from npm on both platforms', () => {
    for (const source of [SH_SOURCE, PS_SOURCE]) {
      expect(source).toContain('@moonshot-ai/kimi-code@latest');
      expect(source).toContain('0.27.0');
      expect(source).toContain('kimi-code/k3');
      expect(source).not.toContain('uv tool install kimi-cli');
      expect(source).not.toContain('astral.sh/uv');
    }
  });

  it('installs MetaBot Skills globally and retires project mirrors', () => {
    expect(SH_SOURCE).toContain('AGENTS_SKILLS_DIR="$HOME/.agents/skills"');
    expect(SH_SOURCE).toContain('AGENTS_SKILLS_DEST="$DEPLOY_WORK_DIR/.agents/skills"');
    expect(PS_SOURCE).toContain('$AgentsSkillsDir = Join-Path $env:USERPROFILE ".agents\\skills"');
    expect(PS_SOURCE).toContain('$AgentsSkillsDest = Join-Path $DeployWorkDir ".agents\\skills"');

    for (const source of [SH_SOURCE, PS_SOURCE]) {
      expect(source.replaceAll('\\', '/')).toContain('packages/skills/metabot');
      expect(source).toContain('metabot-team');
      expect(source).toContain('Retired project-level');
    }
  });

  it('leaves AGENTS.md and CLAUDE.md user-owned', () => {
    for (const source of [SH_SOURCE, PS_SOURCE]) {
      expect(source).not.toContain('src/workspace/CLAUDE.md');
      expect(source).not.toContain('src/workspace/AGENTS.md');
      expect(source).not.toContain('ln -s CLAUDE.md AGENTS.md');
      expect(source).not.toContain('Copy-Item $deployClaude $workspaceAgents -Force');
      expect(source).toContain('workspace-harness.sha256');
    }
  });
});
