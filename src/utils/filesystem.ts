import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.csv', '.json']);

export interface FileSandboxConfig {
  workspaceDir: string;
  maxFileBytes: number;
}

function parseMaxFileBytes(value: string | undefined): number {
  if (!value) {
    return DEFAULT_MAX_FILE_BYTES;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('POSTGRES_MCP_MAX_FILE_BYTES must be a positive integer.');
  }

  return parsed;
}

export function getFileSandboxConfig(): FileSandboxConfig {
  const workspaceDir = process.env.POSTGRES_MCP_WORKSPACE_DIR;
  if (!workspaceDir) {
    throw new Error('Filesystem tools require POSTGRES_MCP_WORKSPACE_DIR or --workspace-dir.');
  }

  return {
    workspaceDir: fs.realpathSync(path.resolve(workspaceDir)),
    maxFileBytes: parseMaxFileBytes(process.env.POSTGRES_MCP_MAX_FILE_BYTES)
  };
}

function assertInsideWorkspace(resolvedPath: string, workspaceDir: string): void {
  const relativePath = path.relative(workspaceDir, resolvedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Path "${resolvedPath}" is outside POSTGRES_MCP_WORKSPACE_DIR.`);
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function realpathIfExists(resolvedPath: string): string | undefined {
  try {
    return fs.realpathSync(resolvedPath);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }

    throw error;
  }
}

function assertNoDanglingSymlink(resolvedPath: string): void {
  try {
    if (fs.lstatSync(resolvedPath).isSymbolicLink()) {
      throw new Error(`Path "${resolvedPath}" is a symlink with an unresolved target.`);
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}

function nearestExistingParentRealpath(resolvedPath: string): string {
  let currentPath = path.dirname(resolvedPath);

  while (true) {
    const realPath = realpathIfExists(currentPath);
    if (realPath) {
      return realPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Path "${resolvedPath}" has no existing parent directory.`);
    }

    currentPath = parentPath;
  }
}

function assertAllowedExtension(resolvedPath: string, expectedFormat?: 'json' | 'csv'): void {
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file extension "${extension}". Only .json and .csv are allowed.`);
  }

  if (expectedFormat && extension !== `.${expectedFormat}`) {
    throw new Error(`File extension "${extension}" does not match requested format "${expectedFormat}".`);
  }
}

export function resolveSandboxPath(inputPath: string, expectedFormat?: 'json' | 'csv'): string {
  const config = getFileSandboxConfig();
  const resolvedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(config.workspaceDir, inputPath);

  assertInsideWorkspace(resolvedPath, config.workspaceDir);
  assertAllowedExtension(resolvedPath, expectedFormat);

  const realResolvedPath = realpathIfExists(resolvedPath);
  if (realResolvedPath) {
    assertInsideWorkspace(realResolvedPath, config.workspaceDir);
  } else {
    assertNoDanglingSymlink(resolvedPath);
    assertInsideWorkspace(nearestExistingParentRealpath(resolvedPath), config.workspaceDir);
  }

  return resolvedPath;
}

export async function assertReadableSandboxFile(inputPath: string, expectedFormat?: 'json' | 'csv'): Promise<string> {
  const resolvedPath = resolveSandboxPath(inputPath, expectedFormat);
  const config = getFileSandboxConfig();
  const stats = await fs.promises.stat(resolvedPath);

  if (!stats.isFile()) {
    throw new Error(`Path "${resolvedPath}" is not a file.`);
  }

  if (stats.size > config.maxFileBytes) {
    throw new Error(`File "${resolvedPath}" exceeds max file size of ${config.maxFileBytes} bytes.`);
  }

  return resolvedPath;
}

export function assertWritableContentSize(content: string): void {
  const config = getFileSandboxConfig();
  const byteLength = Buffer.byteLength(content, 'utf8');

  if (byteLength > config.maxFileBytes) {
    throw new Error(`Generated export exceeds max file size of ${config.maxFileBytes} bytes.`);
  }
}
