import { describe, expect, it } from "vitest";
import { assessCandidatePose } from "../../src/domain/layout-assessment";
import type { Pose, WorkingState } from "../../src/domain/types";

const baseline = (): WorkingState => ({ schemaVersion: 1, templateId: "home-office", room: { widthMm: 4000, depthMm: 4000 },
  furniture: [{ id: "chair", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false },
    { id: "desk", catalogId: "desk-1400x700", xMm: 2500, yMm: 1000, rotationDeg: 0, locked: false }],
  features: [{ id: "radiator", catalogId: "radiator-900", wall: "south", offsetMm: 500 }], constraints: [
    { constraintId: "near-desk", type: "item_distance", itemAId: "chair", itemBId: "desk", relation: "near", thresholdMm: 500, strength: "required" },
    { constraintId: "away-radiator", type: "feature_distance", itemId: "chair", featureId: "radiator", relation: "away", thresholdMm: 3000, strength: "preferred" },
  ] });

describe("pure shared transient candidate feedback", () => {
  it.each([
    ["room boundary", { xMm: 299, yMm: 1000, rotationDeg: 0 }, "ITEM_OUT_OF_BOUNDS"],
    ["furniture", { xMm: 1600, yMm: 1000, rotationDeg: 0 }, "ITEM_OVERLAP"],
    ["hard radiator keep-out", { xMm: 1000, yMm: 3401, rotationDeg: 0 }, "FEATURE_KEEP_OUT_INTERSECTION"],
  ] as const)("reports %s with source identity without changing any state", (_name, pose, code) => {
    const state = baseline(), copy = structuredClone(state);
    const result = assessCandidatePose(state, "chair", pose);
    expect(result.hardValid).toBe(false);
    expect(result.constraintResults).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code, itemIds: expect.arrayContaining(["chair"]) })]));
    if (code === "ITEM_OVERLAP") expect(result.issues.some(issue => issue.itemIds.includes("desk"))).toBe(true);
    if (code === "FEATURE_KEEP_OUT_INTERSECTION") expect(result.issues.some(issue => issue.featureId === "radiator")).toBe(true);
    expect(state).toEqual(copy);
    expect(assessCandidatePose(state, "chair", { xMm: 1000, yMm: 1000, rotationDeg: 0 }).hardValid).toBe(true);
  });

  it("keeps required and preferred failures as warnings, not new manual physical prohibitions", () => {
    const state = baseline(), pose: Pose = { xMm: 1000, yMm: 3000, rotationDeg: 0 };
    const result = assessCandidatePose(state, "chair", pose);
    expect(result.hardValid).toBe(true);
    expect(result.constraintResults).toEqual([
      expect.objectContaining({ constraintId: "near-desk", strength: "required", satisfied: false }),
      expect.objectContaining({ constraintId: "away-radiator", strength: "preferred", satisfied: false }),
    ]);
    expect(result.issues.some(issue => ["ITEM_OUT_OF_BOUNDS", "ITEM_OVERLAP", "FEATURE_KEEP_OUT_INTERSECTION"].includes(issue.code))).toBe(false);
    expect(state.furniture[0]).toMatchObject({ xMm: 1000, yMm: 1000 });
  });

  it("uses the candidate rotation and half-open edge policy, with no stale result between calls", () => {
    const state = baseline();
    expect(assessCandidatePose(state, "desk", { xMm: 699, yMm: 2000, rotationDeg: 0 }).hardValid).toBe(false);
    expect(assessCandidatePose(state, "desk", { xMm: 350, yMm: 2000, rotationDeg: 90 }).hardValid).toBe(true);
    expect(assessCandidatePose(state, "chair", { xMm: 1500, yMm: 1000, rotationDeg: 0 }).hardValid).toBe(true);
    expect(assessCandidatePose(state, "chair", { xMm: 1501, yMm: 1000, rotationDeg: 0 }).hardValid).toBe(false);
  });
});
