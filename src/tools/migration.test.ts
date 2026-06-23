import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { copyBetweenDatabasesTool, exportTableDataTool, importTableDataTool } from './migration';

const originalWorkspace = process.env.POSTGRES_MCP_WORKSPACE_DIR;
const originalMaxBytes = process.env.POSTGRES_MCP_MAX_FILE_BYTES;

async function makeWorkspace(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'postgres-mcp-migration-'));
}

describe('migration tools', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
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
    mockGetConnectionString.mockClear();
    vi.restoreAllMocks();
  });

  it('rejects unknown export fields before resolving a connection', async () => {
    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: 'exports/users.json',
      format: 'json',
      unexpected: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(result.content[0].text).not.toContain('[object Object]');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('blocks export paths outside the configured workspace before connecting', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: path.resolve(workspace, '..', 'outside.json'),
      format: 'json'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside POSTGRES_MCP_WORKSPACE_DIR');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('exports with quoted identifiers and structured where predicates', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{ id: 1, email: 'a@example.com' }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: 'exports/users.json',
      format: 'json',
      where: { status: 'active', id: { gte: 1 } },
      limit: 25
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('to exports/users.json');
    expect(result.content[0].text).not.toContain(workspace);
    expect(mockDb.query).toHaveBeenCalledWith(
      'SELECT * FROM "users" WHERE "status" = $1 AND "id" >= $2 LIMIT $3',
      ['active', 1, 25]
    );
    await expect(fs.promises.readFile(path.join(workspace, 'exports', 'users.json'), 'utf8')).resolves.toContain('a@example.com');
  });

  it('exports from the requested schema with a qualified table name', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{ id: 1, event: 'login' }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await exportTableDataTool.execute({
      tableName: 'events',
      schema: 'audit',
      outputPath: 'exports/events.json',
      format: 'json',
      where: { id: { gte: 1 } },
      limit: 10
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('from audit.events');
    expect(mockDb.query).toHaveBeenCalledWith(
      'SELECT * FROM "audit"."events" WHERE "id" >= $1 LIMIT $2',
      [1, 10]
    );
  });

  it('exports CSV with escaped headers, quotes, delimiters, and newlines', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{
        'full,name': 'Ada, Lovelace',
        note: 'She said "hi"\nthen left',
        padded: ' x ',
        count: 2
      }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: 'exports/users.csv',
      format: 'csv'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('SELECT * FROM "users" LIMIT $1', [1000]);
    await expect(fs.promises.readFile(path.join(workspace, 'exports', 'users.csv'), 'utf8')).resolves.toBe([
      '"full,name",note,padded,count',
      '"Ada, Lovelace","She said ""hi""',
      'then left"," x ",2'
    ].join('\n'));
  });

  it('rejects oversized export limits before resolving a connection', async () => {
    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: 'exports/users.json',
      format: 'json',
      limit: 100001
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Number must be less than or equal to 100000');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('rejects legacy string where predicates before connecting', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: 'exports/users.json',
      format: 'json',
      where: "token = 'raw-migration-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('String where predicates are not allowed');
    expect(result.content[0].text).not.toContain('raw-migration-secret');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown structured where operators before resolving a connection', async () => {
    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: 'exports/users.json',
      format: 'json',
      where: {
        status: {
          startsWith: 'active'
        }
      }
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).not.toContain('[object Object]');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('sanitizes export database errors before returning them', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed while exporting WHERE token = 'raw-migration-secret'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await exportTableDataTool.execute({
      tableName: 'users',
      outputPath: 'exports/users.json',
      format: 'json',
      rawWhere: "token = 'raw-migration-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to export data');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("token = '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-migration-secret');
  });

  it('rejects unknown import fields before resolving a connection', async () => {
    const result = await importTableDataTool.execute({
      tableName: 'users',
      inputPath: 'users.json',
      format: 'json',
      unexpected: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(result.content[0].text).not.toContain('[object Object]');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('imports using sandboxed files and quoted identifiers', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    await fs.promises.writeFile(path.join(workspace, 'users.json'), JSON.stringify([{ id: 1, email: 'a@example.com' }]));

    const query = vi.fn().mockResolvedValue({ rows: [] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await importTableDataTool.execute({
      tableName: 'users',
      inputPath: 'users.json',
      format: 'json'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "users" ("id", "email")'), [1, 'a@example.com']);
  });

  it('rejects JSON import rows that are not objects before connecting', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    await fs.promises.writeFile(path.join(workspace, 'users.json'), JSON.stringify([{ id: 1 }, null]));

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await importTableDataTool.execute({
      tableName: 'users',
      inputPath: 'users.json',
      format: 'json'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Import record at index ? must be a JSON object');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects JSON import array records before connecting', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    await fs.promises.writeFile(path.join(workspace, 'users.json'), JSON.stringify([[1, 'a@example.com']]));

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await importTableDataTool.execute({
      tableName: 'users',
      inputPath: 'users.json',
      format: 'json'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Import record at index ? must be a JSON object');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('imports into the requested schema and truncates the qualified table', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    await fs.promises.writeFile(path.join(workspace, 'events.json'), JSON.stringify([{ id: 1, event: 'login' }]));

    const query = vi.fn().mockResolvedValue({ rows: [] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await importTableDataTool.execute({
      tableName: 'events',
      schema: 'audit',
      inputPath: 'events.json',
      format: 'json',
      truncateFirst: true
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('into audit.events');
    expect(mockDb.query).toHaveBeenCalledWith('TRUNCATE TABLE "audit"."events"');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "audit"."events" ("id", "event")'), [1, 'login']);
  });

  it('imports CSV with escaped quotes, delimiters, CRLF rows, and quoted newlines', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    await fs.promises.writeFile(
      path.join(workspace, 'users.csv'),
      [
        '"id","email","note","empty"',
        '"1","ada,l@example.com","Line ""one""',
        'Line two",'
      ].join('\r\n')
    );

    const query = vi.fn().mockResolvedValue({ rows: [] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await importTableDataTool.execute({
      tableName: 'users',
      inputPath: 'users.csv',
      format: 'csv'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "users" ("id", "email", "note", "empty")'),
      ['1', 'ada,l@example.com', 'Line "one"\r\nLine two', '']
    );
  });

  it('rejects invalid CSV delimiters before connecting', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    await fs.promises.writeFile(path.join(workspace, 'users.csv'), 'id,email\n1,a@example.com');

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await importTableDataTool.execute({
      tableName: 'users',
      inputPath: 'users.csv',
      format: 'csv',
      delimiter: '||'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CSV delimiter must be a single non-quote, non-newline character');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects CSV rows with more values than headers before connecting', async () => {
    const workspace = await makeWorkspace();
    process.env.POSTGRES_MCP_WORKSPACE_DIR = workspace;
    await fs.promises.writeFile(path.join(workspace, 'users.csv'), 'id,email\n1,a@example.com,unexpected');

    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await importTableDataTool.execute({
      tableName: 'users',
      inputPath: 'users.csv',
      format: 'csv'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('has more values than headers');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects unknown copy fields before resolving a connection', async () => {
    const result = await copyBetweenDatabasesTool.execute({
      sourceConnectionString: 'postgresql://source',
      targetConnectionString: 'postgresql://target',
      tableName: 'users',
      unexpected: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(result.content[0].text).not.toContain('[object Object]');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('resolves copy source and target connection strings before connecting', async () => {
    const resolvingGetConnectionString = vi.fn((connectionString?: string) => `${connectionString}?resolved`);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{ id: 1, email: 'a@example.com' }]),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await copyBetweenDatabasesTool.execute({
      sourceConnectionString: 'postgresql://source',
      targetConnectionString: 'postgresql://target',
      tableName: 'users',
      where: { status: 'active' }
    }, resolvingGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(resolvingGetConnectionString).toHaveBeenCalledWith('postgresql://source');
    expect(resolvingGetConnectionString).toHaveBeenCalledWith('postgresql://target');
    expect(mockDb.connect).toHaveBeenNthCalledWith(1, 'postgresql://source?resolved');
    expect(mockDb.connect).toHaveBeenNthCalledWith(2, 'postgresql://target?resolved');
    expect(mockDb.query).toHaveBeenCalledWith('SELECT * FROM "users" WHERE "status" = $1 LIMIT $2', ['active', 1000]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "users" ("id", "email")'), [1, 'a@example.com']);
  });

  it('copies between the requested source and target schema', async () => {
    const resolvingGetConnectionString = vi.fn((connectionString?: string) => `${connectionString}?resolved`);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{ id: 1, event: 'login' }]),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await copyBetweenDatabasesTool.execute({
      sourceConnectionString: 'postgresql://source',
      targetConnectionString: 'postgresql://target',
      tableName: 'events',
      schema: 'audit',
      limit: 10,
      truncateTarget: true
    }, resolvingGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('to audit.events');
    expect(mockDb.query).toHaveBeenNthCalledWith(1, 'SELECT * FROM "audit"."events" LIMIT $1', [10]);
    expect(mockDb.query).toHaveBeenNthCalledWith(2, 'TRUNCATE TABLE "audit"."events"');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "audit"."events" ("id", "event")'), [1, 'login']);
  });

  it('rejects oversized copy limits before resolving connection strings', async () => {
    const result = await copyBetweenDatabasesTool.execute({
      sourceConnectionString: 'postgresql://source',
      targetConnectionString: 'postgresql://target',
      tableName: 'users',
      limit: 100001
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Number must be less than or equal to 100000');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('rejects denied copy connection targets before connecting', async () => {
    const rejectingGetConnectionString = vi.fn((connectionString?: string) => {
      if (connectionString === 'postgresql://denied-source') {
        throw new Error('Connection target "denied-source" is not allowed by the configured connection target allowlist.');
      }

      return connectionString ?? 'postgresql://fallback';
    });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await copyBetweenDatabasesTool.execute({
      sourceConnectionString: 'postgresql://denied-source',
      targetConnectionString: 'postgresql://target',
      tableName: 'users'
    }, rejectingGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not allowed by the configured connection target allowlist');
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe copy table identifiers before resolving a connection', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await copyBetweenDatabasesTool.execute({
      sourceConnectionString: 'postgresql://source',
      targetConnectionString: 'postgresql://target',
      tableName: 'users; drop table users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });
});
