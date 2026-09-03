import { describe, expect, it } from "vitest";
import { FEATURE_CATALOG, FURNITURE_CATALOG, getFeatureCatalogEntry, getFurnitureCatalogEntry } from "../../src/domain/catalog";

describe("immutable bounded catalogs", () => {
  it("publishes the exact furniture Inspect order and dimensions", () => {
    expect(FURNITURE_CATALOG).toStrictEqual([
      { id: "desk-1400x700", kind: "desk", label: "Desk", widthMm: 1400, depthMm: 700, allowedRotations: [0, 90, 180, 270] },
      { id: "chair-600x600", kind: "chair", label: "Chair", widthMm: 600, depthMm: 600, allowedRotations: [0, 90, 180, 270] },
      { id: "storage-800x400", kind: "storage", label: "Storage", widthMm: 800, depthMm: 400, allowedRotations: [0, 90, 180, 270] },
      { id: "bed-2000x1600", kind: "bed", label: "Bed", widthMm: 2000, depthMm: 1600, allowedRotations: [0, 90, 180, 270] },
      { id: "nightstand-500x400", kind: "nightstand", label: "Nightstand", widthMm: 500, depthMm: 400, allowedRotations: [0, 90, 180, 270] },
      { id: "wardrobe-1200x600", kind: "wardrobe", label: "Wardrobe", widthMm: 1200, depthMm: 600, allowedRotations: [0, 90, 180, 270] },
      { id: "table-1200x800", kind: "table", label: "Table", widthMm: 1200, depthMm: 800, allowedRotations: [0, 90, 180, 270] },
      { id: "bookcase-800x350", kind: "bookcase", label: "Bookcase", widthMm: 800, depthMm: 350, allowedRotations: [0, 90, 180, 270] },
    ]);
    expect(getFurnitureCatalogEntry("desk-1400x700")).toBe(FURNITURE_CATALOG[0]);
    expect(getFurnitureCatalogEntry("missing" as never)).toBeUndefined();
    expect(Object.isFrozen(FURNITURE_CATALOG)).toBe(true);
    expect(Object.isFrozen(FURNITURE_CATALOG[0])).toBe(true);
    expect(Object.isFrozen(FURNITURE_CATALOG[0].allowedRotations)).toBe(true);
  });

  it("publishes exact feature spans, physical depths, and hard keep-outs", () => {
    expect(FEATURE_CATALOG).toStrictEqual([
      { id: "door-900", type: "door", label: "Door", spanMm: 900, depthMm: 0, keepOutDepthMm: 0 },
      { id: "window-1400", type: "window", label: "Window", spanMm: 1400, depthMm: 0, keepOutDepthMm: 0 },
      { id: "radiator-900", type: "radiator", label: "Radiator", spanMm: 900, depthMm: 150, keepOutDepthMm: 300 },
    ]);
    expect(getFeatureCatalogEntry("radiator-900")).toBe(FEATURE_CATALOG[2]);
    expect(getFeatureCatalogEntry("missing" as never)).toBeUndefined();
    expect(Object.isFrozen(FEATURE_CATALOG)).toBe(true);
    expect(Object.isFrozen(FEATURE_CATALOG[0])).toBe(true);
  });
});
