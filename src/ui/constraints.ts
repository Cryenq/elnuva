import { featureCatalogById, furnitureCatalogById } from "../domain/catalog";
import type { StoreSnapshot } from "../domain/store";
import type { Constraint } from "../domain/types";

export type ConstraintCallbacks = Readonly<{
  update: (id: string, value: Constraint) => void;
  remove: (id: string) => void;
}>;

const keyed = <T extends HTMLElement>(node: T, key: string): T => {
  node.dataset.focusKey = key;
  return node;
};

function selectLabel(
  text: string,
  values: readonly Readonly<{ id: string; label: string }>[],
  selected: string,
  disabled: boolean,
  focusKey: string,
  reference: string,
): Readonly<{ label: HTMLLabelElement; select: HTMLSelectElement }> {
  const label = document.createElement("label");
  label.textContent = text;
  const select = keyed(document.createElement("select"), focusKey);
  select.dataset.constraintReference = reference;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value.id;
    option.textContent = value.label;
    select.append(option);
  }
  select.value = selected;
  select.disabled = disabled;
  label.append(select);
  return { label, select };
}

export function constraintsList(snapshot: StoreSnapshot, callbacks: ConstraintCallbacks): HTMLElement {
  const section = document.createElement("section");
  section.className = "constraints panel-section";
  section.dataset.constraintList = "";
  section.setAttribute("aria-labelledby", "constraints-heading");
  const heading = document.createElement("h2");
  heading.id = "constraints-heading";
  heading.textContent = "Constraints";
  section.append(heading);
  const help = document.createElement("p");
  help.className = "section-help";
  help.textContent = "Required constraints must pass; preferred constraints guide ranking.";
  section.append(help);
  if (snapshot.workingState.constraints.length === 0) {
    section.append(Object.assign(document.createElement("p"), { textContent: "No constraints in this layout." }));
  }

  const disabled = !!snapshot.preview;
  const furniture = snapshot.workingState.furniture.map((item) => ({
    id: item.id,
    label: `${furnitureCatalogById(item.catalogId)?.label ?? item.id} · ${item.id}`,
  }));
  const features = snapshot.workingState.features.map((feature) => ({
    id: feature.id,
    label: `${featureCatalogById(feature.catalogId)?.label ?? feature.id} · ${feature.id}`,
  }));
  const doors = snapshot.workingState.features
    .filter((feature) => featureCatalogById(feature.catalogId)?.type === "door")
    .map((feature) => ({
      id: feature.id,
      label: `${featureCatalogById(feature.catalogId)?.label ?? feature.id} · ${feature.id}`,
    }));

  for (const constraint of snapshot.workingState.constraints) {
    const form = document.createElement("form");
    form.className = "constraint-row";
    form.dataset.constraintId = constraint.constraintId;
    form.dataset.constraintRow = "";
    const title = document.createElement("h3");
    title.textContent = `${constraint.constraintId} · ${constraint.type.replaceAll("_", " ")} · ${constraint.strength} · ${constraint.type === "door_path_clear" ? constraint.widthMm : constraint.thresholdMm} mm`;
    form.append(title);

    const strengthLabel = document.createElement("label");
    strengthLabel.textContent = "Strength";
    const strength = keyed(document.createElement("select"), `constraint:${constraint.constraintId}:strength`);
    for (const value of ["required", "preferred"]) {
      strength.append(Object.assign(document.createElement("option"), {
        value,
        textContent: value[0].toUpperCase() + value.slice(1),
      }));
    }
    strength.value = constraint.strength;
    strength.disabled = disabled;
    strengthLabel.append(strength);
    form.append(strengthLabel);

    let featureReference: HTMLSelectElement | null = null;
    let itemReference: HTMLSelectElement | null = null;
    let itemAReference: HTMLSelectElement | null = null;
    let itemBReference: HTMLSelectElement | null = null;

    if (constraint.type === "door_path_clear") {
      const control = selectLabel(
        "Wall feature",
        doors,
        constraint.featureId,
        disabled,
        `constraint:${constraint.constraintId}:feature`,
        "feature",
      );
      featureReference = control.select;
      form.append(control.label);
    } else if (constraint.type === "feature_distance") {
      const itemControl = selectLabel(
        "Furniture item",
        furniture,
        constraint.itemId,
        disabled,
        `constraint:${constraint.constraintId}:item`,
        "item",
      );
      const featureControl = selectLabel(
        "Wall feature",
        features,
        constraint.featureId,
        disabled,
        `constraint:${constraint.constraintId}:feature`,
        "feature",
      );
      itemReference = itemControl.select;
      featureReference = featureControl.select;
      form.append(itemControl.label, featureControl.label);
    } else {
      const itemAControl = selectLabel(
        "First furniture item",
        furniture,
        constraint.itemAId,
        disabled,
        `constraint:${constraint.constraintId}:item-a`,
        "item-a",
      );
      const itemBControl = selectLabel(
        "Second furniture item",
        furniture.filter((item) => item.id !== constraint.itemAId),
        constraint.itemBId,
        disabled,
        `constraint:${constraint.constraintId}:item-b`,
        "item-b",
      );
      itemAReference = itemAControl.select;
      itemBReference = itemBControl.select;
      const populateSecondReference = (preferred: string): void => {
        const candidates = furniture.filter((item) => item.id !== itemAControl.select.value);
        itemBControl.select.replaceChildren();
        for (const candidate of candidates) {
          const option = document.createElement("option");
          option.value = candidate.id;
          option.textContent = candidate.label;
          itemBControl.select.append(option);
        }
        itemBControl.select.value = candidates.some((candidate) => candidate.id === preferred)
          ? preferred
          : candidates[0]?.id ?? "";
      };
      itemAControl.select.addEventListener("change", () => populateSecondReference(itemBControl.select.value));
      form.append(itemAControl.label, itemBControl.label);
    }

    const valueLabel = document.createElement("label");
    const value = keyed(document.createElement("input"), `constraint:${constraint.constraintId}:amount`);
    value.type = "number";
    value.step = "1";
    value.disabled = disabled;
    if (constraint.type === "door_path_clear") {
      valueLabel.textContent = "Clear width (mm)";
      value.min = "500";
      value.max = "1600";
      value.value = String(constraint.widthMm);
    } else {
      valueLabel.textContent = "Distance threshold (mm)";
      value.min = "0";
      value.max = "4000";
      value.value = String(constraint.thresholdMm);
    }
    value.setAttribute("aria-label", valueLabel.textContent);
    valueLabel.append(value);
    form.append(valueLabel);

    const distanceConstraint = constraint.type === "door_path_clear" ? null : constraint;
    const relation = distanceConstraint
      ? keyed(document.createElement("select"), `constraint:${constraint.constraintId}:relation`)
      : null;
    if (relation && distanceConstraint) {
      const relationLabel = document.createElement("label");
      relationLabel.textContent = "Relation";
      relation.append(
        Object.assign(document.createElement("option"), { value: "near", textContent: "Keep near" }),
        Object.assign(document.createElement("option"), { value: "away", textContent: "Keep away" }),
      );
      relation.value = distanceConstraint.relation;
      relation.disabled = disabled;
      relationLabel.append(relation);
      form.append(relationLabel);
    }

    const update = keyed(document.createElement("button"), `constraint:${constraint.constraintId}:update`);
    update.type = "submit";
    update.textContent = "Update constraint";
    update.disabled = disabled;
    const remove = keyed(document.createElement("button"), `constraint:${constraint.constraintId}:delete`);
    remove.type = "button";
    remove.textContent = "Delete constraint";
    remove.disabled = disabled;
    remove.dataset.deleteConstraint = constraint.constraintId;
    remove.addEventListener("click", () => callbacks.remove(constraint.constraintId));
    form.append(update, remove);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const amount = Number(value.value);
      const nextStrength = strength.value as Constraint["strength"];
      if (constraint.type === "door_path_clear") {
        callbacks.update(constraint.constraintId, {
          ...constraint,
          strength: nextStrength,
          featureId: featureReference!.value,
          widthMm: amount,
        });
      } else if (constraint.type === "feature_distance") {
        callbacks.update(constraint.constraintId, {
          ...constraint,
          strength: nextStrength,
          itemId: itemReference!.value,
          featureId: featureReference!.value,
          relation: relation!.value as "near" | "away",
          thresholdMm: amount,
        });
      } else {
        callbacks.update(constraint.constraintId, {
          ...constraint,
          strength: nextStrength,
          itemAId: itemAReference!.value,
          itemBId: itemBReference!.value,
          relation: relation!.value as "near" | "away",
          thresholdMm: amount,
        });
      }
    });
    section.append(form);
  }
  return section;
}
