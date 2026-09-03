import type { CatalogEntry, FeatureCatalogEntry, RotationDeg } from "./types";

export const ROTATIONS: readonly RotationDeg[] = Object.freeze([0, 90, 180, 270]);
export const LIMITS = Object.freeze({ roomMinMm: 2000, roomMaxMm: 12000, maxFeatures: 8, maxFurniture: 8, maxConstraints: 8, maxOptions: 3, maxMovesPerOption: 8, doorPathWidthMinMm: 500, doorPathWidthMaxMm: 1600, distanceThresholdMinMm: 0, distanceThresholdMaxMm: 4000, dragSnapMm: 50, rotationsDeg: ROTATIONS });
const furnitureCatalogEntries: CatalogEntry[] = [
  { id: "desk-1400x700", kind: "desk", label: "Desk", widthMm: 1400, depthMm: 700, allowedRotations: ROTATIONS },
  { id: "chair-600x600", kind: "chair", label: "Chair", widthMm: 600, depthMm: 600, allowedRotations: ROTATIONS },
  { id: "storage-800x400", kind: "storage", label: "Storage", widthMm: 800, depthMm: 400, allowedRotations: ROTATIONS },
  { id: "bed-2000x1600", kind: "bed", label: "Bed", widthMm: 2000, depthMm: 1600, allowedRotations: ROTATIONS },
  { id: "nightstand-500x400", kind: "nightstand", label: "Nightstand", widthMm: 500, depthMm: 400, allowedRotations: ROTATIONS },
  { id: "wardrobe-1200x600", kind: "wardrobe", label: "Wardrobe", widthMm: 1200, depthMm: 600, allowedRotations: ROTATIONS },
  { id: "table-1200x800", kind: "table", label: "Table", widthMm: 1200, depthMm: 800, allowedRotations: ROTATIONS },
  { id: "bookcase-800x350", kind: "bookcase", label: "Bookcase", widthMm: 800, depthMm: 350, allowedRotations: ROTATIONS },
];
export const FURNITURE_CATALOG: readonly CatalogEntry[] = Object.freeze(
  furnitureCatalogEntries.map((entry) => Object.freeze({ ...entry, allowedRotations: ROTATIONS })),
);
const featureCatalogEntries: FeatureCatalogEntry[] = [
  { id: "door-900", type: "door", label: "Door", spanMm: 900, depthMm: 0, keepOutDepthMm: 0 },
  { id: "window-1400", type: "window", label: "Window", spanMm: 1400, depthMm: 0, keepOutDepthMm: 0 },
  { id: "radiator-900", type: "radiator", label: "Radiator", spanMm: 900, depthMm: 150, keepOutDepthMm: 300 },
];
export const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = Object.freeze(
  featureCatalogEntries.map((entry) => Object.freeze({ ...entry })),
);
export const furnitureCatalogById = (id: string) => FURNITURE_CATALOG.find((entry) => entry.id === id);
export const featureCatalogById = (id: string) => FEATURE_CATALOG.find((entry) => entry.id === id);
export const getFurnitureCatalogEntry = furnitureCatalogById;
export const getFeatureCatalogEntry = featureCatalogById;
