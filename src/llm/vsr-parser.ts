/**
 * vLLM Semantic Router decision header parser and formatter.
 *
 * Extracts routing decisions from `x-vsr-*` HTTP response headers and formats
 * them for display in OpenClaw's TUI, Dashboard, and CLI.
 */

import type { RouterDecision, RouterHeaders } from "./vsr-types.js";

const VSR_PREFIX = "x-vsr-";

/**
 * Extract vLLM Semantic Router decision from HTTP response headers.
 *
 * Scans for `x-vsr-*` headers (case-insensitive) and parses them into a
 * structured RouterDecision object. Returns undefined if no router headers
 * are present (i.e., the response came from a regular OpenAI endpoint, not
 * the vLLM Semantic Router proxy).
 *
 * @param headers - HTTP response headers as a key-value record
 * @returns Parsed router decision or undefined if no router headers found
 */
export function extractRouterDecision(
  headers: Record<string, string>,
): RouterDecision | undefined {
  const vsrHeaders: Partial<RouterHeaders> = {};

  // Extract all x-vsr-* headers (case-insensitive)
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith(VSR_PREFIX)) {
      vsrHeaders[lowerKey as keyof RouterHeaders] = value;
    }
  }

  // If no router headers found, return undefined
  if (Object.keys(vsrHeaders).length === 0) {
    return undefined;
  }

  // Parse structured decision object
  const decision: RouterDecision = {
    selectedModel: vsrHeaders["x-vsr-selected-model"],
    selectedDecision: vsrHeaders["x-vsr-selected-decision"],
    selectedConfidence: parseFloatSafe(vsrHeaders["x-vsr-selected-confidence"]),
    matchedStructure: parseCommaSeparated(vsrHeaders["x-vsr-matched-structure"]),
    matchedComplexity: vsrHeaders["x-vsr-matched-complexity"],
    matchedJailbreak: vsrHeaders["x-vsr-matched-jailbreak"],
    matchedPii: vsrHeaders["x-vsr-matched-pii"],
    contextTokenCount: parseIntSafe(vsrHeaders["x-vsr-context-token-count"]),
    looperAlgorithm: vsrHeaders["x-vsr-looper-algorithm"],
    looperIterations: parseIntSafe(vsrHeaders["x-vsr-looper-iterations"]),
    looperModelsUsed: parseCommaSeparated(vsrHeaders["x-vsr-looper-models-used"]),
  };

  return decision;
}

/**
 * Format router decision as a compact one-line summary for display.
 *
 * Produces output similar to Hermes format:
 * "🧭 router → Qwen3.5-9B | decision=route_security_guard (conf 1.00) | structure=short_query,any_query | algo=static iters=1"
 *
 * @param decision - Parsed router decision
 * @returns Formatted summary string
 */
export function formatRouterDecisionSummary(decision: RouterDecision): string {
  const parts: string[] = [];

  // Model selection (always present)
  const model = decision.selectedModel || "?";
  parts.push(`🧭 router → ${model}`);

  // Decision name + confidence
  if (decision.selectedDecision) {
    let seg = `decision=${decision.selectedDecision}`;
    if (decision.selectedConfidence !== undefined) {
      seg += ` (conf ${decision.selectedConfidence.toFixed(2)})`;
    }
    parts.push(seg);
  }

  // Matched signals
  const signals: string[] = [];
  if (decision.matchedStructure && decision.matchedStructure.length > 0) {
    signals.push(`structure=${decision.matchedStructure.join(",")}`);
  }
  if (decision.matchedComplexity) {
    signals.push(`complexity=${decision.matchedComplexity}`);
  }
  if (decision.matchedJailbreak) {
    signals.push(`jailbreak=${decision.matchedJailbreak}`);
  }
  if (decision.matchedPii) {
    signals.push(`pii=${decision.matchedPii}`);
  }
  if (decision.contextTokenCount !== undefined) {
    signals.push(`ctx_tokens=${decision.contextTokenCount}`);
  }
  if (signals.length > 0) {
    parts.push(signals.join(" "));
  }

  // Looper metadata (for confidence looping)
  const loop: string[] = [];
  if (decision.looperAlgorithm) {
    loop.push(`algo=${decision.looperAlgorithm}`);
  }
  if (decision.looperIterations !== undefined) {
    loop.push(`iters=${decision.looperIterations}`);
  }
  if (decision.looperModelsUsed && decision.looperModelsUsed.length > 0) {
    const modelsUsed = decision.looperModelsUsed.join(",");
    if (modelsUsed !== model) {
      loop.push(`models=${modelsUsed}`);
    }
  }
  if (loop.length > 0) {
    parts.push(loop.join(" "));
  }

  return parts.join(" | ");
}

/**
 * Parse a string to float, returning undefined if invalid.
 */
function parseFloatSafe(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = parseFloat(value);
  return isNaN(num) ? undefined : num;
}

/**
 * Parse a string to integer, returning undefined if invalid.
 */
function parseIntSafe(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = parseInt(value, 10);
  return isNaN(num) ? undefined : num;
}

/**
 * Parse a comma-separated string into an array, returning undefined if empty.
 */
function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
