import { CONFIG, TARGET_BITS } from "./config.js";

// =============================================================================
// Probability Math
// =============================================================================

/**
 * Calculate the minimum number of variations needed to achieve the desired
 * success rate for a given target.
 *
 * Failure probability: P(fail) = ((2^b - 1) / 2^b)^n
 * We want: P(fail) <= 1 / INVERSE_DESIRED_FAILURE_RATE
 *
 * Solving for n:
 * n >= ln(1/rate) / ln((2^b - 1) / 2^b)
 */
export function requiredVariations(
  targetBits: number,
  inverseFailureRate: number
): number {
  const totalSpace = Math.pow(2, targetBits);
  const failProbPerAttempt = (totalSpace - 1) / totalSpace;

  const desiredFailureProb = 1 / inverseFailureRate;

  // ln(desiredFailureProb) / ln(failProbPerAttempt)
  const n = Math.log(desiredFailureProb) / Math.log(failProbPerAttempt);

  return Math.ceil(n);
}

/**
 * Calculate the probability of failure given a number of variations.
 */
export function failureProbability(
  targetBits: number,
  variations: number
): number {
  const totalSpace = Math.pow(2, targetBits);
  const failProbPerAttempt = (totalSpace - 1) / totalSpace;
  return Math.pow(failProbPerAttempt, variations);
}

/**
 * Calculate entropy in bits from variation count.
 */
export function entropyBits(variations: number): number {
  return Math.log2(variations);
}

// =============================================================================
// Validation
// =============================================================================

export interface EntropyValidation {
  valid: boolean;
  variations: number;
  requiredVariations: number;
  entropyBits: number;
  requiredEntropyBits: number;
  failureProbability: number;
  targetFailureProbability: number;
}

export function validateEntropy(variations: number): EntropyValidation {
  const required = requiredVariations(
    TARGET_BITS,
    CONFIG.inverseDesiredFailureRate
  );
  const failProb = failureProbability(TARGET_BITS, variations);
  const targetFailProb = 1 / CONFIG.inverseDesiredFailureRate;

  return {
    valid: variations >= required,
    variations,
    requiredVariations: required,
    entropyBits: entropyBits(variations),
    requiredEntropyBits: entropyBits(required),
    failureProbability: failProb,
    targetFailureProbability: targetFailProb,
  };
}

export function formatEntropyError(validation: EntropyValidation): string {
  const lines = [
    `❌ Not enough entropy`,
    ``,
    `   Template variations: ${validation.variations.toLocaleString()} (${validation.entropyBits.toFixed(1)} bits)`,
    `   Required variations: ${validation.requiredVariations.toLocaleString()} (${validation.requiredEntropyBits.toFixed(1)} bits)`,
    ``,
    `   Failure probability: 1 in ${Math.round(1 / validation.failureProbability).toLocaleString()}`,
    `   Target probability:  1 in ${CONFIG.inverseDesiredFailureRate.toLocaleString()}`,
  ];
  return lines.join("\n");
}

