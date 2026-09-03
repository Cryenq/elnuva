export type RotationDeg = 0 | 90 | 180 | 270;

export type TemplateId = "home-office" | "bedroom" | "study";

export type FurnitureCatalogId =
  | "desk-1400x700"
  | "chair-600x600"
  | "storage-800x400"
  | "bed-2000x1600"
  | "nightstand-500x400"
  | "wardrobe-1200x600"
  | "table-1200x800"
  | "bookcase-800x350";

export type FeatureCatalogId = "door-900" | "window-1400" | "radiator-900";

export type FurnitureKind =
  | "desk"
  | "chair"
  | "storage"
  | "bed"
  | "nightstand"
  | "wardrobe"
  | "table"
  | "bookcase";

export type Wall = "north" | "east" | "south" | "west";
export type ConstraintStrength = "required" | "preferred";
export type DistanceRelation = "near" | "away";

export type Room = Readonly<{
  widthMm: number;
  depthMm: number;
}>;

export type Furniture = Readonly<{
  id: string;
  catalogId: FurnitureCatalogId;
  xMm: number;
  yMm: number;
  rotationDeg: RotationDeg;
  locked: boolean;
}>;

export type Feature = Readonly<{
  id: string;
  catalogId: FeatureCatalogId;
  wall: Wall;
  offsetMm: number;
}>;

export type DoorPathClearConstraint = Readonly<{
  constraintId: string;
  type: "door_path_clear";
  strength: ConstraintStrength;
  featureId: string;
  widthMm: number;
}>;

export type FeatureDistanceConstraint = Readonly<{
  constraintId: string;
  type: "feature_distance";
  strength: ConstraintStrength;
  itemId: string;
  featureId: string;
  relation: DistanceRelation;
  thresholdMm: number;
}>;

export type ItemDistanceConstraint = Readonly<{
  constraintId: string;
  type: "item_distance";
  strength: ConstraintStrength;
  itemAId: string;
  itemBId: string;
  relation: DistanceRelation;
  thresholdMm: number;
}>;

export type Constraint =
  | DoorPathClearConstraint
  | FeatureDistanceConstraint
  | ItemDistanceConstraint;

export type WorkingState = Readonly<{
  schemaVersion: 1;
  templateId: TemplateId;
  room: Room;
  features: readonly Feature[];
  furniture: readonly Furniture[];
  constraints: readonly Constraint[];
}>;

export type CatalogEntry = Readonly<{
  id: FurnitureCatalogId;
  kind: FurnitureKind;
  label: string;
  widthMm: number;
  depthMm: number;
  allowedRotations: readonly RotationDeg[];
}>;

export type FeatureCatalogEntry = Readonly<{
  id: FeatureCatalogId;
  type: "door" | "window" | "radiator";
  label: string;
  spanMm: number;
  depthMm: number;
  keepOutDepthMm: number;
}>;

export type PreviewSummary =
  | Readonly<{ status: "none" }>
  | Readonly<{
      status: "pending-review";
      optionId: string;
      proposalDigest: string;
      notApplied: true;
      notSaved: true;
    }>;

export type InspectSpatialLayoutData = Readonly<{
  contractVersion: "1.0.0";
  baseRevision: number;
  baseHash: string;
  workingState: WorkingState;
  catalog: Readonly<{
    furniture: readonly CatalogEntry[];
    features: readonly FeatureCatalogEntry[];
  }>;
  coordinateSystem: Readonly<{
    origin: "north-west";
    xAxis: "east";
    yAxis: "south";
    unit: "mm";
    integersOnly: true;
  }>;
  limits: Readonly<{
    roomMinMm: number;
    roomMaxMm: number;
    maxFeatures: number;
    maxFurniture: number;
    maxConstraints: number;
    maxOptions: number;
    maxMovesPerOption: number;
    doorPathWidthMinMm: number;
    doorPathWidthMaxMm: number;
    distanceThresholdMinMm: number;
    distanceThresholdMaxMm: number;
    dragSnapMm: number;
    rotationsDeg: readonly RotationDeg[];
  }>;
  preview: PreviewSummary;
}>;

export type Aabb = Readonly<{ left2: number; top2: number; right2: number; bottom2: number }>;
export type Pose = Readonly<{ xMm: number; yMm: number; rotationDeg: RotationDeg }>;
export type SubmittedPose = Readonly<{ xMm: number; yMm: number; rotationDeg: number }>;
export type Move = Readonly<{ itemId: string; pose: Pose }>;
export type SubmittedMove = Readonly<{ itemId: string; pose: SubmittedPose }>;
export type ConstraintResult = Readonly<{ constraintId: string; type: Constraint["type"]; strength: ConstraintStrength; satisfied: boolean; operator: "clear" | "lte" | "gte"; actualMm: number | null; targetMm: number }>;
export type ValidationIssue = Readonly<{ code: string; path: string; message: string }>;
export type StageValidationSummary = Readonly<{ optionId: string; hardValid: true; stageable: true; issues: readonly []; constraintResults: readonly ConstraintResult[]; required: Readonly<{ satisfied: number; total: number }>; preferred: Readonly<{ satisfied: number; total: number }>; movedCount: number; rotatedCount: number; totalMovementMm: number; minimumClearanceMm: number; proposalDigest: string }>;
export type PreviewState = Readonly<{ status: "pending-review"; baseRevision: number; baseHash: string; optionId: string; moves: readonly Move[]; constraints: readonly Constraint[]; proposalDigest: string; idempotencyKey: string; validation: StageValidationSummary; projectedFurniture: readonly Furniture[]; notApplied: true; notSaved: true; requiresHumanAction: true }>;
export type StoredEnvelope = Readonly<{ storageVersion: 1; templateId: TemplateId; state: WorkingState }>;
export type ToolFailureCode = "INVALID_INPUT" | "UNSUPPORTED_CONSTRAINT" | "STATE_UNAVAILABLE" | "REVISION_CONFLICT" | "OPTION_INVALID" | "DIGEST_MISMATCH" | "PENDING_REVIEW" | "IDEMPOTENCY_CONFLICT" | "CANCELLED" | "INTERNAL_ERROR";
export type ToolResult<T> = Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: Readonly<{ code: ToolFailureCode; message: string }> }>;
