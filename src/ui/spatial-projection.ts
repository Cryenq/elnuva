import { LIMITS } from "../domain/catalog";
import type { Pose, Room } from "../domain/types";
import type { CssPoint, CssViewport, MillimetrePoint, TopCameraFrame, WorldFloorPoint, WorldPose } from "./spatial-view-contract";

/** A presentation transform only; the measured layout remains in millimetres. */
export function domainPoseToWorld(pose: Pose): WorldPose {
  return { x: pose.xMm / 1000, z: pose.yMm / 1000, rotationY: pose.rotationDeg === 0 ? 0 : -pose.rotationDeg * Math.PI / 180 };
}

/** Preserve the place where the item was grabbed, then snap, without clamping. */
export function floorPointToSnappedMm(point: WorldFloorPoint, grabOffset: MillimetrePoint): MillimetrePoint | null {
  const x = point.x * 1000 - grabOffset.xMm;
  const y = point.z * 1000 - grabOffset.yMm;
  if (![point.x, point.z, grabOffset.xMm, grabOffset.yMm, x, y].every(Number.isFinite)) return null;
  const xMm = Math.round(x / LIMITS.dragSnapMm) * LIMITS.dragSnapMm;
  const yMm = Math.round(y / LIMITS.dragSnapMm) * LIMITS.dragSnapMm;
  if (!Number.isSafeInteger(xMm) || !Number.isSafeInteger(yMm)) return null;
  return { xMm: xMm === 0 ? 0 : xMm, yMm: yMm === 0 ? 0 : yMm };
}

/** North-up frame, in metres, including a visible margin at every aspect ratio. */
export function fitTopCamera(room: Room, viewport: CssViewport): TopCameraFrame {
  const width = room.widthMm / 1000;
  const depth = room.depthMm / 1000;
  const aspect = Math.max(1, viewport.width) / Math.max(1, viewport.height);
  const margin = Math.max(0.35, Math.max(width, depth) * 0.06);
  const frameWidth = Math.max(width + margin * 2, (depth + margin * 2) * aspect);
  const frameDepth = frameWidth / aspect;
  return { minX: (width - frameWidth) / 2, maxX: (width + frameWidth) / 2, minZ: (depth - frameDepth) / 2, maxZ: (depth + frameDepth) / 2 };
}

/** CSS-pixel coordinates relative to the canvas, independent of device pixel ratio. */
export function projectTopPoint(point: MillimetrePoint, frame: TopCameraFrame, viewport: CssViewport): CssPoint {
  return { x: (point.xMm / 1000 - frame.minX) / (frame.maxX - frame.minX) * viewport.width, y: (point.yMm / 1000 - frame.minZ) / (frame.maxZ - frame.minZ) * viewport.height };
}
