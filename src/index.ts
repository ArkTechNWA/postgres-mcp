#!/usr/bin/env node
/**
 * postgres-mcp
 * MCP server for PostgreSQL integration
 *
 * @author Claude + MOD
 * @license MIT
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { loadConfig } from "./config.js";
import {
  withTimeout,
  formatBytes,
  formatRowCount,
  formatDuration,
  matchesBlacklist,
  containsBlockedPattern,
} from "./utils.js";

const { Pool } = pg;

// ============================================================================
// INITIALIZATION
// ============================================================================

const config = loadConfig();

const server = new McpServer({
  name: "postgres-mcp",
  version: "0.1.0",
});

// Initialize connection pool
const poolConfig: pg.PoolConfig = {
  host: config.connection.host,
  port: config.connection.port,
  database: config.connection.database,
  user: config.connection.user,
  password: config.connection.password,
  ssl: config.connection.ssl,
  connectionString: config.connection.connectionString,
  connectionTimeoutMillis: config.neverhang.connect_timeout,
  statement_timeout: config.safety.statement_timeout,
  max: 5,
};

const pool = new Pool(poolConfig);

// ============================================================================
// HELPER: Safe query execution
// ============================================================================

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  duration: number;
}

async function safeQuery(
  sql: string,
  params?: unknown[],
  options?: { maxRows?: number }
): Promise<QueryResult> {
  const maxRows = options?.maxRows ?? config.safety.max_rows;

  // Check for blocked patterns
  const blocked = containsBlockedPattern(sql, config.safety.blocked_patterns);
  if (blocked) {
    throw new Error(`Blocked pattern detected: ${blocked}`);
  }

  // Add LIMIT if not present and it's a SELECT
  let finalSql = sql;
  const upperSql = sql.toUpperCase().trim();
  if (upperSql.startsWith("SELECT") && !upperSql.includes(" LIMIT ")) {
    finalSql = `${sql} LIMIT ${maxRows}`;
  }

  const start = Date.now();
  const client = await pool.connect();

  try {
    const result = await withTimeout(
      client.query(finalSql, params),
      config.neverhang.query_timeout,
      "Query timed out"
    );

    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      duration: Date.now() - start,
    };
  } finally {
    client.release();
  }
}

// ============================================================================
// TOOLS: Query Execution
// ============================================================================

server.tool(
  "pg_query",
  "Execute a SELECT query with safety limits",
  {
    query: z.string().describe("SQL SELECT query"),
    params: z.array(z.unknown()).optional().describe("Query parameters ($1, $2, etc)"),
    max_rows: z.number().optional().describe("Override default row limit"),
  },
  async ({ query, params, max_rows }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    // Only allow SELECT for read permission
    const upperQuery = query.toUpperCase().trim();
    if (!upperQuery.startsWith("SELECT") && !upperQuery.startsWith("WITH")) {
      return {
        content: [{ type: "text", text: "Permission denied: only SELECT queries allowed with read permission" }],
      };
    }

    try {
      const result = await safeQuery(query, params, { maxRows: max_rows });

      // Filter out blacklisted columns from results
      const filteredRows = result.rows.map((row) => {
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!matchesBlacklist(key, config.safety.blacklist_columns)) {
            filtered[key] = value;
          }
        }
        return filtered;
      });

      const truncated = result.rowCount > (max_rows ?? config.safety.max_rows);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: query.slice(0, 200) + (query.length > 200 ? "..." : ""),
                rows: filteredRows,
                row_count: result.rowCount,
                execution_time: formatDuration(result.duration),
                truncated,
                max_rows: max_rows ?? config.safety.max_rows,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown"}` }],
      };
    }
  }
);

// ============================================================================
// TOOLS: Schema Introspection
// ============================================================================

server.tool(
  "pg_tables",
  "List tables with metadata",
  {
    schema: z.string().optional().describe("Schema name (default: public)"),
    pattern: z.string().optional().describe("Table name pattern (LIKE syntax)"),
  },
  async ({ schema = "public", pattern }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    try {
      let query = `
        SELECT
          t.table_schema,
          t.table_name,
          t.table_type,
          pg_catalog.obj_description(pgc.oid, 'pg_class') as description,
          pg_catalog.pg_table_size(pgc.oid) as size_bytes,
          COALESCE(s.n_live_tup, 0) as row_estimate
        FROM information_schema.tables t
        LEFT JOIN pg_catalog.pg_class pgc
          ON pgc.relname = t.table_name
          AND pgc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
        LEFT JOIN pg_stat_user_tables s
          ON s.schemaname = t.table_schema AND s.relname = t.table_name
        WHERE t.table_schema = $1
      `;

      const params: unknown[] = [schema];

      if (pattern) {
        query += ` AND t.table_name LIKE $2`;
        params.push(pattern);
      }

      query += ` ORDER BY t.table_name`;

      const result = await safeQuery(query, params, { maxRows: 500 });

      const tables = result.rows
        .filter((row) => !matchesBlacklist(row.table_name as string, config.safety.blacklist_tables))
        .map((row) => ({
          schema: row.table_schema,
          name: row.table_name,
          type: row.table_type === "BASE TABLE" ? "table" : row.table_type?.toString().toLowerCase(),
          description: row.description || null,
          size: formatBytes(row.size_bytes as number),
          size_bytes: row.size_bytes,
          row_estimate: formatRowCount(row.row_estimate as number),
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                schema,
                tables,
                count: tables.length,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown"}` }],
      };
    }
  }
);

server.tool(
  "pg_columns",
  "Get column information for a table",
  {
    table: z.string().describe("Table name"),
    schema: z.string().optional().describe("Schema name (default: public)"),
  },
  async ({ table, schema = "public" }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    // Check table blacklist
    if (matchesBlacklist(table, config.safety.blacklist_tables)) {
      return { content: [{ type: "text", text: `Permission denied: ${table} is blacklisted` }] };
    }

    try {
      const query = `
        SELECT
          c.column_name,
          c.data_type,
          c.character_maximum_length,
          c.numeric_precision,
          c.is_nullable,
          c.column_default,
          col_description(
            (SELECT oid FROM pg_class WHERE relname = c.table_name AND relnamespace = (
              SELECT oid FROM pg_namespace WHERE nspname = c.table_schema
            )),
            c.ordinal_position
          ) as description,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
          CASE WHEN uq.column_name IS NOT NULL THEN true ELSE false END as is_unique
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name, ku.table_name, ku.table_schema
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
        ) pk ON pk.column_name = c.column_name
          AND pk.table_name = c.table_name
          AND pk.table_schema = c.table_schema
        LEFT JOIN (
          SELECT ku.column_name, ku.table_name, ku.table_schema
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'UNIQUE'
        ) uq ON uq.column_name = c.column_name
          AND uq.table_name = c.table_name
          AND uq.table_schema = c.table_schema
        WHERE c.table_name = $1 AND c.table_schema = $2
        ORDER BY c.ordinal_position
      `;

      const result = await safeQuery(query, [table, schema], { maxRows: 500 });

      const columns = result.rows.map((row) => {
        const isBlacklisted = matchesBlacklist(row.column_name as string, config.safety.blacklist_columns);

        let dataType = row.data_type as string;
        if (row.character_maximum_length) {
          dataType += `(${row.character_maximum_length})`;
        } else if (row.numeric_precision) {
          dataType += `(${row.numeric_precision})`;
        }

        return {
          name: row.column_name,
          type: dataType,
          nullable: row.is_nullable === "YES",
          default: row.column_default,
          description: row.description || null,
          primary_key: row.is_primary_key,
          unique: row.is_unique,
          redacted: isBlacklisted,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                schema,
                table,
                columns,
                count: columns.length,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown"}` }],
      };
    }
  }
);

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[postgres-mcp] Running on stdio");
  console.error(`[postgres-mcp] Permissions: read=${config.permissions.read}, write=${config.permissions.write}`);
  console.error(`[postgres-mcp] Safety: max_rows=${config.safety.max_rows}, timeout=${config.safety.statement_timeout}ms`);
  console.error(`[postgres-mcp] Database: ${config.connection.host}:${config.connection.port}/${config.connection.database}`);
}

main().catch((error) => {
  console.error("[postgres-mcp] Fatal error:", error);
  process.exit(1);
});

// Cleanup on exit
process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
