const id = Object.freeze({ type: "string" as const, pattern: "^[a-z][a-z0-9-]{0,39}$", minLength: 1, maxLength: 40 });
const hash = Object.freeze({ type: "string" as const, pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const strength = Object.freeze({ type: "string" as const, enum: ["required", "preferred"] });
const relation = Object.freeze({ type: "string" as const, enum: ["near", "away"] });
const closed = (properties: Record<string, unknown>, required: readonly string[]) => Object.freeze({ type: "object" as const, properties: Object.freeze(properties), required: Object.freeze([...required]), additionalProperties: false as const });
const doorConstraint = closed({ constraintId: id, type: { const: "door_path_clear" }, strength, featureId: id, widthMm: { type: "integer", minimum: 500, maximum: 1600 } }, ["constraintId", "type", "strength", "featureId", "widthMm"]);
const featureConstraint = closed({ constraintId: id, type: { const: "feature_distance" }, strength, itemId: id, featureId: id, relation, thresholdMm: { type: "integer", minimum: 0, maximum: 4000 } }, ["constraintId", "type", "strength", "itemId", "featureId", "relation", "thresholdMm"]);
const itemConstraint = closed({ constraintId: id, type: { const: "item_distance" }, strength, itemAId: id, itemBId: id, relation, thresholdMm: { type: "integer", minimum: 0, maximum: 4000 } }, ["constraintId", "type", "strength", "itemAId", "itemBId", "relation", "thresholdMm"]);
const constraints = Object.freeze({ type: "array" as const, minItems: 0, maxItems: 8, items: Object.freeze({ oneOf: [doorConstraint, featureConstraint, itemConstraint] }) });
const pose = closed({ xMm: { type: "integer" }, yMm: { type: "integer" }, rotationDeg: { type: "integer" } }, ["xMm", "yMm", "rotationDeg"]);
const move = closed({ itemId: id, pose }, ["itemId", "pose"]);
const moves = Object.freeze({ type: "array" as const, minItems: 1, maxItems: 8, items: move });
const option = closed({ optionId: id, moves }, ["optionId", "moves"]);
export const INSPECT_SPATIAL_LAYOUT_INPUT_SCHEMA = Object.freeze({ type: "object" as const, properties: Object.freeze({}), additionalProperties: false as const });
export const VALIDATE_LAYOUT_OPTIONS_INPUT_SCHEMA = closed({ baseRevision: { type: "integer", minimum: 1 }, baseHash: hash, constraints, options: { type: "array", minItems: 1, maxItems: 3, items: option } }, ["baseRevision", "baseHash", "constraints", "options"]);
export const STAGE_LAYOUT_PREVIEW_INPUT_SCHEMA = closed({ baseRevision: { type: "integer", minimum: 1 }, baseHash: hash, constraints, optionId: id, moves, proposalDigest: hash, idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_-]{16,80}$", minLength: 16, maxLength: 80 } }, ["baseRevision", "baseHash", "constraints", "optionId", "moves", "proposalDigest", "idempotencyKey"]);
export function isInspectSpatialLayoutInput(input: unknown): input is Record<string, never> { try { if (typeof input !== "object" || input === null || Array.isArray(input)) return false; const prototype = Object.getPrototypeOf(input); return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(input).length === 0; } catch { return false; } }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!record(value)) return false;
  try { const own = Reflect.ownKeys(value); return own.length === keys.length && own.every((key) => {
    if (typeof key !== "string" || !keys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && !descriptor.get && !descriptor.set;
  }); } catch { return false; }
};
const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const validHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const plainArray = (value: unknown): value is unknown[] => { try {
  if (!Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === value.length + 1 && own.every((key) => {
    if (key === "length") return true;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && !descriptor.get && !descriptor.set;
  });
} catch { return false; } };
const validConstraint = (value: unknown): boolean => {
  if (!record(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  const base = validId(value.constraintId) && (value.strength === "required" || value.strength === "preferred");
  if (value.type === "door_path_clear") return base && exact(value, ["constraintId", "type", "strength", "featureId", "widthMm"]) && validId(value.featureId) && safeInteger(value.widthMm) && value.widthMm >= 500 && value.widthMm <= 1600;
  if (value.type === "feature_distance") return base && exact(value, ["constraintId", "type", "strength", "itemId", "featureId", "relation", "thresholdMm"]) && validId(value.itemId) && validId(value.featureId) && (value.relation === "near" || value.relation === "away") && safeInteger(value.thresholdMm) && value.thresholdMm >= 0 && value.thresholdMm <= 4000;
  if (value.type === "item_distance") return base && exact(value, ["constraintId", "type", "strength", "itemAId", "itemBId", "relation", "thresholdMm"]) && validId(value.itemAId) && validId(value.itemBId) && value.itemAId !== value.itemBId && (value.relation === "near" || value.relation === "away") && safeInteger(value.thresholdMm) && value.thresholdMm >= 0 && value.thresholdMm <= 4000;
  return base && typeof value.type === "string" && exact(value, ["constraintId", "type", "strength"]);
};
const validMove = (value: unknown): boolean => exact(value, ["itemId", "pose"]) && validId(value.itemId) && exact(value.pose, ["xMm", "yMm", "rotationDeg"]) && safeInteger(value.pose.xMm) && safeInteger(value.pose.yMm) && safeInteger(value.pose.rotationDeg);
const validMoves = (value: unknown): boolean => plainArray(value) && value.length >= 1 && value.length <= 8 && value.every(validMove);
const validConstraints = (value: unknown): boolean => plainArray(value) && value.length <= 8 && value.every(validConstraint) && new Set(value.map((entry) => (entry as Record<string, unknown>).constraintId)).size === value.length;

export function isValidateLayoutOptionsInput(value: unknown): boolean {
  try { return exact(value, ["baseRevision", "baseHash", "constraints", "options"])
    && safeInteger(value.baseRevision) && value.baseRevision >= 1 && validHash(value.baseHash)
    && validConstraints(value.constraints) && plainArray(value.options) && value.options.length >= 1 && value.options.length <= 3
    && value.options.every((option) => exact(option, ["optionId", "moves"]) && validId(option.optionId) && validMoves(option.moves))
    && new Set(value.options.map((option) => (option as Record<string, unknown>).optionId)).size === value.options.length; } catch { return false; }
}
export function isStageLayoutPreviewInput(value: unknown): boolean {
  try { return exact(value, ["baseRevision", "baseHash", "constraints", "optionId", "moves", "proposalDigest", "idempotencyKey"])
    && safeInteger(value.baseRevision) && value.baseRevision >= 1 && validHash(value.baseHash) && validConstraints(value.constraints)
    && validId(value.optionId) && validMoves(value.moves) && validHash(value.proposalDigest)
    && typeof value.idempotencyKey === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(value.idempotencyKey); } catch { return false; }
}
