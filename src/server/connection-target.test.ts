import { describe, expect, it } from 'vitest';
import {
  assertConnectionTargetAllowed,
  normalizeAllowedConnectionTargets,
  parseAllowedConnectionTarget,
  parseAllowedConnectionTargetList,
  parseConnectionTarget
} from './connection-target';

describe('connection target allowlist helpers', () => {
  it('parses PostgreSQL URL connection targets without retaining secrets', () => {
    expect(parseConnectionTarget('postgresql://readonly:s3cr3t@DB.internal:5432/app?sslmode=require')).toEqual({
      host: 'db.internal',
      port: '5432',
      database: 'app',
      user: 'readonly'
    });
  });

  it('parses keyword-style connection targets', () => {
    expect(parseConnectionTarget("host=db.internal port=5432 dbname=app user='read only' password=secret")).toEqual({
      host: 'db.internal',
      port: '5432',
      database: 'app',
      user: 'read only'
    });
  });

  it('supports exact and full-field wildcard allowlist entries', () => {
    const allowedTargets = normalizeAllowedConnectionTargets([
      'readonly@db.internal:5432/app',
      '*@localhost:*/dev'
    ]);

    expect(() => assertConnectionTargetAllowed(
      'postgresql://readonly:secret@db.internal:5432/app',
      allowedTargets
    )).not.toThrow();
    expect(() => assertConnectionTargetAllowed(
      'postgresql://alice:secret@localhost:6543/dev',
      allowedTargets
    )).not.toThrow();
    expect(() => assertConnectionTargetAllowed(
      'postgresql://readonly:secret@db.internal:5432/other',
      allowedTargets
    )).toThrow('is not allowed by the configured connection target allowlist');
  });

  it('treats omitted allowlist fields as unconstrained', () => {
    const allowedTargets = normalizeAllowedConnectionTargets(['db.internal']);

    expect(() => assertConnectionTargetAllowed(
      'postgresql://admin:secret@db.internal:9999/any_database',
      allowedTargets
    )).not.toThrow();
  });

  it('rejects empty and partial-wildcard allowlist patterns', () => {
    expect(() => parseAllowedConnectionTarget('')).toThrow('non-empty');
    expect(() => parseAllowedConnectionTarget('read*@db.internal/app')).toThrow('full-field wildcard');
    expect(() => parseAllowedConnectionTarget('db.*.internal/app')).toThrow('full-field wildcard');
    expect(() => parseAllowedConnectionTarget('db.internal:70000/app')).toThrow('integer from 1 to 65535');
  });

  it('parses comma-separated environment allowlist entries fail-closed', () => {
    expect(parseAllowedConnectionTargetList(' readonly@db:5432/app, *@localhost/* ')).toEqual([
      'readonly@db:5432/app',
      '*@localhost/*'
    ]);
    expect(parseAllowedConnectionTargetList(undefined)).toBeUndefined();
    expect(parseAllowedConnectionTargetList('   ')).toBeUndefined();
    expect(() => parseAllowedConnectionTargetList('db.internal,,localhost')).toThrow('must not contain empty entries');
  });

  it('rejects unsupported or ambiguous connection strings when allowlisting is enabled', () => {
    expect(() => parseConnectionTarget('postgresql:///app')).toThrow('explicit host');
    expect(() => parseConnectionTarget('service=prod')).toThrow('include host or hostaddr');
    expect(() => parseConnectionTarget('not a connection string')).toThrow('only supports PostgreSQL URL or keyword-style');
  });

  it('does not leak passwords in rejection errors', () => {
    const allowedTargets = normalizeAllowedConnectionTargets(['readonly@db.internal:5432/app']);

    expect(() => assertConnectionTargetAllowed(
      'postgresql://readonly:s3cr3t@other.internal:5432/app',
      allowedTargets
    )).toThrow('readonly@other.internal:5432/app');
    expect(() => assertConnectionTargetAllowed(
      'postgresql://readonly:s3cr3t@other.internal:5432/app',
      allowedTargets
    )).not.toThrow('s3cr3t');
  });
});
