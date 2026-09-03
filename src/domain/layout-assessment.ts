import { assertWorkingState, canonicalJson } from "./canonical";
import { LIMITS, featureCatalogById, furnitureCatalogById } from "./catalog";
import { aabbsOverlap, featureKeepOutAabb, furnitureAabb, isAabbInsideRoom, rectangleDistanceMm } from "./geometry";
import type { CandidatePoseAssessment, FitIssue, FitRequest, LayoutAssessment } from "./fit-contract";
import type { Aabb, CommandResult, ConstraintResult, Feature, Furniture, Pose, WorkingState } from "./types";

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!);

/** Reject non-JSON properties, accessors, cycles and oversized input before cloning. */
function boundedData(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 128;
  if (typeof value === "number") return integer(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.length <= 64 && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return !!descriptor && descriptor.enumerable === true && "value" in descriptor && boundedData(descriptor.value, depth + 1, seen);
    }).every(Boolean);
  } else {
    valid = object(value) && Reflect.ownKeys(value).length <= 16 && Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return typeof key === "string" && descriptor.enumerable === true && "value" in descriptor && boundedData(descriptor.value, depth + 1, seen);
    });
  }
  seen.delete(value);
  return valid;
}

function freezeClone<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
    Object.freeze(entry);
    for (const child of Object.values(entry)) freeze(child);
  };
  freeze(copy);
  return copy;
}

const invalidRequest = (): CommandResult<never> => ({ ok: false, error: { code: "INVALID_INPUT", message: "The fit request is invalid." } });

export function assessFitRequest(value: unknown): CommandResult<FitRequest> {
  try {
    if (!boundedData(value) || !exact(value, ["contractVersion", "requestId", "generation", "templateId", "baseRevision", "baseHash", "baseline", "targetRoom", "additions"])) return invalidRequest();
    if (value.contractVersion !== "human-fit/1" || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId) || !integer(value.generation) || value.generation < 1 || !integer(value.baseRevision) || value.baseRevision < 1 || typeof value.baseHash !== "string" || !HASH.test(value.baseHash)) return invalidRequest();
    assertWorkingState(value.baseline);
    const baseline = value.baseline;
    if (value.templateId !== baseline.templateId || !exact(value.targetRoom, ["widthMm", "depthMm"])) return invalidRequest();
    const room = value.targetRoom;
    if (!integer(room.widthMm) || !integer(room.depthMm) || room.widthMm < LIMITS.roomMinMm || room.widthMm > LIMITS.roomMaxMm || room.depthMm < LIMITS.roomMinMm || room.depthMm > LIMITS.roomMaxMm) return invalidRequest();
    if (!Array.isArray(value.additions) || value.additions.length + baseline.furniture.length > LIMITS.maxFurniture) return invalidRequest();
    const ids = new Set(baseline.furniture.map(item => item.id));
    for (const addition of value.additions) {
      if (!exact(addition, ["id", "catalogId", "locked"]) || typeof addition.id !== "string" || !ID.test(addition.id) || ids.has(addition.id) || typeof addition.catalogId !== "string" || !furnitureCatalogById(addition.catalogId) || addition.locked !== false) return invalidRequest();
      ids.add(addition.id);
    }
    // Only structural target-room checks here: old unlocked poses may need moving.
    for (const feature of baseline.features) {
      const wallLength = feature.wall === "north" || feature.wall === "south" ? room.widthMm : room.depthMm;
      if (feature.offsetMm + featureCatalogById(feature.catalogId)!.spanMm > wallLength) return invalidRequest();
    }
    const targetContext = { ...baseline, room: { widthMm: room.widthMm, depthMm: room.depthMm } };
    for (const constraint of baseline.constraints) {
      if (constraint.type === "door_path_clear" && !doorCorridor(baseline.features.find(feature => feature.id === constraint.featureId)!, constraint.widthMm, targetContext)) return invalidRequest();
    }
    return { ok: true, data: freezeClone(value as FitRequest) };
  } catch { return invalidRequest(); }
}

function featurePhysicalAabb(feature: Feature, state: WorkingState): Aabb {
  const entry = featureCatalogById(feature.catalogId)!; const o = feature.offsetMm * 2; const span = entry.spanMm * 2; const depth = entry.depthMm * 2;
  if (feature.wall === "north") return { left2: o, right2: o + span, top2: 0, bottom2: depth };
  if (feature.wall === "south") return { left2: o, right2: o + span, top2: state.room.depthMm * 2 - depth, bottom2: state.room.depthMm * 2 };
  if (feature.wall === "west") return { left2: 0, right2: depth, top2: o, bottom2: o + span };
  return { left2: state.room.widthMm * 2 - depth, right2: state.room.widthMm * 2, top2: o, bottom2: o + span };
}

function doorCorridor(feature: Feature, widthMm: number, state: WorkingState): Aabb | null {
  const entry = featureCatalogById(feature.catalogId); if (!entry || entry.type !== "door") return null;
  const center2 = feature.offsetMm * 2 + entry.spanMm; const halfWidth2 = widthMm;
  if (feature.wall === "north" || feature.wall === "south") {
    if (center2 - halfWidth2 < 0 || center2 + halfWidth2 > state.room.widthMm * 2) return null;
    return feature.wall === "north" ? { left2: center2 - halfWidth2, right2: center2 + halfWidth2, top2: 0, bottom2: state.room.depthMm } : { left2: center2 - halfWidth2, right2: center2 + halfWidth2, top2: state.room.depthMm, bottom2: state.room.depthMm * 2 };
  }
  if (center2 - halfWidth2 < 0 || center2 + halfWidth2 > state.room.depthMm * 2) return null;
  return feature.wall === "west" ? { left2: 0, right2: state.room.widthMm, top2: center2 - halfWidth2, bottom2: center2 + halfWidth2 } : { left2: state.room.widthMm, right2: state.room.widthMm * 2, top2: center2 - halfWidth2, bottom2: center2 + halfWidth2 };
}

/** Exact extraction of native constraint ordering and numerical semantics. */
export function evaluateConstraints(state: WorkingState, furniture: readonly Furniture[]): readonly ConstraintResult[] {
  const items = new Map(furniture.map((item) => [item.id, item])); const features = new Map(state.features.map((feature) => [feature.id, feature]));
  return state.constraints.map((constraint): ConstraintResult => {
    if (constraint.type === "door_path_clear") {
      const corridor = doorCorridor(features.get(constraint.featureId)!, constraint.widthMm, state);
      const satisfied = corridor !== null && !furniture.some((item) => aabbsOverlap(furnitureAabb(item), corridor));
      return { constraintId: constraint.constraintId, type: constraint.type, strength: constraint.strength, satisfied, operator: "clear", actualMm: null, targetMm: constraint.widthMm };
    }
    const first = furnitureAabb(items.get(constraint.type === "feature_distance" ? constraint.itemId : constraint.itemAId)!);
    const second = constraint.type === "feature_distance" ? featurePhysicalAabb(features.get(constraint.featureId)!, state) : furnitureAabb(items.get(constraint.itemBId)!);
    const actualMm = rectangleDistanceMm(first, second); const operator = constraint.relation === "near" ? "lte" : "gte"; const satisfied = constraint.relation === "near" ? actualMm <= constraint.thresholdMm : actualMm >= constraint.thresholdMm;
    return { constraintId: constraint.constraintId, type: constraint.type, strength: constraint.strength, satisfied, operator, actualMm, targetMm: constraint.thresholdMm };
  });
}

function assessment(state: WorkingState, inputIssues: readonly FitIssue[] = []): LayoutAssessment {
  const issues: FitIssue[] = [...inputIssues];
  const requiredTotal = state.constraints.filter(row => row.strength === "required").length;
  const preferredTotal = state.constraints.length - requiredTotal;
  if (!issues.length) {
    for (const item of state.furniture) {
      const box = furnitureAabb(item);
      if (!isAabbInsideRoom(box, state.room)) issues.push({ code: "ITEM_OUT_OF_BOUNDS", itemIds: [item.id], message: `Furniture ${item.id} is outside the room boundary.` });
      for (const feature of state.features) {
        const keepOut = featureKeepOutAabb(feature, state.room);
        if (keepOut && aabbsOverlap(box, keepOut)) issues.push({ code: "FEATURE_KEEP_OUT_INTERSECTION", itemIds: [item.id], featureId: feature.id, message: `Furniture ${item.id} intersects the keep-out for ${feature.id}.` });
      }
    }
    for (let left = 0; left < state.furniture.length; left++) for (let right = left + 1; right < state.furniture.length; right++) {
      const a = state.furniture[left], b = state.furniture[right];
      if (aabbsOverlap(furnitureAabb(a), furnitureAabb(b))) issues.push({ code: "ITEM_OVERLAP", itemIds: [a.id, b.id], message: `Furniture ${a.id} and ${b.id} overlap.` });
    }
  }
  if (issues.length) return freezeClone({ hardValid: false, requiredSatisfied: false, issues, constraintResults: [], required: { satisfied: 0, total: requiredTotal }, preferred: { satisfied: 0, total: preferredTotal } });
  const constraintResults = evaluateConstraints(state, state.furniture);
  const requiredSatisfied = constraintResults.filter(row => row.strength === "required" && row.satisfied).length;
  const preferredSatisfied = constraintResults.filter(row => row.strength === "preferred" && row.satisfied).length;
  for (const row of constraintResults) if (row.strength === "required" && !row.satisfied) {
    const constraint = state.constraints.find(entry => entry.constraintId === row.constraintId)!;
    const itemIds = constraint.type === "door_path_clear" ? state.furniture.filter(item => aabbsOverlap(furnitureAabb(item), doorCorridor(state.features.find(feature => feature.id === constraint.featureId)!, constraint.widthMm, state)!)).map(item => item.id) : constraint.type === "feature_distance" ? [constraint.itemId] : [constraint.itemAId, constraint.itemBId];
    issues.push({ code: "REQUIRED_CONSTRAINT_UNSATISFIED", itemIds, constraintId: row.constraintId, ...(constraint.type !== "item_distance" ? { featureId: constraint.featureId } : {}), message: `Required constraint ${row.constraintId} is not satisfied.` });
  }
  return freezeClone({ hardValid: true, requiredSatisfied: requiredSatisfied === requiredTotal, issues, constraintResults, required: { satisfied: requiredSatisfied, total: requiredTotal }, preferred: { satisfied: preferredSatisfied, total: preferredTotal } });
}

export function assessFitTarget(request: FitRequest, target: unknown): LayoutAssessment {
  const decoded = assessFitRequest(request);
  if (!decoded.ok) return freezeClone({ hardValid: false, requiredSatisfied: false, issues: [{ code: "INVALID_REQUEST", itemIds: [], message: "The fit request is invalid." }], constraintResults: [], required: { satisfied: 0, total: 0 }, preferred: { satisfied: 0, total: 0 } });
  const baseline = decoded.data.baseline;
  const fail = (code: FitIssue["code"], itemIds: readonly string[] = []): LayoutAssessment => assessment(baseline, [{ code, itemIds, message: "The fit target does not match the requested layout contract." }]);
  try {
    if (!boundedData(target) || !exact(target, ["schemaVersion", "templateId", "room", "features", "furniture", "constraints"])) return fail("INVALID_REQUEST");
    if (target.schemaVersion !== 1 || target.templateId !== request.templateId || canonicalJson(target.room) !== canonicalJson(request.targetRoom) || canonicalJson(target.features) !== canonicalJson(request.baseline.features) || canonicalJson(target.constraints) !== canonicalJson(request.baseline.constraints)) return fail("MEMBERSHIP_MISMATCH");
    const expected = [...request.baseline.furniture, ...request.additions];
    if (!Array.isArray(target.furniture) || target.furniture.length !== expected.length) return fail("MEMBERSHIP_MISMATCH");
    for (let index = 0; index < expected.length; index++) {
      const item = target.furniture[index], original = expected[index];
      if (!exact(item, ["id", "catalogId", "xMm", "yMm", "rotationDeg", "locked"]) || !integer(item.xMm) || !integer(item.yMm) || !integer(item.rotationDeg) || ![0, 90, 180, 270].includes(item.rotationDeg)) return fail("INVALID_REQUEST");
      if (item.id !== original.id || item.catalogId !== original.catalogId || item.locked !== original.locked) return fail("MEMBERSHIP_MISMATCH", [original.id]);
      if (original.locked && "xMm" in original && (item.xMm !== original.xMm || item.yMm !== original.yMm || item.rotationDeg !== original.rotationDeg)) return fail("LOCKED_ITEM_CHANGED", [original.id]);
    }
    return assessment(target as WorkingState);
  } catch { return fail("INVALID_REQUEST"); }
}

export function assessCandidatePose(state: WorkingState, itemId: string, pose: Pose): CandidatePoseAssessment {
  try {
    assertWorkingState(state);
    const item = state.furniture.find(entry => entry.id === itemId);
    if (!item || !boundedData(pose) || !exact(pose, ["xMm", "yMm", "rotationDeg"]) || !integer(pose.xMm) || !integer(pose.yMm) || !integer(pose.rotationDeg) || ![0, 90, 180, 270].includes(pose.rotationDeg)) throw new TypeError();
    if (item.locked && (item.xMm !== pose.xMm || item.yMm !== pose.yMm || item.rotationDeg !== pose.rotationDeg)) return freezeClone({ hardValid: false, issues: [{ code: "LOCKED_ITEM_CHANGED", itemIds: [itemId], message: `Furniture ${itemId} is locked.` }], constraintResults: [] });
    const result = assessment({ ...state, furniture: state.furniture.map(entry => entry.id === itemId ? { ...entry, ...pose } : entry) });
    return freezeClone({ hardValid: result.hardValid, issues: result.issues, constraintResults: result.constraintResults });
  } catch { return freezeClone({ hardValid: false, issues: [{ code: "INVALID_REQUEST", itemIds: [], message: "The candidate pose is invalid." }], constraintResults: [] }); }
}
