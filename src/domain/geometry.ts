import { featureCatalogById, furnitureCatalogById } from "./catalog";
import type { Aabb, Feature, Furniture, Room } from "./types";

export function furnitureAabb(item: Furniture): Aabb {
  const catalog = furnitureCatalogById(item.catalogId); if (!catalog) throw new Error("Unknown catalog item.");
  const swap = item.rotationDeg === 90 || item.rotationDeg === 270;
  const width2 = 2 * (swap ? catalog.depthMm : catalog.widthMm); const depth2 = 2 * (swap ? catalog.widthMm : catalog.depthMm);
  return { left2: 2 * item.xMm - width2 / 2, right2: 2 * item.xMm + width2 / 2, top2: 2 * item.yMm - depth2 / 2, bottom2: 2 * item.yMm + depth2 / 2 };
}
export function featureKeepOutAabb(feature: Feature, room: Room): Aabb | null {
  const entry = featureCatalogById(feature.catalogId); if (!entry || entry.keepOutDepthMm === 0) return null;
  const span2 = entry.spanMm * 2, d2 = entry.keepOutDepthMm * 2, offset2 = feature.offsetMm * 2;
  if (feature.wall === "north") return { left2: offset2, right2: offset2 + span2, top2: 0, bottom2: d2 };
  if (feature.wall === "south") return { left2: offset2, right2: offset2 + span2, top2: room.depthMm * 2 - d2, bottom2: room.depthMm * 2 };
  if (feature.wall === "west") return { left2: 0, right2: d2, top2: offset2, bottom2: offset2 + span2 };
  return { left2: room.widthMm * 2 - d2, right2: room.widthMm * 2, top2: offset2, bottom2: offset2 + span2 };
}
export const aabbsOverlap = (a: Aabb, b: Aabb): boolean => a.left2 < b.right2 && a.right2 > b.left2 && a.top2 < b.bottom2 && a.bottom2 > b.top2;
export const isAabbInsideRoom = (a: Aabb, room: Room): boolean => a.left2 >= 0 && a.top2 >= 0 && a.right2 <= room.widthMm * 2 && a.bottom2 <= room.depthMm * 2;
export function rectangleDistanceMm(a: Aabb, b: Aabb): number { const dx = Math.max(0, a.left2 - b.right2, b.left2 - a.right2) / 2; const dy = Math.max(0, a.top2 - b.bottom2, b.top2 - a.bottom2) / 2; return Math.floor(Math.hypot(dx, dy)); }
export function placementValid(item: Furniture, room: Room, furniture: readonly Furniture[], features: readonly Feature[]): boolean { const aabb = furnitureAabb(item); return isAabbInsideRoom(aabb, room) && !furniture.some((candidate) => candidate.id !== item.id && aabbsOverlap(aabb, furnitureAabb(candidate))) && !features.some((feature) => { const keepOut = featureKeepOutAabb(feature, room); return keepOut !== null && aabbsOverlap(aabb, keepOut); }); }
export const aabbForFurniture = furnitureAabb;
export const overlapsPositiveArea = aabbsOverlap;
export const isPlacementValid = placementValid;
