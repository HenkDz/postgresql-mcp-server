import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { manageUsersTool } from './users';

describe('manageUsersTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('creates users with quoted roles and escaped password literals', async () => {
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
      login: true,
      connectionLimit: 5
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('CREATE USER "app_user" PASSWORD \'owner\'\'s secret\' LOGIN CONNECTION LIMIT 5');
  });

  it('grants permissions with quoted role and target identifiers', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'grant',
      username: 'app_user',
      permissions: ['SELECT', 'UPDATE'],
      target: 'orders',
      targetType: 'table',
      schema: 'sales'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('GRANT SELECT, UPDATE ON TABLE "sales"."orders" TO "app_user"');
  });

  it('does not echo password values in alter-user success responses', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'alter',
      username: 'app_user',
      password: "owner's secret",
      login: false
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('ALTER USER "app_user" PASSWORD \'owner\'\'s secret\' NOLOGIN');
    expect(result.content[0].text).toContain('Changes: password, login');
    expect(result.content[0].text).not.toContain("owner's secret");
    expect(result.content[0].text).not.toContain('PASSWORD');
  });

  it('sanitizes user-management database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed while running ALTER USER app_user PASSWORD 'raw-secret'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'alter',
      username: 'app_user',
      password: 'raw-secret'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to alter user');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("PASSWORD '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-secret');
  });

  it('rejects unknown user-management fields before resolving a connection string', async () => {
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
      rawSql: 'GRANT SUPERUSER TO app_user'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects invalid user-management option types before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'create',
      username: 'app_user',
      connectionLimit: 1.5
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Expected integer');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects invalid connection limits before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'alter',
      username: 'app_user',
      connectionLimit: -2
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('connectionLimit');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects malformed validUntil dates before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'create',
      username: 'app_user',
      validUntil: '2024-02-31'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('validUntil must be a valid YYYY-MM-DD calendar date');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects empty permission lists before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'grant',
      username: 'app_user',
      permissions: [],
      target: 'orders',
      targetType: 'table'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('permissions');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe role identifiers before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageUsersTool.execute({
      operation: 'create',
      username: 'app_user"; drop role postgres',
      password: 'secret'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe grant targets before resolving a connection string', async () => {
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
      target: 'orders; drop table orders',
      targetType: 'table'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
