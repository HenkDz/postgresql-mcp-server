import { describe, expect, it } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { hasToolSuppliedConnectionString, resolveConnectionString } from './boundary';

describe('server boundary helpers', () => {
  it('detects top-level per-tool connection string arguments', () => {
    expect(hasToolSuppliedConnectionString(undefined)).toBe(false);
    expect(hasToolSuppliedConnectionString({ tableName: 'users' })).toBe(false);
    expect(hasToolSuppliedConnectionString({ connectionString: 'postgresql://request' })).toBe(true);
    expect(hasToolSuppliedConnectionString({ sourceConnectionString: 'postgresql://source' })).toBe(true);
    expect(hasToolSuppliedConnectionString({ targetConnectionString: 'postgresql://target' })).toBe(true);
  });

  it('ignores non-string connection-string shaped fields', () => {
    expect(hasToolSuppliedConnectionString({ connectionString: 42 })).toBe(false);
    expect(hasToolSuppliedConnectionString({ sourceConnectionString: null })).toBe(false);
    expect(hasToolSuppliedConnectionString({ targetConnectionString: false })).toBe(false);
  });

  it('resolves connection strings in request, CLI, environment order', () => {
    expect(resolveConnectionString({
      requestConnectionString: 'postgresql://request',
      cliConnectionString: 'postgresql://cli',
      envConnectionString: 'postgresql://env'
    })).toBe('postgresql://request');

    expect(resolveConnectionString({
      cliConnectionString: 'postgresql://cli',
      envConnectionString: 'postgresql://env'
    })).toBe('postgresql://cli');

    expect(resolveConnectionString({
      envConnectionString: 'postgresql://env'
    })).toBe('postgresql://env');
  });

  it('rejects blank request connection strings instead of falling through', () => {
    expect(() => resolveConnectionString({
      requestConnectionString: '   ',
      cliConnectionString: 'postgresql://cli',
      envConnectionString: 'postgresql://env'
    })).toThrow('Tool argument connection string must be a non-empty string.');
  });

  it('rejects blank server-level connection strings instead of falling through', () => {
    expect(() => resolveConnectionString({
      cliConnectionString: '',
      envConnectionString: 'postgresql://env'
    })).toThrow('Server-level connection string must be a non-empty string.');
  });

  it('rejects blank environment connection strings', () => {
    expect(() => resolveConnectionString({
      envConnectionString: '\t '
    })).toThrow('POSTGRES_CONNECTION_STRING must be a non-empty string.');
  });

  it('throws an MCP validation error when no connection string source exists', () => {
    expect(() => resolveConnectionString({})).toThrow(McpError);
    expect(() => resolveConnectionString({})).toThrow('No connection string provided');
  });
});
