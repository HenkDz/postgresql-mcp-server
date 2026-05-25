import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_VERSION, allTools } from '../build/index.js';

const errors = [];
const postgresEnvKeys = [
  'POSTGRES_CONNECTION_STRING',
  'POSTGRES_TOOLS_CONFIG',
  'POSTGRES_MCP_SECURITY_MODE',
  'POSTGRES_MCP_ALLOW_DESTRUCTIVE',
  'POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING',
  'POSTGRES_MCP_WORKSPACE_DIR',
  'POSTGRES_MCP_AUDIT_FILE',
  'POSTGRES_MCP_MAX_CONNECTIONS',
  'POSTGRES_MCP_IDLE_TIMEOUT_MS',
  'POSTGRES_MCP_CONNECTION_TIMEOUT_MS',
  'POSTGRES_MCP_MAX_FILE_BYTES',
  'POSTGRES_MCP_STATEMENT_TIMEOUT_MS',
  'POSTGRES_MCP_QUERY_TIMEOUT_MS',
  'POSTGRES_MCP_LOCK_TIMEOUT_MS',
  'POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
  'POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS',
  'POSTGRES_MCP_DEBUG_SQL'
];

function cleanChildEnvironment() {
  const env = getDefaultEnvironment();
  for (const key of postgresEnvKeys) {
    delete env[key];
  }
  return env;
}

function requireCondition(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

async function runSmokeTest() {
  const client = new Client({
    name: 'postgres-mcp-smoke-verifier',
    version: '1.0.0'
  }, {
    capabilities: {}
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env: cleanChildEnvironment(),
    stderr: 'ignore'
  });

  try {
    await client.connect(transport);

    const serverVersion = client.getServerVersion();
    requireCondition(serverVersion?.name === 'postgresql-mcp-server', `Expected server name postgresql-mcp-server, got ${serverVersion?.name}.`);
    requireCondition(serverVersion?.version === PACKAGE_VERSION, `Expected server version ${PACKAGE_VERSION}, got ${serverVersion?.version}.`);
    requireCondition(!!client.getServerCapabilities()?.tools, 'Expected server to advertise tools capability.');

    const listedTools = await client.listTools({}, { timeout: 5000 });
    const listedToolNames = listedTools.tools.map((tool) => tool.name);
    const runtimeToolNames = allTools.map((tool) => tool.name);
    requireCondition(listedToolNames.length === runtimeToolNames.length, `Expected ${runtimeToolNames.length} listed tools, got ${listedToolNames.length}.`);
    requireCondition(JSON.stringify(listedToolNames) === JSON.stringify(runtimeToolNames), 'Listed tool names do not match runtime tool order.');

    const executeSqlSchema = listedTools.tools.find((tool) => tool.name === 'pg_execute_sql')?.inputSchema;
    requireCondition(executeSqlSchema?.additionalProperties === false, 'pg_execute_sql schema should reject unknown input fields.');
    requireCondition(Array.isArray(executeSqlSchema?.required) && executeSqlSchema.required.includes('sql'), 'pg_execute_sql schema should require sql.');

    const blockedResult = await client.callTool({
      name: 'pg_execute_query',
      arguments: {
        operation: 'select',
        query: 'SELECT 1',
        connectionString: 'postgresql://attacker:secret@localhost/postgres'
      }
    }, undefined, { timeout: 5000 });
    const blockedText = blockedResult.content?.[0]?.text ?? '';
    requireCondition(blockedResult.isError === true, 'Per-tool connection string call should return an MCP tool error result.');
    requireCondition(blockedText.includes('Per-tool connection string arguments are disabled'), 'Expected per-tool connection string denial text.');
    requireCondition(blockedText.includes('--connection-string'), 'Expected CLI guidance to preserve --connection-string.');
    requireCondition(blockedText.includes('--allow-tool-connection-string'), 'Expected CLI guidance to preserve --allow-tool-connection-string.');
    requireCondition(!blockedText.includes('secret'), 'Denied MCP tool result must not include connection-string password.');
  } finally {
    await client.close();
  }
}

try {
  await runSmokeTest();
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

if (errors.length > 0) {
  console.error('MCP stdio verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('MCP stdio verification passed.');
