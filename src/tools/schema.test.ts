import { afterEach, describe, it, expect, vi } from 'vitest';
import { getSchemaInfoTool, manageSchemaTools } from './schema';
import { Pool } from 'pg';
import { DatabaseConnection } from '../utils/connection';

describe('manageSchemaTools', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('mock-connection-string');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('should handle get_info operation', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ table_name: 'users' }] }),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as any; // Broaden mock for DatabaseConnection
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockPool);

    const result = await manageSchemaTools.execute({
      operation: 'get_info'
    }, mockGetConnectionString);

    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text' }));
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('redacts literals in detailed schema metadata', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([
          {
            column_name: 'token',
            data_type: 'text',
            is_nullable: 'NO',
            column_default: "'raw-schema-secret'::text"
          }
        ])
        .mockResolvedValueOnce([
          {
            constraint_name: 'users_token_check',
            constraint_type: 'CHECK',
            definition: "CHECK ((token <> 'raw-schema-secret'))"
          }
        ])
        .mockResolvedValueOnce([
          {
            indexname: 'idx_users_token',
            indexdef: "CREATE INDEX idx_users_token ON users USING btree (token) WHERE token = 'raw-schema-secret'"
          }
        ]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'get_info',
      tableName: 'users'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("'?'::text");
    expect(output).toContain("token <> '?'");
    expect(output).toContain("token = '?'");
    expect(output).not.toContain('raw-schema-secret');
  });

  it('lists tables from the requested schema', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{ table_name: 'events' }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'get_info',
      schema: 'audit'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain('List of tables in schema audit');
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('WHERE table_schema = $1'), ['audit']);
    expect(mockDb.query).not.toHaveBeenCalledWith(expect.stringContaining("table_schema = 'public'"));
  });

  it('direct schema-info tool lists tables from the requested schema', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{ table_name: 'events' }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getSchemaInfoTool.execute({
      schema: 'audit'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain('List of tables in schema audit');
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('WHERE table_schema = $1'), ['audit']);
  });

  it('gets detailed table info from the requested schema', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn()
        .mockResolvedValueOnce([
          {
            column_name: 'event_id',
            data_type: 'uuid',
            is_nullable: 'NO',
            column_default: null
          }
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'get_info',
      schema: 'audit',
      tableName: 'events'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain('Schema information for table audit.events');
    expect(output).toContain('"schema": "audit"');
    expect(mockDb.query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE table_schema = $1 AND table_name = $2'), ['audit', 'events']);
    expect(mockDb.query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE tn.nspname = $1 AND cl.relname = $2'), ['audit', 'events']);
    expect(mockDb.query).toHaveBeenNthCalledWith(3, expect.stringContaining('WHERE c.relkind = \'r\' AND n.nspname = $1 AND c.relname = $2'), ['audit', 'events']);
  });

  it('should return an MCP error result for invalid operation', async () => {
    const result = await manageSchemaTools.execute({ operation: 'invalid' }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Invalid enum value');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
  });

  it('rejects unknown schema-management fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_table',
      tableName: 'users',
      columns: [{ name: 'id', type: 'integer' }],
      rawSql: 'DROP TABLE users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('rejects unknown nested schema-management fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'alter_table',
      tableName: 'users',
      operations: [
        {
          type: 'add',
          columnName: 'nickname',
          dataType: 'text',
          using: 'nickname::text'
        }
      ]
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('operations.0');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
  });

  it('creates tables with quoted schema, table, and column identifiers', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_table',
      schema: 'app',
      tableName: 'users',
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'email', type: 'varchar(255)' },
        { name: 'created_at', type: 'timestamp with time zone' }
      ]
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(
      'CREATE TABLE IF NOT EXISTS "app"."users" ("id" integer NOT NULL, "email" varchar(255), "created_at" timestamp with time zone)'
    );
  });

  it('does not echo default expressions in create-table success responses', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_table',
      schema: 'app',
      tableName: 'tokens',
      columns: [
        { name: 'token', type: 'text', default: "'raw-secret-token'" }
      ]
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(
      'CREATE TABLE IF NOT EXISTS "app"."tokens" ("token" text DEFAULT \'raw-secret-token\')'
    );
    expect(output).toContain('"defaultSet": true');
    expect(output).not.toContain('raw-secret-token');
  });

  it('alters tables with quoted identifiers inside a transaction', async () => {
    const client = { query: vi.fn().mockResolvedValue(undefined) };
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: typeof client) => Promise<void>) => callback(client)),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'alter_table',
      schema: 'app',
      tableName: 'users',
      operations: [
        { type: 'add', columnName: 'nickname', dataType: 'text', nullable: true },
        { type: 'drop', columnName: 'legacy_name' }
      ]
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(client.query).toHaveBeenNthCalledWith(1, 'ALTER TABLE "app"."users" ADD COLUMN "nickname" text');
    expect(client.query).toHaveBeenNthCalledWith(2, 'ALTER TABLE "app"."users" DROP COLUMN "legacy_name"');
  });

  it('does not echo default expressions in alter-table success responses', async () => {
    const client = { query: vi.fn().mockResolvedValue(undefined) };
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: typeof client) => Promise<void>) => callback(client)),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'alter_table',
      schema: 'app',
      tableName: 'tokens',
      operations: [
        { type: 'add', columnName: 'token', dataType: 'text', default: "'raw-secret-token'" }
      ]
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith(
      'ALTER TABLE "app"."tokens" ADD COLUMN "token" text DEFAULT \'raw-secret-token\''
    );
    expect(output).toContain('"defaultChanged": true');
    expect(output).not.toContain('raw-secret-token');
  });

  it('splits multi-action alter-column operations into PostgreSQL-valid statements', async () => {
    const client = { query: vi.fn().mockResolvedValue(undefined) };
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: typeof client) => Promise<void>) => callback(client)),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'alter_table',
      schema: 'app',
      tableName: 'settings',
      operations: [
        {
          type: 'alter',
          columnName: 'value',
          dataType: 'text',
          nullable: false,
          default: "'pending'"
        }
      ]
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(client.query).toHaveBeenNthCalledWith(1, 'ALTER TABLE "app"."settings" ALTER COLUMN "value" TYPE text');
    expect(client.query).toHaveBeenNthCalledWith(2, 'ALTER TABLE "app"."settings" ALTER COLUMN "value" SET NOT NULL');
    expect(client.query).toHaveBeenNthCalledWith(3, 'ALTER TABLE "app"."settings" ALTER COLUMN "value" SET DEFAULT \'pending\'');
  });

  it('does not echo enum values in create-enum success responses', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_enum',
      schema: 'app',
      enumName: 'token_state',
      values: ['raw-secret-token']
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(
      'CREATE TYPE "app"."token_state" AS ENUM (\'raw-secret-token\');'
    );
    expect(output).toContain('"valueCount": 1');
    expect(output).not.toContain('raw-secret-token');
  });

  it('gets enums as text arrays for stable pg decoding', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([
        {
          enum_schema: 'app',
          enum_name: 'status',
          enum_values: ['active', "owner's"]
        }
      ]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'get_enums',
      schema: 'app',
      enumName: 'status'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('array_agg(e.enumlabel::text ORDER BY e.enumsortorder)'), ['app', 'status']);
    expect(output).toContain('"enum_values": [');
    expect(output).toContain('"active"');
  });

  it('sanitizes schema database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed near DEFAULT 'raw-secret-token'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_table',
      schema: 'app',
      tableName: 'tokens',
      columns: [
        { name: 'token', type: 'text', default: "'raw-secret-token'" }
      ]
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to create table');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("DEFAULT '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-secret-token');
  });

  it('rejects unsafe schema identifiers before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_table',
      tableName: 'users; drop table users',
      columns: [{ name: 'id', type: 'integer' }]
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe data types before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_table',
      tableName: 'users',
      columns: [{ name: 'id', type: 'integer; drop schema public' }]
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid PostgreSQL data type');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe alter-table data types before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'alter_table',
      tableName: 'users',
      operations: [
        { type: 'add', columnName: 'nickname', dataType: 'text; drop schema public' }
      ]
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid PostgreSQL data type');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('rejects unsafe enum identifiers before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageSchemaTools.execute({
      operation: 'create_enum',
      enumName: 'state; drop type state',
      values: ['active']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
