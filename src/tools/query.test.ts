import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { manageQueryTool } from './query';

describe('manageQueryTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('builds EXPLAIN only for a single read-only statement', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': 1, 'Plan Rows': 1 } }] }] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>, options: unknown) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'explain',
      query: 'SELECT * FROM users WHERE email = $1',
      format: 'json',
      costs: false
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.transaction).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
    expect(query).toHaveBeenCalledWith('EXPLAIN (COSTS false, FORMAT JSON) SELECT * FROM users WHERE email = $1');
  });

  it('redacts echoed EXPLAIN SQL in successful responses', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': 1, 'Plan Rows': 1 } }] }] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>, options: unknown) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'explain',
      query: "SELECT * FROM sessions WHERE token = 'raw-token' AND id = 42",
      format: 'json'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("token = '?'");
    expect(output).toContain('id = ?');
    expect(output).not.toContain('raw-token');
    expect(output).not.toContain('id = 42');
  });

  it('sanitizes EXPLAIN database errors before returning them', async () => {
    const query = vi.fn().mockRejectedValue(
      new Error("password=db-secret failed on SELECT * FROM sessions WHERE token = 'raw-token'")
    );
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>, options: unknown) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'explain',
      query: "SELECT * FROM sessions WHERE token = 'raw-token'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to explain query');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("token = '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-token');
  });

  it('rejects multi-statement EXPLAIN input before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'explain',
      query: 'SELECT 1; DROP TABLE users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('without semicolons');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects data-changing CTEs in EXPLAIN before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'explain',
      query: 'WITH inserted AS (INSERT INTO users(email) VALUES ($1) RETURNING *) SELECT * FROM inserted'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INSERT');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('parameterizes slow-query duration filters and caps limits', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'get_slow_queries',
      limit: 25,
      minDuration: 100,
      orderBy: 'total_time'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE mean_time >= $2'), [25, 100]);
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining('ORDER BY total_time DESC'), [25, 100]);
  });

  it('orders slow queries by computed cache hit ratio when requested', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'get_slow_queries',
      orderBy: 'cache_hit_ratio'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining('END as cache_hit_ratio'), [10]);
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining('ORDER BY cache_hit_ratio DESC'), [10]);
  });

  it('redacts literals in slow-query output from pg_stat_statements', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([{
          query: "SELECT * FROM users WHERE email = 'admin@example.com' AND token = 'secret'",
          calls: 3,
          total_time: 120,
          mean_time: 40,
          rows: 3,
          stddev_time: 1,
          min_time: 39,
          max_time: 41,
          shared_blks_hit: 10,
          shared_blks_read: 0,
          shared_blks_written: 0,
          temp_blks_read: 0,
          temp_blks_written: 0
        }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'get_slow_queries'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("email = '?'");
    expect(output).toContain("token = '?'");
    expect(output).not.toContain('admin@example.com');
    expect(output).not.toContain('secret');
  });

  it('redacts literals in query stats output from pg_stat_statements', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([{
          query_id: '123',
          query: "UPDATE users SET password = 'new-secret' WHERE id = 42",
          calls: 1,
          total_time: 20,
          mean_time: 20,
          min_time: 20,
          max_time: 20,
          stddev_time: 0,
          rows: 1,
          shared_blks_hit: 1,
          shared_blks_read: 0,
          shared_blks_written: 1,
          cache_hit_ratio: 100
        }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'get_stats'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("password = '?'");
    expect(output).toContain('id = ?');
    expect(output).not.toContain('new-secret');
    expect(output).not.toContain('id = 42');
  });

  it('rejects invalid limits before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'get_stats',
      limit: 101
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown query-management fields before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      query: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'explain',
      query: 'SELECT * FROM users',
      rawSql: 'DROP TABLE users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects invalid reset query IDs before executing reset', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageQueryTool.execute({
      operation: 'reset_stats',
      queryId: '123;select'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('queryId must be');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
