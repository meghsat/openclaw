// vLLM Semantic Router decision header parser and formatter.
import type { RouterDecision } from "./vsr-types.js";

type RouterHeaders = {
  "x-vsr-selected-model"?: string;
  "x-vsr-selected-decision"?: string;
  "x-vsr-selected-confidence"?: string;
  "x-vsr-matched-structure"?: string;
  "x-vsr-matched-complexity"?: string;
  "x-vsr-matched-jailbreak"?: string;
  "x-vsr-matched-pii"?: string;
  "x-vsr-context-token-count"?: string;
  "x-vsr-looper-algorithm"?: string;
  "x-vsr-looper-iterations"?: string;
  "x-vsr-looper-models-used"?: string;
};

const VSR_PREFIX = "x-vsr-";

/** Extract vLLM Semantic Router decision from HTTP response headers, or undefined if none. */
export function extractRouterDecision(headers: Record<string, string>): RouterDecision | undefined {
  const vsrHeaders: Partial<RouterHeaders> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith(VSR_PREFIX)) {
      vsrHeaders[lowerKey as keyof RouterHeaders] = value;
    }
  }

  if (Object.keys(vsrHeaders).length === 0) {
    return undefined;
  }

  return {
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
}

/** Format router decision as a compact summary line for TUI/CLI display. */
export function formatRouterDecisionSummary(decision: RouterDecision): string {
  const parts: string[] = [];

  const model = decision.selectedModel || "?";
  parts.push(`🧭 router → ${model}`);

  if (decision.selectedDecision) {
    let seg = `decision=${decision.selectedDecision}`;
    if (decision.selectedConfidence !== undefined) {
      seg += ` (conf ${decision.selectedConfidence.toFixed(2)})`;
    }
    parts.push(seg);
  }

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

function parseFloatSafe(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = parseFloat(value);
  return isNaN(num) ? undefined : num;
}

function parseIntSafe(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const num = parseInt(value, 10);
  return isNaN(num) ? undefined : num;
}

function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
