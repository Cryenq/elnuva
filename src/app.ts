import { DomainStore, type StoreSnapshot } from "./domain/store";
import { placementValid } from "./domain/geometry";
import type { InspectSpatialLayoutData, TemplateId } from "./domain/types";
import { roomSvg } from "./ui/render";
import { startDrag } from "./ui/svg-editor";
import { inspector } from "./ui/inspector";
import { constraintsList } from "./ui/constraints";

type CapabilityState = "checking" | "registered" | "unavailable" | "failed";
export type AppView = Readonly<{ setCapabilityStatus: (state: CapabilityState, message: string) => void; teardown: () => void }>;
const names: Record<TemplateId,string>={"home-office":"Home Office",bedroom:"Bedroom",study:"Study"};
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const node=document.createElement(tag);node.textContent=text??"";return node;};

/** T03 fixture remains accepted for synchronous callers; T06 may supply its shared store. */
export function hydrateApp(root: HTMLElement, _fixture?: InspectSpatialLayoutData, supplied?: DomainStore): AppView {
  const store=supplied??new DomainStore(); let snapshot:StoreSnapshot|undefined, selected:string|null=null, message="Ready to edit the room.", capability:HTMLElement|undefined;
  const status=(value:string)=>{message=value;root.querySelector<HTMLElement>("[data-editor-status]")?.replaceChildren(value);};
  const draw=()=>{if(!snapshot)return; root.replaceChildren();const shell=make("div");shell.className="app-shell";const header=make("header");header.className="site-header";header.append(make("p","Spatial workspace"),make("h1","Elnuva"),make("p","Constraint-aware room planning, with you in control."));shell.append(header);const main=make("main");main.className="workspace";const card=make("section");card.className="card layout-card";card.append(make("h2","Active layout"));
    const label=make("label","Room template");const select=document.createElement("select");select.setAttribute("aria-label","Room template");for(const id of Object.keys(names) as TemplateId[]){const option=document.createElement("option");option.value=id;option.textContent=names[id];select.append(option)}select.value=snapshot.activeTemplateId;select.disabled=!!snapshot.preview;select.addEventListener("change",()=>{const result=store.activateTemplate(select.value as TemplateId);if(!result.ok)status(result.error.message)});label.append(select);card.append(label);
    const summary=make("dl");summary.className="layout-summary";for(const [term,value] of [["Template",names[snapshot.activeTemplateId]],["Room",`${snapshot.workingState.room.widthMm} × ${snapshot.workingState.room.depthMm} mm`],["Revision",String(snapshot.baseRevision)],["Furniture",String(snapshot.workingState.furniture.length)],["Features",String(snapshot.workingState.features.length)],["Constraints",String(snapshot.workingState.constraints.length)]]) summary.append(make("dt",term),make("dd",value));card.append(summary);
    card.append(roomSvg(snapshot,selected,{select:id=>{selected=id;draw()},drag:(event,id,node)=>startDrag(event,id,node,snapshot!,store,draw,status)}));const notice=make("p",message);notice.dataset.editorStatus="";notice.setAttribute("role","status");notice.setAttribute("aria-live","polite");card.append(notice);
    card.append(inspector(snapshot,(id,x,y,r)=>{if(!/^-?\d+$/.test(x)||!/^-?\d+$/.test(y)||!/^-?\d+$/.test(r)){status("Invalid input: coordinates and rotation must be whole integers.");return}const item=snapshot!.workingState.furniture.find(value=>value.id===id)!;const pose={xMm:Number(x),yMm:Number(y),rotationDeg:Number(r)};if(![0,90,180,270].includes(pose.rotationDeg)){status("Rotation must be a quarter turn (0, 90, 180, or 270).");return}const candidate={...item,...pose} as typeof item;if(!placementValid(candidate,snapshot!.workingState.room,snapshot!.workingState.furniture,snapshot!.workingState.features)){status("Move rejected: outside bounds, overlap, or radiator keep-out.");return}const result=store.updateFurniturePose(id,candidate);status(result.ok?`${id} updated.`:result.error.message)},(id,locked)=>{const result=store.setFurnitureLocked(id,locked);status(result.ok?`${id} ${locked?"locked":"unlocked"}.`:result.error.message)}));card.append(constraintsList(snapshot));main.append(card);
    const aside=make("aside");aside.className="card capability-card";aside.append(make("h2","Agent capability"));capability=make("p","Checking WebMCP availability…");capability.className="capability-status";capability.dataset.state="checking";capability.setAttribute("role","status");aside.append(capability);main.append(aside);shell.append(main);root.append(shell);
  };const unsubscribe=store.subscribe(value=>{snapshot=value;draw()});return Object.freeze({setCapabilityStatus(state,value){if(capability){capability.dataset.state=state;capability.textContent=value}},teardown:unsubscribe});
}
