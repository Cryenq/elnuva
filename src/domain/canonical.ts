import { LIMITS, featureCatalogById, furnitureCatalogById } from "./catalog";
import { aabbForFurniture, featureKeepOutAabb, overlapsPositiveArea, isAabbInsideRoom } from "./geometry";
import type {
  Constraint,
  ConstraintStrength,
  DistanceRelation,
  Feature,
  Furniture,
  ProposalProjection,
  TemplateId,
  Wall,
  WorkingState,
} from "./types";

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const HASH = /^[a-f0-9]{64}$/;
const TEMPLATE_IDS = new Set<TemplateId>(["home-office", "bedroom", "study"]);
const WALLS = new Set<Wall>(["north", "east", "south", "west"]);
const STRENGTHS = new Set<ConstraintStrength>(["required", "preferred"]);
const RELATIONS = new Set<DistanceRelation>(["near", "away"]);
const ROTATIONS = new Set([0, 90, 180, 270]);

function invalid(): never {
  throw new TypeError("Invalid contract value.");
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  return value;
}

function safeInteger(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) invalid();
  return value;
}

function oneOf<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) invalid();
  return value as T;
}

function validateConstraint(value: unknown, state?: { room: Readonly<{ widthMm: number; depthMm: number }>; features: readonly Feature[]; furniture: readonly Furniture[] }): Constraint {
  if (!plain(value) || typeof value.type !== "string") invalid();
  const strength = oneOf(value.strength, STRENGTHS);
  const constraintId = identifier(value.constraintId);

  if (value.type === "door_path_clear") {
    const object = exact(value, ["constraintId", "type", "strength", "featureId", "widthMm"]);
    const featureId = identifier(object.featureId);
    const widthMm = safeInteger(object.widthMm, LIMITS.doorPathWidthMinMm, LIMITS.doorPathWidthMaxMm);
    if (state) {
      const feature = state.features.find((candidate) => candidate.id === featureId);
      if (!feature || feature.catalogId !== "door-900") invalid();
      const wallLength = feature.wall === "north" || feature.wall === "south" ? state.room.widthMm : state.room.depthMm;
      const midpoint2 = feature.offsetMm * 2 + 900;
      if (midpoint2 - widthMm < 0 || midpoint2 + widthMm > wallLength * 2) invalid();
    }
    return { constraintId, type: "door_path_clear", strength, featureId, widthMm };
  }

  if (value.type === "feature_distance") {
    const object = exact(value, ["constraintId", "type", "strength", "itemId", "featureId", "relation", "thresholdMm"]);
    const itemId = identifier(object.itemId);
    const featureId = identifier(object.featureId);
    const relation = oneOf(object.relation, RELATIONS);
    const thresholdMm = safeInteger(object.thresholdMm, LIMITS.distanceThresholdMinMm, LIMITS.distanceThresholdMaxMm);
    if (state && (!state.furniture.some((item) => item.id === itemId) || !state.features.some((feature) => feature.id === featureId))) invalid();
    return { constraintId, type: "feature_distance", strength, itemId, featureId, relation, thresholdMm };
  }

  if (value.type === "item_distance") {
    const object = exact(value, ["constraintId", "type", "strength", "itemAId", "itemBId", "relation", "thresholdMm"]);
    const itemAId = identifier(object.itemAId);
    const itemBId = identifier(object.itemBId);
    const relation = oneOf(object.relation, RELATIONS);
    const thresholdMm = safeInteger(object.thresholdMm, LIMITS.distanceThresholdMinMm, LIMITS.distanceThresholdMaxMm);
    if (itemAId === itemBId) invalid();
    if (state && (!state.furniture.some((item) => item.id === itemAId) || !state.furniture.some((item) => item.id === itemBId))) invalid();
    return { constraintId, type: "item_distance", strength, itemAId, itemBId, relation, thresholdMm };
  }

  invalid();
}

function validateConstraints(value: unknown, state?: { room: Readonly<{ widthMm: number; depthMm: number }>; features: readonly Feature[]; furniture: readonly Furniture[] }): readonly Constraint[] {
  if (!Array.isArray(value) || value.length > LIMITS.maxConstraints) invalid();
  const constraints = value.map((constraint) => validateConstraint(constraint, state));
  if (new Set(constraints.map((constraint) => constraint.constraintId)).size !== constraints.length) invalid();
  return constraints;
}

export function assertWorkingState(value: unknown, expectedTemplateId?: TemplateId): asserts value is WorkingState {
  const state = exact(value, ["schemaVersion", "templateId", "room", "features", "furniture", "constraints"]);
  if (state.schemaVersion !== 1) invalid();
  const templateId = oneOf(state.templateId, TEMPLATE_IDS);
  if (expectedTemplateId !== undefined && templateId !== expectedTemplateId) invalid();

  const roomObject = exact(state.room, ["widthMm", "depthMm"]);
  const room = {
    widthMm: safeInteger(roomObject.widthMm, LIMITS.roomMinMm, LIMITS.roomMaxMm),
    depthMm: safeInteger(roomObject.depthMm, LIMITS.roomMinMm, LIMITS.roomMaxMm),
  };

  if (!Array.isArray(state.features) || state.features.length > LIMITS.maxFeatures) invalid();
  const features: Feature[] = state.features.map((entry) => {
    const feature = exact(entry, ["id", "catalogId", "wall", "offsetMm"]);
    const id = identifier(feature.id);
    if (typeof feature.catalogId !== "string") invalid();
    const catalog = featureCatalogById(feature.catalogId);
    if (!catalog) invalid();
    const wall = oneOf(feature.wall, WALLS);
    const offsetMm = safeInteger(feature.offsetMm, 0);
    const wallLength = wall === "north" || wall === "south" ? room.widthMm : room.depthMm;
    if (offsetMm + catalog.spanMm > wallLength) invalid();
    return { id, catalogId: catalog.id, wall, offsetMm };
  });
  if (new Set(features.map((feature) => feature.id)).size !== features.length) invalid();

  if (!Array.isArray(state.furniture) || state.furniture.length > LIMITS.maxFurniture) invalid();
  const furniture: Furniture[] = state.furniture.map((entry) => {
    const item = exact(entry, ["id", "catalogId", "xMm", "yMm", "rotationDeg", "locked"]);
    const id = identifier(item.id);
    if (typeof item.catalogId !== "string") invalid();
    const catalog = furnitureCatalogById(item.catalogId);
    if (!catalog) invalid();
    const xMm = safeInteger(item.xMm);
    const yMm = safeInteger(item.yMm);
    const rotationDeg = safeInteger(item.rotationDeg);
    if (!ROTATIONS.has(rotationDeg) || typeof item.locked !== "boolean") invalid();
    return { id, catalogId: catalog.id, xMm, yMm, rotationDeg: rotationDeg as Furniture["rotationDeg"], locked: item.locked };
  });
  if (new Set(furniture.map((item) => item.id)).size !== furniture.length) invalid();

  validateConstraints(state.constraints, { room, features, furniture });
  const aabbs = furniture.map((item) => ({ aabb: aabbForFurniture(item) }));
  if (aabbs.some(({ aabb }) => !isAabbInsideRoom(aabb, room))) invalid();
  for (let left = 0; left < aabbs.length; left += 1) {
    for (let right = left + 1; right < aabbs.length; right += 1) {
      if (overlapsPositiveArea(aabbs[left].aabb, aabbs[right].aabb)) invalid();
    }
  }
  for (const { aabb } of aabbs) {
    for (const feature of features) {
      const keepOut = featureKeepOutAabb(feature, room);
      if (keepOut && overlapsPositiveArea(aabb, keepOut)) invalid();
    }
  }
}

export function isValidWorkingState(value: unknown, expectedTemplateId?: TemplateId): value is WorkingState {
  try {
    assertWorkingState(value, expectedTemplateId);
    return true;
  } catch {
    return false;
  }
}

export function assertProposalProjection(value: unknown): asserts value is ProposalProjection {
  const proposal = exact(value, ["contractVersion", "baseRevision", "baseHash", "constraints", "optionId", "moves"]);
  if (proposal.contractVersion !== "1.0.0") invalid();
  safeInteger(proposal.baseRevision, 1);
  if (typeof proposal.baseHash !== "string" || !HASH.test(proposal.baseHash)) invalid();
  validateConstraints(proposal.constraints);
  identifier(proposal.optionId);
  if (!Array.isArray(proposal.moves) || proposal.moves.length < 1 || proposal.moves.length > LIMITS.maxMovesPerOption) invalid();
  for (const entry of proposal.moves) {
    const move = exact(entry, ["itemId", "pose"]);
    identifier(move.itemId);
    const pose = exact(move.pose, ["xMm", "yMm", "rotationDeg"]);
    safeInteger(pose.xMm);
    safeInteger(pose.yMm);
    safeInteger(pose.rotationDeg);
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonical(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return safeInteger(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) invalid();
    seen.add(value);
    const result = value.map((entry) => canonical(entry, seen));
    seen.delete(value);
    return result;
  }
  if (!plain(value)) invalid();
  if (seen.has(value)) invalid();
  seen.add(value);
  const result = Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonical(value[key], seen)]));
  seen.delete(value);
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value, new WeakSet()));
}

export function canonicalWorkingState(state: WorkingState): string {
  assertWorkingState(state);
  return canonicalJson({
    schemaVersion: state.schemaVersion,
    templateId: state.templateId,
    room: state.room,
    features: [...state.features].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    furniture: [...state.furniture].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    constraints: state.constraints,
  });
}

export function canonicalProposal(proposal: ProposalProjection): string {
  assertProposalProjection(proposal);
  return canonicalJson(proposal);
}

export const canonicalizeWorkingState = canonicalWorkingState;
export const canonicalizeProposal = canonicalProposal;
