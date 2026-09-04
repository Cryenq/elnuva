import { expect, test, type Locator, type Page } from "@playwright/test";
import { enterWorkspace, expectCompactFocusOrder, openPanel, openReviewDetails, openSection, selectFurniture, setView } from "./workspace-helpers";

// Captured registration is deterministic handler/UI regression coverage only.
// POLISH-05 and native-client invocation require the separate actual-browser run.
async function capture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools = new Map<string, { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => Promise<any> }>();
    Object.defineProperty(document, "modelContext", { configurable: true, value: {
      registerTool: async (tool: { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => Promise<any> }) => { tools.set(tool.name, tool); },
    } });
    Object.assign(window, { __compactTools: tools });
  });
}
async function invoke(page: Page, name: string, input: unknown = {}): Promise<any> {
  await expect.poll(() => page.evaluate(() => (window as any).__compactTools?.size)).toBe(3);
  return page.evaluate(async ({ name, input }) => (window as any).__compactTools.get(name).execute(input, { signal: new AbortController().signal }), { name, input });
}
async function inspect(page: Page): Promise<any> {
  const result = await invoke(page, "inspect_spatial_layout");
  expect(result.ok).toBe(true);
  return result.data;
}
const storage = (page: Page) => page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
const moves = [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }];
async function validate(page: Page, before: any): Promise<any> {
  const response = await invoke(page, "validate_layout_options", { baseRevision: before.baseRevision, baseHash: before.baseHash,
    constraints: before.workingState.constraints, options: [{ optionId: "compact-home", moves }] });
  expect(response.ok).toBe(true);
  expect(response.data.results).toHaveLength(1);
  expect(response.data.results[0].stageable).toBe(true);
  return response.data.results[0];
}
async function stage(page: Page, before: any, summary: any): Promise<void> {
  const result = await invoke(page, "stage_layout_preview", { baseRevision: before.baseRevision, baseHash: before.baseHash,
    constraints: before.workingState.constraints, optionId: "compact-home", moves,
    proposalDigest: summary.proposalDigest, idempotencyKey: "compact-preview-0001" });
  expect(result).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true, requiresHumanAction: true } });
}
async function open(page: Page): Promise<Locator> {
  await capture(page); await page.goto("/"); await enterWorkspace(page);
  await expect(page.locator("[data-spatial-status]")).toHaveAttribute("data-state", "available");
  const canvas = page.locator("canvas[data-spatial-canvas]");
  await expect(canvas).toHaveCount(1); await expect(canvas).toBeVisible();
  expect(await canvas.evaluate(node => !!(node as HTMLCanvasElement).getContext("webgl2"))).toBe(true);
  return canvas;
}
async function containedInViewport(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox(); expect(box).not.toBeNull();
  const viewport = await control.page().evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}
async function noPageOverflow(page: Page, vertical = false): Promise<void> {
  const sizes = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
    documentHeight: document.documentElement.scrollHeight }));
  expect(sizes.documentWidth).toBeLessThanOrEqual(sizes.width + 1);
  expect(sizes.bodyWidth).toBeLessThanOrEqual(sizes.width + 1);
  if (vertical) expect(sizes.documentHeight).toBeLessThanOrEqual(sizes.height + 1);
}
async function sceneSize(canvas: Locator, widthFraction: number, heightFraction: number): Promise<void> {
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    const viewport = await canvas.page().evaluate(() => ({ width: innerWidth, height: innerHeight }));
    return !!box && box.width >= viewport.width * widthFraction && box.height >= viewport.height * heightFraction;
  }, { message: `Real canvas must occupy at least ${widthFraction * 100}% width and ${heightFraction * 100}% height` }).toBe(true);
}
async function viewStamp(page: Page) {
  return page.evaluate(() => ({
    entry: document.querySelector<HTMLElement>("[data-workspace-entry]")!.hidden,
    mode: document.querySelector(".app-shell")!.getAttribute("data-view-mode"),
    panels: Array.from(document.querySelectorAll("[data-panel-toggle]"), node => [node.getAttribute("data-panel-toggle"), node.getAttribute("aria-expanded")]),
    selected: Array.from(document.querySelectorAll('[data-scene-item-list] button[aria-pressed="true"]'), node => node.getAttribute("data-focus-key")),
    focus: document.activeElement?.getAttribute("data-focus-key"),
    capability: document.querySelector(".capability-status")!.textContent,
    capabilityState: document.querySelector(".capability-status")!.getAttribute("data-state"),
    status: document.querySelector("[data-editor-status]")!.textContent,
    values: Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"), node => [node.getAttribute("data-focus-key"), node.value]),
  }));
}

for (const width of [320, 390]) {
  test(`POLISH-03 R1 ${width}px fresh-entry actions meet the narrow pointer target before entering`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await capture(page); await page.goto("/");
    const entry = page.locator("[data-workspace-entry]");
    await expect(entry).toBeVisible();
    const before = await inspect(page), saved = await storage(page);
    const controls = entry.getByRole("button");
    await expect(controls).toHaveCount(4);
    await expect(controls).toHaveText(["Start designing", "Use Home Office template", "Use Bedroom template", "Use Study template"]);
    expect(await controls.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus-key"))))
      .toEqual(["workspace:start", "welcome:home-office", "welcome:bedroom", "welcome:study"]);
    for (const control of await controls.all()) {
      await control.scrollIntoViewIfNeeded(); await containedInViewport(control);
      const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.height, `Fresh-entry target: ${await control.innerText()}`).toBeGreaterThanOrEqual(44);
    }
    await noPageOverflow(page);
    expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
    await enterWorkspace(page);
    expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
  test(`POLISH-04 R1 ${viewport.width}x${viewport.height} feedback preserves the SVG mapping through a fixed-coordinate drag`, async ({ page }) => {
    await page.setViewportSize(viewport); await open(page); await setView(page, "precision-2d");
    const form = await selectFurniture(page, "chair-main");
    const svg = page.locator("svg[data-room-editor]");
    await expect(svg).toHaveCount(1); await expect(svg).toBeVisible(); await svg.scrollIntoViewIfNeeded();
    const originalSvg = await svg.elementHandle(); expect(originalSvg).not.toBeNull();
    const before = await inspect(page), saved = await storage(page);
    const chair = svg.locator('[data-furniture-id="chair-main"]');
    await expect(chair).toHaveAttribute("data-x-mm", "2500"); await expect(chair).toHaveAttribute("data-y-mm", "1300");
    // Every screen point is captured from the same pre-drag CTM. Recomputing a
    // target after feedback has shifted the SVG would conceal this regression.
    const original = await svg.evaluate(node => {
      const matrix = (node as SVGGraphicsElement).getScreenCTM();
      if (!matrix) throw new Error("Missing pre-drag SVG screen CTM");
      const rect = node.getBoundingClientRect();
      return {
        rect: [rect.x, rect.y, rect.width, rect.height],
        matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
        points: [[2500, 1300], [2500, 2200], [2500, 500], [2550, 2200]].map(([x, y]) => {
          const point = new DOMPoint(x, y).matrixTransform(matrix); return { x: point.x, y: point.y };
        }),
      };
    });
    const transitions = [
      { xMm: 2500, yMm: 2200, state: "warning", text: /Constraint warning.*(?:required|preferred).*Moving is allowed/i },
      { xMm: 2500, yMm: 500, state: "blocked", text: /Blocked.*chair-main.*desk-main/i },
      { xMm: 2550, yMm: 2200, state: "warning", text: /Constraint warning.*(?:required|preferred).*Moving is allowed/i },
    ];
    await page.mouse.move(original.points[0].x, original.points[0].y); await page.mouse.down();
    for (const [index, transition] of transitions.entries()) {
      const point = original.points[index + 1]; await page.mouse.move(point.x, point.y);
      const feedback = page.locator('[data-placement-feedback][aria-live="polite"]').filter({ visible: true });
      await expect(feedback).toHaveCount(1); await expect(feedback).toHaveAttribute("data-placement-state", transition.state);
      await expect(feedback).toContainText(transition.text);
      const current = await svg.evaluate(node => {
        const matrix = (node as SVGGraphicsElement).getScreenCTM();
        if (!matrix) throw new Error("Missing held-drag SVG screen CTM");
        const rect = node.getBoundingClientRect();
        return { rect: [rect.x, rect.y, rect.width, rect.height], matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] };
      });
      expect(current.rect, `${transition.state} feedback must not resize or reposition the held SVG`).toEqual(original.rect);
      expect(current.matrix, `${transition.state} feedback must not change the pointer coordinate mapping`).toEqual(original.matrix);
      expect(await originalSvg!.evaluate(node => node === document.querySelector("svg[data-room-editor]"))).toBe(true);
      await expect(chair).toHaveAttribute("data-x-mm", String(transition.xMm));
      await expect(chair).toHaveAttribute("data-y-mm", String(transition.yMm));
      await expect(form.getByRole("spinbutton", { name: "X position (mm)", exact: true })).toHaveValue("2500");
      await expect(form.getByRole("spinbutton", { name: "Y position (mm)", exact: true })).toHaveValue("1300");
      expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
    }
    await page.mouse.up();
    await expect.poll(async () => (await inspect(page)).baseRevision).toBe(before.baseRevision + 1);
    const after = await inspect(page);
    expect(after.workingState).toEqual({ ...before.workingState, furniture: before.workingState.furniture.map((item: any) =>
      item.id === "chair-main" ? { ...item, xMm: 2550, yMm: 2200 } : item) });
    expect(after.baseHash).not.toBe(before.baseHash); expect(after.preview).toEqual({ status: "none" });
    await expect(form.getByRole("spinbutton", { name: "X position (mm)", exact: true })).toHaveValue("2550");
    await expect(form.getByRole("spinbutton", { name: "Y position (mm)", exact: true })).toHaveValue("2200");
    await expect(page.locator("[data-placement-feedback]").filter({ visible: true })).toHaveCount(0);
    const released = await svg.boundingBox(); expect(released).not.toBeNull();
    expect([released!.x, released!.y, released!.width, released!.height]).toEqual(original.rect);
    expect(await storage(page)).toEqual(saved); await originalSvg!.dispose();
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
  test(`POLISH-01/02 ${viewport.width}x${viewport.height} gives the real persistent scene priority in every dock state`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const canvas = await open(page), originalCanvas = await canvas.elementHandle();
    expect(originalCanvas).not.toBeNull();
    const before = await inspect(page), saved = await storage(page);
    await expect(page.locator('[data-panel-toggle="properties"]')).toHaveAttribute("aria-expanded", "true");
    await sceneSize(canvas, 0.70, 0.70);
    const header = await page.locator(".site-header").boundingBox();
    expect(header).not.toBeNull(); expect(header!.height).toBeLessThanOrEqual(64);
    await noPageOverflow(page, true);
    const form = await selectFurniture(page, "chair-main");
    await containedInViewport(form.getByRole("spinbutton", { name: "X position (mm)", exact: true }));
    for (const panel of ["add", "fit", "properties"] as const) {
      await openPanel(page, panel);
      await sceneSize(canvas, 0.70, 0.55);
      await noPageOverflow(page, true);
      const controls = page.locator("button, input, select, summary").filter({ visible: true });
      await expect(controls).toHaveCount({ properties: 26, add: 14, fit: 19 }[panel]);
      for (const control of await controls.all()) {
        const height = await control.evaluate(node => (node.matches('input[type="checkbox"]') ? node.closest("label")! : node).getBoundingClientRect().height);
        expect(height, `Desktop target ${await control.getAttribute("data-focus-key")}`).toBeGreaterThanOrEqual(32);
      }
      expect(await originalCanvas!.evaluate(node => node === document.querySelector("canvas[data-spatial-canvas]"))).toBe(true);
    }
    await page.locator('[data-workspace-panel="properties"]').getByRole("button", { name: "Close Properties", exact: true }).click();
    await expect(page.locator('[data-panel-toggle="properties"]')).toHaveAttribute("aria-expanded", "false");
    await sceneSize(canvas, 0.88, 0.70);
    expect(await originalCanvas!.evaluate(node => node === document.querySelector("canvas[data-spatial-canvas]"))).toBe(true);
    expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
    await originalCanvas!.dispose();
  });

  test(`POLISH-02 ${viewport.width}x${viewport.height} keeps native preview truth/actions global and full details available`, async ({ page }) => {
    await page.setViewportSize(viewport); const canvas = await open(page);
    const before = await inspect(page), saved = await storage(page), validation = await validate(page, before);
    await openPanel(page, "add");
    await page.locator('[data-panel-toggle="add"]').focus();
    const ui = await viewStamp(page);
    await stage(page, before, validation);
    const afterUi = await viewStamp(page);
    expect(afterUi.panels).toEqual(ui.panels); expect(afterUi.mode).toEqual(ui.mode);
    expect(afterUi.entry).toBe(ui.entry); expect(afterUi.selected).toEqual(ui.selected); expect(afterUi.focus).toBe(ui.focus);
    const review = page.locator("[data-preview-review]");
    await expect(review).toContainText(/not applied.*not saved/is);
    const details = page.locator("details[data-review-details]");
    await expect(details).toHaveCount(1); await expect(details).toHaveJSProperty("open", false);
    for (const name of ["Apply preview", "Discard preview"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeEnabled(); await containedInViewport(button);
      expect(await button.evaluate(node => node.closest("[data-review-details]") === null)).toBe(true);
    }
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await sceneSize(canvas, 0.70, 0.55); await noPageOverflow(page, true);
    const pending = await inspect(page);
    expect(pending.workingState).toEqual(before.workingState); expect(pending.baseHash).toBe(before.baseHash); expect(pending.baseRevision).toBe(before.baseRevision);
    for (const panel of ["fit", "properties", "add"] as const) {
      await openPanel(page, panel); expect(await inspect(page)).toEqual(pending);
      await containedInViewport(page.getByRole("button", { name: "Apply preview", exact: true }));
    }
    await openReviewDetails(page);
    await sceneSize(canvas, 0.70, 0.55);
    await containedInViewport(page.getByRole("button", { name: "Apply preview", exact: true }));
    await containedInViewport(page.getByRole("button", { name: "Discard preview", exact: true }));
    await noPageOverflow(page, true);
    await expect(details.locator(".preview-metrics dt")).toHaveText(["Option", "Moved", "Rotated", "Movement", "Clearance", "Required constraints", "Preferred constraints", "Validation"]);
    await expect(details.locator(".preview-metrics dd")).toHaveText(["compact-home", "1", "0", "600 mm", "100 mm", "2/2", "2/2", "Valid · stageable"]);
    await expect(details.locator("[data-constraint-result]")).toHaveCount(4);
    expect(await details.locator("[data-constraint-result]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-constraint-id")))).toEqual(["c-door", "c-radiator", "c-window", "c-chair"]);
    for (const row of await details.locator("[data-constraint-result]").all()) {
      await row.scrollIntoViewIfNeeded(); await expect(row).toBeVisible();
      await containedInViewport(page.getByRole("button", { name: "Apply preview", exact: true }));
      await containedInViewport(page.getByRole("button", { name: "Discard preview", exact: true }));
    }
    const report = details.getByRole("region", { name: "Preview details content", exact: true, includeHidden: true });
    await expect(report).toHaveCount(1);
    await expect(report).toHaveAttribute("data-focus-key", "review:content");
    await expect(report).toHaveAttribute("tabindex", "0");
    const disclosure = details.locator(":scope > summary");
    await disclosure.focus(); await page.keyboard.press("Tab");
    await expect(report).toBeFocused();
    await page.keyboard.press("Home");
    await expect.poll(() => report.evaluate(node => node.scrollTop)).toBe(0);
    expect(await report.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await page.keyboard.press("End");
    await expect.poll(() => report.evaluate(node => node.scrollTop > 0 && node.scrollTop + node.clientHeight >= node.scrollHeight - 1)).toBe(true);
    const finalReportField = report.locator("[data-preview-issues]");
    await expect(finalReportField).toHaveCount(1); await expect(finalReportField).toHaveText("Issues: none");
    const lastFieldVisible = await finalReportField.evaluate(node => {
      const field = node.getBoundingClientRect(), region = node.closest('[data-focus-key="review:content"]')!.getBoundingClientRect();
      return field.top >= region.top - 1 && field.bottom <= region.bottom + 1;
    });
    expect(lastFieldVisible, "Keyboard End must reveal the retained last report field inside the scrolling region").toBe(true);
    await disclosure.focus(); await page.keyboard.press("Enter");
    await expect(details).toHaveJSProperty("open", false); await expect(report).not.toBeVisible();
    await page.keyboard.press("Tab"); await expect(report).not.toBeFocused();
    expect(await report.evaluate(node => node.contains(document.activeElement))).toBe(false);
    await disclosure.focus(); await page.keyboard.press("Enter");
    await expect(details).toHaveJSProperty("open", true);
    expect(await inspect(page)).toEqual(pending); expect(await storage(page)).toEqual(saved);
    await page.getByRole("button", { name: "Discard preview", exact: true }).click();
    expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
  test(`POLISH-03/04 ${viewport.width}px has complete keyboard sequences and deterministic panel focus return`, async ({ page }) => {
    await page.setViewportSize(viewport); await open(page); await setView(page, "precision-2d");
    const before = await inspect(page), saved = await storage(page);
    await expectCompactFocusOrder(page, "properties");
    await selectFurniture(page, "chair-main");
    await expectCompactFocusOrder(page, "properties", true);
    await openSection(page, "room");
    await expectCompactFocusOrder(page, "properties", true, true);
    for (const panel of ["add", "fit"] as const) {
      await openPanel(page, panel);
      await expectCompactFocusOrder(page, panel);
      if (panel === "fit") await expect(page.locator('[data-focus-key="fit:cancel"]')).toBeDisabled();
    }
    for (const [panel, name] of [["properties", "Properties"], ["add", "Add furniture"], ["fit", "Make it Fit"]] as const) {
      const target = await openPanel(page, panel), trigger = page.locator(`[data-panel-toggle="${panel}"]`);
      const close = target.getByRole("button", { name: `Close ${name}`, exact: true });
      await close.focus(); await page.keyboard.press("Enter");
      await expect(trigger).toBeFocused(); await expect(trigger).toHaveAttribute("aria-expanded", "false"); await expect(target).not.toBeVisible();
      await page.keyboard.press("Enter"); await expect(target).toBeVisible();
      await close.focus(); await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused(); await expect(trigger).toHaveAttribute("aria-expanded", "false"); await expect(target).not.toBeVisible();
    }
    expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved); await noPageOverflow(page);
  });
}

test("POLISH-04 the complete expanded Properties keyboard path reaches every room, feature and constraint control", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await open(page); await setView(page, "precision-2d"); await selectFurniture(page, "chair-main");
  for (const section of ["room", "features", "constraints"] as const) await openSection(page, section);
  const before = await inspect(page), saved = await storage(page);
  await expectCompactFocusOrder(page, "properties", true, "all");
  await page.keyboard.press("Enter");
  await expect(page.locator('details[data-workspace-section="layout-data"]')).toHaveJSProperty("open", true);
  await expect(page.locator("[data-layout-table] [data-table-item-id]")).toHaveCount(3);
  expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
});

test("POLISH-04 view-only navigation preserves panel/canvas/form identities and drafts; Inspect/Validate are UI-pure", async ({ page }) => {
  const canvas = await open(page), canvasHandle = await canvas.elementHandle();
  const before = await inspect(page), saved = await storage(page);
  const panels = await page.locator("[data-workspace-panel]").elementHandles(); expect(panels).toHaveLength(3);
  const form = await selectFurniture(page, "chair-main"), formHandle = await form.elementHandle();
  await form.getByRole("spinbutton", { name: "X position (mm)", exact: true }).fill("1900");
  await openSection(page, "room"); await page.locator('[data-focus-key="room:width"]').fill("3700");
  await openPanel(page, "fit");
  const fit = page.locator("[data-fit-panel]"), fitHandle = await fit.elementHandle();
  await fit.getByLabel("Fit room width (mm)", { exact: true }).fill("3400");
  await fit.getByLabel("Furniture to request", { exact: true }).selectOption("chair-600x600");
  await fit.getByRole("button", { name: "Request furniture", exact: true }).click();
  const requested = await fit.locator("[data-fit-request-id]").getAttribute("data-fit-request-id"); expect(requested).toBeTruthy();
  await openPanel(page, "add"); await page.getByRole("combobox", { name: "Add furniture", exact: true }).selectOption("bed-2000x1600");
  for (const panel of ["properties", "fit", "add", "properties"] as const) await openPanel(page, panel);
  await expect(form.getByRole("spinbutton", { name: "X position (mm)", exact: true })).toHaveValue("1900");
  await expect(page.locator('[data-focus-key="room:width"]')).toHaveValue("3700");
  expect(await formHandle!.evaluate(node => node === document.querySelector("form[data-geometry-row]"))).toBe(true);
  expect(await fitHandle!.evaluate(node => node === document.querySelector("[data-fit-panel]"))).toBe(true);
  expect(await canvasHandle!.evaluate(node => node === document.querySelector("canvas[data-spatial-canvas]"))).toBe(true);
  for (const panel of panels) expect(await panel.evaluate(node => node.isConnected && node === document.querySelector(`[data-workspace-panel="${(node as Element).getAttribute("data-workspace-panel")}"]`))).toBe(true);
  await openPanel(page, "fit");
  await expect(fit.getByLabel("Fit room width (mm)", { exact: true })).toHaveValue("3400");
  await expect(fit.locator("[data-fit-request-id]")).toHaveAttribute("data-fit-request-id", requested!);
  await openPanel(page, "add"); await expect(page.getByRole("combobox", { name: "Add furniture", exact: true })).toHaveValue("bed-2000x1600");
  await page.locator('[data-panel-toggle="add"]').focus();
  const ui = await viewStamp(page);
  expect(await inspect(page)).toEqual(before); expect(await viewStamp(page)).toEqual(ui);
  await validate(page, before); expect(await viewStamp(page)).toEqual(ui);
  expect(await storage(page)).toEqual(saved);
  expect(ui.capabilityState).toBe("registered");
  expect(ui.capability).not.toMatch(/agent (?:connected|attached|thinking|working)|awaiting first invocation|heartbeat/i);
  for (const handle of [...panels, formHandle!, fitHandle!, canvasHandle!]) await handle.dispose();
});

test("POLISH-04 hiding and reopening Fit preserves an active real Worker until explicit Cancel", async ({ page }) => {
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  let delivered!: () => void; const finished = new Promise<void>(resolve => { delivered = resolve; });
  await page.route(/\/assets\/fit-worker-[^/]+\.js$/, async route => {
    const response = await route.fetch(); reached(); await held;
    try { await route.fulfill({ response }); }
    catch (error) { if (!(error instanceof Error) || !/closed|cancel|aborted|invalid interception/i.test(error.message)) throw error; }
    finally { delivered(); }
  });
  await open(page); const before = await inspect(page), saved = await storage(page);
  await openPanel(page, "fit");
  const fit = page.locator("[data-fit-panel]");
  await fit.getByLabel("Fit room width (mm)", { exact: true }).fill("4000");
  await fit.getByRole("button", { name: "Make it Fit", exact: true }).click();
  await entered;
  try {
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "RUNNING");
    for (const panel of ["add", "properties", "fit"] as const) await openPanel(page, panel);
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "RUNNING");
    await expect(fit.getByLabel("Fit room width (mm)", { exact: true })).toHaveValue("4000");
    const cancel = fit.getByRole("button", { name: "Cancel fit", exact: true });
    await expect(cancel).toBeEnabled(); await cancel.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "CANCELLED");
  } finally { release(); await finished; }
  await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "CANCELLED");
  await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0);
  expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
});

for (const width of [320, 390]) {
  test(`POLISH-03 ${width}px retains full request/proof/review text, target sizes and a readable scene`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => localStorage.setItem("elnuva:v1:template:home-office", JSON.stringify({ storageVersion: 1,
      templateId: "home-office", state: { schemaVersion: 1, templateId: "home-office", room: { widthMm: 2000, depthMm: 2000 }, furniture: [], features: [], constraints: [] } })));
    const canvas = await open(page); const before = await inspect(page), saved = await storage(page);
    const box = await canvas.boundingBox(); expect(box).not.toBeNull(); expect(box!.height).toBeGreaterThanOrEqual(240);
    await openPanel(page, "fit"); const fit = page.locator("[data-fit-panel]");
    for (const label of ["Fit room width (mm)", "Fit room depth (mm)"]) {
      const input = fit.getByLabel(label, { exact: true }); await expect(input).toHaveValue("2000");
      await input.scrollIntoViewIfNeeded(); await containedInViewport(input);
      expect(await input.evaluate(node => {
        const input = node as HTMLInputElement, style = getComputedStyle(input), box = input.getBoundingClientRect();
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) >= context.measureText(input.value).width;
      })).toBe(true);
    }
    await fit.getByLabel("Furniture to request", { exact: true }).selectOption("bed-2000x1600");
    await fit.getByRole("button", { name: "Request furniture", exact: true }).click();
    await fit.getByRole("button", { name: "Request furniture", exact: true }).click();
    const requests = fit.locator("[data-fit-request-id]"); await expect(requests).toHaveCount(2);
    const ids = await requests.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-fit-request-id")!));
    for (const request of await requests.all()) { await expect(request).toContainText(/2000.*1600/); await expect(request).toContainText("Requested — not placed"); }
    const visibleControls = page.locator("button, select, input:not([type=checkbox]), summary").filter({ visible: true });
    const expectedControlKeys = ["template:active", "layout:save", "layout:undo", "layout:reset", "view:isometric", "view:top", "view:precision-2d", "view:reset",
      "panel:properties", "panel:add", "panel:fit", "panel:fit:close", "section:fit", "fit:width", "fit:depth", "fit:catalog", "fit:request",
      `fit:remove:${ids[0]}`, `fit:remove:${ids[1]}`, "fit:start", "fit:cancel"];
    expect(await visibleControls.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus-key")))).toEqual(expectedControlKeys);
    for (const control of await visibleControls.all()) {
      const targetBox = await control.boundingBox(); expect(targetBox).not.toBeNull();
      expect(targetBox!.height, await control.getAttribute("data-focus-key") ?? await control.textContent() ?? "control").toBeGreaterThanOrEqual(44);
    }
    await fit.getByRole("button", { name: "Make it Fit", exact: true }).click();
    const status = fit.locator("[data-fit-status]");
    await expect(status).toHaveAttribute("data-fit-state", "PROVEN_IMPOSSIBLE", { timeout: 17000 });
    await expect(status).toContainText("No arrangement exists within this 2D model and its required constraints.");
    await status.scrollIntoViewIfNeeded(); await expect(status).toBeVisible();
    expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
    await fit.getByRole("button", { name: `Remove request ${ids[1]}`, exact: true }).click();
    await expect(requests).toHaveCount(1);
    await fit.getByRole("button", { name: "Make it Fit", exact: true }).click();
    await expect(status).toHaveAttribute("data-fit-state", "FOUND", { timeout: 17000 });
    const pending = await inspect(page); expect(pending.workingState).toEqual(before.workingState);
    expect(pending.baseRevision).toBe(before.baseRevision); expect(pending.baseHash).toBe(before.baseHash); expect(await storage(page)).toEqual(saved);
    const details = await openReviewDetails(page);
    await expect(details).toContainText(/Original room 2000.*2000 mm.*Target room 2000.*2000 mm/s);
    await expect(details).toContainText("1 requested additions"); await expect(details).toContainText(ids[0]);
    await expect(details).toContainText(/2000.*1600/); await expect(details).toContainText(/Required constraints: 0\/0.*Preferred constraints: 0\/0/s);
    await expect(details.locator(".preview-moves > li")).toHaveCount(1);
    await expect(details.locator(".preview-moves > li")).toContainText(new RegExp(ids[0]));
    await expect(details.locator(".preview-moves > li")).toContainText(/2000.*1600.*\d+, \d+ mm.*(?:0|90|180|270)°/);
    await expect(details.locator(".preview-metrics")).toHaveCount(0);
    const targets = details.locator("p, h3, li"); expect(await targets.count()).toBeGreaterThanOrEqual(7);
    for (const target of await targets.all()) {
      await target.scrollIntoViewIfNeeded(); await expect(target).toBeVisible();
      const issues = await target.evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const fragments = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
        const issues: string[] = [];
        if (!fragments.length) issues.push("No rendered text fragments");
        for (const fragment of fragments) if (fragment.left < -0.5 || fragment.right > innerWidth + 0.5) issues.push(`Clipped text: ${node.textContent}`);
        return issues;
      });
      expect(issues).toEqual([]);
    }
    for (const name of ["Apply preview", "Discard preview"]) {
      const button = page.getByRole("button", { name, exact: true }); await button.focus(); await expect(button).toBeFocused();
      await containedInViewport(button); expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await noPageOverflow(page);
    await page.getByRole("button", { name: "Discard preview", exact: true }).click();
    expect(await inspect(page)).toEqual(before); expect(await storage(page)).toEqual(saved);
  });
}
