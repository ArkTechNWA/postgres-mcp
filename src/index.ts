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
// TOOLS: Schema Deep Dive (v0.2.0)
// ============================================================================

server.tool(
  "pg_indexes",
  "Get index information for tables",
  {
    table: z.string().optional().describe("Table name (optional - all tables if omitted)"),
    schema: z.string().optional().describe("Schema name (default: public)"),
  },
  async ({ table, schema = "public" }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    // Check table blacklist if specified
    if (table && matchesBlacklist(table, config.safety.blacklist_tables)) {
      return { content: [{ type: "text", text: `Permission denied: ${table} is blacklisted` }] };
    }

    try {
      let query = `
        SELECT
          i.schemaname as schema,
          i.tablename as table_name,
          i.indexname as index_name,
          i.indexdef as definition,
          pg_relation_size(c.oid) as size_bytes,
          idx.indisunique as is_unique,
          idx.indisprimary as is_primary,
          am.amname as index_type
        FROM pg_indexes i
        JOIN pg_class c ON c.relname = i.indexname
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
        JOIN pg_index idx ON idx.indexrelid = c.oid
        JOIN pg_am am ON am.oid = c.relam
        WHERE i.schemaname = $1
      `;

      const params: unknown[] = [schema];

      if (table) {
        query += ` AND i.tablename = $2`;
        params.push(table);
      }

      query += ` ORDER BY i.tablename, i.indexname`;

      const result = await safeQuery(query, params, { maxRows: 500 });

      const indexes = result.rows
        .filter((row) => !matchesBlacklist(row.table_name as string, config.safety.blacklist_tables))
        .map((row) => ({
          schema: row.schema,
          table: row.table_name,
          name: row.index_name,
          type: row.index_type,
          is_unique: row.is_unique,
          is_primary: row.is_primary,
          size: formatBytes(row.size_bytes as number | null),
          definition: row.definition,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                schema,
                table: table || "all",
                indexes,
                count: indexes.length,
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
  "pg_constraints",
  "Get constraint information (PK, FK, unique, check)",
  {
    table: z.string().optional().describe("Table name (optional - all tables if omitted)"),
    schema: z.string().optional().describe("Schema name (default: public)"),
    type: z.enum(["PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CHECK"]).optional().describe("Constraint type filter"),
  },
  async ({ table, schema = "public", type }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    // Check table blacklist if specified
    if (table && matchesBlacklist(table, config.safety.blacklist_tables)) {
      return { content: [{ type: "text", text: `Permission denied: ${table} is blacklisted` }] };
    }

    try {
      let query = `
        SELECT
          tc.table_schema as schema,
          tc.table_name,
          tc.constraint_name,
          tc.constraint_type,
          kcu.column_name,
          ccu.table_name as foreign_table_name,
          ccu.column_name as foreign_column_name,
          cc.check_clause
        FROM information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
          AND tc.constraint_type = 'FOREIGN KEY'
        LEFT JOIN information_schema.check_constraints cc
          ON tc.constraint_name = cc.constraint_name
          AND tc.table_schema = cc.constraint_schema
        WHERE tc.table_schema = $1
      `;

      const params: unknown[] = [schema];
      let paramIndex = 2;

      if (table) {
        query += ` AND tc.table_name = $${paramIndex}`;
        params.push(table);
        paramIndex++;
      }

      if (type) {
        query += ` AND tc.constraint_type = $${paramIndex}`;
        params.push(type);
      }

      query += ` ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name`;

      const result = await safeQuery(query, params, { maxRows: 500 });

      // Group constraints by name (multiple rows for multi-column constraints)
      const constraintMap = new Map<string, {
        schema: string;
        table: string;
        name: string;
        type: string;
        columns: string[];
        foreign_table?: string;
        foreign_columns?: string[];
        check_clause?: string;
      }>();

      for (const row of result.rows) {
        if (matchesBlacklist(row.table_name as string, config.safety.blacklist_tables)) continue;

        const key = `${row.table_name}.${row.constraint_name}`;
        if (!constraintMap.has(key)) {
          constraintMap.set(key, {
            schema: row.schema as string,
            table: row.table_name as string,
            name: row.constraint_name as string,
            type: row.constraint_type as string,
            columns: [],
            foreign_table: row.foreign_table_name as string | undefined,
            foreign_columns: [],
            check_clause: row.check_clause as string | undefined,
          });
        }

        const constraint = constraintMap.get(key)!;
        if (row.column_name && !constraint.columns.includes(row.column_name as string)) {
          constraint.columns.push(row.column_name as string);
        }
        if (row.foreign_column_name && !constraint.foreign_columns?.includes(row.foreign_column_name as string)) {
          constraint.foreign_columns?.push(row.foreign_column_name as string);
        }
      }

      const constraints = Array.from(constraintMap.values()).map((c) => {
        const result: Record<string, unknown> = {
          schema: c.schema,
          table: c.table,
          name: c.name,
          type: c.type,
          columns: c.columns,
        };

        if (c.type === "FOREIGN KEY" && c.foreign_table) {
          result.references = {
            table: c.foreign_table,
            columns: c.foreign_columns,
          };
        }

        if (c.type === "CHECK" && c.check_clause) {
          result.check_clause = c.check_clause;
        }

        return result;
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                schema,
                table: table || "all",
                type: type || "all",
                constraints,
                count: constraints.length,
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
  "pg_explain",
  "Get query execution plan (EXPLAIN)",
  {
    query: z.string().describe("SQL query to explain"),
    params: z.array(z.unknown()).optional().describe("Query parameters ($1, $2, etc)"),
    analyze: z.boolean().optional().describe("Actually execute the query (careful with writes!)"),
    format: z.enum(["text", "json"]).optional().describe("Output format (default: json)"),
  },
  async ({ query, params, analyze = false, format = "json" }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    // If analyze is true and query is not SELECT, require write permission
    const upperQuery = query.toUpperCase().trim();
    if (analyze && !upperQuery.startsWith("SELECT") && !upperQuery.startsWith("WITH")) {
      if (!config.permissions.write) {
        return {
          content: [{ type: "text", text: "Permission denied: ANALYZE on write queries requires write permission" }],
        };
      }
    }

    // Check for blocked patterns
    const blocked = containsBlockedPattern(query, config.safety.blocked_patterns);
    if (blocked) {
      return { content: [{ type: "text", text: `Blocked pattern detected: ${blocked}` }] };
    }

    try {
      const explainQuery = `EXPLAIN (FORMAT ${format.toUpperCase()}${analyze ? ", ANALYZE" : ""}) ${query}`;

      const start = Date.now();
      const client = await pool.connect();

      try {
        const result = await withTimeout(
          client.query(explainQuery, params),
          config.neverhang.query_timeout,
          "EXPLAIN timed out"
        );

        const duration = Date.now() - start;

        if (format === "json") {
          const plan = result.rows[0]["QUERY PLAN"];

          // Extract key metrics from the plan
          const topNode = Array.isArray(plan) ? plan[0].Plan : plan.Plan;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    query: query.slice(0, 200) + (query.length > 200 ? "..." : ""),
                    analyzed: analyze,
                    plan: {
                      node_type: topNode["Node Type"],
                      startup_cost: topNode["Startup Cost"],
                      total_cost: topNode["Total Cost"],
                      plan_rows: topNode["Plan Rows"],
                      plan_width: topNode["Plan Width"],
                      ...(analyze && {
                        actual_rows: topNode["Actual Rows"],
                        actual_loops: topNode["Actual Loops"],
                        actual_time: topNode["Actual Total Time"],
                      }),
                    },
                    full_plan: plan,
                    execution_time: formatDuration(duration),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          // Text format
          const planText = result.rows.map((r) => r["QUERY PLAN"]).join("\n");

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    query: query.slice(0, 200) + (query.length > 200 ? "..." : ""),
                    analyzed: analyze,
                    plan: planText,
                    execution_time: formatDuration(duration),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } finally {
        client.release();
      }
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
