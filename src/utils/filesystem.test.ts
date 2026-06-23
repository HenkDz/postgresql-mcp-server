import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReadableSandboxFile,
  assertWritableContentSize,
  getFileSandboxConfig,
  resolveSandboxPath
} from './filesystem';

const originalWorkspace = process.env.POSTGRES_MCP_WORKSPACE_DIR;
const originalMaxBytes = process.env.POSTGRES_MCP_MAX_FILE_BYTES;

async function makeWorkspace(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'postgres-mcp-fs-'));
}

async function trySymlink(target: string, linkPath: string, type: fs.symlink.Type): Promise<boolean> {
  try {
    await fs.promises.symlink(target, linkPath, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
    return true;
  } catch {
    return false;
  }
}

describe('filesystem sandbox helpers', () => {
  afterEach(async () => {
    if (originalWorkspace === undefined) {
      delete process.env.POSTGRES_MCP_WORKSPACE_DIR;
    } else {
      process.env.POSTGRES_MCP_WORKSPACE_DIR = originalWorkspace;
    }

    if (originalMaxBytes === undefined) {
      delete process.env.POSTGRES_MCP_MAX_FILE_BYTES;
    } else {
      process.env.POSTGRES_MCP_MAX_FILE_BYTES = originalMaxBytes;
    }
  });

  it('requires an explicit workspace directory', () => {
    delete process.env.POSTGRES_MCP_WORKSPACE_DIR;

    expect(() => getFileSandboxConfig()).toThrow('POSTGRES_MCP_WORKSPACE_DIR');
  });

  it('requires positive integer max file bytes when configured', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    process.env.POSTGRES_MCP_MAX_FILE_BYTES = '1.5';
    expect(() => getFileSandboxConfig()).toThrow('POSTGRES_MCP_MAX_FILE_BYTES must be a positive integer');

    process.env.POSTGRES_MCP_MAX_FILE_BYTES = '0';
    expect(() => getFileSandboxConfig()).toThrow('POSTGRES_MCP_MAX_FILE_BYTES must be a positive integer');
  });

  it('resolves relative paths inside the configured workspace', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    expect(resolveSandboxPath('exports/users.json', 'json')).toBe(path.join(workspace, 'exports', 'users.json'));
  });

  it('rejects traversal outside the configured workspace', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    expect(() => resolveSandboxPath('../outside.json', 'json')).toThrow('outside POSTGRES_MCP_WORKSPACE_DIR');
  });

  it('rejects existing file symlinks that resolve outside the configured workspace', async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const outsideFile = path.join(outside, 'secret.json');
    const linkPath = path.join(workspace, 'secret.json');
    await fs.promises.writeFile(outsideFile, '[{}]');
    if (!await trySymlink(outsideFile, linkPath, 'file')) {
      return;
    }
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    expect(() => resolveSandboxPath('secret.json', 'json')).toThrow(/outside POSTGRES_MCP_WORKSPACE_DIR|unresolved target/);
  });

  it('rejects parent directory symlinks that resolve outside the configured workspace', async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const linkPath = path.join(workspace, 'exports');
    if (!await trySymlink(outside, linkPath, 'dir')) {
      return;
    }
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    expect(() => resolveSandboxPath('exports/users.json', 'json')).toThrow('outside POSTGRES_MCP_WORKSPACE_DIR');
  });

  it('enforces extensions and requested formats', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    expect(() => resolveSandboxPath('users.txt')).toThrow('Unsupported file extension');
    expect(() => resolveSandboxPath('users.csv', 'json')).toThrow('does not match requested format');
  });

  it('checks import file size before reading', async () => {
    const workspace = await makeWorkspace();
    const inputPath = path.join(workspace, 'users.json');
    await fs.promises.writeFile(inputPath, '[{}]');
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    process.env.POSTGRES_MCP_MAX_FILE_BYTES = '2';

    await expect(assertReadableSandboxFile(inputPath, 'json')).rejects.toThrow('exceeds max file size');
  });

  it('checks export content size before writing', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    process.env.POSTGRES_MCP_MAX_FILE_BYTES = '2';

    expect(() => assertWritableContentSize('abcd')).toThrow('Generated export exceeds max file size');
  });
});
