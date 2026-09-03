import { expect, test, type Page } from "@playwright/test";

type Tool = { execute: (input: unknown, options: { signal: AbortSignal }) => Promise<any> };
const moveSets = {
  "home-office": { optionId: "home-valid", key: "fixture-home-0001", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }] },
  bedroom: { optionId: "bedroom-valid", key: "fixture-bedroom-0001", moves: [{ itemId: "bed-main", pose: { xMm: 2700, yMm: 2100, rotationDeg: 0 } }, { itemId: "nightstand-main", pose: { xMm: 3950, yMm: 2500, rotationDeg: 90 } }] },
  study: { optionId: "study-valid", key: "fixture-study-0001", moves: [{ itemId: "table-main", pose: { xMm: 1500, yMm: 2100, rotationDeg: 0 } }, { itemId: "chair-main", pose: { xMm: 2300, yMm: 1400, rotationDeg: 0 } }] },
} as const;
const constraintResults = {
  "home-office": ["c-door", "c-radiator", "c-window", "c-chair"],
  bedroom: ["c-door", "c-radiator", "c-window", "c-nightstand"],
  study: ["c-door", "c-radiator", "c-window", "c-chair"],
} as const;

async function installCapture(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, Tool>();
    Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool: async (tool: Tool & { name: string }) => { tools.set(tool.name, tool); } } });
    (window as any).__elnuvaTools = tools;
  });
}
async function tool(page: Page, name: string): Promise<Tool> {
  await expect.poll(() => page.evaluate(n => (window as any).__elnuvaTools.has(n), name)).toBe(true);
  return page.evaluateHandle(n => (window as any).__elnuvaTools.get(n), name).then(async handle => handle.jsonValue() as Promise<Tool>);
}
async function stage(page: Page, template: keyof typeof moveSets) {
  if (template !== "home-office") {
    await page.getByRole("combobox", { name: "Room template" }).selectOption(template);
  }
  const inspect = await page.evaluate(async () => { const t = (window as any).__elnuvaTools.get("inspect_spatial_layout"); return t.execute({}, { signal: new AbortController().signal }); });
  expect(inspect.ok).toBe(true);
  const fixture = moveSets[template];
  const validation = await page.evaluate(async ({ inspect, fixture }) => { const t = (window as any).__elnuvaTools.get("validate_layout_options"); return t.execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, options: [{ optionId: fixture.optionId, moves: fixture.moves }] }, { signal: new AbortController().signal }); }, { inspect, fixture });
  expect(validation.ok).toBe(true);
  const summary = validation.data.results[0];
  return page.evaluate(async ({ inspect, fixture, summary }) => { const t = (window as any).__elnuvaTools.get("stage_layout_preview"); return t.execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, optionId: fixture.optionId, moves: fixture.moves, proposalDigest: summary.proposalDigest, idempotencyKey: fixture.key }, { signal: new AbortController().signal }); }, { inspect, fixture, summary });
}

test.describe("T07 preview review and human control", () => {
  test("renders the real Stage result as one ghost with explicit review truth", async ({ page }) => {
    await installCapture(page); await page.goto("/");
    const result = await stage(page, "home-office");
    expect(result).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true, requiresHumanAction: true, allowedHumanActions: ["apply", "discard"] } });
    await expect(page.locator("[data-preview-review]")).toContainText(/not applied/i);
    await expect(page.locator("[data-preview-review]")).toContainText(/not saved/i);
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Apply preview" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Discard preview" })).toBeEnabled();
  });

  for (const template of ["home-office", "bedroom", "study"] as const) {
    test(`uses the exact ${template} StageValidationSummary in visible review`, async ({ page }) => {
      await installCapture(page); await page.goto("/");
      const result = await stage(page, template);
      expect(result.ok).toBe(true);
      await expect(page.locator('[data-preview-review] [data-option-id]')).toHaveAttribute("data-option-id", moveSets[template].optionId);
      await expect(page.locator("[data-preview-review]")).toContainText(/Required constraints/i);
      await expect(page.locator("[data-preview-review]")).toContainText(/Preferred constraints/i);
      await expect(page.locator('[data-preview-review] [data-preview-required]')).toHaveText(/2\/2/);
      await expect(page.locator('[data-preview-review] [data-preview-preferred]')).toHaveText(/2\/2/);
      const rows = page.locator('[data-preview-review] [data-preview-constraint-results] [data-constraint-result]');
      await expect(rows).toHaveCount(constraintResults[template].length);
      expect(await rows.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.constraintId)))
        .toEqual(constraintResults[template]);
      for (const id of constraintResults[template]) {
        const row = page.locator(`[data-preview-review] [data-preview-constraint-results] [data-constraint-result][data-constraint-id="${id}"]`);
        await expect(row).toContainText(new RegExp(id));
        await expect(row).toContainText(/satisfied/i);
      }
      await expect(page.locator("[data-preview-review]")).toContainText(/not applied/i);
      await expect(page.locator("[data-preview-review]")).toContainText(/not saved/i);
    });
  }

  test("disables every mutation control while pending except human Apply and Discard", async ({ page }) => {
    await installCapture(page); await page.goto("/"); await stage(page, "home-office");
    for (const name of ["Room template", "Add furniture", "Delete furniture", "Save", "Undo", "Reset", "Update furniture", "Locked"]) {
      const control = page.getByRole(name === "Room template" ? "combobox" : name === "Locked" ? "checkbox" : "button", { name });
      if (await control.count()) await expect(control.first()).toBeDisabled();
    }
    await expect(page.getByRole("button", { name: "Apply preview" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Discard preview" })).toBeEnabled();
  });

  test("keyboard Discard clears the ghost without changing revision or state, and reload proves unsaved", async ({ page }) => {
    await installCapture(page); await page.goto("/"); await stage(page, "home-office");
    const revision = page.locator("dt").filter({ hasText: /^Revision$/ }).locator("xpath=following-sibling::dd[1]");
    await expect(revision).toHaveText("1");
    await page.getByRole("button", { name: "Discard preview" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
    await expect(revision).toHaveText("1");
    await stage(page, "home-office"); await page.reload();
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
    await expect(page.locator("[data-preview-review]")).toHaveCount(0);
  });

  test("keyboard Apply changes pose and revision once, then Undo restores it without conflating Save", async ({ page }) => {
    await installCapture(page); await page.goto("/"); await stage(page, "home-office");
    await page.getByRole("button", { name: "Apply preview" }).focus(); await page.keyboard.press("Enter");
    await expect(page.locator("dt").filter({ hasText: /^Revision$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("2");
    await expect(page.locator('[data-furniture-id="desk-main"]')).toHaveAttribute("data-x-mm", "1900");
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("dt").filter({ hasText: /^Revision$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("3");
    await expect(page.locator('[data-furniture-id="desk-main"]')).toHaveAttribute("data-x-mm", "2500");
  });
});
