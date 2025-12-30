# postgres-mcp Chronicle

**Project**: postgres-mcp
**Timeline**: 2025-12-29 to 2025-12-30
**Status**: Feature Complete (v0.4.0)
**Authors**: Claude + MOD

---

## Origin Story

Born from the ArktechNWA MCP toolshed initiative. After building systemd-mcp (v0.4.1) and docker-mcp (deemed potentially superfluous vs raw CLI), the question arose: what MCPs actually provide value beyond what CLI already offers?

Analysis of remaining candidates:
- **prometheus-mcp**: Moderate value. PromQL is complex but the API is already clean.
- **postgres-mcp**: Clear winner. AI + raw SQL access is dangerous without guardrails.
- **pfclaude**: Massive scope creep risk. Full product, not just MCP wrapper.

**Decision**: Build postgres-mcp. The safety-first approach for AI database access has genuine utility.

---

## Development Timeline

### Day 1 (2025-12-29): Planning & Foundation

Created BUILD_PLAN.md with difficulty scores and usefulness confidence ratings:

| Phase | Tools | Difficulty | Usefulness |
|-------|-------|------------|------------|
| 1 | pg_query, pg_tables, pg_columns | Low | 0.90-0.95 |
| 2 | pg_indexes, pg_constraints, pg_explain | Low-Med | 0.75-0.85 |
| 3 | Safety enhancements | Low | 0.90 |
| 4 | pg_execute | Medium | 0.80 |
| 5 | pg_connections, pg_locks, pg_size | Low | 0.70-0.80 |

**Scope creep flags identified early**:
- Transaction support (deferred)
- AI analysis / pg_analyze_query (deferred)
- Natural language to SQL (deferred - that's a product, not an MCP)

### Day 2 (2025-12-30): Build Cycle

Execution pattern: `Plan -> Build -> TEST -> Fix -> +version -> Recurse`

**v0.1.0** - Core foundation
- pg_query with automatic LIMIT injection
- pg_tables with size/row estimates
- pg_columns with PK/unique detection
- Column blacklist (password, token, secret, api_key)
- Statement timeout, connection pooling

**v0.1.1** - Bug fix
- formatBytes returning "NaN undefined" for null table sizes
- Root cause: pg_table_size returns null for some tables

**v0.2.0** - Schema deep dive
- pg_indexes (type, uniqueness, size, definition)
- pg_constraints (PK, FK, unique, check with references)
- pg_explain (EXPLAIN/ANALYZE with JSON plan parsing)

**v0.3.0** - Phase compression occurs
- Phases 3 (Safety) and 4 (Write) combined
- Reason: `require_where` enforcement only makes sense WITH write operations
- pg_execute added with full safety stack:
  - Permission gating (PG_MCP_WRITE=true required)
  - Table blacklist enforcement on write targets
  - WHERE clause requirement for UPDATE/DELETE
  - RETURNING with column blacklist filtering

**v0.4.0** - Statistics (feature complete)
- pg_connections (active connections, state breakdown)
- pg_locks (lock monitoring, blocked/blocking detection)
- pg_size (database overview, table breakdown, maintenance stats)

---

## Phase Compression Decision

Original plan had 5 phases mapping to 5 versions. Actual delivery compressed to 4.

```
PLANNED:                    ACTUAL:
v0.1.0 = Phase 1           v0.1.0 = Phase 1
v0.2.0 = Phase 2           v0.2.0 = Phase 2
v0.3.0 = Phase 3 (Safety)  v0.3.0 = Phase 3+4 (Safety + Write)
v0.4.0 = Phase 4 (Write)   v0.4.0 = Phase 5 (Stats)
v0.5.0 = Phase 5 (Stats)   [absorbed into v0.4.0]
```

**Rationale**: Safety and write operations are interdependent. The `require_where` safety feature has no meaning without `pg_execute`. Combining them avoided shipping a half-baked safety phase.

---

## Final Tool Inventory

| Tool | Category | Description |
|------|----------|-------------|
| pg_query | Read | SELECT with safety limits |
| pg_tables | Schema | Table listing with metadata |
| pg_columns | Schema | Column info with constraints |
| pg_indexes | Schema | Index details |
| pg_constraints | Schema | PK/FK/unique/check |
| pg_explain | Analysis | Query execution plans |
| pg_execute | Write | INSERT/UPDATE/DELETE (gated) |
| pg_connections | Stats | Active connections |
| pg_locks | Stats | Lock monitoring |
| pg_size | Stats | Size analysis |

**Total**: 10 tools

---

## Safety Architecture

The core philosophy: **Read-only by default, write explicitly enabled.**

```
                    ┌─────────────────────┐
                    │   Incoming Query    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Permission Check    │
                    │ (read/write/ddl)    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Blocked Patterns    │
                    │ DROP/TRUNCATE/etc   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Table Blacklist     │
                    │ (wildcard support)  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
    ┌─────────▼─────────┐             ┌─────────▼─────────┐
    │ SELECT Path       │             │ WRITE Path        │
    │ - Auto LIMIT      │             │ - WHERE required  │
    │ - Column filter   │             │ - RETURNING filter│
    └─────────┬─────────┘             └─────────┬─────────┘
              │                                 │
              └────────────────┬────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Statement Timeout   │
                    │ (30s default)       │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │     Execute         │
                    └─────────────────────┘
```

---

## Deferred Features

These were flagged as scope creep risks from the start:

1. **Transaction support** - Adds state management complexity
2. **AI analysis (pg_analyze_query)** - Requires Haiku integration, separate concern
3. **Natural language to SQL** - That's a product, not an MCP tool

They remain in ROADMAP.md under "Deferred (may not ship)".

---

## Testing Notes

Tested against Activepieces PostgreSQL container:
- 43 tables in database
- pg_tables successfully listed all with size/row estimates
- formatBytes bug discovered and fixed (v0.1.1)
- Tools registered correctly after Claude Code restart

---

## Repository

- **GitHub**: https://github.com/ArkTechNWA/postgres-mcp
- **Release**: https://github.com/ArkTechNWA/postgres-mcp/releases/tag/v0.4.0
- **License**: MIT

---

## Lessons Learned

1. **Phase dependencies matter** - Don't ship safety features that can't be enforced yet
2. **Scope creep flags work** - Identifying risky features early prevented drift
3. **Difficulty/usefulness scoring** - Helped prioritize and set expectations
4. **formatBytes edge cases** - Always handle null from database functions

---

*Chronicle entry by Claude, 2025-12-30*
