import { DomainStore, type StoreSnapshot } from "./domain/store";
import { placementValid } from "./domain/geometry";
import { FEATURE_CATALOG, FURNITURE_CATALOG, LIMITS, furnitureCatalogById, featureCatalogById } from "./domain/catalog";
import type { Constraint, Feature, Furniture, FurnitureCatalogId, InspectSpatialLayoutData, RotationDeg, TemplateId, Wall } from "./domain/types";
import { roomSvg } from "./ui/render";
import { startDrag } from "./ui/svg-editor";
import { inspector } from "./ui/inspector";
import { constraintsList } from "./ui/constraints";
import { reviewPanel } from "./ui/review";
import { createWorkspaceShell } from "./ui/workspace-shell";
import { mountSpatialView } from "./ui/spatial-view";
import type { SpatialAvailability, SpatialPoseRequest, SpatialViewHandle, SpatialViewMode, SpatialViewState } from "./ui/spatial-view-contract";

type CapabilityState="checking"|"registered"|"unavailable"|"failed";
export type AppView=Readonly<{setCapabilityStatus:(state:CapabilityState,message:string)=>void;teardown:()=>void}>;
const names:Record<TemplateId,string>={"home-office":"Home Office",bedroom:"Bedroom",study:"Study"};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=document.createElement(tag);node.textContent=text??"";return node};
const resultMessage=(label:string,result:ReturnType<DomainStore["save"]>)=>result.ok?`${label} complete.`:result.error.message;
const whole=(value:string)=>/^-?\d+$/.test(value);
const nextId=(prefix:string,ids:readonly string[])=>{for(let index=1;index<100;index+=1){const id=`${prefix}-${index}`;if(!ids.includes(id))return id}return `${prefix}-99`};
const keyed=<T extends HTMLElement|SVGElement>(node:T,key:string):T=>{node.setAttribute("data-focus-key",key);return node};
const activeFocusKey=(root:HTMLElement):string|null=>{const active=document.activeElement;if(!active||!root.contains(active))return null;return active.getAttribute("data-focus-key")};
const restoreFocus=(root:HTMLElement,key:string|null,preview:boolean):void=>{if(!key)return;const elements=Array.from(root.querySelectorAll<HTMLElement|SVGElement>("[data-focus-key]"));let target=elements.find(node=>node.getAttribute("data-focus-key")===key);if((!target||target.matches(":disabled"))&&preview)target=elements.find(node=>node.getAttribute("data-focus-key")==="preview:apply");if(!target||target.matches(":disabled"))target=elements.find(node=>node.getAttribute("data-focus-key")==="status:editor");if(!target||target.matches(":disabled"))return;const focus=(target as Element&{focus?:(options?:FocusOptions)=>void}).focus;if(focus)focus.call(target,{preventScroll:true})};
const tagInspectorFocus=(section:HTMLElement):HTMLElement=>{if(typeof section.querySelectorAll!=="function")return section;for(const row of Array.from(section.querySelectorAll<HTMLElement>("[data-geometry-row][data-item-id]"))){const id=row.dataset.itemId!;for(const input of Array.from(row.querySelectorAll<HTMLInputElement>("input[name]")))keyed(input,`furniture:${id}:${input.name}`);const lock=row.querySelector<HTMLInputElement>('input[type="checkbox"]');if(lock)keyed(lock,`furniture:${id}:lock`);const update=row.querySelector<HTMLButtonElement>('button[type="submit"]');if(update)keyed(update,`furniture:${id}:update`);const remove=row.querySelector<HTMLButtonElement>("[data-delete-furniture]");if(remove)keyed(remove,`furniture:${id}:delete`)}return section};
const constraintReferents=(constraint:Constraint):string=>constraint.type==="door_path_clear"?`feature ${constraint.featureId}`:constraint.type==="feature_distance"?`item ${constraint.itemId}, feature ${constraint.featureId}`:`items ${constraint.itemAId} and ${constraint.itemBId}`;

function findOpenPose(snapshot:StoreSnapshot,catalogId:FurnitureCatalogId):Furniture|null{const entry=furnitureCatalogById(catalogId)!;const id=nextId(entry.kind,snapshot.workingState.furniture.map(item=>item.id));for(let y=Math.ceil(entry.depthMm/2/50)*50;y<=snapshot.workingState.room.depthMm-entry.depthMm/2;y+=50){for(let x=Math.ceil(entry.widthMm/2/50)*50;x<=snapshot.workingState.room.widthMm-entry.widthMm/2;x+=50){const item: Furniture={id,catalogId,xMm:x,yMm:y,rotationDeg:0,locked:false};if(placementValid(item,snapshot.workingState.room,snapshot.workingState.furniture,snapshot.workingState.features))return item}}return null}

function summaryTable(snapshot:StoreSnapshot):HTMLElement{const section=make("section");section.className="state-table panel-section";section.dataset.semanticLayout="";section.setAttribute("aria-labelledby","state-table-heading");const heading=make("h2","Layout data");heading.id="state-table-heading";section.append(heading,make("p","The table and plan are generated from the same current working state."));const wrap=make("div");wrap.className="table-wrap";const table=make("table");table.dataset.layoutTable="";const caption=make("caption",`${names[snapshot.activeTemplateId]} furniture positions`);const thead=make("thead");const tr=make("tr");for(const value of ["Item","ID","X (mm)","Y (mm)","Rotation","Size (mm)","Status"]){const th=make("th",value);th.scope="col";tr.append(th)}thead.append(tr);const body=make("tbody");for(const item of snapshot.workingState.furniture){const entry=furnitureCatalogById(item.catalogId)!;const row=make("tr");row.dataset.tableItemId=item.id;for(const value of [entry.label,item.id,String(item.xMm),String(item.yMm),`${item.rotationDeg}°`,`${entry.widthMm} × ${entry.depthMm}`,item.locked?"Locked":"Editable"])row.append(make("td",value));body.append(row)}table.append(caption,thead,body);wrap.append(table);section.append(wrap);const featureList=make("ul");featureList.className="semantic-list";for(const feature of snapshot.workingState.features){const row=make("li",`${feature.id}: ${featureCatalogById(feature.catalogId)?.label} ${feature.wall} ${feature.offsetMm} mm`);row.dataset.featureId=feature.id;featureList.append(row)}const constraintList=make("ul");constraintList.className="semantic-list";for(const constraint of snapshot.workingState.constraints){const amount=constraint.type==="door_path_clear"?constraint.widthMm:constraint.thresholdMm;const relation=constraint.type==="door_path_clear"?"":` ${constraint.relation}`;const row=make("li",`${constraint.constraintId}: ${constraint.strength} ${constraint.type.replaceAll("_"," ")}${relation} ${amount} mm; ${constraintReferents(constraint)}`);row.dataset.constraintId=constraint.constraintId;constraintList.append(row)}section.append(make("h3","Wall features"),featureList,make("h3","Constraint summary"),constraintList);return section}

function roomControls(snapshot:StoreSnapshot,store:DomainStore,status:(s:string)=>void,beforeCommand:()=>void):HTMLElement{const section=make("section");section.className="panel-section room-controls";const heading=make("h2","Room size");section.append(heading);const form=make("form");const field=(labelText:string,value:number,key:string)=>{const label=make("label",labelText);const input=keyed(make("input"),key);input.type="number";input.min=String(LIMITS.roomMinMm);input.max=String(LIMITS.roomMaxMm);input.step="1";input.value=String(value);input.disabled=!!snapshot.preview;label.append(input);form.append(label);return input};const width=field("Width (mm)",snapshot.workingState.room.widthMm,"room:width"),depth=field("Depth (mm)",snapshot.workingState.room.depthMm,"room:depth");const button=keyed(make("button","Update room"),"room:update");button.type="submit";button.disabled=!!snapshot.preview;form.append(button);form.addEventListener("submit",event=>{event.preventDefault();if(!whole(width.value)||!whole(depth.value)){status("Room dimensions must be whole millimetres.");return}beforeCommand();const result=store.updateRoom({widthMm:Number(width.value),depthMm:Number(depth.value)});status(resultMessage("Room update",result))});section.append(form);return section}

function catalogControls(snapshot:StoreSnapshot,store:DomainStore,status:(s:string)=>void,beforeCommand:()=>void):HTMLElement{const section=make("section");section.className="panel-section catalog-controls";section.setAttribute("aria-labelledby","catalog-heading");const heading=make("h2","Add furniture");heading.id="catalog-heading";section.append(heading);const form=make("form");const label=make("label","Add furniture");const select=keyed(make("select"),"furniture:catalog");select.setAttribute("aria-label","Add furniture");for(const entry of FURNITURE_CATALOG){const option=make("option",`${entry.label} · ${entry.widthMm} × ${entry.depthMm} mm`);option.value=entry.id;select.append(option)}select.disabled=!!snapshot.preview||snapshot.workingState.furniture.length>=LIMITS.maxFurniture;label.append(select);const add=keyed(make("button","Add selected furniture"),"furniture:add");add.type="submit";add.disabled=select.disabled;form.append(label,add);form.addEventListener("submit",event=>{event.preventDefault();const item=findOpenPose(snapshot,select.value as FurnitureCatalogId);if(!item){status("No valid open position is available for that item.");return}beforeCommand();const result=store.addFurniture(item);status(result.ok?`${furnitureCatalogById(item.catalogId)!.label} added.${snapshot.workingState.furniture.length+1>=LIMITS.maxFurniture?` Maximum ${LIMITS.maxFurniture} furniture items reached.`:""}`:result.error.message)});section.append(form,make("p",snapshot.workingState.furniture.length>=LIMITS.maxFurniture?`Furniture limit reached (${LIMITS.maxFurniture} of ${LIMITS.maxFurniture}).`:`${snapshot.workingState.furniture.length} of ${LIMITS.maxFurniture} furniture items used.`));return section}

function featureControls(snapshot:StoreSnapshot,store:DomainStore,status:(s:string)=>void,beforeCommand:()=>void):HTMLElement{
  const section=make("section");section.className="panel-section feature-controls";const heading=make("h2","Wall features");section.append(heading);
  for(const feature of snapshot.workingState.features){
    const form=make("form");form.className="feature-row";form.dataset.featureId=feature.id;const title=make("h3",`${featureCatalogById(feature.catalogId)?.label??feature.id} · ${feature.id}`);
    const wallLabel=make("label","Wall");const wall=keyed(make("select"),`feature:${feature.id}:wall`);for(const name of ["north","east","south","west"]){const option=make("option",name[0].toUpperCase()+name.slice(1));option.value=name;wall.append(option)}wall.value=feature.wall;wall.disabled=!!snapshot.preview;wallLabel.append(wall);
    const offsetLabel=make("label","Offset (mm)");const offset=keyed(make("input"),`feature:${feature.id}:offset`);offset.type="number";offset.step="1";offset.min="0";offset.value=String(feature.offsetMm);offset.disabled=!!snapshot.preview;offsetLabel.append(offset);
    const update=keyed(make("button","Update"),`feature:${feature.id}:update`);update.type="submit";update.disabled=!!snapshot.preview;const remove=keyed(make("button","Delete"),`feature:${feature.id}:delete`);remove.type="button";remove.disabled=!!snapshot.preview;remove.addEventListener("click",()=>{beforeCommand();const result=store.deleteFeature(feature.id);status(result.ok?`${feature.id} deleted.`:result.error.message)});
    form.append(title,wallLabel,offsetLabel,update,remove);form.addEventListener("submit",event=>{event.preventDefault();if(!whole(offset.value)){status("Feature offset must be a whole number.");return}beforeCommand();const result=store.updateFeature(feature.id,{...feature,wall:wall.value as Wall,offsetMm:Number(offset.value)});status(result.ok?`${feature.id} updated.`:result.error.message)});section.append(form)
  }
  const add=make("form");add.className="add-row";
  const catalogLabel=make("label","Feature type");const catalog=keyed(make("select"),"feature:new:catalog");for(const entry of FEATURE_CATALOG){const option=make("option",entry.label);option.value=entry.id;catalog.append(option)}catalogLabel.append(catalog);
  const wallLabel=make("label","Wall");const wall=keyed(make("select"),"feature:new:wall");for(const name of ["north","east","south","west"]){const option=make("option",name[0].toUpperCase()+name.slice(1));option.value=name;wall.append(option)}wallLabel.append(wall);
  const offsetLabel=make("label","Offset (mm)");const offset=keyed(make("input"),"feature:new:offset");offset.type="number";offset.value="0";offset.min="0";offset.step="1";offsetLabel.append(offset);
  const button=keyed(make("button","Add feature"),"feature:add");button.type="submit";button.disabled=!!snapshot.preview||snapshot.workingState.features.length>=LIMITS.maxFeatures;for(const field of [catalog,wall,offset])field.disabled=button.disabled;
  add.append(catalogLabel,wallLabel,offsetLabel,button);add.addEventListener("submit",event=>{event.preventDefault();if(!whole(offset.value)){status("Feature offset must be a whole number.");return}const entry=featureCatalogById(catalog.value)!;const feature:Feature={id:nextId(entry.type,snapshot.workingState.features.map(v=>v.id)),catalogId:entry.id,wall:wall.value as Wall,offsetMm:Number(offset.value)};beforeCommand();const result=store.addFeature(feature);status(result.ok?`${entry.label} added.`:result.error.message)});section.append(add,make("p",`${snapshot.workingState.features.length} of ${LIMITS.maxFeatures} wall features used.`));return section
}

function addConstraintControls(snapshot:StoreSnapshot,store:DomainStore,status:(s:string)=>void,beforeCommand:()=>void):HTMLElement{
  const wrap=make("div");const form=make("form");form.className="add-constraint add-row";
  const typeLabel=make("label","Constraint type");const type=keyed(make("select"),"constraint:new:type");type.dataset.newConstraintType="";for(const [value,label] of [["feature_distance","Furniture to feature distance"],["door_path_clear","Door path clear"],["item_distance","Furniture to furniture distance"]]){const option=make("option",label);option.value=value;type.append(option)}typeLabel.append(type);
  const references=make("div");references.className="constraint-references";references.dataset.newConstraintReferences="";
  const add=keyed(make("button","Add constraint"),"constraint:add");add.type="submit";add.dataset.addConstraint="";
  const locked=!!snapshot.preview||snapshot.workingState.constraints.length>=LIMITS.maxConstraints;type.disabled=locked;
  let featureReference:HTMLSelectElement|null=null,itemReference:HTMLSelectElement|null=null,itemAReference:HTMLSelectElement|null=null,itemBReference:HTMLSelectElement|null=null;
  const referenceSelect=(text:string,key:string,reference:string,values:readonly Readonly<{id:string;label:string}>[]):HTMLSelectElement=>{const label=make("label",text);const select=keyed(make("select"),key);select.dataset.newConstraintReference=reference;select.disabled=locked;for(const value of values){const option=make("option",value.label);option.value=value.id;select.append(option)}label.append(select);references.append(label);return select};
  const furniture=snapshot.workingState.furniture.map(item=>({id:item.id,label:`${furnitureCatalogById(item.catalogId)?.label??item.id} · ${item.id}`}));
  const features=snapshot.workingState.features.map(feature=>({id:feature.id,label:`${featureCatalogById(feature.catalogId)?.label??feature.id} · ${feature.id}`}));
  const doors=snapshot.workingState.features.filter(feature=>featureCatalogById(feature.catalogId)?.type==="door").map(feature=>({id:feature.id,label:`${featureCatalogById(feature.catalogId)?.label??feature.id} · ${feature.id}`}));
  const buildReferences=()=>{references.replaceChildren();featureReference=null;itemReference=null;itemAReference=null;itemBReference=null;
    if(type.value==="door_path_clear")featureReference=referenceSelect("Wall feature","constraint:new:feature","feature",doors);
    if(type.value==="feature_distance"){itemReference=referenceSelect("Furniture item","constraint:new:item","item",furniture);featureReference=referenceSelect("Wall feature","constraint:new:feature","feature",features)}
    if(type.value==="item_distance"){
      itemAReference=referenceSelect("First furniture item","constraint:new:item-a","item-a",furniture);
      const populateSecond=(preferred:string)=>{const candidates=furniture.filter(item=>item.id!==itemAReference!.value);itemBReference!.replaceChildren();for(const candidate of candidates){const option=make("option",candidate.label);option.value=candidate.id;itemBReference!.append(option)}itemBReference!.value=candidates.some(candidate=>candidate.id===preferred)?preferred:candidates[0]?.id??""};
      itemBReference=referenceSelect("Second furniture item","constraint:new:item-b","item-b",furniture.filter(item=>item.id!==itemAReference!.value));itemAReference.addEventListener("change",()=>populateSecond(itemBReference!.value));
    }
    const ready=type.value==="door_path_clear"?!!featureReference?.value:type.value==="feature_distance"?!!itemReference?.value&&!!featureReference?.value:!!itemAReference?.value&&!!itemBReference?.value&&itemAReference.value!==itemBReference.value;add.disabled=locked||!ready
  };
  type.addEventListener("change",buildReferences);form.append(typeLabel,references,add);buildReferences();
  form.addEventListener("submit",event=>{event.preventDefault();const id=nextId("constraint",snapshot.workingState.constraints.map(c=>c.constraintId));let constraint:Constraint|null=null;
    if(type.value==="door_path_clear"&&featureReference?.value)constraint={constraintId:id,type:"door_path_clear",strength:"required",featureId:featureReference.value,widthMm:900};
    if(type.value==="feature_distance"&&featureReference?.value&&itemReference?.value)constraint={constraintId:id,type:"feature_distance",strength:"preferred",itemId:itemReference.value,featureId:featureReference.value,relation:"near",thresholdMm:500};
    if(type.value==="item_distance"&&itemAReference?.value&&itemBReference?.value&&itemAReference.value!==itemBReference.value)constraint={constraintId:id,type:"item_distance",strength:"preferred",itemAId:itemAReference.value,itemBId:itemBReference.value,relation:"near",thresholdMm:500};
    if(!constraint){status("This constraint needs valid, distinct referenced furniture or wall features first.");return}beforeCommand();const result=store.addConstraint(constraint);status(result.ok?`${id} added.`:result.error.message)
  });
  wrap.append(form,make("p",snapshot.workingState.constraints.length>=LIMITS.maxConstraints?`Maximum ${LIMITS.maxConstraints} constraints reached.`:`${snapshot.workingState.constraints.length} of ${LIMITS.maxConstraints} constraints used.`));return wrap
}

export function hydrateApp(root: HTMLElement, _fixture?: InspectSpatialLayoutData, supplied?: DomainStore): AppView {
  const store = supplied ?? new DomainStore();
  const ui = createWorkspaceShell(root);
  let snapshot: StoreSnapshot | undefined;
  let selected: string | null = null;
  let viewMode: SpatialViewMode = "isometric";
  let cameraResetVersion = 0;
  let renderer: SpatialViewHandle | undefined;
  let availability: SpatialAvailability["state"] = "initializing";
  let cancelSvg: (() => void) | null = null;
  let disposed = false;
  let interactionVersion = 0;
  let surfacedStoreError: string | null = null;
  const welcomeTemplates = make("div");
  welcomeTemplates.className = "welcome-templates";
  const welcomeButtons: HTMLButtonElement[] = [];
  for (const id of Object.keys(names) as TemplateId[]) {
    const button = keyed(make("button", `Use ${names[id]} template`), `welcome:${id}`);
    button.type = "button";
    button.addEventListener("click", () => {
      if (disposed) return;
      cancelGestures();
      const result = store.activateTemplate(id);
      if (result.ok) selected = null;
      else status(result.error.message);
    });
    welcomeButtons.push(button);
    welcomeTemplates.append(button);
  }
  ui.entry.append(welcomeTemplates);

  const status = (value: string) => {
    if (!disposed) ui.editorStatus.textContent = value;
  };
  const cancelGestures = () => {
    interactionVersion += 1;
    const cancel = cancelSvg;
    cancelSvg = null;
    cancel?.();
    renderer?.cancelInteraction();
  };
  const spatialState = (): SpatialViewState => ({
    snapshot: snapshot!,
    selectedItemId: selected,
    viewMode,
    cameraResetVersion,
  });
  const updateView = () => {
    ui.shell.dataset.viewMode = viewMode;
    ui.spatialHost.hidden = viewMode === "precision-2d" || availability === "unavailable";
    ui.precisionHost.hidden = viewMode !== "precision-2d" && availability === "available";
    for (const [mode, button] of Object.entries(ui.modeButtons)) {
      button.setAttribute("aria-pressed", String(mode === viewMode));
      button.disabled = availability === "unavailable" && mode !== "precision-2d";
    }
    if (snapshot) renderer?.update(spatialState());
  };
  const changeView = (mode: SpatialViewMode) => {
    if (disposed || mode === viewMode || (availability === "unavailable" && mode !== "precision-2d")) return;
    cancelGestures();
    viewMode = mode;
    drawPrecision();
    updateView();
  };
  for (const mode of Object.keys(ui.modeButtons) as SpatialViewMode[]) {
    ui.modeButtons[mode].addEventListener("click", () => changeView(mode));
  }
  ui.resetViewButton.addEventListener("click", () => {
    if (disposed) return;
    cancelGestures();
    cameraResetVersion += 1;
    drawPrecision();
    updateView();
  });
  ui.startButton.addEventListener("click", () => {
    if (disposed) return;
    ui.entry.hidden = true;
    ui.shell.dataset.entered = "true";
    ui.title.focus({ preventScroll: true });
  });

  const selectItem = (id: string | null) => {
    if (disposed || !snapshot || (id !== null && !snapshot.workingState.furniture.some(item => item.id === id))) return;
    if (selected === id) return;
    selected = id;
    draw(true);
  };
  const onPoseRequest = async (request: SpatialPoseRequest) => {
    if (disposed) return;
    const version = interactionVersion;
    const current = await store.snapshot();
    if (disposed || version !== interactionVersion) return;
    if (current.activeTemplateId !== request.baseTemplateId || current.baseRevision !== request.baseRevision || current.baseHash !== request.baseHash || current.preview) {
      status("Move canceled: the room changed. Try again with the current layout.");
      return;
    }
    const item = current.workingState.furniture.find(value => value.id === request.itemId);
    if (!item || item.locked) return;
    const pose = request.pose;
    if (![pose.xMm, pose.yMm, pose.rotationDeg].every(Number.isInteger) || ![0, 90, 180, 270].includes(pose.rotationDeg)) {
      status("Coordinates must be whole millimetres and rotation must be a quarter turn.");
      return;
    }
    if (!placementValid({ ...item, ...pose }, current.workingState.room, current.workingState.furniture, current.workingState.features)) {
      status("Move rejected: outside bounds, overlap, or radiator keep-out.");
      return;
    }
    cancelGestures();
    const result = store.updateFurniturePose(item.id, pose);
    status(result.ok ? `${item.id} moved to ${pose.xMm}, ${pose.yMm} mm.` : result.error.message);
  };

  const drawPrecision = () => {
    if (disposed || !snapshot) return;
    ui.precisionHost.replaceChildren(roomSvg(snapshot, selected, {
      select: selectItem,
      drag: (event, id, node) => {
        if (!snapshot || disposed || viewMode !== "precision-2d" || snapshot.preview || event.button !== 0 || !event.isPrimary || cancelSvg) return;
        cancelGestures();
        cancelSvg = startDrag(event, id, node, snapshot, store, () => {
          cancelSvg = null;
          if (!disposed) drawPrecision();
        }, status) ?? null;
      },
    }));
  };
  const drawSceneList = () => {
    if (!snapshot) return;
    const section = make("section");
    section.className = "scene-list panel-section";
    section.dataset.sceneItemList = "";
    section.append(make("h2", "In this room"), make("p", "Select an item to fine-tune its position."));
    const list = make("ul");
    for (const item of snapshot.workingState.furniture) {
      const entry = furnitureCatalogById(item.catalogId)!;
      const row = make("li");
      row.dataset.spatialItemId = item.id;
      row.dataset.xMm = String(item.xMm);
      row.dataset.yMm = String(item.yMm);
      row.dataset.rotationDeg = String(item.rotationDeg);
      row.dataset.locked = String(item.locked);
      row.classList.toggle("selected", selected === item.id);
      const button = keyed(make("button"), `scene:${item.id}`);
      button.type = "button";
      button.setAttribute("aria-label", `Select ${entry.label} (${item.id})`);
      button.setAttribute("aria-pressed", String(selected === item.id));
      const swatch = make("span");
      swatch.className = "item-swatch";
      swatch.dataset.kind = entry.kind;
      swatch.setAttribute("aria-hidden", "true");
      const label = make("span", entry.label);
      button.append(swatch, label);
      button.addEventListener("click", () => selectItem(item.id));
      const pose = make("p", `${item.xMm}, ${item.yMm} mm · ${item.rotationDeg}°`);
      pose.className = "item-pose";
      const identity = make("span", `${item.id} · ${item.locked ? "Locked" : "Editable"}`);
      identity.className = "item-identity";
      row.append(button, pose, identity);
      list.append(row);
    }
    section.append(list);
    if (!snapshot.workingState.furniture.length) section.append(make("p", "No furniture in this layout."));
    if (snapshot.preview) {
      const preview = make("div");
      preview.className = "scene-preview-list";
      preview.append(make("h3", "Preview — not applied"));
      for (const move of snapshot.preview.moves) {
        const item = snapshot.preview.projectedFurniture.find(candidate => candidate.id === move.itemId)!;
        const row = make("p", `${furnitureCatalogById(item.catalogId)!.label}: ${item.xMm}, ${item.yMm} mm · ${item.rotationDeg}° · Preview — not applied`);
        row.dataset.spatialPreviewItemId = item.id;
        row.dataset.xMm = String(item.xMm);
        row.dataset.yMm = String(item.yMm);
        row.dataset.rotationDeg = String(item.rotationDeg);
        preview.append(row);
      }
      section.append(preview);
    }
    ui.sceneListSlot.replaceChildren(section);
  };
  const mutatePose = (id: string, x: string, y: string, r: string) => {
    if (!snapshot || disposed) return;
    if (x === "" || y === "" || r === "") { status("Invalid input: every coordinate and rotation is required."); return; }
    if (!whole(x) || !whole(y) || !whole(r)) { status("Coordinates and rotation must be whole integers."); return; }
    const item = snapshot.workingState.furniture.find(value => value.id === id);
    if (!item) return;
    const pose = { xMm: Number(x), yMm: Number(y), rotationDeg: Number(r) as RotationDeg };
    if (![0, 90, 180, 270].includes(pose.rotationDeg)) { status("Rotation must be a quarter turn: 0, 90, 180, or 270 degrees."); return; }
    if (!placementValid({ ...item, ...pose }, snapshot.workingState.room, snapshot.workingState.furniture, snapshot.workingState.features)) {
      status("Move rejected: outside bounds, overlap, or radiator keep-out."); return;
    }
    cancelGestures();
    const result = store.updateFurniturePose(id, pose);
    status(result.ok ? `${id} updated.` : result.error.message);
  };

  const draw = (selectionOnly = false) => {
    if (!snapshot || disposed) return;
    const focusKey = activeFocusKey(root);
    const pending = !!snapshot.preview;
    for (const button of welcomeButtons) button.disabled = pending;
    if (selected && !snapshot.workingState.furniture.some(item => item.id === selected)) selected = null;
    const errorKey = snapshot.error ? `${snapshot.activeTemplateId}:${snapshot.error}` : null;
    if (snapshot.error && errorKey !== surfacedStoreError) { status(snapshot.error); surfacedStoreError = errorKey; }
    else if (!snapshot.error) surfacedStoreError = null;
    ui.title.textContent = `${names[snapshot.activeTemplateId]} plan`;
    ui.shell.classList.toggle("has-preview", pending);
    const templateLabel = make("label", "Room template");
    const templates = keyed(make("select"), "template:active");
    templates.setAttribute("aria-label", "Room template");
    for (const id of Object.keys(names) as TemplateId[]) {
      const option = make("option", names[id]);
      option.value = id;
      templates.append(option);
    }
    templates.value = snapshot.activeTemplateId;
    templates.disabled = pending;
    templates.addEventListener("change", () => {
      cancelGestures();
      const result = store.activateTemplate(templates.value as TemplateId);
      if (result.ok) selected = null;
      else status(result.error.message);
    });
    templateLabel.append(templates);
    ui.templateSlot.replaceChildren(templateLabel);
    ui.actionsSlot.replaceChildren();
    for (const [labelText, action] of [["Save", () => store.save()], ["Undo", () => store.undo()], ["Reset", () => store.reset()]] as const) {
      const actionName = labelText.toLowerCase();
      const button = keyed(make("button", labelText), `layout:${actionName}`);
      button.type = "button";
      button.dataset.action = actionName;
      button.disabled = pending;
      if (labelText === "Save") button.className = "primary-action";
      button.addEventListener("click", () => {
        cancelGestures();
        const result = action();
        status(resultMessage(labelText, result));
      });
      ui.actionsSlot.append(button);
    }
    const summary = make("dl");
    summary.className = "layout-summary";
    for (const [term, value] of [["Template", names[snapshot.activeTemplateId]], ["Room", `${snapshot.workingState.room.widthMm} × ${snapshot.workingState.room.depthMm} mm`], ["Revision", String(snapshot.baseRevision)], ["Furniture", String(snapshot.workingState.furniture.length)], ["Features", String(snapshot.workingState.features.length)], ["Constraints", String(snapshot.workingState.constraints.length)]]) {
      const pair = make("div"); pair.append(make("dt", term), make("dd", value)); summary.append(pair);
    }
    ui.summarySlot.replaceChildren(summary);
    ui.catalogSlot.replaceChildren(catalogControls(snapshot, store, status, cancelGestures));
    drawSceneList();
    ui.inspectorSlot.replaceChildren(tagInspectorFocus(inspector(snapshot, {
      mutate: mutatePose,
      rotate: id => {
        const item = snapshot!.workingState.furniture.find(value => value.id === id);
        if (item) mutatePose(id, String(item.xMm), String(item.yMm), String((item.rotationDeg + 90) % 360));
      },
      lock: (id, locked) => {
        cancelGestures();
        const result = store.setFurnitureLocked(id, locked);
        status(result.ok ? `${id} ${locked ? "locked" : "unlocked"}.` : result.error.message);
      },
      remove: id => {
        cancelGestures();
        const result = store.deleteFurniture(id);
        status(result.ok ? `${id} deleted.` : result.error.message);
      },
    }, selected)));
    ui.roomSlot.replaceChildren(roomControls(snapshot, store, status, cancelGestures));
    ui.featuresSlot.replaceChildren(featureControls(snapshot, store, status, cancelGestures));
    ui.constraintsSlot.replaceChildren(constraintsList(snapshot, {
      update: (id, value) => { cancelGestures(); const result = store.updateConstraint(id, value); status(result.ok ? `${id} updated.` : result.error.message); },
      remove: id => { cancelGestures(); const result = store.deleteConstraint(id); status(result.ok ? `${id} deleted.` : result.error.message); },
    }), addConstraintControls(snapshot, store, status, cancelGestures));
    ui.layoutDataSlot.replaceChildren(summaryTable(snapshot));
    ui.reviewSlot.replaceChildren(reviewPanel(snapshot.preview, {
      apply: () => { cancelGestures(); void store.apply().then(result => status(result.ok ? "Preview applied. It is not saved yet." : result.error.message)); },
      discard: () => { cancelGestures(); const result = store.discard(); status(result.ok ? "Preview discarded. Working layout unchanged." : result.error.message); },
    }));
    if (!selectionOnly && !cancelSvg) drawPrecision();
    else {
      for (const item of Array.from(ui.precisionHost.querySelectorAll<SVGGElement>("[data-furniture-id]"))) {
        const isSelected = item.dataset.furnitureId === selected;
        item.classList.toggle("selected", isSelected);
        item.setAttribute("aria-pressed", String(isSelected));
      }
    }
    if (!renderer) {
      renderer = mountSpatialView(ui.spatialHost, spatialState(), {
        onSelect: selectItem,
        onPoseRequest: request => { void onPoseRequest(request); },
        onAvailabilityChange: value => {
          if (disposed) return;
          availability = value.state;
          ui.spatialStatus.dataset.state = value.state;
          ui.spatialStatus.textContent = value.message;
          if (value.state === "unavailable") {
            cancelGestures();
            viewMode = "precision-2d";
            drawPrecision();
          }
          updateView();
        },
      });
    }
    updateView();
    restoreFocus(root, focusKey, pending);
  };
  const unsubscribe = store.subscribe(value => {
    if (disposed) return;
    const prior = snapshot;
    const baseChanged = !prior || prior.activeTemplateId !== value.activeTemplateId || prior.baseRevision !== value.baseRevision || prior.baseHash !== value.baseHash;
    const previewChanged = JSON.stringify(prior?.preview ?? null) !== JSON.stringify(value.preview);
    if (baseChanged || previewChanged) cancelGestures();
    if (prior && prior.activeTemplateId !== value.activeTemplateId) selected = null;
    snapshot = value;
    draw();
  });
  return Object.freeze({
    setCapabilityStatus(state, value) {
      if (disposed) return;
      ui.capabilityStatus.dataset.state = state;
      ui.capabilityStatus.textContent = value;
    },
    teardown() {
      if (disposed) return;
      disposed = true;
      cancelGestures();
      unsubscribe();
      renderer?.dispose();
    },
  });
}
