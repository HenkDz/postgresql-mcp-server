import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { manageUsersTool } from './users';

describe('manageUsersTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('quotes roles and escapes password literals when creating users', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'create',
      username: 'app_user',
      password: "owner's secret",
      login: true
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('CREATE USER "app_user" PASSWORD \'owner\'\'s secret\' LOGIN');
  });

  it('rejects unsafe role identifiers before executing SQL', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'drop',
      username: 'victim"; ALTER USER postgres WITH SUPERUSER; --'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('quotes grant targets and grantees', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'grant',
      username: 'app_user',
      permissions: ['SELECT'],
      target: 'orders',
      targetType: 'table',
      schema: 'sales'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('GRANT SELECT ON TABLE "sales"."orders" TO "app_user"');
  });
});
