# postgres-mcp

A Model Context Protocol (MCP) server for PostgreSQL integration. Give your AI assistant safe, controlled access to your databases.

**Status:** Alpha (v0.1.0)

**Author:** Claude + MOD

**License:** MIT

**Org:** [ArktechNWA](https://github.com/ArktechNWA)

---

## Why?

Your AI assistant can write SQL, but it can't see your actual schema. It can suggest queries, but can't run them to verify. It's blind to your data model.

postgres-mcp connects Claude to your PostgreSQL databases — with granular permission control, query safety, and read-only defaults.

---

## Philosophy

1. **Safety first** — Read-only by default, write explicitly enabled
2. **Query safety** — Statement timeouts, row limits, dangerous pattern blocking
3. **Schema awareness** — Introspection without data exposure
4. **Never hang** — Timeouts on everything, cancellation support
5. **Fallback AI** — Haiku for query optimization and schema analysis

---

## Features

### Perception (Read)
- Execute SELECT queries
- Schema introspection (tables, columns, indexes, constraints)
- Explain query plans
- Database statistics
- Active connections and locks

### Action (Write)
- INSERT, UPDATE, DELETE (permission-gated)
- DDL operations (permission-gated)
- Transaction support

### Analysis (AI-Assisted)
- Query optimization suggestions
- Schema design analysis
- Index recommendations

---

## Permission Model

**CRITICAL:** Database access requires careful permission management.

### Permission Levels

| Level | Description | Default |
|-------|-------------|---------|
| `read` | SELECT queries, schema introspection | **ON** |
| `write` | INSERT, UPDATE, DELETE | OFF |
| `ddl` | CREATE, ALTER, DROP | OFF |
| `admin` | VACUUM, REINDEX, connection management | OFF |

### Table/Schema Filtering

```json
{
  "permissions": {
    "read": true,
    "write": false,
    "ddl": false,
    "admin": false,

    "whitelist_schemas": ["public", "app"],
    "blacklist_schemas": ["pg_catalog", "information_schema"],

    "whitelist_tables": [],
    "blacklist_tables": [
      "users.password_hash",
      "secrets.*",
      "*.credentials"
    ]
  }
}
```

**Rules:**
- Blacklist always wins
- Column-level filtering supported
- Pattern matching: `schema.table.column`

### Query Safety

```json
{
  "query_safety": {
    "statement_timeout": "30s",
    "max_rows": 1000,
    "block_patterns": [
      "DROP DATABASE",
      "TRUNCATE",
      "DELETE FROM .* WHERE 1=1",
      "UPDATE .* SET .* WHERE 1=1"
    ],
    "require_where_clause": true
  }
}
```

### Bypass Mode

```bash
postgres-mcp --bypass-permissions
```

Full database access. **DANGER ZONE.**

---

## Authentication

```json
{
  "connection": {
    "host": "localhost",
    "port": 5432,
    "database": "myapp",
    "user_env": "PGUSER",
    "password_env": "PGPASSWORD",
    "ssl": true
  }
}
```

Or connection string:
```json
{
  "connection": {
    "url_env": "DATABASE_URL"
  }
}
```

**Recommendation:** Use a read-only database user for maximum safety.

---

## Tools

### Queries

#### `pg_query`
Execute a SELECT query.

```typescript
pg_query({
  query: string,
  params?: any[],           // parameterized queries
  limit?: number,           // override max_rows
  timeout?: string          // override statement_timeout
})
```

Returns:
```json
{
  "query": "SELECT name, email FROM users WHERE active = $1",
  "params": [true],
  "rows": [
    {"name": "Alice", "email": "alice@example.com"},
    {"name": "Bob", "email": "bob@example.com"}
  ],
  "row_count": 2,
  "execution_time": "12ms",
  "summary": "2 active users found"
}
```

#### `pg_execute`
Execute INSERT/UPDATE/DELETE. Requires `write` permission.

```typescript
pg_execute({
  query: string,
  params?: any[],
  returning?: boolean       // add RETURNING *
})
```

Returns:
```json
{
  "query": "UPDATE users SET active = $1 WHERE id = $2",
  "params": [false, 123],
  "affected_rows": 1,
  "execution_time": "5ms"
}
```

### Schema Introspection

#### `pg_tables`
List tables with metadata.

```typescript
pg_tables({
  schema?: string,          // default: "public"
  pattern?: string          // table name pattern
})
```

Returns:
```json
{
  "tables": [
    {
      "schema": "public",
      "name": "users",
      "type": "table",
      "row_estimate": 15420,
      "size": "2.3 MB",
      "description": "User accounts"
    }
  ]
}
```

#### `pg_columns`
Get column information for a table.

```typescript
pg_columns({
  table: string,
  schema?: string
})
```

Returns:
```json
{
  "table": "users",
  "columns": [
    {
      "name": "id",
      "type": "integer",
      "nullable": false,
      "default": "nextval('users_id_seq')",
      "primary_key": true
    },
    {
      "name": "email",
      "type": "varchar(255)",
      "nullable": false,
      "unique": true
    }
  ]
}
```

#### `pg_indexes`
Get index information.

```typescript
pg_indexes({
  table?: string,
  schema?: string
})
```

#### `pg_constraints`
Get constraint information (PK, FK, unique, check).

```typescript
pg_constraints({
  table?: string,
  schema?: string,
  type?: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK"
})
```

#### `pg_schema`
Get complete schema for a table (columns, indexes, constraints, relations).

```typescript
pg_schema({
  table: string,
  schema?: string,
  include_stats?: boolean
})
```

### Query Analysis

#### `pg_explain`
Get query execution plan.

```typescript
pg_explain({
  query: string,
  params?: any[],
  analyze?: boolean,        // actually run (careful!)
  format?: "text" | "json"
})
```

Returns:
```json
{
  "query": "SELECT * FROM users WHERE email = $1",
  "plan": {
    "node_type": "Index Scan",
    "index_name": "users_email_idx",
    "estimated_rows": 1,
    "estimated_cost": 0.42
  },
  "summary": "Uses index scan on users_email_idx, estimated 1 row"
}
```

### Statistics

#### `pg_stats`
Get database/table statistics.

```typescript
pg_stats({
  table?: string,           // specific table (omit for database)
  include_index_usage?: boolean
})
```

#### `pg_connections`
Get active connections.

```typescript
pg_connections({
  include_queries?: boolean
})
```

#### `pg_locks`
Get current locks.

```typescript
pg_locks({
  blocked_only?: boolean
})
```

### Analysis

#### `pg_analyze_query`
AI-powered query analysis.

```typescript
pg_analyze_query({
  query: string,
  use_ai?: boolean
})
```

Returns:
```json
{
  "query": "SELECT * FROM orders WHERE user_id = 123",
  "plan_summary": "Sequential scan on orders (15M rows)",
  "synthesis": {
    "analysis": "This query performs a full table scan. The user_id column is not indexed.",
    "suggested_index": "CREATE INDEX orders_user_id_idx ON orders(user_id);",
    "estimated_improvement": "~10,000x faster",
    "confidence": "high"
  }
}
```

#### `pg_suggest_schema`
Get schema improvement suggestions.

```typescript
pg_suggest_schema({
  table: string,
  use_ai?: boolean
})
```

---

## NEVERHANG Architecture

Database queries can hang indefinitely. A missing index + large table = disaster.

### Statement Timeout
- Default: 30s
- Server-enforced via `SET statement_timeout`
- Per-query override available

### Connection Timeout
- Connect timeout: 10s
- Idle timeout: 60s
- Connection pooling

### Row Limits
- Default max: 1000 rows
- Prevents accidental `SELECT *` disasters
- Override per-query when needed

### Circuit Breaker
- 3 timeouts in 60s → 5 minute cooldown
- Tracks connection health
- Graceful degradation

### Query Cancellation
- Queries can be cancelled mid-flight
- Uses `pg_cancel_backend()`

```json
{
  "neverhang": {
    "statement_timeout": "30s",
    "connect_timeout": "10s",
    "max_rows": 1000,
    "circuit_breaker": {
      "failures": 3,
      "window": 60000,
      "cooldown": 300000
    }
  }
}
```

---

## Fallback AI

Optional Haiku for query optimization.

```json
{
  "fallback": {
    "enabled": true,
    "model": "claude-haiku-4-5",
    "api_key_env": "PG_MCP_FALLBACK_KEY",
    "max_tokens": 500
  }
}
```

**When used:**
- `pg_analyze_query` with `use_ai: true`
- `pg_suggest_schema` for design recommendations
- Natural language to SQL (future)

---

## Configuration

`~/.config/postgres-mcp/config.json`:

```json
{
  "connection": {
    "host": "localhost",
    "port": 5432,
    "database": "myapp",
    "user_env": "PGUSER",
    "password_env": "PGPASSWORD"
  },
  "permissions": {
    "read": true,
    "write": false,
    "ddl": false,
    "admin": false,
    "blacklist_tables": ["*.password*", "*.secret*"]
  },
  "query_safety": {
    "statement_timeout": "30s",
    "max_rows": 1000,
    "require_where_clause": true
  },
  "fallback": {
    "enabled": false
  }
}
```

### Claude Code Integration

```json
{
  "mcpServers": {
    "postgres": {
      "command": "postgres-mcp",
      "env": {
        "PGUSER": "readonly_user",
        "PGPASSWORD": "secret"
      }
    }
  }
}
```

---

## Installation

```bash
npm install -g @arktechnwa/postgres-mcp
```

---

## Requirements

- Node.js 18+
- PostgreSQL 12+
- Optional: Anthropic API key for fallback AI

---

## Security Considerations

1. **Use read-only user** — Create a DB user with SELECT-only grants
2. **Blacklist sensitive tables** — Passwords, secrets, PII
3. **Statement timeout** — Prevent runaway queries
4. **Row limits** — Prevent accidental data dumps
5. **No credential exposure** — Connection strings never logged

---

## Credits

Created by Claude (claude@arktechnwa.com) in collaboration with Meldrey.
Part of the [ArktechNWA MCP Toolshed](https://github.com/ArktechNWA).
