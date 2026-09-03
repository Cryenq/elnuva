import { expect, test, type Page } from "@playwright/test";
import { openWorkspace, preparePrecisionWorkspace, selectFurniture, openSection, setView, expectPendingMutationControls } from "./workspace-helpers";

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

async function expectReadablePreviewMetrics(page: Page): Promise<void> {
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
  expect(geometry.columns).toBeGreaterThanOrEqual(1); // Layout is flexible; every exact pair above must fit.
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
    await openWorkspace(page);
    await stageHome(page);
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toBeVisible();
    await expectReadablePreviewMetrics(page);
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
    await openWorkspace(page);
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
    await openWorkspace(page);
    const template = page.getByRole("combobox", { name: "Room template" });
    await selectFurniture(page, "chair-main");
    // Measure every actual workspace card, including the catalog/scene rail.
    const cards = page.locator("[data-workspace] > .card");
    await expect(cards).toHaveCount(3);
    const cardOrder = await cards.evaluateAll(nodes => nodes.map(node => {
      const roles = ["layout-card", "controls-card", "details-card"].filter(name => node.classList.contains(name));
      if (roles.length !== 1) throw new Error("Workspace card must have exactly one known role");
      const box = node.getBoundingClientRect();
      return { role: roles[0], top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    }));
    expect(cardOrder.map(card => card.role)).toEqual(["layout-card", "controls-card", "details-card"]);
    expect([...cardOrder].sort((a, b) => a.top - b.top).map(card => card.role)).toEqual(cardOrder.map(card => card.role));
    for (const card of cardOrder) {
      expect(card.width).toBeGreaterThan(0);
      expect(card.height).toBeGreaterThan(0);
    }
    expect(cardOrder[0].bottom).toBeLessThanOrEqual(cardOrder[1].top);
    expect(cardOrder[1].bottom).toBeLessThanOrEqual(cardOrder[2].top);
    await expect(cards.nth(0).locator("svg[data-room-editor]")).toHaveCount(1);
    await expect(cards.nth(1).getByRole("combobox", { name: "Add furniture", exact: true })).toHaveCount(1);
    await expect(cards.nth(1).locator("[data-scene-item-list]")).toHaveCount(1);
    await expect(cards.nth(1).locator("[data-spatial-item-id]")).toHaveCount(3);
    await expect(cards.nth(2).locator('form[data-geometry-row][data-item-id="chair-main"]')).toHaveCount(1);
    await expect(cards.nth(2).locator("details[data-workspace-section]")).toHaveCount(4);
    // Close disclosures via their real controls so the complete cross-card tab
    // sequence is explicit and stable, rather than accepting any visible focus.
    for (const section of ["room", "features", "constraints", "layout-data"]) {
      const disclosure = page.locator(`details[data-workspace-section="${section}"]`);
      await expect(disclosure).toHaveJSProperty("open", true);
      await disclosure.locator(":scope > summary").click();
      await expect(disclosure).toHaveJSProperty("open", false);
    }
    await expect(page.locator('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveCount(0);
    await template.focus();
    await expect(template).toBeFocused();
    const expectedFocusKeys = [
      "layout:save", "layout:undo", "layout:reset",
      "view:isometric", "view:top", "view:precision-2d", "view:reset",
      "plan:furniture:chair-main", "plan:furniture:desk-main", "plan:furniture:storage-main",
      "furniture:catalog", "furniture:add",
      "scene:chair-main", "scene:desk-main", "scene:storage-main",
      "furniture:chair-main:xMm", "furniture:chair-main:yMm", "furniture:chair-main:rotationDeg",
      "furniture:chair-main:lock", "furniture:chair-main:rotate", "furniture:chair-main:update", "furniture:chair-main:delete",
      "section:room", "section:features", "section:constraints", "section:layout-data",
    ];
    for (const key of expectedFocusKeys) {
      const target = page.locator(`[data-focus-key="${key}"]`);
      await expect(target).toHaveCount(1);
      await page.keyboard.press("Tab");
      await expect(target, `Tab must reach ${key} in workspace DOM/visual order`).toBeFocused();
      await expect(target).toBeVisible();
    }
    await page.keyboard.press("Enter");
    await expect(page.locator('details[data-workspace-section="layout-data"]')).toHaveJSProperty("open", true);
    await expect(page.locator("[data-layout-table]")).toBeVisible();
  });

  test(`${viewport.width}px keeps expanded preview review and human controls visible without overflow`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`page: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await installCapture(page);
    await page.setViewportSize(viewport);
    await openWorkspace(page);
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

const furnitureFormSelector = "form.geometry-row[data-geometry-row][data-item-id]";
const furnitureFactories = {
  "home-office": [
    ["chair-main", "2500", "1300", false],
    ["desk-main", "2500", "500", false],
    ["storage-main", "700", "600", true],
  ],
  bedroom: [
    ["bed-main", "2300", "2400", false],
    ["nightstand-main", "3550", "2500", false],
    ["wardrobe-main", "700", "700", true],
  ],
  study: [
    ["bookcase-main", "2700", "2300", true],
    ["chair-main", "2000", "1600", false],
    ["table-main", "2000", "900", false],
  ],
} as const;

async function furnitureReadabilityViolations(page: Page): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page.locator(furnitureFormSelector).evaluateAll(forms => {
    const tolerance = 0.5; // Subpixel rounding only, not clipped letters.
    const rect = (value: DOMRect) => ({
      left: value.left, right: value.right, top: value.top, bottom: value.bottom,
      width: value.width, height: value.height,
    });
    type Box = ReturnType<typeof rect>;
    const contained = (inner: Box, outer: Box) =>
      inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance &&
      inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
    const overlaps = (a: Box, b: Box) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
    const violations: string[] = [];
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) throw new Error("Canvas text measurement is unavailable");
    for (const form of forms) {
      const id = form.getAttribute("data-item-id")!;
      const formBox = rect(form.getBoundingClientRect());
      const inspectorBox = rect(form.closest(".inspector")!.getBoundingClientRect());
      const cells = Array.from(form.querySelectorAll(":scope > label, :scope > button"), element => ({
        element, name: element.textContent!.trim(), box: rect(element.getBoundingClientRect()),
      }));
      const runs: { name: string; box: Box }[] = [];
      const inputs: { name: string; box: Box }[] = [];
      const checkBounds = (name: string, box: Box, boundaries: readonly (readonly [string, Box])[]) => {
        if (box.width <= 0 || box.height <= 0) violations.push(`${id} ${name} has empty bounds`);
        for (const [boundary, outer] of boundaries) {
          if (!contained(box, outer)) {
            violations.push(`${id} ${name} escapes ${boundary}: ${JSON.stringify({ box, outer })}`);
          }
        }
        if (box.left < -tolerance || box.right > document.documentElement.clientWidth + tolerance) {
          violations.push(`${id} ${name} is horizontally clipped by the viewport`);
        }
      };
      for (const [index, cell] of cells.entries()) {
        checkBounds(cell.name, cell.box, [["furniture form", formBox], ["inspector", inspectorBox]]);
        for (const neighbor of cells.slice(index + 1)) {
          if (overlaps(cell.box, neighbor.box)) violations.push(`${id} ${cell.name} overlaps ${neighbor.name}`);
        }
        // Range fragments measure each wrapped line, including direct label text
        // and every button text node. Input .value is not a DOM text fragment.
        const walker = document.createTreeWalker(cell.element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        let fragmentCount = 0;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const fragment of Array.from(range.getClientRects(), rect)) {
            fragmentCount += 1;
            checkBounds(`${cell.name} text`, fragment, [
              ["label/button", cell.box], ["furniture form", formBox], ["inspector", inspectorBox],
            ]);
            for (const neighbor of cells) {
              if (neighbor !== cell && overlaps(fragment, neighbor.box)) {
                violations.push(`${id} ${cell.name} text overlaps neighboring ${neighbor.name}`);
              }
            }
            runs.push({ name: cell.name, box: fragment });
          }
        }
        if (!fragmentCount) violations.push(`${id} ${cell.name} has no rendered text fragments`);
        for (const input of cell.element.querySelectorAll("input")) {
          const box = rect(input.getBoundingClientRect());
          const name = input.getAttribute("aria-label")!;
          inputs.push({ name, box });
          checkBounds(`${name} input`, box, [
            ["own label", cell.box], ["furniture form", formBox], ["inspector", inspectorBox],
          ]);
          for (const neighbor of cells) {
            if (neighbor !== cell && overlaps(box, neighbor.box)) {
              violations.push(`${id} ${name} input overlaps neighboring ${neighbor.name}`);
            }
          }
          if (input.type === "number") {
            const style = getComputedStyle(input);
            const pixels = (value: string) => Number.parseFloat(value) || 0;
            const contentWidth = box.width - pixels(style.borderLeftWidth) - pixels(style.borderRightWidth) -
              pixels(style.paddingLeft) - pixels(style.paddingRight);
            canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            canvas.fontKerning = style.fontKerning as CanvasFontKerning;
            canvas.fontStretch = style.fontStretch as CanvasFontStretch;
            canvas.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
            const glyphWidth = canvas.measureText(input.value).width;
            // Necessary numeric-fit check; UA spin-button painting and actual
            // glyph visibility still require independent real-browser visual QA.
            if (!input.value || !Number.isFinite(glyphWidth) || glyphWidth <= 0 || contentWidth + tolerance < glyphWidth) {
              violations.push(`${id} ${name} value ${input.value} does not fit: ${JSON.stringify({ contentWidth, glyphWidth })}`);
            }
          }
        }
      }
      for (const [index, run] of runs.entries()) {
        for (const neighbor of runs.slice(index + 1)) {
          if (overlaps(run.box, neighbor.box)) violations.push(`${id} ${run.name} text overlaps ${neighbor.name} text`);
        }
        for (const input of inputs) {
          if (overlaps(run.box, input.box)) violations.push(`${id} ${run.name} text overlaps ${input.name} input`);
        }
      }
      for (const [index, input] of inputs.entries()) {
        for (const neighbor of inputs.slice(index + 1)) {
          if (overlaps(input.box, neighbor.box)) violations.push(`${id} ${input.name} input overlaps ${neighbor.name} input`);
        }
      }
    }
    return violations;
  });
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1051, height: 800 },
  { width: 1050, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const) {
  for (const templateId of ["home-office", "bedroom", "study"] as const) {
    test(`${viewport.width}x${viewport.height} ${templateId} furniture controls keep full text and numeric values readable`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(`page: ${error.message}`));
      page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
      await page.setViewportSize(viewport);
      await openWorkspace(page);
      await page.getByRole("combobox", { name: "Room template" }).selectOption(templateId);
      const items = page.locator("[data-scene-item-list] [data-spatial-item-id]");
      await expect(items).toHaveCount(3);
      expect(await items.evaluateAll(rows => rows.map(row => row.getAttribute("data-spatial-item-id"))))
        .toEqual(furnitureFactories[templateId].map(item => item[0]));
      const violations: string[] = [];
      for (const [id, xMm, yMm, locked] of furnitureFactories[templateId]) {
        const form = await selectFurniture(page, id);
        await form.scrollIntoViewIfNeeded();
        await expect(form.locator(":scope > label")).toHaveText(["X position (mm)", "Y position (mm)", "Rotation", " Locked"]);
        for (const name of ["Update furniture", "Delete furniture"]) await expect(form.getByRole("button", { name, exact: true })).toHaveCount(1);
        for (const [name, value] of [["X position (mm)", xMm], ["Y position (mm)", yMm], ["Rotation", "0"]]) {
          const input = form.getByRole("spinbutton", { name, exact: true });
          await expect(input).toBeVisible();
          await expect(input).toHaveValue(value);
          if (locked) await expect(input).toBeDisabled();
          else await expect(input).toBeEnabled();
        }
        const lock = form.getByRole("checkbox", { name: "Locked", exact: true });
        await expect(lock).toBeChecked({ checked: locked });
        await expect(lock).toBeEnabled();
        for (const name of ["Update furniture", "Delete furniture"]) {
          await expect(form.getByRole("button", { name, exact: true })).toBeVisible();
          if (locked) await expect(form.getByRole("button", { name, exact: true })).toBeDisabled();
          else await expect(form.getByRole("button", { name, exact: true })).toBeEnabled();
        }
        violations.push(...(await furnitureReadabilityViolations(page)).map(issue => `factory ${id}: ${issue}`));
      }
      if (templateId === "home-office") {
        const chair = await selectFurniture(page, "chair-main");
        const graphic = page.locator('[data-layer="furniture"] [data-furniture-id="chair-main"]');
        const tableCells = page.locator('[data-layout-table] [data-table-item-id="chair-main"] > td');
        await expect(graphic).toHaveAttribute("data-x-mm", "2500");
        await expect(graphic).toHaveAttribute("data-y-mm", "1300");
        await expect(tableCells).toHaveText(["Chair", "chair-main", "2500", "1300", "0°", "600 × 600", "Editable"]);
        await chair.getByRole("spinbutton", { name: "X position (mm)", exact: true }).fill("1900");
        await chair.getByRole("spinbutton", { name: "Y position (mm)", exact: true }).fill("1300");
        await chair.getByRole("button", { name: "Update furniture", exact: true }).click();
        await expect(chair.getByRole("spinbutton", { name: "X position (mm)", exact: true })).toHaveValue("1900");
        await expect(chair.getByRole("spinbutton", { name: "Y position (mm)", exact: true })).toHaveValue("1300");
        await expect(graphic).toHaveAttribute("data-x-mm", "1900");
        await expect(graphic).toHaveAttribute("data-y-mm", "1300");
        await expect(graphic.locator("rect")).toHaveAttribute("x", "1600");
        await expect(graphic.locator("rect")).toHaveAttribute("y", "1000");
        await expect(tableCells).toHaveText(["Chair", "chair-main", "1900", "1300", "0°", "600 × 600", "Editable"]);
        violations.push(...(await furnitureReadabilityViolations(page)).map(issue => `after numeric edit: ${issue}`));
      }
      expect(errors).toEqual([]);
      expect(violations, "Furniture labels, buttons, and complete numeric values must fit without overlap").toEqual([]);
    });
  }
}

const constraintFormSelector = ".constraints > form[data-constraint-row], form.add-constraint";
const constraintSelectSelector = ".constraints > form[data-constraint-row] select, form.add-constraint select";
type SelectOption = { value: string; text: string; disabled: boolean };
type SelectSnapshot = { key: string; label: string; value: string; options: SelectOption[] };

async function constraintSelectSnapshot(page: Page): Promise<SelectSnapshot[]> {
  return page.locator(constraintSelectSelector).evaluateAll(selects => selects.map(element => {
    const select = element as HTMLSelectElement;
    const label = select.closest("label")!;
    return {
      key: select.dataset.focusKey!,
      label: Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent).join("").trim(),
      value: select.value,
      options: Array.from(select.options, option => ({ value: option.value, text: option.text, disabled: option.disabled })),
    };
  }));
}

async function constraintControlViolations(page: Page): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page.locator(constraintFormSelector).evaluateAll(forms => {
    const tolerance = 0.5;
    const rect = (value: DOMRect) => ({
      left: value.left, right: value.right, top: value.top, bottom: value.bottom,
      width: value.width, height: value.height,
    });
    type Box = ReturnType<typeof rect>;
    const contained = (inner: Box, outer: Box) =>
      inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance &&
      inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
    const overlaps = (a: Box, b: Box) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
    const violations: string[] = [];
    const viewport = document.documentElement.clientWidth;
    // Root overflow is a separate assertion: body clipping must not conceal an
    // overflowing native select, even when its parent card has normal bounds.
    for (const [name, width] of [["document", document.documentElement.scrollWidth], ["body", document.body.scrollWidth]] as const) {
      if (width > viewport) violations.push(`${name} overflow: ${width}px exceeds ${viewport}px viewport`);
    }
    for (const form of forms) {
      const formBox = rect(form.getBoundingClientRect());
      const labels = Array.from(form.querySelectorAll("label"));
      const controls = Array.from(form.querySelectorAll("input, select, button"));
      for (const select of form.querySelectorAll("select")) {
        const key = select.dataset.focusKey!;
        const box = rect(select.getBoundingClientRect());
        const label = select.closest("label")!;
        const labelBox = rect(label.getBoundingClientRect());
        const boundaries: [string, Box][] = [["label", labelBox], ["form", formBox]];
        const references = select.closest(".constraint-references");
        if (references) boundaries.push(["reference grid", rect(references.getBoundingClientRect())]);
        if (box.width <= 0 || box.height <= 0) violations.push(`${key} has empty control bounds`);
        for (const [boundary, outer] of boundaries) {
          if (!contained(box, outer)) violations.push(`${key} select escapes ${boundary}: ${JSON.stringify({ box, outer })}`);
        }
        if (box.left < -tolerance || box.right > viewport + tolerance) {
          violations.push(`${key} select/arrow box is clipped by viewport: ${JSON.stringify({ box, viewport })}`);
        }
        for (const neighbor of labels) {
          if (neighbor !== label && overlaps(box, rect(neighbor.getBoundingClientRect()))) {
            violations.push(`${key} select overlaps sibling label ${neighbor.textContent!.trim()}`);
          }
        }
        for (const neighbor of controls) {
          if (neighbor !== select && overlaps(box, rect(neighbor.getBoundingClientRect()))) {
            violations.push(`${key} select overlaps sibling control ${neighbor.getAttribute("data-focus-key") ?? neighbor.tagName}`);
          }
        }
        // A closed native select may ellipsize its selected option. Measure the
        // whole control (including arrow), not popup options' unrendered text.
        for (const node of label.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const fragments = Array.from(range.getClientRects(), rect);
          if (!fragments.length) violations.push(`${key} has no visible label text fragments`);
          for (const fragment of fragments) {
            if (!contained(fragment, labelBox) || !contained(fragment, formBox)) {
              violations.push(`${key} label text escapes label/form: ${JSON.stringify({ fragment, labelBox, formBox })}`);
            }
            if (overlaps(fragment, box)) violations.push(`${key} label text overlaps its select`);
          }
        }
      }
    }
    return violations;
  });
}

const constraintFactories = {
  "home-office": { features: ["door-main", "radiator-east", "window-north"], anchor: "desk-main", neighbor: "chair-main", itemConstraint: "c-chair" },
  bedroom: { features: ["door-south", "radiator-north", "window-east"], anchor: "bed-main", neighbor: "nightstand-main", itemConstraint: "c-nightstand" },
  study: { features: ["door-north", "radiator-west", "window-south"], anchor: "table-main", neighbor: "chair-main", itemConstraint: "c-chair" },
} as const;

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1051, height: 800 },
  { width: 1050, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const) {
  for (const templateId of ["home-office", "bedroom", "study"] as const) {
    test(`${viewport.width}x${viewport.height} ${templateId} constraint selects stay contained with complete dynamic references`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(`page: ${error.message}`));
      page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
      if (templateId === "home-office") await installCapture(page);
      await page.setViewportSize(viewport);
      await openWorkspace(page);
      await page.getByRole("combobox", { name: "Room template" }).selectOption(templateId);
      await expect(page.locator(".constraints > form[data-constraint-row]")).toHaveCount(4);
      await expect(page.locator("form.add-constraint")).toHaveCount(1);
      const fixture = constraintFactories[templateId];
      const furnitureIds = furnitureFactories[templateId].map(item => item[0]);
      const options = (pairs: readonly (readonly [string, string])[]): SelectOption[] =>
        pairs.map(([value, text]) => ({ value, text, disabled: false }));
      const names: Record<string, string> = {
        chair: "Chair", desk: "Desk", storage: "Storage", bed: "Bed", nightstand: "Nightstand",
        wardrobe: "Wardrobe", bookcase: "Bookcase", table: "Table", door: "Door", radiator: "Radiator", window: "Window",
      };
      const referenceOptions = (ids: readonly string[]) => options(ids.map(id => [id, `${names[id.split("-")[0]]} · ${id}`]));
      const furniture = referenceOptions(furnitureIds);
      const features = referenceOptions(fixture.features);
      const doors = referenceOptions([fixture.features[0]]);
      const strength = options([["required", "Required"], ["preferred", "Preferred"]]);
      const relation = options([["near", "Keep near"], ["away", "Keep away"]]);
      const types = options([
        ["feature_distance", "Furniture to feature distance"], ["door_path_clear", "Door path clear"],
        ["item_distance", "Furniture to furniture distance"],
      ]);
      const control = (key: string, label: string, value: string, inventory: SelectOption[]): SelectSnapshot =>
        ({ key: `constraint:${key}`, label, value, options: inventory });
      const existing: SelectSnapshot[] = [
        control("c-door:strength", "Strength", "required", strength),
        control("c-door:feature", "Wall feature", fixture.features[0], doors),
        control("c-radiator:strength", "Strength", "required", strength),
        control("c-radiator:item", "Furniture item", fixture.anchor, furniture),
        control("c-radiator:feature", "Wall feature", fixture.features[1], features),
        control("c-radiator:relation", "Relation", "away", relation),
        control("c-window:strength", "Strength", "preferred", strength),
        control("c-window:item", "Furniture item", fixture.anchor, furniture),
        control("c-window:feature", "Wall feature", fixture.features[2], features),
        control("c-window:relation", "Relation", "near", relation),
        control(`${fixture.itemConstraint}:strength`, "Strength", "preferred", strength),
        control(`${fixture.itemConstraint}:item-a`, "First furniture item", fixture.neighbor, furniture),
        control(`${fixture.itemConstraint}:item-b`, "Second furniture item", fixture.anchor, furniture.filter(option => option.value !== fixture.neighbor)),
        control(`${fixture.itemConstraint}:relation`, "Relation", "near", relation),
      ];
      const newControls = (type: string): SelectSnapshot[] => [
        control("new:type", "Constraint type", type, types),
        ...(type === "door_path_clear"
          ? [control("new:feature", "Wall feature", fixture.features[0], doors)]
          : type === "feature_distance"
            ? [control("new:item", "Furniture item", furnitureIds[0], furniture), control("new:feature", "Wall feature", fixture.features[0], features)]
            : [control("new:item-a", "First furniture item", furnitureIds[0], furniture), control("new:item-b", "Second furniture item", furnitureIds[1], furniture.slice(1))]),
      ];
      const violations: string[] = [];
      const recordBounds = async (state: string) => {
        violations.push(...(await constraintControlViolations(page)).map(issue => `${state}: ${issue}`));
      };
      const type = page.locator('form.add-constraint select[data-focus-key="constraint:new:type"]');
      for (const [index, constraintType] of ["feature_distance", "door_path_clear", "item_distance"].entries()) {
        if (index > 0) {
          await type.focus();
          // Native type-ahead plus Tab commits selection without relying on
          // platform-specific popup-menu ArrowDown/Enter handling.
          await page.keyboard.press(index === 1 ? "d" : "f");
          await page.keyboard.press("Tab");
        }
        await expect(type).toHaveValue(constraintType);
        expect(await constraintSelectSnapshot(page)).toEqual([...existing, ...newControls(constraintType)]);
        for (const select of await page.locator(constraintSelectSelector).all()) {
          await expect(select).toBeVisible();
          await expect(select).toBeEnabled();
        }
        await recordBounds(`new ${constraintType}`);
      }
      const firstItem = page.locator('form.add-constraint select[data-new-constraint-reference="item-a"]');
      await firstItem.focus();
      await page.keyboard.press(names[furnitureIds[2].split("-")[0]][0].toLowerCase());
      await page.keyboard.press("Tab");
      await expect(firstItem).toHaveValue(furnitureIds[2]);
      expect(await constraintSelectSnapshot(page)).toEqual([...existing,
        control("new:type", "Constraint type", "item_distance", types),
        control("new:item-a", "First furniture item", furnitureIds[2], furniture),
        control("new:item-b", "Second furniture item", furnitureIds[1], furniture.slice(0, 2)),
      ]);
      await recordBounds("keyboard changed first furniture reference");
      const feature = page.locator('.constraints select[data-focus-key="constraint:c-window:feature"]');
      await feature.focus();
      await page.keyboard.press("d");
      await page.keyboard.press("Tab");
      await expect(feature).toHaveValue(fixture.features[0]);
      await feature.focus();
      await page.keyboard.press("r");
      await page.keyboard.press("Tab");
      await expect(feature).toHaveValue(fixture.features[1]);
      await feature.focus();
      await page.keyboard.press("w");
      await page.keyboard.press("Tab");
      await expect(feature).toHaveValue(fixture.features[2]);
      if (templateId === "home-office") {
        // Captured Stage verifies disabled UI state, not native/model discovery.
        await stageHome(page);
        await expect(page.locator("[data-preview-review]")).toBeVisible();
        expect(await constraintSelectSnapshot(page)).toEqual([...existing, ...newControls("feature_distance")]);
        for (const select of await page.locator(constraintSelectSelector).all()) await expect(select).toBeDisabled();
        await expect(page.getByRole("button", { name: "Add constraint", exact: true })).toBeDisabled();
        await recordBounds("pending preview");
        await page.getByRole("button", { name: "Discard preview", exact: true }).click();
        await expect(page.locator("[data-preview-review]")).toHaveCount(0);
        for (const select of await page.locator(constraintSelectSelector).all()) await expect(select).toBeEnabled();
        expect(await constraintSelectSnapshot(page)).toEqual([...existing, ...newControls("feature_distance")]);
        await recordBounds("after discard");
      }
      expect(errors).toEqual([]);
      expect(violations, "Constraint controls and arrow bounds must fit without sibling or root overflow").toEqual([]);
    });
  }
}
