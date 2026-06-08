import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';
import { afterEach, expect, test } from 'vitest';

import { DataMigrationRestoreStatus } from '../../../shared/dataMigration/constants';
import { DB_FILENAME } from '../../appConstants';
import {
  createMigrationArchiveSync,
  inspectMigrationArchiveSync,
  performDataMigrationRestoreSync,
  performPendingDataMigrationRestoreSync,
  writePendingRestoreRequestSync,
} from './dataMigrationService';

const tempRoots: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-test-'));
  tempRoots.push(dir);
  return dir;
};

const writeFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const writeSqliteFixture = (dbPath: string, label: string): void => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(dbPath, { force: true });

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE cowork_messages (id TEXT PRIMARY KEY);
      CREATE TABLE cowork_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY);
      CREATE TABLE mcp_launch_resolutions (server_id TEXT PRIMARY KEY);
      CREATE TABLE user_plugins (plugin_id TEXT PRIMARY KEY);
      CREATE TABLE user_memories (id TEXT PRIMARY KEY);
      CREATE TABLE user_memory_sources (id TEXT PRIMARY KEY);
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY);
      CREATE TABLE subagent_messages (id TEXT PRIMARY KEY);
      CREATE TABLE im_config (key TEXT PRIMARY KEY);
      CREATE TABLE im_session_mappings (im_conversation_id TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (im_conversation_id, platform));
    `);

    const now = Date.now();
    const insertKv = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    insertKv.run('auth_tokens', JSON.stringify({ accessToken: `${label}-access`, refreshToken: `${label}-refresh` }), now);
    insertKv.run('auth_user', JSON.stringify({ id: `${label}-user` }), now);
    insertKv.run('app_config', JSON.stringify({ providers: { custom: { models: [`${label}-model`] } } }), now);
    insertKv.run('skills_state', JSON.stringify({ [`${label}-skill`]: { enabled: true } }), now);
    insertKv.run('openclaw_session_policy', JSON.stringify({ mode: label }), now);
    insertKv.run('installation_uuid', JSON.stringify(`${label}-install`), now);

    db.prepare('INSERT INTO cowork_sessions (id) VALUES (?)').run(`${label}-session`);
    db.prepare('INSERT INTO cowork_messages (id) VALUES (?)').run(`${label}-message`);
    db.prepare('INSERT INTO cowork_config (key, value, updated_at) VALUES (?, ?, ?)').run('workingDirectory', label, now);
    db.prepare('INSERT INTO agents (id) VALUES (?)').run(`${label}-agent`);
    db.prepare('INSERT INTO mcp_servers (id) VALUES (?)').run(`${label}-mcp`);
    db.prepare('INSERT INTO mcp_launch_resolutions (server_id) VALUES (?)').run(`${label}-mcp`);
    db.prepare('INSERT INTO user_plugins (plugin_id) VALUES (?)').run(`${label}-plugin`);
    db.prepare('INSERT INTO user_memories (id) VALUES (?)').run(`${label}-memory`);
    db.prepare('INSERT INTO user_memory_sources (id) VALUES (?)').run(`${label}-memory-source`);
    db.prepare('INSERT INTO subagent_runs (id) VALUES (?)').run(`${label}-subagent`);
    db.prepare('INSERT INTO subagent_messages (id) VALUES (?)').run(`${label}-subagent-message`);
    db.prepare('INSERT INTO im_config (key) VALUES (?)').run(`${label}-im`);
    db.prepare('INSERT INTO im_session_mappings (im_conversation_id, platform) VALUES (?, ?)').run(`${label}-conversation`, 'telegram');
  } finally {
    db.close();
  }
};

const readSqliteValue = (dbPath: string, sql: string, params: unknown[] = []): unknown => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).pluck().get(...params);
  } finally {
    db.close();
  }
};

const readSqliteString = (dbPath: string, sql: string, params: unknown[] = []): string => (
  String(readSqliteValue(dbPath, sql, params) ?? '')
);

const readSqliteCount = (dbPath: string, tableName: string): number => (
  Number(readSqliteValue(dbPath, `SELECT COUNT(*) FROM "${tableName}"`) ?? 0)
);

const listArchiveEntries = (archivePath: string): string[] => {
  const entries: string[] = [];
  tar.list({
    sync: true,
    file: archivePath,
    onentry: entry => entries.push(entry.path),
  });
  return entries.sort();
};

const extractArchive = (archivePath: string): string => {
  const extractRoot = makeTempDir();
  tar.extract({
    sync: true,
    file: archivePath,
    cwd: extractRoot,
  });
  return extractRoot;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createMigrationArchive excludes cache and log data and writes a manifest', () => {
  const root = makeTempDir();
  const userData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'backup.tar.gz');

  writeFile(path.join(userData, 'Cache', 'cache.bin'), 'cache');
  writeFile(path.join(userData, 'Code Cache', 'code.bin'), 'code-cache');
  writeFile(path.join(userData, 'GPUCache', 'gpu.bin'), 'gpu-cache');
  writeFile(path.join(userData, 'Network', 'Cookies'), 'network-cookies');
  writeFile(path.join(userData, 'logs', 'main.log'), 'log');
  writeFile(path.join(userData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'old-snapshot');
  writeFile(path.join(userData, 'Cookies'), 'cookies');
  writeFile(path.join(userData, 'DIPS-journal'), 'dips');
  writeFile(path.join(userData, '.com.github.Electron.test'), 'electron-marker');
  writeSqliteFixture(path.join(userData, DB_FILENAME), 'source');
  writeFile(path.join(userData, 'cowork', 'workspaces', 'session.txt'), 'workspace');
  writeFile(path.join(userData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'native');
  writeFile(path.join(userData, 'openclaw', 'state', 'openclaw.json'), '{}');
  writeFile(path.join(userData, 'runtimes', 'node', 'node.exe'), 'runtime');
  writeFile(path.join(userData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');

  createMigrationArchiveSync({ userDataPath: userData, outputPath: archivePath });

  const entries = listArchiveEntries(archivePath);
  expect(entries).toContain('LobsterAI/.lobsterai-migration.json');
  expect(entries).toContain(`LobsterAI/${DB_FILENAME}`);
  expect(entries).toContain('LobsterAI/openclaw/state/openclaw.json');
  expect(entries).toContain('LobsterAI/SKILLs/demo/SKILL.md');
  expect(entries.some(entry => entry.includes('/Cache/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Code Cache/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/cowork/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/GPUCache/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Network/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/openclaw/mcp-packages/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/backups/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/logs/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/runtimes/'))).toBe(false);
  expect(entries.some(entry => entry.includes('/Cookies'))).toBe(false);
  expect(entries.some(entry => entry.includes('/DIPS'))).toBe(false);
  expect(entries.some(entry => entry.includes('/.com.github.Electron.'))).toBe(false);
});

test('createMigrationArchive replaces the live sqlite database with the snapshot', () => {
  const root = makeTempDir();
  const userData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'backup.tar.gz');
  const sqliteSnapshotPath = path.join(root, 'snapshot.sqlite');

  writeSqliteFixture(path.join(userData, DB_FILENAME), 'live');
  writeFile(path.join(userData, `${DB_FILENAME}-wal`), 'live-wal');
  writeSqliteFixture(sqliteSnapshotPath, 'snapshot');

  createMigrationArchiveSync({
    userDataPath: userData,
    outputPath: archivePath,
    sqliteSnapshotPath,
  });

  const extractRoot = extractArchive(archivePath);
  expect(readSqliteString(path.join(extractRoot, 'LobsterAI', DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('snapshot-refresh');
  expect(fs.existsSync(path.join(extractRoot, 'LobsterAI', `${DB_FILENAME}-wal`))).toBe(false);
});

test('createMigrationArchive rejects a source without a sqlite database', () => {
  const root = makeTempDir();
  const userData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'backup.tar.gz');

  writeFile(path.join(userData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');

  expect(() => createMigrationArchiveSync({ userDataPath: userData, outputPath: archivePath }))
    .toThrow(`missing ${DB_FILENAME}`);
  expect(fs.existsSync(archivePath)).toBe(false);
});

test('inspectMigrationArchive accepts legacy Windows PowerShell archive root', () => {
  const root = makeTempDir();
  const legacyRoot = path.join(root, 'AppData', 'Roaming', 'LobsterAI');
  const archivePath = path.join(root, 'legacy.tar.gz');
  writeSqliteFixture(path.join(legacyRoot, DB_FILENAME), 'legacy');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: root,
  }, ['AppData']);

  const info = inspectMigrationArchiveSync(archivePath);
  expect(info.root).toBe('AppData/Roaming/LobsterAI');
  expect(info.rootKind).toBe('legacy-windows');
});

test('inspectMigrationArchive rejects unreadable sqlite database', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'LobsterAI');
  const archivePath = path.join(root, 'invalid.tar.gz');
  writeFile(path.join(sourceUserData, DB_FILENAME), 'not a sqlite database');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: root,
  }, ['LobsterAI']);

  expect(() => inspectMigrationArchiveSync(archivePath)).toThrow(`unreadable ${DB_FILENAME}`);
});

test('inspectMigrationArchive rejects parent-directory archive paths', () => {
  const root = makeTempDir();
  const source = path.join(root, 'source');
  const archivePath = path.join(root, 'evil.tar.gz');
  writeFile(path.join(source, 'payload.txt'), 'evil');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: source,
    prefix: '../evil',
  }, ['payload.txt']);

  expect(() => inspectMigrationArchiveSync(archivePath)).toThrow(/parent-directory path/);
});

test('performPendingDataMigrationRestoreSync creates rollback and restores backup data', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeFile(path.join(sourceUserData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });
  writePendingRestoreRequestSync(targetUserData, archivePath);

  const result = performPendingDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(result?.rollbackPath).toBeTruthy();
  expect(fs.existsSync(result?.rollbackPath || '')).toBe(true);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('source-refresh');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT id FROM cowork_sessions')).toBe('source-session');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT id FROM agents')).toBe('source-agent');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT id FROM mcp_servers')).toBe('source-mcp');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT plugin_id FROM user_plugins')).toBe('source-plugin');
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT key FROM im_config')).toBe('source-im');
  expect(fs.readFileSync(path.join(targetUserData, 'SKILLs', 'demo', 'SKILL.md'), 'utf8')).toBe('# Demo');
});

test('performDataMigrationRestoreSync restores backup data without a pending marker', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['app_config']))
    .toContain('source-model');
  expect(readSqliteCount(path.join(targetUserData, DB_FILENAME), 'subagent_runs')).toBe(1);
  expect(readSqliteCount(path.join(targetUserData, DB_FILENAME), 'user_memory_sources')).toBe(1);
});

test('performDataMigrationRestoreSync restores valid backup when current sqlite is unreadable', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeFile(path.join(targetUserData, DB_FILENAME), 'not a sqlite database');
  writeFile(path.join(targetUserData, 'old-only.txt'), 'old');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  expect(result?.rollbackPath).toBeTruthy();
  expect(fs.existsSync(result?.rollbackPath || '')).toBe(true);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('source-refresh');
  expect(fs.existsSync(path.join(targetUserData, 'old-only.txt'))).toBe(false);
});

test('performPendingDataMigrationRestoreSync replaces data in place and preserves runtime locks', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  writeSqliteFixture(path.join(sourceUserData, DB_FILENAME), 'source');
  writeFile(path.join(sourceUserData, 'openclaw', 'state', 'openclaw.json'), '{"source":true}');
  writeFile(path.join(sourceUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'source-backup');
  writeFile(path.join(sourceUserData, 'cowork', 'bin', 'node.cmd'), 'source-shim');
  writeFile(path.join(sourceUserData, 'Network', 'Cookies'), 'source-network-cookies');
  writeFile(path.join(sourceUserData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'native.node'), 'native');
  writeFile(path.join(sourceUserData, 'runtimes', 'python', 'python.exe'), 'source-runtime');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writeFile(path.join(targetUserData, 'old-only.txt'), 'old');
  writeFile(path.join(targetUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'target-backup');
  writeFile(path.join(targetUserData, 'cowork', 'bin', 'node.cmd'), 'target-shim');
  writeFile(path.join(targetUserData, 'Network', 'Cookies'), 'runtime-cookies');
  writeFile(path.join(targetUserData, 'openclaw', 'mcp-packages', 'demo', 'node_modules', 'target-native.node'), 'target-native');
  writeFile(path.join(targetUserData, 'runtimes', 'python', 'python.exe'), 'target-runtime');
  writeFile(path.join(targetUserData, 'SingletonLock'), 'runtime-lock');

  createMigrationArchiveSync({ userDataPath: sourceUserData, outputPath: archivePath });
  writePendingRestoreRequestSync(targetUserData, archivePath);

  const result = performPendingDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Success);
  const rollbackEntries = listArchiveEntries(result?.rollbackPath || '');
  expect(rollbackEntries).toContain('LobsterAI/backups/sqlite/snapshots/lobsterai-latest.sqlite');
  expect(rollbackEntries).toContain('LobsterAI/cowork/bin/node.cmd');
  expect(rollbackEntries).toContain('LobsterAI/openclaw/mcp-packages/demo/node_modules/target-native.node');
  expect(rollbackEntries).toContain('LobsterAI/runtimes/python/python.exe');
  expect(rollbackEntries.some(entry => entry.includes('/Network/'))).toBe(false);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('source-refresh');
  expect(fs.readFileSync(path.join(targetUserData, 'openclaw', 'state', 'openclaw.json'), 'utf8')).toBe('{"source":true}');
  expect(fs.existsSync(path.join(targetUserData, 'openclaw', 'mcp-packages'))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, 'backups'))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, 'cowork'))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, 'runtimes'))).toBe(false);
  expect(fs.existsSync(path.join(targetUserData, 'old-only.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(targetUserData, 'Network', 'Cookies'), 'utf8')).toBe('runtime-cookies');
  expect(fs.readFileSync(path.join(targetUserData, 'SingletonLock'), 'utf8')).toBe('runtime-lock');
});

test('performPendingDataMigrationRestoreSync keeps existing data when restore fails', () => {
  const root = makeTempDir();
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'missing-backup.tar.gz');

  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writePendingRestoreRequestSync(targetUserData, archivePath);

  const result = performPendingDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Failed);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('target-refresh');
});

test('performDataMigrationRestoreSync rolls back when the backup is missing sqlite data', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  const sourceParent = path.dirname(sourceUserData);
  writeFile(path.join(sourceUserData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: sourceParent,
  }, ['LobsterAI']);

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Failed);
  expect(result?.error).toContain(`missing ${DB_FILENAME}`);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('target-refresh');
  expect(fs.existsSync(path.join(targetUserData, 'SKILLs', 'demo', 'SKILL.md'))).toBe(false);
});

test('performDataMigrationRestoreSync rejects unreadable backup sqlite before touching target data', () => {
  const root = makeTempDir();
  const sourceUserData = path.join(root, 'source', 'LobsterAI');
  const targetUserData = path.join(root, 'target', 'LobsterAI');
  const rollbackRoot = path.join(root, 'rollbacks');
  const archivePath = path.join(root, 'source-backup.tar.gz');

  const sourceParent = path.dirname(sourceUserData);
  writeFile(path.join(sourceUserData, DB_FILENAME), 'not a sqlite database');
  writeFile(path.join(sourceUserData, 'SKILLs', 'demo', 'SKILL.md'), '# Demo');
  writeSqliteFixture(path.join(targetUserData, DB_FILENAME), 'target');
  writeFile(path.join(targetUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'target-backup');

  tar.create({
    sync: true,
    gzip: true,
    file: archivePath,
    cwd: sourceParent,
  }, ['LobsterAI']);

  const result = performDataMigrationRestoreSync({
    userDataPath: targetUserData,
    rollbackRootPath: rollbackRoot,
    archivePath,
    now: new Date('2026-06-08T01:02:03Z'),
  });

  expect(result?.status).toBe(DataMigrationRestoreStatus.Failed);
  expect(result?.error).toContain(`unreadable ${DB_FILENAME}`);
  expect(readSqliteString(path.join(targetUserData, DB_FILENAME), 'SELECT value FROM kv WHERE key = ?', ['auth_tokens']))
    .toContain('target-refresh');
  expect(fs.readFileSync(path.join(targetUserData, 'backups', 'sqlite', 'snapshots', 'lobsterai-latest.sqlite'), 'utf8'))
    .toBe('target-backup');
  expect(fs.existsSync(path.join(targetUserData, 'SKILLs', 'demo', 'SKILL.md'))).toBe(false);
});
