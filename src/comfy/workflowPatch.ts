function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function getPointerSegments(pointer: string): string[] {
  const normalized = String(pointer ?? "").trim();
  if (!normalized.startsWith("/")) {
    throw new Error(`JSON Pointer must start with /: ${pointer}`);
  }
  return normalized
    .split("/")
    .slice(1)
    .map((segment) => decodePointerSegment(segment));
}

export function assertJsonPointerExists(root: unknown, pointer: string): void {
  let current: unknown = root;
  for (const segment of getPointerSegments(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`JSON Pointer does not exist: ${pointer}`);
      }
      current = current[index];
      continue;
    }

    if (current == null || typeof current !== "object" || !(segment in current)) {
      throw new Error(`JSON Pointer does not exist: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
}

export function setJsonPointerValue(root: unknown, pointer: string, value: unknown): void {
  const segments = getPointerSegments(pointer);
  if (segments.length === 0) {
    throw new Error(`JSON Pointer cannot target root: ${pointer}`);
  }

  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment == null) {
      throw new Error(`JSON Pointer does not exist: ${pointer}`);
    }
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
        throw new Error(`JSON Pointer does not exist: ${pointer}`);
      }
      current = current[arrayIndex];
      continue;
    }
    if (current == null || typeof current !== "object" || !(segment in current)) {
      throw new Error(`JSON Pointer does not exist: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  const finalSegment = segments.at(-1);
  if (finalSegment == null) {
    throw new Error(`JSON Pointer does not exist: ${pointer}`);
  }
  if (Array.isArray(current)) {
    const arrayIndex = Number(finalSegment);
    if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) {
      throw new Error(`JSON Pointer does not exist: ${pointer}`);
    }
    current[arrayIndex] = value;
    return;
  }

  if (current == null || typeof current !== "object" || !(finalSegment in current)) {
    throw new Error(`JSON Pointer does not exist: ${pointer}`);
  }
  (current as Record<string, unknown>)[finalSegment] = value;
}
