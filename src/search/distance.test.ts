import { describe, test, expect } from "bun:test";
import { distanceToCosineSimilarity } from "./distance.ts";
import { normalizeL2 } from "../indexer/embedder.ts";

function l2Distance(a: Float32Array, b: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq);
}

describe("distanceToCosineSimilarity", () => {
  test("identical normalized vectors → sim ≈ 1", () => {
    const a = normalizeL2(new Float32Array([1, 2, 3, 4]));
    const d = l2Distance(a, a);
    expect(distanceToCosineSimilarity(d)).toBeCloseTo(1.0, 6);
  });

  test("orthogonal normalized vectors → sim ≈ 0", () => {
    const a = normalizeL2(new Float32Array([1, 0, 0]));
    const b = normalizeL2(new Float32Array([0, 1, 0]));
    const d = l2Distance(a, b);
    // cos(a,b)=0 → L2=√2 → sim=1-2/2=0
    expect(distanceToCosineSimilarity(d)).toBeCloseTo(0, 6);
  });

  test("antipodal normalized vectors → sim ≈ -1", () => {
    const a = normalizeL2(new Float32Array([1, 0]));
    const b = normalizeL2(new Float32Array([-1, 0]));
    const d = l2Distance(a, b);
    // L2=2 → sim=1-4/2=-1
    expect(distanceToCosineSimilarity(d)).toBeCloseTo(-1, 6);
  });

  test("clamps to [-1, 1] for numeric noise", () => {
    // distance slightly > 2 shouldn't drop below -1
    expect(distanceToCosineSimilarity(2.0001)).toBeGreaterThanOrEqual(-1);
    expect(distanceToCosineSimilarity(0)).toBe(1);
  });
});

describe("normalizeL2", () => {
  test("unit-norm output", () => {
    const v = normalizeL2(new Float32Array([3, 4]));
    // 3,4 → 5 → (0.6, 0.8)
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    expect(sumSq).toBeCloseTo(1, 6);
  });

  test("zero vector passes through unchanged", () => {
    const v = normalizeL2(new Float32Array([0, 0, 0]));
    expect(Array.from(v)).toEqual([0, 0, 0]);
  });
});
