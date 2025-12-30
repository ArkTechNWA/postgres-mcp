/**
 * postgres-mcp utilities
 */

/**
 * Wrap a promise with a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Operation timed out"
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number | string | null | undefined): string {
  // Handle null/undefined
  if (bytes === null || bytes === undefined) return "N/A";

  // Coerce to number (handles string "0" from DB)
  const num = typeof bytes === "string" ? parseFloat(bytes) : bytes;

  // Handle edge cases
  if (isNaN(num) || num < 0) return "N/A";
  if (num === 0) return "0 B";
  if (num > 1e18) return "N/A";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(k)), sizes.length - 1);
  return `${(num / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Format row count with commas
 */
export function formatRowCount(count: number): string {
  return count.toLocaleString();
}

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Check if a table/column matches any pattern in a blacklist
 */
export function matchesBlacklist(name: string, patterns: string[]): boolean {
  const lowerName = name.toLowerCase();

  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();

    // Exact match
    if (lowerName === lowerPattern) return true;

    // Wildcard matching
    if (lowerPattern.includes("*")) {
      const regex = new RegExp("^" + lowerPattern.replace(/\*/g, ".*") + "$");
      if (regex.test(lowerName)) return true;
    }

    // Contains match for column names
    if (lowerName.includes(lowerPattern)) return true;
  }

  return false;
}

/**
 * Check if query contains blocked patterns
 */
export function containsBlockedPattern(query: string, patterns: string[]): string | null {
  const upperQuery = query.toUpperCase();

  for (const pattern of patterns) {
    if (upperQuery.includes(pattern.toUpperCase())) {
      return pattern;
    }
  }

  return null;
}
