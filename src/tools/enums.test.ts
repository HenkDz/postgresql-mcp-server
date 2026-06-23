import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import { createEnumTool, getEnumsTool } from './enums';

describe('legacy direct enum tools', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('gets enums with parameterized schema and enum filters', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getEnumsTool.execute({
      schema: 'app',
      enumName: 'status'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('AND t.typname = $2'), ['app', 'status']);
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('array_agg(e.enumlabel::text ORDER BY e.enumsortorder)'), ['app', 'status']);
  });

  it('creates enums with quoted schema and enum identifiers', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createEnumTool.execute({
      schema: 'app',
      enumName: 'status',
      values: ['active', "owner's"],
      ifNotExists: true
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    const sql = mockDb.query.mock.calls[0][0];
    expect(sql).toContain('DO $postgres_mcp_enum$');
    expect(sql).toContain('CREATE TYPE "app"."status" AS ENUM (\'active\', \'owner\'\'s\');');
    expect(sql).toContain('WHEN duplicate_object THEN NULL;');
    expect(sql).not.toContain('CREATE TYPE IF NOT EXISTS');
    expect(result.content.map((item) => item.text).join('\n')).toContain('"valueCount": 2');
    expect(result.content.map((item) => item.text).join('\n')).not.toContain("owner's");
  });

  it('creates enums with plain PostgreSQL DDL by default', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createEnumTool.execute({
      schema: 'app',
      enumName: 'status',
      values: ['active']
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('CREATE TYPE "app"."status" AS ENUM (\'active\');');
  });

  it('sanitizes enum database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed while creating ENUM value 'raw-enum-secret'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createEnumTool.execute({
      schema: 'app',
      enumName: 'status',
      values: ['raw-enum-secret']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to create ENUM');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("value '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-enum-secret');
  });

  it('rejects unsafe enum identifiers before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createEnumTool.execute({
      enumName: 'status; drop type status',
      values: ['active']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown get-enum fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getEnumsTool.execute({
      schema: 'app',
      rawSql: 'DROP TYPE status'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown create-enum fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createEnumTool.execute({
      enumName: 'status',
      values: ['active'],
      rawSql: 'DROP TYPE status'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe enum schemas before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createEnumTool.execute({
      schema: 'app; drop schema app',
      enumName: 'status',
      values: ['active']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
