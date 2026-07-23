import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf-8');

describe('PowerShell installer health contracts', () => {
  it('checks critical native command exit codes before reporting success', () => {
    expect(SOURCE).toContain('function Assert-NativeSuccess');
    expect(SOURCE).toMatch(/npm install --production=false\s+Assert-NativeSuccess "npm install"/);
    expect(SOURCE).toMatch(/npm run build\s+Assert-NativeSuccess "MetaBot build"/);
    expect(SOURCE).toMatch(/pm2 start ecosystem\.config\.cjs\s+Assert-NativeSuccess "PM2 start"/);
  });

  it('waits for Bridge health and emits bounded diagnostics on failure', () => {
    expect(SOURCE).toContain('function Wait-BridgeHealth');
    expect(SOURCE).toContain('/api/health');
    expect(SOURCE).toContain('function Write-BridgeDiagnostics');
    expect(SOURCE).toContain('Select-Object -First 80');
    expect(SOURCE).toContain('Get-Content -LiteralPath $logPath -Tail $MaxLogLines');
  });

  it('does not configure, kill, or advertise the obsolete MetaMemory port', () => {
    expect(SOURCE).not.toContain('META_MEMORY_URL=');
    expect(SOURCE).not.toContain('localhost:8100');
    expect(SOURCE).not.toContain('Get-NetTCPConnection -LocalPort 8100');
    expect(SOURCE).not.toContain('pm2 delete metamemory');
    expect(SOURCE).toContain('METABOT_CORE_URL=$CoreUrl');
    expect(SOURCE).toContain('The Windows installer manages the MetaBot Bridge only.');
  });
});
