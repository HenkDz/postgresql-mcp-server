import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { manageIndexesTool } from './indexes';

describe('manageIndexesTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('creates indexes with quoted identifiers and structured partial predicates', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'create',
      indexName: 'idx_users_active_email',
      tableName: 'users',
      columns: ['email'],
      schema: 'public',
      unique: true,
      where: {
        active: true,
        deleted_at: { isNull: true }
      }
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_active_email" ON "users" ("email") WHERE "active" = TRUE AND "deleted_at" IS NULL'
    );
    expect(result.content[0].text).toContain('"predicateSet":true');
    expect(result.content[0].text).not.toContain('CREATE UNIQUE INDEX');
  });

  it('does not echo raw partial-index predicates in create success responses', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'create',
      indexName: 'idx_sessions_token',
      tableName: 'sessions',
      columns: ['token'],
      rawWhere: "token <> 'raw-index-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(
      'CREATE INDEX IF NOT EXISTS "idx_sessions_token" ON "sessions" ("token") WHERE token <> \'raw-index-secret\''
    );
    expect(result.content[0].text).toContain('"predicateSet":true');
    expect(result.content[0].text).not.toContain('raw-index-secret');
    expect(result.content[0].text).not.toContain('token <>');
  });

  it('redacts index definitions returned from catalog lookups', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{
        schemaname: 'public',
        tablename: 'sessions',
        indexname: 'idx_sessions_token',
        indexdef: "CREATE INDEX idx_sessions_token ON sessions USING btree (token) WHERE token = 'raw-index-secret'",
        size: '16 kB'
      }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'get',
      includeStats: false
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("token = '?'");
    expect(output).not.toContain('raw-index-secret');
  });

  it('uses pg_stat_user_indexes column names for stats lookups', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'get',
      tableName: 'sessions'
    }, mockGetConnectionString);

    const query = mockDb.query.mock.calls[0][0] as string;
    expect(result.isError).toBeUndefined();
    expect(query).toContain('psi.relname AS tablename');
    expect(query).toContain('psi.indexrelname AS indexname');
    expect(query).toContain('pg_relation_size(psi.indexrelid)');
    expect(query).toContain('AND psi.relname = $2');
  });

  it('uses pg_stat_user_indexes column names for usage analysis', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue({ formatted: '0 bytes' }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'analyze_usage',
      tableName: 'sessions'
    }, mockGetConnectionString);

    const usageQuery = mockDb.query.mock.calls[0][0] as string;
    const duplicateQuery = mockDb.query.mock.calls[1][0] as string;
    expect(result.isError).toBeUndefined();
    expect(usageQuery).toContain('psi.relname AS tablename');
    expect(usageQuery).toContain('psi.indexrelname AS indexname');
    expect(usageQuery).toContain('AND psi.relname = $2');
    expect(usageQuery).toContain('AND NOT pi.indisprimary');
    expect(duplicateQuery).toContain('array_agg(psi.indexrelname)');
    expect(duplicateQuery).toContain('GROUP BY psi.schemaname, psi.relname, pi.indkey');
  });

  it('rejects legacy string partial-index predicates before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'create',
      indexName: 'idx_sessions_token',
      tableName: 'sessions',
      columns: ['token'],
      where: "token <> 'raw-index-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('String where predicates are not allowed');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown index-management fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'create',
      indexName: 'idx_sessions_token',
      tableName: 'sessions',
      columns: ['token'],
      rawSql: 'DROP INDEX idx_sessions_token'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown structured partial-index operators before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'create',
      indexName: 'idx_sessions_token',
      tableName: 'sessions',
      columns: ['token'],
      where: {
        token: { raw: "token <> 'secret'" }
      }
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('sanitizes index database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed near WHERE token = 'raw-index-secret'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'create',
      indexName: 'idx_sessions_token',
      tableName: 'sessions',
      columns: ['token'],
      rawWhere: "token = 'raw-index-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to create index');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("token = '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-index-secret');
  });

  it('rejects unsafe identifiers before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'create',
      indexName: 'idx_users_email',
      tableName: 'users; drop table users',
      columns: ['email']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe drop-index identifiers before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'drop',
      indexName: 'idx_users_email; drop table users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe reindex targets before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'reindex',
      target: 'users; drop table users',
      type: 'table'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects negative index analysis size filters before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageIndexesTool.execute({
      operation: 'analyze_usage',
      minSizeBytes: -1
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('minSizeBytes');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
