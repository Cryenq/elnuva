import { expect, test, type Locator, type Page } from "@playwright/test";

type Fixture = Readonly<{
  id: "home-office" | "bedroom" | "study";
  label: string;
  furniture: readonly (readonly [id: string, label: string, xMm: number, yMm: number, rotationDeg: number])[];
  features: readonly string[];
  constraints: readonly string[];
}>;

const FIXTURES: readonly Fixture[] = [
  {
    id: "home-office",
    label: "Home Office",
    furniture: [
      ["chair-main", "Chair", 2500, 1300, 0],
      ["desk-main", "Desk", 2500, 500, 0],
      ["storage-main", "Storage", 700, 600, 0],
    ],
    features: ["door-main", "radiator-east", "window-north"],
    constraints: ["c-door", "c-radiator", "c-window", "c-chair"],
  },
  {
    id: "bedroom",
    label: "Bedroom",
    furniture: [
      ["bed-main", "Bed", 2300, 2400, 0],
      ["nightstand-main", "Nightstand", 3550, 2500, 0],
      ["wardrobe-main", "Wardrobe", 700, 700, 0],
    ],
    features: ["door-south", "radiator-north", "window-east"],
    constraints: ["c-door", "c-radiator", "c-window", "c-nightstand"],
  },
  {
    id: "study",
    label: "Study",
    furniture: [
      ["bookcase-main", "Bookcase", 2700, 2300, 0],
      ["chair-main", "Chair", 2000, 1600, 0],
      ["table-main", "Table", 2000, 900, 0],
    ],
    features: ["door-north", "radiator-west", "window-south"],
    constraints: ["c-door", "c-radiator", "c-window", "c-chair"],
  },
];

const HOME_HASH = "54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e";
const HOME_VALID_DIGEST = "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f";

async function installToolCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type CapturedTool = { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => unknown };
    const captured = new Map<string, CapturedTool>();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool: async (tool: CapturedTool) => { captured.set(tool.name, tool); } },
    });
    (window as unknown as { __elnuvaCapturedTools: Map<string, CapturedTool> }).__elnuvaCapturedTools = captured;
  });
}

async function invokeTool(page: Page, name: string, input: unknown): Promise<unknown> {
  return page.evaluate(async ({ toolName, toolInput }) => {
    type CapturedTool = { execute: (value: unknown, options: { signal: AbortSignal }) => unknown };
    const tools = (window as unknown as { __elnuvaCapturedTools: Map<string, CapturedTool> }).__elnuvaCapturedTools;
    const tool = tools.get(toolName);
    if (!tool) throw new Error(`Registered tool ${toolName} was not captured.`);
    return tool.execute(toolInput, { signal: new AbortController().signal });
  }, { toolName: name, toolInput: input });
}

async function openEditor(page: Page): Promise<Locator> {
  await page.goto("/");
  const editor = page.locator('svg[data-room-editor]');
  await expect(editor).toHaveCount(1);
  await expect(editor).toHaveAccessibleName("Room layout editor");
  return editor;
}

function geometryRow(page: Page, itemId: string): Locator {
  return page.locator(`[data-geometry-row][data-item-id="${itemId}"]`);
}

async function definitionValue(page: Page, term: string): Promise<string> {
  const definitionTerm = page.locator("dt").filter({ hasText: new RegExp(`^${term}$`) }).first();
  await expect(definitionTerm).toBeVisible();
  return (await definitionTerm.locator("xpath=following-sibling::dd[1]").textContent())?.trim() ?? "";
}

async function revision(page: Page): Promise<number> {
  return Number(await definitionValue(page, "Revision"));
}

async function roomPointToClient(editor: Locator, xMm: number, yMm: number): Promise<{ x: number; y: number }> {
  return editor.evaluate((node, point) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("SVG screen CTM is unavailable.");
    const transformed = new DOMPoint(point.xMm, point.yMm).matrixTransform(matrix);
    return { x: transformed.x, y: transformed.y };
  }, { xMm, yMm });
}

async function beginDrag(
  page: Page,
  editor: Locator,
  itemId: string,
  from: { xMm: number; yMm: number },
  to: { xMm: number; yMm: number },
): Promise<void> {
  await editor.scrollIntoViewIfNeeded();
  const start = await roomPointToClient(editor, from.xMm, from.yMm);
  const target = await roomPointToClient(editor, to.xMm, to.yMm);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await expect(editor.locator(`[data-furniture-id="${itemId}"]`)).toHaveAttribute("data-x-mm", String(to.xMm));
  await expect(editor.locator(`[data-furniture-id="${itemId}"]`)).toHaveAttribute("data-y-mm", String(to.yMm));
}

async function dragAndRelease(
  page: Page,
  editor: Locator,
  itemId: string,
  from: { xMm: number; yMm: number },
  to: { xMm: number; yMm: number },
): Promise<void> {
  await beginDrag(page, editor, itemId, from, to);
  await page.mouse.up();
}

test.describe("precise room editor", () => {
  test("renders exact template factories, semantic layers, and text geometry", async ({ page }) => {
    const editor = await openEditor(page);
    for (const layer of ["grid", "features", "furniture", "constraints", "dimensions", "preview"]) {
      await expect(editor.locator(`[data-layer="${layer}"]`)).toHaveCount(1);
    }
    const selector = page.getByRole("combobox", { name: "Room template" });
    await expect(selector.locator("option")).toHaveText(["Home Office", "Bedroom", "Study"]);
    expect(await selector.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
      .toEqual(["home-office", "bedroom", "study"]);

    for (const fixture of FIXTURES) {
      await selector.selectOption(fixture.id);
      await expect(selector).toHaveValue(fixture.id);
      await expect(selector.locator(`option[value="${fixture.id}"]`)).toHaveText(fixture.label);
      expect(await revision(page)).toBe(1);

      const furniture = editor.locator('[data-layer="furniture"] [data-furniture-id]');
      await expect(furniture).toHaveCount(3);
      expect(await furniture.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.furnitureId)))
        .toEqual(fixture.furniture.map(([id]) => id));
      for (const [id, label, xMm, yMm, rotationDeg] of fixture.furniture) {
        const item = editor.locator(`[data-layer="furniture"] [data-furniture-id="${id}"]`);
        await expect(item).toHaveCount(1);
        await expect(item).toHaveAccessibleName(label);
        await expect(item).toHaveAttribute("data-x-mm", String(xMm));
        await expect(item).toHaveAttribute("data-y-mm", String(yMm));
        await expect(item).toHaveAttribute("data-rotation-deg", String(rotationDeg));
        await expect(geometryRow(page, id)).toHaveCount(1);
        await expect(geometryRow(page, id)).toContainText(label);
      }

      const features = editor.locator('[data-layer="features"] [data-feature-id]');
      await expect(features).toHaveCount(3);
      expect(await features.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.featureId)))
        .toEqual(fixture.features);
      const constraints = page.locator('[data-constraint-list] [data-constraint-id]');
      await expect(constraints).toHaveCount(4);
      expect(await constraints.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.constraintId)))
        .toEqual(fixture.constraints);
    }
  });

  test("uses the live SVG CTM, keeps drag transient, and commits exactly one 50 mm command", async ({ page }) => {
    const editor = await openEditor(page);
    const chair = editor.locator('[data-furniture-id="chair-main"]');
    const row = geometryRow(page, "chair-main");
    const x = row.getByRole("spinbutton", { name: "X position (mm)" });
    const y = row.getByRole("spinbutton", { name: "Y position (mm)" });
    const beforeRevision = await revision(page);

    await beginDrag(page, editor, "chair-main", { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
    await expect(chair).toHaveAttribute("data-x-mm", "2550");
    await expect(x).toHaveValue("2500");
    await expect(y).toHaveValue("1300");
    expect(await revision(page)).toBe(beforeRevision);

    await page.mouse.up();
    await expect(x).toHaveValue("2550");
    await expect(y).toHaveValue("1300");
    expect(await revision(page)).toBe(beforeRevision + 1);
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/Chair.*2550.*1300|moved.*50 mm/i);
  });

  for (const vector of [
    { name: "out-of-bounds", to: { xMm: 200, yMm: 1500 }, status: /outside|bounds/i },
    { name: "furniture collision", to: { xMm: 2500, yMm: 500 }, status: /overlap|collision|Desk/i },
    { name: "radiator keep-out", to: { xMm: 3300, yMm: 1300 }, status: /radiator|keep-out/i },
  ] as const) {
    test(`rejects the exact Home Office ${vector.name} vector without committing`, async ({ page }) => {
      const editor = await openEditor(page);
      const row = geometryRow(page, "chair-main");
      const beforeRevision = await revision(page);
      await dragAndRelease(page, editor, "chair-main", { xMm: 2500, yMm: 1300 }, vector.to);
      const chair = editor.locator('[data-furniture-id="chair-main"]');
      await expect(chair).toHaveAttribute("data-x-mm", "2500");
      await expect(chair).toHaveAttribute("data-y-mm", "1300");
      await expect(row.getByRole("spinbutton", { name: "X position (mm)" })).toHaveValue("2500");
      expect(await revision(page)).toBe(beforeRevision);
      await expect(page.locator('[data-editor-status][role="status"]')).toContainText(vector.status);
    });
  }

  test("allows exact positive-area edge touch and commits it once", async ({ page }) => {
    const editor = await openEditor(page);
    const beforeRevision = await revision(page);
    await dragAndRelease(page, editor, "chair-main", { xMm: 2500, yMm: 1300 }, { xMm: 1500, yMm: 500 });
    const chair = editor.locator('[data-furniture-id="chair-main"]');
    await expect(chair).toHaveAttribute("data-x-mm", "1500");
    await expect(chair).toHaveAttribute("data-y-mm", "500");
    expect(await revision(page)).toBe(beforeRevision + 1);
  });

  test("owns one captured pointer and safely cancels both pointercancel and lost capture", async ({ page }) => {
    const editor = await openEditor(page);
    const chair = editor.locator('[data-furniture-id="chair-main"]');
    await chair.evaluate(node => {
      const events: { type: string; pointerId: number }[] = [];
      for (const type of ["gotpointercapture", "lostpointercapture"]) {
        node.addEventListener(type, event => events.push({ type, pointerId: (event as PointerEvent).pointerId }));
      }
      (window as unknown as { __elnuvaPointerEvents: typeof events }).__elnuvaPointerEvents = events;
    });
    const beforeRevision = await revision(page);
    await beginDrag(page, editor, "chair-main", { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __elnuvaPointerEvents: { type: string; pointerId: number }[] }).__elnuvaPointerEvents
        .some(event => event.type === "gotpointercapture"),
    )).toBe(true);
    const activePointerId = await page.evaluate(() =>
      (window as unknown as { __elnuvaPointerEvents: { type: string; pointerId: number }[] }).__elnuvaPointerEvents
        .find(event => event.type === "gotpointercapture")!.pointerId,
    );
    expect(await chair.evaluate((node, pointerId) => node.hasPointerCapture(pointerId), activePointerId)).toBe(true);

    await chair.dispatchEvent("pointerdown", { pointerId: 77, pointerType: "touch", isPrimary: false, clientX: 0, clientY: 0 });
    await chair.dispatchEvent("pointermove", { pointerId: 77, pointerType: "touch", isPrimary: false, clientX: 500, clientY: 500 });
    await chair.dispatchEvent("pointerup", { pointerId: 77, pointerType: "touch", isPrimary: false, clientX: 500, clientY: 500 });
    await expect(chair).toHaveAttribute("data-x-mm", "2550");
    expect(await revision(page)).toBe(beforeRevision);

    await chair.dispatchEvent("pointercancel", { pointerId: activePointerId, pointerType: "mouse", isPrimary: true });
    await expect(chair).toHaveAttribute("data-x-mm", "2500");
    await page.mouse.up();
    expect(await revision(page)).toBe(beforeRevision);

    await beginDrag(page, editor, "chair-main", { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
    const recapturedId = await page.evaluate(() =>
      (window as unknown as { __elnuvaPointerEvents: { type: string; pointerId: number }[] }).__elnuvaPointerEvents
        .filter(event => event.type === "gotpointercapture").at(-1)!.pointerId,
    );
    await chair.evaluate((node, pointerId) => node.releasePointerCapture(pointerId), recapturedId);
    await expect(chair).toHaveAttribute("data-x-mm", "2500");
    await page.mouse.up();
    expect(await revision(page)).toBe(beforeRevision);
  });

  test("supports a real emulated touch drag without disabling global touch actions", async ({ browser, browserName }) => {
    expect(browserName).toBe("chromium");
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    const editor = await openEditor(page);
    const start = await roomPointToClient(editor, 2500, 1300);
    const target = await roomPointToClient(editor, 2550, 1300);
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x, y: start.y, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: target.x, y: target.y, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(editor.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "2550");
    expect(await revision(page)).toBe(2);
    expect(await page.evaluate(() => [getComputedStyle(document.documentElement).touchAction, getComputedStyle(document.body).touchAction]))
      .not.toContain("none");
    await context.close();
  });

  test("renders a real Stage callback preview without changing working state or persistence", async ({ page }) => {
    await installToolCapture(page);
    const editor = await openEditor(page);
    await expect.poll(() => page.evaluate(() =>
      [...(window as unknown as { __elnuvaCapturedTools: Map<string, unknown> }).__elnuvaCapturedTools.keys()],
    )).toContain("inspect_spatial_layout");
    const registeredNames = await page.evaluate(() =>
      [...(window as unknown as { __elnuvaCapturedTools: Map<string, unknown> }).__elnuvaCapturedTools.keys()].sort(),
    );
    expect(registeredNames).toEqual(["inspect_spatial_layout", "stage_layout_preview", "validate_layout_options"]);

    const before = await invokeTool(page, "inspect_spatial_layout", {}) as {
      ok: true;
      data: { baseRevision: number; baseHash: string; workingState: { constraints: unknown[] }; preview: unknown };
    };
    expect(before.ok).toBe(true);
    expect(before.data.baseRevision).toBe(1);
    expect(before.data.baseHash).toBe(HOME_HASH);
    const storedBefore = await page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)));
    const stage = await invokeTool(page, "stage_layout_preview", {
      baseRevision: before.data.baseRevision,
      baseHash: before.data.baseHash,
      constraints: before.data.workingState.constraints,
      optionId: "home-valid",
      moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }],
      proposalDigest: HOME_VALID_DIGEST,
      idempotencyKey: "fixture-home-0001",
    });
    expect(stage).toMatchObject({
      ok: true,
      data: {
        optionId: "home-valid",
        proposalDigest: HOME_VALID_DIGEST,
        notApplied: true,
        notSaved: true,
        requiresHumanAction: true,
      },
    });

    const ghost = editor.locator('[data-layer="preview"] [data-preview-item-id="desk-main"]');
    await expect(ghost).toHaveCount(1);
    await expect(ghost).toHaveAttribute("data-x-mm", "1900");
    await expect(editor.locator('[data-layer="furniture"] [data-furniture-id="desk-main"]')).toHaveAttribute("data-x-mm", "2500");
    const after = await invokeTool(page, "inspect_spatial_layout", {}) as typeof before;
    expect(after.data.baseRevision).toBe(before.data.baseRevision);
    expect(after.data.baseHash).toBe(before.data.baseHash);
    expect(after.data.workingState).toEqual(before.data.workingState);
    expect(after.data.preview).toMatchObject({ status: "pending-review", optionId: "home-valid", proposalDigest: HOME_VALID_DIGEST });
    expect(await page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)))).toEqual(storedBefore);

    await expect(page.getByRole("combobox", { name: "Room template" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Update furniture" })).toHaveCount(3);
    for (const control of await page.getByRole("button", { name: "Update furniture" }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("checkbox", { name: "Locked" }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("spinbutton").all()) await expect(control).toBeDisabled();
  });

  test("has no page overflow or runtime errors at 1280, 390, and 320 px", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("pageerror", error => errors.push(`page: ${error.message}`));
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await openEditor(page);
      await expect(page.getByRole("combobox", { name: "Room template" })).toBeVisible();
      await expect(page.locator('[data-geometry-row]')).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
});
