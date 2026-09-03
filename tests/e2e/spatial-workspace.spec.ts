import { expect, test, type Locator, type Page } from "@playwright/test";
import { fitTopCamera, projectTopPoint } from "../../src/ui/spatial-projection";
import { enterWorkspace, expectPendingMutationControls, openSection, selectFurniture, setView } from "./workspace-helpers";

// Captured registration exercises real handlers deterministically. It is NOT
// evidence of native discovery, client selection, or a native invocation score.
async function capture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools = new Map();
    Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool: async (tool: any) => { tools.set(tool.name, tool); } } });
    (window as any).__spatialTools = tools;
  });
}
async function invoke(page: Page, name: string, input: unknown): Promise<any> {
  await expect.poll(() => page.evaluate(() => (window as any).__spatialTools?.size)).toBe(3);
  return page.evaluate(async ({ name, input }) => (window as any).__spatialTools.get(name).execute(input, { signal: new AbortController().signal }), { name, input });
}
const inspect = (page: Page): Promise<any> => invoke(page, "inspect_spatial_layout", {});
const storage = (page: Page) => page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
async function stageHome(page: Page, key = "spatial-fixture-0001"): Promise<any> {
  const before = await inspect(page);
  expect(before.ok).toBe(true);
  const moves = [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }];
  const validation = await invoke(page, "validate_layout_options", { baseRevision: before.data.baseRevision, baseHash: before.data.baseHash, constraints: before.data.workingState.constraints, options: [{ optionId: "home-valid", moves }] });
  expect(validation.ok).toBe(true);
  const staged = await invoke(page, "stage_layout_preview", { baseRevision: before.data.baseRevision, baseHash: before.data.baseHash, constraints: before.data.workingState.constraints, optionId: "home-valid", moves, proposalDigest: validation.data.results[0].proposalDigest, idempotencyKey: key });
  expect(staged).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true, requiresHumanAction: true } });
  return staged;
}
async function openSpatial(page: Page): Promise<Locator> {
  await capture(page);
  await page.goto("/");
  await enterWorkspace(page);
  const status = page.locator("[data-spatial-status]");
  await expect(status).toHaveAttribute("data-state", "available");
  await setView(page, "top");
  const canvas = page.locator("canvas[data-spatial-canvas]");
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  return canvas;
}
async function point(page: Page, canvas: Locator, xMm: number, yMm: number): Promise<{ x: number; y: number }> {
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const current = await inspect(page);
  const viewport = { width: box!.width, height: box!.height };
  const frame = fitTopCamera(current.data.workingState.room, viewport);
  const projected = projectTopPoint({ xMm, yMm }, frame, viewport);
  return { x: box!.x + projected.x, y: box!.y + projected.y };
}
async function beginDrag(page: Page, canvas: Locator, from: { xMm: number; yMm: number }, to: { xMm: number; yMm: number }): Promise<number> {
  await canvas.evaluate(node => node.addEventListener("pointerdown", event => { (window as any).__spatialPointerId = (event as PointerEvent).pointerId; }, { once: true }));
  const start = await point(page, canvas, from.xMm, from.yMm);
  const end = await point(page, canvas, to.xMm, to.yMm);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  const pointerId = await page.evaluate(() => (window as any).__spatialPointerId as number);
  expect(Number.isInteger(pointerId)).toBe(true);
  return pointerId;
}
async function uiStamp(page: Page) {
  return page.evaluate(() => ({
    entryVisible: !!document.querySelector<HTMLElement>("[data-workspace-entry]")?.getClientRects().length,
    modes: Array.from(document.querySelectorAll('[data-workspace] button[aria-pressed]'), node => [node.textContent, node.getAttribute("aria-pressed")]),
    selected: Array.from(document.querySelectorAll('[data-scene-item-list] button[aria-pressed="true"]'), node => node.getAttribute("aria-label") ?? node.textContent),
    focus: document.activeElement?.getAttribute("data-focus-key") ?? document.activeElement?.textContent,
    editorStatus: document.querySelector("[data-editor-status]")?.textContent,
  }));
}

test.describe("T09 interactive spatial workspace", () => {
  test("starts nonmodally and renders every exact template in a real WebGL2 canvas", async ({ page }) => {
    await capture(page); await page.goto("/");
    await expect(page.locator("[data-workspace-entry]")).toBeVisible();
    await expect(page.locator("[data-review-dock]")).toBeVisible();
    await expect(page.locator(".capability-status")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const before = await inspect(page);
    const saved = await storage(page);
    await enterWorkspace(page);
    await expect(page.getByRole("button", { name: "Isometric", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-spatial-status]")).toHaveAttribute("data-state", "available");
    expect(await inspect(page)).toEqual(before);
    expect(await storage(page)).toEqual(saved);
    const canvas = page.locator("canvas[data-spatial-canvas]");
    expect(await canvas.evaluate(node => Boolean((node as HTMLCanvasElement).getContext("webgl2")))).toBe(true);
    const expected = {
      "home-office": [["chair-main", "2500", "1300", "0", "false"], ["desk-main", "2500", "500", "0", "false"], ["storage-main", "700", "600", "0", "true"]],
      bedroom: [["bed-main", "2300", "2400", "0", "false"], ["nightstand-main", "3550", "2500", "0", "false"], ["wardrobe-main", "700", "700", "0", "true"]],
      study: [["bookcase-main", "2700", "2300", "0", "true"], ["chair-main", "2000", "1600", "0", "false"], ["table-main", "2000", "900", "0", "false"]],
    };
    for (const [template, rows] of Object.entries(expected)) {
      await page.getByRole("combobox", { name: "Room template", exact: true }).selectOption(template);
      await expect(canvas).toBeVisible();
      const list = page.locator("[data-scene-item-list] [data-spatial-item-id]");
      await expect(list).toHaveCount(3);
      expect(await list.evaluateAll(nodes => nodes.map(node => ["data-spatial-item-id", "data-x-mm", "data-y-mm", "data-rotation-deg", "data-locked"].map(name => node.getAttribute(name))))).toEqual(rows);
      await expect(page.locator('[data-layer="furniture"] [data-furniture-id]')).toHaveCount(3);
      for (const [id] of rows) await selectFurniture(page, id);
    }
  });

  test("real Top pick/drag stays transient then equals numeric state with one revision", async ({ browser, page }) => {
    const canvas = await openSpatial(page);
    const before = await inspect(page);
    const saved = await storage(page);
    const pointerId = await beginDrag(page, canvas, { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
    expect(await canvas.evaluate((node, id) => node.hasPointerCapture(id), pointerId)).toBe(true);
    expect(await inspect(page)).toEqual(before);
    await expect(page.locator('[data-scene-item-list] [data-spatial-item-id="chair-main"] button')).toHaveAttribute("aria-pressed", "true");
    await page.mouse.up();
    await expect.poll(async () => (await inspect(page)).data.baseRevision).toBe(before.data.baseRevision + 1);
    const after = await inspect(page);
    expect(after.data.workingState.furniture.find((item: any) => item.id === "chair-main")).toMatchObject({ xMm: 2550, yMm: 1300, rotationDeg: 0 });
    expect(await storage(page)).toEqual(saved);
    const context = await browser.newContext();
    try {
      const numeric = await context.newPage();
      await openSpatial(numeric);
      const form = await selectFurniture(numeric, "chair-main");
      await form.getByRole("spinbutton", { name: "X position (mm)" }).fill("2550");
      await form.getByRole("button", { name: "Update furniture", exact: true }).click();
      expect(await inspect(numeric)).toEqual(after);
    } finally { await context.close(); }
  });

  for (const vector of [
    { name: "no-op", id: "chair-main", from: [2500, 1300], to: [2500, 1300] },
    { name: "out-of-bounds", id: "chair-main", from: [2500, 1300], to: [200, 1500] },
    { name: "collision", id: "chair-main", from: [2500, 1300], to: [2500, 500] },
    { name: "radiator", id: "chair-main", from: [2500, 1300], to: [3300, 1300] },
    { name: "locked", id: "storage-main", from: [700, 600], to: [800, 600] },
  ]) {
    test(`does not commit a ${vector.name} spatial gesture`, async ({ page }) => {
      const canvas = await openSpatial(page);
      const before = await inspect(page);
      await beginDrag(page, canvas, { xMm: vector.from[0], yMm: vector.from[1] }, { xMm: vector.to[0], yMm: vector.to[1] });
      await page.mouse.up();
      expect(await inspect(page)).toEqual(before);
      const item = page.locator(`[data-spatial-item-id="${vector.id}"]`);
      await expect(item).toHaveAttribute("data-x-mm", String(vector.from[0]));
      await expect(item).toHaveAttribute("data-y-mm", String(vector.from[1]));
    });
  }

  for (const reason of ["pointercancel", "lost capture", "view change", "template change", "preview arrival"] as const) {
    test(`cancels a live spatial gesture on ${reason}`, async ({ page }) => {
      const canvas = await openSpatial(page);
      const before = await inspect(page);
      const id = await beginDrag(page, canvas, { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
      expect(await canvas.evaluate((node, pointerId) => node.hasPointerCapture(pointerId), id)).toBe(true);
      if (reason === "pointercancel") await canvas.dispatchEvent("pointercancel", { pointerId: id, isPrimary: true, pointerType: "mouse" });
      if (reason === "lost capture") await canvas.evaluate((node, pointerId) => node.releasePointerCapture(pointerId), id);
      if (reason === "view change") {
        const control = page.getByRole("button", { name: "Isometric", exact: true });
        await control.focus();
        await page.keyboard.press("Enter"); // Do not release the held pointer before switching views.
        await expect(control).toHaveAttribute("aria-pressed", "true");
      }
      if (reason === "template change") await page.getByRole("combobox", { name: "Room template", exact: true }).selectOption("bedroom");
      if (reason === "preview arrival") await stageHome(page);
      await page.mouse.up();
      if (reason === "template change") await page.getByRole("combobox", { name: "Room template", exact: true }).selectOption("home-office");
      const after = await inspect(page);
      expect(after.data.workingState).toEqual(before.data.workingState);
      expect(after.data.baseRevision).toBe(before.data.baseRevision);
      expect(after.data.baseHash).toBe(before.data.baseHash);
      if (reason === "preview arrival") expect(after.data.preview).toMatchObject({ status: "pending-review" });
      else expect(after.data.preview).toEqual(before.data.preview);
    });
  }

  test("secondary pointers cannot take over a captured primary drag", async ({ page }) => {
    const canvas = await openSpatial(page);
    const id = await beginDrag(page, canvas, { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
    for (const type of ["pointerdown", "pointermove", "pointerup"]) await canvas.dispatchEvent(type, { pointerId: 77, pointerType: "touch", isPrimary: false, clientX: 1, clientY: 1 });
    expect(await canvas.evaluate((node, pointerId) => node.hasPointerCapture(pointerId), id)).toBe(true);
    expect((await inspect(page)).data.baseRevision).toBe(1);
    await page.mouse.up();
    const after = await inspect(page);
    expect(after.data.baseRevision).toBe(2);
    expect(after.data.workingState.furniture.find((item: any) => item.id === "chair-main")).toMatchObject({ xMm: 2550, yMm: 1300 });
  });

  test("quarter-turn rotation is human-only and view/selection/reset do not mutate state", async ({ page }) => {
    const canvas = await openSpatial(page);
    const canvasIdentity = await canvas.elementHandle();
    const before = await inspect(page);
    const saved = await storage(page);
    for (const id of ["chair-main", "desk-main", "storage-main"]) await selectFurniture(page, id);
    for (const mode of ["isometric", "precision-2d", "top"] as const) await setView(page, mode);
    await page.getByRole("button", { name: "Reset view", exact: true }).click();
    expect(await inspect(page)).toEqual(before);
    expect(await storage(page)).toEqual(saved);
    expect(await canvas.evaluate((node, previous) => node === previous, canvasIdentity)).toBe(true);
    const locked = await selectFurniture(page, "storage-main");
    await expect(locked.getByRole("button", { name: "Rotate 90°", exact: true })).toBeDisabled();
    const chair = await selectFurniture(page, "chair-main");
    await chair.getByRole("button", { name: "Rotate 90°", exact: true }).click();
    const rotated = await inspect(page);
    expect(rotated.data.baseRevision).toBe(2);
    expect(rotated.data.workingState.furniture.find((item: any) => item.id === "chair-main")).toMatchObject({ xMm: 2500, yMm: 1300, rotationDeg: 90 });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await inspect(page)).data.workingState).toEqual(before.data.workingState);
    expect(await storage(page)).toEqual(saved);
  });

  test("Inspect/Validate do not alter UI and Stage remains visible without entering", async ({ page }) => {
    await capture(page); await page.goto("/");
    await expect(page.locator("[data-spatial-status]")).toHaveAttribute("data-state", "available");
    await page.getByRole("button", { name: "Start designing", exact: true }).focus();
    const ui = await uiStamp(page);
    const before = await inspect(page);
    expect(await uiStamp(page)).toEqual(ui);
    const saved = await storage(page);
    const validation = await invoke(page, "validate_layout_options", { baseRevision: before.data.baseRevision, baseHash: before.data.baseHash, constraints: before.data.workingState.constraints, options: [{ optionId: "home-valid", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }] }] });
    expect(validation.ok).toBe(true);
    expect(await uiStamp(page)).toEqual(ui);
    await stageHome(page);
    await expect(page.locator("[data-workspace-entry]")).toBeVisible();
    await expect(page.locator("[data-preview-review]")).toBeVisible();
    const stagedUi = await uiStamp(page);
    expect(stagedUi.modes).toEqual(ui.modes);
    expect(stagedUi.selected).toEqual(ui.selected);
    expect(stagedUi.focus).toBe(ui.focus);
    await expect(page.locator("[data-preview-review]")).toContainText(/not applied.*not saved/is);
    const ghost = page.locator('[data-spatial-preview-item-id="desk-main"]');
    await expect(ghost).toHaveCount(1);
    await expect(ghost).toContainText(/preview.*not applied/i);
    await expect(ghost).toHaveAttribute("data-x-mm", "1900");
    await expect(page.locator('[data-spatial-item-id="desk-main"]')).toHaveAttribute("data-x-mm", "2500");
    const after = await inspect(page);
    expect(after.data.workingState).toEqual(before.data.workingState);
    expect(after.data.baseHash).toBe(before.data.baseHash);
    expect(after.data.baseRevision).toBe(before.data.baseRevision);
    expect(await storage(page)).toEqual(saved);
    const entryTemplateControls = page.locator("[data-workspace-entry]").getByRole("button", { name: /^Use .+ template$/ });
    await expect(entryTemplateControls).toHaveCount(3);
    for (const control of await entryTemplateControls.all()) await expect(control).toBeDisabled();
    await enterWorkspace(page);
    await expectPendingMutationControls(page);
    await setView(page, "top");
    const canvas = page.locator("canvas[data-spatial-canvas]");
    await beginDrag(page, canvas, { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
    await page.mouse.up();
    expect(await inspect(page)).toEqual(after);
    await page.getByRole("button", { name: "Discard preview", exact: true }).click();
    await expect(page.locator("[data-spatial-preview-item-id]")).toHaveCount(0);
  });

  test("Top picking stays correctly projected after portrait resize without replacing canvas", async ({ page }) => {
    const canvas = await openSpatial(page);
    const original = await canvas.elementHandle();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(canvas).toBeVisible();
    const size = await canvas.boundingBox();
    expect(size!.width).toBeLessThanOrEqual(390);
    expect(await canvas.evaluate((node, previous) => node === previous, original)).toBe(true);
    await beginDrag(page, canvas, { xMm: 2500, yMm: 1300 }, { xMm: 2550, yMm: 1300 });
    await page.mouse.up();
    expect((await inspect(page)).data.workingState.furniture.find((item: any) => item.id === "chair-main")).toMatchObject({ xMm: 2550, yMm: 1300 });
    expect(await canvas.evaluate(node => (node as HTMLCanvasElement).width / node.getBoundingClientRect().width)).toBeLessThanOrEqual(2.01);
  });

  for (const failure of ["initialization", "context loss"] as const) {
    test(`explicit ${failure} fallback still supports precise numeric editing`, async ({ page }) => {
      await capture(page);
      if (failure === "initialization") await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: any[]) {
          if (kind === "webgl2") return null;
          return (original as any).call(this, kind, ...args);
        } as typeof original;
      });
      await page.goto("/"); await enterWorkspace(page);
      if (failure === "context loss") {
        await expect(page.locator("[data-spatial-status]")).toHaveAttribute("data-state", "available");
        const lost = await page.locator("canvas[data-spatial-canvas]").evaluate(node => {
          const context = (node as HTMLCanvasElement).getContext("webgl2");
          const extension = context?.getExtension("WEBGL_lose_context");
          if (!extension) return false;
          extension.loseContext(); return true;
        });
        expect(lost, "A real WebGL context-loss extension must execute; not a skipped fallback assertion").toBe(true);
      }
      await expect(page.locator("[data-spatial-status]")).toHaveAttribute("data-state", "unavailable");
      await expect(page.locator("[data-spatial-status]")).toContainText(/unavailable|lost|unable|not supported/i);
      await expect(page.locator("svg[data-room-editor]")).toBeVisible();
      const form = await selectFurniture(page, "chair-main");
      await form.getByRole("spinbutton", { name: "X position (mm)" }).fill("1901");
      await form.getByRole("button", { name: "Update furniture", exact: true }).click();
      const result = await inspect(page);
      expect(result.data.baseRevision).toBe(2);
      expect(result.data.workingState.furniture.find((item: any) => item.id === "chair-main").xMm).toBe(1901);
      await stageHome(page);
      await expect(page.locator("[data-preview-review]")).toBeVisible();
      await expect(page.locator('[data-layer="preview"] [data-preview-item-id="desk-main"]')).toBeVisible();
    });
  }

  test("reload does not persist entry/camera/selection or an unsaved edit", async ({ page }) => {
    await openSpatial(page);
    await selectFurniture(page, "desk-main");
    await setView(page, "precision-2d");
    const form = await selectFurniture(page, "chair-main");
    await form.getByRole("spinbutton", { name: "X position (mm)" }).fill("1900");
    await form.getByRole("button", { name: "Update furniture", exact: true }).click();
    expect(await storage(page)).toEqual({ local: [], session: [] });
    await page.reload();
    await expect(page.locator("[data-workspace-entry]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Isometric", exact: true })).toHaveAttribute("aria-pressed", "true");
    const result = await inspect(page);
    expect(result.data.baseRevision).toBe(1);
    expect(result.data.workingState.furniture.find((item: any) => item.id === "chair-main").xMm).toBe(2500);
    expect(await storage(page)).toEqual({ local: [], session: [] });
  });
});
