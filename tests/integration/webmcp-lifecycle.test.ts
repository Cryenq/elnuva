import { afterEach, describe, expect, it, vi } from "vitest";

import { registerWebMcpTools } from "../../src/webmcp/register";
import type { ModelContextTool, WebMcpHandlers } from "../../src/webmcp/types";

type CapturedTool = ModelContextTool;
type RegistrationOptions = { signal: AbortSignal };

function handlers(): WebMcpHandlers {
  return {
    inspect: vi.fn(async () => ({ ok: false as const, error: { code: "STATE_UNAVAILABLE" as const, message: "unused" } })),
    validate: vi.fn(async () => ({ ok: false as const, error: { code: "STATE_UNAVAILABLE" as const, message: "unused" } })),
    stage: vi.fn(async () => ({ ok: false as const, error: { code: "STATE_UNAVAILABLE" as const, message: "unused" } })),
  };
}

function pageView(topLevel = true): EventTarget {
  const view = new EventTarget();
  Object.defineProperty(view, "self", { value: view });
  Object.defineProperty(view, "top", { value: topLevel ? view : new EventTarget() });
  return view;
}

function documentHarness(options: { api?: boolean; topLevel?: boolean } = {}) {
  const page = pageView(options.topLevel ?? true);
  const registerTool = vi.fn(async (_tool: CapturedTool, _options: RegistrationOptions) => undefined);
  const document = (options.api === false
    ? { defaultView: page }
    : { modelContext: { registerTool }, defaultView: page }) as unknown as Document;
  return { document, page, registerTool };
}

function pagehide(persisted: boolean): Event {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/app");
  vi.doUnmock("../../src/domain/fixture");
  vi.doUnmock("../../src/webmcp/handlers");
  vi.doUnmock("../../src/webmcp/register");
});

describe("T06 Document registration lifecycle", () => {
  it("requires the complete three-handler surface and never partially registers", async () => {
    for (const missing of ["validate", "stage"] as const) {
      const harness = documentHarness();
      const incomplete = { ...handlers(), [missing]: undefined };
      await expect(registerWebMcpTools({ document: harness.document, ...incomplete } as unknown as Parameters<typeof registerWebMcpTools>[0])).rejects.toThrow();
      expect(harness.registerTool).not.toHaveBeenCalled();
    }
  });

  it("deduplicates registration per Document and shares one lifetime across exactly three tools", async () => {
    const harness = documentHarness();
    const complete = handlers();
    const firstPending = registerWebMcpTools({ document: harness.document, ...complete });
    const duplicatePending = registerWebMcpTools({ document: harness.document, ...complete });
    const [first, duplicate] = await Promise.all([firstPending, duplicatePending]);

    expect(first).toBe(duplicate);
    expect(harness.registerTool).toHaveBeenCalledTimes(3);
    expect(harness.registerTool.mock.calls.map(([tool]) => tool.name)).toStrictEqual([
      "inspect_spatial_layout",
      "validate_layout_options",
      "stage_layout_preview",
    ]);
    const signals = harness.registerTool.mock.calls.map(([, options]) => options.signal);
    expect(new Set(signals)).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    first.teardown();
    expect(signals[0].aborted).toBe(true);
  });

  it("retains registrations through BFCache but aborts an ended Document", async () => {
    const harness = documentHarness();
    const registration = await registerWebMcpTools({ document: harness.document, ...handlers() });
    const lifetime = harness.registerTool.mock.calls[0][1].signal;

    harness.page.dispatchEvent(pagehide(true));
    expect(lifetime.aborted).toBe(false);
    harness.page.dispatchEvent(pagehide(false));
    expect(lifetime.aborted).toBe(true);
    expect(harness.registerTool).toHaveBeenCalledTimes(3);
    registration.teardown();
  });

  it("gives a fresh Document fresh registrations and a distinct lifetime", async () => {
    const first = documentHarness();
    const second = documentHarness();
    const firstRegistration = await registerWebMcpTools({ document: first.document, ...handlers() });
    const secondRegistration = await registerWebMcpTools({ document: second.document, ...handlers() });
    await registerWebMcpTools({ document: second.document, ...handlers() });

    expect(first.registerTool).toHaveBeenCalledTimes(3);
    expect(second.registerTool).toHaveBeenCalledTimes(3);
    expect(first.registerTool.mock.calls[0][1].signal).not.toBe(second.registerTool.mock.calls[0][1].signal);
    firstRegistration.teardown();
    expect(second.registerTool.mock.calls[0][1].signal.aborted).toBe(false);
    secondRegistration.teardown();
  });

  it.each([2, 3])("aborts a tool-%i registration failure and cleanly retries all three tools", async (failureCall) => {
    const harness = documentHarness();
    let failed = false;
    harness.registerTool.mockImplementation(async () => {
      if (!failed && harness.registerTool.mock.calls.length === failureCall) {
        failed = true;
        throw new Error("registration rejected");
      }
    });

    await expect(registerWebMcpTools({ document: harness.document, ...handlers() })).rejects.toThrow("WebMCP registration failed.");
    const failedLifetime = harness.registerTool.mock.calls[0][1].signal;
    expect(failedLifetime.aborted).toBe(true);

    const retry = await registerWebMcpTools({ document: harness.document, ...handlers() });
    const retryCalls = harness.registerTool.mock.calls.slice(failureCall);
    expect(retryCalls.map(([tool]) => tool.name)).toStrictEqual([
      "inspect_spatial_layout",
      "validate_layout_options",
      "stage_layout_preview",
    ]);
    expect(new Set(retryCalls.map(([, options]) => options.signal))).toHaveLength(1);
    expect(retryCalls[0][1].signal).not.toBe(failedLifetime);
    expect(retryCalls[0][1].signal.aborted).toBe(false);
    retry.teardown();
  });

  it("keeps iframe Documents unregistered", async () => {
    const harness = documentHarness({ topLevel: false });
    const registration = await registerWebMcpTools({ document: harness.document, ...handlers() });
    expect(registration.status).toBe("unavailable");
    expect(harness.registerTool).not.toHaveBeenCalled();
    registration.teardown();
  });

  it("falls back cleanly when modelContext is absent", async () => {
    const harness = documentHarness({ api: false });
    const complete = handlers();
    const registration = await registerWebMcpTools({ document: harness.document, ...complete });
    expect(registration.status).toBe("unavailable");
    expect(harness.registerTool).not.toHaveBeenCalled();
    expect(complete.inspect).not.toHaveBeenCalled();
    expect(complete.validate).not.toHaveBeenCalled();
    expect(complete.stage).not.toHaveBeenCalled();
    expect(() => registration.teardown()).not.toThrow();
  });

  it("hydrates before composing all three handlers and reports registered capability", async () => {
    vi.resetModules();
    const order: string[] = [];
    const capability = vi.fn();
    const complete = handlers();
    const root = {} as HTMLElement;
    const fakeDocument = { querySelector: vi.fn(() => root) } as unknown as Document;
    const fakeWindow = { addEventListener: vi.fn() } as unknown as Window;
    const register = vi.fn(async (input: { document: Document } & WebMcpHandlers) => {
      order.push("register");
      return { status: "registered" as const, teardown: vi.fn() };
    });
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", fakeWindow);
    vi.doMock("../../src/app", () => ({
      hydrateApp: vi.fn(() => {
        order.push("hydrate");
        return { setCapabilityStatus: capability, teardown: vi.fn() };
      }),
    }));
    vi.doMock("../../src/domain/fixture", () => ({ createHomeOfficeInspectData: vi.fn(() => ({ fixture: true })) }));
    vi.doMock("../../src/webmcp/handlers", () => ({
      createInspectSpatialLayoutHandler: vi.fn(() => complete.inspect),
      createWebMcpHandlers: vi.fn(() => complete),
    }));
    vi.doMock("../../src/webmcp/register", () => ({ registerWebMcpTools: register }));

    await import("../../src/main");
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toStrictEqual(["hydrate", "register"]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({ document: fakeDocument, ...complete });
    expect(capability).toHaveBeenCalledWith("registered", "WebMCP tools are available.");
  });
});
