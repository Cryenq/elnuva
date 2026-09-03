import { BoxGeometry, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial } from "three";
import type { CatalogEntry } from "../domain/types";

/** Original, illustrative furniture. Heights and materials are not domain data. */
export function createFurnitureVisual(entry: CatalogEntry, ghost = false, selected = false): Group {
  const group = new Group();
  const w = entry.widthMm / 1000, d = entry.depthMm / 1000;
  const colors = { oak: 0xc19d76, edge: 0x876d54, cream: 0xe9e3d7, sage: 0x78958a, dark: 0x36474a, linen: 0xd3c5b6, blue: 0x82999f, ghost: 0xdb843d };
  const materials = new Map<number, MeshStandardMaterial>();
  const material = (color: number): MeshStandardMaterial => {
    const key = ghost ? colors.ghost : color;
    let value = materials.get(key);
    if (!value) {
      value = new MeshStandardMaterial({ color: key, roughness: 0.88, metalness: 0, transparent: ghost, opacity: ghost ? 0.24 : 1, depthWrite: !ghost });
      materials.set(key, value);
    }
    return value;
  };
  const box = (width: number, height: number, depth: number, x: number, y: number, z: number, color: number): Mesh => {
    const geometry = new BoxGeometry(width, height, depth);
    const mesh = new Mesh(geometry, material(color));
    mesh.position.set(x, y, z);
    group.add(mesh);
    if (ghost) {
      const outline = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: 0x9f551c, transparent: true, opacity: 0.8, depthWrite: false }));
      outline.position.copy(mesh.position);
      group.add(outline);
    }
    return mesh;
  };
  const legs = (height: number, inset = 0.06): void => {
    for (const x of [-w / 2 + inset, w / 2 - inset]) for (const z of [-d / 2 + inset, d / 2 - inset]) box(0.055, height, 0.055, x, height / 2, z, colors.dark);
  };
  switch (entry.kind) {
    case "desk":
      legs(0.7);
      box(w, 0.065, d, 0, 0.735, 0, colors.oak);
      box(0.48, 0.025, 0.18, 0.06, 0.78, -d * 0.12, colors.dark);
      box(0.065, 0.18, 0.05, 0.06, 0.88, -d * 0.22, colors.dark);
      box(0.5, 0.3, 0.035, 0.06, 1.08, -d * 0.22, colors.dark);
      box(0.445, 0.245, 0.012, 0.06, 1.085, -d * 0.22 + 0.025, colors.blue);
      box(0.33, 0.018, 0.12, 0, 0.779, d * 0.24, colors.cream);
      break;
    case "chair":
      legs(0.4, 0.1);
      box(w, 0.1, d, 0, 0.45, 0, colors.sage);
      box(w, 0.43, 0.08, 0, 0.7, -d / 2 + 0.04, colors.sage);
      box(0.045, 0.22, d * 0.65, -w / 2 + 0.025, 0.58, 0.04, colors.dark);
      box(0.045, 0.22, d * 0.65, w / 2 - 0.025, 0.58, 0.04, colors.dark);
      break;
    case "storage":
      box(w, 0.78, d - 0.04, 0, 0.43, -0.02, colors.oak);
      for (const x of [-w / 4, w / 4]) {
        box(w / 2 - 0.025, 0.69, 0.025, x, 0.44, d / 2 - 0.0325, colors.cream);
        box(0.035, 0.12, 0.018, x + (x < 0 ? 0.12 : -0.12), 0.49, d / 2 - 0.009, colors.edge);
      }
      box(w, 0.04, d, 0, 0.84, 0, colors.oak);
      break;
    case "bed":
      box(w, 0.24, d, 0, 0.22, 0, colors.edge);
      box(w - 0.05, 0.2, d - 0.05, 0, 0.44, 0, colors.cream);
      box(0.08, 0.84, d, -w / 2 + 0.04, 0.44, 0, colors.oak);
      box(w * 0.63, 0.055, d - 0.08, w * 0.13, 0.568, 0, colors.sage);
      for (const z of [-d * 0.23, d * 0.23]) box(w * 0.2, 0.09, d * 0.38, -w * 0.32, 0.585, z, colors.linen);
      box(0.22, 0.065, d - 0.07, w * 0.27, 0.604, 0, colors.blue);
      break;
    case "nightstand":
      box(w, 0.5, d - 0.04, 0, 0.28, -0.02, colors.oak);
      for (const y of [0.17, 0.39]) {
        box(w - 0.035, 0.19, 0.02, 0, y, d / 2 - 0.025, colors.cream);
        box(0.1, 0.018, 0.025, 0, y + 0.035, d / 2 - 0.0125, colors.edge);
      }
      box(w, 0.035, d, 0, 0.548, 0, colors.oak);
      break;
    case "wardrobe":
      box(w, 1.85, d - 0.04, 0, 0.97, -0.02, colors.oak);
      for (const x of [-w / 4, w / 4]) {
        box(w / 2 - 0.025, 1.75, 0.02, x, 0.99, d / 2 - 0.025, colors.cream);
        box(0.025, 0.22, 0.024, x + (x < 0 ? w * 0.18 : -w * 0.18), 0.98, d / 2 - 0.012, colors.edge);
      }
      break;
    case "table":
      legs(0.7, 0.09);
      box(w, 0.075, d, 0, 0.735, 0, colors.oak);
      box(0.3, 0.025, 0.22, -w * 0.17, 0.785, 0, colors.sage);
      box(0.27, 0.015, 0.19, -w * 0.17, 0.805, 0, colors.cream);
      break;
    case "bookcase":
      box(w, 1.68, 0.035, 0, 0.88, -d / 2 + 0.018, colors.edge);
      for (const x of [-w / 2 + 0.025, w / 2 - 0.025]) box(0.05, 1.74, d, x, 0.9, 0, colors.oak);
      for (let row = 0; row < 5; row += 1) {
        const y = 0.08 + row * 0.42;
        box(w, 0.04, d, 0, y, 0, colors.oak);
        if (row < 4) for (let book = 0; book < 6; book += 1) {
          const height = 0.22 + ((book + row) % 3) * 0.035;
          box(0.065, height, d * 0.7, -w / 2 + 0.12 + book * 0.105, y + height / 2 + 0.025, 0.015, [colors.sage, colors.linen, colors.blue, colors.cream][(book + row) % 4]);
        }
      }
      break;
  }
  // A footprint outline is always exact, even where legs or decorations are inset.
  const footprint = new BoxGeometry(w, 0.012, d);
  const ring = new LineSegments(new EdgesGeometry(footprint), new LineBasicMaterial({ color: ghost ? 0x9f551c : selected ? 0x226258 : 0xa59c8e, transparent: !selected && !ghost, opacity: selected || ghost ? 1 : 0.6 }));
  footprint.dispose();
  ring.position.y = 0.012;
  group.add(ring);
  if (selected && !ghost) {
    // Corner markers are solid geometry rather than unsupported wide WebGL lines.
    for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) {
      box(0.11, 0.016, 0.025, x + (x < 0 ? 0.043 : -0.043), 0.021, z, 0x226258);
      box(0.025, 0.016, 0.11, x, 0.021, z + (z < 0 ? 0.043 : -0.043), 0x226258);
    }
  }
  return group;
}
