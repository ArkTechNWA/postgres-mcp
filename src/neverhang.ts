/**
 * NEVERHANG v2.0 - Reliability is a methodology
 *
 * Components:
 * - HealthMonitor: Proactive database health detection
 * - CircuitBreaker: Fast-fail when database is known-bad
 * - AdaptiveTimeout: Adjust timeouts based on query complexity and health
 * - NeverhangError: Failure taxonomy with actionable information
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface NeverhangConfig {
  // Timeouts
  base_timeout_ms: number;
  connection_timeout_ms: number;
  health_check_timeout_ms: number;

  // Pool
  max_connections: number;
  min_connections: number;
  connection_ttl_ms: number;
  idle_timeout_ms: number;
  validate_on_borrow: boolean;

  // Circuit breaker
  circuit_failure_threshold: number;
  circuit_failure_window_ms: number;
  circuit_open_duration_ms: number;
  circuit_recovery_threshold: number;

  // Health monitor
  health_check_interval_ms: number;
  health_degraded_interval_ms: number;

  // Adaptive timeout
  adaptive_timeout: boolean;
  min_timeout_ms: number;
  max_timeout_ms: number;
}

export const DEFAULT_NEVERHANG_CONFIG: NeverhangConfig = {
  // Timeouts - aggressive defaults
  base_timeout_ms: 10000,
  connection_timeout_ms: 2000,
  health_check_timeout_ms: 2000,

  // Pool
  max_connections: 5,
  min_connections: 1,
  connection_ttl_ms: 300000, // 5 minutes
  idle_timeout_ms: 60000, // 1 minute
  validate_on_borrow: true,

  // Circuit breaker
  circuit_failure_threshold: 5,
  circuit_failure_window_ms: 60000,
  circuit_open_duration_ms: 30000,
  circuit_recovery_threshold: 2,

  // Health monitor
  health_check_interval_ms: 30000,
  health_degraded_interval_ms: 5000,

  // Adaptive timeout
  adaptive_timeout: true,
  min_timeout_ms: 2000,
  max_timeout_ms: 30000,
};

// ============================================================================
// FAILURE TAXONOMY
// ============================================================================

export type FailureType =
  | "timeout"
  | "connection_failed"
  | "pool_exhausted"
  | "circuit_open"
  | "query_error"
  | "permission_denied"
  | "cancelled";

export class NeverhangError extends Error {
  readonly type: FailureType;
  readonly duration_ms: number;
  readonly retryable: boolean;
  readonly suggestion: string;

  constructor(
    type: FailureType,
    message: string,
    duration_ms: number,
    options?: { cause?: Error }
  ) {
    super(message, options);
    this.name = "NeverhangError";
    this.type = type;
    this.duration_ms = duration_ms;
    this.retryable = type !== "permission_denied" && type !== "query_error";
    this.suggestion = NeverhangError.getSuggestion(type);
  }

  static getSuggestion(type: FailureType): string {
    switch (type) {
      case "timeout":
        return "Consider adding indexes, limiting scope, or increasing timeout.";
      case "connection_failed":
        return "Check network connectivity and database availability.";
      case "pool_exhausted":
        return "All connections busy. Try again shortly.";
      case "circuit_open":
        return "Database marked unhealthy. Automatic retry pending.";
      case "query_error":
        return "Check SQL syntax and constraints.";
      case "permission_denied":
        return "Verify database credentials and permissions.";
      case "cancelled":
        return "Query was cancelled.";
      default:
        return "Unknown error occurred.";
    }
  }

  toJSON() {
    return {
      type: this.type,
      message: this.message,
      duration_ms: this.duration_ms,
      retryable: this.retryable,
      suggestion: this.suggestion,
    };
  }
}

// ============================================================================
// HEALTH MONITOR
// ============================================================================

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthState {
  status: HealthStatus;
  last_check: Date | null;
  last_success: Date | null;
  last_failure: Date | null;
  latency_ms: number;
  latency_samples: number[];
  consecutive_failures: number;
  consecutive_successes: number;
}

export class HealthMonitor {
  private state: HealthState;
  private config: NeverhangConfig;
  private pingFn: () => Promise<void>;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: NeverhangConfig, pingFn: () => Promise<void>) {
    this.config = config;
    this.pingFn = pingFn;
    this.state = {
      status: "healthy", // Assume healthy until proven otherwise
      last_check: null,
      last_success: null,
      last_failure: null,
      latency_ms: 0,
      latency_samples: [],
      consecutive_failures: 0,
      consecutive_successes: 0,
    };
  }

  async ping(): Promise<{ ok: boolean; latency_ms: number }> {
    const start = Date.now();
    try {
      await this.pingFn();
      const latency = Date.now() - start;
      this.recordSuccess(latency);
      return { ok: true, latency_ms: latency };
    } catch (error) {
      const latency = Date.now() - start;
      this.recordFailure();
      return { ok: false, latency_ms: latency };
    }
  }

  private recordSuccess(latency_ms: number): void {
    this.state.last_check = new Date();
    this.state.last_success = new Date();
    this.state.latency_ms = latency_ms;
    this.state.consecutive_failures = 0;
    this.state.consecutive_successes++;

    // Keep last 10 samples for p95
    this.state.latency_samples.push(latency_ms);
    if (this.state.latency_samples.length > 10) {
      this.state.latency_samples.shift();
    }

    // Status transitions
    if (this.state.status === "unhealthy" && this.state.consecutive_successes >= 1) {
      this.state.status = "degraded";
      console.error("[neverhang] Health: unhealthy -> degraded");
    } else if (this.state.status === "degraded" && this.state.consecutive_successes >= 3) {
      this.state.status = "healthy";
      console.error("[neverhang] Health: degraded -> healthy");
    }
  }

  private recordFailure(): void {
    this.state.last_check = new Date();
    this.state.last_failure = new Date();
    this.state.consecutive_successes = 0;
    this.state.consecutive_failures++;

    // Status transitions
    if (this.state.status === "healthy" && this.state.consecutive_failures >= 1) {
      this.state.status = "degraded";
      console.error("[neverhang] Health: healthy -> degraded");
    } else if (this.state.status === "degraded" && this.state.consecutive_failures >= 3) {
      this.state.status = "unhealthy";
      console.error("[neverhang] Health: degraded -> unhealthy");
    }
  }

  getHealth(): HealthState {
    return { ...this.state };
  }

  getLatencyP95(): number {
    if (this.state.latency_samples.length === 0) return 0;
    const sorted = [...this.state.latency_samples].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  startBackgroundCheck(): void {
    if (this.intervalId) return;

    const check = async () => {
      await this.ping();

      // Adjust interval based on health
      const interval =
        this.state.status === "healthy"
          ? this.config.health_check_interval_ms
          : this.config.health_degraded_interval_ms;

      this.intervalId = setTimeout(check, interval);
    };

    // Start after initial delay
    this.intervalId = setTimeout(check, 5000);
  }

  stopBackgroundCheck(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number[];
  opened_at: Date | null;
  half_open_successes: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState;
  private config: NeverhangConfig;

  constructor(config: NeverhangConfig) {
    this.config = config;
    this.state = {
      state: "closed",
      failures: [],
      opened_at: null,
      half_open_successes: 0,
    };
  }

  canExecute(): boolean {
    this.cleanOldFailures();

    switch (this.state.state) {
      case "closed":
        return true;

      case "open":
        // Check if it's time to try half-open
        if (this.state.opened_at) {
          const elapsed = Date.now() - this.state.opened_at.getTime();
          if (elapsed >= this.config.circuit_open_duration_ms) {
            this.state.state = "half-open";
            this.state.half_open_successes = 0;
            console.error("[neverhang] Circuit: open -> half-open (testing)");
            return true;
          }
        }
        return false;

      case "half-open":
        return true;
    }
  }

  recordSuccess(): void {
    if (this.state.state === "half-open") {
      this.state.half_open_successes++;
      if (this.state.half_open_successes >= this.config.circuit_recovery_threshold) {
        this.state.state = "closed";
        this.state.failures = [];
        this.state.opened_at = null;
        console.error("[neverhang] Circuit: half-open -> closed (recovered)");
      }
    }
  }

  recordFailure(excludeFromCircuit: boolean = false): void {
    if (excludeFromCircuit) return;

    this.state.failures.push(Date.now());
    this.cleanOldFailures();

    if (this.state.state === "half-open") {
      // Any failure in half-open reopens the circuit
      this.state.state = "open";
      this.state.opened_at = new Date();
      console.error("[neverhang] Circuit: half-open -> open (test failed)");
      return;
    }

    if (this.state.state === "closed") {
      if (this.state.failures.length >= this.config.circuit_failure_threshold) {
        this.state.state = "open";
        this.state.opened_at = new Date();
        console.error(
          `[neverhang] Circuit: closed -> open (${this.state.failures.length} failures)`
        );
      }
    }
  }

  private cleanOldFailures(): void {
    const cutoff = Date.now() - this.config.circuit_failure_window_ms;
    this.state.failures = this.state.failures.filter((t) => t > cutoff);
  }

  getState(): CircuitState {
    this.cleanOldFailures();
    return this.state.state;
  }

  getOpenDuration(): number | null {
    if (this.state.state !== "open" || !this.state.opened_at) return null;
    return Date.now() - this.state.opened_at.getTime();
  }

  getTimeUntilHalfOpen(): number | null {
    if (this.state.state !== "open" || !this.state.opened_at) return null;
    const elapsed = Date.now() - this.state.opened_at.getTime();
    const remaining = this.config.circuit_open_duration_ms - elapsed;
    return Math.max(0, remaining);
  }

  getRecentFailures(): number {
    this.cleanOldFailures();
    return this.state.failures.length;
  }
}

// ============================================================================
// ADAPTIVE TIMEOUT
// ============================================================================

export interface QueryComplexity {
  has_join: boolean;
  has_subquery: boolean;
  table_count: number;
  has_aggregation: boolean;
  is_explain_analyze: boolean;
}

export class AdaptiveTimeout {
  private config: NeverhangConfig;

  constructor(config: NeverhangConfig) {
    this.config = config;
  }

  analyzeQuery(query: string): QueryComplexity {
    const upper = query.toUpperCase();
    return {
      has_join: /\bJOIN\b/.test(upper),
      has_subquery: /\(\s*SELECT\b/.test(upper),
      table_count: (upper.match(/\bFROM\b/g) || []).length,
      has_aggregation:
        /\b(COUNT|SUM|AVG|MAX|MIN|GROUP BY)\b/.test(upper),
      is_explain_analyze:
        upper.includes("EXPLAIN") && upper.includes("ANALYZE"),
    };
  }

  getTimeout(
    query: string,
    healthStatus: HealthStatus,
    userOverride?: number
  ): { timeout_ms: number; reason: string } {
    // User override takes precedence (capped)
    if (userOverride !== undefined) {
      const capped = Math.min(
        Math.max(userOverride, this.config.min_timeout_ms),
        this.config.max_timeout_ms
      );
      return { timeout_ms: capped, reason: `user override (capped to ${capped}ms)` };
    }

    if (!this.config.adaptive_timeout) {
      return { timeout_ms: this.config.base_timeout_ms, reason: "adaptive disabled" };
    }

    const complexity = this.analyzeQuery(query);
    let multiplier = 1.0;
    const reasons: string[] = [];

    // EXPLAIN ANALYZE gets 3x and is excluded from circuit
    if (complexity.is_explain_analyze) {
      multiplier *= 3.0;
      reasons.push("EXPLAIN ANALYZE (3x)");
    } else {
      // Complexity multipliers (stack multiplicatively)
      if (complexity.has_join) {
        multiplier *= 1.5;
        reasons.push("JOIN (1.5x)");
      }
      if (complexity.has_subquery) {
        multiplier *= 2.0;
        reasons.push("subquery (2x)");
      }
      if (complexity.table_count > 1) {
        multiplier *= 1.5;
        reasons.push(`${complexity.table_count} tables (1.5x)`);
      }
      if (complexity.has_aggregation) {
        multiplier *= 1.5;
        reasons.push("aggregation (1.5x)");
      }
    }

    // Health multiplier
    switch (healthStatus) {
      case "healthy":
        // No change
        break;
      case "degraded":
        multiplier *= 0.5;
        reasons.push("degraded health (0.5x)");
        break;
      case "unhealthy":
        // Should be blocked by circuit breaker, but just in case
        multiplier *= 0.25;
        reasons.push("unhealthy (0.25x)");
        break;
    }

    let timeout = this.config.base_timeout_ms * multiplier;
    timeout = Math.min(
      Math.max(timeout, this.config.min_timeout_ms),
      this.config.max_timeout_ms
    );

    return {
      timeout_ms: Math.round(timeout),
      reason: reasons.length > 0 ? reasons.join(", ") : "base timeout",
    };
  }
}

// ============================================================================
// NEVERHANG MANAGER (Unified Interface)
// ============================================================================

export interface NeverhangStats {
  status: HealthStatus;
  circuit: CircuitState;
  circuit_opens_in: number | null;
  latency_ms: number;
  latency_p95_ms: number;
  recent_failures: number;
  last_success: Date | null;
  last_failure: Date | null;
}

export class NeverhangManager {
  readonly config: NeverhangConfig;
  readonly health: HealthMonitor;
  readonly circuit: CircuitBreaker;
  readonly timeout: AdaptiveTimeout;

  private startTime: Date;
  private totalQueries: number = 0;
  private successfulQueries: number = 0;

  constructor(config: Partial<NeverhangConfig>, pingFn: () => Promise<void>) {
    this.config = { ...DEFAULT_NEVERHANG_CONFIG, ...config };
    this.health = new HealthMonitor(this.config, pingFn);
    this.circuit = new CircuitBreaker(this.config);
    this.timeout = new AdaptiveTimeout(this.config);
    this.startTime = new Date();
  }

  start(): void {
    this.health.startBackgroundCheck();
  }

  stop(): void {
    this.health.stopBackgroundCheck();
  }

  canExecute(): { allowed: boolean; reason?: string } {
    if (!this.circuit.canExecute()) {
      const timeLeft = this.circuit.getTimeUntilHalfOpen();
      return {
        allowed: false,
        reason: `Circuit open. Retry in ${Math.ceil((timeLeft || 0) / 1000)}s`,
      };
    }
    return { allowed: true };
  }

  getTimeout(query: string, userOverride?: number): { timeout_ms: number; reason: string } {
    const healthState = this.health.getHealth();
    return this.timeout.getTimeout(query, healthState.status, userOverride);
  }

  isExcludedFromCircuit(query: string): boolean {
    const complexity = this.timeout.analyzeQuery(query);
    return complexity.is_explain_analyze;
  }

  recordSuccess(): void {
    this.totalQueries++;
    this.successfulQueries++;
    this.circuit.recordSuccess();
  }

  recordFailure(query: string): void {
    this.totalQueries++;
    const excluded = this.isExcludedFromCircuit(query);
    this.circuit.recordFailure(excluded);
  }

  getStats(): NeverhangStats {
    const healthState = this.health.getHealth();
    return {
      status: healthState.status,
      circuit: this.circuit.getState(),
      circuit_opens_in: this.circuit.getTimeUntilHalfOpen(),
      latency_ms: healthState.latency_ms,
      latency_p95_ms: this.health.getLatencyP95(),
      recent_failures: this.circuit.getRecentFailures(),
      last_success: healthState.last_success,
      last_failure: healthState.last_failure,
    };
  }

  getUptimePercent(): number {
    if (this.totalQueries === 0) return 100;
    return Math.round((this.successfulQueries / this.totalQueries) * 100);
  }
}
