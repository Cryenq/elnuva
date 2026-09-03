import { describe, expect, it, vi } from "vitest";

import { registerWebMcpTools } from "../../src/webmcp/register";
import type { ModelContextTool, WebMcpHandlers } from "../../src/webmcp/types";

type CapturedTool = ModelContextTool & { outputSchema?: unknown };

function handlers(): WebMcpHandlers {
  return {
    inspect: vi.fn(async () => ({ ok: false as const, error: { code: "STATE_UNAVAILABLE" as const, message: "unused" } })),
    validate: vi.fn(async () => ({ ok: false as const, error: { code: "STATE_UNAVAILABLE" as const, message: "unused" } })),
    stage: vi.fn(async () => ({ ok: false as const, error: { code: "STATE_UNAVAILABLE" as const, message: "unused" } })),
  };
}

async function captureTools(): Promise<{ tools: CapturedTool[]; teardown: () => void }> {
  const tools: CapturedTool[] = [];
  const document = {
    modelContext: {
      registerTool: vi.fn(async (tool: CapturedTool) => {
        tools.push(tool);
      }),
    },
  } as unknown as Document;
  const registration = await registerWebMcpTools({ document, ...handlers() });
  return { tools, teardown: registration.teardown };
}

const id = { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$", minLength: 1, maxLength: 40 };
const hash = { type: "string", pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 };
const strength = { type: "string", enum: ["required", "preferred"] };
const relation = { type: "string", enum: ["near", "away"] };
const pose = {
  type: "object",
  properties: {
    xMm: { type: "integer" },
    yMm: { type: "integer" },
    rotationDeg: { type: "integer" },
  },
  required: ["xMm", "yMm", "rotationDeg"],
  additionalProperties: false,
};
const move = {
  type: "object",
  properties: { itemId: id, pose },
  required: ["itemId", "pose"],
  additionalProperties: false,
};
const moves = { type: "array", minItems: 1, maxItems: 8, items: move };
const constraints = {
  type: "array",
  minItems: 0,
  maxItems: 8,
  items: {
    oneOf: [
      {
        type: "object",
        properties: {
          constraintId: id,
          type: { const: "door_path_clear" },
          strength,
          featureId: id,
          widthMm: { type: "integer", minimum: 500, maximum: 1600 },
        },
        required: ["constraintId", "type", "strength", "featureId", "widthMm"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          constraintId: id,
          type: { const: "feature_distance" },
          strength,
          itemId: id,
          featureId: id,
          relation,
          thresholdMm: { type: "integer", minimum: 0, maximum: 4000 },
        },
        required: ["constraintId", "type", "strength", "itemId", "featureId", "relation", "thresholdMm"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          constraintId: id,
          type: { const: "item_distance" },
          strength,
          itemAId: id,
          itemBId: id,
          relation,
          thresholdMm: { type: "integer", minimum: 0, maximum: 4000 },
        },
        required: ["constraintId", "type", "strength", "itemAId", "itemBId", "relation", "thresholdMm"],
        additionalProperties: false,
      },
    ],
  },
};

describe("T06 registered WebMCP schemas", () => {
  it("publishes exactly the locked metadata and never registers outputSchema", async () => {
    const { tools, teardown } = await captureTools();

    expect(tools.map(({ name, title, description, annotations }) => ({ name, title, description, annotations }))).toStrictEqual([
      {
        name: "inspect_spatial_layout",
        title: "Inspect spatial layout",
        description: "Read the active Elnuva room, furniture, constraints, revision, and bounded catalogs.",
        annotations: { readOnlyHint: true, untrustedContentHint: true },
      },
      {
        name: "validate_layout_options",
        title: "Validate layout options",
        description: "Validate and rank one to three concrete furniture move options against the active Elnuva layout without changing state.",
        annotations: { readOnlyHint: true, untrustedContentHint: true },
      },
      {
        name: "stage_layout_preview",
        title: "Stage layout preview",
        description: "Stage one validated furniture move option as an ephemeral preview for human Apply or Discard; never apply or save it.",
        annotations: { readOnlyHint: false, untrustedContentHint: true },
      },
    ]);
    expect(new Set(tools.map((tool) => tool.name))).toHaveLength(3);
    for (const tool of tools) expect(Object.hasOwn(tool, "outputSchema")).toBe(false);
    teardown();
  });

  it("keeps Inspect closed to the empty object", async () => {
    const { tools, teardown } = await captureTools();
    expect(tools[0].inputSchema).toStrictEqual({ type: "object", properties: {}, additionalProperties: false });
    teardown();
  });

  it("deeply locks every Validate object, union branch, bound, and identifier", async () => {
    const { tools, teardown } = await captureTools();
    expect(tools[1].inputSchema).toStrictEqual({
      type: "object",
      properties: {
        baseRevision: { type: "integer", minimum: 1 },
        baseHash: hash,
        constraints,
        options: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: { optionId: id, moves },
            required: ["optionId", "moves"],
            additionalProperties: false,
          },
        },
      },
      required: ["baseRevision", "baseHash", "constraints", "options"],
      additionalProperties: false,
    });
    teardown();
  });

  it("deeply locks Stage bounds and keeps rotation semantic rather than an enum", async () => {
    const { tools, teardown } = await captureTools();
    expect(tools[2].inputSchema).toStrictEqual({
      type: "object",
      properties: {
        baseRevision: { type: "integer", minimum: 1 },
        baseHash: hash,
        constraints,
        optionId: id,
        moves,
        proposalDigest: hash,
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_-]{16,80}$", minLength: 16, maxLength: 80 },
      },
      required: ["baseRevision", "baseHash", "constraints", "optionId", "moves", "proposalDigest", "idempotencyKey"],
      additionalProperties: false,
    });

    const schema = tools[2].inputSchema as {
      properties: { moves: { items: { properties: { pose: { properties: { rotationDeg: Record<string, unknown> } } } } } };
    };
    const rotation = schema.properties.moves.items.properties.pose.properties.rotationDeg;
    expect(rotation).toStrictEqual({ type: "integer" });
    expect(rotation).not.toHaveProperty("enum");
    teardown();
  });
});
