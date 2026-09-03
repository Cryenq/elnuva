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

async function expectReadablePreviewMetrics(page: Page, expectedColumns: number): Promise<void> {
  const metrics = page.locator("[data-preview-review] .preview-metrics");
  await expect(metrics.locator(":scope > div > dt")).toHaveText([
    "Option", "Moved", "Rotated", "Movement", "Clearance",
    "Required constraints", "Preferred constraints", "Validation",
  ]);
  await expect(metrics.locator(":scope > div > dd")).toHaveText([
    "home-valid", "1", "0", "600 mm", "100 mm", "2/2", "2/2", "Valid · stageable",
  ]);
  await metrics.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  for (const term of await metrics.locator("dt, dd").all()) await expect(term).toBeVisible();

  const geometry = await metrics.evaluate(element => {
    // Use text fragments, not element visibility or root scrollWidth: overflow-x: clip
    // can conceal unreadable content while both of those weaker checks still pass.
    const tolerance = 0.5; // Only allow subpixel layout rounding, not clipped letters.
    const rect = (value: DOMRect) => ({
      left: value.left, right: value.right, top: value.top, bottom: value.bottom,
      width: value.width, height: value.height,
    });
    const metricsBox = rect(element.getBoundingClientRect());
    const reviewBox = rect(element.closest("[data-preview-review]")!.getBoundingClientRect());
    const cells = Array.from(element.children, cell => ({
      name: cell.querySelector("dt")!.textContent!,
      box: rect(cell.getBoundingClientRect()),
      terms: Array.from(cell.querySelectorAll("dt, dd"), term => {
        const fragments: ReturnType<typeof rect>[] = [];
        const textNodes = document.createTreeWalker(term, NodeFilter.SHOW_TEXT);
        let textNode: Node | null;
        while ((textNode = textNodes.nextNode())) {
          if (!textNode.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(textNode);
          fragments.push(...Array.from(range.getClientRects(), rect));
        }
        return { text: term.textContent!, box: rect(term.getBoundingClientRect()), fragments };
      }),
    }));
    const violations: string[] = [];
    const contained = (inner: ReturnType<typeof rect>, outer: ReturnType<typeof rect>) =>
      inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance &&
      inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
    const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
    const runs: { name: string; box: ReturnType<typeof rect> }[] = [];
    for (const [cellIndex, cell] of cells.entries()) {
      for (const term of cell.terms) {
        const name = `${cell.name}: ${term.text}`;
        if (term.fragments.length === 0) violations.push(`${name} has no rendered text fragments`);
        for (const fragment of term.fragments) {
          if (fragment.width <= 0 || fragment.height <= 0) violations.push(`${name} has an empty text fragment`);
          for (const [boundary, box] of [
            ["label/value", term.box], ["metric cell", cell.box],
            ["metrics grid", metricsBox], ["review panel", reviewBox],
          ] as const) {
            if (!contained(fragment, box)) {
              violations.push(`${name} text escapes ${boundary}: ${JSON.stringify({ fragment, box })}`);
            }
          }
          if (fragment.left < -tolerance || fragment.right > document.documentElement.clientWidth + tolerance) {
            violations.push(`${name} text is clipped by the viewport horizontally`);
          }
          for (const [neighborIndex, neighbor] of cells.entries()) {
            if (cellIndex !== neighborIndex && overlaps(fragment, neighbor.box)) {
              violations.push(`${name} text overlaps neighboring metric cell ${neighbor.name}`);
            }
          }
          runs.push({ name, box: fragment });
        }
      }
    }
    for (let i = 0; i < runs.length; i += 1) {
      for (let j = i + 1; j < runs.length; j += 1) {
        if (overlaps(runs[i].box, runs[j].box)) {
          violations.push(`${runs[i].name} text overlaps ${runs[j].name} text`);
        }
      }
    }
    return { violations, columns: getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length };
  });
  // Readability is asserted first so a bad cascade fails on actual clipping/overlap.
  expect(geometry.violations, "Every Preview metric label and value must remain readable").toEqual([]);
  expect(geometry.columns).toBe(expectedColumns);
}

for (const viewport of [
  { width: 1280, height: 800, columns: 4 },
  { width: 390, height: 844, columns: 2 },
  { width: 320, height: 568, columns: 2 },
] as const) {
  test(`${viewport.width}px keeps every Preview metric text contained and non-overlapping`, async ({ page }) => {
    // This captured registration exercises the real Stage/UI path deterministically;
    // it is not evidence of native client discovery or model-selected invocation.
    await installCapture(page);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await stageHome(page);
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toBeVisible();
    await expectReadablePreviewMetrics(page, viewport.columns);
    await expect(page.getByRole("button", { name: "Apply preview" })).toBeEnabled();
    await page.getByRole("button", { name: "Discard preview" }).click();
    await expect(page.locator("[data-preview-review]")).toHaveCount(0);
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
  });
}

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
  test(`${viewport.width}px keeps visual card order aligned with DOM and keyboard order`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const controls = page.getByRole("heading", { level: 2, name: "Templates" }).locator("xpath=ancestor::aside[1]");
    const plan = page.getByRole("heading", { level: 2, name: "Home Office plan" }).locator("xpath=ancestor::section[1]");
    const details = page.getByRole("heading", { level: 2, name: "Furniture", exact: true }).locator("xpath=ancestor::aside[1]");
    const domOrder = await page.locator("main.workspace > .card").evaluateAll(cards => cards.map(card => card.querySelector("h2")?.textContent?.trim()));
    expect(domOrder).toEqual(["Templates", "Home Office plan", "Furniture"]);
    const boxes = await Promise.all([controls, plan, details].map(locator => locator.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
    expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
    await page.keyboard.press("Tab");
    const template = page.getByRole("combobox", { name: "Room template" });
    await expect(template).toBeFocused();
    const templateBox = await template.boundingBox();
    const saveBox = await page.getByRole("button", { name: "Save" }).boundingBox();
    expect(templateBox).not.toBeNull();
    expect(saveBox).not.toBeNull();
    expect(templateBox!.y).toBeLessThan(saveBox!.y);
  });

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
