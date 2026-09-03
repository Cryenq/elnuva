import { describe, expect, it, vi } from "vitest";

import { createInspectSpatialLayoutHandler } from "../../src/webmcp/handlers";

/**
 * These are deterministic handler tests. They do not prove native WebMCP
 * discovery, model selection, or client invocation.
 */

const HOME_OFFICE_INSPECT_DATA = {
  contractVersion: "1.1.0",
  baseRevision: 1,
  baseHash: "54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e",
  workingState: {
    schemaVersion: 1,
    templateId: "home-office",
    room: { widthMm: 3600, depthMm: 3000 },
    features: [
      {
        id: "door-main",
        catalogId: "door-900",
        wall: "west",
        offsetMm: 1950,
      },
      {
        id: "radiator-east",
        catalogId: "radiator-900",
        wall: "east",
        offsetMm: 850,
      },
      {
        id: "window-north",
        catalogId: "window-1400",
        wall: "north",
        offsetMm: 1100,
      },
    ],
    furniture: [
      {
        id: "chair-main",
        catalogId: "chair-600x600",
        xMm: 2500,
        yMm: 1300,
        rotationDeg: 0,
        locked: false,
      },
      {
        id: "desk-main",
        catalogId: "desk-1400x700",
        xMm: 2500,
        yMm: 500,
        rotationDeg: 0,
        locked: false,
      },
      {
        id: "storage-main",
        catalogId: "storage-800x400",
        xMm: 700,
        yMm: 600,
        rotationDeg: 0,
        locked: true,
      },
    ],
    constraints: [
      {
        constraintId: "c-door",
        type: "door_path_clear",
        strength: "required",
        featureId: "door-main",
        widthMm: 900,
      },
      {
        constraintId: "c-radiator",
        type: "feature_distance",
        strength: "required",
        itemId: "desk-main",
        featureId: "radiator-east",
        relation: "away",
        thresholdMm: 800,
      },
      {
        constraintId: "c-window",
        type: "feature_distance",
        strength: "preferred",
        itemId: "desk-main",
        featureId: "window-north",
        relation: "near",
        thresholdMm: 700,
      },
      {
        constraintId: "c-chair",
        type: "item_distance",
        strength: "preferred",
        itemAId: "chair-main",
        itemBId: "desk-main",
        relation: "near",
        thresholdMm: 500,
      },
    ],
  },
  catalog: {
    furniture: [
      {
        id: "desk-1400x700",
        kind: "desk",
        label: "Desk",
        widthMm: 1400,
        depthMm: 700,
        allowedRotations: [0, 90, 180, 270],
      },
      {
        id: "chair-600x600",
        kind: "chair",
        label: "Chair",
        widthMm: 600,
        depthMm: 600,
        allowedRotations: [0, 90, 180, 270],
      },
      {
        id: "storage-800x400",
        kind: "storage",
        label: "Storage",
        widthMm: 800,
        depthMm: 400,
        allowedRotations: [0, 90, 180, 270],
      },
      {
        id: "bed-2000x1600",
        kind: "bed",
        label: "Bed",
        widthMm: 2000,
        depthMm: 1600,
        allowedRotations: [0, 90, 180, 270],
      },
      {
        id: "nightstand-500x400",
        kind: "nightstand",
        label: "Nightstand",
        widthMm: 500,
        depthMm: 400,
        allowedRotations: [0, 90, 180, 270],
      },
      {
        id: "wardrobe-1200x600",
        kind: "wardrobe",
        label: "Wardrobe",
        widthMm: 1200,
        depthMm: 600,
        allowedRotations: [0, 90, 180, 270],
      },
      {
        id: "table-1200x800",
        kind: "table",
        label: "Table",
        widthMm: 1200,
        depthMm: 800,
        allowedRotations: [0, 90, 180, 270],
      },
      {
        id: "bookcase-800x350",
        kind: "bookcase",
        label: "Bookcase",
        widthMm: 800,
        depthMm: 350,
        allowedRotations: [0, 90, 180, 270],
      },
    ],
    features: [
      {
        id: "door-900",
        type: "door",
        label: "Door",
        spanMm: 900,
        depthMm: 0,
        keepOutDepthMm: 0,
      },
      {
        id: "window-1400",
        type: "window",
        label: "Window",
        spanMm: 1400,
        depthMm: 0,
        keepOutDepthMm: 0,
      },
      {
        id: "radiator-900",
        type: "radiator",
        label: "Radiator",
        spanMm: 900,
        depthMm: 150,
        keepOutDepthMm: 300,
      },
    ],
  },
  coordinateSystem: {
    origin: "north-west",
    xAxis: "east",
    yAxis: "south",
    unit: "mm",
    integersOnly: true,
  },
  limits: {
    roomMinMm: 2000,
    roomMaxMm: 12000,
    maxFeatures: 8,
    maxFurniture: 8,
    maxConstraints: 8,
    maxOptions: 3,
    maxMovesPerOption: 8,
    doorPathWidthMinMm: 500,
    doorPathWidthMaxMm: 1600,
    distanceThresholdMinMm: 0,
    distanceThresholdMaxMm: 4000,
    dragSnapMm: 50,
    rotationsDeg: [0, 90, 180, 270],
  },
  preview: { status: "none" },
} as const;

const HOME_OFFICE_INSPECT_SUCCESS = {
  ok: true,
  data: HOME_OFFICE_INSPECT_DATA,
} as const;

function freshInspectData() {
  return structuredClone(HOME_OFFICE_INSPECT_DATA);
}

function expectBoundedFailure(result: unknown, code: string): void {
  const failure = result as {
    ok: false;
    error: { code: string; message: string };
  };

  expect(Object.keys(failure).sort()).toStrictEqual(["error", "ok"]);
  expect(failure.ok).toBe(false);
  expect(Object.keys(failure.error).sort()).toStrictEqual(["code", "message"]);
  expect(failure.error.code).toBe(code);
  expect(typeof failure.error.message).toBe("string");
  expect(failure.error.message.trim().length).toBeGreaterThan(0);
  expect([...failure.error.message].length).toBeLessThanOrEqual(160);
}

describe("inspect_spatial_layout handler contract", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an array", []],
    ["a string", ""],
    ["a number", 0],
    ["a boolean", false],
    ["an unknown property", { unexpected: true }],
  ])("rejects %s instead of trusting the published empty-object schema", async (_label, input) => {
    const readCurrentLayout = vi.fn(() => freshInspectData());
    const handler = createInspectSpatialLayoutHandler({ readCurrentLayout });

    const result = await handler(input, { signal: new AbortController().signal });

    expectBoundedFailure(result, "INVALID_INPUT");
    expect(readCurrentLayout).not.toHaveBeenCalled();
  });

  it("returns the exact bounded revision-1 Home Office Inspect envelope", async () => {
    const readCurrentLayout = vi.fn(() => freshInspectData());
    const handler = createInspectSpatialLayoutHandler({ readCurrentLayout });

    const result = await handler({}, { signal: new AbortController().signal });

    expect(result).toStrictEqual(HOME_OFFICE_INSPECT_SUCCESS);
    expect(readCurrentLayout).toHaveBeenCalledTimes(1);
    expect((result as typeof HOME_OFFICE_INSPECT_SUCCESS).data.workingState.templateId).toBe(
      "home-office",
    );
    expect((result as typeof HOME_OFFICE_INSPECT_SUCCESS).data.baseHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic and does not expose mutable aliases or mutate its source", async () => {
    const source = freshInspectData();
    const sourceBefore = structuredClone(source);
    const readCurrentLayout = vi.fn(() => source);
    const handler = createInspectSpatialLayoutHandler({ readCurrentLayout });

    const first = await handler({}, { signal: new AbortController().signal });
    const firstBytes = JSON.stringify(first);

    try {
      const mutableResult = first as {
        data: { workingState: { room: { widthMm: number } } };
      };
      mutableResult.data.workingState.room.widthMm = 9999;
    } catch {
      // A deeply frozen result is also acceptable; the source still must be isolated.
    }

    const second = await handler({}, { signal: new AbortController().signal });

    expect(source).toStrictEqual(sourceBefore);
    expect(second).toStrictEqual(HOME_OFFICE_INSPECT_SUCCESS);
    expect(JSON.stringify(second)).toBe(firstBytes);
    expect(readCurrentLayout).toHaveBeenCalledTimes(2);
  });

  it("returns CANCELLED before reading state when execution is already aborted", async () => {
    const readCurrentLayout = vi.fn(() => freshInspectData());
    const handler = createInspectSpatialLayoutHandler({ readCurrentLayout });
    const execution = new AbortController();
    execution.abort("test cancellation");

    const result = await handler({}, { signal: execution.signal });

    expectBoundedFailure(result, "CANCELLED");
    expect(readCurrentLayout).not.toHaveBeenCalled();
  });

  it("returns STATE_UNAVAILABLE when no current layout snapshot exists", async () => {
    const handler = createInspectSpatialLayoutHandler({ readCurrentLayout: () => null });

    const result = await handler({}, { signal: new AbortController().signal });

    expectBoundedFailure(result, "STATE_UNAVAILABLE");
  });

  it("sanitizes unexpected failures into the stable INTERNAL_ERROR union member", async () => {
    const sensitiveDetail = "token=do-not-leak https://internal.example/trace";
    const handler = createInspectSpatialLayoutHandler({
      readCurrentLayout: () => {
        throw new Error(sensitiveDetail);
      },
    });

    const result = await handler({}, { signal: new AbortController().signal });

    expectBoundedFailure(result, "INTERNAL_ERROR");
    expect(JSON.stringify(result)).not.toContain(sensitiveDetail);
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
    expect(JSON.stringify(result)).not.toContain("internal.example");
    expect(JSON.stringify(result)).not.toContain("Error:");
  });
});
