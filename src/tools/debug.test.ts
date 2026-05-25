import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { debugDatabaseTool } from './debug';

describe('debugDatabaseTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('rejects unknown fields before resolving a connection', async () => {
    const result = await debugDatabaseTool.execute({
      issue: 'connection',
      unexpected: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('redacts active query literals in performance diagnostics', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([
          {
            query: "SELECT * FROM users WHERE email = 'admin@example.com' AND token = 'secret'",
            duration: 45
          }
        ])
        .mockResolvedValueOnce([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await debugDatabaseTool.execute({
      issue: 'performance'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("email = '?'");
    expect(output).toContain("token = '?'");
    expect(output).not.toContain('admin@example.com');
    expect(output).not.toContain('secret');
  });

  it('redacts blocked query literals in lock diagnostics', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([
        {
          blocked_pid: 11,
          blocked_user: 'app',
          blocking_pid: 12,
          blocking_user: 'worker',
          blocked_statement: "UPDATE users SET password = 'new-secret' WHERE id = 42"
        }
      ]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await debugDatabaseTool.execute({
      issue: 'locks'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("password = '?'");
    expect(output).toContain('id = ?');
    expect(output).not.toContain('new-secret');
    expect(output).not.toContain('id = 42');
  });

  it('sanitizes caught diagnostic errors before returning details', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=diagnostic-secret failed while running SELECT * FROM users WHERE token = 'raw-token'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await debugDatabaseTool.execute({
      issue: 'connection'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain('password=*****');
    expect(output).toContain("token = '?'");
    expect(output).not.toContain('diagnostic-secret');
    expect(output).not.toContain('raw-token');
  });

  it('caps performance diagnostic rows before formatting output', async () => {
    const slowQueries = Array.from({ length: 26 }, (_, index) => ({
      query: `SELECT * FROM jobs WHERE token = 'secret-${index}'`,
      duration: index + 30
    }));
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce(slowQueries)
        .mockResolvedValueOnce([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await debugDatabaseTool.execute({
      issue: 'performance'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain('Additional long-running queries omitted after 25 rows.');
    expect(output).toContain('Duration: 54s');
    expect(output).not.toContain('Duration: 55s');
    expect(output).not.toContain('secret-25');
    expect(mockDb.query).toHaveBeenNthCalledWith(1, expect.stringContaining('LIMIT 26'));
  });
});
