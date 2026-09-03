import { describe, expect, it } from "vitest";
import { canonicalizeProposal, canonicalizeWorkingState } from "../../src/domain/canonical";
import { createFactoryState } from "../../src/domain/templates";

describe("canonical domain projections", () => {
  it("sorts only features/furniture by id while preserving semantic constraint and move order", () => {
    const state = createFactoryState("home-office");
    const shuffled = { ...state, features: [...state.features].reverse(), furniture: [...state.furniture].reverse() };
    expect(canonicalizeWorkingState(shuffled)).toBe(canonicalizeWorkingState(state));
    const reordered = { ...state, constraints: [...state.constraints].reverse() };
    expect(canonicalizeWorkingState(reordered)).not.toBe(canonicalizeWorkingState(state));
    expect(canonicalizeProposal({ contractVersion: "1.0.0", baseRevision: 1, baseHash: "a".repeat(64), constraints: state.constraints, optionId: "x", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }, { itemId: "chair-main", pose: { xMm: 2500, yMm: 1400, rotationDeg: 0 } }] })).not.toBe(canonicalizeProposal({ contractVersion: "1.0.0", baseRevision: 1, baseHash: "a".repeat(64), constraints: state.constraints, optionId: "x", moves: [{ itemId: "chair-main", pose: { xMm: 2500, yMm: 1400, rotationDeg: 0 } }, { itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }] }));
  });

  it("rejects unknown properties, non-integers and negative zero before serializing", () => {
    expect(() => canonicalizeWorkingState({ ...createFactoryState("home-office"), extra: true } as any)).toThrow();
    expect(() => canonicalizeWorkingState({ ...createFactoryState("home-office"), room: { widthMm: 3600.5, depthMm: 3000 } } as any)).toThrow();
    expect(() => canonicalizeWorkingState({ ...createFactoryState("home-office"), room: { widthMm: -0, depthMm: 3000 } } as any)).toThrow();
  });
});
