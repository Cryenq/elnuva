import { describe, expect, it } from "vitest";
import { domainPoseToWorld, fitTopCamera, floorPointToSnappedMm, projectTopPoint } from "../../src/ui/spatial-projection";
import type { RotationDeg } from "../../src/domain/types";

describe("T09 independent spatial coordinate oracles", () => {
  it.each([0, 90, 180, 270] as const)("maps millimetres and clockwise %i degrees to negative world Y yaw", rotationDeg => {
    const result = domainPoseToWorld({ xMm: 1901, yMm: 1301, rotationDeg });
    expect(result.x).toBe(1.901);
    expect(result.z).toBe(1.301);
    expect(result.rotationY).toBeCloseTo(-rotationDeg * Math.PI / 180, 14);
  });

  // Independent asymmetric 1800x800 rectangle: a clockwise quarter turn sends
  // its local (+900,+400) corner to (-400,+900), not (+400,-900).
  it.each([
    [0, 2.9, 1.4], [90, 1.6, 1.9], [180, 1.1, 0.6], [270, 2.4, 0.1],
  ] as const)("preserves asymmetric footprint orientation at %i degrees", (rotation, expectedX, expectedZ) => {
    const pose = domainPoseToWorld({ xMm: 2000, yMm: 1000, rotationDeg: rotation as RotationDeg });
    const x = pose.x + Math.cos(pose.rotationY) * 0.9 + Math.sin(pose.rotationY) * 0.4;
    const z = pose.z - Math.sin(pose.rotationY) * 0.9 + Math.cos(pose.rotationY) * 0.4;
    expect(x).toBeCloseTo(expectedX, 12);
    expect(z).toBeCloseTo(expectedZ, 12);
  });

  it.each([
    [{ x: 2.575, z: 1.325 }, { xMm: 75, yMm: 25 }, { xMm: 2500, yMm: 1300 }],
    [{ x: 2.425, z: 1.275 }, { xMm: -75, yMm: -25 }, { xMm: 2500, yMm: 1300 }],
    [{ x: 2.526, z: 1.324 }, { xMm: 0, yMm: 0 }, { xMm: 2550, yMm: 1300 }],
    [{ x: -0.226, z: 9.126 }, { xMm: 0, yMm: 0 }, { xMm: -250, yMm: 9150 }],
  ] as const)("subtracts grab offset before 50mm snapping without clamping", (point, offset, expected) => {
    expect(floorPointToSnappedMm(point, offset)).toEqual(expected);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite floor/offset components %s", value => {
    for (const [point, offset] of [
      [{ x: value, z: 1 }, { xMm: 0, yMm: 0 }],
      [{ x: 1, z: value }, { xMm: 0, yMm: 0 }],
      [{ x: 1, z: 1 }, { xMm: value, yMm: 0 }],
      [{ x: 1, z: 1 }, { xMm: 0, yMm: value }],
    ] as const) expect(floorPointToSnappedMm(point, offset)).toBeNull();
  });

  for (const room of [{ widthMm: 3600, depthMm: 3000 }, { widthMm: 4200, depthMm: 3600 }, { widthMm: 3200, depthMm: 2800 }]) {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 320, height: 568 }]) {
      it(`fits ${room.widthMm}x${room.depthMm} into ${viewport.width}x${viewport.height} with centered margin and correct aspect`, () => {
        const frame = fitTopCamera(room, viewport);
        for (const value of Object.values(frame)) expect(Number.isFinite(value)).toBe(true);
        expect(frame.minX).toBeLessThan(0);
        expect(frame.minZ).toBeLessThan(0);
        expect(frame.maxX).toBeGreaterThan(room.widthMm / 1000);
        expect(frame.maxZ).toBeGreaterThan(room.depthMm / 1000);
        expect((frame.minX + frame.maxX) / 2).toBeCloseTo(room.widthMm / 2000, 12);
        expect((frame.minZ + frame.maxZ) / 2).toBeCloseTo(room.depthMm / 2000, 12);
        expect((frame.maxX - frame.minX) / (frame.maxZ - frame.minZ)).toBeCloseTo(viewport.width / viewport.height, 12);
        const center = projectTopPoint({ xMm: room.widthMm / 2, yMm: room.depthMm / 2 }, frame, viewport);
        expect(center.x).toBeCloseTo(viewport.width / 2, 10);
        expect(center.y).toBeCloseTo(viewport.height / 2, 10);
      });
    }
  }

  it("uses an independent manually specified frame, north up/east right, and CSS rather than device pixels", () => {
    const frame = { minX: -1, maxX: 5, minZ: -1, maxZ: 3 };
    const viewport = { width: 600, height: 400 };
    expect(projectTopPoint({ xMm: -1000, yMm: -1000 }, frame, viewport)).toEqual({ x: 0, y: 0 });
    expect(projectTopPoint({ xMm: 5000, yMm: 3000 }, frame, viewport)).toEqual({ x: 600, y: 400 });
    expect(projectTopPoint({ xMm: 2000, yMm: 1000 }, frame, viewport)).toEqual({ x: 300, y: 200 });
    expect(projectTopPoint({ xMm: 0, yMm: 0 }, frame, viewport)).toEqual({ x: 100, y: 100 });
    expect(projectTopPoint({ xMm: 0, yMm: 0 }, frame, { width: 300, height: 800 })).toEqual({ x: 50, y: 200 });
  });
});
