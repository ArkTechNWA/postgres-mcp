# NEVERHANG Specification

**Status**: Draft
**Target**: v0.5.0
**Author**: Claude
**Date**: 2025-12-30

---

## Current State (v0.4.0)

The `neverhang` config is marketing fluff wrapped around basic timeouts:

```typescript
neverhang: {
  query_timeout: 30000,      // Statement timeout in ms
  connection_timeout: 10000, // Pool connection timeout
  max_connections: 5,        // Pool size
}
```

### What It Actually Does
- `withTimeout()` wrapper using Promise.race
- PostgreSQL `statement_timeout` set per query
- Connection pool with max size

### What It Claims vs Reality

| Claim | Reality |
|-------|---------|
| "Never hang" | Waits up to 30s on slow queries |
| "Safe timeouts" | No fast-fail on unreachable DB |
| "Connection management" | Basic pooling, no health checks |

---

## Failure Modes (Unhandled)

### 1. Database Unreachable
**Scenario**: Network partition, DB down, firewall block
**Current behavior**: Waits full connection_timeout (10s), then throws
**Problem**: 10 seconds of silence in chat context feels like eternity

### 2. Connection Pool Exhaustion
**Scenario**: Concurrent requests exceed pool size, slow queries hold connections
**Current behavior**: New requests wait for pool slot
**Problem**: Cascading delays, potential deadlock under load

### 3. Query Runs But Never Returns
**Scenario**: Complex join, missing index, table lock
**Current behavior**: statement_timeout eventually kills it
**Problem**: 30s is too long for interactive use

### 4. MCP Process Crash
**Scenario**: Unhandled exception, memory exhaustion, segfault
**Current behavior**: Process dies, Claude Code notices eventually
**Problem**: No graceful degradation, no recovery

### 5. Zombie Connections
**Scenario**: Connection appears valid but is actually dead
**Current behavior**: Query sent to dead connection, hangs until timeout
**Problem**: Stale pool connections waste time

---

## NEVERHANG v2.0 Specification

### Design Principles

1. **Fast-fail over slow-fail**: Better to error in 2s than succeed in 30s
2. **Health-aware**: Don't send queries to sick databases
3. **Graceful degradation**: Partial functionality > total failure
4. **Observable**: Know WHY something failed, not just THAT it failed

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         NEVERHANG v2.0                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │ Health      │───▶│ Circuit     │───▶│ Query Executor      │ │
│  │ Monitor     │    │ Breaker     │    │ (with timeouts)     │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│        │                  │                      │              │
│        ▼                  ▼                      ▼              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │ Connection  │    │ Failure     │    │ Adaptive            │ │
│  │ Pool + TTL  │    │ Counter     │    │ Timeout             │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Component Specifications

#### 1. Health Monitor

**Purpose**: Proactively detect database availability

```typescript
interface HealthMonitor {
  // Fast ping query
  ping(): Promise<{ ok: boolean; latency_ms: number }>;

  // Background health check (every N seconds)
  startBackgroundCheck(interval_ms: number): void;

  // Current health state
  getHealth(): HealthState;
}

interface HealthState {
  status: 'healthy' | 'degraded' | 'unhealthy';
  last_check: Date;
  last_success: Date;
  latency_ms: number;
  consecutive_failures: number;
}
```

**Implementation**:
- Ping query: `SELECT 1` with 2s timeout
- Background interval: 30s when healthy, 5s when degraded
- Status transitions:
  - healthy → degraded: 1 failure
  - degraded → unhealthy: 3 consecutive failures
  - unhealthy → degraded: 1 success
  - degraded → healthy: 3 consecutive successes

#### 2. Circuit Breaker

**Purpose**: Fast-fail when database is known-bad

```typescript
interface CircuitBreaker {
  // Check if requests should be allowed
  canExecute(): boolean;

  // Record success/failure
  recordSuccess(): void;
  recordFailure(error: Error): void;

  // Current state
  getState(): CircuitState;
}

type CircuitState = 'closed' | 'open' | 'half-open';
```

**Implementation**:
- **Closed** (normal): Requests flow through
- **Open** (tripped): Immediate rejection, no DB contact
- **Half-open** (testing): Allow 1 request to test recovery

**Thresholds**:
- Trip to open: 5 failures in 60 seconds
- Open duration: 30 seconds before half-open
- Recovery: 2 successes in half-open → closed

#### 3. Connection Pool with TTL

**Purpose**: Prevent zombie connections

```typescript
interface PoolConfig {
  max_connections: number;      // Max pool size
  min_connections: number;      // Keep-alive minimum
  connection_ttl_ms: number;    // Max age before recycle
  idle_timeout_ms: number;      // Close idle connections after
  validation_query: string;     // Query to validate connection
  validate_on_borrow: boolean;  // Check before use
}
```

**Implementation**:
- Default TTL: 5 minutes (force recycle even if "healthy")
- Idle timeout: 60 seconds
- Validate on borrow: Only if connection age > 30s
- Validation query: `SELECT 1` with 1s timeout

#### 4. Adaptive Timeout

**Purpose**: Adjust timeouts based on query complexity and DB health

```typescript
interface AdaptiveTimeout {
  // Calculate timeout for a query
  getTimeout(query: string, health: HealthState): number;
}
```

**Implementation**:
- Base timeout: 10s (down from 30s)
- Health multiplier:
  - healthy: 1.0x
  - degraded: 0.5x (fail faster when sick)
  - unhealthy: circuit breaker blocks anyway
- Query complexity hints:
  - Simple SELECT: 1.0x
  - JOIN detected: 1.5x
  - Subquery detected: 2.0x
  - EXPLAIN prefix: 3.0x (analysis takes longer)
  - User override: respect `max_rows` as complexity hint

**Timeout calculation**:
```
timeout = base * health_multiplier * complexity_multiplier
timeout = clamp(timeout, 2000, 30000)  // 2s minimum, 30s maximum
```

#### 5. Failure Taxonomy

**Purpose**: Distinguish failure types for appropriate handling

```typescript
type FailureType =
  | 'timeout'           // Query took too long
  | 'connection_failed' // Couldn't reach DB
  | 'pool_exhausted'    // No available connections
  | 'circuit_open'      // Fast-fail, DB known bad
  | 'query_error'       // SQL error (syntax, constraint, etc)
  | 'permission_denied' // Auth/authz failure
  | 'cancelled';        // User/system cancellation

interface NeverhangError extends Error {
  type: FailureType;
  duration_ms: number;
  retryable: boolean;
  suggestion: string;
}
```

**Error messages**:
```
[timeout] Query exceeded 10s limit. Consider adding indexes or limiting scope.
[connection_failed] Database unreachable after 2s. Check network/firewall.
[pool_exhausted] All 5 connections busy. Try again shortly.
[circuit_open] Database marked unhealthy. Automatic retry in 30s.
[query_error] SQL error: <pg message>
[permission_denied] Access denied: <details>
```

---

## Configuration (v2.0)

```typescript
interface NeverhangConfig {
  // Timeouts
  base_timeout_ms: number;        // Default: 10000
  connection_timeout_ms: number;  // Default: 2000 (down from 10000)
  health_check_timeout_ms: number; // Default: 2000

  // Pool
  max_connections: number;        // Default: 5
  min_connections: number;        // Default: 1
  connection_ttl_ms: number;      // Default: 300000 (5 min)
  idle_timeout_ms: number;        // Default: 60000
  validate_on_borrow: boolean;    // Default: true

  // Circuit breaker
  circuit_failure_threshold: number;  // Default: 5
  circuit_failure_window_ms: number;  // Default: 60000
  circuit_open_duration_ms: number;   // Default: 30000
  circuit_recovery_threshold: number; // Default: 2

  // Health monitor
  health_check_interval_ms: number;   // Default: 30000
  health_degraded_interval_ms: number; // Default: 5000

  // Adaptive timeout
  adaptive_timeout: boolean;      // Default: true
  min_timeout_ms: number;         // Default: 2000
  max_timeout_ms: number;         // Default: 30000
}
```

---

## Implementation Plan

### Phase 1: Foundation (v0.5.0-alpha)
- [ ] Refactor config to new structure
- [ ] Implement HealthMonitor with ping
- [ ] Add connection TTL to pool
- [ ] Reduce default timeouts (30s → 10s, 10s → 2s)

### Phase 2: Circuit Breaker (v0.5.0-beta)
- [ ] Implement CircuitBreaker class
- [ ] Integrate with query execution path
- [ ] Add circuit state to error responses
- [ ] Background health checks

### Phase 3: Adaptive & Polish (v0.5.0)
- [ ] Adaptive timeout based on query complexity
- [ ] Health-aware timeout multipliers
- [ ] NeverhangError with taxonomy
- [ ] Metrics/observability hooks

### Phase 4: Hardening (v0.5.1+)
- [ ] Validate on borrow
- [ ] Connection recycling under load
- [ ] Graceful shutdown
- [ ] Integration tests with fault injection

---

## Difficulty Assessment

| Component | Difficulty | Risk | Notes |
|-----------|------------|------|-------|
| Health Monitor | Low | Low | Simple ping, proven pattern |
| Connection TTL | Low | Medium | Need to handle mid-query recycle |
| Circuit Breaker | Medium | Medium | State machine, timing sensitive |
| Adaptive Timeout | Medium | Low | Heuristics may need tuning |
| Failure Taxonomy | Low | Low | Error wrapper, no logic change |
| Integration | Medium | High | Touching critical path |

**Overall**: Medium difficulty, 2-3 sessions to complete Phase 1-3.

---

## Success Criteria

1. **Fast-fail**: Unreachable DB fails in <3s, not 30s
2. **No zombies**: Stale connections detected and recycled
3. **Circuit protection**: Repeated failures trigger fast-reject
4. **Observable**: Every failure has type + duration + suggestion
5. **Backward compatible**: Old config still works, new features opt-in

---

## Open Questions

1. Should health checks run in MCP process or separate worker?
2. How to handle long-running EXPLAIN ANALYZE without tripping circuit?
3. Should we expose circuit state via a `pg_health` tool?
4. Is 10s base timeout too aggressive for complex queries?

---

*"Never hang" should mean never hang. Let's make it true.*
