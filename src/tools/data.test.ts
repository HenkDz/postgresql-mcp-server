import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { executeMutationTool, executeQueryTool, executeSqlTool } from './data';

describe('executeMutationTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('builds update SQL with quoted identifiers and structured where predicates', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [{ id: 123, email: 'new@example.com' }], rowCount: 1 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'update',
      table: 'users',
      data: { email: 'new@example.com' },
      where: { id: 123 },
      returning: ['id', 'email']
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.queryResult).toHaveBeenCalledWith(
      'UPDATE "users" SET "email" = $1 WHERE "id" = $2 RETURNING "id", "email"',
      ['new@example.com', 123]
    );
  });

  it('rejects unsafe identifiers before executing SQL', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'insert',
      table: 'users; drop table users',
      data: { email: 'new@example.com' }
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.queryResult).not.toHaveBeenCalled();
  });

  it('reports rows affected from PostgreSQL rowCount when no returning data is requested', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 7 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'update',
      table: 'users',
      data: { active: false },
      where: { stale: true }
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Rows affected: 7');
    expect(mockDb.queryResult).toHaveBeenCalledWith(
      'UPDATE "users" SET "active" = $1 WHERE "stale" = $2',
      [false, true]
    );
  });

  it('rejects legacy string where predicates before executing mutations', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'update',
      table: 'users',
      data: { active: false },
      where: "token = 'raw-mutation-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('String where predicates are not allowed');
    expect(result.content[0].text).not.toContain('raw-mutation-secret');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.queryResult).not.toHaveBeenCalled();
  });

  it('rejects missing mutation data before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'update',
      table: 'users',
      where: { id: 1 }
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Data object is required for update operation');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.queryResult).not.toHaveBeenCalled();
  });

  it('allows explicit rawWhere predicates for trusted local/admin mutation SQL', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'update',
      table: 'users',
      data: { active: false },
      rawWhere: "token = 'raw-mutation-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.queryResult).toHaveBeenCalledWith(
      'UPDATE "users" SET "active" = $1 WHERE token = \'raw-mutation-secret\'',
      [false]
    );
  });

  it('truncates returning data in the MCP response without changing affected row count', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3
      }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'update',
      table: 'users',
      data: { active: false },
      where: { stale: true },
      returning: ['id'],
      maxReturningRows: 2
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Rows affected: 3');
    expect(result.content[0].text).toContain('Returning data truncated to 2 of 3 rows');
    expect(result.content[0].text).toContain('"id": 1');
    expect(result.content[0].text).toContain('"id": 2');
    expect(result.content[0].text).not.toContain('"id": 3');
  });

  it('rejects invalid returning output limits before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'insert',
      table: 'users',
      data: { email: 'new@example.com' },
      returning: '*',
      maxReturningRows: 1001
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects unknown mutation input fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeMutationTool.execute({
      operation: 'update',
      table: 'users',
      data: { active: false },
      where: { id: 1 },
      unsafeSql: 'DROP TABLE users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });
});

describe('executeQueryTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('runs SELECT queries in a read-only transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>, options: unknown) => {
        return callback({ query });
      }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeQueryTool.execute({
      operation: 'select',
      query: 'SELECT * FROM users WHERE id = $1',
      parameters: [1],
      timeout: 1000
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.transaction).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
    expect(query).toHaveBeenCalledWith({
      text: 'SELECT * FROM (SELECT * FROM users WHERE id = $1) AS mcp_query LIMIT $2',
      values: [1, 100],
      timeout: 1000
    });
  });

  it('applies a bounded custom SELECT limit as a parameter', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => {
        return callback({ query });
      }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeQueryTool.execute({
      operation: 'select',
      query: 'SELECT * FROM users WHERE active = $1;',
      parameters: [true],
      limit: 25
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(query).toHaveBeenCalledWith({
      text: 'SELECT * FROM (SELECT * FROM users WHERE active = $1) AS mcp_query LIMIT $2',
      values: [true, 25]
    });
  });

  it('rejects invalid SELECT limits before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeQueryTool.execute({
      operation: 'select',
      query: 'SELECT * FROM users',
      limit: 1001
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects unknown query input fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeQueryTool.execute({
      operation: 'select',
      query: 'SELECT * FROM users',
      rawSql: 'DELETE FROM users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects data-changing CTEs before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeQueryTool.execute({
      operation: 'select',
      query: 'WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DELETE');
    expect(result.content[0].text).not.toContain('InternalError');
    expect(result.content[0].text).not.toContain('Failed to execute query');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe('executeSqlTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('reports non-transactional affected rows from PostgreSQL rowCount', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 4 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'UPDATE users SET active = false WHERE stale = true',
      expectRows: false
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Rows affected: 4');
    expect(mockDb.queryResult).toHaveBeenCalledWith(
      'UPDATE users SET active = false WHERE stale = true',
      [],
      {}
    );
  });

  it('truncates arbitrary SQL row output', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3
      }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'SELECT * FROM users',
      maxRows: 2
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Retrieved 3 rows; returning first 2');
    expect(result.content[0].text).toContain('"id": 1');
    expect(result.content[0].text).toContain('"id": 2');
    expect(result.content[0].text).not.toContain('"id": 3');
  });

  it('passes timeout through transactional arbitrary SQL execution', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => {
        return callback({ query });
      }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'SELECT * FROM users WHERE id = $1',
      parameters: [1],
      timeout: 2000,
      transactional: true
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(query).toHaveBeenCalledWith({
      text: 'SELECT * FROM users WHERE id = $1',
      values: [1],
      timeout: 2000
    });
  });

  it('rejects multi-statement arbitrary SQL unless it is transactional', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'UPDATE accounts SET balance = balance - 100 WHERE id = 1; UPDATE accounts SET balance = balance + 100 WHERE id = 2',
      expectRows: false
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Multi-statement arbitrary SQL must use transactional=true');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects multi-statement arbitrary SQL result sets as ambiguous', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'SELECT 1; SELECT 2',
      transactional: true,
      expectRows: true
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('expectRows=false');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects parameters for multi-statement arbitrary SQL', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'UPDATE accounts SET balance = balance - $1 WHERE id = $2; UPDATE accounts SET balance = balance + $1 WHERE id = $3',
      parameters: [100, 1, 2],
      transactional: true,
      expectRows: false
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot use parameters');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('allows transactional multi-statement arbitrary SQL without parameters or result rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) => {
        return callback({ query });
      }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'ALTER TABLE users ADD COLUMN archived boolean; CREATE INDEX idx_users_archived ON users(archived)',
      transactional: true,
      expectRows: false
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith({
      text: 'ALTER TABLE users ADD COLUMN archived boolean; CREATE INDEX idx_users_archived ON users(archived)',
      values: []
    });
  });

  it('sanitizes arbitrary SQL execution errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed while running SELECT * FROM tokens WHERE value = 'raw-token'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'SELECT * FROM tokens'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("value = '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-token');
  });

  it('rejects invalid arbitrary SQL output limits before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'SELECT * FROM users',
      maxRows: 1001
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects unknown arbitrary SQL input fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await executeSqlTool.execute({
      sql: 'SELECT * FROM users',
      operation: 'drop'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });
});
