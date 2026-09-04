import { expect, test, type Page } from "@playwright/test";
import { enterWorkspace, setView, openPanel, openReviewDetails } from "./workspace-helpers";
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
  await openPanel(page, "fit");
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
  await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
  await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "FOUND", { timeout: 17000 });
}

// A completed result may be cleared, reconciled, or explicitly presented as
// history. Do not require a new status enum or particular repaired wording.
const historicalResult = /(?:\b(?:previous|last|completed|historical)\s+(?:fit\s+)?(?:run|search|result)\b|\b(?:run|search|result)\s*\(historical\))/i;
async function expectResolvedFitStatus(page: Page) {
  const status = page.locator("[data-fit-status]");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("data-fit-state", /^(IDLE|RUNNING|FOUND|ALREADY_FITS|PROVEN_IMPOSSIBLE|CANCELLED|RESOURCE_LIMIT|INVALID_REQUEST|INTERNAL_ERROR)$/);
  await expect(status).toContainText(/elapsed.*\d+\s*\/\s*15000\s*ms/i);
  const text = await status.innerText();
  if (/ready for review|not (?:yet |been )?(?:applied|saved)|unapplied|unsaved|awaiting (?:review|application)/i.test(text)) {
    expect(text, "Resolved preview must not retain unqualified live ready/unapplied/unsaved claims").toMatch(historicalResult);
  }
}
async function expectCurrentPendingGuidance(page: Page) {
  await expect(page.locator("[data-human-fit-preview]").getByRole("heading", { name: "Make it Fit preview — Not applied — Not saved", exact: true })).toBeVisible();
  const messages = page.locator("section[data-fit-panel] [data-fit-status], section[data-fit-panel] .fit-request-note");
  await expect(messages).toHaveCount(2);
  for (const message of await messages.all()) {
    const text = await message.innerText();
    if (/(?:arrangement|preview|layout)\s+(?:(?:is|was|has been)\s+)?(?:applied|saved)\b/i.test(text)) {
      expect(text, "A fresh unapplied preview must not inherit an unqualified prior Apply/Save claim").toMatch(historicalResult);
    }
  }
}

test.describe("explicit full-state Make it Fit workflow", () => {
  for (const resolution of ["Apply", "Save"] as const) test(`reconciles fit-panel status after successful ${resolution}`, async ({ page }) => {
    await setup(page); const before = await inspect(page), saved = await persisted(page);
    await queueChair(page); await start(page); await expectCurrentPendingGuidance(page);
    await page.getByRole("button", { name: "Apply preview", exact: true }).click();
    const applied = await inspect(page);
    expect(applied.preview).toEqual({ status: "none" }); expect(applied.baseRevision).toBe(before.baseRevision + 1);
    expect(applied.workingState.room).toEqual({ widthMm: 3500, depthMm: 3200 });
    expect(await persisted(page)).toEqual(saved);
    if (resolution === "Save") {
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const stored = await persisted(page);
      expect(JSON.parse(stored.local.find(([key]) => key === "elnuva:v1:template:home-office")![1]).state).toEqual(applied.workingState);
      expect(await inspect(page)).toEqual(applied);
    }
    await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0);
    await expectResolvedFitStatus(page);
  });

  test("reconciles fit-panel status after Discard without changing the working or saved layout", async ({ page }) => {
    await setup(page); const before = await inspect(page), saved = await persisted(page);
    await queueChair(page); await start(page); await expectCurrentPendingGuidance(page);
    await page.getByRole("button", { name: "Discard preview", exact: true }).click();
    await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0);
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    await expectResolvedFitStatus(page);
  });

  test("a fresh Fit after Apply Save and Undo does not inherit an applied-status claim", async ({ page }) => {
    await setup(page); const before = await inspect(page);
    await queueChair(page); await start(page); await expectCurrentPendingGuidance(page);
    await page.getByRole("button", { name: "Apply preview", exact: true }).click();
    const applied = await inspect(page);
    await page.getByRole("button", { name: "Save", exact: true }).click(); const savedTarget = await persisted(page);
    expect(JSON.parse(savedTarget.local.find(([key]) => key === "elnuva:v1:template:home-office")![1]).state).toEqual(applied.workingState);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    const freshBase = await inspect(page);
    expect(freshBase.workingState).toEqual(before.workingState); expect(freshBase.preview).toEqual({ status: "none" });
    // Do not overwrite the previous confirmation by requesting another item.
    // The changed target room alone must produce a new, unapplied preview.
    await start(page);
    const freshPreview = await inspect(page);
    expect(freshPreview.workingState).toEqual(freshBase.workingState);
    expect(freshPreview.baseRevision).toBe(freshBase.baseRevision); expect(freshPreview.baseHash).toBe(freshBase.baseHash);
    expect(freshPreview.preview).toEqual({ status: "pending-human-fit", notApplied: true, notSaved: true, requiresHumanAction: true });
    expect(await persisted(page)).toEqual(savedTarget);
    await expectCurrentPendingGuidance(page);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });

  test("keeps queue/preview ephemeral, shows both full-target ghosts, applies once, saves separately and undoes the whole state", async ({ page }) => {
    await setup(page); const before = await inspect(page), saved = await persisted(page), id = await queueChair(page);
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved); await start(page);
    const review = page.locator("[data-review-dock] [data-human-fit-preview]"); await expect(review).toBeVisible();
    await expect(review.getByRole("heading", { name: "Make it Fit preview — Not applied — Not saved", exact: true })).toBeVisible();
    await openReviewDetails(page);
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
    await openPanel(page, "add");
    await page.getByRole("combobox", { name: "Add furniture", exact: true }).selectOption("chair-600x600");
    await page.getByRole("button", { name: "Add selected furniture", exact: true }).click();
    await expect(page.locator("[data-fit-request-list] [data-fit-request-id]")).toHaveCount(0);
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    await page.getByRole("button", { name: "Request this furniture for Make it Fit", exact: true }).click();
    await expect(page.locator('[data-workspace-panel="fit"]')).toBeVisible();
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

// Completed outcomes describe the evaluated request, which can differ from the
// now-visible room or editable inputs. Accept explicit historical scope without
// prescribing a replacement sentence or inventing another progress enum.
const historicalRequest = /(?:\b(?:last|previous|prior|completed|historical)\b[^.!?\n]{0,80}\b(?:request|run|search|result|outcome)\b|\b(?:request|run|search|result|outcome)\b[^.!?\n]{0,80}\b(?:previous|prior|historical)\b)/i;
async function expectLastRequestOutcome(page: Page, outcome: "ALREADY_FITS" | "PROVEN_IMPOSSIBLE") {
  const status = page.locator("[data-fit-status]");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("data-fit-state", outcome);
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toContainText(/elapsed.*\d+\s*\/\s*15000\s*ms/i);
  expect(await status.innerText(), "A completed outcome must be explicitly scoped to its evaluated request, not assert the changed room or queue still fits/fails").toMatch(historicalRequest);
}

test.describe("completed fit outcomes remain scoped to the evaluated request", () => {
  test("ALREADY_FITS stays historical after Reset changes the working room", async ({ page }) => {
    await setup(page); const before = await inspect(page), saved = await persisted(page);
    const workers: string[] = []; page.on("worker", worker => workers.push(worker.url()));
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "ALREADY_FITS");
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved); expect(workers).toEqual([]);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    const reset = await inspect(page);
    expect(reset.workingState.room).toEqual({ widthMm: 3600, depthMm: 3000 });
    expect(reset.workingState.furniture.map(item => item.id)).toEqual(["chair-main", "desk-main", "storage-main"]);
    expect(reset.baseRevision).toBe(before.baseRevision + 1); expect(reset.baseHash).not.toBe(before.baseHash);
    expect(reset.preview).toEqual({ status: "none" }); expect(await persisted(page)).toEqual(saved);
    await expect(page.getByLabel("Fit room width (mm)", { exact: true })).toHaveValue("3000");
    await expect(page.getByLabel("Fit room depth (mm)", { exact: true })).toHaveValue("3000");
    await expect(page.locator("[data-fit-request-list] [data-fit-request-id]")).toHaveCount(0);
    await expectLastRequestOutcome(page, "ALREADY_FITS");
  });

  for (const change of ["room input", "requested addition"] as const) test(`ALREADY_FITS stays historical after editing ${change} and a fresh run has current preview guidance`, async ({ page }) => {
    await setup(page); const before = await inspect(page), saved = await persisted(page);
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "ALREADY_FITS");
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    if (change === "room input") {
      await page.getByLabel("Fit room width (mm)", { exact: true }).fill("3500");
      await expect(page.getByLabel("Fit room width (mm)", { exact: true })).toHaveValue("3500");
      await expect(page.locator("[data-fit-request-list] [data-fit-request-id]")).toHaveCount(0);
    } else {
      await queueChair(page);
      await expect(page.getByLabel("Fit room width (mm)", { exact: true })).toHaveValue("3000");
    }
    await expect(page.getByLabel("Fit room depth (mm)", { exact: true })).toHaveValue("3000");
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    await expectLastRequestOutcome(page, "ALREADY_FITS");
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "FOUND", { timeout: 17000 });
    await expectCurrentPendingGuidance(page);
    await expect(page.locator("[data-fit-status]")).toContainText(/ready for review/i);
    await expect(page.locator("[data-fit-status]")).toContainText(/not been applied or saved/i);
    const preview = await inspect(page);
    expect(preview.workingState).toEqual(before.workingState); expect(preview.baseRevision).toBe(before.baseRevision); expect(preview.baseHash).toBe(before.baseHash);
    expect(preview.preview).toEqual({ status: "pending-human-fit", notApplied: true, notSaved: true, requiresHumanAction: true });
    expect(await persisted(page)).toEqual(saved);
  });

  test("PROVEN_IMPOSSIBLE stays historical after removing requested beds and a fresh request replaces it", async ({ page }) => {
    const empty: WorkingState = { ...initial, room: { widthMm: 2000, depthMm: 2000 }, furniture: [] };
    await setup(page, empty); const before = await inspect(page), saved = await persisted(page);
    const workers: string[] = []; page.on("worker", worker => workers.push(worker.url()));
    await page.getByLabel("Furniture to request", { exact: true }).selectOption("bed-2000x1600");
    for (let index = 0; index < 2; index++) await page.getByRole("button", { name: "Request furniture", exact: true }).click();
    const rows = page.locator("[data-fit-request-list] [data-fit-request-id]"); await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) await expect(row).toContainText(/2000.*1600/);
    expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
    const status = page.locator("[data-fit-status]");
    await expect(status).toHaveAttribute("data-fit-state", "PROVEN_IMPOSSIBLE", { timeout: 17000 });
    await expect(status).toContainText("No arrangement exists within this 2D model and its required constraints.");
    expect(workers).toHaveLength(1); expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    for (const remaining of [1, 0]) {
      await rows.first().getByRole("button", { name: /^Remove request / }).click();
      await expect(rows).toHaveCount(remaining);
      expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
    }
    await expect(page.getByLabel("Fit room width (mm)", { exact: true })).toHaveValue("2000");
    await expect(page.getByLabel("Fit room depth (mm)", { exact: true })).toHaveValue("2000");
    await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0);
    await expectLastRequestOutcome(page, "PROVEN_IMPOSSIBLE");
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
    await expect(status).toHaveAttribute("data-fit-state", "ALREADY_FITS");
    await expect(status).not.toContainText("No arrangement exists within this 2D model and its required constraints.");
    expect(workers).toHaveLength(1); expect(await inspect(page)).toEqual(before); expect(await persisted(page)).toEqual(saved);
  });
});
