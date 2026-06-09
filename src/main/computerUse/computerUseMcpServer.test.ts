import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const TEST_USER_DATA = `${process.cwd()}\\.test-computer-use-runtime`;

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => (name === 'userData' ? TEST_USER_DATA : '')),
    isPackaged: false,
  },
  session: {
    defaultSession: {
      fetch: vi.fn(),
    },
  },
}));

import {
  ComputerUseMcpEnv,
  ensureComputerUseMcpServerScript,
  resolveComputerUseMcpServer,
  resolveComputerUseRuntimePaths,
  resolvePackageRoot,
} from './computerUseMcpServer';
import {
  ComputerUseRuntime,
  getComputerUseHelperStateHome,
  getComputerUseRuntimeRoot,
  inspectComputerUseRuntime,
} from './computerUseRuntime';

afterEach(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('resolvePackageRoot', () => {
  test('resolves the MCP SDK package root instead of its exported cjs package marker', () => {
    const root = resolvePackageRoot('@modelcontextprotocol/sdk');

    expect(root).toBeTruthy();
    expect(path.basename(root!)).toBe('sdk');
    expect(root).not.toContain(`${path.sep}dist${path.sep}cjs`);
  });
});

describe('resolveComputerUseRuntimePaths', () => {
  function writeRuntimeFixture(): {
    clientModulePath: string;
    helperExePath: string;
    rootDir: string;
    runtimePackageRoot: string;
  } {
    const rootDir = getComputerUseRuntimeRoot();
    const runtimePackageRoot = path.join(rootDir, 'node_modules', '@lobsterai', 'computer-use');
    const helperExePath = path.join(runtimePackageRoot, 'bin', 'windows', 'lobster-computer-use.exe');
    const clientPath = path.join(
      runtimePackageRoot,
      'dist',
      'windows',
      'computer_use_client.js',
    );
    fs.mkdirSync(path.dirname(helperExePath), { recursive: true });
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'runtime.json'), `\uFEFF${JSON.stringify({
      arch: ComputerUseRuntime.Arch,
      id: ComputerUseRuntime.Id,
      platform: ComputerUseRuntime.Platform,
      version: ComputerUseRuntime.Version,
      clientModule: 'node_modules/@lobsterai/computer-use/dist/windows/computer_use_client.js',
      helper: 'node_modules/@lobsterai/computer-use/bin/windows/lobster-computer-use.exe',
      runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
    })}`);
    fs.writeFileSync(helperExePath, '');
    fs.writeFileSync(clientPath, '');
    return { clientModulePath: clientPath, helperExePath, rootDir, runtimePackageRoot };
  }

  test('resolves the installed runtime from userData runtimes directory', () => {
    const { clientModulePath, helperExePath, rootDir, runtimePackageRoot } = writeRuntimeFixture();

    const inspection = inspectComputerUseRuntime();
    const paths = resolveComputerUseRuntimePaths();

    expect(inspection.missing).toEqual([]);
    expect(paths).toEqual({ clientModulePath, helperExePath, rootDir, runtimePackageRoot });
  });

  test('configures the helper with LobsterAI branding', () => {
    writeRuntimeFixture();

    const server = resolveComputerUseMcpServer({
      askUserCallbackUrl: 'http://127.0.0.1:1234/ask-user',
      bridgeSecret: 'secret',
      electronNodePath: process.execPath,
    });
    const helperStateHome = getComputerUseHelperStateHome();
    const config = JSON.parse(fs.readFileSync(
      path.join(helperStateHome, 'computer-use', 'config.json'),
      'utf8',
    )) as { strings?: { escToCancel?: string; usingComputer?: string } };

    expect(server?.env?.[ComputerUseMcpEnv.HelperStateHome]).toBe(helperStateHome);
    expect(server?.env?.[ComputerUseMcpEnv.ClientModulePath]).toContain(path.join(
      'node_modules',
      '@lobsterai',
      'computer-use',
      'dist',
      'windows',
      'computer_use_client.js',
    ));
    expect(server?.env?.[ComputerUseMcpEnv.LogDir]).toBe(path.join(TEST_USER_DATA, 'computer-use', 'logs'));
    expect(server?.env?.[ComputerUseMcpEnv.LogLevel]).toBe('info');
    expect(server?.env?.[ComputerUseMcpEnv.LogRetentionDays]).toBe('7');
    expect(config.strings?.usingComputer).toBe('LobsterAI正在使用你的电脑');
    expect(config.strings?.escToCancel).toBe('按 Esc 取消');
  });

  test('renews the helper turn only after Escape cancellation', () => {
    const scriptPath = ensureComputerUseMcpServerScript();
    const script = fs.readFileSync(scriptPath, 'utf8');

    expect(script).toContain("requireEnv('LOBSTER_COMPUTER_USE_HOME')");
    expect(script).toContain("requireEnv('LOBSTER_COMPUTER_USE_CLIENT_MODULE')");
    expect(script).not.toContain("requireEnv('CODEX_HOME')");
    expect(script).not.toContain('sky_js');
    expect(script).not.toContain('@oai');
    expect(script).toContain('function renewHelperTurn()');
    expect(script).toContain('function hasHelperInterruptMarker()');
    expect(script).toContain('function ensureFreshHelperTurn()');
    expect(script).toContain('ensureFreshHelperTurn();');
    expect(script).toContain('function isComputerUseStoppedError(error)');
    expect(script).toContain("error.message.includes('physical Escape key')");
    expect(script).not.toContain('turn_id: String(Date.now())');
    expect(script).not.toContain("client.transport?.request?.('end_turn'");
  });
});
