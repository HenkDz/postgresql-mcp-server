import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection, maskConnectionString, sanitizeErrorMessage } from './connection';

function resetSingleton(): void {
  (DatabaseConnection as unknown as { instance?: DatabaseConnection }).instance = undefined;
  (DatabaseConnection as unknown as { connectionQueue: Promise<void> }).connectionQueue = Promise.resolve();
}

describe('DatabaseConnection lifecycle', () => {
  afterEach(() => {
    resetSingleton();
    vi.restoreAllMocks();
  });

  it('executes regular queries through the pool without a held client', async () => {
    const db = DatabaseConnection.getInstance();
    const poolQuery = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    const pool = { query: poolQuery };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://test';

    const rows = await db.query('SELECT $1::int AS id', [1], { timeout: 500 });

    expect(rows).toEqual([{ id: 1 }]);
    expect(poolQuery).toHaveBeenCalledWith({
      text: 'SELECT $1::int AS id',
      values: [1],
      timeout: 500
    });
    expect(db.getClient()).toBeNull();
    expect(db.isConnected()).toBe(true);
  });

  it('can return full query metadata including rowCount', async () => {
    const db = DatabaseConnection.getInstance();
    const poolQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 7 });
    const pool = { query: poolQuery };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://test';

    const result = await db.queryResult('UPDATE users SET active = $1', [true]);

    expect(result.rowCount).toBe(7);
    expect(result.rows).toEqual([]);
    expect(poolQuery).toHaveBeenCalledWith({
      text: 'UPDATE users SET active = $1',
      values: [true]
    });
  });

  it('rejects invalid per-query timeout options before sending queries to the pool', async () => {
    const db = DatabaseConnection.getInstance();
    const poolQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool = { query: poolQuery };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://test';

    await expect(db.query('SELECT 1', [], { timeout: 0 })).rejects.toThrow('query timeout must be a positive integer');
    await expect(db.queryResult('SELECT 1', [], { timeout: 1.5 })).rejects.toThrow('query timeout must be a positive integer');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('checks out and releases a transaction client on commit', async () => {
    const db = DatabaseConnection.getInstance();
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://test';

    const result = await db.transaction(async (transactionClient) => {
      await transactionClient.query('SELECT 1');
      return 'ok';
    }, { readOnly: true });

    expect(result).toBe('ok');
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN READ ONLY');
    expect(client.query).toHaveBeenNthCalledWith(2, 'SELECT 1');
    expect(client.query).toHaveBeenNthCalledWith(3, 'COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases a transaction client on failure', async () => {
    const db = DatabaseConnection.getInstance();
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://test';

    await expect(db.transaction(async () => {
      throw new Error('boom');
    })).rejects.toThrow('Transaction failed: boom');

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('sanitizes secrets in query errors before propagating', async () => {
    const db = DatabaseConnection.getInstance();
    const pool = {
      query: vi.fn().mockRejectedValue(
        new Error("connection postgresql://app:s3cr3t@localhost/main failed while running SELECT * FROM users WHERE token = 'secret-token'")
      )
    };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://test';

    await expect(db.query('SELECT 1')).rejects.toThrow("Query failed: connection postgresql://app:*****@localhost/main failed while running SELECT * FROM users WHERE token = '?'");
    await expect(db.query('SELECT 1')).rejects.not.toThrow('s3cr3t');
    await expect(db.query('SELECT 1')).rejects.not.toThrow('secret-token');
  });

  it('sanitizes rollback and transaction errors', async () => {
    const db = DatabaseConnection.getInstance();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const release = vi.fn();
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error("rollback password=rollback-secret WHERE token = 'rollback-token'")),
      release
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://test';

    await expect(db.transaction(async () => {
      throw new Error("transaction postgresql://app:tx-secret@localhost/main WHERE token = 'tx-token'");
    })).rejects.toThrow("Transaction failed: transaction postgresql://app:*****@localhost/main WHERE token = '?'");

    const logOutput = consoleError.mock.calls.flat().join(' ');
    expect(logOutput).toContain('password=*****');
    expect(logOutput).toContain("token = '?'");
    expect(logOutput).not.toContain('rollback-secret');
    expect(logOutput).not.toContain('rollback-token');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('masks URI and query-parameter passwords in connection info', () => {
    const db = DatabaseConnection.getInstance();
    (db as unknown as { connectionString: string }).connectionString =
      'postgresql://app:s3cr3t@db.example.com:5432/main?sslmode=require&password=query-secret';

    const connectionInfo = db.getConnectionInfo();

    expect(connectionInfo).toContain('app:*****@db.example.com');
    expect(connectionInfo).toContain('password=*****');
    expect(connectionInfo).not.toContain('s3cr3t');
    expect(connectionInfo).not.toContain('query-secret');
  });

  it('masks keyword-style connection strings', () => {
    expect(maskConnectionString('host=localhost user=app password=s3cr3t dbname=main')).toBe(
      'host=localhost user=app password=***** dbname=main'
    );
    expect(maskConnectionString('postgresql://app:s3cr3t@localhost/main')).toBe(
      'postgresql://app:*****@localhost/main'
    );
  });

  it('sanitizes standalone error messages', () => {
    expect(sanitizeErrorMessage("password=s3cr3t SELECT 'private'")).toBe("password=***** SELECT '?'");
    expect(sanitizeErrorMessage("postgresql://app:s3cr3t@localhost/main failed on SELECT 'private'")).toBe(
      "postgresql://app:*****@localhost/main failed on SELECT '?'"
    );
    expect(sanitizeErrorMessage('Use the server --connection-string option or --allow-tool-connection-string.')).toBe(
      'Use the server --connection-string option or --allow-tool-connection-string.'
    );
  });

  it('rejects invalid POSTGRES_MCP_DEBUG_SQL values on fresh import', async () => {
    const originalDebugSql = process.env.POSTGRES_MCP_DEBUG_SQL;

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool: vi.fn() } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));
    process.env.POSTGRES_MCP_DEBUG_SQL = 'yes';

    try {
      await expect(import('./connection')).rejects.toThrow('POSTGRES_MCP_DEBUG_SQL must be "true" or "false"');
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
      if (originalDebugSql === undefined) {
        delete process.env.POSTGRES_MCP_DEBUG_SQL;
      } else {
        process.env.POSTGRES_MCP_DEBUG_SQL = originalDebugSql;
      }
    }
  });

  it('attaches pg-monitor only when POSTGRES_MCP_DEBUG_SQL is true', async () => {
    const originalDebugSql = process.env.POSTGRES_MCP_DEBUG_SQL;
    const attach = vi.fn();
    const setTheme = vi.fn();

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool: vi.fn() } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach,
        setTheme
      }
    }));
    process.env.POSTGRES_MCP_DEBUG_SQL = 'true';

    try {
      await import('./connection');

      expect(attach).toHaveBeenCalledWith({
        query: true,
        error: true,
        notice: true,
        connect: true,
        disconnect: true
      });
      expect(setTheme).toHaveBeenCalledWith('matrix');
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
      if (originalDebugSql === undefined) {
        delete process.env.POSTGRES_MCP_DEBUG_SQL;
      } else {
        process.env.POSTGRES_MCP_DEBUG_SQL = originalDebugSql;
      }
    }
  });

  it('applies built-in bounded timeout defaults to new pools', async () => {
    const originalMaxConnections = process.env.POSTGRES_MCP_MAX_CONNECTIONS;
    const originalIdleTimeout = process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS;
    const originalConnectionTimeout = process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS;
    const originalStatementTimeout = process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS;
    const originalQueryTimeout = process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS;
    const originalLockTimeout = process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS;
    const originalIdleInTransactionSessionTimeout = process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS;
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn(() => pool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    delete process.env.POSTGRES_MCP_MAX_CONNECTIONS;
    delete process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS;
    delete process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS;
    delete process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS;
    delete process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS;
    delete process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS;
    delete process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS;

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      await FreshDatabaseConnection.getInstance().connect('postgresql://test');

      expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        statement_timeout: 60000,
        query_timeout: 65000,
        lock_timeout: 10000,
        idle_in_transaction_session_timeout: 60000
      }));
      expect(client.query).toHaveBeenCalledWith('SELECT 1');

      await FreshDatabaseConnection.cleanupPools();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
      if (originalMaxConnections === undefined) {
        delete process.env.POSTGRES_MCP_MAX_CONNECTIONS;
      } else {
        process.env.POSTGRES_MCP_MAX_CONNECTIONS = originalMaxConnections;
      }
      if (originalIdleTimeout === undefined) {
        delete process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS = originalIdleTimeout;
      }
      if (originalConnectionTimeout === undefined) {
        delete process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS = originalConnectionTimeout;
      }
      if (originalStatementTimeout === undefined) {
        delete process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS = originalStatementTimeout;
      }
      if (originalQueryTimeout === undefined) {
        delete process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS = originalQueryTimeout;
      }
      if (originalLockTimeout === undefined) {
        delete process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS = originalLockTimeout;
      }
      if (originalIdleInTransactionSessionTimeout === undefined) {
        delete process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = originalIdleInTransactionSessionTimeout;
      }
    }
  });

  it('applies environment timeout overrides to new pools', async () => {
    const originalMaxConnections = process.env.POSTGRES_MCP_MAX_CONNECTIONS;
    const originalIdleTimeout = process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS;
    const originalConnectionTimeout = process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS;
    const originalStatementTimeout = process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS;
    const originalQueryTimeout = process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS;
    const originalLockTimeout = process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS;
    const originalIdleInTransactionSessionTimeout = process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS;
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn(() => pool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    process.env.POSTGRES_MCP_MAX_CONNECTIONS = '8';
    process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS = '9000';
    process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS = '1000';
    process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS = '30000';
    process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS = '45000';
    process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS = '5000';
    process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = '55000';

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      await FreshDatabaseConnection.getInstance().connect('postgresql://test');

      expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
        max: 8,
        idleTimeoutMillis: 9000,
        connectionTimeoutMillis: 1000,
        statement_timeout: 30000,
        query_timeout: 45000,
        lock_timeout: 5000,
        idle_in_transaction_session_timeout: 55000
      }));
      expect(client.query).toHaveBeenCalledWith('SELECT 1');

      await FreshDatabaseConnection.cleanupPools();
      expect(FreshDatabaseConnection.getInstance().isConnected()).toBe(false);
      expect(FreshDatabaseConnection.getInstance().getConnectionInfo()).toBe('Not connected');
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
      if (originalMaxConnections === undefined) {
        delete process.env.POSTGRES_MCP_MAX_CONNECTIONS;
      } else {
        process.env.POSTGRES_MCP_MAX_CONNECTIONS = originalMaxConnections;
      }
      if (originalIdleTimeout === undefined) {
        delete process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS = originalIdleTimeout;
      }
      if (originalConnectionTimeout === undefined) {
        delete process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS = originalConnectionTimeout;
      }
      if (originalStatementTimeout === undefined) {
        delete process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS = originalStatementTimeout;
      }
      if (originalQueryTimeout === undefined) {
        delete process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS = originalQueryTimeout;
      }
      if (originalLockTimeout === undefined) {
        delete process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS = originalLockTimeout;
      }
      if (originalIdleInTransactionSessionTimeout === undefined) {
        delete process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS;
      } else {
        process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = originalIdleInTransactionSessionTimeout;
      }
    }
  });

  it('rejects invalid connection options before constructing a pool', async () => {
    const Pool = vi.fn();

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      const db = FreshDatabaseConnection.getInstance();

      await expect(db.connect('postgresql://test', { maxConnections: 0 })).rejects.toThrow('maxConnections must be a positive integer');
      await expect(db.connect('postgresql://test', { idleTimeoutMillis: 1.5 })).rejects.toThrow('idleTimeoutMillis must be a positive integer');
      await expect(db.connect('postgresql://test', { connectionTimeoutMillis: -1 })).rejects.toThrow('connectionTimeoutMillis must be a positive integer');
      await expect(db.connect('postgresql://test', { statementTimeout: 0 })).rejects.toThrow('statementTimeout must be a positive integer');
      await expect(db.connect('postgresql://test', { queryTimeout: 1.5 })).rejects.toThrow('queryTimeout must be a positive integer');
      await expect(db.connect('postgresql://test', { lockTimeout: 0 })).rejects.toThrow('lockTimeout must be a positive integer');
      await expect(db.connect('postgresql://test', { idleInTransactionSessionTimeout: -1 })).rejects.toThrow('idleInTransactionSessionTimeout must be a positive integer');

      expect(Pool).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });

  it('rejects blank connection strings before constructing a pool', async () => {
    const originalConnectionString = process.env.POSTGRES_CONNECTION_STRING;
    const Pool = vi.fn();

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      const db = FreshDatabaseConnection.getInstance();
      process.env.POSTGRES_CONNECTION_STRING = 'postgresql://env';

      await expect(db.connect('   ')).rejects.toThrow('No non-empty connection string provided');

      process.env.POSTGRES_CONNECTION_STRING = '\t ';
      await expect(db.connect()).rejects.toThrow('No non-empty connection string provided');

      expect(Pool).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
      if (originalConnectionString === undefined) {
        delete process.env.POSTGRES_CONNECTION_STRING;
      } else {
        process.env.POSTGRES_CONNECTION_STRING = originalConnectionString;
      }
    }
  });

  it('keeps an active connection when a later connect call has invalid options', async () => {
    const db = DatabaseConnection.getInstance();
    const pool = {
      query: vi.fn(),
      end: vi.fn()
    };

    (db as unknown as { pool: typeof pool; connectionString: string }).pool = pool;
    (db as unknown as { connectionString: string }).connectionString = 'postgresql://app:secret@localhost/main';

    await expect(db.connect('postgresql://other', { maxConnections: 0 })).rejects.toThrow('maxConnections must be a positive integer');

    expect(db.getPool()).toBe(pool);
    expect(db.getConnectionInfo()).toBe('postgresql://app:*****@localhost/main');
    expect(pool.end).not.toHaveBeenCalled();
  });

  it('passes validated direct connection options to new pools', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn(() => pool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');

      await FreshDatabaseConnection.getInstance().connect('postgresql://test', {
        maxConnections: 5,
        idleTimeoutMillis: 1000,
        connectionTimeoutMillis: 2000,
        statementTimeout: 3000,
        queryTimeout: 4000,
        lockTimeout: 5000,
        idleInTransactionSessionTimeout: 6000
      });

      expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
        max: 5,
        idleTimeoutMillis: 1000,
        connectionTimeoutMillis: 2000,
        statement_timeout: 3000,
        query_timeout: 4000,
        lock_timeout: 5000,
        idle_in_transaction_session_timeout: 6000
      }));
      expect(client.query).toHaveBeenCalledWith('SELECT 1');
      expect(release).toHaveBeenCalledTimes(1);

      await FreshDatabaseConnection.cleanupPools();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });

  it('serializes overlapping active connection workflows until disconnect releases the lease', async () => {
    const firstClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn()
    };
    const secondClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn()
    };
    const firstPool = {
      connect: vi.fn().mockResolvedValue(firstClient),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const secondPool = {
      connect: vi.fn().mockResolvedValue(secondClient),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn()
      .mockReturnValueOnce(firstPool)
      .mockReturnValueOnce(secondPool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      const db = FreshDatabaseConnection.getInstance();

      await db.connect('postgresql://first');

      let secondConnected = false;
      const secondConnect = db.connect('postgresql://second').then(() => {
        secondConnected = true;
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(secondConnected).toBe(false);
      expect(Pool).toHaveBeenCalledTimes(1);

      await db.disconnect();
      await secondConnect;

      expect(secondConnected).toBe(true);
      expect(Pool).toHaveBeenCalledTimes(2);
      expect(secondPool.connect).toHaveBeenCalledTimes(1);

      await FreshDatabaseConnection.cleanupPools();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });

  it('releases the connection lease when connect validation fails', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn(() => pool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      const db = FreshDatabaseConnection.getInstance();

      await expect(db.connect('   ')).rejects.toThrow('No non-empty connection string provided');
      await db.connect('postgresql://valid');

      expect(Pool).toHaveBeenCalledTimes(1);
      expect(pool.connect).toHaveBeenCalledTimes(1);

      await FreshDatabaseConnection.cleanupPools();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });

  it('recovers if the connection queue is accidentally poisoned', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn(() => pool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      (FreshDatabaseConnection as unknown as { connectionQueue: Promise<void> }).connectionQueue = Promise.reject(new Error('poisoned lease'));

      const db = FreshDatabaseConnection.getInstance();
      await db.connect('postgresql://valid');

      expect(Pool).toHaveBeenCalledTimes(1);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith('SELECT 1');
      expect(db.isConnected()).toBe(true);

      await FreshDatabaseConnection.cleanupPools();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });

  it('clears active state and removes failed pools after connection failure', async () => {
    const failedPool = {
      connect: vi.fn().mockRejectedValue(new Error('database is down')),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const release = vi.fn();
    const healthyClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const healthyPool = {
      connect: vi.fn().mockResolvedValue(healthyClient),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn()
      .mockReturnValueOnce(failedPool)
      .mockReturnValueOnce(healthyPool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      const db = FreshDatabaseConnection.getInstance();

      await expect(db.connect('postgresql://app:secret@localhost/main')).rejects.toThrow('Failed to connect to database: database is down');

      expect(failedPool.end).toHaveBeenCalledTimes(1);
      expect(db.isConnected()).toBe(false);
      expect(db.getPool()).toBeNull();
      expect(db.getConnectionInfo()).toBe('Not connected');
      await expect(db.query('SELECT 1')).rejects.toThrow('Not connected to database');

      await db.connect('postgresql://app:secret@localhost/main');

      expect(Pool).toHaveBeenCalledTimes(2);
      expect(healthyPool.connect).toHaveBeenCalledTimes(1);
      expect(healthyClient.query).toHaveBeenCalledWith('SELECT 1');
      expect(release).toHaveBeenCalledTimes(1);

      await FreshDatabaseConnection.cleanupPools();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });

  it('clears active singleton state when pool cleanup runs after shutdown', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn(() => pool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      const db = FreshDatabaseConnection.getInstance();

      await db.connect('postgresql://app:secret@localhost/main');
      expect(db.isConnected()).toBe(true);
      expect(db.getConnectionInfo()).toBe('postgresql://app:*****@localhost/main');

      await FreshDatabaseConnection.cleanupPools();

      expect(pool.end).toHaveBeenCalledTimes(1);
      expect(db.isConnected()).toBe(false);
      expect(db.getPool()).toBeNull();
      expect(db.getConnectionInfo()).toBe('Not connected');
      await expect(db.query('SELECT 1')).rejects.toThrow('Not connected to database');
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });

  it('disconnects the active handle without ending the reusable cached pool', async () => {
    const release = vi.fn();
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const Pool = vi.fn(() => pool);

    vi.resetModules();
    vi.doMock('pg', () => ({ default: { Pool } }));
    vi.doMock('pg-monitor', () => ({
      default: {
        attach: vi.fn(),
        setTheme: vi.fn()
      }
    }));

    try {
      const { DatabaseConnection: FreshDatabaseConnection } = await import('./connection');
      const db = FreshDatabaseConnection.getInstance();

      await db.connect('postgresql://app:secret@localhost/main');
      await db.disconnect();

      expect(db.isConnected()).toBe(false);
      expect(db.getPool()).toBeNull();
      expect(db.getConnectionInfo()).toBe('Not connected');
      expect(pool.end).not.toHaveBeenCalled();
      await expect(db.query('SELECT 1')).rejects.toThrow('Not connected to database');

      await db.connect('postgresql://app:secret@localhost/main');

      expect(Pool).toHaveBeenCalledTimes(1);
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(db.isConnected()).toBe(true);

      await FreshDatabaseConnection.cleanupPools();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('pg-monitor');
      vi.resetModules();
    }
  });
});
