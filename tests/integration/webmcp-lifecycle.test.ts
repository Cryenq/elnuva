import { describe, expect, it, vi } from "vitest";

import { registerWebMcpTools } from "../../src/webmcp/register";

type Tool = { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => unknown };

function documentHarness(withModelContext = true) {
  const page = new EventTarget();
  const registerTool = vi.fn(async (_tool: Tool, _options: { signal: AbortSignal }) => undefined);
  const document = (withModelContext
    ? { modelContext: { registerTool }, defaultView: page }
    : { defaultView: page }) as unknown as Document;
  return { document, page, registerTool };
}

describe("T06 Document lifecycle and fallback", () => {
  it("registers only after hydration, shares one lifetime, and aborts on navigation", async () => {
    const harness = documentHarness();
    const handlers = { inspect: vi.fn(), validate: vi.fn(), stage: vi.fn() };
    const first = await (registerWebMcpTools as unknown as (args: Record<string, unknown>) => Promise<{ teardown: () => void }>)({ document: harness.document, ...handlers });
    await (registerWebMcpTools as unknown as (args: Record<string, unknown>) => Promise<unknown>)({ document: harness.document, ...handlers });
    expect(harness.registerTool).toHaveBeenCalledTimes(3);
    const signals = harness.registerTool.mock.calls.map(([, options]) => options.signal);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0].aborted).toBe(false);
    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: false });
    harness.page.dispatchEvent(pagehide);
    expect(signals[0].aborted).toBe(true);
    first.teardown();
  });

  it("does not tear down a BFCache page and a fresh Document gets new registrations", async () => {
    const first = documentHarness();
    const registration = await (registerWebMcpTools as unknown as (args: Record<string, unknown>) => Promise<{ teardown: () => void }>)({ document: first.document, inspect: vi.fn(), validate: vi.fn(), stage: vi.fn() });
    const signal = first.registerTool.mock.calls[0][1].signal;
    const persisted = new Event("pagehide"); Object.defineProperty(persisted, "persisted", { value: true }); first.page.dispatchEvent(persisted);
    expect(signal.aborted).toBe(false);
    const second = documentHarness();
    await (registerWebMcpTools as unknown as (args: Record<string, unknown>) => Promise<unknown>)({ document: second.document, inspect: vi.fn(), validate: vi.fn(), stage: vi.fn() });
    expect(second.registerTool).toHaveBeenCalledTimes(3);
    expect(second.registerTool.mock.calls[0][1].signal).not.toBe(signal);
    registration.teardown();
  });

  it("falls back cleanly when the client has no modelContext API", async () => {
    const harness = documentHarness(false);
    const registration = await (registerWebMcpTools as unknown as (args: Record<string, unknown>) => Promise<{ status: string; teardown: () => void }>)({ document: harness.document, inspect: vi.fn(), validate: vi.fn(), stage: vi.fn() });
    expect(registration.status).toBe("unavailable");
    expect(harness.registerTool).not.toHaveBeenCalled();
    expect(() => registration.teardown()).not.toThrow();
  });
});
