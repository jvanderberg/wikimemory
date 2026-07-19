import { DomainError, isDomainError } from "../src/domain/errors";
import { isMemoryScope, isRecord } from "../src/domain/guards";

describe("shared runtime guards", () => {
  it("distinguishes records from null, arrays, and primitives", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("value")).toBe(false);
  });

  it("accepts only the three supported memory scopes", () => {
    expect(isMemoryScope("memory:read")).toBe(true);
    expect(isMemoryScope("memory:write")).toBe(true);
    expect(isMemoryScope("memory:admin")).toBe(true);
    expect(isMemoryScope("memory:delete")).toBe(false);
  });

  it("identifies domain errors without accepting ordinary errors", () => {
    expect(isDomainError(new DomainError("not_found", "missing"))).toBe(true);
    expect(isDomainError(new Error("missing"))).toBe(false);
  });
});
