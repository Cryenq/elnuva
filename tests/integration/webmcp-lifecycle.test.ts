import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentStore, type DomainStore, type StoreSnapshot } from "../../src/domain/store";
import { registerWebMcpTools } from "../../src/webmcp/register";
import type { SpatialViewCallbacks, SpatialViewState } from "../../src/ui/spatial-view-contract";
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
  vi.doUnmock("../../src/ui/render");
  vi.doUnmock("../../src/ui/svg-editor");
  vi.doUnmock("../../src/ui/inspector");
  vi.doUnmock("../../src/ui/constraints");
  vi.doUnmock("../../src/ui/spatial-view");
  vi.doUnmock("../../src/ui/review");
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

// Small DOM harness for actual createWorkspaceShell/app composition. GPU, SVG
// drawing and form internals are mocked independently; this is not browser proof.
class TestElement extends EventTarget {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      const add = force ?? !names.has(name);
      if (add) names.add(name); else names.delete(name);
      this.className = [...names].join(" ");
      return add;
    },
    add: (...names: string[]) => { for (const name of names) this.classList.toggle(name, true); },
    remove: (...names: string[]) => { for (const name of names) this.classList.toggle(name, false); },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
  };

  constructor(readonly tagName: string) { super(); }
  append(...nodes: TestElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
      if (this.tagName === "select" && this.value === "" && node.tagName === "option") this.value = node.value;
    }
  }
  replaceChildren(...nodes: Array<TestElement | string>): void {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes.filter((node): node is TestElement => node instanceof TestElement));
    if (typeof nodes[0] === "string") this.textContent = nodes[0];
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  getAttribute(name: string): string | null {
    if (name.startsWith("data-")) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  contains(target: TestElement): boolean { return this === target || this.children.some(child => child.contains(target)); }
  focus(): void { (document as unknown as { activeElement: TestElement }).activeElement = this; }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  matches(selector: string): boolean {
    if (selector === ":disabled") return this.disabled;
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (/^[a-z]+$/i.test(selector)) return this.tagName.toLowerCase() === selector.toLowerCase();
    const attrs = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
    return attrs.length > 0 && attrs.every(([, name, value]) =>
      value === undefined ? this.getAttribute(name) !== null : this.getAttribute(name) === value);
  }
  querySelectorAll(selector: string): TestElement[] {
    const found: TestElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector: string): TestElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  get ownerSVGElement(): TestElement | null {
    let parent = this.parentElement;
    while (parent && parent.tagName !== "svg") parent = parent.parentElement;
    return parent;
  }
  getScreenCTM(): { inverse: () => object } { return { inverse: () => ({}) }; }
  private readonly captures = new Set<number>();
  setPointerCapture(pointerId: number): void {
    this.captures.add(pointerId);
    this.dispatchEvent(pointerEvent("gotpointercapture", { pointerId }));
  }
  hasPointerCapture(pointerId: number): boolean { return this.captures.has(pointerId); }
  releasePointerCapture(pointerId: number): void {
    if (this.captures.delete(pointerId)) this.dispatchEvent(pointerEvent("lostpointercapture", { pointerId }));
  }
}

function pointerEvent(type: string, values: Partial<PointerEvent> = {}): PointerEvent {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries({ pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse", clientX: 2500, clientY: 1300, ...values })) {
    Object.defineProperty(event, key, { value });
  }
  return event as PointerEvent;
}

async function workspaceHarness(options: { store?: DomainStore; realPrecision?: boolean } = {}) {
  let drawFromStore!: (value: StoreSnapshot) => void;
  let callbacks!: SpatialViewCallbacks;
  const unsubscribe = vi.fn();
  const updateFurniturePose = vi.fn();
  const store = options.store ?? {
    subscribe: vi.fn((listener: (value: StoreSnapshot) => void) => { drawFromStore = listener; return unsubscribe; }),
    updateFurniturePose,
  } as unknown as DomainStore;
  const root = new TestElement("div");
  const spatial = { update: vi.fn(), cancelInteraction: vi.fn(), dispose: vi.fn() };
  let markMounted!: () => void;
  const mounted = new Promise<void>(resolve => { markMounted = resolve; });
  const mount = vi.fn((_host: HTMLElement, _state: SpatialViewState, handlers: SpatialViewCallbacks) => {
    callbacks = handlers;
    markMounted();
    return spatial;
  });
  vi.resetModules();
  vi.stubGlobal("document", {
    createElement: (tag: string) => new TestElement(tag),
    createElementNS: (_namespace: string, tag: string) => new TestElement(tag),
    activeElement: null,
  });
  if (options.realPrecision) {
    vi.doUnmock("../../src/ui/render");
    vi.doUnmock("../../src/ui/svg-editor");
    vi.doUnmock("../../src/ui/constraints");
    // Identity coordinates and capture are deterministic DOM doubles, not
    // browser/device/GPU evidence. Actual render/startDrag/app/store code runs.
    vi.stubGlobal("DOMPoint", class {
      constructor(readonly x: number, readonly y: number) {}
      matrixTransform(): { x: number; y: number } { return { x: this.x, y: this.y }; }
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  } else {
    vi.doMock("../../src/ui/render", () => ({ roomSvg: () => new TestElement("svg") }));
    vi.doMock("../../src/ui/svg-editor", () => ({ startDrag: vi.fn(() => vi.fn()) }));
    vi.doMock("../../src/ui/constraints", () => ({ constraintsList: () => new TestElement("section") }));
  }
  vi.doMock("../../src/ui/inspector", () => ({ inspector: () => new TestElement("section") }));
  vi.doMock("../../src/ui/review", () => ({ reviewPanel: () => new TestElement("section") }));
  vi.doMock("../../src/ui/spatial-view", () => ({ mountSpatialView: mount }));
  // workspace-shell itself is deliberately real: no invented host/export shape.
  const { hydrateApp } = await import("../../src/app");
  const app = hydrateApp(root as unknown as HTMLElement, undefined, store);
  return { app, root, store, unsubscribe, updateFurniturePose, spatial, mount, mounted,
    emit: (value: StoreSnapshot) => drawFromStore(value),
    callbacks: () => callbacks };
}

describe("T06 capability result/draw ordering", () => {
  it.each([
    ["registered", "WebMCP tools are available."],
    ["unavailable", "WebMCP unavailable in this client. The room layout remains available."],
  ] as const)("retains an immediately resolved %s result through the first draw and a redraw", async (state, message) => {
    const snapshot = await createDocumentStore({ storage: null }).snapshot();
    const harness = await workspaceHarness();
    await Promise.resolve({ status: state }).then(() => harness.app.setCapabilityStatus(state, message));
    // The new persistent shell is usable before the first asynchronous snapshot.
    const earlyStatus = harness.root.querySelector(".capability-status");
    expect(earlyStatus).not.toBeNull();
    expect(earlyStatus?.dataset.state).toBe(state);
    expect(earlyStatus?.textContent).toBe(message);

    harness.emit(snapshot);
    const firstStatus = harness.root.querySelector(".capability-status");
    expect(firstStatus).toBe(earlyStatus);
    expect(firstStatus?.dataset.state).toBe(state);
    expect(firstStatus?.textContent).toBe(message);

    harness.emit(snapshot);
    const redrawnStatus = harness.root.querySelector(".capability-status");
    expect(redrawnStatus).toBe(firstStatus);
    expect(redrawnStatus?.dataset.state).toBe(state);
    expect(redrawnStatus?.textContent).toBe(message);
    harness.app.teardown();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("T09 synchronous gesture invalidation before delayed snapshot delivery", () => {
  const control = (root: TestElement, key: string): TestElement => {
    const nodes = root.querySelectorAll(`[data-focus-key="${key}"]`);
    expect(nodes, `exactly one real control ${key}`).toHaveLength(1);
    expect(nodes[0].disabled).toBe(false);
    return nodes[0];
  };
  const submit = (root: TestElement, key: string): void => {
    let form: TestElement | null = control(root, key);
    while (form && form.tagName !== "form") form = form.parentElement;
    expect(form, `${key} belongs to a real form`).not.toBeNull();
    form!.dispatchEvent(new Event("submit", { cancelable: true }));
  };
  const cases = [
    { name: "room update", command: "updateRoom", act: (root: TestElement) => {
      control(root, "room:width").value = "3650";
      submit(root, "room:update");
    } },
    { name: "catalog furniture addition", command: "addFurniture", act: (root: TestElement) => {
      control(root, "furniture:catalog").value = "chair-600x600";
      submit(root, "furniture:add");
    } },
    { name: "feature update", command: "updateFeature", act: (root: TestElement) => {
      control(root, "feature:window-north:offset").value = "1150";
      submit(root, "feature:window-north:update");
    } },
    { name: "feature addition", command: "addFeature", act: (root: TestElement) => {
      control(root, "feature:new:catalog").value = "window-1400";
      control(root, "feature:new:wall").value = "south";
      control(root, "feature:new:offset").value = "100";
      submit(root, "feature:add");
    } },
    { name: "feature deletion", command: "deleteFeature", act: (root: TestElement) => {
      control(root, "feature:window-spare:delete").click();
    } },
    { name: "constraint update", command: "updateConstraint", act: (root: TestElement) => {
      control(root, "constraint:c-chair:amount").value = "550";
      submit(root, "constraint:c-chair:update");
    } },
    { name: "constraint addition", command: "addConstraint", act: (root: TestElement) => {
      control(root, "constraint:new:type").value = "door_path_clear";
      control(root, "constraint:new:type").dispatchEvent(new Event("change"));
      submit(root, "constraint:add");
    } },
    { name: "constraint deletion", command: "deleteConstraint", act: (root: TestElement) => {
      control(root, "constraint:c-chair:delete").click();
    } },
  ] as const;

  it.each(cases)("rejects a held SVG release after $name, before any new snapshot is delivered", async ({ command, act }) => {
    const persisted = new Map<string, string>([["unrelated-preexisting-key", "preserve"]]);
    const storage = { getItem: (key: string) => persisted.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => { persisted.set(key, value); }) };
    const data = createDocumentStore({ storage });
    if (command === "deleteFeature") {
      expect(data.addFeature({ id: "window-spare", catalogId: "window-1400", wall: "south", offsetMm: 100 }).ok).toBe(true);
    }
    const readSnapshot = data.snapshot.bind(data);
    const before = await readSnapshot();
    const savedBefore = [...persisted];
    let hold = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const heldSnapshots: Promise<StoreSnapshot>[] = [];
    const snapshot = vi.spyOn(data, "snapshot").mockImplementation(() => {
      const captured = readSnapshot();
      if (!hold) return captured;
      const deferred = captured.then(async value => { await gate; return value; });
      heldSnapshots.push(deferred);
      return deferred;
    });
    const poseCommand = vi.spyOn(data, "updateFurniturePose");
    const otherCommand = vi.spyOn(data, command);
    const harness = await workspaceHarness({ store: data, realPrecision: true });
    await harness.mounted;
    try {
      control(harness.root, "view:precision-2d").click();
      const chair = harness.root.querySelector('[data-furniture-id="chair-main"]');
      expect(chair).not.toBeNull();
      chair!.dispatchEvent(pointerEvent("pointerdown"));
      chair!.dispatchEvent(pointerEvent("pointermove", { clientX: 2550 }));
      expect(chair!.dataset.xMm).toBe("2550");
      expect(chair!.hasPointerCapture(1)).toBe(true);
      expect(poseCommand).not.toHaveBeenCalled();

      // Gate only snapshot delivery. The actual command commits synchronously;
      // pointerup is deliberately delivered before that snapshot can reach app.
      hold = true;
      act(harness.root);
      expect(otherCommand).toHaveBeenCalledTimes(1);
      expect(otherCommand.mock.results[0].value).toMatchObject({ ok: true });
      expect(heldSnapshots).toHaveLength(1);
      expect(harness.spatial.update.mock.lastCall?.[0].snapshot).toEqual(before);
      const afterHumanCommand = await readSnapshot();
      expect(afterHumanCommand.baseRevision).toBe(before.baseRevision + 1);
      expect(afterHumanCommand.workingState).not.toEqual(before.workingState);
      expect(afterHumanCommand.workingState.furniture.find(item => item.id === "chair-main"))
        .toEqual(before.workingState.furniture.find(item => item.id === "chair-main"));

      chair!.dispatchEvent(pointerEvent("pointerup", { clientX: 2550 }));
      const beforeDelivery = await readSnapshot();
      // Soft checks preserve all failed-race details and still execute cleanup.
      expect.soft(poseCommand, "stale gesture must not issue a second mutation").not.toHaveBeenCalled();
      expect.soft(beforeDelivery).toEqual(afterHumanCommand);
      expect.soft(beforeDelivery.baseRevision).toBe(before.baseRevision + 1);
      expect.soft(storage.setItem).not.toHaveBeenCalled();
      expect.soft([...persisted]).toEqual(savedBefore);

      hold = false;
      release();
      await Promise.all(heldSnapshots);
      await Promise.resolve();
      expect.soft(await readSnapshot()).toEqual(afterHumanCommand);
      expect.soft(harness.spatial.update.mock.lastCall?.[0].snapshot).toEqual(afterHumanCommand);
      const displayedChair = harness.root.querySelector('[data-furniture-id="chair-main"]');
      expect.soft(displayedChair?.dataset.xMm).toBe("2500");
      expect.soft(displayedChair?.dataset.yMm).toBe("1300");
      expect.soft(chair!.hasPointerCapture(1)).toBe(false);
      expect.soft(storage.setItem).not.toHaveBeenCalled();
      expect.soft([...persisted]).toEqual(savedBefore);
    } finally {
      hold = false;
      release();
      await Promise.all(heldSnapshots);
      harness.app.teardown();
      snapshot.mockRestore();
      poseCommand.mockRestore();
      otherCommand.mockRestore();
    }
  });
});

describe("T09 persistent workspace renderer lifecycle", () => {
  it("mounts once, uses the latest snapshot after delayed readiness, and keeps the host", async () => {
    const data = createDocumentStore({ storage: null });
    const first = await data.snapshot();
    expect(data.updateFurniturePose("chair-main", { xMm: 2550, yMm: 1300, rotationDeg: 0 }).ok).toBe(true);
    const second = await data.snapshot();
    const harness = await workspaceHarness();
    harness.emit(first);
    expect(harness.mount).toHaveBeenCalledTimes(1);
    const host = harness.root.querySelector("[data-spatial-host]");
    expect(host).not.toBeNull();
    expect(harness.mount.mock.calls[0][0]).toBe(host);
    expect(harness.mount.mock.calls[0][1].snapshot).toBe(first);

    harness.emit(second);
    expect(harness.mount).toHaveBeenCalledTimes(1);
    expect(harness.root.querySelector("[data-spatial-host]")).toBe(host);
    expect(harness.spatial.update).toHaveBeenCalled();
    expect(harness.spatial.update.mock.lastCall?.[0].snapshot).toBe(second);
    harness.callbacks().onAvailabilityChange({ state: "available", message: "Spatial view available." });
    expect(harness.spatial.update.mock.lastCall?.[0].snapshot).toBe(second);
    expect(harness.root.querySelector("[data-spatial-status]")?.dataset.state).toBe("available");

    harness.callbacks().onSelect("chair-main");
    expect(harness.mount).toHaveBeenCalledTimes(1);
    expect(harness.spatial.update.mock.lastCall?.[0]).toMatchObject({ snapshot: second, selectedItemId: "chair-main" });
    expect(harness.root.querySelector("[data-spatial-host]")).toBe(host);
    expect(harness.updateFurniturePose).not.toHaveBeenCalled();
    harness.app.teardown();
  });

  it("cancels and disposes exactly once and ignores late renderer/store callbacks", async () => {
    const snapshot = await createDocumentStore({ storage: null }).snapshot();
    const harness = await workspaceHarness();
    harness.emit(snapshot);
    const callbacks = harness.callbacks();
    harness.spatial.cancelInteraction.mockClear();
    harness.spatial.dispose.mockClear();
    harness.app.teardown();
    harness.app.teardown();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.spatial.cancelInteraction).toHaveBeenCalledTimes(1);
    expect(harness.spatial.dispose).toHaveBeenCalledTimes(1);
    const callsAfterDispose = harness.spatial.update.mock.calls.length;
    const stateAfterDispose = harness.root.querySelector("[data-spatial-status]")?.dataset.state;
    callbacks.onAvailabilityChange({ state: "available", message: "Late readiness must be ignored." });
    callbacks.onSelect("chair-main");
    callbacks.onPoseRequest({ itemId: "chair-main", pose: { xMm: 2550, yMm: 1300, rotationDeg: 0 },
      baseTemplateId: snapshot.activeTemplateId, baseRevision: snapshot.baseRevision, baseHash: snapshot.baseHash });
    harness.emit(snapshot);
    expect(harness.mount).toHaveBeenCalledTimes(1);
    expect(harness.spatial.update.mock.calls).toHaveLength(callsAfterDispose);
    expect(harness.root.querySelector("[data-spatial-status]")?.dataset.state).toBe(stateAfterDispose);
    expect(harness.updateFurniturePose).not.toHaveBeenCalled();
  });
});
