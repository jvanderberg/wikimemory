import { z } from "zod";
import { MCP_OUTPUT_SCHEMAS } from "../src/mcp/schemas";

describe("MCP structured output contracts", () => {
  const schema = (shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> => z.object(shape);

  it("requires object envelopes for array-valued tools", () => {
    expect(schema(MCP_OUTPUT_SCHEMAS.recall).safeParse([]).success).toBe(false);
    expect(schema(MCP_OUTPUT_SCHEMAS.history).safeParse([]).success).toBe(false);
    expect(schema(MCP_OUTPUT_SCHEMAS.lint).safeParse([]).success).toBe(false);

    expect(schema(MCP_OUTPUT_SCHEMAS.recall).safeParse({ hits: [] }).success).toBe(true);
    expect(schema(MCP_OUTPUT_SCHEMAS.history).safeParse({ revisions: [] }).success).toBe(true);
    expect(schema(MCP_OUTPUT_SCHEMAS.lint).safeParse({ findings: [] }).success).toBe(true);
  });

  it("defines an output object schema for every V1 tool", () => {
    expect(Object.keys(MCP_OUTPUT_SCHEMAS).sort()).toEqual([
      "get", "history", "index", "ingest", "link", "lint", "orient", "recall",
      "restore_apply", "restore_preview"
    ]);
    for (const shape of Object.values(MCP_OUTPUT_SCHEMAS)) {
      expect(schema(shape).def.type).toBe("object");
    }
  });
});
