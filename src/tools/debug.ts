import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { redactSqlText } from '../utils/sql.js';

interface DebugResult {
  issue: string;
  status: 'error' | 'warning' | 'ok';
  details: string[];
  recommendations: string[];
}

interface UnusedIndex {
  schemaname: string;
  tablename: string;
  indexname: string;
  idx_scan: number;
  replay_lag: string | null;
}

interface LockInfo {
  blocked_pid: number;
  blocked_user: string;
  blocking_pid: number;
  blocking_user: string;
  blocked_statement: string;
}

interface ReplicationStatus {
  client_addr: string;
  state: string;
  sent_lsn: string;
  write_lsn: string;
  flush_lsn: string;
  replay_lsn: string;
  write_lag: string | null;
  flush_lag: string | null;
  replay_lag: string | null;
}

const SLOW_QUERY_DIAGNOSTIC_LIMIT = 25;
const UNUSED_INDEX_DIAGNOSTIC_LIMIT = 50;
const LOCK_DIAGNOSTIC_LIMIT = 50;
const REPLICATION_DIAGNOSTIC_LIMIT = 50;

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

const DebugDatabaseInputSchema = z.object({
  connectionString: z.string().optional(),
  issue: z.enum(['connection', 'performance', 'locks', 'replication']),
  logLevel: z.enum(['info', 'debug', 'trace']).optional().default('info'),
}).strict();

type DebugDatabaseInput = z.infer<typeof DebugDatabaseInputSchema>;

async function executeDebugDatabase(
  input: DebugDatabaseInput,
  getConnectionString: GetConnectionStringFn
): Promise<DebugResult> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();

  try {
    await db.connect(resolvedConnectionString);

    switch (input.issue) {
      case 'connection':
        return await debugConnection(db);
      case 'performance':
        return await debugPerformance(db);
      case 'locks':
        return await debugLocks(db);
      case 'replication':
        return await debugReplication(db);
      default:
        // This case should be unreachable due to Zod validation
        throw new McpError(ErrorCode.InvalidParams, `Unsupported issue type: ${input.issue}`);
    }
  } finally {
    // Ensure disconnect is called even if connect fails or other errors occur
    await db.disconnect();
  }
}

export const debugDatabaseTool: PostgresTool = {
  name: 'pg_debug_database',
  description: 'Debug common PostgreSQL issues',
  inputSchema: DebugDatabaseInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = DebugDatabaseInputSchema.safeParse(params);
    if (!validationResult.success) {
      return {
        content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }],
        isError: true,
      };
    }
    try {
      const result = await executeDebugDatabase(validationResult.data, getConnectionString);
      // Convert DebugResult to ToolOutput format
      return {
        content: [
          { type: 'text', text: `Debug Result for Issue: ${result.issue}` },
          { type: 'text', text: `Status: ${result.status}` },
          { type: 'text', text: `Details:\n${result.details.join('\n')}` },
          { type: 'text', text: `Recommendations:\n${result.recommendations.join('\n')}` },
        ],
      };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return {
        content: [{ type: 'text', text: `Error debugging database: ${errorMessage}` }],
        isError: true,
      };
    }
  }
};

async function debugConnection(db: DatabaseConnection): Promise<DebugResult> {
  const result: DebugResult = {
    issue: 'connection',
    status: 'ok',
    details: [],
    recommendations: []
  };

  try {
    // Check max connections
    const maxConns = await db.query<{ setting: string }>(
      "SELECT setting FROM pg_settings WHERE name = 'max_connections'"
    );
    const currentConns = await db.query<{ count: string }>(
      'SELECT count(*) FROM pg_stat_activity'
    );

    const max = Number.parseInt(maxConns[0].setting);
    const current = Number.parseInt(currentConns[0].count);
    const percentage = (current / max) * 100;

    result.details.push(
      `Current connections: ${current}/${max} (${percentage.toFixed(1)}%)`
    );

    if (percentage > 80) {
      result.status = 'warning';
      result.recommendations.push(
        'High connection usage. Consider implementing connection pooling',
        'Review application connection handling',
        'Monitor for connection leaks'
      );
    }

    // Check for idle connections
    const idleConns = await db.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle'"
    );
    const idleCount = Number.parseInt(idleConns[0].count);
    if (idleCount > 5) {
      result.details.push(`High number of idle connections: ${idleCount}`);
      result.recommendations.push(
        'Consider implementing connection timeouts',
        'Review connection pool settings'
      );
    }

  } catch (error: unknown) {
    result.status = 'error';
    result.details.push(`Connection error: ${sanitizeErrorMessage(error)}`);
  }

  return result;
}

async function debugPerformance(db: DatabaseConnection): Promise<DebugResult> {
  const result: DebugResult = {
    issue: 'performance',
    status: 'ok',
    details: [],
    recommendations: []
  };

  try {
    // Check slow queries
    const slowQueries = await db.query<{ query: string; duration: number }>(
      `SELECT query, extract(epoch from now() - query_start) as duration
       FROM pg_stat_activity
       WHERE state = 'active'
         AND query NOT LIKE '%pg_stat_activity%'
         AND query_start < now() - interval '30 second'
       ORDER BY query_start
       LIMIT ${SLOW_QUERY_DIAGNOSTIC_LIMIT + 1}`
    );
    const visibleSlowQueries = slowQueries.slice(0, SLOW_QUERY_DIAGNOSTIC_LIMIT);

    if (visibleSlowQueries.length > 0) {
      result.status = 'warning';
      result.details.push('Long-running queries detected:');
      for (const q of visibleSlowQueries) {
        result.details.push(`Duration: ${q.duration}s - Query: ${redactSqlText(q.query)}`);
      }
      if (slowQueries.length > SLOW_QUERY_DIAGNOSTIC_LIMIT) {
        result.details.push(`Additional long-running queries omitted after ${SLOW_QUERY_DIAGNOSTIC_LIMIT} rows.`);
      }
      result.recommendations.push(
        'Review and optimize slow queries',
        'Consider adding appropriate indexes',
        'Check for missing VACUUM operations'
      );
    }

    // Check index usage
    const unusedIndexes = await db.query<UnusedIndex>(
      `SELECT s.schemaname,
             s.relname AS tablename,
             s.indexrelname AS indexname,
             s.idx_scan
      FROM pg_stat_user_indexes s
      WHERE s.idx_scan = 0
        AND s.schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY s.schemaname, s.relname, s.indexrelname
      LIMIT ${UNUSED_INDEX_DIAGNOSTIC_LIMIT + 1}`
    );
    const visibleUnusedIndexes = unusedIndexes.slice(0, UNUSED_INDEX_DIAGNOSTIC_LIMIT);

    if (visibleUnusedIndexes.length > 0) {
      result.details.push('Unused indexes found:');
      for (const idx of visibleUnusedIndexes) {
        result.details.push(
          `${idx.schemaname}.${idx.tablename} - ${idx.indexname}`
        );
      }
      if (unusedIndexes.length > UNUSED_INDEX_DIAGNOSTIC_LIMIT) {
        result.details.push(`Additional unused indexes omitted after ${UNUSED_INDEX_DIAGNOSTIC_LIMIT} rows.`);
      }
      result.recommendations.push(
        'Consider removing unused indexes',
        'Review index strategy'
      );
    }

  } catch (error: unknown) {
    result.status = 'error';
    result.details.push(`Performance analysis error: ${sanitizeErrorMessage(error)}`);
  }

  return result;
}

async function debugLocks(db: DatabaseConnection): Promise<DebugResult> {
  const result: DebugResult = {
    issue: 'locks',
    status: 'ok',
    details: [],
    recommendations: []
  };

  try {
    const locks = await db.query<LockInfo>(
      `SELECT blocked_locks.pid AS blocked_pid,
              blocked_activity.usename AS blocked_user,
              blocking_locks.pid AS blocking_pid,
              blocking_activity.usename AS blocking_user,
              blocked_activity.query AS blocked_statement
       FROM pg_catalog.pg_locks blocked_locks
       JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
       JOIN pg_catalog.pg_locks blocking_locks 
            ON blocking_locks.locktype = blocked_locks.locktype
            AND blocking_locks.DATABASE IS NOT DISTINCT FROM blocked_locks.DATABASE
            AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
            AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
            AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
            AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
            AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
            AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
            AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
            AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
            AND blocking_locks.pid != blocked_locks.pid
       JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
       WHERE NOT blocked_locks.GRANTED
       ORDER BY blocked_locks.pid, blocking_locks.pid
       LIMIT ${LOCK_DIAGNOSTIC_LIMIT + 1}`
    );
    const visibleLocks = locks.slice(0, LOCK_DIAGNOSTIC_LIMIT);

    if (visibleLocks.length > 0) {
      result.status = 'warning';
      result.details.push('Lock conflicts detected:');
      for (const lock of visibleLocks) {
        result.details.push(
          `Process ${lock.blocked_pid} (${lock.blocked_user}) blocked by process ${lock.blocking_pid} (${lock.blocking_user})`
        );
        result.details.push(`Blocked query: ${redactSqlText(lock.blocked_statement)}`);
      }
      if (locks.length > LOCK_DIAGNOSTIC_LIMIT) {
        result.details.push(`Additional lock conflicts omitted after ${LOCK_DIAGNOSTIC_LIMIT} rows.`);
      }
      result.recommendations.push(
        'Consider killing blocking queries if appropriate',
        'Review transaction management in application code',
        'Check for long-running transactions'
      );
    }

  } catch (error: unknown) {
    result.status = 'error';
    result.details.push(`Lock analysis error: ${sanitizeErrorMessage(error)}`);
  }

  return result;
}

async function debugReplication(db: DatabaseConnection): Promise<DebugResult> {
  const result: DebugResult = {
    issue: 'replication',
    status: 'ok',
    details: [],
    recommendations: []
  };

  try {
    // Check replication status
    const replicationStatus = await db.query<ReplicationStatus>(
      `SELECT client_addr, 
              state,
              sent_lsn,
              write_lsn,
              flush_lsn,
              replay_lsn,
              write_lag,
              flush_lag,
              replay_lag
       FROM pg_stat_replication
       ORDER BY client_addr NULLS LAST, state
       LIMIT ${REPLICATION_DIAGNOSTIC_LIMIT + 1}`
    );
    const visibleReplicationStatus = replicationStatus.slice(0, REPLICATION_DIAGNOSTIC_LIMIT);

    if (visibleReplicationStatus.length === 0) {
      result.details.push('No active replication detected');
      result.recommendations.push(
        'If replication is expected, check configuration',
        'Verify replication slots are created',
        'Check network connectivity between nodes'
      );
      return result;
    }

    result.status = 'ok'; // Default to ok, specific checks might change it
    result.details.push('Replication status:');
    for (const status of visibleReplicationStatus) {
      result.details.push(
        `Replica: ${status.client_addr}, State: ${status.state}, Sent LSN: ${status.sent_lsn}, Replay LSN: ${status.replay_lsn}`
      );

      const writeLagSeconds = status.write_lag ? Number.parseFloat(status.write_lag.split(' ')[0]) : 0;
      const flushLagSeconds = status.flush_lag ? Number.parseFloat(status.flush_lag.split(' ')[0]) : 0;
      const replayLagSeconds = status.replay_lag ? Number.parseFloat(status.replay_lag.split(' ')[0]) : 0;

      if (writeLagSeconds > 60 || flushLagSeconds > 60 || replayLagSeconds > 60) {
        result.status = 'warning';
        result.recommendations.push(
          `High replication lag (${status.replay_lag}) for ${status.client_addr}`,
          'Check network bandwidth between nodes',
          'Review WAL settings',
          'Monitor system resources on replica'
        );
      }
    }
    if (replicationStatus.length > REPLICATION_DIAGNOSTIC_LIMIT) {
      result.details.push(`Additional replication rows omitted after ${REPLICATION_DIAGNOSTIC_LIMIT} rows.`);
    }

  } catch (error: unknown) {
    result.status = 'error';
    result.details.push(`Replication analysis error: ${sanitizeErrorMessage(error)}`);
  }

  return result;
}
