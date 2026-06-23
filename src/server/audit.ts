import { appendFileSync } from 'node:fs';
import type { SecurityPolicy, ToolCallClassification } from '../security/policy.js';
import { sanitizeErrorMessage } from '../utils/connection.js';
import { hasToolSuppliedConnectionString } from './boundary.js';

export type AuditDenialReason =
  | 'tool_not_enabled'
  | 'per_tool_connection_string_blocked'
  | 'connection_target_denied'
  | 'security_policy_denied';

export interface AuditEvent {
  event: 'postgres_mcp.security';
  outcome: 'denied';
  reason: AuditDenialReason;
  toolName: string;
  securityMode: SecurityPolicy['mode'];
  allowDestructive: boolean;
  allowToolConnectionString: boolean;
  hasToolConnectionString: boolean;
  operation?: string;
  risk?: ToolCallClassification['risk'];
  destructive?: boolean;
  availableButDisabled?: boolean;
  message?: string;
}

export interface AuditEventContext {
  reason: AuditDenialReason;
  toolName: string;
  args: unknown;
  securityPolicy: SecurityPolicy;
  allowToolConnectionString: boolean;
  classification?: ToolCallClassification;
  availableButDisabled?: boolean;
  message?: string;
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;

function normalizeAuditIdentifier(value: string): string {
  return SAFE_IDENTIFIER_PATTERN.test(value) ? value : '<invalid>';
}

function getSafeOperation(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || !('operation' in args)) {
    return undefined;
  }

  const operation = (args as { operation?: unknown }).operation;
  if (typeof operation !== 'string') {
    return '<invalid>';
  }

  return SAFE_IDENTIFIER_PATTERN.test(operation) ? operation : '<invalid>';
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

export function buildAuditEvent(context: AuditEventContext): AuditEvent {
  const event: AuditEvent = {
    event: 'postgres_mcp.security',
    outcome: 'denied',
    reason: context.reason,
    toolName: normalizeAuditIdentifier(context.toolName),
    securityMode: context.securityPolicy.mode,
    allowDestructive: context.securityPolicy.allowDestructive,
    allowToolConnectionString: context.allowToolConnectionString,
    hasToolConnectionString: hasToolSuppliedConnectionString(context.args)
  };

  const operation = getSafeOperation(context.args);
  if (operation !== undefined) {
    event.operation = operation;
  }

  if (context.classification) {
    event.risk = context.classification.risk;
    event.destructive = context.classification.destructive;
  }

  if (context.availableButDisabled !== undefined) {
    event.availableButDisabled = context.availableButDisabled;
  }

  if (context.message && context.reason !== 'security_policy_denied') {
    event.message = truncate(sanitizeErrorMessage(context.message), 500);
  }

  return event;
}

export function emitAuditEvent(context: AuditEventContext): void {
  const line = JSON.stringify(buildAuditEvent(context));
  console.error('[MCP Audit]', line);

  const auditFile = process.env.POSTGRES_MCP_AUDIT_FILE;
  if (!auditFile) {
    return;
  }

  try {
    appendFileSync(auditFile, `${line}\n`, { encoding: 'utf8' });
  } catch (error) {
    console.error('[MCP Audit Error]', sanitizeErrorMessage(error));
  }
}

export function isConnectionTargetDenial(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Connection target allowlist') ||
    message.includes('connection target allowlist') ||
    message.includes('configured connection target allowlist');
}
