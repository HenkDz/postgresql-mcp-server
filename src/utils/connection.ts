import pkg from 'pg';
import type { Pool as PoolType, PoolClient as PoolClientType, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import monitor from 'pg-monitor';
import { redactSqlText } from './sql.js';
const { Pool } = pkg;

export const DEFAULT_STATEMENT_TIMEOUT_MS = 60000;
export const DEFAULT_QUERY_TIMEOUT_MS = 65000;
export const DEFAULT_LOCK_TIMEOUT_MS = 10000;
export const DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 60000;
export const DEFAULT_MAX_CONNECTIONS = 20;
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 30000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 2000;

// Connection pool cache to reuse connections
const poolCache = new Map<string, PoolType>();

interface ConnectionOptions {
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeout?: number;
  queryTimeout?: number;
  lockTimeout?: number;
  idleInTransactionSessionTimeout?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

type PoolConfigWithTimeouts = PoolConfig & {
  statement_timeout?: number;
  query_timeout?: number;
  lock_timeout?: number;
  idle_in_transaction_session_timeout?: number;
};

// Extended query config with additional options
interface ExtendedQueryConfig {
  text: string;
  values?: unknown[];
  timeout?: number;
  rowMode?: string;
}

function parseBooleanEnv(name: string): boolean {
  const value = process.env[name];

  if (value === undefined || value === '') {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be "true" or "false".`);
}

// pg-monitor can print raw SQL and bind values. Keep it opt-in so stdio MCP logs
// do not leak queries or secrets during normal development use.
if (parseBooleanEnv('POSTGRES_MCP_DEBUG_SQL')) {
  monitor.attach({
    query: true,
    error: true,
    notice: true,
    connect: true,
    disconnect: true
  });
  monitor.setTheme('matrix');
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function assertPositiveIntegerOption(name: string, value: number | undefined): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertConnectionOptions(options: ConnectionOptions): void {
  assertPositiveIntegerOption('maxConnections', options.maxConnections);
  assertPositiveIntegerOption('idleTimeoutMillis', options.idleTimeoutMillis);
  assertPositiveIntegerOption('connectionTimeoutMillis', options.connectionTimeoutMillis);
  assertPositiveIntegerOption('statementTimeout', options.statementTimeout);
  assertPositiveIntegerOption('queryTimeout', options.queryTimeout);
  assertPositiveIntegerOption('lockTimeout', options.lockTimeout);
  assertPositiveIntegerOption('idleInTransactionSessionTimeout', options.idleInTransactionSessionTimeout);
}

function getDefaultConnectionOptions(): ConnectionOptions {
  return {
    maxConnections: parsePositiveIntegerEnv('POSTGRES_MCP_MAX_CONNECTIONS', DEFAULT_MAX_CONNECTIONS),
    idleTimeoutMillis: parsePositiveIntegerEnv('POSTGRES_MCP_IDLE_TIMEOUT_MS', DEFAULT_POOL_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: parsePositiveIntegerEnv('POSTGRES_MCP_CONNECTION_TIMEOUT_MS', DEFAULT_CONNECTION_TIMEOUT_MS),
    statementTimeout: parsePositiveIntegerEnv('POSTGRES_MCP_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS),
    queryTimeout: parsePositiveIntegerEnv('POSTGRES_MCP_QUERY_TIMEOUT_MS', DEFAULT_QUERY_TIMEOUT_MS),
    lockTimeout: parsePositiveIntegerEnv('POSTGRES_MCP_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS),
    idleInTransactionSessionTimeout: parsePositiveIntegerEnv('POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS', DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS)
  };
}

function buildPoolCacheKey(connectionString: string, options: ConnectionOptions): string {
  return JSON.stringify({
    connectionString,
    maxConnections: options.maxConnections,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    statementTimeout: options.statementTimeout,
    queryTimeout: options.queryTimeout,
    lockTimeout: options.lockTimeout,
    idleInTransactionSessionTimeout: options.idleInTransactionSessionTimeout,
    ssl: options.ssl
  });
}

const ERROR_MESSAGE_CLI_FLAGS = [
  '--connection-string',
  '--tools-config',
  '--security-mode',
  '--allow-destructive',
  '--allow-tool-connection-string',
  '--workspace-dir',
  '--audit-file',
  '--max-connections',
  '--idle-timeout-ms',
  '--connection-timeout-ms',
  '--max-file-bytes',
  '--statement-timeout-ms',
  '--query-timeout-ms',
  '--lock-timeout-ms',
  '--idle-in-transaction-session-timeout-ms',
  '--allowed-connection-target'
] as const;

export function maskConnectionString(connectionString: string): string {
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(connectionString)) {
      const parsed = new URL(connectionString);
      if (parsed.password) {
        parsed.password = '*****';
      }

      for (const key of ['password', 'pass', 'pwd']) {
        if (parsed.searchParams.has(key)) {
          parsed.searchParams.set(key, '*****');
        }
      }

      return parsed.toString();
    }
  } catch {
    // Fall through to regex masking for malformed or embedded connection strings.
  }

  return connectionString
    .replace(/(password|pass|pwd)=([^&\s]*)/gi, '$1=*****')
    .replace(/:\/\/([^:\s/@]+):([^@\s]+)@/g, '://$1:*****@');
}

export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let masked = maskConnectionString(message);
  const placeholders: string[] = [];

  for (const flag of ERROR_MESSAGE_CLI_FLAGS) {
    masked = masked.replaceAll(flag, () => {
      const placeholder = `__POSTGRES_MCP_CLI_FLAG_${placeholders.length}__`;
      placeholders.push(flag);
      return placeholder;
    });
  }

  let redacted = redactSqlText(masked, 1000);
  placeholders.forEach((flag, index) => {
    redacted = redacted.replaceAll(`__POSTGRES_MCP_CLI_FLAG_${index}__`, flag);
  });
  return redacted;
}

export class DatabaseConnection {
  private static instance: DatabaseConnection;
  private static connectionQueue: Promise<void> = Promise.resolve();
  private pool: PoolType | null = null;
  private connectionString = '';
  private poolCacheKey = '';
  private lastError: Error | null = null;
  private connectionOptions: ConnectionOptions = {};
  private connectionLeaseRelease: (() => void) | null = null;

  private constructor() {}

  public static getInstance(): DatabaseConnection {
    if (!DatabaseConnection.instance) {
      DatabaseConnection.instance = new DatabaseConnection();
    }
    return DatabaseConnection.instance;
  }

  private static clearActivePool(poolCacheKey: string): void {
    if (!DatabaseConnection.instance || DatabaseConnection.instance.poolCacheKey !== poolCacheKey) {
      return;
    }

    DatabaseConnection.instance.clearConnectionState();
  }

  private clearConnectionState(): void {
    this.pool = null;
    this.connectionString = '';
    this.poolCacheKey = '';
    this.connectionOptions = {};
  }

  private async acquireConnectionLease(): Promise<void> {
    let releaseCurrentLease!: () => void;
    const currentLease = new Promise<void>((resolve) => {
      releaseCurrentLease = resolve;
    });
    const previousLease = DatabaseConnection.connectionQueue;
    DatabaseConnection.connectionQueue = previousLease.then(
      () => currentLease,
      () => currentLease
    );

    try {
      await previousLease;
    } catch {
      // Keep the connection queue live even if a future edit accidentally poisons it.
    }
    this.connectionLeaseRelease = releaseCurrentLease;
  }

  private releaseConnectionLease(): void {
    if (!this.connectionLeaseRelease) {
      return;
    }

    const releaseLease = this.connectionLeaseRelease;
    this.connectionLeaseRelease = null;
    releaseLease();
  }

  /**
   * Connect to a PostgreSQL database
   */
  public async connect(connectionString?: string, options: ConnectionOptions = {}): Promise<void> {
    await this.acquireConnectionLease();
    let connectionStateChanged = false;

    try {
      // Use environment variable only when no explicit connection string was provided.
      const connString = connectionString !== undefined ? connectionString : process.env.POSTGRES_CONNECTION_STRING;
      const effectiveOptions = {
        ...getDefaultConnectionOptions(),
        ...options
      };

      if (connString === undefined || connString.trim() === '') {
        throw new Error('No non-empty connection string provided and POSTGRES_CONNECTION_STRING environment variable is not set');
      }

      assertConnectionOptions(effectiveOptions);
      const poolCacheKey = buildPoolCacheKey(connString, effectiveOptions);

      // If already connected to this database, reuse the connection
      if (this.pool && this.poolCacheKey === poolCacheKey) {
        return;
      }
      
      // If connected to a different database, disconnect first
      if (this.pool) {
        this.clearConnectionState();
      }
      
      this.connectionString = connString;
      this.poolCacheKey = poolCacheKey;
      this.connectionOptions = effectiveOptions;
      connectionStateChanged = true;
      
      // Check if we have a cached pool for this connection string
      if (poolCache.has(poolCacheKey)) {
        this.pool = poolCache.get(poolCacheKey) as PoolType;
      } else {
        // Create a new pool
        const config: PoolConfigWithTimeouts = {
          connectionString: connString,
          max: effectiveOptions.maxConnections,
          idleTimeoutMillis: effectiveOptions.idleTimeoutMillis,
          connectionTimeoutMillis: effectiveOptions.connectionTimeoutMillis,
          allowExitOnIdle: true,
          ssl: effectiveOptions.ssl,
          statement_timeout: effectiveOptions.statementTimeout,
          query_timeout: effectiveOptions.queryTimeout,
          lock_timeout: effectiveOptions.lockTimeout,
          idle_in_transaction_session_timeout: effectiveOptions.idleInTransactionSessionTimeout
        };
        
        this.pool = new Pool(config);
        
        // Set up error handler for the pool
        this.pool.on('error', (err: Error) => {
          console.error('Unexpected error on idle client:', sanitizeErrorMessage(err));
          this.lastError = err;
        });
        
        // Cache the pool for future use
        poolCache.set(poolCacheKey, this.pool);
      }

      const client = await this.pool.connect();
      try {
        // Test the connection without keeping a client checked out.
        await client.query('SELECT 1');
      } finally {
        client.release();
      }

    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      const failedPool = connectionStateChanged ? this.pool : null;
      const failedPoolCacheKey = connectionStateChanged ? this.poolCacheKey : '';
      
      if (failedPool) {
        // Remove from cache if connection failed
        poolCache.delete(failedPoolCacheKey);
        try {
          await failedPool.end();
        } catch (cleanupError) {
          console.error(`Error closing failed pool for ${maskConnectionString(failedPoolCacheKey)}:`, sanitizeErrorMessage(cleanupError));
        }
      }

      if (connectionStateChanged) {
        this.clearConnectionState();
      }
      this.releaseConnectionLease();
      
      throw new Error(`Failed to connect to database: ${sanitizeErrorMessage(this.lastError)}`);
    }
  }

  /**
   * Disconnect from the database
   */
  public async disconnect(): Promise<void> {
    // Detach the active handle while keeping the cached pool available for reuse.
    this.clearConnectionState();
    this.releaseConnectionLease();
  }

  /**
   * Execute a SQL query
   */
  public async query<T extends QueryResultRow = Record<string, unknown>>(
    text: string, 
    values: unknown[] = [],
    options: { timeout?: number } = {}
  ): Promise<T[]> {
    const result = await this.queryResult<T>(text, values, options);
    return result.rows;
  }

  /**
   * Execute a SQL query and return PostgreSQL metadata such as rowCount
   */
  public async queryResult<T extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
    options: { timeout?: number } = {}
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      assertPositiveIntegerOption('query timeout', options.timeout);
      const queryConfig = {
        text,
        values
      };
      
      // Set query timeout if specified
      if (options.timeout !== undefined || this.connectionOptions.queryTimeout) {
        // We need to use a type assertion here because the pg types don't include timeout
        // but the library actually supports it
        (queryConfig as ExtendedQueryConfig).timeout = options.timeout ?? this.connectionOptions.queryTimeout;
      }
      
      return await this.pool.query<T>(queryConfig);
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Query failed: ${sanitizeErrorMessage(this.lastError)}`);
    }
  }

  /**
   * Execute a query that returns a single row
   */
  public async queryOne<T extends QueryResultRow = Record<string, unknown>>(
    text: string, 
    values: unknown[] = [],
    options: { timeout?: number } = {}
  ): Promise<T | null> {
    const rows = await this.query<T>(text, values, options);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Execute a query that returns a single value
   */
  public async queryValue<T>(
    text: string, 
    values: unknown[] = [],
    options: { timeout?: number } = {}
  ): Promise<T | null> {
    const rows = await this.query<Record<string, unknown>>(text, values, options);
    if (rows.length > 0) {
      const firstRow = rows[0];
      const firstValue = Object.values(firstRow)[0];
      return firstValue as T;
    }
    return null;
  }

  /**
   * Execute multiple queries in a transaction
   */
  public async transaction<T>(
    callback: (client: PoolClientType) => Promise<T>,
    options: { readOnly?: boolean } = {}
  ): Promise<T> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const client = await this.pool.connect();
    try {
      await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Transaction rollback failed:', sanitizeErrorMessage(rollbackError));
      }
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Transaction failed: ${sanitizeErrorMessage(this.lastError)}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get the current connection pool
   */
  public getPool(): PoolType | null {
    return this.pool;
  }

  /**
   * Get the current client
   */
  public getClient(): PoolClientType | null {
    return null;
  }

  /**
   * Get the last error that occurred
   */
  public getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Check if connected to database
   */
  public isConnected(): boolean {
    return this.pool !== null;
  }

  /**
   * Get connection string (with password masked)
   */
  public getConnectionInfo(): string {
    if (!this.connectionString) {
      return 'Not connected';
    }

    return maskConnectionString(this.connectionString);
  }

  /**
   * Clean up all connection pools
   * Should be called when the application is shutting down
   */
  public static async cleanupPools(): Promise<void> {
    for (const [poolCacheKey, pool] of Array.from(poolCache.entries())) {
      try {
        await pool.end();
      } catch (error) {
        console.error(`Error closing pool for ${maskConnectionString(poolCacheKey)}:`, sanitizeErrorMessage(error));
      } finally {
        poolCache.delete(poolCacheKey);
        DatabaseConnection.clearActivePool(poolCacheKey);
        DatabaseConnection.instance?.releaseConnectionLease();
      }
    }
  }
}
