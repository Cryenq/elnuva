import { describe, expect, it, vi } from "vitest";

import { registerWebMcpTools } from "../../src/webmcp/register";

/**
 * This file uses a minimal mocked ModelContext only to contract-test imperative
 * registration and execution routing. It is diagnostic integration coverage,
 * not evidence of native discovery, model selection, or client invocation.
 */

type ExecuteOptions = { signal: AbortSignal };

type CapturedTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown>;
  execute: (input: unknown, options: ExecuteOptions) => unknown;
  outputSchema?: unknown;
};

type RegistrationOptions = { signal: AbortSignal };

function createDocumentHarness(defaultView?: EventTarget) {
  const registerTool = vi.fn(
    async (_tool: CapturedTool, _options: RegistrationOptions): Promise<undefined> => undefined,
  );
  const document = {
    modelContext: { registerTool },
    defaultView,
  } as unknown as Document;

  return { document, registerTool };
}

function createPageHideEvent(persisted: boolean): Event {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

function createInspectHandler() {
  return vi.fn(async (_input: unknown, _options: ExecuteOptions) => ({
    ok: false as const,
    error: {
      code: "STATE_UNAVAILABLE" as const,
      message: "Layout state is unavailable.",
    },
  }));
}

function createCompleteHandlers(inspect = createInspectHandler()) {
  const unavailable = async () => ({
    ok: false as const,
    error: { code: "STATE_UNAVAILABLE" as const, message: "Layout state is unavailable." },
  });
  return { inspect, validate: vi.fn(unavailable), stage: vi.fn(unavailable) };
}

describe("top-level imperative WebMCP registration", () => {
  it("registers exactly one Inspect tool with the locked schema and annotations", async () => {
    const harness = createDocumentHarness();
    const inspect = createInspectHandler();

    const registration = await registerWebMcpTools({
      document: harness.document,
      ...createCompleteHandlers(inspect),
    });

    expect(registration.status).toBe("registered");
    expect(harness.registerTool).toHaveBeenCalledTimes(3);

    const [tool, options] = harness.registerTool.mock.calls[0];
    expect(tool.name).toBe("inspect_spatial_layout");
    expect(tool.inputSchema).toStrictEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(tool.annotations).toStrictEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(Object.prototype.hasOwnProperty.call(tool, "outputSchema")).toBe(false);
    expect(typeof tool.description).toBe("string");
    expect(tool.description.trim().length).toBeGreaterThan(0);
    expect(options).toStrictEqual({ signal: expect.any(AbortSignal) });
    expect(options.signal.aborted).toBe(false);

    registration.teardown();
  });

  it("routes execution input and the per-call signal to the Inspect handler", async () => {
    const harness = createDocumentHarness();
    const inspect = createInspectHandler();
    const registration = await registerWebMcpTools({
      document: harness.document,
      ...createCompleteHandlers(inspect),
    });
    const [tool, registrationOptions] = harness.registerTool.mock.calls[0];
    const execution = new AbortController();

    const result = await tool.execute({}, { signal: execution.signal });

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith({}, { signal: execution.signal });
    expect(result).toStrictEqual({
      ok: false,
      error: {
        code: "STATE_UNAVAILABLE",
        message: "Layout state is unavailable.",
      },
    });
    expect(execution.signal).not.toBe(registrationOptions.signal);

    registration.teardown();
  });

  it("uses one in-flight registration and one lifetime controller per Document", async () => {
    let releaseRegistration!: () => void;
    const registerTool = vi.fn(
      (_tool: CapturedTool, _options: RegistrationOptions) => registerTool.mock.calls.length === 1
        ? new Promise<undefined>((resolve) => { releaseRegistration = () => resolve(undefined); })
        : Promise.resolve(undefined),
    );
    const document = { modelContext: { registerTool } } as unknown as Document;
    const inspect = createInspectHandler();

    const complete = createCompleteHandlers(inspect);
    const firstPending = registerWebMcpTools({ document, ...complete });
    const repeatedPending = registerWebMcpTools({ document, ...complete });

    expect(registerTool).toHaveBeenCalledTimes(1);
    releaseRegistration();

    const [first, repeated] = await Promise.all([firstPending, repeatedPending]);
    expect(first).toBe(repeated);
    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(registerTool.mock.calls[0][1].signal.aborted).toBe(false);

    first.teardown();
  });

  it("aborts the Document registration signal on idempotent teardown", async () => {
    const harness = createDocumentHarness();
    const registration = await registerWebMcpTools({
      document: harness.document,
      ...createCompleteHandlers(),
    });
    const signal = harness.registerTool.mock.calls[0][1].signal;

    registration.teardown();
    registration.teardown();

    expect(signal.aborted).toBe(true);
  });

  it("preserves the registration through BFCache and aborts when the Document ends", async () => {
    const pageLifecycle = new EventTarget();
    const harness = createDocumentHarness(pageLifecycle);
    const registration = await registerWebMcpTools({
      document: harness.document,
      ...createCompleteHandlers(),
    });
    const signal = harness.registerTool.mock.calls[0][1].signal;

    pageLifecycle.dispatchEvent(createPageHideEvent(true));
    expect(signal.aborted).toBe(false);

    pageLifecycle.dispatchEvent(createPageHideEvent(false));
    expect(signal.aborted).toBe(true);

    registration.teardown();
  });

  it("registers once again for a fresh Document with a distinct lifetime", async () => {
    const firstHarness = createDocumentHarness();
    const secondHarness = createDocumentHarness();
    const inspect = createInspectHandler();
    const complete = createCompleteHandlers(inspect);

    const first = await registerWebMcpTools({
      document: firstHarness.document,
      ...complete,
    });
    first.teardown();

    const second = await registerWebMcpTools({
      document: secondHarness.document,
      ...complete,
    });
    await registerWebMcpTools({
      document: secondHarness.document,
      ...complete,
    });

    expect(firstHarness.registerTool).toHaveBeenCalledTimes(3);
    expect(secondHarness.registerTool).toHaveBeenCalledTimes(3);
    expect(firstHarness.registerTool.mock.calls[0][1].signal).not.toBe(
      secondHarness.registerTool.mock.calls[0][1].signal,
    );
    expect(secondHarness.registerTool.mock.calls[0][1].signal.aborted).toBe(false);

    second.teardown();
  });

  it("degrades without a modelContext and never invokes the handler", async () => {
    const inspect = createInspectHandler();
    const complete = createCompleteHandlers(inspect);
    const document = {} as Document;

    const registration = await registerWebMcpTools({ document, ...complete });

    expect(registration.status).toBe("unavailable");
    expect(inspect).not.toHaveBeenCalled();
    expect(complete.validate).not.toHaveBeenCalled();
    expect(complete.stage).not.toHaveBeenCalled();
    expect(() => registration.teardown()).not.toThrow();
  });
});
