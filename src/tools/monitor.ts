import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { redactSqlText } from '../utils/sql.js';

interface MonitoringResult {
  timestamp: string;
  metrics: {
    database: DatabaseMetrics;
    tables: Record<string, TableMetrics>;
    queries: ActiveQueryInfo[];
    locks: LockInfo[];
    replication?: ReplicationInfo[];
  };
  alerts: Alert[];
}

interface DatabaseMetrics {
  name: string;
  size: string;
  connections: {
    active: number;
    idle: number;
    total: number;
    max: number;
  };
  uptime: string;
  transactions: {
    committed: number;
    rolledBack: number;
  };
  cacheHitRatio: number;
}

interface TableMetrics {
  name: string;
  size: string;
  rowCount: number;
  deadTuples: number;
  lastVacuum: string | null;
  lastAnalyze: string | null;
  scanCount: number;
  indexUseRatio: number;
}

interface ActiveQueryInfo {
  pid: number;
  username: string;
  database: string;
  startTime: string;
  duration: number;
  state: string;
  query: string;
  waitEvent?: string;
}

interface LockInfo {
  relation: string;
  mode: string;
  granted: boolean;
  pid: number;
  username: string;
  query: string;
}

interface ReplicationInfo {
  clientAddr: string;
  state: string;
  sentLsn: string;
  writeLsn: string;
  flushLsn: string;
  replayLsn: string;
  writeLag: string | null;
  flushLag: string | null;
  replayLag: string | null;
}

interface Alert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  context?: Record<string, unknown>;
}

interface CappedRows<T> {
  rows: T[];
  capped: boolean;
}

const TABLE_METRICS_DIAGNOSTIC_LIMIT = 100;
const ACTIVE_QUERY_DIAGNOSTIC_LIMIT = 50;
const LOCK_DIAGNOSTIC_LIMIT = 100;
const REPLICATION_DIAGNOSTIC_LIMIT = 50;

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

const AlertThresholdsSchema = z.object({
  connectionPercentage: z.number().min(0).max(100).optional().describe("Connection usage percentage threshold"),
  longRunningQuerySeconds: z.number().positive().optional().describe("Long-running query threshold in seconds"),
  cacheHitRatio: z.number().min(0).max(1).optional().describe("Cache hit ratio threshold"),
  deadTuplesPercentage: z.number().min(0).max(100).optional().describe("Dead tuples percentage threshold"),
  vacuumAge: z.number().positive().int().optional().describe("Vacuum age threshold in days"),
}).strict().describe("Alert thresholds");

const MonitorDatabaseInputSchema = z.object({
  connectionString: z.string().optional(),
  includeTables: z.boolean().optional().default(false),
  includeQueries: z.boolean().optional().default(false),
  includeLocks: z.boolean().optional().default(false),
  includeReplication: z.boolean().optional().default(false),
  alertThresholds: AlertThresholdsSchema.optional(),
}).strict();

type MonitorDatabaseInput = z.infer<typeof MonitorDatabaseInputSchema>;

async function executeMonitorDatabase(
  input: MonitorDatabaseInput,
  getConnectionString: GetConnectionStringFn
): Promise<MonitoringResult> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const alerts: Alert[] = [];
  const { includeTables, includeQueries, includeLocks, includeReplication, alertThresholds } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    const now = new Date();
    const timestamp = now.toISOString();
    
    const dbMetrics = await getDatabaseMetrics(db);
    
    if (alertThresholds?.connectionPercentage && 
        (dbMetrics.connections.total / dbMetrics.connections.max) * 100 > alertThresholds.connectionPercentage) {
      const percentage = (dbMetrics.connections.total / dbMetrics.connections.max) * 100;
      alerts.push({
        level: percentage > 90 ? 'critical' : 'warning',
        message: `High connection usage: ${percentage.toFixed(1)}%`,
        context: {
          current: dbMetrics.connections.total,
          max: dbMetrics.connections.max
        }
      });
    }
    
    if (alertThresholds?.cacheHitRatio && 
        dbMetrics.cacheHitRatio < alertThresholds.cacheHitRatio) {
      alerts.push({
        level: dbMetrics.cacheHitRatio < 0.8 ? 'critical' : 'warning',
        message: `Low cache hit ratio: ${(dbMetrics.cacheHitRatio * 100).toFixed(1)}%`,
        context: {
          current: dbMetrics.cacheHitRatio
        }
      });
    }
    
    const tableMetricsResult: Record<string, TableMetrics> = {};
    if (includeTables) {
      const tableMetrics = await getTableMetrics(db);
      const tables = tableMetrics.rows;
      if (tableMetrics.capped) {
        alerts.push({
          level: 'info',
          message: `Table metrics output capped at ${TABLE_METRICS_DIAGNOSTIC_LIMIT} rows`
        });
      }

      for (const table of tables) {
        tableMetricsResult[table.name] = table;
        
        if (alertThresholds?.deadTuplesPercentage) {
          const deadTuplePercentage = table.rowCount > 0 
            ? (table.deadTuples / table.rowCount) * 100 
            : 0;
            
          if (deadTuplePercentage > alertThresholds.deadTuplesPercentage) {
            alerts.push({
              level: deadTuplePercentage > 30 ? 'critical' : 'warning',
              message: `High dead tuple percentage in table ${table.name}: ${deadTuplePercentage.toFixed(1)}%`,
              context: {
                table: table.name,
                deadTuples: table.deadTuples,
                totalRows: table.rowCount
              }
            });
          }
        }
        
        if (alertThresholds?.vacuumAge && table.lastVacuum) {
          const lastVacuumDate = new Date(table.lastVacuum);
          const daysSinceVacuum = Math.floor((now.getTime() - lastVacuumDate.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysSinceVacuum > alertThresholds.vacuumAge) {
            alerts.push({
              level: 'warning',
              message: `Table ${table.name} hasn't been vacuumed in ${daysSinceVacuum} days`,
              context: {
                table: table.name,
                lastVacuum: table.lastVacuum
              }
            });
          }
        }
      }
    }
    
    let activeQueriesResult: ActiveQueryInfo[] = [];
    if (includeQueries) {
      const activeQueries = await getActiveQueries(db);
      activeQueriesResult = activeQueries.rows;
      if (activeQueries.capped) {
        alerts.push({
          level: 'info',
          message: `Active query output capped at ${ACTIVE_QUERY_DIAGNOSTIC_LIMIT} rows`
        });
      }

      if (alertThresholds?.longRunningQuerySeconds) {
        const threshold = alertThresholds.longRunningQuerySeconds;
        const longRunningQueries = activeQueriesResult.filter(
          q => q.duration > threshold
        );
        
        for (const query of longRunningQueries) {
          const redactedQuery = redactSqlText(query.query, 100);
          alerts.push({
            level: query.duration > threshold * 2 ? 'critical' : 'warning',
            message: `Long-running query (${query.duration.toFixed(1)}s) by ${query.username}`,
            context: {
              pid: query.pid,
              duration: query.duration,
              query: redactedQuery
            }
          });
        }
      }
    }
    
    let locksResult: LockInfo[] = [];
    if (includeLocks) {
      const locks = await getLockInfo(db);
      locksResult = locks.rows;
      if (locks.capped) {
        alerts.push({
          level: 'info',
          message: `Lock output capped at ${LOCK_DIAGNOSTIC_LIMIT} rows`
        });
      }

      const blockingLocks = locksResult.filter(l => !l.granted);
      if (blockingLocks.length > 0) {
        alerts.push({
          level: 'warning',
          message: `${blockingLocks.length} blocking locks detected`,
          context: {
            count: blockingLocks.length
          }
        });
      }
    }
    
    let replicationResult: ReplicationInfo[] = [];
    if (includeReplication) {
      const replication = await getReplicationInfo(db);
      replicationResult = replication.rows;
      if (replication.capped) {
        alerts.push({
          level: 'info',
          message: `Replication output capped at ${REPLICATION_DIAGNOSTIC_LIMIT} rows`
        });
      }

      for (const replica of replicationResult) {
        if (replica.replayLag) {
          const lagMatch = replica.replayLag.match(/(\d+):(\d+):(\d+)/);
          if (lagMatch) {
            const hours = Number.parseInt(lagMatch[1]);
            const minutes = Number.parseInt(lagMatch[2]);
            
            if (hours > 0 || minutes > 5) {
              alerts.push({
                level: hours > 0 ? 'critical' : 'warning',
                message: `High replication lag for ${replica.clientAddr}: ${replica.replayLag}`,
                context: {
                  clientAddr: replica.clientAddr,
                  lag: replica.replayLag
                }
              });
            }
          }
        }
      }
    }
    
    return {
      timestamp,
      metrics: {
        database: dbMetrics,
        tables: tableMetricsResult,
        queries: activeQueriesResult,
        locks: locksResult,
        replication: includeReplication ? replicationResult : undefined
      },
      alerts
    };
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error);
    console.error("Error monitoring database:", errorMessage);
    throw new McpError(ErrorCode.InternalError, `Failed to monitor database: ${errorMessage}`);
  } finally {
    await db.disconnect();
  }
}

export const monitorDatabaseTool: PostgresTool = {
  name: 'pg_monitor_database',
  description: 'Get real-time monitoring information for a PostgreSQL database',
  inputSchema: MonitorDatabaseInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = MonitorDatabaseInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeMonitorDatabase(validationResult.data, getConnectionString);
      return { 
        content: [
          { type: 'text', text: `Database monitoring results at ${result.timestamp}` },
          { type: 'text', text: `Alerts: ${result.alerts.length > 0 ? result.alerts.map(a => `${a.level.toUpperCase()}: ${a.message}`).join('; ') : 'None'}` },
          { type: 'text', text: `Full metrics (JSON): ${JSON.stringify(result.metrics, null, 2)}` }
        ]
      };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error monitoring database: ${errorMessage}` }], isError: true };
    }
  }
};

/**
 * Get database-level metrics
 */
async function getDatabaseMetrics(db: DatabaseConnection): Promise<DatabaseMetrics> {
  const dbInfo = await db.queryOne<{
    db_name: string;
    db_size: string;
    uptime: string;
    committed_tx: string;
    rolled_back_tx: string;
  }>(
    `SELECT datname as db_name, pg_size_pretty(pg_database_size(current_database())) as db_size, 
            (now() - pg_postmaster_start_time())::text as uptime, 
            xact_commit as committed_tx, xact_rollback as rolled_back_tx 
     FROM pg_stat_database WHERE datname = current_database()`
  );
  
  const connInfo = await db.queryOne<{
    active_connections: string;
    idle_connections: string;
    total_connections: string;
    max_connections: string;
  }>(
    `SELECT 
      (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active_connections, 
      (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') as idle_connections, 
      (SELECT count(*) FROM pg_stat_activity) as total_connections, 
      setting as max_connections 
     FROM pg_settings WHERE name = 'max_connections'`
  );
  
  const cacheHit = await db.queryOne<{
    cache_hit_ratio: number;
  }>(
    `SELECT sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) as cache_hit_ratio 
     FROM pg_statio_user_tables WHERE (heap_blks_hit + heap_blks_read) > 0`
  );
  
  if (!dbInfo || !connInfo || !cacheHit) {
    throw new Error('Failed to retrieve core database metrics');
  }
  
  return {
    name: dbInfo.db_name,
    size: dbInfo.db_size,
    connections: {
      active: Number.parseInt(connInfo.active_connections),
      idle: Number.parseInt(connInfo.idle_connections),
      total: Number.parseInt(connInfo.total_connections),
      max: Number.parseInt(connInfo.max_connections)
    },
    uptime: dbInfo.uptime,
    transactions: {
      committed: Number.parseInt(dbInfo.committed_tx),
      rolledBack: Number.parseInt(dbInfo.rolled_back_tx)
    },
    cacheHitRatio: cacheHit.cache_hit_ratio || 0,
  };
}

/**
 * Get table-level metrics
 */
async function getTableMetrics(db: DatabaseConnection): Promise<CappedRows<TableMetrics>> {
  const tableStats = await db.query<{
    relname: string;
    size: string;
    n_live_tup: string;
    n_dead_tup: string;
    last_vacuum: string | null;
    last_analyze: string | null;
    seq_scan: string;
    idx_scan: string;
  }>(
    `SELECT
       c.relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) as size,
       s.n_live_tup,
       s.n_dead_tup,
       s.last_vacuum,
       s.last_analyze,
       s.seq_scan,
       s.idx_scan
     FROM pg_class c
     JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC, c.relname
     LIMIT ${TABLE_METRICS_DIAGNOSTIC_LIMIT + 1}`
  );
  const visibleTableStats = tableStats.slice(0, TABLE_METRICS_DIAGNOSTIC_LIMIT);

  return {
    rows: visibleTableStats.map(table => ({
      name: table.relname,
      size: table.size,
      rowCount: Number.parseInt(table.n_live_tup),
      deadTuples: Number.parseInt(table.n_dead_tup),
      lastVacuum: table.last_vacuum,
      lastAnalyze: table.last_analyze,
      scanCount: Number.parseInt(table.seq_scan),
      indexUseRatio: Number.parseInt(table.seq_scan) + Number.parseInt(table.idx_scan) > 0
        ? Number.parseInt(table.idx_scan) / (Number.parseInt(table.seq_scan) + Number.parseInt(table.idx_scan))
        : 0
    })),
    capped: tableStats.length > TABLE_METRICS_DIAGNOSTIC_LIMIT
  };
}

/**
 * Get information about active queries
 */
async function getActiveQueries(db: DatabaseConnection): Promise<CappedRows<ActiveQueryInfo>> {
  const queries = await db.query<{
    pid: string;
    usename: string;
    datname: string;
    query_start: string;
    state: string;
    wait_event: string | null;
    query: string;
  }>(
    `SELECT
       pid,
       usename,
       datname,
       query_start::text,
       state,
       wait_event,
       query
     FROM pg_stat_activity
     WHERE state != 'idle'
       AND pid <> pg_backend_pid()
     ORDER BY query_start
     LIMIT ${ACTIVE_QUERY_DIAGNOSTIC_LIMIT + 1}`
  );
  const visibleQueries = queries.slice(0, ACTIVE_QUERY_DIAGNOSTIC_LIMIT);

  const now = new Date();

  return {
    rows: visibleQueries.map(q => {
      const startTime = new Date(q.query_start);
      const durationSeconds = (now.getTime() - startTime.getTime()) / 1000;

      return {
        pid: Number.parseInt(q.pid),
        username: q.usename,
        database: q.datname,
        startTime: q.query_start,
        duration: durationSeconds,
        state: q.state,
        waitEvent: q.wait_event || undefined,
        query: redactSqlText(q.query)
      };
    }),
    capped: queries.length > ACTIVE_QUERY_DIAGNOSTIC_LIMIT
  };
}

/**
 * Get information about locks
 */
async function getLockInfo(db: DatabaseConnection): Promise<CappedRows<LockInfo>> {
  const locks = await db.query<{
    relation: string;
    mode: string;
    granted: string;
    pid: string;
    usename: string;
    query: string;
  }>(
    `SELECT
       CASE
         WHEN l.relation IS NOT NULL THEN (SELECT relname FROM pg_class WHERE oid = l.relation)
         ELSE 'transactionid'
       END as relation,
       l.mode,
       l.granted::text,
       l.pid,
       a.usename,
       a.query
     FROM pg_locks l
     JOIN pg_stat_activity a ON l.pid = a.pid
     WHERE l.pid <> pg_backend_pid()
     ORDER BY relation, mode
     LIMIT ${LOCK_DIAGNOSTIC_LIMIT + 1}`
  );
  const visibleLocks = locks.slice(0, LOCK_DIAGNOSTIC_LIMIT);

  return {
    rows: visibleLocks.map(lock => ({
      relation: lock.relation,
      mode: lock.mode,
      granted: lock.granted === 't',
      pid: Number.parseInt(lock.pid),
      username: lock.usename,
      query: redactSqlText(lock.query)
    })),
    capped: locks.length > LOCK_DIAGNOSTIC_LIMIT
  };
}

/**
 * Get information about replication
 */
async function getReplicationInfo(db: DatabaseConnection): Promise<CappedRows<ReplicationInfo>> {
  const replication = await db.query<{
    client_addr: string | null;
    state: string;
    sent_lsn: string;
    write_lsn: string;
    flush_lsn: string;
    replay_lsn: string;
    write_lag: string | null;
    flush_lag: string | null;
    replay_lag: string | null;
  }>(
    `SELECT
       client_addr,
       state,
       sent_lsn::text,
       write_lsn::text,
       flush_lsn::text,
       replay_lsn::text,
       write_lag::text,
       flush_lag::text,
       replay_lag::text
     FROM pg_stat_replication
     ORDER BY client_addr NULLS LAST, state
     LIMIT ${REPLICATION_DIAGNOSTIC_LIMIT + 1}`
  );
  const visibleReplication = replication.slice(0, REPLICATION_DIAGNOSTIC_LIMIT);

  return {
    rows: visibleReplication.map(rep => ({
      clientAddr: rep.client_addr || 'local',
      state: rep.state,
      sentLsn: rep.sent_lsn,
      writeLsn: rep.write_lsn,
      flushLsn: rep.flush_lsn,
      replayLsn: rep.replay_lsn,
      writeLag: rep.write_lag,
      flushLag: rep.flush_lag,
      replayLag: rep.replay_lag
    })),
    capped: replication.length > REPLICATION_DIAGNOSTIC_LIMIT
  };
}
