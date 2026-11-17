// Builds the extension and the integration suite, creates a throwaway workspace, and runs the suite inside a
// real VS Code (downloaded by @vscode/test-electron into .vscode-test/).
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({ entryPoints: [path.join(root, 'test/vscode/suite.ts')], outfile: path.join(root, 'dist/test/suite.js'), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'warning' });

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vscode-'));
fs.mkdirSync(path.join(ws, 'pkg'));
fs.mkdirSync(path.join(ws, '.vscode'));
fs.writeFileSync(path.join(ws, 'pkg', 'mod.py'), '');
fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'forge.mcpPort': 3998, 'forge.trueforgeUrl': 'http://localhost:8790' }));

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist/test/suite.js'),
    launchArgs: [ws, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
