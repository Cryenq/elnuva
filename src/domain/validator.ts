import { featureCatalogById, furnitureCatalogById, LIMITS } from "./catalog";
import { aabbsOverlap, featureKeepOutAabb, furnitureAabb, isAabbInsideRoom, rectangleDistanceMm } from "./geometry";
import { proposalDigest } from "./hash";
import type {
  Aabb, Constraint, ConstraintResult, Feature, Furniture, Move, RotationDeg,
  StageRequest, StageValidationSummary, StageVerifier, SubmittedMove, ToolFailureCode,
  ToolResult, ValidationIssue, WorkingState,
} from "./types";

type ValidationContext = Readonly<{ workingState: WorkingState; baseRevision: number; baseHash: string }>;
export type ValidateLayoutOptionsRequest = Readonly<{ baseRevision: number; baseHash: string; constraints: readonly Constraint[]; options: readonly Readonly<{ optionId: string; moves: readonly SubmittedMove[] }>[] }>;
export type OptionResult = Readonly<{ optionId: string; inputIndex: number; hardValid: boolean; stageable: boolean; issues: readonly ValidationIssue[]; constraintResults: readonly ConstraintResult[]; required: Readonly<{ satisfied: number; total: number }>; preferred: Readonly<{ satisfied: number; total: number }>; movedCount: number; rotatedCount: number; totalMovementMm: number; minimumClearanceMm: number; rank: number | null; proposalDigest: string }>;
export type ValidateLayoutOptionsData = Readonly<{ baseRevision: number; baseHash: string; results: readonly OptionResult[]; rankedOptionIds: readonly string[] }>;

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const HASH = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_-]{16,80}$/;
const ownKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const fail = <T>(code: ToolFailureCode): ToolResult<T> => ({ ok: false, error: { code, message: ({ INVALID_INPUT: "The request is invalid.", UNSUPPORTED_CONSTRAINT: "The request contains an unsupported constraint.", REVISION_CONFLICT: "The layout revision or hash has changed.", OPTION_INVALID: "The option is not valid for staging.", DIGEST_MISMATCH: "The proposal digest does not match.", STATE_UNAVAILABLE: "The layout state is unavailable.", PENDING_REVIEW: "A preview is already pending review.", IDEMPOTENCY_CONFLICT: "The idempotency key conflicts with an earlier request.", CANCELLED: "The operation was cancelled.", INTERNAL_ERROR: "The operation could not be completed." } as const)[code] } });

function decodeConstraint(value: unknown): "unsupported" | Constraint | null {
  if (!object(value) || typeof value.type !== "string") return null;
  if (!["door_path_clear", "feature_distance", "item_distance"].includes(value.type)) return "unsupported";
  if (!id(value.constraintId) || (value.strength !== "required" && value.strength !== "preferred")) return null;
  if (value.type === "door_path_clear") {
    if (!ownKeys(value, ["constraintId", "type", "strength", "featureId", "widthMm"]) || !id(value.featureId) || !integer(value.widthMm) || value.widthMm < 500 || value.widthMm > 1600) return null;
    return value as Constraint;
  }
  if (value.type === "feature_distance") {
    if (!ownKeys(value, ["constraintId", "type", "strength", "itemId", "featureId", "relation", "thresholdMm"]) || !id(value.itemId) || !id(value.featureId) || (value.relation !== "near" && value.relation !== "away") || !integer(value.thresholdMm) || value.thresholdMm < 0 || value.thresholdMm > 4000) return null;
    return value as Constraint;
  }
  if (!ownKeys(value, ["constraintId", "type", "strength", "itemAId", "itemBId", "relation", "thresholdMm"]) || !id(value.itemAId) || !id(value.itemBId) || value.itemAId === value.itemBId || (value.relation !== "near" && value.relation !== "away") || !integer(value.thresholdMm) || value.thresholdMm < 0 || value.thresholdMm > 4000) return null;
  return value as Constraint;
}

function decodeConstraints(value: unknown): { value?: readonly Constraint[]; unsupported?: true } | null {
  if (!Array.isArray(value) || value.length > LIMITS.maxConstraints) return null;
  const result: Constraint[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const decoded = decodeConstraint(raw);
    if (decoded === "unsupported") return { unsupported: true };
    if (!decoded || ids.has(decoded.constraintId)) return null;
    ids.add(decoded.constraintId); result.push(decoded);
  }
  return { value: result };
}

function decodeMoves(value: unknown): readonly SubmittedMove[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.maxMovesPerOption) return null;
  const moves: SubmittedMove[] = [];
  for (const raw of value) {
    if (!object(raw) || !ownKeys(raw, ["itemId", "pose"]) || !id(raw.itemId) || !object(raw.pose) || !ownKeys(raw.pose, ["xMm", "yMm", "rotationDeg"]) || !integer(raw.pose.xMm) || !integer(raw.pose.yMm) || !integer(raw.pose.rotationDeg)) return null;
    moves.push(raw as SubmittedMove);
  }
  return moves;
}

function decodeValidate(value: unknown): { request?: ValidateLayoutOptionsRequest; unsupported?: true } | null {
  if (!object(value) || !ownKeys(value, ["baseRevision", "baseHash", "constraints", "options"]) || !integer(value.baseRevision) || value.baseRevision < 1 || typeof value.baseHash !== "string" || !HASH.test(value.baseHash)) return null;
  const constraints = decodeConstraints(value.constraints); if (!constraints) return null; if (constraints.unsupported) return { unsupported: true };
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > LIMITS.maxOptions) return null;
  const options: { optionId: string; moves: readonly SubmittedMove[] }[] = []; const ids = new Set<string>();
  for (const raw of value.options) {
    if (!object(raw) || !ownKeys(raw, ["optionId", "moves"]) || !id(raw.optionId) || ids.has(raw.optionId)) return null;
    const moves = decodeMoves(raw.moves); if (!moves) return null;
    ids.add(raw.optionId); options.push({ optionId: raw.optionId, moves });
  }
  return { request: { baseRevision: value.baseRevision, baseHash: value.baseHash, constraints: constraints.value!, options } };
}

function decodeStage(value: unknown): { request?: StageRequest; unsupported?: true } | null {
  if (!object(value) || !ownKeys(value, ["baseRevision", "baseHash", "constraints", "optionId", "moves", "proposalDigest", "idempotencyKey"]) || !integer(value.baseRevision) || value.baseRevision < 1 || typeof value.baseHash !== "string" || !HASH.test(value.baseHash) || !id(value.optionId) || typeof value.proposalDigest !== "string" || !HASH.test(value.proposalDigest) || typeof value.idempotencyKey !== "string" || !KEY.test(value.idempotencyKey)) return null;
  const constraints = decodeConstraints(value.constraints); if (!constraints) return null; if (constraints.unsupported) return { unsupported: true };
  const moves = decodeMoves(value.moves); if (!moves) return null;
  return { request: { baseRevision: value.baseRevision, baseHash: value.baseHash, constraints: constraints.value!, optionId: value.optionId, moves, proposalDigest: value.proposalDigest, idempotencyKey: value.idempotencyKey } };
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

function evaluateConstraints(state: WorkingState, furniture: readonly Furniture[]): readonly ConstraintResult[] {
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

function minimumClearance(state: WorkingState, furniture: readonly Furniture[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  const aabbs = furniture.map((item) => ({ item, aabb: furnitureAabb(item) }));
  for (let i = 0; i < aabbs.length; i++) {
    const box = aabbs[i].aabb;
    minimum = Math.min(minimum, box.left2 / 2, box.top2 / 2, (state.room.widthMm * 2 - box.right2) / 2, (state.room.depthMm * 2 - box.bottom2) / 2);
    for (let j = i + 1; j < aabbs.length; j++) minimum = Math.min(minimum, rectangleDistanceMm(box, aabbs[j].aabb));
    for (const feature of state.features) { const keepOut = featureKeepOutAabb(feature, state.room); if (keepOut) minimum = Math.min(minimum, rectangleDistanceMm(box, keepOut)); }
  }
  return Number.isFinite(minimum) ? Math.floor(Math.max(0, minimum)) : 0;
}

async function evaluateOption(context: ValidationContext, option: Readonly<{ optionId: string; moves: readonly SubmittedMove[] }>, inputIndex: number): Promise<{ result: OptionResult; projectedFurniture?: readonly Furniture[]; normalizedMoves?: readonly Move[] }> {
  const state = context.workingState; const digest = await proposalDigest(context.baseRevision, context.baseHash, state.constraints, option.optionId, option.moves);
  const requiredTotal = state.constraints.filter((c) => c.strength === "required").length; const preferredTotal = state.constraints.length - requiredTotal;
  const byId = new Map(state.furniture.map((item) => [item.id, item])); const seen = new Set<string>();
  const groups: ValidationIssue[][] = [[], [], [], [], []];
  option.moves.forEach((move, index) => {
    const path = `/options/${inputIndex}/moves/${index}`; const current = byId.get(move.itemId); const duplicate = seen.has(move.itemId); seen.add(move.itemId);
    if (!current) groups[0].push({ code: "UNKNOWN_ITEM", path: `${path}/itemId`, message: `Unknown furniture item ${move.itemId}.` });
    if (duplicate) groups[1].push({ code: "DUPLICATE_MOVE", path: `${path}/itemId`, message: `Furniture item ${move.itemId} is moved more than once.` });
    if (!current || duplicate) return;
    const changed = current.xMm !== move.pose.xMm || current.yMm !== move.pose.yMm || current.rotationDeg !== move.pose.rotationDeg;
    if (current.locked && changed) groups[2].push({ code: "LOCKED_ITEM_CHANGED", path: `${path}/pose`, message: `Locked furniture item ${move.itemId} cannot change pose.` });
    if (!furnitureCatalogById(current.catalogId)!.allowedRotations.includes(move.pose.rotationDeg as RotationDeg)) groups[3].push({ code: "INVALID_ROTATION", path: `${path}/pose/rotationDeg`, message: `Rotation ${move.pose.rotationDeg} is not allowed for furniture item ${move.itemId}.` });
    else if (!changed) groups[4].push({ code: "NO_EFFECT_MOVE", path: `${path}/pose`, message: `Furniture item ${move.itemId} has no pose change.` });
  });
  const inputIssues = groups.flat();
  const sentinel = (issues: readonly ValidationIssue[]): OptionResult => ({ optionId: option.optionId, inputIndex, hardValid: false, stageable: false, issues, constraintResults: [], required: { satisfied: 0, total: requiredTotal }, preferred: { satisfied: 0, total: preferredTotal }, movedCount: 0, rotatedCount: 0, totalMovementMm: 0, minimumClearanceMm: 0, rank: null, proposalDigest: digest });
  if (inputIssues.length) return { result: sentinel(inputIssues) };
  const moveIndex = new Map(option.moves.map((move, index) => [move.itemId, index]));
  const normalizedMoves: Move[] = option.moves.map((move) => ({ itemId: move.itemId, pose: { ...move.pose, rotationDeg: move.pose.rotationDeg as RotationDeg } }));
  const replacements = new Map(normalizedMoves.map((move) => [move.itemId, move.pose]));
  const projected = state.furniture.map((item) => replacements.has(item.id) ? { ...item, ...replacements.get(item.id)! } : item);
  const geometry: ValidationIssue[][] = [[], [], []];
  for (let j = 0; j < option.moves.length; j++) { const item = projected.find((candidate) => candidate.id === option.moves[j].itemId)!; if (!isAabbInsideRoom(furnitureAabb(item), state.room)) geometry[0].push({ code: "ITEM_OUT_OF_BOUNDS", path: `/options/${inputIndex}/moves/${j}/pose`, message: `Furniture item ${item.id} is outside the room.` }); }
  const sorted = [...projected].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (let a = 0; a < sorted.length; a++) for (let b = a + 1; b < sorted.length; b++) if (aabbsOverlap(furnitureAabb(sorted[a]), furnitureAabb(sorted[b]))) {
    const indices = [moveIndex.get(sorted[a].id), moveIndex.get(sorted[b].id)].filter((v): v is number => v !== undefined); if (indices.length) geometry[1].push({ code: "ITEM_OVERLAP", path: `/options/${inputIndex}/moves/${Math.min(...indices)}/pose`, message: `Furniture items ${sorted[a].id} and ${sorted[b].id} overlap.` });
  }
  for (const item of sorted) for (const feature of [...state.features].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) { const keepOut = featureKeepOutAabb(feature, state.room); const j = moveIndex.get(item.id); if (j !== undefined && keepOut && aabbsOverlap(furnitureAabb(item), keepOut)) geometry[2].push({ code: "FEATURE_KEEP_OUT_INTERSECTION", path: `/options/${inputIndex}/moves/${j}/pose`, message: `Furniture item ${item.id} intersects keep-out for feature ${feature.id}.` }); }
  const geometryIssues = geometry.flat(); if (geometryIssues.length) return { result: sentinel(geometryIssues) };
  const constraintResults = evaluateConstraints(state, projected); const requiredSatisfied = constraintResults.filter((r) => r.strength === "required" && r.satisfied).length; const preferredSatisfied = constraintResults.filter((r) => r.strength === "preferred" && r.satisfied).length;
  const issues = constraintResults.filter((r) => r.strength === "required" && !r.satisfied).map((r): ValidationIssue => ({ code: "REQUIRED_CONSTRAINT_UNSATISFIED", path: `/options/${inputIndex}`, message: `Required constraint ${r.constraintId} is not satisfied.` }));
  let movedCount = 0, rotatedCount = 0, totalMovementMm = 0;
  for (const move of normalizedMoves) { const current = byId.get(move.itemId)!; movedCount++; if (current.rotationDeg !== move.pose.rotationDeg) rotatedCount++; totalMovementMm += Math.round(Math.hypot(move.pose.xMm - current.xMm, move.pose.yMm - current.yMm)); }
  const stageable = requiredSatisfied === requiredTotal;
  return { result: { optionId: option.optionId, inputIndex, hardValid: true, stageable, issues, constraintResults, required: { satisfied: requiredSatisfied, total: requiredTotal }, preferred: { satisfied: preferredSatisfied, total: preferredTotal }, movedCount, rotatedCount, totalMovementMm, minimumClearanceMm: minimumClearance(state, projected), rank: 0, proposalDigest: digest }, projectedFurniture: projected, normalizedMoves };
}

export async function validateLayoutOptions(context: ValidationContext, input: unknown): Promise<ToolResult<ValidateLayoutOptionsData>> {
  const decoded = decodeValidate(input); if (!decoded) return fail("INVALID_INPUT"); if (decoded.unsupported) return fail("UNSUPPORTED_CONSTRAINT"); const request = decoded.request!;
  if (request.baseRevision !== context.baseRevision || request.baseHash !== context.baseHash) return fail("REVISION_CONFLICT");
  if (JSON.stringify(request.constraints) !== JSON.stringify(context.workingState.constraints)) return fail("INVALID_INPUT");
  const evaluated = await Promise.all(request.options.map((option, index) => evaluateOption(context, option, index))); const results = evaluated.map((entry) => entry.result);
  const ranked = results.filter((r) => r.hardValid).sort((a, b) => Number(b.stageable) - Number(a.stageable) || b.required.satisfied - a.required.satisfied || b.preferred.satisfied - a.preferred.satisfied || a.movedCount - b.movedCount || a.rotatedCount - b.rotatedCount || a.totalMovementMm - b.totalMovementMm || b.minimumClearanceMm - a.minimumClearanceMm || a.inputIndex - b.inputIndex);
  const ranks = new Map(ranked.map((result, index) => [result.inputIndex, index + 1]));
  const rankedResults = results.map((result) => result.hardValid ? { ...result, rank: ranks.get(result.inputIndex)! } : result);
  return { ok: true, data: { baseRevision: context.baseRevision, baseHash: context.baseHash, results: rankedResults, rankedOptionIds: ranked.map((r) => r.optionId) } };
}

export async function recomputeStageValidation(context: ValidationContext, input: unknown): Promise<ToolResult<StageValidationSummary>> {
  const decoded = decodeStage(input); if (!decoded) return fail("INVALID_INPUT"); if (decoded.unsupported) return fail("UNSUPPORTED_CONSTRAINT"); const request = decoded.request!;
  if (request.baseRevision !== context.baseRevision || request.baseHash !== context.baseHash) return fail("REVISION_CONFLICT");
  if (JSON.stringify(request.constraints) !== JSON.stringify(context.workingState.constraints)) return fail("INVALID_INPUT");
  const digest = await proposalDigest(request.baseRevision, request.baseHash, request.constraints, request.optionId, request.moves); if (digest !== request.proposalDigest) return fail("DIGEST_MISMATCH");
  const evaluated = await evaluateOption(context, { optionId: request.optionId, moves: request.moves }, 0); const result = evaluated.result; if (!result.hardValid || !result.stageable) return fail("OPTION_INVALID");
  return { ok: true, data: { optionId: result.optionId, hardValid: true, stageable: true, issues: [], constraintResults: result.constraintResults, required: result.required, preferred: result.preferred, movedCount: result.movedCount, rotatedCount: result.rotatedCount, totalMovementMm: result.totalMovementMm, minimumClearanceMm: result.minimumClearanceMm, proposalDigest: result.proposalDigest } };
}

export const verifyStageRequest: StageVerifier = async ({ request, workingState, baseRevision, baseHash }) => {
  const validation = await recomputeStageValidation({ workingState, baseRevision, baseHash }, request); if (!validation.ok) return validation;
  const moves = request.moves.map((move) => ({ itemId: move.itemId, pose: { ...move.pose, rotationDeg: move.pose.rotationDeg as RotationDeg } })); const replacements = new Map(moves.map((move) => [move.itemId, move.pose]));
  const projectedFurniture = workingState.furniture.map((item) => replacements.has(item.id) ? { ...item, ...replacements.get(item.id)! } : item);
  return { ok: true, data: { optionId: request.optionId, proposalDigest: request.proposalDigest, moves, validation: validation.data, projectedFurniture } };
};
