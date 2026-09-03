import { furnitureCatalogById, featureCatalogById } from "../domain/catalog";
import { furnitureAabb } from "../domain/geometry";
import type { StoreSnapshot } from "../domain/store";

const ns = "http://www.w3.org/2000/svg";
const svg = (tag: string) => document.createElementNS(ns, tag);

export type RenderCallbacks = Readonly<{ select: (id: string) => void; drag: (event: PointerEvent, id: string, element: SVGGElement) => void }>;

export function roomSvg(snapshot: StoreSnapshot, selected: string | null, callbacks: RenderCallbacks): SVGSVGElement {
  const state = snapshot.workingState; const el = svg("svg") as SVGSVGElement;
  el.dataset.roomEditor = ""; el.setAttribute("role", "img"); el.setAttribute("aria-label", "Room layout editor");
  const description = svg("desc"); description.id = "room-layout-description"; description.textContent = `Interactive ${state.templateId === "home-office" ? "Home Office" : state.templateId === "bedroom" ? "Bedroom" : "Study"} plan, ${state.room.widthMm} by ${state.room.depthMm} millimetres. A matching data table follows the plan.`; el.setAttribute("aria-describedby", description.id); el.append(description);
  el.setAttribute("viewBox", `0 0 ${state.room.widthMm} ${state.room.depthMm}`); el.classList.add("room-editor");
  for (const layerName of ["grid", "features", "furniture", "constraints", "dimensions", "preview"]) { const g = svg("g"); g.dataset.layer = layerName; el.append(g); }
  const grid = el.querySelector('[data-layer="grid"]')!;
  const room = svg("rect"); room.setAttribute("width", String(state.room.widthMm)); room.setAttribute("height", String(state.room.depthMm)); room.classList.add("room-boundary"); grid.append(room);
  for (let x = 0; x <= state.room.widthMm; x += 500) { const l=svg("line"); l.setAttribute("x1",String(x));l.setAttribute("x2",String(x));l.setAttribute("y2",String(state.room.depthMm));l.classList.add("grid-line");grid.append(l); }
  for (let y = 0; y <= state.room.depthMm; y += 500) { const l=svg("line"); l.setAttribute("y1",String(y));l.setAttribute("x2",String(state.room.widthMm));l.setAttribute("y2",String(y));l.classList.add("grid-line");grid.append(l); }
  const features = el.querySelector('[data-layer="features"]')!;
  for (const feature of state.features) { const entry=featureCatalogById(feature.catalogId)!; const r=svg("rect"); r.dataset.featureId=feature.id; r.classList.add(`feature-${entry.type}`); let x=0,y=0,w=0,h=0;
    if(feature.wall==="north"||feature.wall==="south"){x=feature.offsetMm;w=entry.spanMm;y=feature.wall==="north"?0:state.room.depthMm-Math.max(20,entry.depthMm);h=Math.max(20,entry.depthMm)} else {y=feature.offsetMm;h=entry.spanMm;x=feature.wall==="west"?0:state.room.widthMm-Math.max(20,entry.depthMm);w=Math.max(20,entry.depthMm)}
    r.setAttribute("x",String(x));r.setAttribute("y",String(y));r.setAttribute("width",String(w));r.setAttribute("height",String(h)); features.append(r); }
  const furniture = el.querySelector('[data-layer="furniture"]')!;
  for (const item of state.furniture) { const entry=furnitureCatalogById(item.catalogId)!; const box=furnitureAabb(item); const g=svg("g") as SVGGElement; g.dataset.furnitureId=item.id; g.dataset.xMm=String(item.xMm);g.dataset.yMm=String(item.yMm);g.dataset.rotationDeg=String(item.rotationDeg);g.dataset.locked=String(item.locked);g.setAttribute("role","button");g.setAttribute("tabindex","0");g.setAttribute("aria-label",entry.label);g.setAttribute("aria-pressed",String(selected===item.id));g.classList.toggle("selected",selected===item.id);g.classList.toggle("locked",item.locked);
    const r=svg("rect");r.setAttribute("x",String(box.left2/2));r.setAttribute("y",String(box.top2/2));r.setAttribute("width",String((box.right2-box.left2)/2));r.setAttribute("height",String((box.bottom2-box.top2)/2));g.append(r); const t=svg("text");t.setAttribute("x",String(item.xMm));t.setAttribute("y",String(item.yMm));t.textContent=entry.label;g.append(t);
    g.setAttribute("aria-description",`${item.id}, x ${item.xMm} millimetres, y ${item.yMm} millimetres, rotation ${item.rotationDeg} degrees, ${item.locked ? "locked" : "unlocked"}`); g.addEventListener("click",()=>callbacks.select(item.id)); g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();callbacks.select(item.id);}}); if(!item.locked) g.addEventListener("pointerdown",e=>callbacks.drag(e,item.id,g)); furniture.append(g); }
  const dimensions=el.querySelector('[data-layer="dimensions"]')!; const text=svg("text");text.setAttribute("x","25");text.setAttribute("y","55");text.textContent=`${state.room.widthMm} × ${state.room.depthMm} mm`;dimensions.append(text);
  const previewLayer = el.querySelector('[data-layer="preview"]')!;
  if (snapshot.preview) {
    for (const item of snapshot.preview.projectedFurniture) {
      const current = state.furniture.find(candidate => candidate.id === item.id);
      if (!current || (current.xMm === item.xMm && current.yMm === item.yMm && current.rotationDeg === item.rotationDeg)) continue;
      const entry = furnitureCatalogById(item.catalogId)!;
      const box = furnitureAabb(item);
      const ghost = svg("g") as SVGGElement;
      ghost.dataset.previewItemId = item.id;
      ghost.dataset.xMm = String(item.xMm);
      ghost.dataset.yMm = String(item.yMm);
      ghost.dataset.rotationDeg = String(item.rotationDeg);
      ghost.classList.add("preview-ghost");
      ghost.setAttribute("role", "img");
      ghost.setAttribute("aria-label", `Preview ghost: ${entry.label}; not applied`);
      const title = svg("title");
      title.textContent = `Preview ghost: ${entry.label}; not applied`;
      ghost.append(title);
      const rect = svg("rect");
      rect.setAttribute("x", String(box.left2 / 2)); rect.setAttribute("y", String(box.top2 / 2));
      rect.setAttribute("width", String((box.right2 - box.left2) / 2)); rect.setAttribute("height", String((box.bottom2 - box.top2) / 2));
      ghost.append(rect);
      const label = svg("text"); label.setAttribute("x", String(item.xMm)); label.setAttribute("y", String(item.yMm)); label.textContent = `Preview: ${entry.label}`; ghost.append(label);
      previewLayer.append(ghost);
    }
  }
  return el;
}
