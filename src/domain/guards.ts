import type { MemoryScope } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMemoryScope(value: string): value is MemoryScope {
  return value === "memory:read" || value === "memory:write" || value === "memory:admin";
}
