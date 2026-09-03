import { BoxGeometry, Color, DirectionalLight, Group, HemisphereLight, LineBasicMaterial, LineSegments, BufferGeometry, Mesh, MeshStandardMaterial, OrthographicCamera, Plane, Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import type { BufferGeometry as Geometry, Material, Object3D } from "three";
import { featureCatalogById, furnitureCatalogById } from "../domain/catalog";
import type { Furniture, Pose, WorkingState } from "../domain/types";
import { createFurnitureVisual } from "./furniture-visuals";
import { domainPoseToWorld, fitTopCamera, floorPointToSnappedMm } from "./spatial-projection";
import type { CssViewport, MillimetrePoint, MountSpatialView, SpatialPoseRequest, SpatialViewState } from "./spatial-view-contract";

type Gesture = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  item: Furniture;
  candidate: Pose;
  grabOffset: MillimetrePoint;
  baseTemplateId: SpatialPoseRequest["baseTemplateId"];
  baseRevision: number;
  baseHash: string;
};

function releaseObjects(root: Object3D): void {
  const geometries = new Set<Geometry>();
  const materials = new Set<Material>();
  root.traverse((node) => {
    if (node instanceof Mesh || node instanceof LineSegments) {
      geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  root.clear();
}

function sameBase(a: SpatialViewState, b: SpatialViewState): boolean {
  return a.snapshot.activeTemplateId === b.snapshot.activeTemplateId && a.snapshot.baseRevision === b.snapshot.baseRevision && a.snapshot.baseHash === b.snapshot.baseHash;
}

function samePreview(a: SpatialViewState, b: SpatialViewState): boolean {
  return a.snapshot.preview?.proposalDigest === b.snapshot.preview?.proposalDigest && a.snapshot.preview?.idempotencyKey === b.snapshot.preview?.idempotencyKey;
}

/** An isolated, disposable presentation adapter: it never owns or writes a store. */
export const mountSpatialView: MountSpatialView = (host, initialState, callbacks) => {
  let state = initialState;
  let disposed = false;
  let available = false;
  let failed = false;
  let renderer: WebGLRenderer | null = null;
  let frame: number | null = null;
  let gesture: Gesture | null = null;
  let gestureGeneration = 0;
  let resizeObserver: ResizeObserver | null = null;
  let viewport: CssViewport = { width: 1, height: 1 };
  const canvas = document.createElement("canvas");
  canvas.dataset.spatialCanvas = "";
  canvas.setAttribute("aria-label", "Interactive spatial room view. Select furniture here or use the scene list and numeric controls.");
  canvas.setAttribute("role", "img");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;";
  host.append(canvas);
  const scene = new Scene();
  scene.background = new Color(0xf1eee7);
  const roomGroup = new Group(), currentGroup = new Group(), previewGroup = new Group();
  scene.add(roomGroup, currentGroup, previewGroup);
  const hemisphere = new HemisphereLight(0xfffaf0, 0x838f88, 2.8);
  const sunlight = new DirectionalLight(0xfff6e4, 2.6);
  sunlight.position.set(-3, 7, 5);
  const fill = new DirectionalLight(0xe1edf0, 1);
  fill.position.set(5, 4, -3);
  scene.add(hemisphere, sunlight, fill);
  const camera = new OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
  const raycaster = new Raycaster();
  const floor = new Plane(new Vector3(0, 1, 0), 0);
  const floorTarget = new Vector3();
  const itemGroups = new Map<string, Group>();

  function drawNow(): void {
    if (disposed || !available || !renderer || state.viewMode === "precision-2d") return;
    try {
      renderer.render(scene, camera);
    } catch {
      unavailable("Spatial rendering stopped. Precision 2D and numeric editing remain available.");
    }
  }

  function requestDraw(): void {
    if (disposed || !available || frame !== null || state.viewMode === "precision-2d") return;
    frame = requestAnimationFrame(() => { frame = null; drawNow(); });
  }

  function cancelInteraction(): void {
    gestureGeneration += 1;
    const previous = gesture;
    gesture = null;
    canvas.style.cursor = "default";
    if (previous) {
      const visual = itemGroups.get(previous.item.id);
      const current = state.snapshot.workingState.furniture.find((item) => item.id === previous.item.id);
      if (visual && current) {
        const pose = domainPoseToWorld(current);
        visual.position.set(pose.x, 0, pose.z);
        visual.rotation.y = pose.rotationY;
      }
      try { if (canvas.hasPointerCapture(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId); } catch { /* A disconnected canvas may already have lost capture. */ }
      requestDraw();
    }
  }

  function unavailable(message: string): void {
    if (disposed || failed) return;
    failed = true;
    available = false;
    cancelInteraction();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    renderer?.dispose();
    renderer = null;
    callbacks.onAvailabilityChange({ state: "unavailable", message });
  }

  function addBox(group: Group, w: number, h: number, d: number, x: number, y: number, z: number, color: number, opacity = 1): void {
    const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshStandardMaterial({ color, roughness: 0.95, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
    mesh.position.set(x, y, z);
    group.add(mesh);
  }

  function buildRoom(working: WorkingState): void {
    releaseObjects(roomGroup);
    const width = working.room.widthMm / 1000, depth = working.room.depthMm / 1000;
    addBox(roomGroup, width + 0.12, 0.11, depth + 0.12, width / 2, -0.07, depth / 2, 0xc9b79f);
    addBox(roomGroup, width, 0.025, depth, width / 2, -0.013, depth / 2, 0xe4d6be);
    const plankPoints: Vector3[] = [];
    for (let x = 0.22; x < width; x += 0.22) plankPoints.push(new Vector3(x, 0.002, 0), new Vector3(x, 0.002, depth));
    for (let x = 0; x < width; x += 0.22) for (let z = 0.7 + (Math.round(x / 0.22) % 3) * 0.45; z < depth; z += 1.35) plankPoints.push(new Vector3(x, 0.002, z), new Vector3(Math.min(width, x + 0.22), 0.002, z));
    roomGroup.add(new LineSegments(new BufferGeometry().setFromPoints(plankPoints), new LineBasicMaterial({ color: 0xc6b599, transparent: true, opacity: 0.4 })));

    for (const wall of ["north", "east", "south", "west"] as const) {
      const horizontal = wall === "north" || wall === "south";
      const wallLength = horizontal ? width : depth;
      const tall = state.viewMode !== "top" && (wall === "north" || wall === "west");
      const wallHeight = tall ? 1.2 : 0.055;
      const features = working.features.filter((feature) => feature.wall === wall);
      const wallPiece = (start: number, end: number, bottom: number, height: number, color = 0xe2e5dc): void => {
        if (end <= start || height <= 0) return;
        const at = (start + end) / 2;
        const boundary = wall === "north" || wall === "west" ? -0.04 : (horizontal ? depth : width) + 0.04;
        addBox(roomGroup, horizontal ? end - start : 0.08, height, horizontal ? 0.08 : end - start, horizontal ? at : boundary, bottom + height / 2, horizontal ? boundary : at, color);
      };
      // Openings are cut from the raised back walls; short front walls do not obscure furniture.
      const openings = features.filter((feature) => feature.catalogId !== "radiator-900").map((feature) => ({ start: feature.offsetMm / 1000, end: (feature.offsetMm + featureCatalogById(feature.catalogId)!.spanMm) / 1000 })).sort((a, b) => a.start - b.start);
      let from = 0;
      for (const opening of openings) {
        wallPiece(from, opening.start, 0, wallHeight);
        from = Math.max(from, opening.end);
      }
      wallPiece(from, wallLength, 0, wallHeight);
      for (const feature of features) {
        const catalog = featureCatalogById(feature.catalogId)!;
        const start = feature.offsetMm / 1000, span = catalog.spanMm / 1000;
        const center = start + span / 2;
        const boundary = wall === "north" || wall === "west" ? 0 : horizontal ? depth : width;
        const inward = wall === "north" || wall === "west" ? 1 : -1;
        const featureBox = (length: number, height: number, inwardDepth: number, at: number, y: number, inset: number, color: number, opacity = 1): void => {
          addBox(roomGroup, horizontal ? length : inwardDepth, height, horizontal ? inwardDepth : length, horizontal ? at : boundary + inward * inset, y, horizontal ? boundary + inward * inset : at, color, opacity);
        };
        if (catalog.type === "window") {
          if (tall) wallPiece(start, start + span, 0, 0.48);
          const y = tall ? 0.83 : 0.07;
          featureBox(span, tall ? 0.58 : 0.035, 0.025, center, y, -0.025, 0xb0cbd0, 0.72);
          featureBox(span + 0.04, 0.045, 0.12, center, tall ? 0.52 : 0.045, 0.01, 0xf5f3e9);
          if (tall) {
            featureBox(span + 0.04, 0.035, 0.05, center, 1.14, -0.025, 0xf5f3e9);
            for (const at of [start, center, start + span]) featureBox(0.035, 0.64, 0.05, at, 0.83, -0.025, 0xf5f3e9);
          }
        } else if (catalog.type === "door") {
          featureBox(span, 0.022, 0.06, center, 0.012, 0, 0x8b7358);
          for (const at of [start, start + span]) featureBox(0.04, tall ? 1.18 : 0.09, 0.085, at, tall ? 0.59 : 0.045, -0.015, 0xc3b39b);
        } else {
          featureBox(span, 0.48, catalog.depthMm / 1000, center, 0.31, catalog.depthMm / 2000, 0xf4f2e8);
          for (let at = start + 0.06; at < start + span; at += 0.085) featureBox(0.028, 0.39, 0.025, at, 0.31, catalog.depthMm / 1000 - 0.015, 0xd1d5cf);
        }
      }
    }
  }

  function buildFurniture(): void {
    releaseObjects(currentGroup);
    releaseObjects(previewGroup);
    itemGroups.clear();
    const add = (item: Furniture, preview: boolean): void => {
      const catalog = furnitureCatalogById(item.catalogId);
      if (!catalog) return;
      const group = createFurnitureVisual(catalog, preview, !preview && item.id === state.selectedItemId);
      const pose = domainPoseToWorld(item);
      group.position.set(pose.x, preview ? 0.018 : 0, pose.z);
      group.rotation.y = pose.rotationY;
      if (!preview) { group.userData.itemId = item.id; itemGroups.set(item.id, group); }
      (preview ? previewGroup : currentGroup).add(group);
    };
    state.snapshot.workingState.furniture.forEach((item) => add(item, false));
    const preview = state.snapshot.preview;
    if (preview) {
      const moved = new Set(preview.moves.map((move) => move.itemId));
      preview.projectedFurniture.filter((item) => moved.has(item.id)).forEach((item) => add(item, true));
    }
    // Selection can change synchronously during picking, without canceling the gesture.
    if (gesture) {
      const group = itemGroups.get(gesture.item.id);
      const pose = domainPoseToWorld(gesture.candidate);
      group?.position.set(pose.x, 0, pose.z);
    }
    scene.updateMatrixWorld(true);
  }

  function fitCamera(): void {
    const room = state.snapshot.workingState.room;
    const width = room.widthMm / 1000, depth = room.depthMm / 1000;
    const center = new Vector3(width / 2, 0, depth / 2);
    if (state.viewMode === "top") {
      const bounds = fitTopCamera(room, viewport);
      camera.up.set(0, 0, -1);
      camera.position.set(center.x, 30, center.z);
      camera.lookAt(center);
      camera.left = bounds.minX - center.x;
      camera.right = bounds.maxX - center.x;
      camera.top = center.z - bounds.minZ;
      camera.bottom = center.z - bounds.maxZ;
    } else {
      camera.up.set(0, 1, 0);
      center.y = 0.55;
      camera.position.copy(center).add(new Vector3(12, 13, 12));
      camera.lookAt(center);
      camera.updateMatrixWorld(true);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [-0.12, width + 0.12]) for (const z of [-0.12, depth + 0.12]) for (const y of [-0.12, 1.95]) {
        const point = new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
      }
      const aspect = viewport.width / viewport.height;
      const halfWidth = Math.max((maxX - minX) / 2 + 0.28, ((maxY - minY) / 2 + 0.28) * aspect);
      const halfHeight = halfWidth / aspect;
      const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
      camera.left = midX - halfWidth; camera.right = midX + halfWidth;
      camera.top = midY + halfHeight; camera.bottom = midY - halfHeight;
    }
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  function resize(): void {
    if (disposed || !available || !renderer) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const next = { width: rect.width, height: rect.height };
    const ratio = Math.min(2, window.devicePixelRatio || 1, 4096 / next.width, 4096 / next.height);
    if (viewport.width !== next.width || viewport.height !== next.height || renderer.getPixelRatio() !== ratio) {
      cancelInteraction();
      viewport = next;
      renderer.setPixelRatio(ratio);
      renderer.setSize(viewport.width, viewport.height, false);
      fitCamera();
      requestDraw();
    }
  }

  function ray(event: PointerEvent): boolean {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = (event.clientX - rect.left) / rect.width * 2 - 1;
    const y = 1 - (event.clientY - rect.top) / rect.height * 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(new Vector2(x, y), camera);
    return true;
  }

  function gestureIsCurrent(active: Gesture): boolean {
    const snapshot = state.snapshot;
    const item = snapshot.workingState.furniture.find((candidate) => candidate.id === active.item.id);
    return available && !disposed && state.viewMode !== "precision-2d" && !snapshot.preview && snapshot.activeTemplateId === active.baseTemplateId && snapshot.baseRevision === active.baseRevision && snapshot.baseHash === active.baseHash && Boolean(item && !item.locked);
  }

  function pointerDown(event: PointerEvent): void {
    if (disposed || !available || gesture || event.button !== 0 || !event.isPrimary || state.viewMode === "precision-2d" || !ray(event)) return;
    const hit = raycaster.intersectObjects(currentGroup.children, true).find((intersection) => intersection.object instanceof Mesh);
    let node: Object3D | null = hit?.object ?? null;
    while (node && typeof node.userData.itemId !== "string") node = node.parent;
    const id = node?.userData.itemId as string | undefined;
    const item = state.snapshot.workingState.furniture.find((candidate) => candidate.id === id);
    const origin = raycaster.ray.intersectPlane(floor, floorTarget);
    const capturedState = state;
    const generation = gestureGeneration;
    const floorPoint = origin ? { x: origin.x, z: origin.z } : null;
    callbacks.onSelect(item?.id ?? null);
    if (!item || !floorPoint || disposed || generation !== gestureGeneration || !sameBase(capturedState, state) || state.snapshot.preview || item.locked) return;
    const current = state.snapshot.workingState.furniture.find((candidate) => candidate.id === item.id);
    if (!current || current.locked) return;
    try { canvas.setPointerCapture(event.pointerId); } catch { return; }
    gesture = { pointerId: event.pointerId, startClientX: event.clientX, startClientY: event.clientY, item: current, candidate: current, grabOffset: { xMm: floorPoint.x * 1000 - current.xMm, yMm: floorPoint.z * 1000 - current.yMm }, baseTemplateId: state.snapshot.activeTemplateId, baseRevision: state.snapshot.baseRevision, baseHash: state.snapshot.baseHash };
    canvas.style.cursor = "grabbing";
    event.preventDefault();
  }

  function pointerMove(event: PointerEvent): void {
    const active = gesture;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!gestureIsCurrent(active) || !canvas.hasPointerCapture(event.pointerId) || !ray(event)) { cancelInteraction(); return; }
    const point = raycaster.ray.intersectPlane(floor, floorTarget);
    const snapped = point ? floorPointToSnappedMm(point, active.grabOffset) : null;
    if (!snapped) { cancelInteraction(); return; }
    // A click or tiny pointer jitter must not snap an exact numeric placement.
    active.candidate = Math.hypot(event.clientX - active.startClientX, event.clientY - active.startClientY) <= 3 ? active.item : { ...snapped, rotationDeg: active.item.rotationDeg };
    const pose = domainPoseToWorld(active.candidate);
    itemGroups.get(active.item.id)?.position.set(pose.x, 0, pose.z);
    requestDraw();
    event.preventDefault();
  }

  function pointerUp(event: PointerEvent): void {
    const active = gesture;
    if (!active || event.pointerId !== active.pointerId) return;
    const valid = gestureIsCurrent(active) && canvas.hasPointerCapture(event.pointerId);
    const changed = active.item.xMm !== active.candidate.xMm || active.item.yMm !== active.candidate.yMm;
    cancelInteraction();
    // Do not optimistically leave the requested pose on screen or treat a void callback as success.
    drawNow();
    if (valid && changed && !disposed && available) callbacks.onPoseRequest({ itemId: active.item.id, pose: active.candidate, baseTemplateId: active.baseTemplateId, baseRevision: active.baseRevision, baseHash: active.baseHash });
  }

  function pointerCancel(event: PointerEvent): void {
    if (gesture?.pointerId === event.pointerId) cancelInteraction();
  }

  function contextLost(event: Event): void {
    event.preventDefault();
    unavailable("The WebGL2 context was lost. Continue in Precision 2D; reload to retry spatial rendering.");
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerCancel);
  canvas.addEventListener("lostpointercapture", pointerCancel);
  canvas.addEventListener("webglcontextlost", contextLost);
  window.addEventListener("resize", resize);

  const handle = Object.freeze({
    update(next: SpatialViewState): void {
      if (disposed) return;
      const baseChanged = !sameBase(state, next);
      const previewChanged = !samePreview(state, next);
      const viewChanged = state.viewMode !== next.viewMode;
      const resetChanged = state.cameraResetVersion !== next.cameraResetVersion;
      const roomChanged = state.snapshot.workingState.room.widthMm !== next.snapshot.workingState.room.widthMm || state.snapshot.workingState.room.depthMm !== next.snapshot.workingState.room.depthMm;
      const selectionChanged = state.selectedItemId !== next.selectedItemId;
      if (baseChanged || previewChanged || viewChanged || resetChanged) cancelInteraction();
      state = next;
      if (!available) return;
      if (baseChanged || viewChanged) buildRoom(state.snapshot.workingState);
      if (baseChanged || previewChanged || selectionChanged) buildFurniture();
      if (roomChanged || viewChanged || resetChanged) fitCamera();
      resize();
      requestDraw();
    },
    cancelInteraction,
    dispose(): void {
      if (disposed) return;
      cancelInteraction();
      disposed = true;
      available = false;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerCancel);
      canvas.removeEventListener("lostpointercapture", pointerCancel);
      canvas.removeEventListener("webglcontextlost", contextLost);
      releaseObjects(roomGroup); releaseObjects(currentGroup); releaseObjects(previewGroup);
      itemGroups.clear();
      sunlight.dispose(); fill.dispose(); hemisphere.dispose();
      renderer?.dispose();
      renderer = null;
      scene.clear();
      canvas.remove();
    },
  });

  queueMicrotask(() => {
    if (disposed) return;
    callbacks.onAvailabilityChange({ state: "initializing", message: "Preparing the spatial room view…" });
    if (disposed) return;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "low-power" });
      available = true;
      buildRoom(state.snapshot.workingState);
      buildFurniture();
      fitCamera();
      resize();
      if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host); }
      drawNow();
      if (!disposed && available) callbacks.onAvailabilityChange({ state: "available", message: "Spatial view ready. Select and drag furniture; use the inspector for exact measurements." });
    } catch {
      unavailable("WebGL2 is unavailable. Precision 2D and numeric editing remain fully usable.");
    }
  });
  return handle;
};
