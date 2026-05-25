import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { monitorDatabaseTool } from './monitor';

describe('monitorDatabaseTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('rejects unknown fields before resolving a connection', async () => {
    const result = await monitorDatabaseTool.execute({
      includeQueries: true,
      unexpected: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(result.content[0].text).not.toContain('[object Object]');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('rejects unknown alert threshold fields before resolving a connection', async () => {
    const result = await monitorDatabaseTool.execute({
      alertThresholds: {
        cacheHitRatio: 0.9,
        unexpected: true
      }
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(result.content[0].text).not.toContain('[object Object]');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('redacts active query text in metrics and alert context', async () => {
    const queryStart = new Date(Date.now() - 65_000).toISOString();
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryOne: vi.fn()
        .mockResolvedValueOnce({
          db_name: 'postgres',
          db_size: '10 MB',
          uptime: '1 day',
          committed_tx: '100',
          rolled_back_tx: '2'
        })
        .mockResolvedValueOnce({
          active_connections: '1',
          idle_connections: '0',
          total_connections: '1',
          max_connections: '100'
        })
        .mockResolvedValueOnce({
          cache_hit_ratio: 0.99
        }),
      query: vi.fn().mockResolvedValue([
        {
          pid: '123',
          usename: 'app',
          datname: 'postgres',
          query_start: queryStart,
          state: 'active',
          wait_event: null,
          query: "SELECT * FROM sessions WHERE api_key = 'secret-key' AND user_id = 99"
        }
      ]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await monitorDatabaseTool.execute({
      includeQueries: true,
      alertThresholds: {
        longRunningQuerySeconds: 30
      }
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("api_key = '?'");
    expect(output).toContain('user_id = ?');
    expect(output).not.toContain('secret-key');
    expect(output).not.toContain('user_id = 99');
  });

  it('sanitizes monitor errors before logging and returning them', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryOne: vi.fn().mockRejectedValue(
        new Error("postgresql://app:monitor-secret@localhost/main failed on SELECT * FROM tokens WHERE value = 'raw-token'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await monitorDatabaseTool.execute({}, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    const logOutput = consoleError.mock.calls.flat().join(' ');
    expect(result.isError).toBe(true);
    expect(output).toContain('postgresql://app:*****@localhost/main');
    expect(output).toContain("value = '?'");
    expect(output).not.toContain('monitor-secret');
    expect(output).not.toContain('raw-token');
    expect(logOutput).not.toContain('monitor-secret');
    expect(logOutput).not.toContain('raw-token');
  });

  it('caps active query metrics before formatting output', async () => {
    const queryStart = new Date(Date.now() - 65_000).toISOString();
    const activeQueries = Array.from({ length: 51 }, (_, index) => ({
      pid: String(1000 + index),
      usename: 'app',
      datname: 'postgres',
      query_start: queryStart,
      state: 'active',
      wait_event: null,
      query: `SELECT * FROM sessions WHERE token = 'secret-${index}'`
    }));
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryOne: vi.fn()
        .mockResolvedValueOnce({
          db_name: 'postgres',
          db_size: '10 MB',
          uptime: '1 day',
          committed_tx: '100',
          rolled_back_tx: '2'
        })
        .mockResolvedValueOnce({
          active_connections: '1',
          idle_connections: '0',
          total_connections: '1',
          max_connections: '100'
        })
        .mockResolvedValueOnce({
          cache_hit_ratio: 0.99
        }),
      query: vi.fn().mockResolvedValue(activeQueries),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await monitorDatabaseTool.execute({
      includeQueries: true
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain('INFO: Active query output capped at 50 rows');
    expect(output).toContain('"pid": 1049');
    expect(output).not.toContain('"pid": 1050');
    expect(output).not.toContain('secret-50');
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 51'));
  });
});
