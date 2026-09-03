import { describe, expect, it } from "vitest";
import { assessFitRequest, assessFitTarget, evaluateConstraints } from "../../src/domain/layout-assessment";
import type { FitRequest } from "../../src/domain/fit-contract";
import type { Furniture, FurnitureCatalogId, WorkingState } from "../../src/domain/types";

const chair = (id: string, xMm: number, yMm: number, locked = false): Furniture => ({ id, catalogId: "chair-600x600", xMm, yMm, rotationDeg: 0, locked });
const state = (): WorkingState => ({ schemaVersion: 1, templateId: "home-office", room: { widthMm: 4000, depthMm: 4000 },
  furniture: [chair("chair-a", 1000, 1000), chair("chair-b", 2000, 1000)], features: [], constraints: [] });
// Identity is only syntactic here; the store tests exercise authoritative hashing.
const request = (baseline = state()): FitRequest => ({ contractVersion: "human-fit/1", requestId: "assessment-request-01", generation: 1,
  templateId: baseline.templateId, baseRevision: 1, baseHash: "a".repeat(64), baseline, targetRoom: baseline.room, additions: [] });
const codes = (req: FitRequest, target: unknown) => assessFitTarget(req, target).issues.map(issue => issue.code);

describe("independent complete target assessment", () => {
  it("requires the full ordered baseline plus requested union, exact room, features, constraints, locks and identities", () => {
    const baseline = { ...state(), furniture: [chair("chair-a", 1000, 1000, true)] };
    const req: FitRequest = { ...request(baseline), targetRoom: { widthMm: 4500, depthMm: 4200 }, additions: [{ id: "requested-a", catalogId: "bookcase-800x350", locked: false }] };
    const target: WorkingState = { ...baseline, room: req.targetRoom, furniture: [...baseline.furniture,
      { id: "requested-a", catalogId: "bookcase-800x350", xMm: 3000, yMm: 3000, rotationDeg: 90, locked: false }] };
    expect(assessFitTarget(req, target)).toMatchObject({ hardValid: true, requiredSatisfied: true });
    for (const furniture of [target.furniture.slice(0, 1), [...target.furniture].reverse(), [...target.furniture, chair("invented", 4000, 3000)],
      target.furniture.map(i => i.id === "requested-a" ? { ...i, catalogId: "chair-600x600" as const } : i),
      target.furniture.map(i => i.id === "requested-a" ? { ...i, locked: true } : i)]) {
      expect(codes(req, { ...target, furniture })).toContain("MEMBERSHIP_MISMATCH");
    }
    expect(codes(req, { ...target, furniture: target.furniture.map(i => i.id === "chair-a" ? { ...i, rotationDeg: 180 } : i) })).toContain("LOCKED_ITEM_CHANGED");
    for (const invalid of [{ ...target, room: baseline.room }, { ...target, features: [{ id: "extra", catalogId: "door-900", wall: "north", offsetMm: 0 }] },
      { ...target, constraints: [{ constraintId: "extra", type: "item_distance", itemAId: "chair-a", itemBId: "requested-a", relation: "near", thresholdMm: 4000, strength: "preferred" }] }]) {
      expect(assessFitTarget(req, invalid).hardValid).toBe(false);
    }
  });

  it("checks unmoved old furniture too, before evaluating any required or preferred constraint", () => {
    const baseline: WorkingState = { ...state(), constraints: [
      { constraintId: "required", type: "item_distance", itemAId: "chair-a", itemBId: "chair-b", relation: "near", thresholdMm: 4000, strength: "required" },
      { constraintId: "preferred", type: "item_distance", itemAId: "chair-a", itemBId: "chair-b", relation: "away", thresholdMm: 4000, strength: "preferred" },
    ] };
    const req = { ...request(baseline), targetRoom: { widthMm: 2000, depthMm: 2000 } };
    expect(assessFitRequest(req).ok).toBe(true); // unlocked old pose can fall outside requested room
    const result = assessFitTarget(req, { ...baseline, room: req.targetRoom });
    expect(result).toMatchObject({ hardValid: false, requiredSatisfied: false, constraintResults: [], required: { satisfied: 0, total: 1 }, preferred: { satisfied: 0, total: 1 } });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ITEM_OUT_OF_BOUNDS", itemIds: ["chair-b"] })]));
  });

  it.each([
    ["desk-1400x700", 1400, 700], ["chair-600x600", 600, 600], ["storage-800x400", 800, 400], ["bed-2000x1600", 2000, 1600],
    ["nightstand-500x400", 500, 400], ["wardrobe-1200x600", 1200, 600], ["table-1200x800", 1200, 800], ["bookcase-800x350", 800, 350],
  ] as const)("uses literal %s footprints at inclusive bounds for all four rotations", (catalogId, width, depth) => {
    for (const rotationDeg of [0, 90, 180, 270] as const) {
      const [w, d] = rotationDeg % 180 ? [depth, width] : [width, depth];
      const baseline = { ...state(), furniture: [] };
      const req: FitRequest = { ...request(baseline), additions: [{ id: "requested", catalogId, locked: false }] };
      const item = { id: "requested", catalogId, rotationDeg, xMm: w / 2, yMm: d / 2, locked: false };
      expect(assessFitTarget(req, { ...baseline, furniture: [item] }).hardValid).toBe(true);
      expect(codes(req, { ...baseline, furniture: [{ ...item, xMm: item.xMm - 1 }] })).toContain("ITEM_OUT_OF_BOUNDS");
    }
  });

  it("allows exact touching but rejects one millimetre positive overlap for every unordered pair", () => {
    const baseline = { ...state(), furniture: [chair("chair-a", 300, 300), chair("chair-b", 900, 300), chair("chair-c", 1500, 300)] };
    const req = request(baseline);
    expect(assessFitTarget(req, baseline).hardValid).toBe(true);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const furniture = baseline.furniture.map((item, i) => i === b ? { ...item, xMm: baseline.furniture[a].xMm + 599 } : item);
      expect(assessFitTarget(req, { ...baseline, furniture }).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ITEM_OVERLAP", itemIds: expect.arrayContaining([baseline.furniture[a].id, baseline.furniture[b].id]) }),
      ]));
    }
  });

  it.each(["north", "east", "south", "west"] as const)("uses radiator300 keep-out but150 physical distance on %s", wall => {
    const vertical = wall === "east" || wall === "west";
    const near = wall === "north" || wall === "west" ? 600 : 3400;
    const item = chair("chair-a", vertical ? near : 1000, vertical ? 1000 : near);
    const baseline: WorkingState = { ...state(), furniture: [item], features: [{ id: "rad", catalogId: "radiator-900", wall, offsetMm: 550 }],
      constraints: [{ constraintId: "distance", type: "feature_distance", itemId: "chair-a", featureId: "rad", relation: "near", thresholdMm: 150, strength: "required" }] };
    expect(assessFitTarget(request(baseline), baseline)).toMatchObject({ hardValid: true, requiredSatisfied: true,
      constraintResults: [expect.objectContaining({ actualMm: 150, satisfied: true })] });
    const blocked = { ...item, [vertical ? "xMm" : "yMm"]: near + (near < 2000 ? -1 : 1) };
    expect(assessFitTarget(request(baseline), { ...baseline, furniture: [blocked] }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FEATURE_KEEP_OUT_INTERSECTION", itemIds: ["chair-a"], featureId: "rad" }),
    ]));
  });

  it("preserves floor-distance1 for a diagonal and current constraint ordering without using the solver", () => {
    const baseline: WorkingState = { ...state(), furniture: [chair("chair-a", 1000, 1000), chair("chair-b", 1601, 1601)], constraints: [
      { constraintId: "near", type: "item_distance", itemAId: "chair-a", itemBId: "chair-b", relation: "near", thresholdMm: 1, strength: "required" },
      { constraintId: "away", type: "item_distance", itemAId: "chair-a", itemBId: "chair-b", relation: "away", thresholdMm: 2, strength: "preferred" },
    ] };
    const rows = evaluateConstraints(baseline, baseline.furniture);
    expect(rows).toEqual([
      { constraintId: "near", type: "item_distance", strength: "required", satisfied: true, operator: "lte", actualMm: 1, targetMm: 1 },
      { constraintId: "away", type: "item_distance", strength: "preferred", satisfied: false, operator: "gte", actualMm: 1, targetMm: 2 },
    ]);
    expect(assessFitTarget(request(baseline), baseline)).toMatchObject({ hardValid: true, requiredSatisfied: true, required: { satisfied: 1, total: 1 }, preferred: { satisfied: 0, total: 1 } });
  });

  it("fails closed on invalid full inputs, bounded identities/counts and corridor extents without clipping", () => {
    const req = request();
    const malformed: unknown[] = [null, [], { ...req, extra: true }, { ...req, generation: -0 }, { ...req, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...req, requestId: "short" }, { ...req, requestId: "a".repeat(81) }, { ...req, requestId: "<script>injected</script>" },
      { ...req, targetRoom: { widthMm: 1999, depthMm: 4000 } }, { ...req, targetRoom: { widthMm: 12001, depthMm: 4000 } },
      { ...req, targetRoom: { widthMm: NaN, depthMm: 4000 } }, { ...req, targetRoom: { widthMm: 4000.1, depthMm: 4000 } },
      { ...req, additions: [{ id: "chair-a", catalogId: "chair-600x600", locked: false }] },
      { ...req, additions: Array.from({ length: 7 }, (_, i) => ({ id: `extra-${i}`, catalogId: "chair-600x600", locked: false })) },
      { ...req, additions: [{ id: "extra", catalogId: "not-catalog" as FurnitureCatalogId, locked: false }] },
      { ...req, additions: [{ id: "extra", catalogId: "chair-600x600", locked: true }] },
      { ...req, baseline: { ...req.baseline, furniture: req.baseline.furniture.map((item, i) => i === 0 ? { ...item, xMm: -0 } : item) } },
      request({ ...state(), features: Array.from({ length: 9 }, (_, i) => ({ id: `window-${i}`, catalogId: "window-1400" as const, wall: "north" as const, offsetMm: 0 })) }),
      request({ ...state(), constraints: Array.from({ length: 9 }, (_, i) => ({ constraintId: `constraint-${i}`, type: "item_distance" as const,
        itemAId: "chair-a", itemBId: "chair-b", relation: "near" as const, thresholdMm: 1000, strength: "preferred" as const })) }),
    ];
    const door: WorkingState = { ...state(), features: [{ id: "door", catalogId: "door-900", wall: "north", offsetMm: 0 }],
      constraints: [{ constraintId: "path", type: "door_path_clear", featureId: "door", widthMm: 1000, strength: "required" }] };
    malformed.push(request(door)); // centre450, width1000 extends50mm outside the wall
    for (const value of malformed) {
      const result = assessFitRequest(value);
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(JSON.stringify(result)).not.toMatch(/injected|script|NaN/);
    }
  });
});
