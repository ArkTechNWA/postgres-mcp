# postgres-mcp Build Plan

**Objective:** Safe PostgreSQL access for Claude with guardrails

**Core Value:** Claude + raw SQL = dangerous. This MCP adds safety rails.

---

## Phase 1: v0.1.0 - Read-Only Core

| Tool | Difficulty | Usefulness | Description |
|------|------------|------------|-------------|
| `pg_query` | Low | 0.95 | Execute SELECT with row limits, timeout |
| `pg_tables` | Low | 0.90 | List tables with row estimates, sizes |
| `pg_columns` | Low | 0.90 | Column info for a table |
| Connection pooling | Med | 0.85 | pg library handles this |
| Statement timeout | Low | 0.95 | `SET statement_timeout` |
| Row limit enforcement | Low | 0.95 | LIMIT injection |

**Deliverable:** Read queries + basic schema introspection
**Estimate:** 2-3 hours (following systemd-mcp pattern)
**Slide risk:** LOW - this is table stakes

---

## Phase 2: v0.2.0 - Schema Deep Dive

| Tool | Difficulty | Usefulness | Description |
|------|------------|------------|-------------|
| `pg_indexes` | Low | 0.80 | Index info per table |
| `pg_constraints` | Low | 0.75 | PK/FK/unique/check |
| `pg_schema` | Med | 0.85 | Combined table schema dump |
| `pg_explain` | Low | 0.70 | EXPLAIN query plan (no ANALYZE) |

**Deliverable:** Full schema introspection
**Estimate:** 1-2 hours
**Slide risk:** LOW - straightforward queries against pg_catalog

---

## Phase 3: v0.3.0 - Safety System

| Tool | Difficulty | Usefulness | Description |
|------|------------|------------|-------------|
| Table blacklist | Med | 0.90 | Block `*.password*`, `secrets.*` |
| Column redaction | High | 0.60 | Hide specific columns from results |
| Query pattern blocking | Med | 0.85 | Block `DROP`, `TRUNCATE`, etc. |
| Require WHERE clause | Med | 0.80 | Block `DELETE FROM x` without WHERE |

**Deliverable:** Production-safe defaults
**Estimate:** 2-3 hours
**Slide risk:** MEDIUM - column redaction is tricky, may defer

---

## Phase 4: v0.4.0 - Write Operations

| Tool | Difficulty | Usefulness | Description |
|------|------------|------------|-------------|
| `pg_execute` | Med | 0.65 | INSERT/UPDATE/DELETE |
| Permission gating | Low | 0.90 | `write: false` default |
| RETURNING support | Low | 0.70 | Get affected rows back |
| Transaction support | High | 0.50 | BEGIN/COMMIT/ROLLBACK |

**Deliverable:** Controlled write access
**Estimate:** 2-3 hours
**Slide risk:** MEDIUM - transactions are complex, may skip

⚠️ **SLIDE WARNING:** Transaction support is scope creep. Single-statement writes are sufficient for v1.0.

---

## Phase 5: v0.5.0 - Statistics & Diagnostics

| Tool | Difficulty | Usefulness | Description |
|------|------------|------------|-------------|
| `pg_stats` | Med | 0.60 | Table/index statistics |
| `pg_connections` | Low | 0.55 | Active connections |
| `pg_locks` | Med | 0.50 | Current locks |
| `pg_size` | Low | 0.70 | Database/table sizes |

**Deliverable:** DBA visibility
**Estimate:** 2 hours
**Slide risk:** LOW - but usefulness is lower

---

## Phase 6: v0.6.0 - AI Analysis

| Tool | Difficulty | Usefulness | Description |
|------|------------|------------|-------------|
| `pg_analyze_query` | High | 0.40 | Haiku analyzes query plan |
| `pg_suggest_index` | High | 0.35 | AI recommends indexes |
| Natural language → SQL | High | 0.30 | "Show me users who..." |

**Deliverable:** AI-assisted database work
**Estimate:** 4-6 hours
**Slide risk:** HIGH - Haiku integration complexity, unclear value

⚠️ **SLIDE WARNING:** AI features are nice-to-have. Claude already understands SQL. These may never ship.

---

## Honest Assessment

### Will Ship (v0.1.0 - v0.3.0)
- Read queries with limits ✓
- Schema introspection ✓
- Safety rails (blacklist, pattern blocking) ✓

### Might Ship (v0.4.0 - v0.5.0)
- Write operations (if needed)
- Statistics tools (if requested)

### Probably Won't Ship (v0.6.0)
- AI analysis features
- Natural language → SQL
- Transaction management

---

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "pg": "^8.11.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/pg": "^8.10.0",
    "typescript": "^5.3.0"
  }
}
```

---

## Test Environment

Local postgres container (from activepieces stack):
```bash
docker start postgres  # Exited, needs restart
# Or connect to any postgres instance
```

---

## Config Structure

```typescript
interface Config {
  connection: {
    host: string;
    port: number;
    database: string;
    user?: string;
    password?: string;
    ssl?: boolean;
  };
  permissions: {
    read: boolean;      // default: true
    write: boolean;     // default: false
    ddl: boolean;       // default: false
  };
  safety: {
    statement_timeout: number;  // default: 30000ms
    max_rows: number;           // default: 1000
    blacklist_tables: string[]; // patterns
    require_where: boolean;     // default: true for UPDATE/DELETE
  };
}
```

---

## Decision: Start with v0.1.0?

Ready to build. Scope is tight. No AI fluff.
