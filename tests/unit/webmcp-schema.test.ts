import { describe, expect, it, vi } from "vitest";

import { registerWebMcpTools } from "../../src/webmcp/register";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  execute: (input: unknown, options: { signal: AbortSignal }) => unknown;
};

describe("T06 WebMCP schema contract", () => {
  it("exposes exactly the three imperative tools and no outputSchema", async () => {
    const registerTool = vi.fn(async (_tool: Tool) => undefined);
    const document = { modelContext: { registerTool } } as unknown as Document;
    const inspect = vi.fn(async () => ({ ok: true as const, data: {} as never }));
    const validate = vi.fn(async () => ({ ok: true as const, data: {} as never }));
    const stage = vi.fn(async () => ({ ok: true as const, data: {} as never }));

    const registration = await (registerWebMcpTools as unknown as (args: Record<string, unknown>) => Promise<unknown>)({
      document, inspect, validate, stage,
    });
    expect(registration).toMatchObject({ status: "registered" });
    expect(registerTool).toHaveBeenCalledTimes(3);
    const tools = registerTool.mock.calls.map(([tool]) => tool);
    expect(tools.map((tool) => tool.name)).toStrictEqual([
      "inspect_spatial_layout", "validate_layout_options", "stage_layout_preview",
    ]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(3);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(Object.prototype.hasOwnProperty.call(tool, "outputSchema")).toBe(false);
      expect(tool.annotations.untrustedContentHint).toBe(true);
    }
    expect(tools[0].annotations.readOnlyHint).toBe(true);
    expect(tools[1].annotations.readOnlyHint).toBe(true);
    expect(tools[2].annotations.readOnlyHint).toBe(false);
    expect(tools[1].description).toBe("Validate and rank one to three concrete furniture move options against the active Elnuva layout without changing state.");
    expect(tools[2].description).toBe("Stage one validated furniture move option as an ephemeral preview for human Apply or Discard; never apply or save it.");
    (registration as { teardown: () => void }).teardown();
  });

  it.each([
    ["validate_layout_options", ["baseRevision", "baseHash", "constraints", "options"]],
    ["stage_layout_preview", ["baseRevision", "baseHash", "constraints", "optionId", "moves", "proposalDigest", "idempotencyKey"]],
  ])("keeps %s envelope closed and required", async (name, required) => {
    const registerTool = vi.fn(async (_tool: Tool, _options: { signal: AbortSignal }) => undefined);
    const document = { modelContext: { registerTool } } as unknown as Document;
    const registration = await (registerWebMcpTools as unknown as (args: Record<string, unknown>) => Promise<unknown>)({ document, inspect: vi.fn(), validate: vi.fn(), stage: vi.fn() });
    const tool = registerTool.mock.calls.find(([entry]) => entry.name === name)?.[0] as Tool | undefined;
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toStrictEqual(required);
    expect(tool!.inputSchema.additionalProperties).toBe(false);
    (registration as { teardown: () => void }).teardown();
  });
});
