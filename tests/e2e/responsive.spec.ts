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
  await expect.poll(() => page.evaluate(() => (window as any).__elnuvaTools?.size)).toBe(3);
  const inspect = await page.evaluate(async () => (window as any).__elnuvaTools.get("inspect_spatial_layout").execute({}, { signal: new AbortController().signal }));
  const moves = [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }];
  const validation = await page.evaluate(async ({ inspect, moves }) => (window as any).__elnuvaTools.get("validate_layout_options").execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, options: [{ optionId: "home-valid", moves }] }, { signal: new AbortController().signal }), { inspect, moves });
  const staged = await page.evaluate(async ({ inspect, moves, result }) => (window as any).__elnuvaTools.get("stage_layout_preview").execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, optionId: "home-valid", moves, proposalDigest: result.proposalDigest, idempotencyKey: "fixture-home-0001" }, { signal: new AbortController().signal }), { inspect, moves, result: validation.data.results[0] });
  expect(staged.ok).toBe(true);
}

const overflow = (page: Page) => page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth, body: document.body.scrollWidth }));

for (const viewport of [
  { width: 1280, height: 800, name: "desktop" },
  { width: 390, height: 844, name: "mobile" },
  { width: 320, height: 568, name: "narrow mobile" },
] as const) {
  test(`${viewport.name} ${viewport.width}x${viewport.height} has no page overflow and keeps core editing usable`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`page: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator('svg[data-room-editor]')).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Room template" })).toBeVisible();
    await expect(page.locator('[data-geometry-row][data-item-id="chair-main"]')).toBeVisible();
    const metrics = await overflow(page);
    expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
    const chair = page.locator('[data-geometry-row][data-item-id="chair-main"]');
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("1900");
    await chair.getByRole("spinbutton", { name: "Y position (mm)" }).fill("1300");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "1900");
    const after = await overflow(page);
    expect(after.page).toBeLessThanOrEqual(after.viewport);
    expect(after.body).toBeLessThanOrEqual(after.viewport);
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }] as const) {
  test(`${viewport.width}px keeps expanded preview review and human controls visible without overflow`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`page: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await installCapture(page);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await stageHome(page);
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toBeVisible();
    await expect(page.locator("[data-preview-review]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply preview" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard preview" })).toBeVisible();
    const metrics = await overflow(page);
    expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
    expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
    await page.getByRole("button", { name: "Discard preview" }).click();
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
    expect(await overflow(page)).toMatchObject({ viewport: viewport.width, page: viewport.width, body: viewport.width });
    expect(errors).toEqual([]);
  });
}
