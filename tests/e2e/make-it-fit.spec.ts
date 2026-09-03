import { expect, test, type Page } from "@playwright/test";
import { enterWorkspace, setView } from "./workspace-helpers";
import type { InspectSpatialLayoutData, ToolResult, WorkingState } from "../../src/domain/types";

const initial: WorkingState = { schemaVersion: 1, templateId: "home-office", room: { widthMm: 3000, depthMm: 3000 },
  furniture: [{ id: "chair-main", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false }], features: [], constraints: [] };
async function setup(page: Page, state = initial) {
  // Real public storage format and registered handler capture, not native agent
  // selection evidence. No debug endpoint or production global is introduced.
  await page.addInitScript(value => {
    localStorage.setItem("elnuva:v1:template:home-office", JSON.stringify({ storageVersion: 1, templateId: "home-office", state: value }));
    const tools = new Map<string, { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => unknown }>();
    Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool: async (tool: { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => unknown }) => { tools.set(tool.name, tool); } } });
    Object.assign(window, { __fitTestTools: tools });
  }, state);
  await page.goto("/"); await enterWorkspace(page); await setView(page, "precision-2d");
  const panel = page.locator("section[data-fit-panel]"); await expect(panel).toHaveCount(1);
  const closed = panel.locator("details:not([open]) > summary");
  if (await closed.count()) await closed.click();
  await expect(panel.getByRole("heading", { name: "Make it Fit", exact: true })).toBeVisible();
}
async function inspect(page: Page): Promise<InspectSpatialLayoutData> {
  const result = await page.evaluate(async () => {
    const tools = (window as unknown as { __fitTestTools: Map<string, { execute: (input: unknown, options: { signal: AbortSignal }) => unknown }> }).__fitTestTools;
    return tools.get("inspect_spatial_layout")!.execute({}, { signal: new AbortController().signal });
  }) as ToolResult<InspectSpatialLayoutData>;
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("Expected real Inspect result"); return result.data;
}
const persisted = (page: Page) => page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
async function queueChair(page: Page) {
  await page.getByLabel("Furniture to request", { exact: true }).selectOption("chair-600x600");
  await page.getByRole("button", { name: "Request furniture", exact: true }).click();
  const row = page.locator("[data-fit-request-list] [data-fit-request-id]"); await expect(row).toHaveCount(1);
  await expect(row).toContainText("Requested — not placed"); await expect(row).toContainText(/600.*600/);
  const id = await row.getAttribute("data-fit-request-id"); expect(id).toBeTruthy(); return id!;
}
async function start(page: Page) {
  await page.getByLabel("Fit room width (mm)", { exact: true }).fill("3500");
  await page.getByLabel("Fit room depth (mm)", { exact: true }).fill("3200");
  await page.getByRole("button", { name: "Make it Fit", exact: true }).click();
  await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "FOUND", { timeout: 17000 });
}

test.describe("explicit full-state Make it Fit workflow", () => {
  test("keeps queue/preview ephemeral, shows both full-target ghosts, applies once, saves separately and undoes the whole state", async ({ page }) => {
    await setup(page); const before = await inspect(page), saved = await persisted(page), id = await queueChair(page);
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved); await start(page);
    const review = page.locator("[data-review-dock] [data-human-fit-preview]"); await expect(review).toBeVisible();
    await expect(review.getByRole("heading", { name: "Make it Fit preview — Not applied — Not saved", exact: true })).toBeVisible();
    await expect(review).toContainText(/3000.*3000/); await expect(review).toContainText(/3500.*3200/); await expect(review).toContainText(id);
    await expect(review).toContainText(/600.*600/); await expect(review).toContainText(/required/i); await expect(review).toContainText(/preferred/i);
    const preview = await inspect(page); expect(preview.workingState).toEqual(before.workingState); expect(preview.baseHash).toBe(before.baseHash); expect(preview.baseRevision).toBe(before.baseRevision);
    expect(preview.preview).toEqual({ status: "pending-human-fit", notApplied: true, notSaved: true, requiresHumanAction: true });
    expect(await persisted(page)).toEqual(saved);
    // Read the declared visible SVG/text semantic alternatives, not a private
    // preview object or a production debug API. All duplicate readouts must agree.
    type Ghost = { id: string; xMm: number; yMm: number; rotationDeg: number; widthMm: number; depthMm: number };
    const viewTargets: Array<{ room: { widthMm: number; depthMm: number }; furniture: Ghost[] }> = [];
    for (const mode of ["precision-2d", "top", "isometric"] as const) {
      await setView(page, mode);
      const rooms = page.locator("[data-fit-target-room]").filter({ visible: true }); expect(await rooms.count()).toBeGreaterThan(0);
      const roomReadouts = await rooms.evaluateAll(nodes => nodes.map(node => ({
        widthMm: Number(node.getAttribute("data-width-mm")), depthMm: Number(node.getAttribute("data-depth-mm")),
      })));
      for (const room of roomReadouts) expect(room).toEqual({ widthMm: 3500, depthMm: 3200 });
      const ghosts = page.locator("[data-fit-preview-item-id]").filter({ visible: true });
      const ids = await ghosts.evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute("data-fit-preview-item-id")))].sort());
      expect(ids).toEqual(["chair-main", id].sort());
      for (const node of await ghosts.all()) {
        await expect(node).not.toHaveAttribute("data-furniture-id", /.+/);
        expect(await node.getAttribute("tabindex")).not.toBe("0");
        for (const attribute of ["data-x-mm", "data-y-mm", "data-rotation-deg"]) await expect(node).toHaveAttribute(attribute, /^\d+$/);
      }
      const readouts = await ghosts.evaluateAll(nodes => nodes.map(node => ({
        id: node.getAttribute("data-fit-preview-item-id")!, xMm: Number(node.getAttribute("data-x-mm")),
        yMm: Number(node.getAttribute("data-y-mm")), rotationDeg: Number(node.getAttribute("data-rotation-deg")),
        widthMm: Number(node.getAttribute("data-width-mm")), depthMm: Number(node.getAttribute("data-depth-mm")),
      })));
      const byId = new Map<string, Ghost>();
      for (const ghost of readouts) {
        expect(ghost.widthMm).toBe(600); expect(ghost.depthMm).toBe(600);
        expect(ghost.xMm).toBeGreaterThanOrEqual(300); expect(ghost.xMm).toBeLessThanOrEqual(3200);
        expect(ghost.yMm).toBeGreaterThanOrEqual(300); expect(ghost.yMm).toBeLessThanOrEqual(2900);
        expect([0, 90, 180, 270]).toContain(ghost.rotationDeg);
        if (byId.has(ghost.id)) expect(ghost).toEqual(byId.get(ghost.id));
        else byId.set(ghost.id, ghost);
      }
      const shown = { room: roomReadouts[0], furniture: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
      if (viewTargets.length) expect(shown).toEqual(viewTargets[0]);
      viewTargets.push(shown);
      expect(await inspect(page)).toEqual(preview);
    }
    for (const label of ["Fit room width (mm)", "Fit room depth (mm)", "Furniture to request"]) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Apply preview", exact: true }).click();
    const applied = await inspect(page); expect(applied.baseRevision).toBe(before.baseRevision + 1); expect(applied.workingState.room).toEqual({ widthMm: 3500, depthMm: 3200 });
    expect(applied.workingState.furniture.map(item => item.id)).toEqual(["chair-main", id]); expect(applied.preview).toEqual({ status: "none" });
    expect(viewTargets).toHaveLength(3);
    for (const shown of viewTargets) {
      const expectedFurniture = [...before.workingState.furniture, { id, catalogId: "chair-600x600" as const, locked: false }].map(item => {
        const ghost = shown.furniture.find(value => value.id === item.id)!;
        expect(ghost).toBeDefined(); expect(item.catalogId).toBe("chair-600x600");
        expect({ widthMm: ghost.widthMm, depthMm: ghost.depthMm }).toEqual({ widthMm: 600, depthMm: 600 });
        return { id: item.id, catalogId: item.catalogId, locked: item.locked, xMm: ghost.xMm, yMm: ghost.yMm, rotationDeg: ghost.rotationDeg };
      });
      expect(applied.workingState).toEqual({ ...before.workingState, room: shown.room, furniture: expectedFurniture });
    }
    expect(await persisted(page)).toEqual(saved); await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click(); const savedTarget = await persisted(page);
    expect(JSON.parse(savedTarget.local.find(([key]) => key === "elnuva:v1:template:home-office")![1]).state).toEqual(applied.workingState);
    await page.getByRole("button", { name: "Undo", exact: true }).click(); const undone = await inspect(page);
    expect(undone.workingState).toEqual(before.workingState); expect(undone.baseRevision).toBe(before.baseRevision + 2); expect(undone.baseHash).toBe(before.baseHash);
    expect(await persisted(page)).toEqual(savedTarget);
  });

  test("leaves failed normal Add out of the request queue until a separate explicit action", async ({ page }) => {
    const full: WorkingState = { ...initial, room: { widthMm: 2000, depthMm: 2000 }, furniture: [{ id: "bed-main", catalogId: "bed-2000x1600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false }] };
    await setup(page, full); const before = await inspect(page), saved = await persisted(page);
    await page.getByRole("combobox", { name: "Add furniture", exact: true }).selectOption("chair-600x600");
    await page.getByRole("button", { name: "Add selected furniture", exact: true }).click();
    await expect(page.locator("[data-fit-request-list] [data-fit-request-id]")).toHaveCount(0);
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    await page.getByRole("button", { name: "Request this furniture for Make it Fit", exact: true }).click();
    await expect(page.locator("[data-fit-request-list] [data-fit-request-id]")).toHaveCount(1);
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
  });

  for (const width of [320, 390, 1440]) test(`keeps the full request keyboard journey and preview values available at${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await setup(page);
    const widthInput = page.getByLabel("Fit room width (mm)", { exact: true }), depthInput = page.getByLabel("Fit room depth (mm)", { exact: true });
    await widthInput.focus(); await expect(widthInput).toBeFocused(); await page.keyboard.press("Tab"); await expect(depthInput).toBeFocused();
    await page.keyboard.press("Tab"); await expect(page.getByLabel("Furniture to request", { exact: true })).toBeFocused();
    await page.getByLabel("Furniture to request", { exact: true }).selectOption("chair-600x600");
    await page.keyboard.press("Tab"); const requestButton = page.getByRole("button", { name: "Request furniture", exact: true }); await expect(requestButton).toBeFocused();
    await page.keyboard.press("Enter"); const row = page.locator("[data-fit-request-id]"); const id = await row.getAttribute("data-fit-request-id");
    const remove = page.getByRole("button", { name: `Remove request ${id}`, exact: true }); await remove.focus(); await expect(remove).toBeFocused();
    await page.keyboard.press("Enter"); await expect(row).toHaveCount(0); await queueChair(page); await start(page);
    await expect(page.locator('[data-fit-status][aria-live="polite"]')).toBeVisible();
    for (const control of [page.getByRole("button", { name: "Apply preview", exact: true }), page.getByRole("button", { name: "Discard preview", exact: true })]) {
      await control.focus(); await expect(control).toBeFocused(); await control.scrollIntoViewIfNeeded(); const box = await control.boundingBox();
      expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "Discard preview", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0); expect((await inspect(page)).workingState).toEqual(initial);
  });
});
