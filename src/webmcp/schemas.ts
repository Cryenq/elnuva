export const INSPECT_SPATIAL_LAYOUT_INPUT_SCHEMA = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({}),
  additionalProperties: false as const,
});

export function isInspectSpatialLayoutInput(input: unknown): input is Record<string, never> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(input);
    return (
      (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(input).length === 0
    );
  } catch {
    return false;
  }
}
