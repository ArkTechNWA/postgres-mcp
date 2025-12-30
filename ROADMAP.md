# postgres-mcp Roadmap

## Phase 0: Foundation ✓
- [x] README.md with spec
- [x] ROADMAP.md
- [ ] LICENSE, package.json, tsconfig
- [ ] Example configs

## Phase 1: Read-Only Queries
- [ ] PostgreSQL client (pg)
- [ ] `pg_query` (SELECT)
- [ ] Parameterized queries
- [ ] Row limiting
- [ ] Statement timeout

## Phase 2: Schema Introspection
- [ ] `pg_tables`
- [ ] `pg_columns`
- [ ] `pg_indexes`
- [ ] `pg_constraints`
- [ ] `pg_schema` (unified)

## Phase 3: Permission System
- [ ] Permission levels (read, write, ddl, admin)
- [ ] Table/schema whitelist/blacklist
- [ ] Column-level filtering
- [ ] `--bypass-permissions` flag

## Phase 4: Query Safety
- [ ] Dangerous pattern blocking
- [ ] WHERE clause requirement
- [ ] Query cancellation
- [ ] Circuit breaker

## Phase 5: Write Operations
- [ ] `pg_execute` (INSERT/UPDATE/DELETE)
- [ ] Transaction support
- [ ] RETURNING handling

## Phase 6: Analysis
- [ ] `pg_explain`
- [ ] `pg_stats`
- [ ] `pg_connections`
- [ ] `pg_locks`

## Phase 7: AI Analysis
- [ ] `pg_analyze_query`
- [ ] `pg_suggest_schema`
- [ ] Haiku integration
- [ ] Index recommendations

## Phase 8: Polish
- [ ] Error messages
- [ ] Test suite
- [ ] npm publish

---

| Version | Phase | Description |
|---------|-------|-------------|
| 0.1.0 | 1 | Read-only queries |
| 0.2.0 | 2 | Schema introspection |
| 0.3.0 | 3 | Permission system |
| 0.4.0 | 4 | Query safety |
| 0.5.0 | 5 | Write operations |
| 0.6.0 | 6 | Statistics |
| 0.7.0 | 7 | AI analysis |
| 1.0.0 | 8 | Production release |
