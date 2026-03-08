import { DatabaseConnection } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

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

const AlertThresholdsSchema = z.object({
  connectionPercentage: z.number().min(0).max(100).optional().describe("Connection usage percentage threshold"),
  longRunningQuerySeconds: z.number().positive().optional().describe("Long-running query threshold in seconds"),
  cacheHitRatio: z.number().min(0).max(1).optional().describe("Cache hit ratio threshold"),
  deadTuplesPercentage: z.number().min(0).max(100).optional().describe("Dead tuples percentage threshold"),
  vacuumAge: z.number().positive().int().optional().describe("Vacuum age threshold in days"),
}).describe("Alert thresholds");

const MonitorDatabaseInputSchema = z.object({
  connectionString: z.string().optional(),
  includeTables: z.boolean().optional().default(false),
  includeQueries: z.boolean().optional().default(false),
  includeLocks: z.boolean().optional().default(false),
  includeReplication: z.boolean().optional().default(false),
  alertThresholds: AlertThresholdsSchema.optional(),
});

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
      const tables = await getTableMetrics(db);
      
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
      activeQueriesResult = await getActiveQueries(db);
      
      if (alertThresholds?.longRunningQuerySeconds) {
        const threshold = alertThresholds.longRunningQuerySeconds;
        const longRunningQueries = activeQueriesResult.filter(
          q => q.duration > threshold
        );
        
        for (const query of longRunningQueries) {
          alerts.push({
            level: query.duration > threshold * 2 ? 'critical' : 'warning',
            message: `Long-running query (${query.duration.toFixed(1)}s) by ${query.username}`,
            context: {
              pid: query.pid,
              duration: query.duration,
              query: query.query.substring(0, 100) + (query.query.length > 100 ? '...' : '')
            }
          });
        }
      }
    }
    
    let locksResult: LockInfo[] = [];
    if (includeLocks) {
      locksResult = await getLockInfo(db);
      
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
      replicationResult = await getReplicationInfo(db);
      
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
    console.error("Error monitoring database:", error);
    throw new McpError(ErrorCode.InternalError, `Failed to monitor database: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const monitorDatabaseTool: PostgresTool = {
  name: 'pg_monitor_database',
  description: 'Get real-time monitoring information for a PostgreSQL database. Use when the user wants to pg monitor database. Unlike pg_analyze_database, pg_debug_database, this tool specifically handles pg monitor database.',
  inputSchema: MonitorDatabaseInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = MonitorDatabaseInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
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
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
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
async function getTableMetrics(db: DatabaseConnection): Promise<TableMetrics[]> {
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
     ORDER BY c.relname`
  );
  
  return tableStats.map(table => ({
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
  }));
}

/**
 * Get information about active queries
 */
async function getActiveQueries(db: DatabaseConnection): Promise<ActiveQueryInfo[]> {
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
     ORDER BY query_start`
  );
  
  const now = new Date();
  
  return queries.map(q => {
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
      query: q.query
    };
  });
}

/**
 * Get information about locks
 */
async function getLockInfo(db: DatabaseConnection): Promise<LockInfo[]> {
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
     ORDER BY relation, mode`
  );
  
  return locks.map(lock => ({
    relation: lock.relation,
    mode: lock.mode,
    granted: lock.granted === 't',
    pid: Number.parseInt(lock.pid),
    username: lock.usename,
    query: lock.query
  }));
}

/**
 * Get information about replication
 */
async function getReplicationInfo(db: DatabaseConnection): Promise<ReplicationInfo[]> {
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
     FROM pg_stat_replication`
  );
  
  return replication.map(rep => ({
    clientAddr: rep.client_addr || 'local',
    state: rep.state,
    sentLsn: rep.sent_lsn,
    writeLsn: rep.write_lsn,
    flushLsn: rep.flush_lsn,
    replayLsn: rep.replay_lsn,
    writeLag: rep.write_lag,
    flushLag: rep.flush_lag,
    replayLag: rep.replay_lag
  }));
} 