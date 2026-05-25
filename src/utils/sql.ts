const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOLLAR_QUOTE_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*\$/;
const READ_ONLY_START_PATTERN = /^(select|with|values|table)\b/i;
const DATA_CHANGING_SQL_PATTERN = /\b(insert|update|delete|merge|call|create|alter|drop|truncate|grant|revoke|vacuum|copy)\b/i;

export type SqlScalar = string | number | boolean | null;

export type WhereOperator =
  | { eq: SqlScalar }
  | { ne: SqlScalar }
  | { gt: SqlScalar }
  | { gte: SqlScalar }
  | { lt: SqlScalar }
  | { lte: SqlScalar }
  | { like: string }
  | { ilike: string }
  | { in: SqlScalar[] }
  | { isNull: boolean };

export type WherePredicate = Record<string, SqlScalar | WhereOperator>;

interface WhereClauseResult {
  clause: string;
  values: unknown[];
}

export function quoteIdent(identifier: string): string {
  if (!SIMPLE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Invalid SQL identifier "${identifier}". Use simple unquoted PostgreSQL identifiers only.`);
  }

  return `"${identifier}"`;
}

export function quoteQualifiedIdent(identifier: string, schema = 'public'): string {
  if (!schema || schema === 'public') {
    return quoteIdent(identifier);
  }

  return `${quoteIdent(schema)}.${quoteIdent(identifier)}`;
}

function dollarQuoteSqlBlock(sql: string, baseTag: string): string {
  let tag = baseTag;
  let delimiter = `$${tag}$`;
  let counter = 0;

  while (sql.includes(delimiter)) {
    counter += 1;
    tag = `${baseTag}_${counter}`;
    delimiter = `$${tag}$`;
  }

  return `${delimiter}\n${sql}\n${delimiter}`;
}

export function quoteLiteral(value: SqlScalar): string {
  if (value === null) {
    return 'NULL';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Invalid SQL numeric literal.');
    }
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }

  return `'${value.replace(/'/g, "''")}'`;
}

export function buildCreateEnumTypeSql(
  enumName: string,
  values: string[],
  schema = 'public',
  ifNotExists = false
): string {
  if (values.length === 0) {
    throw new Error('ENUM values must include at least one value.');
  }

  const fullEnumName = quoteQualifiedIdent(enumName, schema);
  const valueLiterals = values.map(quoteLiteral).join(', ');
  const createTypeSql = `CREATE TYPE ${fullEnumName} AS ENUM (${valueLiterals});`;

  if (!ifNotExists) {
    return createTypeSql;
  }

  return `DO ${dollarQuoteSqlBlock(`BEGIN\n  ${createTypeSql}\nEXCEPTION\n  WHEN duplicate_object THEN NULL;\nEND`, 'postgres_mcp_enum')};`;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return !!character && /[A-Za-z0-9_$]/.test(character);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function redactSqlText(sql: string, maxLength = 500): string {
  let redacted = '';
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-') {
      const newlineIndex = sql.indexOf('\n', index + 2);
      redacted += '-- redacted comment';
      if (newlineIndex === -1) {
        break;
      }
      redacted += '\n';
      index = newlineIndex + 1;
      continue;
    }

    if (character === '/' && next === '*') {
      const commentEnd = sql.indexOf('*/', index + 2);
      redacted += '/* redacted comment */';
      index = commentEnd === -1 ? sql.length : commentEnd + 2;
      continue;
    }

    if (character === "'") {
      redacted += "'?'";
      index++;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          index++;
          break;
        }
        index++;
      }
      continue;
    }

    if (character === '$') {
      const dollarQuote = sql.slice(index).match(DOLLAR_QUOTE_PATTERN);
      const delimiter = dollarQuote?.[0] || (next === '$' ? '$$' : undefined);
      if (delimiter) {
        const bodyStart = index + delimiter.length;
        const bodyEnd = sql.indexOf(delimiter, bodyStart);
        redacted += `${delimiter}?${delimiter}`;
        index = bodyEnd === -1 ? sql.length : bodyEnd + delimiter.length;
        continue;
      }
    }

    if (
      /[0-9]/.test(character) &&
      !isIdentifierCharacter(sql[index - 1])
    ) {
      let numberEnd = index + 1;
      while (numberEnd < sql.length && /[0-9._eE+-]/.test(sql[numberEnd])) {
        numberEnd++;
      }

      if (!isIdentifierCharacter(sql[numberEnd])) {
        redacted += '?';
        index = numberEnd;
        continue;
      }
    }

    redacted += character;
    index++;
  }

  return truncateText(redacted, maxLength);
}

function maskSqlForKeywordScan(sql: string): string {
  let masked = '';
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === '-' && next === '-') {
      const newlineIndex = sql.indexOf('\n', index + 2);
      if (newlineIndex === -1) {
        break;
      }
      masked += '\n';
      index = newlineIndex + 1;
      continue;
    }

    if (character === '/' && next === '*') {
      const commentEnd = sql.indexOf('*/', index + 2);
      index = commentEnd === -1 ? sql.length : commentEnd + 2;
      masked += ' ';
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      masked += ' ';
      index++;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }

    if (character === '$') {
      const dollarQuote = sql.slice(index).match(DOLLAR_QUOTE_PATTERN);
      const delimiter = dollarQuote?.[0] || (next === '$' ? '$$' : undefined);
      if (delimiter) {
        const bodyStart = index + delimiter.length;
        const bodyEnd = sql.indexOf(delimiter, bodyStart);
        masked += ' ';
        index = bodyEnd === -1 ? sql.length : bodyEnd + delimiter.length;
        continue;
      }
    }

    masked += character;
    index++;
  }

  return masked;
}

export function hasSqlStatementSeparator(sql: string): boolean {
  const normalizedQuery = sql.trim();
  const withoutTrailingSemicolon = normalizedQuery.replace(/;\s*$/, '');
  return maskSqlForKeywordScan(withoutTrailingSemicolon).includes(';');
}

export function getReadOnlySqlValidationError(sql: string): string | undefined {
  const normalizedQuery = sql.trim();
  if (!normalizedQuery) {
    return 'query parameter is required';
  }

  const withoutTrailingSemicolon = normalizedQuery.replace(/;\s*$/, '');
  const keywordScanSql = maskSqlForKeywordScan(withoutTrailingSemicolon);
  if (hasSqlStatementSeparator(normalizedQuery)) {
    return 'query must contain exactly one statement without semicolons';
  }

  if (!READ_ONLY_START_PATTERN.test(withoutTrailingSemicolon)) {
    return 'query is limited to read-only SELECT, WITH, VALUES, or TABLE statements';
  }

  const dataChangingKeyword = keywordScanSql.match(DATA_CHANGING_SQL_PATTERN)?.[1];
  if (dataChangingKeyword) {
    return `query contains data-changing SQL keyword "${dataChangingKeyword.toUpperCase()}"`;
  }

  return undefined;
}

export function normalizeReturningColumns(returning?: string | string[]): string[] | undefined {
  if (!returning) {
    return undefined;
  }

  if (Array.isArray(returning)) {
    return returning;
  }

  if (returning.trim() === '*') {
    return ['*'];
  }

  return returning.split(',').map((column) => column.trim()).filter(Boolean);
}

export function buildReturningClause(returning?: string | string[]): string {
  const columns = normalizeReturningColumns(returning);
  if (!columns || columns.length === 0) {
    return '';
  }

  if (columns.length === 1 && columns[0] === '*') {
    return ' RETURNING *';
  }

  return ` RETURNING ${columns.map(quoteIdent).join(', ')}`;
}

function isOperatorPredicate(value: SqlScalar | WhereOperator): value is WhereOperator {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendComparison(
  clauses: string[],
  values: unknown[],
  column: string,
  operator: string,
  value: SqlScalar,
  nextPlaceholder: () => string
): void {
  if (value === null && operator === '=') {
    clauses.push(`${quoteIdent(column)} IS NULL`);
    return;
  }

  if (value === null && operator === '<>') {
    clauses.push(`${quoteIdent(column)} IS NOT NULL`);
    return;
  }

  values.push(value);
  clauses.push(`${quoteIdent(column)} ${operator} ${nextPlaceholder()}`);
}

export function buildWhereClause(where: WherePredicate, startingPlaceholder = 1): WhereClauseResult {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let placeholderIndex = startingPlaceholder;
  const nextPlaceholder = () => `$${placeholderIndex++}`;

  for (const [column, predicate] of Object.entries(where)) {
    if (!isOperatorPredicate(predicate)) {
      appendComparison(clauses, values, column, '=', predicate, nextPlaceholder);
      continue;
    }

    const entries = Object.entries(predicate);
    if (entries.length !== 1) {
      throw new Error(`Where predicate for "${column}" must specify exactly one operator.`);
    }

    const [operator, value] = entries[0];

    switch (operator) {
      case 'eq':
        appendComparison(clauses, values, column, '=', value as SqlScalar, nextPlaceholder);
        break;
      case 'ne':
        appendComparison(clauses, values, column, '<>', value as SqlScalar, nextPlaceholder);
        break;
      case 'gt':
        appendComparison(clauses, values, column, '>', value as SqlScalar, nextPlaceholder);
        break;
      case 'gte':
        appendComparison(clauses, values, column, '>=', value as SqlScalar, nextPlaceholder);
        break;
      case 'lt':
        appendComparison(clauses, values, column, '<', value as SqlScalar, nextPlaceholder);
        break;
      case 'lte':
        appendComparison(clauses, values, column, '<=', value as SqlScalar, nextPlaceholder);
        break;
      case 'like':
        appendComparison(clauses, values, column, 'LIKE', value as string, nextPlaceholder);
        break;
      case 'ilike':
        appendComparison(clauses, values, column, 'ILIKE', value as string, nextPlaceholder);
        break;
      case 'in': {
        const items = value as SqlScalar[];
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error(`Where predicate "in" for "${column}" must contain at least one value.`);
        }
        const placeholders = items.map(() => nextPlaceholder());
        values.push(...items);
        clauses.push(`${quoteIdent(column)} IN (${placeholders.join(', ')})`);
        break;
      }
      case 'isNull':
        clauses.push(`${quoteIdent(column)} IS ${value ? '' : 'NOT '}NULL`);
        break;
      default:
        throw new Error(`Unsupported where operator "${operator}" for "${column}".`);
    }
  }

  if (clauses.length === 0) {
    throw new Error('Where predicate must include at least one column.');
  }

  return {
    clause: clauses.join(' AND '),
    values
  };
}

function buildStaticComparison(column: string, operator: string, value: SqlScalar): string {
  if (value === null && operator === '=') {
    return `${quoteIdent(column)} IS NULL`;
  }

  if (value === null && operator === '<>') {
    return `${quoteIdent(column)} IS NOT NULL`;
  }

  return `${quoteIdent(column)} ${operator} ${quoteLiteral(value)}`;
}

export function buildStaticWhereClause(where: WherePredicate): string {
  const clauses: string[] = [];

  for (const [column, predicate] of Object.entries(where)) {
    if (!isOperatorPredicate(predicate)) {
      clauses.push(buildStaticComparison(column, '=', predicate));
      continue;
    }

    const entries = Object.entries(predicate);
    if (entries.length !== 1) {
      throw new Error(`Where predicate for "${column}" must specify exactly one operator.`);
    }

    const [operator, value] = entries[0];

    switch (operator) {
      case 'eq':
        clauses.push(buildStaticComparison(column, '=', value as SqlScalar));
        break;
      case 'ne':
        clauses.push(buildStaticComparison(column, '<>', value as SqlScalar));
        break;
      case 'gt':
        clauses.push(buildStaticComparison(column, '>', value as SqlScalar));
        break;
      case 'gte':
        clauses.push(buildStaticComparison(column, '>=', value as SqlScalar));
        break;
      case 'lt':
        clauses.push(buildStaticComparison(column, '<', value as SqlScalar));
        break;
      case 'lte':
        clauses.push(buildStaticComparison(column, '<=', value as SqlScalar));
        break;
      case 'like':
        clauses.push(buildStaticComparison(column, 'LIKE', value as string));
        break;
      case 'ilike':
        clauses.push(buildStaticComparison(column, 'ILIKE', value as string));
        break;
      case 'in': {
        const items = value as SqlScalar[];
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error(`Where predicate "in" for "${column}" must contain at least one value.`);
        }
        clauses.push(`${quoteIdent(column)} IN (${items.map(quoteLiteral).join(', ')})`);
        break;
      }
      case 'isNull':
        clauses.push(`${quoteIdent(column)} IS ${value ? '' : 'NOT '}NULL`);
        break;
      default:
        throw new Error(`Unsupported where operator "${operator}" for "${column}".`);
    }
  }

  if (clauses.length === 0) {
    throw new Error('Where predicate must include at least one column.');
  }

  return clauses.join(' AND ');
}
