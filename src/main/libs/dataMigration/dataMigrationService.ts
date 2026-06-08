import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import {
  type DataMigrationLastRestoreResult,
  DataMigrationRestoreStatus,
} from '../../../shared/dataMigration/constants';
import { APP_NAME, DB_FILENAME } from '../../appConstants';
import { SQLITE_BACKUP_DIR_NAME } from '../sqliteBackup/constants';

const CURRENT_ARCHIVE_ROOT = APP_NAME;
const LEGACY_WINDOWS_ARCHIVE_ROOT = 'AppData/Roaming/LobsterAI';
const MANIFEST_FILE_NAME = '.lobsterai-migration.json';
const PENDING_RESTORE_FILE_NAME = '.lobsterai-data-migration-restore-pending.json';
const LAST_RESTORE_RESULT_FILE_NAME = '.lobsterai-data-migration-restore-result.json';
const ARCHIVE_FORMAT = 'lobsterai-user-data';
const ARCHIVE_FORMAT_VERSION = 1;
const SQLITE_BACKUP_TOP_LEVEL_DIR_NAME = SQLITE_BACKUP_DIR_NAME.split('/')[0] || 'backups';

const SQLITE_MIGRATION_TABLES = [
  'kv',
  'cowork_sessions',
  'cowork_messages',
  'cowork_config',
  'agents',
  'mcp_servers',
  'mcp_launch_resolutions',
  'user_plugins',
  'user_memories',
  'user_memory_sources',
  'subagent_runs',
  'subagent_messages',
  'im_config',
  'im_session_mappings',
] as const;

const SQLITE_MIGRATION_KV_KEYS = [
  'auth_tokens',
  'auth_user',
  'app_config',
  'skills_state',
  'openclaw_session_policy',
  'installation_uuid',
] as const;

const SOURCE_EXCLUDED_TOP_LEVEL_NAMES = new Set([
  'Cache',
  'Code Cache',
  'cowork',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Network',
  'Service Worker',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'blob_storage',
  'Crashpad',
  SQLITE_BACKUP_TOP_LEVEL_DIR_NAME,
  'logs',
  'lockfile',
  'runtimes',
  PENDING_RESTORE_FILE_NAME,
  LAST_RESTORE_RESULT_FILE_NAME,
]);

const RESTORE_PRESERVED_TOP_LEVEL_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Network',
  'Service Worker',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'blob_storage',
  'Crashpad',
  'logs',
  'lockfile',
  PENDING_RESTORE_FILE_NAME,
  LAST_RESTORE_RESULT_FILE_NAME,
]);

const SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES = [
  'Cookies',
  'DIPS',
  '.com.github.Electron.',
];

const RESTORE_PRESERVED_TOP_LEVEL_PREFIXES = SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES;

const EXCLUDED_RELATIVE_PATHS = [
  'openclaw/mcp-packages',
];

const ALLOWED_ENTRY_TYPES = new Set([
  'File',
  'OldFile',
  'Directory',
]);

export type DataMigrationArchiveKind = 'backup' | 'rollback';

export interface CreateMigrationArchiveInput {
  userDataPath: string;
  outputPath: string;
  sqliteSnapshotPath?: string;
  now?: Date;
  archiveKind?: DataMigrationArchiveKind;
}

export interface CreateMigrationArchiveResult {
  outputPath: string;
  sizeBytes: number;
}

export interface MigrationArchiveInfo {
  archivePath: string;
  root: string;
  rootKind: 'current' | 'legacy-windows';
  entryCount: number;
  hasSqliteDatabase: boolean;
}

interface InspectMigrationArchiveOptions {
  requireSqliteDatabase?: boolean;
  validateSqliteDatabase?: boolean;
}

export interface PendingDataMigrationRestoreRequest {
  archivePath: string;
  requestedAt: string;
}

export interface PerformPendingDataMigrationRestoreInput {
  userDataPath: string;
  rollbackRootPath: string;
  now?: Date;
}

export interface PerformDataMigrationRestoreInput extends PerformPendingDataMigrationRestoreInput {
  archivePath: string;
}

interface SqliteMigrationSummary {
  exists: boolean;
  sizeBytes?: number;
  checksumSha256?: string;
  quickCheck?: string;
  rowCounts?: Record<string, number>;
  kvKeys?: string[];
  error?: string;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

export const formatDataMigrationTimestamp = (date = new Date()): string => (
  `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
);

export const buildDataMigrationBackupFileName = (date = new Date()): string =>
  `lobsterai-backup-${formatDataMigrationTimestamp(date)}.tar.gz`;

export const buildDataMigrationRollbackFileName = (date = new Date()): string =>
  `lobsterai-rollback-${formatDataMigrationTimestamp(date)}.tar.gz`;

export const ensureTarGzFileName = (filePath: string): string => {
  const trimmed = filePath.trim();
  return /\.tar\.gz$/i.test(trimmed) ? trimmed : `${trimmed}.tar.gz`;
};

export const getPendingRestoreRequestPath = (userDataPath: string): string =>
  path.join(userDataPath, PENDING_RESTORE_FILE_NAME);

export const getLastRestoreResultPath = (userDataPath: string): string =>
  path.join(userDataPath, LAST_RESTORE_RESULT_FILE_NAME);

const resolvePath = (value: string): string => path.resolve(value);

const isPathInside = (candidatePath: string, parentPath: string): boolean => {
  const relative = path.relative(resolvePath(parentPath), resolvePath(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isTopLevelEntryMatch = (
  relativePosixPath: string,
  names: Set<string>,
  prefixes: readonly string[],
): boolean => {
  const firstSegment = relativePosixPath.split('/')[0] || '';
  return names.has(firstSegment)
    || prefixes.some(prefix => firstSegment.startsWith(prefix));
};

const isExcludedSourceTopLevelEntry = (relativePosixPath: string): boolean =>
  isTopLevelEntryMatch(
    relativePosixPath,
    SOURCE_EXCLUDED_TOP_LEVEL_NAMES,
    SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES,
  );

const isPreservedRestoreTopLevelEntry = (relativePosixPath: string): boolean =>
  isTopLevelEntryMatch(
    relativePosixPath,
    RESTORE_PRESERVED_TOP_LEVEL_NAMES,
    RESTORE_PRESERVED_TOP_LEVEL_PREFIXES,
  );

const isExcludedMigrationEntry = (relativePosixPath: string): boolean => {
  if (!relativePosixPath) return false;
  if (isExcludedSourceTopLevelEntry(relativePosixPath)) return true;
  return EXCLUDED_RELATIVE_PATHS.some(excludedPath => (
    relativePosixPath === excludedPath
    || relativePosixPath.startsWith(`${excludedPath}/`)
  ));
};

const getExclusionManifestFields = (archiveKind: DataMigrationArchiveKind): Record<string, unknown> => {
  if (archiveKind === 'rollback') {
    return {
      excludedTopLevelNames: [...RESTORE_PRESERVED_TOP_LEVEL_NAMES].sort(),
      excludedTopLevelPrefixes: [...RESTORE_PRESERVED_TOP_LEVEL_PREFIXES].sort(),
      excludedRelativePaths: [],
    };
  }

  return {
    excludedTopLevelNames: [...SOURCE_EXCLUDED_TOP_LEVEL_NAMES].sort(),
    excludedTopLevelPrefixes: [...SOURCE_EXCLUDED_TOP_LEVEL_PREFIXES].sort(),
    excludedRelativePaths: [...EXCLUDED_RELATIVE_PATHS].sort(),
  };
};

const shouldExcludeSourcePath = (
  relativePosixPath: string,
  absolutePath: string,
  input: CreateMigrationArchiveInput,
): boolean => {
  if (!relativePosixPath) return false;
  const archiveKind = input.archiveKind ?? 'backup';
  if (archiveKind === 'rollback') {
    if (isPreservedRestoreTopLevelEntry(relativePosixPath)) return true;
  } else if (isExcludedMigrationEntry(relativePosixPath)) {
    return true;
  }

  const firstSegment = relativePosixPath.split('/')[0] || '';
  if (input.sqliteSnapshotPath) {
    if (
      firstSegment === DB_FILENAME
      || firstSegment === `${DB_FILENAME}-wal`
      || firstSegment === `${DB_FILENAME}-shm`
    ) {
      return true;
    }
  }

  return isPathInside(absolutePath, input.outputPath);
};

const ensureDirSync = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const removeDirIfExistsSync = (dirPath: string): void => {
  fs.rmSync(dirPath, { recursive: true, force: true });
};

const computeFileSha256Sync = (filePath: string): string => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const copyFileSync = (sourcePath: string, targetPath: string): void => {
  ensureDirSync(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
};

const copyDirectorySync = (
  sourceRoot: string,
  targetRoot: string,
  shouldExclude?: (relativePosixPath: string, absolutePath: string) => boolean,
): void => {
  const copyEntry = (sourcePath: string, targetPath: string, relativePosixPath: string): void => {
    if (shouldExclude?.(relativePosixPath, sourcePath)) return;

    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) return;

    if (stat.isDirectory()) {
      ensureDirSync(targetPath);
      for (const entry of fs.readdirSync(sourcePath)) {
        const childRelative = relativePosixPath
          ? `${relativePosixPath}/${entry}`
          : entry;
        copyEntry(path.join(sourcePath, entry), path.join(targetPath, entry), childRelative);
      }
      return;
    }

    if (stat.isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  };

  copyEntry(sourceRoot, targetRoot, '');
};

const writeJsonSync = (filePath: string, value: unknown): void => {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const readJsonFileSync = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
};

const tableExists = (db: Database.Database, tableName: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
};

const readSqliteMigrationSummarySync = (dbPath: string): SqliteMigrationSummary => {
  if (!fs.existsSync(dbPath)) return { exists: false };
  const stat = fs.statSync(dbPath);
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const quickCheck = String(db.prepare('PRAGMA quick_check').pluck().get() ?? '');
    const rowCounts: Record<string, number> = {};
    for (const tableName of SQLITE_MIGRATION_TABLES) {
      if (!tableExists(db, tableName)) continue;
      const count = db.prepare(`SELECT COUNT(*) FROM "${tableName}"`).pluck().get() as number;
      rowCounts[tableName] = Number(count) || 0;
    }

    const kvKeys = tableExists(db, 'kv')
      ? SQLITE_MIGRATION_KV_KEYS.filter((key) => {
        const row = db?.prepare('SELECT key FROM kv WHERE key = ?').get(key);
        return Boolean(row);
      })
      : [];

    return {
      exists: true,
      sizeBytes: stat.size,
      checksumSha256: computeFileSha256Sync(dbPath),
      quickCheck,
      rowCounts,
      kvKeys,
    };
  } catch (error) {
    return {
      exists: true,
      sizeBytes: stat.size,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
};

const assertMigrationSqliteReadySync = (dbPath: string, label: string): SqliteMigrationSummary => {
  const summary = readSqliteMigrationSummarySync(dbPath);
  if (!summary.exists) {
    throw new Error(`${label} is missing ${DB_FILENAME}.`);
  }
  if (summary.error) {
    throw new Error(`${label} contains an unreadable ${DB_FILENAME}: ${summary.error}`);
  }
  if (summary.quickCheck !== 'ok') {
    throw new Error(`${label} ${DB_FILENAME} failed quick_check: ${summary.quickCheck || 'empty result'}`);
  }
  return summary;
};

const buildManifest = (input: CreateMigrationArchiveInput): Record<string, unknown> => {
  const now = input.now ?? new Date();
  const archiveKind = input.archiveKind ?? 'backup';
  const sqliteSourcePath = input.sqliteSnapshotPath
    ? resolvePath(input.sqliteSnapshotPath)
    : path.join(resolvePath(input.userDataPath), DB_FILENAME);
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_FORMAT_VERSION,
    appName: APP_NAME,
    archiveKind,
    archiveRoot: CURRENT_ARCHIVE_ROOT,
    createdAt: now.toISOString(),
    platform: process.platform,
    arch: process.arch,
    includesWorkingDirectories: false,
    ...getExclusionManifestFields(archiveKind),
    sqlite: readSqliteMigrationSummarySync(sqliteSourcePath),
  };
};

export const createMigrationArchiveSync = (
  input: CreateMigrationArchiveInput,
): CreateMigrationArchiveResult => {
  const userDataPath = resolvePath(input.userDataPath);
  const outputPath = resolvePath(input.outputPath);
  const archiveKind = input.archiveKind ?? 'backup';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-'));
  const stageParent = path.join(tempRoot, 'stage');
  const stageUserDataRoot = path.join(stageParent, CURRENT_ARCHIVE_ROOT);

  try {
    ensureDirSync(stageUserDataRoot);
    copyDirectorySync(
      userDataPath,
      stageUserDataRoot,
      (relativePosixPath, absolutePath) => shouldExcludeSourcePath(relativePosixPath, absolutePath, {
        ...input,
        userDataPath,
        outputPath,
      }),
    );

    if (input.sqliteSnapshotPath) {
      copyFileSync(resolvePath(input.sqliteSnapshotPath), path.join(stageUserDataRoot, DB_FILENAME));
    }

    if (archiveKind !== 'rollback') {
      assertMigrationSqliteReadySync(path.join(stageUserDataRoot, DB_FILENAME), 'Backup staging');
    }

    writeJsonSync(path.join(stageUserDataRoot, MANIFEST_FILE_NAME), buildManifest(input));

    ensureDirSync(path.dirname(outputPath));
    tar.create({
      sync: true,
      gzip: true,
      file: outputPath,
      cwd: stageParent,
      portable: true,
    }, [CURRENT_ARCHIVE_ROOT]);

    return {
      outputPath,
      sizeBytes: fs.statSync(outputPath).size,
    };
  } finally {
    removeDirIfExistsSync(tempRoot);
  }
};

export const createMigrationArchive = async (
  input: CreateMigrationArchiveInput,
): Promise<CreateMigrationArchiveResult> => createMigrationArchiveSync(input);

const normalizeArchiveEntryPath = (entryPath: string): string => {
  let normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
};

const assertSafeArchiveEntryPath = (entryPath: string): string => {
  const normalized = normalizeArchiveEntryPath(entryPath);
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Backup archive contains an empty or invalid path.');
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Backup archive contains an absolute path: ${entryPath}`);
  }
  if (normalized.split('/').some(segment => segment === '..')) {
    throw new Error(`Backup archive contains a parent-directory path: ${entryPath}`);
  }
  return normalized;
};

const resolveArchiveRoot = (entryPath: string): Pick<MigrationArchiveInfo, 'root' | 'rootKind'> | null => {
  if (entryPath === CURRENT_ARCHIVE_ROOT || entryPath.startsWith(`${CURRENT_ARCHIVE_ROOT}/`)) {
    return { root: CURRENT_ARCHIVE_ROOT, rootKind: 'current' };
  }
  if (
    entryPath === LEGACY_WINDOWS_ARCHIVE_ROOT
    || entryPath.startsWith(`${LEGACY_WINDOWS_ARCHIVE_ROOT}/`)
  ) {
    return { root: LEGACY_WINDOWS_ARCHIVE_ROOT, rootKind: 'legacy-windows' };
  }
  return null;
};

const isArchiveSqliteDatabaseEntry = (entryPath: string, root: string): boolean =>
  entryPath === `${root}/${DB_FILENAME}`;

const isArchiveRootParentDirectory = (entryPath: string): boolean => (
  `${LEGACY_WINDOWS_ARCHIVE_ROOT}/`.startsWith(`${entryPath}/`)
  || `${CURRENT_ARCHIVE_ROOT}/`.startsWith(`${entryPath}/`)
);

const inspectArchiveEntry = (
  archivePath: string,
  entry: { path: string; type?: string },
  state: {
    root: Pick<MigrationArchiveInfo, 'root' | 'rootKind'> | null;
    entryCount: number;
    hasSqliteDatabase: boolean;
  },
): void => {
  const normalizedPath = assertSafeArchiveEntryPath(entry.path);
  if (entry.type && !ALLOWED_ENTRY_TYPES.has(entry.type)) {
    throw new Error(`Backup archive contains an unsupported entry type: ${entry.type}`);
  }

  const root = resolveArchiveRoot(normalizedPath);
  if (!root) {
    if (entry.type === 'Directory' && isArchiveRootParentDirectory(normalizedPath)) {
      return;
    }
    throw new Error(`Backup archive does not contain ${APP_NAME} user data: ${entry.path}`);
  }
  if (state.root && state.root.root !== root.root) {
    throw new Error(`Backup archive contains multiple root directories: ${archivePath}`);
  }
  state.root = root;
  state.entryCount += 1;
  if (isArchiveSqliteDatabaseEntry(normalizedPath, root.root)) {
    if (entry.type && entry.type !== 'File' && entry.type !== 'OldFile') {
      throw new Error(`Backup archive ${DB_FILENAME} entry is not a file.`);
    }
    state.hasSqliteDatabase = true;
  }
};

const validateArchiveSqliteDatabaseSync = (archivePath: string, root: string): void => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-inspect-'));
  try {
    tar.extract({
      sync: true,
      file: archivePath,
      cwd: tempRoot,
      preservePaths: false,
      unlink: true,
      filter: (entryPath, entry) => {
        const normalizedPath = assertSafeArchiveEntryPath(entryPath);
        if ('type' in entry && entry.type && !ALLOWED_ENTRY_TYPES.has(entry.type)) {
          throw new Error(`Backup archive contains an unsupported entry type: ${entry.type}`);
        }
        return normalizedPath === `${root}/${DB_FILENAME}`;
      },
    });
    assertMigrationSqliteReadySync(path.join(tempRoot, ...root.split('/'), DB_FILENAME), 'Backup archive');
  } finally {
    removeDirIfExistsSync(tempRoot);
  }
};

export const inspectMigrationArchiveSync = (
  archivePath: string,
  options: InspectMigrationArchiveOptions = {},
): MigrationArchiveInfo => {
  const resolvedArchivePath = resolvePath(archivePath);
  const requireSqliteDatabase = options.requireSqliteDatabase ?? true;
  const validateSqliteDatabase = options.validateSqliteDatabase ?? true;
  const state: {
    root: Pick<MigrationArchiveInfo, 'root' | 'rootKind'> | null;
    entryCount: number;
    hasSqliteDatabase: boolean;
  } = {
    root: null,
    entryCount: 0,
    hasSqliteDatabase: false,
  };

  tar.list({
    sync: true,
    file: resolvedArchivePath,
    onentry: entry => inspectArchiveEntry(resolvedArchivePath, entry, state),
  });

  if (!state.root || state.entryCount <= 0) {
    throw new Error('Backup archive is empty or missing LobsterAI user data.');
  }
  if (requireSqliteDatabase && !state.hasSqliteDatabase) {
    throw new Error(`Backup archive is missing ${DB_FILENAME}.`);
  }
  if (requireSqliteDatabase && validateSqliteDatabase) {
    validateArchiveSqliteDatabaseSync(resolvedArchivePath, state.root.root);
  }

  return {
    archivePath: resolvedArchivePath,
    root: state.root.root,
    rootKind: state.root.rootKind,
    entryCount: state.entryCount,
    hasSqliteDatabase: state.hasSqliteDatabase,
  };
};

export const inspectMigrationArchive = async (archivePath: string): Promise<MigrationArchiveInfo> =>
  inspectMigrationArchiveSync(archivePath);

const extractMigrationArchiveToTempSync = (
  archivePath: string,
  options: { requireSqliteDatabase?: boolean } = {},
): { tempRoot: string; sourceRoot: string; info: MigrationArchiveInfo } => {
  const info = inspectMigrationArchiveSync(archivePath, {
    requireSqliteDatabase: options.requireSqliteDatabase,
    validateSqliteDatabase: false,
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-data-migration-restore-'));

  try {
    tar.extract({
      sync: true,
      file: info.archivePath,
      cwd: tempRoot,
      preservePaths: false,
      unlink: true,
      filter: (entryPath, entry) => {
        const normalizedPath = assertSafeArchiveEntryPath(entryPath);
        if ('type' in entry && entry.type && !ALLOWED_ENTRY_TYPES.has(entry.type)) {
          throw new Error(`Backup archive contains an unsupported entry type: ${entry.type}`);
        }
        const root = resolveArchiveRoot(normalizedPath);
        const isDirectoryEntry = 'type' in entry
          ? entry.type === 'Directory'
          : entry.isDirectory();
        return Boolean(
          (root && root.root === info.root)
          || (isDirectoryEntry && isArchiveRootParentDirectory(normalizedPath)),
        );
      },
    });

    const sourceRoot = path.join(tempRoot, ...info.root.split('/'));
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      throw new Error('Backup archive did not extract a valid LobsterAI user data directory.');
    }
    return { tempRoot, sourceRoot, info };
  } catch (error) {
    removeDirIfExistsSync(tempRoot);
    throw error;
  }
};

export const writePendingRestoreRequestSync = (
  userDataPath: string,
  archivePath: string,
  now = new Date(),
): PendingDataMigrationRestoreRequest => {
  const request = {
    archivePath: resolvePath(archivePath),
    requestedAt: now.toISOString(),
  };
  writeJsonSync(getPendingRestoreRequestPath(userDataPath), request);
  return request;
};

export const consumeLastRestoreResultSync = (
  userDataPath: string,
): DataMigrationLastRestoreResult | null => {
  const resultPath = getLastRestoreResultPath(userDataPath);
  const result = readJsonFileSync<DataMigrationLastRestoreResult>(resultPath);
  if (result) {
    try {
      fs.unlinkSync(resultPath);
    } catch {
      // Ignore marker cleanup failures.
    }
  }
  return result;
};

const writeRestoreResultSync = (userDataPath: string, result: DataMigrationLastRestoreResult): void => {
  writeJsonSync(getLastRestoreResultPath(userDataPath), result);
};

const buildFailedRestoreResult = (
  archivePath: string,
  rollbackPath: string | undefined,
  error: unknown,
  now: Date,
): DataMigrationLastRestoreResult => ({
  status: DataMigrationRestoreStatus.Failed,
  archivePath,
  rollbackPath,
  restoredAt: now.toISOString(),
  error: error instanceof Error ? error.message : String(error),
});

const clearRestorableUserDataSync = (userDataPath: string): void => {
  ensureDirSync(userDataPath);
  for (const entry of fs.readdirSync(userDataPath)) {
    if (isPreservedRestoreTopLevelEntry(entry)) continue;
    removeDirIfExistsSync(path.join(userDataPath, entry));
  }
};

const replaceRestorableUserDataSync = (
  sourceRoot: string,
  userDataPath: string,
  shouldExcludeCopiedEntry = isExcludedMigrationEntry,
): void => {
  clearRestorableUserDataSync(userDataPath);
  copyDirectorySync(
    sourceRoot,
    userDataPath,
    (relativePosixPath) => shouldExcludeCopiedEntry(relativePosixPath),
  );
};

const assertSqliteRestoredSync = (
  sourceRoot: string,
  userDataPath: string,
  sourceSummary = assertMigrationSqliteReadySync(path.join(sourceRoot, DB_FILENAME), 'Backup archive'),
): void => {
  const targetSummary = assertMigrationSqliteReadySync(path.join(userDataPath, DB_FILENAME), 'Restored data');
  if (sourceSummary.checksumSha256 !== targetSummary.checksumSha256) {
    throw new Error(`Restored ${DB_FILENAME} checksum does not match the backup archive.`);
  }

  for (const tableName of SQLITE_MIGRATION_TABLES) {
    const sourceCount = sourceSummary.rowCounts?.[tableName] ?? 0;
    const targetCount = targetSummary.rowCounts?.[tableName] ?? 0;
    if (sourceCount !== targetCount) {
      throw new Error(
        `Restored ${DB_FILENAME} row count mismatch for ${tableName}: expected ${sourceCount}, got ${targetCount}.`,
      );
    }
  }

  for (const key of sourceSummary.kvKeys ?? []) {
    if (!targetSummary.kvKeys?.includes(key)) {
      throw new Error(`Restored ${DB_FILENAME} is missing required kv key ${key}.`);
    }
  }
};

const restoreRollbackArchiveSync = (rollbackPath: string, userDataPath: string): void => {
  const rollback = extractMigrationArchiveToTempSync(rollbackPath, { requireSqliteDatabase: false });
  try {
    replaceRestorableUserDataSync(rollback.sourceRoot, userDataPath, isPreservedRestoreTopLevelEntry);
  } finally {
    removeDirIfExistsSync(rollback.tempRoot);
  }
};

export const performDataMigrationRestoreSync = (
  input: PerformDataMigrationRestoreInput,
): DataMigrationLastRestoreResult | null => {
  const now = input.now ?? new Date();
  const archivePath = resolvePath(input.archivePath);
  let rollbackPath: string | undefined;
  let rollbackReady = false;
  let extractedTempRoot: string | null = null;
  let targetWasTouched = false;

  try {
    ensureDirSync(input.rollbackRootPath);
    if (fs.existsSync(input.userDataPath)) {
      rollbackPath = path.join(input.rollbackRootPath, buildDataMigrationRollbackFileName(now));
      createMigrationArchiveSync({
        userDataPath: input.userDataPath,
        outputPath: rollbackPath,
        now,
        archiveKind: 'rollback',
      });
      rollbackReady = true;
    }

    const extracted = extractMigrationArchiveToTempSync(archivePath);
    extractedTempRoot = extracted.tempRoot;
    const sourceSummary = assertMigrationSqliteReadySync(path.join(extracted.sourceRoot, DB_FILENAME), 'Backup archive');

    targetWasTouched = true;
    replaceRestorableUserDataSync(extracted.sourceRoot, input.userDataPath);
    assertSqliteRestoredSync(extracted.sourceRoot, input.userDataPath, sourceSummary);

    const result: DataMigrationLastRestoreResult = {
      status: DataMigrationRestoreStatus.Success,
      archivePath,
      rollbackPath,
      restoredAt: now.toISOString(),
    };
    writeRestoreResultSync(input.userDataPath, result);
    return result;
  } catch (error) {
    if (targetWasTouched && rollbackReady && rollbackPath) {
      try {
        restoreRollbackArchiveSync(rollbackPath, input.userDataPath);
      } catch {
        // Leave the original error as the reported failure.
      }
    }
    const result = buildFailedRestoreResult(archivePath, rollbackPath, error, now);
    try {
      writeRestoreResultSync(input.userDataPath, result);
    } catch {
      // If even marker writing fails, return the result to the caller.
    }
    return result;
  } finally {
    if (extractedTempRoot) {
      removeDirIfExistsSync(extractedTempRoot);
    }
  }
};

export const performPendingDataMigrationRestoreSync = (
  input: PerformPendingDataMigrationRestoreInput,
): DataMigrationLastRestoreResult | null => {
  const pendingPath = getPendingRestoreRequestPath(input.userDataPath);
  const request = readJsonFileSync<PendingDataMigrationRestoreRequest>(pendingPath);
  if (!request?.archivePath) return null;

  try {
    fs.unlinkSync(pendingPath);
  } catch {
    // The request has already been read; continue.
  }

  return performDataMigrationRestoreSync({
    ...input,
    archivePath: request.archivePath,
  });
};
