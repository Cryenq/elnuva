import { describe, expect, it } from "vitest";
import { aabbForFurniture, featureKeepOutAabb, overlapsPositiveArea, rectangleDistanceMm, isPlacementValid } from "../../src/domain/geometry";
import { createFactoryState } from "../../src/domain/templates";

describe("integer geometry", () => {
  it("uses doubled coordinates for odd centred dimensions and permits edge touching", () => {
    const odd = aabbForFurniture({ id: "odd", catalogId: "bookcase-800x350", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false });
    expect(odd).toStrictEqual({ minX2: 1200, maxX2: 2800, minY2: 1650, maxY2: 2350 });
    const left = { minX2: 0, maxX2: 2000, minY2: 0, maxY2: 2000 };
    const touch = { minX2: 2000, maxX2: 4000, minY2: 0, maxY2: 2000 };
    expect(overlapsPositiveArea(left, touch)).toBe(false);
    expect(rectangleDistanceMm(left, touch)).toBe(0);
  });

  it("swaps quarter-turn dimensions, enforces room bounds, and blocks radiator keep-out only", () => {
    expect(aabbForFurniture({ id: "desk", catalogId: "desk-1400x700", xMm: 1000, yMm: 1000, rotationDeg: 90, locked: false })).toStrictEqual({ minX2: 1300, maxX2: 2700, minY2: 600, maxY2: 3400 });
    const state = createFactoryState("home-office");
    expect(featureKeepOutAabb(state.room, state.features.find((f) => f.id === "radiator-east")!)).toStrictEqual({ minX2: 6600, maxX2: 7200, minY2: 1700, maxY2: 3500 });
    expect(isPlacementValid(state, { ...state.furniture[0], xMm: 200, yMm: 1300 })).toMatchObject({ valid: false, code: "ITEM_OUT_OF_BOUNDS" });
    expect(isPlacementValid(state, { ...state.furniture[0], xMm: 3300, yMm: 1300 })).toMatchObject({ valid: false, code: "FEATURE_KEEP_OUT_INTERSECTION" });
  });
});
