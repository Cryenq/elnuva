import { describe, expect, it, vi } from "vitest";

import { createHomeOfficeInspectData } from "../../src/domain/fixture";
import { createDocumentStore, type DomainStore, type StoreSnapshot } from "../../src/domain/store";
import type { InspectSpatialLayoutData, StageRequest, StageSuccessData, StageVerificationInput, ToolResult, VerifiedStageData } from "../../src/domain/types";
import type { ValidateLayoutOptionsData } from "../../src/domain/validator";
import { verifyStageRequest } from "../../src/domain/validator";
import {
  createStageLayoutPreviewHandler,
  createValidateLayoutOptionsHandler,
  createWebMcpHandlers,
} from "../../src/webmcp/handlers";
import { registerWebMcpTools } from "../../src/webmcp/register";
import type { ModelContextTool } from "../../src/webmcp/types";

const HOME_DIGEST = "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f";
const signal = (): AbortSignal => new AbortController().signal;

type CapturedTool = ModelContextTool;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function validOption(snapshot: StoreSnapshot) {
  return {
    baseRevision: snapshot.baseRevision,
    baseHash: snapshot.baseHash,
    constraints: snapshot.workingState.constraints,
    options: [{ optionId: "home-valid", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }] }],
  };
}

function validStage(snapshot: StoreSnapshot): StageRequest {
  return {
    baseRevision: snapshot.baseRevision,
    baseHash: snapshot.baseHash,
    constraints: snapshot.workingState.constraints,
    optionId: "home-valid",
    moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }],
    proposalDigest: HOME_DIGEST,
    idempotencyKey: "fixture-home-0001",
  };
}

const expectedStageValidation = {
  optionId: "home-valid",
  hardValid: true,
  stageable: true,
  issues: [],
  constraintResults: [
    { constraintId: "c-door", type: "door_path_clear", strength: "required", satisfied: true, operator: "clear", actualMm: null, targetMm: 900 },
    { constraintId: "c-radiator", type: "feature_distance", strength: "required", satisfied: true, operator: "gte", actualMm: 850, targetMm: 800 },
    { constraintId: "c-window", type: "feature_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 150, targetMm: 700 },
    { constraintId: "c-chair", type: "item_distance", strength: "preferred", satisfied: true, operator: "lte", actualMm: 150, targetMm: 500 },
  ],
  required: { satisfied: 2, total: 2 },
  preferred: { satisfied: 2, total: 2 },
  movedCount: 1,
  rotatedCount: 0,
  totalMovementMm: 600,
  minimumClearanceMm: 100,
  proposalDigest: HOME_DIGEST,
} as const;

async function registeredTools(store: DomainStore) {
  const tools: CapturedTool[] = [];
  const document = {
    modelContext: { registerTool: vi.fn(async (tool: CapturedTool) => { tools.push(tool); }) },
  } as unknown as Document;
  const registration = await registerWebMcpTools({ document, ...createWebMcpHandlers(store) });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<CapturedTool["name"], CapturedTool>;
  return { registration, tools, byName };
}

describe("T06 registered handler/store integration", () => {
  it("invokes all three registered execute functions against one store with exact effect boundaries", async () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const verifier = vi.fn(async (input: StageVerificationInput): Promise<ToolResult<VerifiedStageData>> => verifyStageRequest(input));
    const store = createDocumentStore({ storage, stageVerifier: verifier });
    const { registration, tools, byName } = await registeredTools(store);
    const before = await store.snapshot();

    expect(tools.map((tool) => tool.name)).toStrictEqual([
      "inspect_spatial_layout",
      "validate_layout_options",
      "stage_layout_preview",
    ]);

    const inspected = await byName.inspect_spatial_layout.execute({}, { signal: signal() }) as ToolResult<InspectSpatialLayoutData>;
    expect(inspected).toStrictEqual({ ok: true, data: createHomeOfficeInspectData() });
    if (typeof inspected === "object" && inspected !== null && "ok" in inspected && inspected.ok) {
      expect(inspected.data).not.toHaveProperty("activeTemplateId");
      expect(inspected.data).not.toHaveProperty("error");
      expect(inspected.data).not.toHaveProperty("undo");
      expect(inspected.data).not.toHaveProperty("saved");
      expect(inspected.data).not.toHaveProperty("idempotencyKey");
    }
    expect(await store.snapshot()).toStrictEqual(before);

    const validated = await byName.validate_layout_options.execute(validOption(before), { signal: signal() }) as ToolResult<ValidateLayoutOptionsData>;
    expect(validated).toStrictEqual({
      ok: true,
      data: {
        baseRevision: 1,
        baseHash: before.baseHash,
        results: [{ ...expectedStageValidation, inputIndex: 0, rank: 1 }],
        rankedOptionIds: ["home-valid"],
      },
    });
    expect(await store.snapshot()).toStrictEqual(before);
    expect(store.recordCount).toBe(0);
    expect(storage.setItem).not.toHaveBeenCalled();

    const staged = await byName.stage_layout_preview.execute(validStage(before), { signal: signal() }) as ToolResult<StageSuccessData>;
    expect(staged).toStrictEqual({
      ok: true,
      data: {
        previewId: HOME_DIGEST,
        optionId: "home-valid",
        proposalDigest: HOME_DIGEST,
        validation: expectedStageValidation,
        notApplied: true,
        notSaved: true,
        requiresHumanAction: true,
        allowedHumanActions: ["apply", "discard"],
      },
    });
    if (typeof staged === "object" && staged !== null && "ok" in staged && staged.ok) {
      expect(staged.data.validation).not.toHaveProperty("inputIndex");
      expect(staged.data.validation).not.toHaveProperty("rank");
      expect(staged.data).not.toHaveProperty("projectedFurniture");
      expect(staged.data).not.toHaveProperty("idempotencyKey");
      expect(staged.data).not.toHaveProperty("baseRevision");
      expect(staged.data).not.toHaveProperty("baseHash");
    }

    const after = await store.snapshot();
    expect(after).toStrictEqual({
      ...before,
      preview: {
        status: "pending-review",
        baseRevision: before.baseRevision,
        baseHash: before.baseHash,
        optionId: "home-valid",
        moves: validStage(before).moves,
        constraints: before.workingState.constraints,
        proposalDigest: HOME_DIGEST,
        idempotencyKey: "fixture-home-0001",
        validation: expectedStageValidation,
        projectedFurniture: before.workingState.furniture.map((item) => item.id === "desk-main" ? { ...item, xMm: 1900 } : item),
        notApplied: true,
        notSaved: true,
        requiresHumanAction: true,
      },
    });
    expect(after.baseRevision).toBe(before.baseRevision);
    expect(after.baseHash).toBe(before.baseHash);
    expect(after.workingState).toStrictEqual(before.workingState);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.recordCount).toBe(1);
    expect(verifier).toHaveBeenCalledTimes(1);
    registration.teardown();
  });

  it("rejects an otherwise-valid string-key unknown field without changing state", async () => {
    const store = createDocumentStore({ storage: null, stageVerifier: verifyStageRequest });
    const { registration, byName } = await registeredTools(store);
    const before = await store.snapshot();
    const result = await byName.validate_layout_options.execute({ ...validOption(before), unexpected: true }, { signal: signal() });
    expect(result).toStrictEqual({ ok: false, error: { code: "INVALID_INPUT", message: "The request is invalid." } });
    expect(await store.snapshot()).toStrictEqual(before);
    registration.teardown();
  });

  it("calls the Stage verifier exactly once across success, replay, and digest conflict", async () => {
    const verifier = vi.fn(async (input: StageVerificationInput): Promise<ToolResult<VerifiedStageData>> => verifyStageRequest(input));
    const store = createDocumentStore({ storage: null, stageVerifier: verifier });
    const { registration, byName } = await registeredTools(store);
    const snapshot = await store.snapshot();
    const request = validStage(snapshot);

    const first = await byName.stage_layout_preview.execute(request, { signal: signal() });
    expect(first).toStrictEqual({
      ok: true,
      data: {
        previewId: HOME_DIGEST,
        optionId: "home-valid",
        proposalDigest: HOME_DIGEST,
        validation: expectedStageValidation,
        notApplied: true,
        notSaved: true,
        requiresHumanAction: true,
        allowedHumanActions: ["apply", "discard"],
      },
    });
    await expect(byName.stage_layout_preview.execute(request, { signal: signal() })).resolves.toStrictEqual(first);
    await expect(byName.stage_layout_preview.execute({ ...request, proposalDigest: "f".repeat(64) }, { signal: signal() })).resolves.toStrictEqual({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", message: "This idempotency key is already bound to another proposal." },
    });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(store.recordCount).toBe(1);
    registration.teardown();
  });
});

describe("T06 Validate reservation and cancellation", () => {
  it("rejects a pre-aborted call without reserving or reading state", async () => {
    const store = createDocumentStore({ storage: null });
    const snapshot = await store.snapshot();
    const begin = vi.spyOn(store, "beginValidate");
    const read = vi.spyOn(store, "snapshot");
    const controller = new AbortController();
    controller.abort();

    await expect(createValidateLayoutOptionsHandler(store)(validOption(snapshot), { signal: controller.signal })).resolves.toStrictEqual({
      ok: false,
      error: { code: "CANCELLED", message: "The operation was cancelled." },
    });
    expect(begin).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("permits one in-flight Validate, rejects a concurrent call, and releases after mid-flight abort", async () => {
    const store = createDocumentStore({ storage: null });
    const snapshot = await store.snapshot();
    const barrier = deferred<StoreSnapshot>();
    vi.spyOn(store, "snapshot").mockImplementationOnce(() => barrier.promise);
    const handler = createValidateLayoutOptionsHandler(store);
    const controller = new AbortController();
    const first = handler(validOption(snapshot), { signal: controller.signal });

    await expect(handler(validOption(snapshot), { signal: signal() })).resolves.toStrictEqual({
      ok: false,
      error: { code: "STATE_UNAVAILABLE", message: "Layout state is unavailable." },
    });
    controller.abort();
    barrier.resolve(snapshot);
    await expect(first).resolves.toStrictEqual({
      ok: false,
      error: { code: "CANCELLED", message: "The operation was cancelled." },
    });

    await expect(handler(validOption(snapshot), { signal: signal() })).resolves.toMatchObject({ ok: true });
  });

  it("releases the reservation after internal failure and allows deterministic sequential retry", async () => {
    const store = createDocumentStore({ storage: null });
    const snapshot = await store.snapshot();
    const originalSnapshot = store.snapshot.bind(store);
    vi.spyOn(store, "snapshot")
      .mockRejectedValueOnce(new Error("private failure"))
      .mockImplementation(() => originalSnapshot());
    const handler = createValidateLayoutOptionsHandler(store);

    await expect(handler(validOption(snapshot), { signal: signal() })).resolves.toStrictEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The operation could not be completed." },
    });
    await expect(handler(validOption(snapshot), { signal: signal() })).resolves.toMatchObject({
      ok: true,
      data: { rankedOptionIds: ["home-valid"] },
    });
    await expect(handler(validOption(snapshot), { signal: signal() })).resolves.toMatchObject({ ok: true });
  });
});

describe("T06 handler-side symbol-key rejection", () => {
  it.each([
    ["Validate root", "validate", "root"],
    ["Validate nested pose", "validate", "nested"],
    ["Stage root", "stage", "root"],
    ["Stage nested pose", "stage", "nested"],
  ] as const)("rejects %s before validator/store access", async (_label, kind, location) => {
    const snapshot = await createDocumentStore({ storage: null }).snapshot();
    const unknown = Symbol("unknown");
    const input: Record<PropertyKey, unknown> = kind === "validate"
      ? structuredClone(validOption(snapshot)) as Record<PropertyKey, unknown>
      : structuredClone(validStage(snapshot)) as unknown as Record<PropertyKey, unknown>;
    if (location === "root") input[unknown] = true;
    else if (kind === "validate") {
      const options = input.options as Array<{ moves: Array<{ pose: Record<PropertyKey, unknown> }> }>;
      options[0].moves[0].pose[unknown] = true;
    } else {
      const moves = input.moves as Array<{ pose: Record<PropertyKey, unknown> }>;
      moves[0].pose[unknown] = true;
    }

    if (kind === "validate") {
      const store = {
        beginValidate: vi.fn(() => ({ token: Symbol("reservation") })),
        releaseValidate: vi.fn(() => true),
        snapshot: vi.fn(async () => snapshot),
      };
      const result = await createValidateLayoutOptionsHandler(store as unknown as Pick<DomainStore, "beginValidate" | "releaseValidate" | "snapshot">)(input, { signal: signal() });
      expect(result).toStrictEqual({ ok: false, error: { code: "INVALID_INPUT", message: "The request is invalid." } });
      expect(store.beginValidate).not.toHaveBeenCalled();
      expect(store.snapshot).not.toHaveBeenCalled();
      expect(store.releaseValidate).not.toHaveBeenCalled();
    } else {
      const store = { stage: vi.fn() };
      const result = await createStageLayoutPreviewHandler(store as unknown as Pick<DomainStore, "stage">)(input, { signal: signal() });
      expect(result).toStrictEqual({ ok: false, error: { code: "INVALID_INPUT", message: "The request is invalid." } });
      expect(store.stage).not.toHaveBeenCalled();
    }
  });
});
