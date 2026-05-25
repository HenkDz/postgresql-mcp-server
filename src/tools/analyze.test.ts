import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { analyzeDatabaseTool } from './analyze';

describe('analyzeDatabaseTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('defaults to configuration analysis and avoids diagnostic stderr logging', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ version: 'PostgreSQL 16' }])
        .mockResolvedValueOnce([
          { name: 'max_connections', setting: '100', unit: '' },
          { name: 'shared_buffers', setting: '128', unit: 'MB' }
        ])
        .mockResolvedValueOnce([{ count: '5' }])
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([{ ratio: '0.98' }])
        .mockResolvedValueOnce([{ tablename: 'users', size: '16 kB' }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await analyzeDatabaseTool.execute({}, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      version: 'PostgreSQL 16',
      metrics: {
        connections: 5,
        activeQueries: 1,
        cacheHitRatio: 0.98,
        tableSizesSchema: 'public',
        tableSizes: {
          users: '16 kB'
        }
      }
    });
    expect(mockDb.query).toHaveBeenNthCalledWith(6, expect.stringContaining('n.nspname = $1'), ['public', 101]);
  });

  it('rejects invalid analysis types before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await analyzeDatabaseTool.execute({
      analysisType: 'all'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects unknown fields before resolving a connection', async () => {
    const result = await analyzeDatabaseTool.execute({
      analysisType: 'configuration',
      unexpected: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('caps table size diagnostics before formatting output', async () => {
    const tableRows = Array.from({ length: 101 }, (_, index) => ({
      tablename: `table_${index}`,
      size: `${index} kB`
    }));
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ version: 'PostgreSQL 16' }])
        .mockResolvedValueOnce([{ name: 'max_connections', setting: '100', unit: '' }])
        .mockResolvedValueOnce([{ count: '5' }])
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([{ ratio: '0.99' }])
        .mockResolvedValueOnce(tableRows),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await analyzeDatabaseTool.execute({}, mockGetConnectionString);
    const output = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(Object.keys(output.metrics.tableSizes)).toHaveLength(100);
    expect(output.metrics.tableSizes.table_99).toBe('99 kB');
    expect(output.metrics.tableSizes.table_100).toBeUndefined();
    expect(output.metrics.tableSizesCapped).toBe(true);
    expect(output.recommendations).toContain('Table size diagnostics are capped at the largest 100 tables in schema "public"');
    expect(mockDb.query).toHaveBeenNthCalledWith(6, expect.stringContaining('LIMIT $2'), ['public', 101]);
  });

  it('uses the requested schema for table-size diagnostics', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([{ version: 'PostgreSQL 16' }])
        .mockResolvedValueOnce([{ name: 'max_connections', setting: '100', unit: '' }])
        .mockResolvedValueOnce([{ count: '5' }])
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([{ ratio: '0.99' }])
        .mockResolvedValueOnce([{ tablename: 'events', size: '16 kB' }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await analyzeDatabaseTool.execute({ schema: 'audit' }, mockGetConnectionString);
    const output = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(output.metrics.tableSizesSchema).toBe('audit');
    expect(output.metrics.tableSizes).toEqual({ events: '16 kB' });
    expect(mockDb.query).toHaveBeenNthCalledWith(6, expect.stringContaining('n.nspname = $1'), ['audit', 101]);
  });
});
