import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { manageCommentsTool } from './comments';

describe('manageCommentsTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('sets comments with quoted identifiers and escaped comment literals', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageCommentsTool.execute({
      operation: 'set',
      objectType: 'table',
      objectName: 'users',
      schema: 'public',
      comment: "Owner's account table"
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('COMMENT ON TABLE "public"."users" IS \'Owner\'\'s account table\'');
    expect(result.content.map((item) => item.text).join('\n')).not.toContain("Owner's account table");
    expect(result.content.map((item) => item.text).join('\n')).toContain('"commentSet": true');
  });

  it('sets column and function comments with explicit object targets', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const columnResult = await manageCommentsTool.execute({
      operation: 'set',
      objectType: 'column',
      objectName: 'orders',
      columnName: 'total_amount',
      schema: 'sales',
      comment: 'Order total'
    }, mockGetConnectionString);
    const functionResult = await manageCommentsTool.execute({
      operation: 'set',
      objectType: 'function',
      objectName: 'calculate_tax',
      functionSignature: 'numeric, text',
      schema: 'sales',
      comment: 'Tax calculator'
    }, mockGetConnectionString);

    expect(columnResult.isError).toBeUndefined();
    expect(functionResult.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenNthCalledWith(1, 'COMMENT ON COLUMN "sales"."orders"."total_amount" IS \'Order total\'');
    expect(mockDb.query).toHaveBeenNthCalledWith(2, 'COMMENT ON FUNCTION "sales"."calculate_tax"(numeric, text) IS \'Tax calculator\'');
  });

  it('removes constraint and trigger comments with a separate parent table name', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const constraintResult = await manageCommentsTool.execute({
      operation: 'remove',
      objectType: 'constraint',
      objectName: 'orders_user_id_fkey',
      tableName: 'orders',
      schema: 'sales'
    }, mockGetConnectionString);
    const triggerResult = await manageCommentsTool.execute({
      operation: 'remove',
      objectType: 'trigger',
      objectName: 'orders_audit_trigger',
      tableName: 'orders',
      schema: 'sales'
    }, mockGetConnectionString);

    expect(constraintResult.isError).toBeUndefined();
    expect(triggerResult.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenNthCalledWith(1, 'COMMENT ON CONSTRAINT "orders_user_id_fkey" ON "sales"."orders" IS NULL');
    expect(mockDb.query).toHaveBeenNthCalledWith(2, 'COMMENT ON TRIGGER "orders_audit_trigger" ON "sales"."orders" IS NULL');
  });

  it('sanitizes comment database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed near COMMENT ON TABLE users IS 'raw-comment-secret'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageCommentsTool.execute({
      operation: 'set',
      objectType: 'table',
      objectName: 'users',
      comment: 'raw-comment-secret'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to set comment');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("IS '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-comment-secret');
  });

  it('rejects unknown comment-management fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageCommentsTool.execute({
      operation: 'set',
      objectType: 'table',
      objectName: 'users',
      comment: 'Unsafe',
      rawSql: 'COMMENT ON DATABASE postgres IS NULL'
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

    const result = await manageCommentsTool.execute({
      operation: 'set',
      objectType: 'table',
      objectName: 'users; drop table users',
      comment: 'Unsafe'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects missing column lookup fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageCommentsTool.execute({
      operation: 'get',
      objectType: 'column',
      objectName: 'users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('columnName is required');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe function signatures before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageCommentsTool.execute({
      operation: 'set',
      objectType: 'function',
      objectName: 'calculate_tax',
      functionSignature: 'numeric); drop function calculate_tax',
      comment: 'Unsafe'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid function signature');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe parent-table comment targets before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageCommentsTool.execute({
      operation: 'remove',
      objectType: 'trigger',
      objectName: 'orders_audit_trigger',
      tableName: 'orders; drop table orders'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
