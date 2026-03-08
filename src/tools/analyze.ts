import { DatabaseConnection } from '../utils/connection.js';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { analyzeDatabase as originalAnalyzeDatabase } from './analyze.js'; // Assuming it's from a .js file initially
import { z } from 'zod';

interface AnalysisResult {
  version: string;
  settings: Record<string, string>;
  metrics: {
    connections: number;
    activeQueries: number;
    cacheHitRatio: number;
    tableSizes: Record<string, string>;
  };
  recommendations: string[];
}

// Definition previously in TOOL_DEFINITIONS
const toolDefinition = {
  name: 'pg_analyze_database',
  description: 'Analyze PostgreSQL database configuration and performance. Use when the user wants to pg analyze database. Unlike pg_debug_database, pg_analyze_index_usage, this tool specifically handles pg analyze database.',
  inputSchema: z.object({
    connectionString: z.string().optional()
      .describe('PostgreSQL connection string (optional if POSTGRES_CONNECTION_STRING environment variable or --connection-string CLI option is set)'),
    analysisType: z.enum(['configuration', 'performance', 'security']).optional()
      .describe('Type of analysis to perform')
  })
};

export const analyzeDatabaseTool: PostgresTool = {
  name: toolDefinition.name,
  description: toolDefinition.description,
  inputSchema: toolDefinition.inputSchema,
  execute: async (args: { connectionString?: string; analysisType?: 'configuration' | 'performance' | 'security'; }, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> => {
    const { connectionString: connStringArg, analysisType } = args;

    if (!analysisType || !['configuration', 'performance', 'security'].includes(analysisType)) {
        return {
            content: [{ type: 'text', text: 'Error: analysisType is required and must be one of [\'configuration\', \'performance\', \'security\'].' }],
            isError: true,
        };
    }

    const resolvedConnString = getConnectionString(connStringArg);
    const result = await originalAnalyzeDatabase(resolvedConnString, analysisType);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  },
};

export async function analyzeDatabase(
  connectionString: string,
  analysisType: 'configuration' | 'performance' | 'security' = 'configuration'
): Promise<AnalysisResult> {
  const db = DatabaseConnection.getInstance();
  await db.connect(connectionString);

  try {
    const version = await getVersion();
    const settings = await getSettings();
    const metrics = await getMetrics();
    const recommendations = await generateRecommendations(analysisType, settings, metrics);

    return {
      version,
      settings,
      metrics,
      recommendations,
    };
  } finally {
    await db.disconnect();
  }
}

async function getVersion(): Promise<string> {
  const db = DatabaseConnection.getInstance();
  const result = await db.query<{ version: string }>('SELECT version()');
  return result[0].version;
}

async function getSettings(): Promise<Record<string, string>> {
  const db = DatabaseConnection.getInstance();
  const result = await db.query<{ name: string; setting: string; unit: string }>(
    'SELECT name, setting, unit FROM pg_settings WHERE name IN ($1, $2, $3, $4, $5)',
    ['max_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size']
  );

  return result.reduce((acc: Record<string, string>, row: { name: string; setting: string; unit: string }) => {
    acc[row.name] = row.unit ? `${row.setting}${row.unit}` : row.setting;
    return acc;
  }, {});
}

async function getMetrics(): Promise<AnalysisResult['metrics']> {
  const db = DatabaseConnection.getInstance();

  const connections = await db.query<{ count: string }>(
    'SELECT count(*) FROM pg_stat_activity'
  );

  const activeQueries = await db.query<{ count: string }>(
    "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'"
  );

  // First get raw stats for diagnostic logging
  const rawStats = await db.query<{ datname: string; hits: number; reads: number }>(
    `SELECT
      datname,
      COALESCE(blks_hit, 0) as hits,
      COALESCE(blks_read, 0) as reads
    FROM pg_stat_database
    WHERE datname = current_database()`
  );

  console.error('Cache stats:', rawStats[0]); // Diagnostic logging

  // Then calculate ratio with additional safety checks
  const cacheHit = await db.query<{ ratio: number }>(
    `WITH stats AS (
      SELECT
        COALESCE(blks_hit, 0) as hits,
        COALESCE(blks_read, 0) as reads
      FROM pg_stat_database
      WHERE datname = current_database()
    )
    SELECT
      CASE
        WHEN (hits + reads) = 0 THEN 0
        ELSE ROUND((hits::float / (hits + reads)::float)::numeric, 2)
      END as ratio
    FROM stats`
  );

  // Ensure ratio is a number
  const rawRatio = cacheHit[0]?.ratio ?? 0;
  let ratio: number;

  // If rawRatio is a string, parseFloat it.
  // If it's already a number, just convert using Number().
  if (typeof rawRatio === 'string') {
    ratio = Number.parseFloat(rawRatio);
  } else {
    ratio = Number(rawRatio);
  }

  // Fallback to 0 if the result is NaN
  if (Number.isNaN(ratio)) {
    ratio = 0;
  }

  console.error('Calculated ratio:', ratio); // Diagnostic logging

  const tableSizes = await db.query<{ tablename: string; size: string }>(
    `SELECT 
      tablename,
      pg_size_pretty(pg_table_size(schemaname || '.' || tablename)) as size
    FROM pg_tables 
    WHERE schemaname = 'public'`
  );

  return {
    connections: Number.parseInt(connections[0].count),
    activeQueries: Number.parseInt(activeQueries[0].count),
    cacheHitRatio: Number.parseFloat(ratio.toFixed(2)),
    tableSizes: tableSizes.reduce((acc: Record<string, string>, row: { tablename: string; size: string }) => {
      acc[row.tablename] = row.size;
      return acc;
    }, {}),
  };
}

async function generateRecommendations(
  type: 'configuration' | 'performance' | 'security',
  settings: Record<string, string>,
  metrics: AnalysisResult['metrics']
): Promise<string[]> {
  const recommendations: string[] = [];

  if (type === 'configuration' || type === 'performance') {
    if (metrics.cacheHitRatio < 0.99) {
      recommendations.push('Consider increasing shared_buffers to improve cache hit ratio');
    }

    if (metrics.connections > Number.parseInt(settings.max_connections) * 0.8) {
      recommendations.push('High connection usage detected. Consider increasing max_connections or implementing connection pooling');
    }
  }

  if (type === 'security') {
    const db = DatabaseConnection.getInstance();
    
    // Check for superusers
    const superusers = await db.query<{ count: string }>(
      "SELECT count(*) FROM pg_user WHERE usesuper = true"
    );
    
    if (Number.parseInt(superusers[0].count) > 1) {
      recommendations.push('Multiple superuser accounts detected. Review and reduce if possible');
    }

    // Check SSL
    const ssl = await db.query<{ ssl: string }>("SHOW ssl");
    if (ssl[0].ssl !== 'on') {
      recommendations.push('SSL is not enabled. Consider enabling SSL for secure connections');
    }
  }

  return recommendations;
}