import { describe, expect, it } from "vitest";
import { hashWorkingState, proposalDigest } from "../../src/domain/hash";
import { recomputeStageValidation, validateLayoutOptions, verifyStageRequest } from "../../src/domain/validator";
import { createTemplateState } from "../../src/domain/templates";
import type { Constraint, StageVerifier, WorkingState } from "../../src/domain/types";

const HOME_HASH = "54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e";
const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const homeState = () => createTemplateState("home-office");
const move = (itemId: string, xMm: number, yMm: number, rotationDeg = 0) => ({ itemId, pose: { xMm, yMm, rotationDeg } });
const stageVerifier: StageVerifier = verifyStageRequest;

type Context = Readonly<{ workingState: WorkingState; baseRevision: number; baseHash: string }>;

async function contextFor(workingState: WorkingState, baseRevision = 1): Promise<Context> {
  return { workingState, baseRevision, baseHash: await hashWorkingState(workingState) };
}

function validateRequest(ctx: Context, options: readonly unknown[]) {
  return { baseRevision: ctx.baseRevision, baseHash: ctx.baseHash, constraints: ctx.workingState.constraints, options };
}

async function successData(resultPromise: Promise<unknown> | unknown): Promise<any> {
  const result = await resultPromise as any;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected success, got ${result.error?.code}.`);
  return result.data;
}

async function expectFailure(resultPromise: Promise<unknown> | unknown, code: string): Promise<void> {
  const result = await resultPromise as any;
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(result).not.toHaveProperty("data");
}

function simpleState(furniture: WorkingState["furniture"], constraints: readonly Constraint[] = [], features: WorkingState["features"] = [], widthMm = 5000, depthMm = 5000): WorkingState {
  return { schemaVersion: 1, templateId: "home-office", room: { widthMm, depthMm }, features, furniture, constraints };
}

describe("strict request classification", () => {
  it("accepts only the exact current request envelope", async () => {
    const ctx: Context = { workingState: homeState(), baseRevision: 1, baseHash: HOME_HASH };
    const valid = validateRequest(ctx, [{ optionId: "valid", moves: [move("desk-main", 1900, 500)] }]);
    const invalidCases: readonly [string, (request: any) => unknown][] = [
      ["null", () => null],
      ["missing envelope fields", () => ({})],
      ["unknown envelope field", (r) => ({ ...r, extra: true })],
      ["wrong revision primitive", (r) => ({ ...r, baseRevision: "1" })],
      ["fractional revision", (r) => ({ ...r, baseRevision: 1.5 })],
      ["unsafe revision", (r) => ({ ...r, baseRevision: Number.MAX_SAFE_INTEGER + 1 })],
      ["negative zero revision", (r) => ({ ...r, baseRevision: -0 })],
      ["wrong hash primitive", (r) => ({ ...r, baseHash: 1 })],
      ["non-hex hash", (r) => ({ ...r, baseHash: "z".repeat(64) })],
      ["empty options", (r) => ({ ...r, options: [] })],
      ["four options", (r) => ({ ...r, options: [r.options[0], { ...r.options[0], optionId: "b" }, { ...r.options[0], optionId: "c" }, { ...r.options[0], optionId: "d" }] })],
      ["unknown option field", (r) => ({ ...r, options: [{ ...r.options[0], extra: true }] })],
      ["invalid option id syntax", (r) => ({ ...r, options: [{ ...r.options[0], optionId: "Not-ASCII-slug" }] })],
      ["overlong option id", (r) => ({ ...r, options: [{ ...r.options[0], optionId: `a${"b".repeat(40)}` }] })],
      ["duplicate option id", (r) => ({ ...r, options: [r.options[0], structuredClone(r.options[0])] })],
      ["empty moves", (r) => ({ ...r, options: [{ ...r.options[0], moves: [] }] })],
      ["nine moves", (r) => ({ ...r, options: [{ ...r.options[0], moves: Array.from({ length: 9 }, (_, i) => move(`item-${i}`, 1000, 1000)) }] })],
      ["unknown move field", (r) => ({ ...r, options: [{ ...r.options[0], moves: [{ ...r.options[0].moves[0], extra: true }] }] })],
      ["invalid item id", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("Bad/item", 1000, 1000)] }] })],
      ["unknown pose field", (r) => ({ ...r, options: [{ ...r.options[0], moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0, zMm: 1 } }] }] })],
      ["wrong numeric primitive", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", "1900" as any, 500)] }] })],
      ["fractional coordinate", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", 1900.5, 500)] }] })],
      ["NaN coordinate", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", Number.NaN, 500)] }] })],
      ["infinite coordinate", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", Number.POSITIVE_INFINITY, 500)] }] })],
      ["negative zero coordinate", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", -0, 500)] }] })],
      ["unsafe coordinate", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", Number.MAX_SAFE_INTEGER + 1, 500)] }] })],
      ["fractional rotation", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", 1900, 500, 45.5)] }] })],
      ["negative zero rotation", (r) => ({ ...r, options: [{ ...r.options[0], moves: [move("desk-main", 1900, 500, -0)] }] })],
    ];

    for (const [label, mutate] of invalidCases) {
      await expectFailure(validateLayoutOptions(ctx, mutate(structuredClone(valid)) as never), "INVALID_INPUT");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("distinguishes current, malformed, foreign, reordered, unsupported, and stale inputs", async () => {
    const ctx: Context = { workingState: homeState(), baseRevision: 1, baseHash: HOME_HASH };
    const option = { optionId: "valid", moves: [move("desk-main", 1900, 500)] };
    const current = validateRequest(ctx, [option]);
    expect((await successData(validateLayoutOptions(ctx, current))).results).toHaveLength(1);

    const malformed = structuredClone(current) as any;
    delete malformed.constraints[0].widthMm;
    await expectFailure(validateLayoutOptions(ctx, malformed), "INVALID_INPUT");

    const foreign = structuredClone(current) as any;
    foreign.constraints[1].thresholdMm = 801;
    await expectFailure(validateLayoutOptions(ctx, foreign), "INVALID_INPUT");

    const reordered = { ...current, constraints: [...ctx.workingState.constraints].reverse() };
    await expectFailure(validateLayoutOptions(ctx, reordered as never), "INVALID_INPUT");

    const unsupported = structuredClone(current) as any;
    unsupported.constraints[0] = { constraintId: "c-door", type: "future_constraint", strength: "required" };
    await expectFailure(validateLayoutOptions(ctx, unsupported), "UNSUPPORTED_CONSTRAINT");

    await expectFailure(validateLayoutOptions(ctx, { ...current, baseRevision: 2 }), "REVISION_CONFLICT");
    await expectFailure(validateLayoutOptions(ctx, { ...current, baseHash: ZERO_HASH }), "REVISION_CONFLICT");
  });
});

describe("constraint boundaries and metric semantics", () => {
  it.each([
    ["north", { xMm: 2000, yMm: 2300 }, { xMm: 2000, yMm: 2299 }],
    ["south", { xMm: 2000, yMm: 1700 }, { xMm: 2000, yMm: 1701 }],
    ["west", { xMm: 2300, yMm: 2000 }, { xMm: 2299, yMm: 2000 }],
    ["east", { xMm: 1700, yMm: 2000 }, { xMm: 1701, yMm: 2000 }],
  ] as const)("builds the exact %s-wall corridor and permits boundary touch", async (wall, touch, overlap) => {
    const state = simpleState(
      [{ id: "chair-main", catalogId: "chair-600x600", xMm: 3500, yMm: 3500, rotationDeg: 0, locked: false }],
      [{ constraintId: "c-door", type: "door_path_clear", strength: "required", featureId: "door-main", widthMm: 500 }],
      [{ id: "door-main", catalogId: "door-900", wall, offsetMm: 1550 }],
      4000,
      4000,
    );
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "touch", moves: [move("chair-main", touch.xMm, touch.yMm)] },
      { optionId: "overlap", moves: [move("chair-main", overlap.xMm, overlap.yMm)] },
    ])));
    expect(data.results.map((result: any) => result.constraintResults)).toStrictEqual([
      [{ constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: true, operator: "clear", actualMm: null, targetMm: 500 }],
      [{ constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: false, operator: "clear", actualMm: null, targetMm: 500 }],
    ]);
    expect(data.rankedOptionIds).toStrictEqual(["touch", "overlap"]);
  });

  it("treats AABB edge touch as valid and one millimetre of positive-area overlap as hard-invalid", async () => {
    const state = simpleState([
      { id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: true },
      { id: "chair-b", catalogId: "chair-600x600", xMm: 2500, yMm: 1000, rotationDeg: 0, locked: false },
    ]);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "touch", moves: [move("chair-b", 1600, 1000)] },
      { optionId: "overlap", moves: [move("chair-b", 1599, 1000)] },
    ])));
    expect(data.results[0]).toMatchObject({ hardValid: true, stageable: true, minimumClearanceMm: 0, rank: 1 });
    expect(data.results[1]).toMatchObject({ hardValid: false, stageable: false, issues: [{ code: "ITEM_OVERLAP", path: "/options/1/moves/0/pose", message: "Furniture items chair-a and chair-b overlap." }], rank: null });
  });

  it("uses inclusive near/away equality and floors diagonal rectangle distance", async () => {
    const constraints: readonly Constraint[] = [
      { constraintId: "c-near", type: "item_distance", strength: "required", itemAId: "chair-a", itemBId: "chair-b", relation: "near", thresholdMm: 1 },
      { constraintId: "c-away", type: "item_distance", strength: "required", itemAId: "chair-a", itemBId: "chair-b", relation: "away", thresholdMm: 1 },
    ];
    const state = simpleState([
      { id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: true },
      { id: "chair-b", catalogId: "chair-600x600", xMm: 2200, yMm: 2200, rotationDeg: 0, locked: false },
    ], constraints, [], 4000, 4000);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "floor-one", moves: [move("chair-b", 1601, 1601)] },
      { optionId: "floor-two", moves: [move("chair-b", 1602, 1602)] },
    ])));
    expect(data.results.map((result: any) => result.constraintResults)).toStrictEqual([
      [
        { constraintId: "c-near", type: "item_distance", strength: "required", satisfied: true, operator: "lte", actualMm: 1, targetMm: 1 },
        { constraintId: "c-away", type: "item_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 1, targetMm: 1 },
      ],
      [
        { constraintId: "c-near", type: "item_distance", strength: "required", satisfied: false, operator: "lte", actualMm: 2, targetMm: 1 },
        { constraintId: "c-away", type: "item_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 2, targetMm: 1 },
      ],
    ]);
  });

  it("rounds each movement before summing and reports literal minimum clearance", async () => {
    const state = simpleState([
      { id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false },
      { id: "chair-b", catalogId: "chair-600x600", xMm: 3000, yMm: 3000, rotationDeg: 0, locked: false },
    ]);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [{ optionId: "two-diagonals", moves: [move("chair-a", 1001, 1001), move("chair-b", 3001, 3001)] }])));
    expect(data.results[0]).toMatchObject({ hardValid: true, movedCount: 2, rotatedCount: 0, totalMovementMm: 2, minimumClearanceMm: 701 });
  });

  it("counts a rotation-only square move without movement", async () => {
    const state = simpleState([{ id: "chair-main", catalogId: "chair-600x600", xMm: 2000, yMm: 2000, rotationDeg: 0, locked: false }], [], [], 4000, 4000);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [{ optionId: "rotate", moves: [move("chair-main", 2000, 2000, 90)] }])));
    expect(data.results[0]).toMatchObject({ hardValid: true, stageable: true, movedCount: 1, rotatedCount: 1, totalMovementMm: 0, minimumClearanceMm: 1700 });
  });
});

describe("deterministic issue and ranking order", () => {
  it("emits multiple input issues in the single normative code order", async () => {
    const state = simpleState([
      { id: "item-a", catalogId: "chair-600x600", xMm: 800, yMm: 800, rotationDeg: 0, locked: false },
      { id: "item-b", catalogId: "chair-600x600", xMm: 2200, yMm: 800, rotationDeg: 0, locked: true },
      { id: "item-c", catalogId: "chair-600x600", xMm: 3600, yMm: 800, rotationDeg: 0, locked: false },
      { id: "item-d", catalogId: "chair-600x600", xMm: 800, yMm: 3000, rotationDeg: 0, locked: false },
    ]);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [{ optionId: "many-issues", moves: [
      move("unknown-item", 1000, 1000), move("item-a", 900, 800), move("item-a", 1000, 800),
      move("item-b", 2300, 800), move("item-c", 3500, 800, 45), move("item-d", 800, 3000),
    ] }])));
    expect(data.results[0].issues).toStrictEqual([
      { code: "UNKNOWN_ITEM", path: "/options/0/moves/0/itemId", message: "Unknown furniture item unknown-item." },
      { code: "DUPLICATE_MOVE", path: "/options/0/moves/2/itemId", message: "Furniture item item-a is moved more than once." },
      { code: "LOCKED_ITEM_CHANGED", path: "/options/0/moves/3/pose", message: "Locked furniture item item-b cannot change pose." },
      { code: "INVALID_ROTATION", path: "/options/0/moves/4/pose/rotationDeg", message: "Rotation 45 is not allowed for furniture item item-c." },
      { code: "NO_EFFECT_MOVE", path: "/options/0/moves/5/pose", message: "Furniture item item-d has no pose change." },
    ]);
  });

  it("isolates stageable before required-invalid", async () => {
    const ctx: Context = { workingState: homeState(), baseRevision: 1, baseHash: HOME_HASH };
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "required-invalid", moves: [move("desk-main", 1100, 2400)] },
      { optionId: "stageable", moves: [move("desk-main", 1900, 500)] },
    ])));
    expect(data.rankedOptionIds).toStrictEqual(["stageable", "required-invalid"]);
  });

  it.each(["required", "preferred"] as const)("isolates higher %s satisfied", async (strength) => {
    const constraints: readonly Constraint[] = [
      { constraintId: "c-left", type: "item_distance", strength, itemAId: "item-a", itemBId: "item-b", relation: "away", thresholdMm: 1000 },
      { constraintId: "c-right", type: "item_distance", strength, itemAId: "item-a", itemBId: "item-c", relation: "away", thresholdMm: 1000 },
    ];
    const state = simpleState([
      { id: "item-a", catalogId: "chair-600x600", xMm: 2600, yMm: 2500, rotationDeg: 0, locked: false },
      { id: "item-b", catalogId: "chair-600x600", xMm: 1000, yMm: 2500, rotationDeg: 0, locked: true },
      { id: "item-c", catalogId: "chair-600x600", xMm: 4000, yMm: 2500, rotationDeg: 0, locked: true },
    ], constraints);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "lower-score-shorter-move", moves: [move("item-a", 2500, 2500)] },
      { optionId: "higher-score-longer-move", moves: [move("item-a", 2300, 2500)] },
    ])));
    expect(data.rankedOptionIds).toStrictEqual(["higher-score-longer-move", "lower-score-shorter-move"]);
  });

  it("isolates lower moved count before movement distance", async () => {
    const state = simpleState([
      { id: "item-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false },
      { id: "item-b", catalogId: "chair-600x600", xMm: 3000, yMm: 3000, rotationDeg: 0, locked: false },
    ]);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "two-short", moves: [move("item-a", 1001, 1001), move("item-b", 3001, 3001)] },
      { optionId: "one-long", moves: [move("item-a", 2000, 1000)] },
    ])));
    expect(data.rankedOptionIds).toStrictEqual(["one-long", "two-short"]);
  });

  it("isolates lower rotated count before movement distance", async () => {
    const state = simpleState([{ id: "chair-main", catalogId: "chair-600x600", xMm: 2000, yMm: 2000, rotationDeg: 0, locked: false }]);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "rotation-zero-movement", moves: [move("chair-main", 2000, 2000, 90)] },
      { optionId: "translation", moves: [move("chair-main", 2100, 2000)] },
    ])));
    expect(data.rankedOptionIds).toStrictEqual(["translation", "rotation-zero-movement"]);
  });

  it("isolates lower total movement", async () => {
    const state = simpleState([{ id: "chair-main", catalogId: "chair-600x600", xMm: 2000, yMm: 2000, rotationDeg: 0, locked: false }]);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "far", moves: [move("chair-main", 2200, 2000)] },
      { optionId: "near", moves: [move("chair-main", 2100, 2000)] },
    ])));
    expect(data.rankedOptionIds).toStrictEqual(["near", "far"]);
  });

  it("isolates higher minimum clearance after equal movement", async () => {
    const state = simpleState([{ id: "chair-main", catalogId: "chair-600x600", xMm: 1000, yMm: 2000, rotationDeg: 0, locked: false }], [], [], 4000, 4000);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "less-clear", moves: [move("chair-main", 900, 2000)] },
      { optionId: "more-clear", moves: [move("chair-main", 1100, 2000)] },
    ])));
    expect(data.results.map((result: any) => result.minimumClearanceMm)).toStrictEqual([600, 800]);
    expect(data.rankedOptionIds).toStrictEqual(["more-clear", "less-clear"]);
  });

  it("uses original input order as the final tie breaker", async () => {
    const state = simpleState([{ id: "chair-main", catalogId: "chair-600x600", xMm: 1000, yMm: 2000, rotationDeg: 0, locked: false }]);
    const ctx = await contextFor(state);
    const data = await successData(validateLayoutOptions(ctx, validateRequest(ctx, [
      { optionId: "first", moves: [move("chair-main", 1100, 2000)] },
      { optionId: "second", moves: [move("chair-main", 1100, 2000)] },
    ])));
    expect(data.rankedOptionIds).toStrictEqual(["first", "second"]);
    expect(data.results.map((result: any) => result.rank)).toStrictEqual([1, 2]);
  });
});

describe("determinism, non-mutation, and Stage recomputation", () => {
  it("returns byte-equivalent results and mutates neither context nor request", async () => {
    const ctx: Context = { workingState: homeState(), baseRevision: 1, baseHash: HOME_HASH };
    const request = validateRequest(ctx, [{ optionId: "home-valid", moves: [move("desk-main", 1900, 500)] }]);
    const beforeContext = structuredClone(ctx);
    const beforeRequest = structuredClone(request);
    const first = await validateLayoutOptions(ctx, request);
    const second = await validateLayoutOptions(ctx, request);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(ctx).toStrictEqual(beforeContext);
    expect(request).toStrictEqual(beforeRequest);
  });

  it("exports a StageVerifier and rejects an option that changed state makes invalid", async () => {
    expect(typeof stageVerifier).toBe("function");
    const changed = structuredClone(homeState()) as any;
    changed.furniture = changed.furniture.map((item: any) => item.id === "desk-main" ? { ...item, xMm: 1900, yMm: 500 } : item);
    const ctx = await contextFor(changed);
    const moves = [move("desk-main", 1900, 500)];
    const digest = await proposalDigest(ctx.baseRevision, ctx.baseHash, ctx.workingState.constraints, "home-valid", moves);
    const request = { baseRevision: ctx.baseRevision, baseHash: ctx.baseHash, constraints: ctx.workingState.constraints, optionId: "home-valid", moves, proposalDigest: digest, idempotencyKey: "changed-state-0001" };
    await expectFailure(recomputeStageValidation(ctx, request), "OPTION_INVALID");
    await expectFailure(stageVerifier({ request, workingState: ctx.workingState, baseRevision: ctx.baseRevision, baseHash: ctx.baseHash }), "OPTION_INVALID");
  });
});
