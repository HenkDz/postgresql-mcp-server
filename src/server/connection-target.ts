export interface ConnectionTarget {
  host: string;
  port?: string;
  database?: string;
  user?: string;
}

export interface AllowedConnectionTarget {
  host: string;
  port?: string;
  database?: string;
  user?: string;
  source: string;
}

function hasPartialWildcard(value: string): boolean {
  return value.includes('*') && value !== '*';
}

function normalizeOptionalPatternComponent(
  label: string,
  value: string | undefined,
  source: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === '') {
    throw new Error(`Invalid allowed connection target "${source}": ${label} must not be empty.`);
  }

  if (hasPartialWildcard(value)) {
    throw new Error(`Invalid allowed connection target "${source}": ${label} only supports "*" as a full-field wildcard.`);
  }

  return value;
}

function normalizePortPattern(port: string | undefined, source: string): string | undefined {
  const normalized = normalizeOptionalPatternComponent('port', port, source);
  if (normalized === undefined || normalized === '*') {
    return normalized;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid allowed connection target "${source}": port must be "*" or an integer from 1 to 65535.`);
  }

  return normalized;
}

function normalizeConnectionHost(host: string): string {
  const decoded = decodeURIComponent(host);
  return (decoded.startsWith('[') && decoded.endsWith(']') ? decoded.slice(1, -1) : decoded).toLowerCase();
}

function splitHostAndPort(hostPort: string, source: string): { host: string; port?: string } {
  if (hostPort.startsWith('[')) {
    const closingBracket = hostPort.indexOf(']');
    if (closingBracket <= 1) {
      throw new Error(`Invalid allowed connection target "${source}": bracketed IPv6 host is malformed.`);
    }

    const host = hostPort.slice(1, closingBracket);
    const rest = hostPort.slice(closingBracket + 1);
    if (rest === '') {
      return { host };
    }
    if (!rest.startsWith(':')) {
      throw new Error(`Invalid allowed connection target "${source}": unexpected text after bracketed host.`);
    }
    return { host, port: rest.slice(1) };
  }

  const colonCount = [...hostPort].filter((char) => char === ':').length;
  if (colonCount > 1) {
    throw new Error(`Invalid allowed connection target "${source}": IPv6 hosts must use bracket notation.`);
  }

  const colonIndex = hostPort.lastIndexOf(':');
  if (colonIndex === -1) {
    return { host: hostPort };
  }

  return {
    host: hostPort.slice(0, colonIndex),
    port: hostPort.slice(colonIndex + 1)
  };
}

export function parseAllowedConnectionTarget(source: string): AllowedConnectionTarget {
  const trimmed = source.trim();
  if (trimmed === '') {
    throw new Error('Allowed connection target entries must be non-empty strings.');
  }

  const slashIndex = trimmed.indexOf('/');
  const targetWithoutDatabase = slashIndex === -1 ? trimmed : trimmed.slice(0, slashIndex);
  const database = slashIndex === -1 ? undefined : trimmed.slice(slashIndex + 1);

  if (database?.includes('/')) {
    throw new Error(`Invalid allowed connection target "${trimmed}": database must not contain "/".`);
  }

  const atIndex = targetWithoutDatabase.lastIndexOf('@');
  const user = atIndex === -1 ? undefined : targetWithoutDatabase.slice(0, atIndex);
  const hostPort = atIndex === -1 ? targetWithoutDatabase : targetWithoutDatabase.slice(atIndex + 1);
  const { host, port } = splitHostAndPort(hostPort, trimmed);
  const normalizedHost = normalizeOptionalPatternComponent('host', host, trimmed);

  if (normalizedHost === undefined) {
    throw new Error(`Invalid allowed connection target "${trimmed}": host is required.`);
  }

  return {
    source: trimmed,
    user: normalizeOptionalPatternComponent('user', user, trimmed),
    host: normalizedHost === '*' ? '*' : normalizedHost.toLowerCase(),
    port: normalizePortPattern(port, trimmed),
    database: normalizeOptionalPatternComponent('database', database, trimmed)
  };
}

export function parseAllowedConnectionTargetList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.split(',').map((entry) => {
    const trimmed = entry.trim();
    if (trimmed === '') {
      throw new Error('POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS must not contain empty entries.');
    }
    return trimmed;
  });
}

export function normalizeAllowedConnectionTargets(
  targets: string[] | undefined
): AllowedConnectionTarget[] | undefined {
  if (targets === undefined) {
    return undefined;
  }

  return targets.map(parseAllowedConnectionTarget);
}

function parseKeywordConnectionString(connectionString: string): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  let index = 0;

  while (index < connectionString.length) {
    while (connectionString[index] === ' ' || connectionString[index] === '\t' || connectionString[index] === '\n') {
      index += 1;
    }
    if (index >= connectionString.length) {
      break;
    }

    const keyStart = index;
    while (index < connectionString.length && connectionString[index] !== '=' && !/\s/.test(connectionString[index])) {
      index += 1;
    }
    const key = connectionString.slice(keyStart, index);
    if (key === '' || connectionString[index] !== '=') {
      return undefined;
    }
    index += 1;

    let value = '';
    if (connectionString[index] === "'") {
      index += 1;
      while (index < connectionString.length) {
        const char = connectionString[index];
        if (char === '\\' && index + 1 < connectionString.length) {
          value += connectionString[index + 1];
          index += 2;
          continue;
        }
        if (char === "'") {
          index += 1;
          break;
        }
        value += char;
        index += 1;
      }
    } else {
      const valueStart = index;
      while (index < connectionString.length && !/\s/.test(connectionString[index])) {
        index += 1;
      }
      value = connectionString.slice(valueStart, index);
    }

    fields[key.toLowerCase()] = value;
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

export function parseConnectionTarget(connectionString: string): ConnectionTarget {
  if (connectionString.trim() === '') {
    throw new Error('Connection string must be a non-empty string.');
  }

  try {
    const parsed = new URL(connectionString);
    if (parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:') {
      if (!parsed.hostname) {
        throw new Error('Connection target allowlist requires URL connection strings to include an explicit host.');
      }

      return {
        host: normalizeConnectionHost(parsed.hostname),
        port: parsed.port || undefined,
        database: parsed.pathname && parsed.pathname !== '/' ? decodeURIComponent(parsed.pathname.slice(1)) : undefined,
        user: parsed.username ? decodeURIComponent(parsed.username) : undefined
      };
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('allowlist requires')) {
      throw error;
    }
  }

  const keywordFields = parseKeywordConnectionString(connectionString);
  if (keywordFields) {
    const host = keywordFields.host || keywordFields.hostaddr;
    if (!host) {
      throw new Error('Connection target allowlist requires keyword connection strings to include host or hostaddr.');
    }

    return {
      host: normalizeConnectionHost(host),
      port: keywordFields.port || undefined,
      database: keywordFields.dbname || keywordFields.database || undefined,
      user: keywordFields.user || undefined
    };
  }

  throw new Error('Connection target allowlist only supports PostgreSQL URL or keyword-style connection strings.');
}

function fieldMatches(pattern: string | undefined, value: string | undefined, caseInsensitive = false): boolean {
  if (pattern === undefined || pattern === '*') {
    return true;
  }

  if (value === undefined) {
    return false;
  }

  return caseInsensitive ? pattern.toLowerCase() === value.toLowerCase() : pattern === value;
}

export function isConnectionTargetAllowed(
  target: ConnectionTarget,
  allowedTargets: AllowedConnectionTarget[] | undefined
): boolean {
  if (allowedTargets === undefined) {
    return true;
  }

  return allowedTargets.some((allowedTarget) =>
    fieldMatches(allowedTarget.host, target.host, true) &&
    fieldMatches(allowedTarget.port, target.port) &&
    fieldMatches(allowedTarget.database, target.database) &&
    fieldMatches(allowedTarget.user, target.user)
  );
}

export function formatConnectionTarget(target: ConnectionTarget): string {
  const user = target.user ? `${target.user}@` : '';
  const port = target.port ? `:${target.port}` : '';
  const database = target.database ? `/${target.database}` : '';
  return `${user}${target.host}${port}${database}`;
}

export function assertConnectionTargetAllowed(
  connectionString: string,
  allowedTargets: AllowedConnectionTarget[] | undefined
): void {
  if (allowedTargets === undefined) {
    return;
  }

  if (allowedTargets.length === 0) {
    throw new Error('Connection target allowlist is configured but contains no allowed entries.');
  }

  const target = parseConnectionTarget(connectionString);
  if (!isConnectionTargetAllowed(target, allowedTargets)) {
    throw new Error(`Connection target "${formatConnectionTarget(target)}" is not allowed by the configured connection target allowlist.`);
  }
}
