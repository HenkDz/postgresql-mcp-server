import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export interface ConnectionStringSources {
  requestConnectionString?: string;
  cliConnectionString?: string;
  envConnectionString?: string;
}

export function hasToolSuppliedConnectionString(args: unknown): boolean {
  if (!args || typeof args !== 'object') {
    return false;
  }

  const params = args as Record<string, unknown>;
  return typeof params.connectionString === 'string' ||
    typeof params.sourceConnectionString === 'string' ||
    typeof params.targetConnectionString === 'string';
}

export function getToolSuppliedConnectionStrings(args: unknown): string[] {
  if (!args || typeof args !== 'object') {
    return [];
  }

  const params = args as Record<string, unknown>;
  return [
    params.connectionString,
    params.sourceConnectionString,
    params.targetConnectionString
  ].filter((value): value is string => typeof value === 'string');
}

function validateConnectionStringSource(errorMessage: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.trim() === '') {
    throw new McpError(
      ErrorCode.InvalidParams,
      errorMessage
    );
  }

  return value;
}

/**
 * Request connection strings are accepted here only after the MCP request
 * handler has applied the allow-tool-connection-string gate.
 */
export function resolveConnectionString(sources: ConnectionStringSources): string {
  const requestConnectionString = validateConnectionStringSource(
    'Tool argument connection string must be a non-empty string.',
    sources.requestConnectionString
  );
  if (requestConnectionString !== undefined) {
    return requestConnectionString;
  }

  const cliConnectionString = validateConnectionStringSource(
    'Server-level connection string must be a non-empty string.',
    sources.cliConnectionString
  );
  if (cliConnectionString !== undefined) {
    return cliConnectionString;
  }

  const envConnectionString = validateConnectionStringSource(
    'POSTGRES_CONNECTION_STRING must be a non-empty string.',
    sources.envConnectionString
  );
  if (envConnectionString !== undefined) {
    return envConnectionString;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    'No connection string provided. Provide one in the tool arguments, via the --connection-string CLI option, or set the POSTGRES_CONNECTION_STRING environment variable.'
  );
}
