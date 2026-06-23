import { describe, expect, it } from 'vitest';
import {
  buildCreateEnumTypeSql,
  buildStaticWhereClause,
  buildReturningClause,
  buildWhereClause,
  getReadOnlySqlValidationError,
  hasSqlStatementSeparator,
  redactSqlText,
  quoteLiteral,
  quoteIdent,
  quoteQualifiedIdent
} from './sql';

describe('SQL safety helpers', () => {
  it('quotes strict PostgreSQL identifiers', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('_internal_1')).toBe('"_internal_1"');
    expect(quoteQualifiedIdent('users')).toBe('"users"');
    expect(quoteQualifiedIdent('users', 'audit')).toBe('"audit"."users"');
  });

  it('rejects unsafe identifiers instead of escaping arbitrary input', () => {
    expect(() => quoteIdent('users; drop table users')).toThrow('Invalid SQL identifier');
    expect(() => quoteIdent('user"name')).toThrow('Invalid SQL identifier');
    expect(() => quoteIdent('123users')).toThrow('Invalid SQL identifier');
  });

  it('builds parameterized where clauses from structured predicates', () => {
    const result = buildWhereClause({
      id: 123,
      status: { in: ['active', 'pending'] },
      deleted_at: { isNull: true },
      score: { gte: 10 }
    }, 2);

    expect(result.clause).toBe('"id" = $2 AND "status" IN ($3, $4) AND "deleted_at" IS NULL AND "score" >= $5');
    expect(result.values).toEqual([123, 'active', 'pending', 10]);
  });

  it('uses IS NULL semantics for null equality comparisons', () => {
    expect(buildWhereClause({ deleted_at: null }).clause).toBe('"deleted_at" IS NULL');
    expect(buildWhereClause({ deleted_at: { ne: null } }).clause).toBe('"deleted_at" IS NOT NULL');
  });

  it('rejects ambiguous and empty predicates', () => {
    expect(() => buildWhereClause({})).toThrow('at least one column');
    expect(() => buildWhereClause({ status: { in: [] } })).toThrow('at least one value');
    expect(() => buildWhereClause({ status: { eq: 'a', ne: 'b' } as never })).toThrow('exactly one operator');
  });

  it('builds safe returning clauses from star, strings, or arrays', () => {
    expect(buildReturningClause('*')).toBe(' RETURNING *');
    expect(buildReturningClause('id, email')).toBe(' RETURNING "id", "email"');
    expect(buildReturningClause(['id', 'email'])).toBe(' RETURNING "id", "email"');
  });

  it('rejects expressions in returning clauses', () => {
    expect(() => buildReturningClause('id, now()')).toThrow('Invalid SQL identifier');
  });

  it('quotes SQL literals for static DDL predicates', () => {
    expect(quoteLiteral("O'Reilly")).toBe("'O''Reilly'");
    expect(quoteLiteral(true)).toBe('TRUE');
    expect(quoteLiteral(42)).toBe('42');
    expect(quoteLiteral(null)).toBe('NULL');
  });

  it('builds PostgreSQL-valid enum DDL', () => {
    expect(buildCreateEnumTypeSql('status', ['active', "owner's"], 'app')).toBe(
      'CREATE TYPE "app"."status" AS ENUM (\'active\', \'owner\'\'s\');'
    );
  });

  it('builds idempotent enum DDL without invalid IF NOT EXISTS syntax', () => {
    const sql = buildCreateEnumTypeSql('status', ['active'], 'app', true);

    expect(sql).toContain('DO $postgres_mcp_enum$');
    expect(sql).toContain('CREATE TYPE "app"."status" AS ENUM (\'active\');');
    expect(sql).toContain('WHEN duplicate_object THEN NULL;');
    expect(sql).not.toContain('CREATE TYPE IF NOT EXISTS');
  });

  it('uses a safe dollar quote delimiter for enum DDL blocks', () => {
    const sql = buildCreateEnumTypeSql('status', ['$postgres_mcp_enum$'], 'app', true);

    expect(sql).toContain('DO $postgres_mcp_enum_1$');
    expect(sql).toContain("'$postgres_mcp_enum$'");
  });

  it('builds static where clauses for DDL contexts', () => {
    expect(buildStaticWhereClause({
      active: true,
      status: { in: ['draft', "owner's"] },
      deleted_at: { isNull: true }
    })).toBe('"active" = TRUE AND "status" IN (\'draft\', \'owner\'\'s\') AND "deleted_at" IS NULL');
  });

  it('redacts SQL literals and comments while preserving query shape', () => {
    const redacted = redactSqlText(
      "SELECT * FROM users WHERE email = 'admin@example.com' AND code = 123 -- token=secret\nAND body = $$private$$"
    );

    expect(redacted).toBe("SELECT * FROM users WHERE email = '?' AND code = ? -- redacted comment\nAND body = $$?$$");
  });

  it('truncates redacted SQL text to the requested length', () => {
    expect(redactSqlText("SELECT 'secret', repeat('x', 100)", 18)).toBe("SELECT '?', rep...");
  });

  it('rejects data-changing SQL hidden inside CTEs', () => {
    expect(getReadOnlySqlValidationError(
      'WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted'
    )).toContain('DELETE');
    expect(getReadOnlySqlValidationError(
      'WITH updated AS (UPDATE users SET admin = true RETURNING *) SELECT * FROM updated'
    )).toContain('UPDATE');
  });

  it('ignores blocked keywords inside literals, comments, and quoted identifiers', () => {
    expect(getReadOnlySqlValidationError(
      'SELECT "update", \'delete\', $$insert$$ -- drop\nFROM audit_log'
    )).toBeUndefined();
  });

  it('ignores semicolons inside literals and comments when validating one statement', () => {
    expect(getReadOnlySqlValidationError(
      "SELECT '; still one statement' AS text_value -- comment ; ignored"
    )).toBeUndefined();
    expect(getReadOnlySqlValidationError(
      'SELECT $$; also one statement$$ AS text_value /* comment ; ignored */'
    )).toBeUndefined();
  });

  it('detects real statement separators outside masked SQL regions', () => {
    expect(hasSqlStatementSeparator("SELECT '; safe literal';")).toBe(false);
    expect(hasSqlStatementSeparator('SELECT $$; safe body$$;')).toBe(false);
    expect(hasSqlStatementSeparator('SELECT 1 -- comment ; ignored')).toBe(false);
    expect(hasSqlStatementSeparator("SELECT '; safe literal'; SELECT 2")).toBe(true);
  });

  it('still rejects semicolon statement separators outside masked SQL regions', () => {
    expect(getReadOnlySqlValidationError(
      "SELECT '; safe literal'; SELECT 2"
    )).toContain('without semicolons');
  });
});
