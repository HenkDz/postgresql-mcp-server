import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { manageConstraintsTool } from './constraints';

describe('manageConstraintsTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('creates unique constraints with quoted identifiers', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create',
      constraintName: 'users_email_unique',
      tableName: 'users',
      constraintTypeCreate: 'unique',
      columnNames: ['email']
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('ALTER TABLE "users"'));
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('ADD CONSTRAINT "users_email_unique"'));
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('UNIQUE ("email")'));
  });

  it('creates foreign keys with quoted local and referenced identifiers', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create_fk',
      constraintName: 'orders_user_id_fkey',
      tableName: 'orders',
      columnNames: ['user_id'],
      referencedTable: 'users',
      referencedColumns: ['id'],
      schema: 'sales',
      referencedSchema: 'public'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('ALTER TABLE "sales"."orders"'));
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('ADD CONSTRAINT "orders_user_id_fkey"'));
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('FOREIGN KEY ("user_id")'));
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('REFERENCES "users" ("id")'));
  });

  it('redacts check clauses returned from catalog listings', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{
        constraint_name: 'users_token_check',
        constraint_type: 'CHECK',
        table_name: 'users',
        column_name: 'token',
        check_clause: "token <> 'raw-check-secret'",
        is_deferrable: 'NO',
        initially_deferred: 'NO'
      }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'get',
      constraintType: 'CHECK'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("token <> '?'");
    expect(output).not.toContain('raw-check-secret');
  });

  it('does not echo check expressions in create-constraint success responses', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create',
      constraintName: 'users_token_check',
      tableName: 'users',
      constraintTypeCreate: 'check',
      checkExpression: "token <> 'raw-check-secret'"
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("CHECK (token <> 'raw-check-secret')"));
    expect(output).toContain('"constraintType": "check"');
    expect(output).not.toContain('raw-check-secret');
    expect(output).not.toContain('checkExpression');
  });

  it('sanitizes constraint database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed near CHECK (token <> 'raw-check-secret')")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create',
      constraintName: 'users_token_check',
      tableName: 'users',
      constraintTypeCreate: 'check',
      checkExpression: "token <> 'raw-check-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to create constraint');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("token <> '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-check-secret');
  });

  it('preserves validation errors instead of wrapping them as internal errors', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create_fk',
      constraintName: 'orders_user_id_fkey',
      tableName: 'orders',
      columnNames: ['user_id', 'account_id'],
      referencedTable: 'users',
      referencedColumns: ['id']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Number of columns must match number of referenced columns');
    expect(result.content[0].text).not.toContain('Failed to create foreign key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown constraint-management fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create',
      constraintName: 'users_token_check',
      tableName: 'users',
      constraintTypeCreate: 'check',
      checkExpression: "token <> 'raw-check-secret'",
      rawSql: 'DROP TABLE users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe identifiers before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create',
      constraintName: 'users_email_unique',
      tableName: 'users; drop table users',
      constraintTypeCreate: 'unique',
      columnNames: ['email']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects empty constraint column arrays before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create',
      constraintName: 'users_email_unique',
      tableName: 'users',
      constraintTypeCreate: 'unique',
      columnNames: []
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('columnNames');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe drop-constraint identifiers before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'drop',
      constraintName: 'users_email_unique; drop table users',
      tableName: 'users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe foreign-key identifiers before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageConstraintsTool.execute({
      operation: 'create_fk',
      constraintName: 'orders_user_id_fkey',
      tableName: 'orders',
      columnNames: ['user_id; drop table orders'],
      referencedTable: 'users',
      referencedColumns: ['id']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
