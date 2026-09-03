import { expect, test, type Page } from "@playwright/test";

async function installCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Tool = { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => Promise<any> };
    const tools = new Map<string, Tool>();
    Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool: async (tool: Tool) => { tools.set(tool.name, tool); } } });
    (window as any).__elnuvaTools = tools;
  });
}

async function stageHome(page: Page): Promise<void> {
  const inspect = await page.evaluate(async () => (window as any).__elnuvaTools.get("inspect_spatial_layout").execute({}, { signal: new AbortController().signal }));
  const moves = [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }];
  const validation = await page.evaluate(async ({ inspect, moves }) => (window as any).__elnuvaTools.get("validate_layout_options").execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, options: [{ optionId: "home-valid", moves }] }, { signal: new AbortController().signal }), { inspect, moves });
  const staged = await page.evaluate(async ({ inspect, moves, result }) => (window as any).__elnuvaTools.get("stage_layout_preview").execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, optionId: "home-valid", moves, proposalDigest: result.proposalDigest, idempotencyKey: "fixture-home-0001" }, { signal: new AbortController().signal }), { inspect, moves, result: validation.data.results[0] });
  expect(staged).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true } });
}

test.describe("T08 accessibility and truthful state", () => {
  test("has native names, logical keyboard focus, and a same-snapshot text alternative", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Elnuva" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Room template" })).toBeVisible();
    const editor = page.locator('svg[data-room-editor]');
    await expect(editor).toHaveAttribute("aria-label", "Room layout editor");
    await expect(editor).toHaveAttribute("aria-describedby", /\S+/);
    const descriptionId = await editor.getAttribute("aria-describedby");
    await expect(page.locator(`#${descriptionId}`)).toContainText(/home office.*3600\s*×\s*3000/i);
    const textState = page.locator("[data-semantic-layout]");
    await expect(textState).toContainText(/chair-main/i);
    await expect(textState).toContainText(/2500.*1300.*0/i);
    await expect(textState).toContainText(/storage-main.*locked/i);
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    expect(await focused.evaluate(node => {
      const style = getComputedStyle(node);
      return style.outlineStyle !== "none" || style.outlineWidth !== "0px" || style.boxShadow !== "none";
    })).toBe(true);
  });

  test("keeps keyboard focus distinct from selection and restores focus after a row mutation", async ({ page }) => {
    await page.goto("/");
    const chairGraphic = page.locator('[data-furniture-id="chair-main"]');
    const deskGraphic = page.locator('[data-furniture-id="desk-main"]');
    await chairGraphic.focus();
    await page.keyboard.press("Enter");
    await expect(chairGraphic).toHaveAttribute("aria-pressed", "true");
    await deskGraphic.focus();
    await expect(deskGraphic).toBeFocused();
    await expect(chairGraphic).toHaveAttribute("aria-pressed", "true");
    await expect(deskGraphic).toHaveAttribute("aria-pressed", "false");

    const chairRow = page.locator('[data-geometry-row][data-item-id="chair-main"]');
    const update = chairRow.getByRole("button", { name: "Update furniture" });
    await update.focus();
    await page.keyboard.press("Enter");
    await expect(update).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(chairRow.getByRole("button", { name: "Delete furniture" })).toBeFocused();
  });

  test("reports errors and success with text, role status, and no color-only meaning", async ({ page }) => {
    await page.goto("/");
    const chair = page.locator('[data-geometry-row][data-item-id="chair-main"]');
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("200");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    const status = page.locator('[data-editor-status][role="status"]');
    await expect(status).toContainText(/rejected|outside|bounds/i);
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).not.toHaveText("");
    await expect(page.getByText(/planning aid.*not.*certif|not.*building code|not.*egress/i)).toBeVisible();
    const required = page.locator('[data-semantic-layout] [data-constraint-id="c-door"]');
    await expect(required).toContainText(/required/i);
    await expect(required).toContainText(/door path clear/i);
  });

  test("preview is explicitly not applied/not saved and leaves only Apply/Discard enabled", async ({ page }) => {
    await installCapture(page);
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => (window as any).__elnuvaTools?.size)).toBe(3);
    await stageHome(page);
    await expect(page.locator("[data-preview-review]")).toContainText(/not applied/i);
    await expect(page.locator("[data-preview-review]")).toContainText(/not saved/i);
    await expect(page.getByRole("combobox", { name: "Room template" })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Add furniture" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add selected furniture" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add constraint" })).toBeDisabled();
    for (const name of ["Save", "Undo", "Reset"]) await expect(page.getByRole("button", { name })).toBeDisabled();
    for (const control of await page.getByRole("button", { name: "Update furniture" }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("button", { name: "Delete furniture" }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("button", { name: /update constraint/i }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("button", { name: /delete constraint/i }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("checkbox", { name: "Locked" }).all()) await expect(control).toBeDisabled();
    await expect(page.getByRole("button", { name: "Apply preview" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Discard preview" })).toBeEnabled();
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveAttribute("aria-label", /preview ghost.*not applied/i);
    await expect(page.locator("[data-preview-review]")).toContainText(/required constraints.*2\/2/i);
    await page.getByRole("button", { name: "Discard preview" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
  });

  test("does not render internal storage, replay, prompt, or inactive-template metadata", async ({ page }) => {
    await page.goto("/");
    const body = page.locator("body");
    await expect(body).not.toContainText(/elnuva:v1:template|idempotency|reservation|proposalDigest|localStorage|prompt transcript/i);
    await expect(body).not.toContainText(/bed-main|table-main/);
    await expect(page.locator('script[src^="http"], link[href^="http"], img[src^="http"]')).toHaveCount(0);
  });
});
