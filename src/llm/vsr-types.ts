/**
 * vLLM Semantic Router integration types.
 *
 * When OpenClaw talks to the vLLM Semantic Router's OpenAI-compatible proxy,
 * the proxy returns routing decisions as `x-vsr-*` response headers on each
 * `/v1/chat/completions` call.
 *
 * This module defines the TypeScript types for capturing and displaying those
 * routing decisions in OpenClaw's TUI, Dashboard, and CLI.
 */

/**
 * Parsed vLLM Semantic Router decision metadata extracted from x-vsr-* headers.
 */
export interface RouterDecision {
  /** Selected model after routing decision (e.g., "Qwen3.5-9B-NoThinking") */
  selectedModel?: string;
  /** Decision rule that matched (e.g., "route_security_guard", "route_cloud_complex") */
  selectedDecision?: string;
  /** Confidence score for the decision (0.0-1.0) */
  selectedConfidence?: number;
  /** Matched structure signals (e.g., ["short_query", "any_query"]) */
  matchedStructure?: string[];
  /** Matched complexity classification (e.g., "needs_reasoning:medium") */
  matchedComplexity?: string;
  /** Matched jailbreak detection signal */
  matchedJailbreak?: string;
  /** Matched PII detection signal */
  matchedPii?: string;
  /** Context token count analyzed by the router */
  contextTokenCount?: number;
  /** Looper algorithm used (e.g., "confidence", "static") */
  looperAlgorithm?: string;
  /** Number of looper iterations (for confidence looping) */
  looperIterations?: number;
  /** Models used during looper execution (e.g., ["Qwen3.5-9B", "Kimi-K2"]) */
  looperModelsUsed?: string[];
}

/**
 * Raw x-vsr-* HTTP headers returned by the vLLM Semantic Router proxy.
 */
export interface RouterHeaders {
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
}
