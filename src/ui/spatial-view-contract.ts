import type { StoreSnapshot } from "../domain/store";
import type { Pose, TemplateId } from "../domain/types";

export type SpatialViewMode = "isometric" | "top" | "precision-2d";

export type SpatialViewState = Readonly<{
  snapshot: StoreSnapshot;
  selectedItemId: string | null;
  viewMode: SpatialViewMode;
  /** Shell-owned, monotonically increasing, view-only reset request. */
  cameraResetVersion: number;
}>;

export type SpatialPoseRequest = Readonly<{
  itemId: string;
  pose: Pose;
  baseTemplateId: TemplateId;
  baseRevision: number;
  baseHash: string;
}>;

export type SpatialAvailability = Readonly<{
  state: "initializing" | "available" | "unavailable";
  message: string;
}>;

export type SpatialViewCallbacks = Readonly<{
  onSelect: (itemId: string | null) => void;
  /** The shell rechecks the live base, preview, lock and placement before committing. */
  onPoseRequest: (request: SpatialPoseRequest) => void;
  onAvailabilityChange: (availability: SpatialAvailability) => void;
}>;

/**
 * Updates use the latest snapshot without replacing the persistent canvas host.
 * Base/preview/item/view/reset changes cancel gestures; selection-only updates do not.
 * Cancel/dispose release capture and resources silently and are idempotent.
 * Updates after disposal are no-ops; delayed callbacks cannot resurrect resources.
 */
export type SpatialViewHandle = Readonly<{
  update: (state: SpatialViewState) => void;
  cancelInteraction: () => void;
  dispose: () => void;
}>;

/**
 * Implemented as mountSpatialView in spatial-view.ts. Returns synchronously;
 * callbacks begin after return and asynchronous initialization uses the latest state.
 * Recheck gesture generation after onSelect, which may update/dispose reentrantly.
 * End the gesture and restore authoritative visuals before onPoseRequest; its void
 * notification never means success. The renderer owns only the host's subtree.
 */
export type MountSpatialView = (
  host: HTMLElement,
  initialState: SpatialViewState,
  callbacks: SpatialViewCallbacks,
) => SpatialViewHandle;

/** Metres: domain east maps +X, south maps +Z; illustrative up is +Y. */
export type WorldFloorPoint = Readonly<{ x: number; z: number }>;

/** Radians: a positive domain quarter-turn maps to negative world Y yaw. */
export type WorldPose = WorldFloorPoint & Readonly<{ rotationY: number }>;

export type MillimetrePoint = Readonly<{ xMm: number; yMm: number }>;
export type CssViewport = Readonly<{ width: number; height: number }>;
export type CssPoint = Readonly<{ x: number; y: number }>;
export type TopCameraFrame = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;
