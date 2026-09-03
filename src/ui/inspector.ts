import type { StoreSnapshot } from "../domain/store";
import { furnitureCatalogById } from "../domain/catalog";

export type InspectorCallbacks = Readonly<{ mutate:(id:string,x:string,y:string,rotation:string)=>void; lock:(id:string,value:boolean)=>void; remove:(id:string)=>void; rotate:(id:string)=>void }>;

export function inspector(snapshot: StoreSnapshot, callbacks: InspectorCallbacks, selectedItemId: string | null): HTMLElement {
  const section=document.createElement("section");section.className="inspector panel-section";section.setAttribute("aria-labelledby","furniture-heading");
  const heading=document.createElement("h2");heading.id="furniture-heading";heading.textContent="Selected furniture";section.append(heading);
  const help=document.createElement("p");help.className="section-help";help.textContent="Enter exact millimetre coordinates. Locked items cannot move or be deleted.";section.append(help);
  if(snapshot.workingState.furniture.length===0){const empty=document.createElement("p");empty.textContent="No furniture in this layout.";empty.dataset.emptyFurniture="";section.append(empty)}
  const selected=snapshot.workingState.furniture.find(item=>item.id===selectedItemId);
  if(!selected&&snapshot.workingState.furniture.length){const prompt=document.createElement("p");prompt.className="selection-prompt";prompt.textContent="Select furniture in the room or item list to edit its position, rotation and lock.";section.append(prompt)}
  for(const item of selected?[selected]:[]){const row=document.createElement("form");row.className="geometry-row";row.dataset.geometryRow="";row.dataset.itemId=item.id;const label=furnitureCatalogById(item.catalogId)?.label??item.id;const title=document.createElement("h3");title.textContent=`${label} · ${item.id}`;row.append(title);
    const input=(text:string,name:string,value:string)=>{const wrapper=document.createElement("label");wrapper.textContent=text;const field=document.createElement("input");field.type="number";field.step="any";field.name=name;field.value=value;field.disabled=!!snapshot.preview||item.locked;field.setAttribute("aria-label",text);wrapper.append(field);row.append(wrapper);return field};
    const x=input("X position (mm)","xMm",String(item.xMm)),y=input("Y position (mm)","yMm",String(item.yMm)),rotation=input("Rotation","rotationDeg",String(item.rotationDeg));
    const lockLabel=document.createElement("label");lockLabel.className="check-label";const check=document.createElement("input");check.type="checkbox";check.checked=item.locked;check.disabled=!!snapshot.preview;check.setAttribute("aria-label","Locked");check.addEventListener("change",()=>callbacks.lock(item.id,check.checked));lockLabel.append(check,document.createTextNode(" Locked"));row.append(lockLabel);
    const rotate=document.createElement("button");rotate.type="button";rotate.textContent="Rotate 90°";rotate.disabled=!!snapshot.preview||item.locked;rotate.dataset.focusKey=`furniture:${item.id}:rotate`;rotate.addEventListener("click",()=>callbacks.rotate(item.id));
    const update=document.createElement("button");update.type="submit";update.textContent="Update furniture";update.className="primary-action";update.disabled=!!snapshot.preview||item.locked;const remove=document.createElement("button");remove.type="button";remove.textContent="Delete furniture";remove.className="destructive-action";remove.disabled=!!snapshot.preview||item.locked;remove.dataset.deleteFurniture=item.id;remove.addEventListener("click",()=>callbacks.remove(item.id));row.append(rotate,update,remove);row.addEventListener("submit",event=>{event.preventDefault();callbacks.mutate(item.id,x.value,y.value,rotation.value)});section.append(row)}return section;
}
