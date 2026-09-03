import { describe, expect, it } from "vitest";
import { aabbForFurniture, featureKeepOutAabb, overlapsPositiveArea, rectangleDistanceMm, isPlacementValid } from "../../src/domain/geometry";
import { createFactoryState } from "../../src/domain/templates";

describe("integer geometry", () => {
  it("uses doubled coordinates for odd centred dimensions and permits edge touching", () => {
    const odd = aabbForFurniture({ id: "odd", catalogId: "bookcase-800x350", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false });
    expect(odd).toStrictEqual({ left2: 1200, right2: 2800, top2: 1650, bottom2: 2350 });
    const left = { left2: 0, right2: 2000, top2: 0, bottom2: 2000 };
    const touch = { left2: 2000, right2: 4000, top2: 0, bottom2: 2000 };
    expect(overlapsPositiveArea(left, touch)).toBe(false);
    expect(rectangleDistanceMm(left, touch)).toBe(0);
  });

  it("swaps quarter-turn dimensions, enforces room bounds, and blocks radiator keep-out only", () => {
    expect(aabbForFurniture({ id: "desk", catalogId: "desk-1400x700", xMm: 1000, yMm: 1000, rotationDeg: 90, locked: false })).toStrictEqual({ left2: 1300, right2: 2700, top2: 600, bottom2: 3400 });
    const state = createFactoryState("home-office");
    expect(featureKeepOutAabb(state.features.find((f) => f.id === "radiator-east")!, state.room)).toStrictEqual({ left2: 6600, right2: 7200, top2: 1700, bottom2: 3500 });
    expect(isPlacementValid({ ...state.furniture[0], xMm: 200, yMm: 1300 }, state.room, state.furniture, state.features)).toBe(false);
    expect(isPlacementValid({ ...state.furniture[0], xMm: 3300, yMm: 1300 }, state.room, state.furniture, state.features)).toBe(false);
    expect(isPlacementValid({ ...state.furniture[0], xMm: 2500, yMm: 1300 }, state.room, state.furniture, state.features)).toBe(true);
  });
});
