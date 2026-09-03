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
export function isInspectSpatialLayoutInput(input: unknown): input is Record<string, never> { if (typeof input !== "object" || input === null || Array.isArray(input)) return false; try { const prototype = Object.getPrototypeOf(input); return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(input).length === 0; } catch { return false; } }
