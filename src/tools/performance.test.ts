import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { explainQueryTool, getQueryStatsTool, getSlowQueriesTool, resetQueryStatsTool } from './performance';

describe('legacy direct performance tools', () => {
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

    const result = await explainQueryTool.execute({
      query: 'SELECT * FROM users',
      format: 'json',
      costs: false
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.transaction).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
    expect(query).toHaveBeenCalledWith('EXPLAIN (COSTS false, FORMAT JSON) SELECT * FROM users');
  });

  it('redacts echoed EXPLAIN SQL in legacy successful responses', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': 1, 'Plan Rows': 1 } }] }] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>, options: unknown) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await explainQueryTool.execute({
      query: "SELECT * FROM sessions WHERE api_key = 'raw-key' AND id = 42",
      format: 'json'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("api_key = '?'");
    expect(output).toContain('id = ?');
    expect(output).not.toContain('raw-key');
    expect(output).not.toContain('id = 42');
  });

  it('sanitizes legacy EXPLAIN database errors before returning them', async () => {
    const query = vi.fn().mockRejectedValue(
      new Error("password=db-secret failed on SELECT * FROM sessions WHERE api_key = 'raw-key'")
    );
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>, options: unknown) => callback({ query })),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await explainQueryTool.execute({
      query: "SELECT * FROM sessions WHERE api_key = 'raw-key'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to explain query');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("api_key = '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-key');
  });

  it('rejects unsafe EXPLAIN input before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await explainQueryTool.execute({
      query: 'UPDATE users SET admin = true'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('read-only SELECT');
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown EXPLAIN input fields before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await explainQueryTool.execute({
      query: 'SELECT * FROM users',
      rawSql: 'DROP TABLE users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects data-changing CTEs in legacy EXPLAIN before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await explainQueryTool.execute({
      query: 'WITH updated AS (UPDATE users SET admin = true RETURNING *) SELECT * FROM updated'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('UPDATE');
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('parameterizes slow-query duration filters', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getSlowQueriesTool.execute({
      limit: 25,
      minDuration: 100,
      orderBy: 'total_time'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE mean_time >= $2'), [25, 100]);
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining('ORDER BY total_time DESC'), [25, 100]);
  });

  it('rejects unknown slow-query input fields before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getSlowQueriesTool.execute({
      orderBy: 'calls',
      injectedOrderBy: 'query; DROP TABLE users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects unknown query-stats input fields before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getQueryStatsTool.execute({
      orderBy: 'total_time',
      rawFilter: 'query ILIKE \'%secret%\''
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('redacts literals in legacy slow-query output', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([{
          query: "SELECT * FROM sessions WHERE api_key = 'secret-key'",
          calls: 2,
          total_time: 80,
          mean_time: 40,
          rows: 2,
          stddev_time: 1,
          min_time: 39,
          max_time: 41,
          shared_blks_hit: 5,
          shared_blks_read: 0,
          shared_blks_written: 0,
          temp_blks_read: 0,
          temp_blks_written: 0
        }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getSlowQueriesTool.execute({}, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("api_key = '?'");
    expect(output).not.toContain('secret-key');
  });

  it('rejects invalid reset query IDs before executing reset', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await resetQueryStatsTool.execute({
      queryId: '123;select'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('queryId must be');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown reset-stat input fields before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await resetQueryStatsTool.execute({
      queryId: '123',
      resetAll: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
