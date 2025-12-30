/**
 * postgres-mcp configuration
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface Config {
  connection: {
    host: string;
    port: number;
    database: string;
    user?: string;
    password?: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    connectionString?: string;
  };
  permissions: {
    read: boolean;
    write: boolean;
    ddl: boolean;
  };
  safety: {
    statement_timeout: number;  // ms
    max_rows: number;
    blacklist_tables: string[];
    blacklist_columns: string[];
    require_where: boolean;
    blocked_patterns: string[];
  };
  neverhang: {
    connect_timeout: number;
    query_timeout: number;
  };
}

const DEFAULT_CONFIG: Config = {
  connection: {
    host: "localhost",
    port: 5432,
    database: "postgres",
  },
  permissions: {
    read: true,
    write: false,
    ddl: false,
  },
  safety: {
    statement_timeout: 30000,
    max_rows: 1000,
    blacklist_tables: [],
    blacklist_columns: ["password", "password_hash", "secret", "token", "api_key"],
    require_where: true,
    blocked_patterns: [
      "DROP DATABASE",
      "DROP SCHEMA",
      "TRUNCATE",
    ],
  },
  neverhang: {
    connect_timeout: 10000,
    query_timeout: 30000,
  },
};

export function loadConfig(): Config {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;

  // Try loading from file
  const configPaths = [
    join(process.cwd(), "postgres-mcp.json"),
    join(process.cwd(), ".postgres-mcp.json"),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
        deepMerge(config as unknown as Record<string, unknown>, fileConfig);
        console.error(`[postgres-mcp] Loaded config from ${configPath}`);
        break;
      } catch (error) {
        console.error(`[postgres-mcp] Warning: Failed to parse ${configPath}`);
      }
    }
  }

  // Environment overrides
  if (process.env.PGHOST) config.connection.host = process.env.PGHOST;
  if (process.env.PGPORT) config.connection.port = parseInt(process.env.PGPORT);
  if (process.env.PGDATABASE) config.connection.database = process.env.PGDATABASE;
  if (process.env.PGUSER) config.connection.user = process.env.PGUSER;
  if (process.env.PGPASSWORD) config.connection.password = process.env.PGPASSWORD;
  if (process.env.DATABASE_URL) config.connection.connectionString = process.env.DATABASE_URL;

  if (process.env.PG_MCP_WRITE === "true") config.permissions.write = true;
  if (process.env.PG_MCP_DDL === "true") config.permissions.ddl = true;
  if (process.env.PG_MCP_MAX_ROWS) config.safety.max_rows = parseInt(process.env.PG_MCP_MAX_ROWS);
  if (process.env.PG_MCP_TIMEOUT) config.safety.statement_timeout = parseInt(process.env.PG_MCP_TIMEOUT);

  return config;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = source[key];
    }
  }
}
