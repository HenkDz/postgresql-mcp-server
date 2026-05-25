import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuditEvent, emitAuditEvent, isConnectionTargetDenial } from './audit';

describe('audit logging helpers', () => {
  const originalAuditFile = process.env.POSTGRES_MCP_AUDIT_FILE;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAuditFile === undefined) {
      delete process.env.POSTGRES_MCP_AUDIT_FILE;
    } else {
      process.env.POSTGRES_MCP_AUDIT_FILE = originalAuditFile;
    }
  });

  it('builds sanitized denial events without raw request payloads', () => {
    const event = buildAuditEvent({
      reason: 'security_policy_denied',
      toolName: 'pg_execute_sql',
      args: {
        operation: "drop table users; password='secret'",
        sql: "SELECT 'private-token'",
        connectionString: 'postgresql://app:secret@db.internal/app'
      },
      securityPolicy: { mode: 'readonly', allowDestructive: false },
      allowToolConnectionString: false,
      classification: {
        risk: 'arbitrary_sql',
        destructive: true,
        reason: 'Arbitrary SQL can read, write, change schema, or change roles.'
      },
      message: "Blocked near SELECT 'private-token' using postgresql://app:secret@db.internal/app"
    });

    expect(event).toMatchObject({
      event: 'postgres_mcp.security',
      outcome: 'denied',
      reason: 'security_policy_denied',
      toolName: 'pg_execute_sql',
      securityMode: 'readonly',
      allowDestructive: false,
      allowToolConnectionString: false,
      hasToolConnectionString: true,
      operation: '<invalid>',
      risk: 'arbitrary_sql',
      destructive: true
    });
    expect(JSON.stringify(event)).not.toContain('private-token');
    expect(JSON.stringify(event)).not.toContain('secret@');
    expect(JSON.stringify(event)).not.toContain('SELECT');
  });

  it('emits machine-readable audit JSON to stderr', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    emitAuditEvent({
      reason: 'tool_not_enabled',
      toolName: 'pg_missing_tool',
      args: {},
      securityPolicy: { mode: 'readonly', allowDestructive: false },
      allowToolConnectionString: false,
      availableButDisabled: false,
      message: 'Tool is not enabled.'
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe('[MCP Audit]');
    expect(JSON.parse(consoleError.mock.calls[0][1] as string)).toMatchObject({
      event: 'postgres_mcp.security',
      outcome: 'denied',
      reason: 'tool_not_enabled',
      toolName: 'pg_missing_tool'
    });
  });

  it('optionally appends sanitized audit JSONL to a configured file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-audit-'));
    const auditFile = join(tempDir, 'audit.jsonl');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.POSTGRES_MCP_AUDIT_FILE = auditFile;

    try {
      emitAuditEvent({
        reason: 'per_tool_connection_string_blocked',
        toolName: 'pg_execute_query',
        args: {
          connectionString: 'postgresql://app:secret@db.internal/app',
          query: "SELECT 'private-token'"
        },
        securityPolicy: { mode: 'readonly', allowDestructive: false },
        allowToolConnectionString: false,
        message: "Blocked postgresql://app:secret@db.internal/app near SELECT 'private-token'"
      });

      expect(consoleError).toHaveBeenCalledWith('[MCP Audit]', expect.any(String));
      const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        event: 'postgres_mcp.security',
        outcome: 'denied',
        reason: 'per_tool_connection_string_blocked',
        toolName: 'pg_execute_query',
        hasToolConnectionString: true
      });
      expect(lines[0]).not.toContain('secret@');
      expect(lines[0]).not.toContain('private-token');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not throw when the optional audit file cannot be written', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.POSTGRES_MCP_AUDIT_FILE = join('__missing_parent__', 'audit.jsonl');

    expect(() => emitAuditEvent({
      reason: 'tool_not_enabled',
      toolName: 'pg_missing_tool',
      args: {},
      securityPolicy: { mode: 'readonly', allowDestructive: false },
      allowToolConnectionString: false
    })).not.toThrow();

    expect(consoleError).toHaveBeenCalledWith('[MCP Audit Error]', expect.any(String));
    expect(existsSync(process.env.POSTGRES_MCP_AUDIT_FILE)).toBe(false);
  });

  it('recognizes connection target denial messages', () => {
    expect(isConnectionTargetDenial(new Error('Connection target "db" is not allowed by the configured connection target allowlist.'))).toBe(true);
    expect(isConnectionTargetDenial(new Error('Connection target allowlist requires URL connection strings to include an explicit host.'))).toBe(true);
    expect(isConnectionTargetDenial(new Error('Query failed'))).toBe(false);
  });
});
