import { describe, expect, it } from "vitest";
import { TEMPLATE_IDS, createFactoryState } from "../../src/domain/templates";

describe("three editable template factories", () => {
  it("returns exact isolated factory working states", () => {
    expect(TEMPLATE_IDS).toStrictEqual(["home-office", "bedroom", "study"]);
    expect(createFactoryState("home-office")).toMatchObject({ schemaVersion: 1, templateId: "home-office", room: { widthMm: 3600, depthMm: 3000 }, features: [{ id: "door-main" }, { id: "radiator-east" }, { id: "window-north" }], furniture: [{ id: "chair-main" }, { id: "desk-main" }, { id: "storage-main", locked: true }], constraints: [{ constraintId: "c-door" }, { constraintId: "c-radiator" }, { constraintId: "c-window" }, { constraintId: "c-chair" }] });
    expect(createFactoryState("bedroom")).toMatchObject({ schemaVersion: 1, templateId: "bedroom", room: { widthMm: 4200, depthMm: 3600 }, features: [{ id: "door-south" }, { id: "radiator-north" }, { id: "window-east" }], furniture: [{ id: "bed-main" }, { id: "nightstand-main" }, { id: "wardrobe-main", locked: true }] });
    expect(createFactoryState("study")).toMatchObject({ schemaVersion: 1, templateId: "study", room: { widthMm: 3200, depthMm: 2800 }, features: [{ id: "door-north" }, { id: "radiator-west" }, { id: "window-south" }], furniture: [{ id: "bookcase-main", locked: true }, { id: "chair-main" }, { id: "table-main" }] });
    const first = createFactoryState("home-office") as any; first.room.widthMm = 9999; first.furniture[0].xMm = 1; first.constraints.reverse();
    expect(createFactoryState("home-office").room.widthMm).toBe(3600);
    expect(createFactoryState("home-office").furniture[0].xMm).toBe(2500);
    expect(createFactoryState("home-office").constraints[0].constraintId).toBe("c-door");
  });
});
