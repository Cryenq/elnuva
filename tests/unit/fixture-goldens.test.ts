import { describe, expect, it } from "vitest";
import { recomputeStageValidation, validateLayoutOptions } from "../../src/domain/validator";
import { createTemplateState } from "../../src/domain/templates";
import type { ConstraintResult, StageValidationSummary, TemplateId } from "../../src/domain/types";

const BASE_HASHES = {
  "home-office": "54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e",
  bedroom: "bf71347d179de915dfb3976edd97e39da3673b35a94547dd51ed8ce3721a081b",
  study: "b2ba6f48701ab423805262c9136c6052ae3a5052da50448290124d087f764274",
} as const;

const MOVES = {
  homeInvalid: [{ itemId: "desk-main", pose: { xMm: 1100, yMm: 2400, rotationDeg: 0 } }],
  homeValid: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }],
  bedroomInvalid: [{ itemId: "bed-main", pose: { xMm: 1000, yMm: 2600, rotationDeg: 0 } }],
  bedroomValid: [
    { itemId: "bed-main", pose: { xMm: 2700, yMm: 2100, rotationDeg: 0 } },
    { itemId: "nightstand-main", pose: { xMm: 3950, yMm: 2500, rotationDeg: 90 } },
  ],
  studyInvalid: [{ itemId: "table-main", pose: { xMm: 700, yMm: 900, rotationDeg: 0 } }],
  studyValid: [
    { itemId: "table-main", pose: { xMm: 1500, yMm: 2100, rotationDeg: 0 } },
    { itemId: "chair-main", pose: { xMm: 2300, yMm: 1400, rotationDeg: 0 } },
  ],
} as const;

const CONSTRAINT_RESULTS = {
  homeInvalid: [
    { constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: false, operator: "clear", actualMm: null, targetMm: 900 },
    { constraintId: "c-radiator", type: "feature_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 1677, targetMm: 800 },
    { constraintId: "c-window", type: "feature_distance", strength: "preferred", satisfied: false, operator: "lte", actualMm: 2050, targetMm: 700 },
    { constraintId: "c-chair", type: "item_distance", strength: "preferred", satisfied: false, operator: "lte", actualMm: 602, targetMm: 500 },
  ] satisfies readonly ConstraintResult[],
  homeValid: [
    { constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: true, operator: "clear", actualMm: null, targetMm: 900 },
    { constraintId: "c-radiator", type: "feature_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 850, targetMm: 800 },
    { constraintId: "c-window", type: "feature_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 150, targetMm: 700 },
    { constraintId: "c-chair", type: "item_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 150, targetMm: 500 },
  ] satisfies readonly ConstraintResult[],
  bedroomInvalid: [
    { constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: false, operator: "clear", actualMm: null, targetMm: 900 },
    { constraintId: "c-radiator", type: "feature_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 1755, targetMm: 800 },
    { constraintId: "c-window", type: "feature_distance", strength: "preferred", satisfied: false, operator: "lte", actualMm: 2200, targetMm: 700 },
    { constraintId: "c-nightstand", type: "item_distance", strength: "preferred", satisfied: false, operator: "lte", actualMm: 1300, targetMm: 300 },
  ] satisfies readonly ConstraintResult[],
  bedroomValid: [
    { constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: true, operator: "clear", actualMm: null, targetMm: 900 },
    { constraintId: "c-radiator", type: "feature_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 1150, targetMm: 800 },
    { constraintId: "c-window", type: "feature_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 500, targetMm: 700 },
    { constraintId: "c-nightstand", type: "item_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 50, targetMm: 300 },
  ] satisfies readonly ConstraintResult[],
  studyInvalid: [
    { constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: false, operator: "clear", actualMm: null, targetMm: 800 },
    { constraintId: "c-radiator", type: "feature_distance", strength: "required", satisfied: false, operator: "gte", actualMm: 200, targetMm: 700 },
    { constraintId: "c-window", type: "feature_distance", strength: "preferred", satisfied: false, operator: "lte", actualMm: 1500, targetMm: 700 },
    { constraintId: "c-chair", type: "item_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 400, targetMm: 400 },
  ] satisfies readonly ConstraintResult[],
  studyValid: [
    { constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: true, operator: "clear", actualMm: null, targetMm: 800 },
    { constraintId: "c-radiator", type: "feature_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 750, targetMm: 700 },
    { constraintId: "c-window", type: "feature_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 300, targetMm: 700 },
    { constraintId: "c-chair", type: "item_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 0, targetMm: 400 },
  ] satisfies readonly ConstraintResult[],
} as const;

const FIXTURES = [
  {
    templateId: "home-office" as const, invalid: { optionId: "home-invalid", moves: MOVES.homeInvalid }, valid: { optionId: "home-valid", moves: MOVES.homeValid },
    expectedResults: [
      { optionId: "home-invalid", inputIndex: 0, hardValid: true, stageable: false, issues: [{ code: "REQUIRED_CONSTRAINT_UNSATISFIED", path: "/options/0", message: "Required constraint c-door is not satisfied." }], constraintResults: CONSTRAINT_RESULTS.homeInvalid, required: { satisfied: 1, total: 2 }, preferred: { satisfied: 0, total: 2 }, movedCount: 1, rotatedCount: 0, totalMovementMm: 2360, minimumClearanceMm: 250, rank: 2, proposalDigest: "cea21af76de525f9dce281bb4ed0c1cee13b2eb9f2fdd1933f44d0c9c27b0a5b" },
      { optionId: "home-valid", inputIndex: 1, hardValid: true, stageable: true, issues: [], constraintResults: CONSTRAINT_RESULTS.homeValid, required: { satisfied: 2, total: 2 }, preferred: { satisfied: 2, total: 2 }, movedCount: 1, rotatedCount: 0, totalMovementMm: 600, minimumClearanceMm: 100, rank: 1, proposalDigest: "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f" },
    ], rankedOptionIds: ["home-valid", "home-invalid"], stageKey: "fixture-home-0001",
    stageSummary: { optionId: "home-valid", hardValid: true, stageable: true, issues: [], constraintResults: CONSTRAINT_RESULTS.homeValid, required: { satisfied: 2, total: 2 }, preferred: { satisfied: 2, total: 2 }, movedCount: 1, rotatedCount: 0, totalMovementMm: 600, minimumClearanceMm: 100, proposalDigest: "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f" } satisfies StageValidationSummary,
  },
  {
    templateId: "bedroom" as const, invalid: { optionId: "bedroom-invalid", moves: MOVES.bedroomInvalid }, valid: { optionId: "bedroom-valid", moves: MOVES.bedroomValid },
    expectedResults: [
      { optionId: "bedroom-invalid", inputIndex: 0, hardValid: true, stageable: false, issues: [{ code: "REQUIRED_CONSTRAINT_UNSATISFIED", path: "/options/0", message: "Required constraint c-door is not satisfied." }], constraintResults: CONSTRAINT_RESULTS.bedroomInvalid, required: { satisfied: 1, total: 2 }, preferred: { satisfied: 0, total: 2 }, movedCount: 1, rotatedCount: 0, totalMovementMm: 1315, minimumClearanceMm: 0, rank: 2, proposalDigest: "8a4a157230bd636bccdb6dccdbcb02535274ed2d8ff0557588ebeceafc3b2c41" },
      { optionId: "bedroom-valid", inputIndex: 1, hardValid: true, stageable: true, issues: [], constraintResults: CONSTRAINT_RESULTS.bedroomValid, required: { satisfied: 2, total: 2 }, preferred: { satisfied: 2, total: 2 }, movedCount: 2, rotatedCount: 1, totalMovementMm: 900, minimumClearanceMm: 50, rank: 1, proposalDigest: "ed108b27fb2579fd0984b3f1cc3ab2a658d0d530f8a0f1825971ac9f477f785e" },
    ], rankedOptionIds: ["bedroom-valid", "bedroom-invalid"], stageKey: "fixture-bedroom-0001",
    stageSummary: { optionId: "bedroom-valid", hardValid: true, stageable: true, issues: [], constraintResults: CONSTRAINT_RESULTS.bedroomValid, required: { satisfied: 2, total: 2 }, preferred: { satisfied: 2, total: 2 }, movedCount: 2, rotatedCount: 1, totalMovementMm: 900, minimumClearanceMm: 50, proposalDigest: "ed108b27fb2579fd0984b3f1cc3ab2a658d0d530f8a0f1825971ac9f477f785e" } satisfies StageValidationSummary,
  },
  {
    templateId: "study" as const, invalid: { optionId: "study-invalid", moves: MOVES.studyInvalid }, valid: { optionId: "study-valid", moves: MOVES.studyValid },
    expectedResults: [
      { optionId: "study-invalid", inputIndex: 0, hardValid: true, stageable: false, issues: [{ code: "REQUIRED_CONSTRAINT_UNSATISFIED", path: "/options/0", message: "Required constraint c-door is not satisfied." }, { code: "REQUIRED_CONSTRAINT_UNSATISFIED", path: "/options/0", message: "Required constraint c-radiator is not satisfied." }], constraintResults: CONSTRAINT_RESULTS.studyInvalid, required: { satisfied: 0, total: 2 }, preferred: { satisfied: 1, total: 2 }, movedCount: 1, rotatedCount: 0, totalMovementMm: 1300, minimumClearanceMm: 100, rank: 2, proposalDigest: "99ac47e0327b3a735f9661fe5b421248ad22abe3452692ecf9d5c70b9d5f339c" },
      { optionId: "study-valid", inputIndex: 1, hardValid: true, stageable: true, issues: [], constraintResults: CONSTRAINT_RESULTS.studyValid, required: { satisfied: 2, total: 2 }, preferred: { satisfied: 2, total: 2 }, movedCount: 2, rotatedCount: 0, totalMovementMm: 1661, minimumClearanceMm: 0, rank: 1, proposalDigest: "8492eb42816a0c8d1018410e7a5e16b120051a8166669ca9924a3d65d94fd24f" },
    ], rankedOptionIds: ["study-valid", "study-invalid"], stageKey: "fixture-study-0001",
    stageSummary: { optionId: "study-valid", hardValid: true, stageable: true, issues: [], constraintResults: CONSTRAINT_RESULTS.studyValid, required: { satisfied: 2, total: 2 }, preferred: { satisfied: 2, total: 2 }, movedCount: 2, rotatedCount: 0, totalMovementMm: 1661, minimumClearanceMm: 0, proposalDigest: "8492eb42816a0c8d1018410e7a5e16b120051a8166669ca9924a3d65d94fd24f" } satisfies StageValidationSummary,
  },
] as const;

const HARD_INVALID_CASES = [
  ["issue-unknown", [{ itemId: "unknown-item", pose: { xMm: 1000, yMm: 1000, rotationDeg: 0 } }], { code: "UNKNOWN_ITEM", path: "/options/0/moves/0/itemId", message: "Unknown furniture item unknown-item." }, "dae22e0178d7f5d38534461a9ba929b982fd54e7a5fb2684b59d953967a1bc38"],
  ["issue-duplicate", [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }, { itemId: "desk-main", pose: { xMm: 2000, yMm: 500, rotationDeg: 0 } }], { code: "DUPLICATE_MOVE", path: "/options/0/moves/1/itemId", message: "Furniture item desk-main is moved more than once." }, "d4f7e435a5389cc0bdb7c3053e51bded4d3318e9e5d1dc409643d329a73d87f9"],
  ["issue-locked", [{ itemId: "storage-main", pose: { xMm: 750, yMm: 600, rotationDeg: 0 } }], { code: "LOCKED_ITEM_CHANGED", path: "/options/0/moves/0/pose", message: "Locked furniture item storage-main cannot change pose." }, "dcb6c6c559419485ea0ebdb0db6e94096c887ab98c0aa7c63c4f5d9796de5296"],
  ["issue-unchanged", [{ itemId: "desk-main", pose: { xMm: 2500, yMm: 500, rotationDeg: 0 } }], { code: "NO_EFFECT_MOVE", path: "/options/0/moves/0/pose", message: "Furniture item desk-main has no pose change." }, "d8ec32224c26f5a81467c4b9946d0e2c849cba4b99d34e741ea4d15a74b7611e"],
  ["issue-rotation", [{ itemId: "desk-main", pose: { xMm: 2450, yMm: 500, rotationDeg: 45 } }], { code: "INVALID_ROTATION", path: "/options/0/moves/0/pose/rotationDeg", message: "Rotation 45 is not allowed for furniture item desk-main." }, "bdb8e6c69f58b19fa6cd28d27e14083bad02f820a80fbe42b646c44596cd6e74"],
  ["issue-bounds", [{ itemId: "chair-main", pose: { xMm: 200, yMm: 1500, rotationDeg: 0 } }], { code: "ITEM_OUT_OF_BOUNDS", path: "/options/0/moves/0/pose", message: "Furniture item chair-main is outside the room." }, "51599e03ddd32ca3e09304bfb0b86720b6e68170f26b3fabf1ac997f847f2550"],
  ["issue-overlap", [{ itemId: "chair-main", pose: { xMm: 2500, yMm: 500, rotationDeg: 0 } }], { code: "ITEM_OVERLAP", path: "/options/0/moves/0/pose", message: "Furniture items chair-main and desk-main overlap." }, "6f7c82dffc664ca0b967a8e61dfda21e830042776e5ffc082ceea02de83e6444"],
  ["issue-keep-out", [{ itemId: "chair-main", pose: { xMm: 3300, yMm: 1300, rotationDeg: 0 } }], { code: "FEATURE_KEEP_OUT_INTERSECTION", path: "/options/0/moves/0/pose", message: "Furniture item chair-main intersects keep-out for feature radiator-east." }, "08f20de68836ea87390f14c52b28f5eef5d633579953f6b2cd6b11725948752f"],
] as const;

function context(templateId: TemplateId) {
  return { workingState: createTemplateState(templateId), baseRevision: 1, baseHash: BASE_HASHES[templateId] };
}

describe("literal Validate fixture goldens", () => {
  it.each(FIXTURES)("returns both complete OptionResults for $templateId", async (fixture) => {
    const ctx = context(fixture.templateId);
    const result = await validateLayoutOptions(ctx, { baseRevision: 1, baseHash: BASE_HASHES[fixture.templateId], constraints: ctx.workingState.constraints, options: [fixture.invalid, fixture.valid] });
    expect(result).toStrictEqual({ ok: true, data: { baseRevision: 1, baseHash: BASE_HASHES[fixture.templateId], results: fixture.expectedResults, rankedOptionIds: fixture.rankedOptionIds } });
  });

  it.each(HARD_INVALID_CASES)("returns the complete zero sentinel for %s", async (optionId, moves, issue, digest) => {
    const ctx = context("home-office");
    const result = await validateLayoutOptions(ctx, { baseRevision: 1, baseHash: BASE_HASHES["home-office"], constraints: ctx.workingState.constraints, options: [{ optionId, moves }] });
    expect(result).toStrictEqual({ ok: true, data: { baseRevision: 1, baseHash: BASE_HASHES["home-office"], results: [{ optionId, inputIndex: 0, hardValid: false, stageable: false, issues: [issue], constraintResults: [], required: { satisfied: 0, total: 2 }, preferred: { satisfied: 0, total: 2 }, movedCount: 0, rotatedCount: 0, totalMovementMm: 0, minimumClearanceMm: 0, rank: null, proposalDigest: digest }], rankedOptionIds: [] } });
  });
});

describe("literal Stage fixture goldens", () => {
  it.each(FIXTURES)("returns the exact rank-independent summary for $templateId", async (fixture) => {
    const ctx = context(fixture.templateId);
    const result = await recomputeStageValidation(ctx, { baseRevision: 1, baseHash: BASE_HASHES[fixture.templateId], constraints: ctx.workingState.constraints, optionId: fixture.valid.optionId, moves: fixture.valid.moves, proposalDigest: fixture.stageSummary.proposalDigest, idempotencyKey: fixture.stageKey });
    expect(result).toStrictEqual({ ok: true, data: fixture.stageSummary });
    if (result.ok) {
      expect(result.data).not.toHaveProperty("rank");
      expect(result.data).not.toHaveProperty("inputIndex");
      expect(JSON.stringify(result.data)).toBe(JSON.stringify(fixture.stageSummary));
    }
  });
});
