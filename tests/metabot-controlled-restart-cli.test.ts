import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
let tempDir = '';
let fakeBin = '';
let callLog = '';

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-restart-cli-'));
  fakeBin = path.join(tempDir, 'bin');
  callLog = path.join(tempDir, 'calls.log');
  fs.mkdirSync(fakeBin, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeExecutable(name: string, body: string): void {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
}

function installCurl(status = 200): void {
  writeExecutable('curl', `
printf 'curl %s\\n' "$*" >> "$CALL_LOG"
out=""
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[$i]}" == "-o" ]]; then out="\${args[$((i+1))]}"; fi
done
if [[ -n "$out" ]]; then printf '{"status":"prepared"}' > "$out"; fi
printf '${status}'
`);
}

function runRestart(extraArgs: string[] = []) {
  return spawnSync('bash', [path.join(repoRoot, 'bin/metabot'), 'restart', '--request-id', 'restart-cli-test', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      METABOT_HOME: repoRoot,
      SESSION_STORE_DIR: path.join(tempDir, 'state'),
      CALL_LOG: callLog,
      NO_COLOR: '1',
    },
  });
}

describe('metabot controlled restart CLI', () => {
  it('prepares the Bridge before writing the breadcrumb and invoking PM2', () => {
    installCurl(200);
    writeExecutable('pm2', 'printf \'pm2 %s\\n\' "$*" >> "$CALL_LOG"');

    const result = runRestart(['--bot', 'admin', '--chat', 'oc_test', '--reason', 'test restart']);

    expect(result.status).toBe(0);
    const calls = fs.readFileSync(callLog, 'utf8');
    expect(calls).toContain('/api/runtime/restart/prepare');
    expect(calls).toContain('pm2 restart metabot');
    const breadcrumb = JSON.parse(fs.readFileSync(path.join(tempDir, 'state', 'last-restart.json'), 'utf8'));
    expect(breadcrumb).toMatchObject({
      requestId: 'restart-cli-test',
      botName: 'admin',
      chatId: 'oc_test',
      reason: 'test restart',
      resume: true,
    });
  });

  it('refuses to restart when prepare is rejected', () => {
    installCurl(409);
    writeExecutable('pm2', 'printf \'pm2 %s\\n\' "$*" >> "$CALL_LOG"');

    const result = runRestart();

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(callLog, 'utf8')).not.toContain('pm2 restart');
    expect(fs.existsSync(path.join(tempDir, 'state', 'last-restart.json'))).toBe(false);
  });

  it('cancels quiesce and removes the breadcrumb when PM2 rejects the restart', () => {
    installCurl(200);
    writeExecutable('pm2', 'printf \'pm2 %s\\n\' "$*" >> "$CALL_LOG"; exit 1');

    const result = runRestart();

    expect(result.status).not.toBe(0);
    const calls = fs.readFileSync(callLog, 'utf8');
    expect(calls).toContain('/api/runtime/restart/prepare');
    expect(calls).toContain('/api/runtime/restart/cancel');
    expect(fs.existsSync(path.join(tempDir, 'state', 'last-restart.json'))).toBe(false);
  });
});
