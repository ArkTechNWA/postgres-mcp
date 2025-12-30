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
  truncate,
} from "./utils.js";
import { NeverhangManager, NeverhangError } from "./neverhang.js";

const { Pool } = pg;

// ============================================================================
// INITIALIZATION
// ============================================================================

const config = loadConfig();

const server = new McpServer({
  name: "postgres-mcp",
  version: "0.5.0",
});

// Initialize connection pool with NEVERHANG settings
const poolConfig: pg.PoolConfig = {
  host: config.connection.host,
  port: config.connection.port,
  database: config.connection.database,
  user: config.connection.user,
  password: config.connection.password,
  ssl: config.connection.ssl,
  connectionString: config.connection.connectionString,
  connectionTimeoutMillis: config.neverhang.connection_timeout_ms,
  statement_timeout: config.neverhang.base_timeout_ms,
  max: config.neverhang.max_connections,
  min: config.neverhang.min_connections,
  idleTimeoutMillis: config.neverhang.idle_timeout_ms,
};

const pool = new Pool(poolConfig);

// Initialize NEVERHANG manager with ping function
const neverhang = new NeverhangManager(config.neverhang, async () => {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
});

// ============================================================================
// HELPER: Safe query execution with NEVERHANG
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
  options?: { maxRows?: number; timeout_ms?: number }
): Promise<QueryResult> {
  const maxRows = options?.maxRows ?? config.safety.max_rows;
  const start = Date.now();

  // NEVERHANG: Circuit breaker check
  const canExecute = neverhang.canExecute();
  if (!canExecute.allowed) {
    throw new NeverhangError(
      "circuit_open",
      canExecute.reason || "Circuit breaker open",
      Date.now() - start
    );
  }

  // Check for blocked patterns
  const blocked = containsBlockedPattern(sql, config.safety.blocked_patterns);
  if (blocked) {
    throw new NeverhangError(
      "permission_denied",
      `Blocked pattern detected: ${blocked}`,
      Date.now() - start
    );
  }

  // NEVERHANG: Get adaptive timeout
  const { timeout_ms, reason: timeoutReason } = neverhang.getTimeout(sql, options?.timeout_ms);

  // Add LIMIT if not present and it's a SELECT
  let finalSql = sql;
  const upperSql = sql.toUpperCase().trim();
  if (upperSql.startsWith("SELECT") && !upperSql.includes(" LIMIT ")) {
    finalSql = `${sql} LIMIT ${maxRows}`;
  }

  let client: pg.PoolClient;
  try {
    client = await withTimeout(
      pool.connect(),
      config.neverhang.connection_timeout_ms,
      "Connection timeout"
    );
  } catch (error) {
    neverhang.recordFailure(sql);
    throw new NeverhangError(
      "connection_failed",
      `Failed to connect: ${error instanceof Error ? error.message : "Unknown"}`,
      Date.now() - start,
      { cause: error instanceof Error ? error : undefined }
    );
  }

  try {
    const result = await withTimeout(
      client.query(finalSql, params),
      timeout_ms,
      `Query timed out after ${timeout_ms}ms (${timeoutReason})`
    );

    neverhang.recordSuccess();

    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      duration: Date.now() - start,
    };
  } catch (error) {
    const duration = Date.now() - start;

    // Determine failure type
    const errorMsg = error instanceof Error ? error.message : "Unknown";
    let failureType: "timeout" | "query_error" | "connection_failed" = "query_error";

    if (errorMsg.includes("timed out") || errorMsg.includes("timeout")) {
      failureType = "timeout";
    } else if (errorMsg.includes("connect") || errorMsg.includes("ECONNREFUSED")) {
      failureType = "connection_failed";
    }

    neverhang.recordFailure(sql);

    throw new NeverhangError(
      failureType,
      errorMsg,
      duration,
      { cause: error instanceof Error ? error : undefined }
    );
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
        // EXPLAIN ANALYZE gets 3x timeout per NEVERHANG spec
        const explainTimeout = analyze
          ? config.neverhang.base_timeout_ms * 3
          : config.neverhang.base_timeout_ms;

        const result = await withTimeout(
          client.query(explainQuery, params),
          explainTimeout,
          `EXPLAIN timed out after ${explainTimeout}ms`
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
// TOOLS: Write Operations (v0.4.0 with v0.3.0 Safety)
// ============================================================================

/**
 * Check if query has a WHERE clause (for UPDATE/DELETE safety)
 */
function hasWhereClause(query: string): boolean {
  const upperQuery = query.toUpperCase();
  // Check for WHERE that's not inside a subquery or CTE
  // Simple heuristic: look for WHERE followed by something other than SELECT
  const whereMatch = upperQuery.match(/\bWHERE\b/g);
  if (!whereMatch) return false;

  // Make sure there's a WHERE after the main UPDATE/DELETE
  const updateMatch = upperQuery.match(/\bUPDATE\b.*\bWHERE\b/s);
  const deleteMatch = upperQuery.match(/\bDELETE\b.*\bWHERE\b/s);

  return !!(updateMatch || deleteMatch);
}

/**
 * Extract table name from INSERT/UPDATE/DELETE query
 */
function extractTargetTable(query: string): string | null {
  const upperQuery = query.toUpperCase().trim();

  // INSERT INTO table_name
  const insertMatch = query.match(/INSERT\s+INTO\s+(?:"?(\w+)"?\.)?\"?(\w+)\"?/i);
  if (insertMatch) return insertMatch[2];

  // UPDATE table_name
  const updateMatch = query.match(/UPDATE\s+(?:ONLY\s+)?(?:"?(\w+)"?\.)?\"?(\w+)\"?/i);
  if (updateMatch) return updateMatch[2];

  // DELETE FROM table_name
  const deleteMatch = query.match(/DELETE\s+FROM\s+(?:ONLY\s+)?(?:"?(\w+)"?\.)?\"?(\w+)\"?/i);
  if (deleteMatch) return deleteMatch[2];

  return null;
}

server.tool(
  "pg_execute",
  "Execute INSERT/UPDATE/DELETE queries (requires write permission)",
  {
    query: z.string().describe("SQL query (INSERT, UPDATE, or DELETE)"),
    params: z.array(z.unknown()).optional().describe("Query parameters ($1, $2, etc)"),
    returning: z.boolean().optional().describe("Add RETURNING * to get affected rows"),
  },
  async ({ query, params, returning = false }) => {
    // Check write permission
    if (!config.permissions.write) {
      return {
        content: [{ type: "text", text: "Permission denied: write access not enabled. Set PG_MCP_WRITE=true or config.permissions.write=true" }],
      };
    }

    const upperQuery = query.toUpperCase().trim();

    // Only allow INSERT, UPDATE, DELETE
    const isInsert = upperQuery.startsWith("INSERT");
    const isUpdate = upperQuery.startsWith("UPDATE");
    const isDelete = upperQuery.startsWith("DELETE");

    if (!isInsert && !isUpdate && !isDelete) {
      return {
        content: [{ type: "text", text: "Permission denied: only INSERT, UPDATE, DELETE allowed. Use pg_query for SELECT." }],
      };
    }

    // Check for blocked patterns
    const blocked = containsBlockedPattern(query, config.safety.blocked_patterns);
    if (blocked) {
      return { content: [{ type: "text", text: `Blocked pattern detected: ${blocked}` }] };
    }

    // Check table blacklist
    const targetTable = extractTargetTable(query);
    if (targetTable && matchesBlacklist(targetTable, config.safety.blacklist_tables)) {
      return { content: [{ type: "text", text: `Permission denied: ${targetTable} is blacklisted` }] };
    }

    // Require WHERE clause for UPDATE/DELETE (safety)
    if ((isUpdate || isDelete) && config.safety.require_where) {
      if (!hasWhereClause(query)) {
        return {
          content: [{ type: "text", text: "Safety error: UPDATE/DELETE requires WHERE clause. Set safety.require_where=false to disable this check (DANGEROUS)." }],
        };
      }
    }

    // Add RETURNING if requested
    let finalQuery = query.trim();
    if (returning && !upperQuery.includes("RETURNING")) {
      finalQuery += " RETURNING *";
    }

    try {
      const start = Date.now();

      // NEVERHANG: Circuit breaker check
      const canExecute = neverhang.canExecute();
      if (!canExecute.allowed) {
        return {
          content: [{ type: "text", text: `Circuit open: ${canExecute.reason}` }],
        };
      }

      // NEVERHANG: Get adaptive timeout
      const { timeout_ms } = neverhang.getTimeout(query);

      const client = await pool.connect();

      try {
        const result = await withTimeout(
          client.query(finalQuery, params),
          timeout_ms,
          `Query timed out after ${timeout_ms}ms`
        );

        neverhang.recordSuccess();
        const duration = Date.now() - start;

        const response: Record<string, unknown> = {
          query: query.slice(0, 200) + (query.length > 200 ? "..." : ""),
          operation: isInsert ? "INSERT" : isUpdate ? "UPDATE" : "DELETE",
          affected_rows: result.rowCount,
          execution_time: formatDuration(duration),
        };

        if (returning && result.rows.length > 0) {
          // Filter out blacklisted columns from returned rows
          response.returned_rows = result.rows.map((row) => {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row)) {
              if (!matchesBlacklist(key, config.safety.blacklist_columns)) {
                filtered[key] = value;
              }
            }
            return filtered;
          });
        }

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      } finally {
        client.release();
      }
    } catch (error) {
      neverhang.recordFailure(query);
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown"}` }],
      };
    }
  }
);

// ============================================================================
// TOOLS: Statistics (v0.4.0)
// ============================================================================

server.tool(
  "pg_connections",
  "Get active database connections",
  {
    include_queries: z.boolean().optional().describe("Include current query for each connection"),
  },
  async ({ include_queries = false }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    try {
      const query = `
        SELECT
          pid,
          usename as username,
          application_name,
          client_addr,
          client_port,
          backend_start,
          state,
          state_change,
          wait_event_type,
          wait_event,
          ${include_queries ? "query," : ""}
          query_start,
          EXTRACT(EPOCH FROM (now() - query_start))::int as query_duration_sec
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
        ORDER BY backend_start DESC
      `;

      const result = await safeQuery(query, [], { maxRows: 200 });

      const connections = result.rows.map((row) => ({
        pid: row.pid,
        username: row.username,
        application: row.application_name || null,
        client: row.client_addr ? `${row.client_addr}:${row.client_port}` : "local",
        state: row.state,
        wait_event: row.wait_event ? `${row.wait_event_type}:${row.wait_event}` : null,
        connected_at: row.backend_start,
        query_duration: row.query_duration_sec ? `${row.query_duration_sec}s` : null,
        ...(include_queries && { query: row.query }),
      }));

      // Summary stats
      const stateCounts: Record<string, number> = {};
      for (const conn of connections) {
        const state = String(conn.state || "unknown");
        stateCounts[state] = (stateCounts[state] || 0) + 1;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                database: config.connection.database,
                total_connections: connections.length,
                by_state: stateCounts,
                connections,
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
  "pg_locks",
  "Get current database locks",
  {
    blocked_only: z.boolean().optional().describe("Only show blocked/blocking locks"),
  },
  async ({ blocked_only = false }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    try {
      let query = `
        SELECT
          l.pid,
          l.locktype,
          l.mode,
          l.granted,
          l.waitstart,
          COALESCE(c.relname, l.locktype) as relation,
          a.usename as username,
          a.application_name,
          a.state,
          a.query,
          EXTRACT(EPOCH FROM (now() - a.query_start))::int as query_duration_sec,
          EXTRACT(EPOCH FROM (now() - l.waitstart))::int as wait_duration_sec
        FROM pg_locks l
        LEFT JOIN pg_class c ON l.relation = c.oid
        LEFT JOIN pg_stat_activity a ON l.pid = a.pid
        WHERE l.pid <> pg_backend_pid()
          AND a.datname = current_database()
      `;

      if (blocked_only) {
        query += ` AND (l.granted = false OR l.pid IN (
          SELECT DISTINCT bl.pid FROM pg_locks bl
          WHERE bl.granted = false
          UNION
          SELECT DISTINCT l2.pid FROM pg_locks l2
          WHERE l2.relation IN (SELECT relation FROM pg_locks WHERE granted = false)
        ))`;
      }

      query += ` ORDER BY l.granted, l.waitstart NULLS LAST`;

      const result = await safeQuery(query, [], { maxRows: 200 });

      const locks = result.rows.map((row) => ({
        pid: row.pid,
        type: row.locktype,
        mode: row.mode,
        granted: row.granted,
        relation: row.relation,
        username: row.username,
        application: row.application_name || null,
        state: row.state,
        query_duration: row.query_duration_sec ? `${row.query_duration_sec}s` : null,
        wait_duration: row.wait_duration_sec ? `${row.wait_duration_sec}s` : null,
        query: truncate(String(row.query || ""), 100),
      }));

      // Summary
      const blockedCount = locks.filter((l) => !l.granted).length;
      const blockingPids = [...new Set(locks.filter((l) => !l.granted).map((l) => l.pid))];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                database: config.connection.database,
                total_locks: locks.length,
                blocked_count: blockedCount,
                blocking_pids: blockingPids,
                locks,
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
  "pg_size",
  "Get database and table sizes",
  {
    table: z.string().optional().describe("Specific table (omit for database overview)"),
    schema: z.string().optional().describe("Schema name (default: public)"),
  },
  async ({ table, schema = "public" }) => {
    if (!config.permissions.read) {
      return { content: [{ type: "text", text: "Permission denied: read access not enabled" }] };
    }

    // Check table blacklist
    if (table && matchesBlacklist(table, config.safety.blacklist_tables)) {
      return { content: [{ type: "text", text: `Permission denied: ${table} is blacklisted` }] };
    }

    try {
      if (table) {
        // Specific table size breakdown
        const query = `
          SELECT
            pg_total_relation_size(c.oid) as total_bytes,
            pg_table_size(c.oid) as table_bytes,
            pg_indexes_size(c.oid) as indexes_bytes,
            pg_total_relation_size(c.oid) - pg_table_size(c.oid) - pg_indexes_size(c.oid) as toast_bytes,
            COALESCE(s.n_live_tup, 0) as row_estimate,
            COALESCE(s.n_dead_tup, 0) as dead_tuples,
            s.last_vacuum,
            s.last_autovacuum,
            s.last_analyze,
            s.last_autoanalyze
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
          WHERE c.relname = $1 AND n.nspname = $2
        `;

        const result = await safeQuery(query, [table, schema], { maxRows: 1 });

        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: `Table not found: ${schema}.${table}` }] };
        }

        const row = result.rows[0];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  schema,
                  table,
                  size: {
                    total: formatBytes(row.total_bytes as number | null),
                    table: formatBytes(row.table_bytes as number | null),
                    indexes: formatBytes(row.indexes_bytes as number | null),
                    toast: formatBytes(row.toast_bytes as number | null),
                  },
                  rows: {
                    estimate: formatRowCount(row.row_estimate as number),
                    dead_tuples: row.dead_tuples,
                  },
                  maintenance: {
                    last_vacuum: row.last_vacuum,
                    last_autovacuum: row.last_autovacuum,
                    last_analyze: row.last_analyze,
                    last_autoanalyze: row.last_autoanalyze,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        // Database overview
        const dbQuery = `
          SELECT
            pg_database_size(current_database()) as db_size,
            (SELECT count(*) FROM pg_stat_user_tables) as table_count,
            (SELECT count(*) FROM pg_stat_user_indexes) as index_count
        `;

        const tableQuery = `
          SELECT
            schemaname as schema,
            relname as table_name,
            pg_total_relation_size(relid) as total_bytes,
            n_live_tup as row_estimate
          FROM pg_stat_user_tables
          WHERE schemaname = $1
          ORDER BY pg_total_relation_size(relid) DESC
          LIMIT 20
        `;

        const [dbResult, tableResult] = await Promise.all([
          safeQuery(dbQuery, [], { maxRows: 1 }),
          safeQuery(tableQuery, [schema], { maxRows: 20 }),
        ]);

        const dbRow = dbResult.rows[0];

        const tables = tableResult.rows
          .filter((row) => !matchesBlacklist(row.table_name as string, config.safety.blacklist_tables))
          .map((row) => ({
            schema: row.schema,
            table: row.table_name,
            size: formatBytes(row.total_bytes as number | null),
            size_bytes: row.total_bytes,
            rows: formatRowCount(row.row_estimate as number),
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  database: config.connection.database,
                  size: formatBytes(dbRow.db_size as number | null),
                  size_bytes: dbRow.db_size,
                  table_count: dbRow.table_count,
                  index_count: dbRow.index_count,
                  largest_tables: tables,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown"}` }],
      };
    }
  }
);

// ============================================================================
// TOOLS: NEVERHANG Health (v0.5.0)
// ============================================================================

server.tool(
  "pg_health",
  "Get database health status, circuit breaker state, and connection pool stats",
  {},
  async () => {
    const stats = neverhang.getStats();
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    // Format time until circuit opens
    let circuitOpensIn: string | null = null;
    if (stats.circuit_opens_in !== null) {
      circuitOpensIn = `${Math.ceil(stats.circuit_opens_in / 1000)}s`;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              database: config.connection.database,
              health: {
                status: stats.status,
                circuit: stats.circuit,
                circuit_opens_in: circuitOpensIn,
              },
              latency: {
                current_ms: stats.latency_ms,
                p95_ms: stats.latency_p95_ms,
              },
              pool: poolStats,
              failures: {
                recent: stats.recent_failures,
                last_failure: stats.last_failure,
              },
              last_success: stats.last_success,
              uptime_percent: neverhang.getUptimePercent(),
              config: {
                base_timeout_ms: config.neverhang.base_timeout_ms,
                connection_timeout_ms: config.neverhang.connection_timeout_ms,
                circuit_threshold: config.neverhang.circuit_failure_threshold,
                adaptive_timeout: config.neverhang.adaptive_timeout,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start NEVERHANG background health monitoring
  neverhang.start();

  console.error("[postgres-mcp] Running on stdio (NEVERHANG v2.0)");
  console.error(`[postgres-mcp] Permissions: read=${config.permissions.read}, write=${config.permissions.write}`);
  console.error(`[postgres-mcp] NEVERHANG: base_timeout=${config.neverhang.base_timeout_ms}ms, connect_timeout=${config.neverhang.connection_timeout_ms}ms`);
  console.error(`[postgres-mcp] Circuit: threshold=${config.neverhang.circuit_failure_threshold} failures, open_duration=${config.neverhang.circuit_open_duration_ms}ms`);
  console.error(`[postgres-mcp] Database: ${config.connection.host}:${config.connection.port}/${config.connection.database}`);
}

main().catch((error) => {
  console.error("[postgres-mcp] Fatal error:", error);
  process.exit(1);
});

// Cleanup on exit
process.on("SIGINT", async () => {
  neverhang.stop();
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  neverhang.stop();
  await pool.end();
  process.exit(0);
});
