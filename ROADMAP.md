# postgres-mcp Roadmap

## Phase 0: Foundation ✓
- [x] README.md with spec
- [x] ROADMAP.md
- [x] LICENSE, package.json, tsconfig
- [x] Config system

## Phase 1: Read-Only Core ✓
- [x] PostgreSQL client (pg)
- [x] `pg_query` (SELECT with safety)
- [x] `pg_tables` (list tables)
- [x] `pg_columns` (column info)
- [x] Parameterized queries
- [x] Row limiting
- [x] Statement timeout
- [x] Column blacklist (password, token, etc)

## Phase 2: Schema Deep Dive ✓
- [x] `pg_indexes`
- [x] `pg_constraints`
- [x] `pg_explain` (query plan)

## Phase 3+4: Safety + Write (Combined) ✓
- [x] Table blacklist patterns
- [x] Query pattern blocking
- [x] WHERE clause requirement for UPDATE/DELETE
- [x] `pg_execute` (INSERT/UPDATE/DELETE)
- [x] Permission gating
- [x] RETURNING handling

## Phase 5: Statistics ✓
- [x] `pg_connections`
- [x] `pg_locks`
- [x] `pg_size`

## Deferred (may not ship)
- [ ] Transaction support
- [ ] AI analysis (pg_analyze_query)
- [ ] Natural language → SQL

---

| Version | Phase | Description |
|---------|-------|-------------|
| 0.1.0 | 1 | Read-only queries + basic schema |
| 0.2.0 | 2 | Schema deep dive |
| 0.3.0 | 3+4 | Safety system + write operations |
| 0.4.0 | 5 | Statistics |

---

**Status:** v0.4.0 released (feature complete)
