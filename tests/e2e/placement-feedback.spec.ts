import { expect, test, type Locator, type Page } from "@playwright/test";
import { fitTopCamera, projectTopPoint } from "../../src/ui/spatial-projection";
import { enterWorkspace, setView } from "./workspace-helpers";
import type { InspectSpatialLayoutData, ToolResult } from "../../src/domain/types";

// Captured real handlers provide read-only stamps; this is not native discovery.
async function open(page: Page, mode: "precision-2d" | "top") {
  await page.addInitScript(() => {
    const tools = new Map<string, { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => unknown }>();
    Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool: async (tool: { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => unknown }) => { tools.set(tool.name, tool); } } });
    Object.assign(window, { __feedbackTools: tools });
  });
  await page.goto("/"); await enterWorkspace(page); await setView(page, mode);
  if (mode === "top") await expect(page.locator("[data-spatial-status]")).toHaveAttribute("data-state", "available");
  return page.locator(mode === "top" ? "canvas[data-spatial-canvas]" : "svg[data-room-editor]");
}
async function inspect(page: Page): Promise<InspectSpatialLayoutData> {
  const result = await page.evaluate(async () => (window as unknown as { __feedbackTools: Map<string, { execute: (input: unknown, options: { signal: AbortSignal }) => unknown }> })
    .__feedbackTools.get("inspect_spatial_layout")!.execute({}, { signal: new AbortController().signal })) as ToolResult<InspectSpatialLayoutData>;
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("Expected Inspect"); return result.data;
}
async function point(page: Page, surface: Locator, mode: "precision-2d" | "top", xMm: number, yMm: number) {
  if (mode === "precision-2d") return surface.evaluate((node, p) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM(); if (!matrix) throw new Error("Missing live CTM");
    const result = new DOMPoint(p.xMm, p.yMm).matrixTransform(matrix); return { x: result.x, y: result.y };
  }, { xMm, yMm });
  const box = await surface.boundingBox(); expect(box).not.toBeNull(); const state = await inspect(page), viewport = { width: box!.width, height: box!.height };
  const result = projectTopPoint({ xMm, yMm }, fitTopCamera(state.workingState.room, viewport), viewport);
  return { x: box!.x + result.x, y: box!.y + result.y };
}
async function hold(page: Page, surface: Locator, mode: "precision-2d" | "top", xMm: number, yMm: number) {
  await surface.scrollIntoViewIfNeeded(); const start = await point(page, surface, mode, 2500, 1300), end = await point(page, surface, mode, xMm, yMm);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 3 });
}
const storage = (page: Page) => page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));

for (const mode of ["precision-2d", "top"] as const) test.describe(`${mode} live candidate feedback`, () => {
  for (const vector of [
    { name: "room boundary", x: 200, y: 1500, reason: /bound|outside/i, identity: /chair-main/ },
    { name: "other furniture", x: 2500, y: 500, reason: /overlap|collision/i, identity: /desk-main/ },
    { name: "radiator", x: 3300, y: 1300, reason: /radiator|keep.out/i, identity: /radiator-east/ },
  ]) test(`shows live physical red/non-color ${vector.name} feedback, without transient persistence`, async ({ page }) => {
    const surface = await open(page, mode), before = await inspect(page), saved = await storage(page);
    await hold(page, surface, mode, vector.x, vector.y);
    const feedback = page.locator('[data-placement-feedback][aria-live="polite"]').filter({ visible: true });
    await expect(feedback).toHaveCount(1); await expect(feedback).toHaveAttribute("data-placement-state", "blocked");
    await expect(feedback).toContainText(vector.reason); await expect(feedback).toContainText(vector.identity);
    // Visible readable blocking copy is a non-color cue. Require an actual red
    // outline/marker in the visible DOM, not just a class named "red".
    const red = await page.locator('[data-placement-feedback], svg[data-room-editor] *').evaluateAll(nodes => nodes.some(node => {
      if (!(node instanceof Element) || node.getClientRects().length === 0) return false;
      const style = getComputedStyle(node);
      return [style.stroke, style.outlineColor, style.borderColor, style.color].some(color => {
        const values = color.match(/[\d.]+/g)?.map(Number); return values && values[0] > values[1] + 40 && values[0] > values[2] + 40 && values[0] > 90;
      });
    }));
    expect(red).toBe(true); expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
    await page.mouse.up(); expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
    await expect(page.locator('[data-placement-state="blocked"]').filter({ visible: true })).toHaveCount(0);
  });

  test("marks required/preferred violations as warnings yet preserves the valid manual release policy", async ({ page }) => {
    const surface = await open(page, mode), before = await inspect(page), saved = await storage(page);
    // Chair(2500,2200) is clear of all physical objects but >500mm from desk.
    await hold(page, surface, mode, 2500, 2200);
    const feedback = page.locator("[data-placement-feedback]").filter({ visible: true });
    await expect(feedback).toHaveAttribute("data-placement-state", "warning"); await expect(feedback).toContainText(/required|preferred/i);
    expect(await inspect(page)).toEqual(before); await page.mouse.up();
    await expect.poll(async () => (await inspect(page)).baseRevision).toBe(before.baseRevision + 1);
    const after = await inspect(page); expect(after.workingState.furniture.find(item => item.id === "chair-main")).toMatchObject({ xMm: 2500, yMm: 2200 });
    expect(await storage(page)).toEqual(saved); await expect(page.locator('[data-placement-state="warning"]').filter({ visible: true })).toHaveCount(0);
  });

  test("clears blocked feedback on a new valid candidate, cancellation and view change", async ({ page }) => {
    const surface = await open(page, mode), before = await inspect(page);
    await hold(page, surface, mode, 2500, 500); await expect(page.locator('[data-placement-state="blocked"]').filter({ visible: true })).toHaveCount(1);
    const valid = await point(page, surface, mode, 2550, 1300); await page.mouse.move(valid.x, valid.y);
    await expect(page.locator('[data-placement-state="blocked"]').filter({ visible: true })).toHaveCount(0);
    const change = page.getByRole("button", { name: mode === "top" ? "Precision 2D" : "Top", exact: true }); await change.focus(); await page.keyboard.press("Enter");
    await page.mouse.up(); expect(await inspect(page)).toEqual(before);
    await expect(page.locator('[data-placement-state="blocked"], [data-placement-state="warning"]').filter({ visible: true })).toHaveCount(0);
  });
});
