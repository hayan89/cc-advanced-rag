/**
 * Convert sqlite-vec's L2 distance to cosine similarity.
 *
 * Valid only when both vectors are L2-normalized (norm=1): then
 *   ‖a - b‖² = 2 - 2·cos(a, b) = 2·(1 - cos)
 * so cos = 1 - d²/2.
 *
 * Callers must ensure the index is built from normalized vectors (see
 * `normalizeL2` in src/indexer/embedder.ts). For zero vectors or numeric
 * noise the result is clamped to [-1, 1].
 */
export function distanceToCosineSimilarity(distance: number): number {
  const sim = 1 - (distance * distance) / 2;
  if (sim > 1) return 1;
  if (sim < -1) return -1;
  return sim;
}
