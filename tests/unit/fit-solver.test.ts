import { describe, expect, it } from "vitest";
import Logic from "logic-solver";
import { encodeSquaredGapSum, solveFitRequest } from "../../src/domain/fit-solver";
import { hashWorkingState } from "../../src/domain/hash";
import type { FitAddition, FitRequest, FitWorkerResponse } from "../../src/domain/fit-contract";
import type { Constraint, Feature, Furniture, FurnitureCatalogId, WorkingState } from "../../src/domain/types";

// Independent literal catalogue and BigInt predicates: never import production
// geometry, catalogue, assessment or validator to decide expected satisfiability.
const sizes: Record<FurnitureCatalogId, readonly [number, number]> = {
  "desk-1400x700": [1400, 700], "chair-600x600": [600, 600], "storage-800x400": [800, 400],
  "bed-2000x1600": [2000, 1600], "nightstand-500x400": [500, 400],
  "wardrobe-1200x600": [1200, 600], "table-1200x800": [1200, 800], "bookcase-800x350": [800, 350],
};
type Box = readonly [bigint, bigint, bigint, bigint];
const max = (...values: bigint[]) => values.reduce((a, b) => a > b ? a : b);
function box(item: Furniture): Box {
  const dimensions = sizes[item.catalogId];
  const [w, d] = item.rotationDeg === 90 || item.rotationDeg === 270 ? [dimensions[1], dimensions[0]] : dimensions;
  return [2n * BigInt(item.xMm) - BigInt(w), 2n * BigInt(item.yMm) - BigInt(d),
    2n * BigInt(item.xMm) + BigInt(w), 2n * BigInt(item.yMm) + BigInt(d)];
}
const overlap = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
function sqrt(value: bigint): bigint {
  let low = 0n, high = value + 1n;
  while (high - low > 1n) { const middle = (low + high) / 2n; if (middle * middle <= value) low = middle; else high = middle; }
  return low;
}
function distance(a: Box, b: Box): bigint {
  const x = max(0n, a[0] - b[2], b[0] - a[2]), y = max(0n, a[1] - b[3], b[1] - a[3]);
  return sqrt(x * x + y * y) / 2n;
}
function featureBox(feature: Feature, state: WorkingState, keepOut = false): Box {
  const span = feature.catalogId === "window-1400" ? 2800n : 1800n;
  const depth = feature.catalogId === "radiator-900" ? (keepOut ? 600n : 300n) : 0n;
  const offset = 2n * BigInt(feature.offsetMm), w = 2n * BigInt(state.room.widthMm), d = 2n * BigInt(state.room.depthMm);
  switch (feature.wall) {
    case "north": return [offset, 0n, offset + span, depth];
    case "south": return [offset, d - depth, offset + span, d];
    case "west": return [0n, offset, depth, offset + span];
    case "east": return [w - depth, offset, w, offset + span];
  }
}
function constraintPass(state: WorkingState, constraint: Constraint): boolean {
  const item = (id: string) => box(state.furniture.find(value => value.id === id)!);
  if (constraint.type === "door_path_clear") {
    const feature = state.features.find(value => value.id === constraint.featureId)!;
    const center = 2n * BigInt(feature.offsetMm) + 900n, half = BigInt(constraint.widthMm);
    const w = BigInt(state.room.widthMm), d = BigInt(state.room.depthMm);
    const corridor: Box = feature.wall === "north" ? [center - half, 0n, center + half, d]
      : feature.wall === "south" ? [center - half, d, center + half, 2n * d]
      : feature.wall === "west" ? [0n, center - half, w, center + half]
      : [w, center - half, 2n * w, center + half];
    if (corridor[0] < 0n || corridor[1] < 0n || corridor[2] > 2n * w || corridor[3] > 2n * d) return false;
    return state.furniture.every(value => !overlap(box(value), corridor));
  }
  const first = item(constraint.type === "item_distance" ? constraint.itemAId : constraint.itemId);
  const second = constraint.type === "item_distance" ? item(constraint.itemBId)
    : featureBox(state.features.find(value => value.id === constraint.featureId)!, state);
  const actual = distance(first, second), threshold = BigInt(constraint.thresholdMm);
  return constraint.relation === "near" ? actual <= threshold : actual >= threshold;
}
function feasible(state: WorkingState): boolean {
  const boxes = state.furniture.map(box);
  return boxes.every(a => a[0] >= 0n && a[1] >= 0n && a[2] <= 2n * BigInt(state.room.widthMm) && a[3] <= 2n * BigInt(state.room.depthMm))
    && boxes.every((a, i) => boxes.slice(i + 1).every(b => !overlap(a, b)))
    && state.features.filter(f => f.catalogId === "radiator-900").every(f => boxes.every(a => !overlap(a, featureBox(f, state, true))))
    && state.constraints.filter(c => c.strength === "required").every(c => constraintPass(state, c));
}
const empty = (): WorkingState => ({ schemaVersion: 1, templateId: "home-office", room: { widthMm: 2000, depthMm: 2000 }, furniture: [], features: [], constraints: [] });
async function request(baseline = empty(), additions: readonly FitAddition[] = []): Promise<FitRequest> {
  return { contractVersion: "human-fit/1", requestId: "fit-test-request-0001", generation: 1,
    templateId: baseline.templateId, baseRevision: 1, baseHash: await hashWorkingState(baseline), baseline, targetRoom: baseline.room, additions };
}
function witness(req: FitRequest, response: FitWorkerResponse): WorkingState {
  expect(response).toMatchObject({ kind: "result", requestId: req.requestId, generation: req.generation, status: "FOUND" });
  if (response.kind !== "result" || response.status !== "FOUND") throw new Error("Expected complete SAT witness");
  const target = response.target;
  expect(target.room).toEqual(req.targetRoom); expect(target.features).toEqual(req.baseline.features); expect(target.constraints).toEqual(req.baseline.constraints);
  expect(target.furniture.map(({ id, catalogId, locked }) => ({ id, catalogId, locked })))
    .toEqual([...req.baseline.furniture, ...req.additions].map(({ id, catalogId, locked }) => ({ id, catalogId, locked })));
  for (const item of target.furniture) {
    expect(Number.isSafeInteger(item.xMm) && Number.isSafeInteger(item.yMm)).toBe(true);
    expect([0, 90, 180, 270]).toContain(item.rotationDeg);
    const original = req.baseline.furniture.find(value => value.id === item.id);
    if (original?.locked) expect(item).toEqual(original);
  }
  expect(feasible(target)).toBe(true);
  return target;
}

describe("human fit exact finite solver and independent oracles", () => {
  it("uses the production square circuit, including every carry through bit30", () => {
    const pairs = [...Array.from({ length: 15 }, (_, bit) => [2 ** bit - 1, 1]),
      [0, 0], [1, 1], [3, 7], [31, 32], [255, 256], [1023, 1024], [16383, 16384], [23999, 24000], [24000, 24000]];
    const solver = new Logic.Solver();
    const results = pairs.map(([x, y], index) => {
      const left = Logic.variableBits(`oracle-x-${index}`, 15), right = Logic.variableBits(`oracle-y-${index}`, 15);
      solver.require(Logic.equalBits(left, Logic.constantBits(x)), Logic.equalBits(right, Logic.constantBits(y)));
      const result = encodeSquaredGapSum(left, right);
      expect(result.bits.length).toBeLessThanOrEqual(31);
      return { result, expected: Number(BigInt(x) ** 2n + BigInt(y) ** 2n) };
    });
    const solved = solver.solve(); expect(solved).not.toBeNull();
    for (const value of results) expect(solved!.evaluate(value.result)).toBe(value.expected);
    expect(results.at(-1)!.expected).toBe(1_152_000_000);
  });

  it.each(Object.keys(sizes) as FurnitureCatalogId[])("decodes the fixed %s catalogue footprint into a complete witness", async catalogId => {
    const req = await request(empty(), [{ id: "requested-catalog", catalogId, locked: false }]);
    witness(req, solveFitRequest(req));
  });

  it("enumerates all1604 legal bed poses and all2572816 ordered pairs without changing production limits", async () => {
    const poses: Furniture[] = [];
    for (const rotationDeg of [0, 90, 180, 270] as const) {
      for (let coordinate = 800; coordinate <= 1200; coordinate++) {
        poses.push({ id: "bed-a", catalogId: "bed-2000x1600", locked: false, rotationDeg,
          xMm: rotationDeg % 180 === 0 ? 1000 : coordinate, yMm: rotationDeg % 180 === 0 ? coordinate : 1000 });
      }
    }
    expect(poses).toHaveLength(1604);
    expect(poses.every(item => feasible({ ...empty(), furniture: [item] }))).toBe(true);
    const boxes = poses.map(box); let pairs = 0, solutions = 0;
    for (const a of boxes) for (const b of boxes) { pairs++; if (!overlap(a, b)) solutions++; }
    expect(pairs).toBe(2_572_816); expect(solutions).toBe(0);
    const one = await request(empty(), [{ id: "bed-a", catalogId: "bed-2000x1600", locked: false }]);
    witness(one, solveFitRequest(one));
    const two = { ...one, additions: [...one.additions, { id: "bed-b", catalogId: "bed-2000x1600", locked: false as const }] };
    expect(solveFitRequest(two)).toEqual({ kind: "result", requestId: two.requestId, generation: 1, status: "PROVEN_IMPOSSIBLE" });
  }, 30_000);

  it.each([1601, 1602])("searches integer millimetres in the off-grid away%i fixture", async thresholdMm => {
    const baseline: WorkingState = { ...empty(), room: { widthMm: 2000, depthMm: 2201 },
      furniture: [{ id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false }],
      features: [{ id: "window-a", catalogId: "window-1400", wall: "north", offsetMm: 600 }],
      constraints: [{ constraintId: "away-window", type: "feature_distance", strength: "required", itemId: "chair-a", featureId: "window-a", relation: "away", thresholdMm }] };
    const req = await request(baseline), result = solveFitRequest(req);
    if (thresholdMm === 1601) {
      const target = witness(req, result); expect(target.furniture[0].yMm).toBe(1901); expect(target.furniture[0].yMm % 50).not.toBe(0);
    } else expect(result).toMatchObject({ kind: "result", status: "PROVEN_IMPOSSIBLE" });
  });

  it.each(["north", "east", "south", "west"] as const)("matches exhaustive legal bed/door/radiator constraints on the %s wall", async wall => {
    // Separate models: a missing door condition must not be hidden by radiator
    // infeasibility, or vice versa. All1604 legal poses are exhaustively checked.
    for (const kind of ["door", "radiator"] as const) {
      const baseline: WorkingState = { ...empty(), features: [
        { id: "feature-a", catalogId: kind === "door" ? "door-900" : "radiator-900", wall, offsetMm: 550 },
      ], constraints: kind === "door" ? [{ constraintId: "door-path", type: "door_path_clear", strength: "required", featureId: "feature-a", widthMm: 500 }] : [] };
      const req = await request(baseline, [{ id: "bed-a", catalogId: "bed-2000x1600", locked: false }]);
      let count = 0;
      for (const rotationDeg of [0, 90, 180, 270] as const) for (let n = 800; n <= 1200; n++) {
        const item: Furniture = { id: "bed-a", catalogId: "bed-2000x1600", locked: false, rotationDeg, xMm: rotationDeg % 180 ? n : 1000, yMm: rotationDeg % 180 ? 1000 : n };
        if (feasible({ ...baseline, furniture: [item] })) count++;
      }
      expect(count).toBe(kind === "door" ? 0 : 202);
      if (count) witness(req, solveFitRequest(req));
      else expect(solveFitRequest(req)).toMatchObject({ kind: "result", status: "PROVEN_IMPOSSIBLE" });
    }
  });

  it.each([0, 90, 180, 270] as const)("preserves exact locked rotation%i and full catalogue footprint", async rotationDeg => {
    const baseline: WorkingState = { ...empty(), furniture: [{ id: "bed-a", catalogId: "bed-2000x1600", xMm: 1000, yMm: 1000, rotationDeg, locked: true }] };
    const req = await request(baseline); witness(req, solveFitRequest(req));
    expect(solveFitRequest({ ...req, targetRoom: { widthMm: 2000, depthMm: 2000 }, additions: [{ id: "bed-b", catalogId: "bed-2000x1600", locked: false }] })).toMatchObject({ status: "PROVEN_IMPOSSIBLE" });
  });

  it("treats a locked pose outside a smaller requested room as finite UNSAT, not malformed input or silent unlocking", async () => {
    const baseline: WorkingState = { ...empty(), room: { widthMm: 3000, depthMm: 3000 }, furniture: [
      { id: "locked-chair", catalogId: "chair-600x600", xMm: 2500, yMm: 2500, rotationDeg: 270, locked: true },
    ] };
    const req = { ...await request(baseline), targetRoom: { widthMm: 2000, depthMm: 2000 } };
    expect(solveFitRequest(req)).toEqual({ kind: "result", requestId: req.requestId, generation: 1, status: "PROVEN_IMPOSSIBLE" });
  });

  it("preserves floored diagonal near1/away1 and ignores preferred failure for feasibility", async () => {
    const baseline: WorkingState = { ...empty(), room: { widthMm: 3000, depthMm: 3000 }, furniture: [
      { id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: true },
      { id: "chair-b", catalogId: "chair-600x600", xMm: 1601, yMm: 1601, rotationDeg: 270, locked: true },
    ], constraints: [
      { constraintId: "near-one", type: "item_distance", strength: "required", itemAId: "chair-a", itemBId: "chair-b", relation: "near", thresholdMm: 1 },
      { constraintId: "away-one", type: "item_distance", strength: "required", itemAId: "chair-a", itemBId: "chair-b", relation: "away", thresholdMm: 1 },
      { constraintId: "preferred-away", type: "item_distance", strength: "preferred", itemAId: "chair-a", itemBId: "chair-b", relation: "away", thresholdMm: 4000 },
    ] };
    const req = await request(baseline); witness(req, solveFitRequest(req));
    const impossible = { ...baseline, constraints: baseline.constraints.map(c => c.constraintId === "preferred-away" ? { ...c, strength: "required" as const } : c) };
    expect(solveFitRequest(await request(impossible))).toMatchObject({ status: "PROVEN_IMPOSSIBLE" });
  });

  it.each([1601, 1602])("enforces the strict near1 upper boundary for a locked chair at x%i", async xMm => {
    const baseline: WorkingState = { ...empty(), room: { widthMm: 3000, depthMm: 3000 }, furniture: [
      { id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: true },
      { id: "chair-b", catalogId: "chair-600x600", xMm, yMm: 1000, rotationDeg: 0, locked: true },
    ], constraints: [
      { constraintId: "near-one", type: "item_distance", strength: "required", itemAId: "chair-a", itemBId: "chair-b", relation: "near", thresholdMm: 1 },
    ] };
    const a = box(baseline.furniture[0]), b = box(baseline.furniture[1]);
    const x = max(0n, a[0] - b[2], b[0] - a[2]), y = max(0n, a[1] - b[3], b[1] - a[3]);
    expect(x * x + y * y).toBe(xMm === 1601 ? 4n : 16n);
    expect(distance(a, b)).toBe(xMm === 1601 ? 1n : 2n);
    expect(feasible(baseline)).toBe(xMm === 1601);
    const req = await request(baseline), result = solveFitRequest(req);
    if (xMm === 1601) expect(witness(req, result)).toEqual(baseline);
    else expect(result).toEqual({ kind: "result", requestId: req.requestId, generation: req.generation, status: "PROVEN_IMPOSSIBLE" });
  });

  it.each([400, 401])("matches an independent all1604-pose bed oracle with required window distance%i", async thresholdMm => {
    const baseline: WorkingState = { ...empty(), furniture: [
      { id: "bed-a", catalogId: "bed-2000x1600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false },
    ], features: [{ id: "window-a", catalogId: "window-1400", wall: "north", offsetMm: 0 }], constraints: [
      { constraintId: "away-window", type: "feature_distance", strength: "required", itemId: "bed-a", featureId: "window-a", relation: "away", thresholdMm },
    ] };
    const legal: Furniture[] = [], satisfying: Furniture[] = [];
    for (const rotationDeg of [0, 90, 180, 270] as const) for (let coordinate = 800; coordinate <= 1200; coordinate++) {
      const item: Furniture = { ...baseline.furniture[0], rotationDeg,
        xMm: rotationDeg % 180 === 0 ? 1000 : coordinate, yMm: rotationDeg % 180 === 0 ? coordinate : 1000 };
      legal.push(item);
      expect(feasible({ ...baseline, constraints: [], furniture: [item] })).toBe(true);
      if (feasible({ ...baseline, furniture: [item] })) satisfying.push(item);
    }
    expect(legal).toHaveLength(1604); expect(satisfying).toHaveLength(thresholdMm === 400 ? 2 : 0);
    const req = await request(baseline), result = solveFitRequest(req);
    if (satisfying.length) {
      const fitted = witness(req, result);
      expect(satisfying).toContainEqual(fitted.furniture[0]);
      expect(distance(box(fitted.furniture[0]), featureBox(baseline.features[0], fitted))).toBe(400n);
    } else expect(result).toEqual({ kind: "result", requestId: req.requestId, generation: req.generation, status: "PROVEN_IMPOSSIBLE" });
  });

  it("accepts empty inventory and rejects malformed identity without reflecting raw text", async () => {
    const req = await request(); expect(witness(req, solveFitRequest(req)).furniture).toEqual([]);
    for (const input of [null, {}, { ...req, requestId: "<script>secret</script>" }, { ...req, generation: -0 }]) {
      const result = solveFitRequest(input);
      expect(result).toEqual({ kind: "protocol-error", status: "INTERNAL_ERROR" });
      expect(JSON.stringify(result)).not.toMatch(/secret|script|stack|message/);
    }
    expect(solveFitRequest({ ...req, unexpected: true })).toEqual({ kind: "result", requestId: req.requestId, generation: 1, status: "INVALID_REQUEST" });
  });
});
