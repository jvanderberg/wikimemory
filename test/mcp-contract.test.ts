import { z } from "zod";
import { MCP_OUTPUT_SCHEMAS } from "../src/mcp/schemas";

describe("MCP structured output contracts", () => {
  const schema = (shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> => z.object(shape);

  it("requires object envelopes for array-valued tools", () => {
    expect(schema(MCP_OUTPUT_SCHEMAS.recall).safeParse([]).success).toBe(false);
    expect(schema(MCP_OUTPUT_SCHEMAS.history).safeParse([]).success).toBe(false);
    expect(schema(MCP_OUTPUT_SCHEMAS.lint).safeParse([]).success).toBe(false);

    expect(
      schema(MCP_OUTPUT_SCHEMAS.recall).safeParse({
        hits: [],
        storedContentTrust: "untrusted"
      }).success
    ).toBe(true);
    expect(
      schema(MCP_OUTPUT_SCHEMAS.history).safeParse({
        revisions: [],
        storedContentTrust: "untrusted"
      }).success
    ).toBe(true);
    expect(schema(MCP_OUTPUT_SCHEMAS.lint).safeParse({ findings: [] }).success).toBe(true);
  });

  it("defines an output object schema for every V1 tool", () => {
    expect(Object.keys(MCP_OUTPUT_SCHEMAS).sort()).toEqual([
      "archive",
      "get",
      "history",
      "index",
      "ingest",
      "link",
      "lint",
      "orient",
      "recall",
      "restore_apply",
      "restore_preview"
    ]);
    for (const shape of Object.values(MCP_OUTPUT_SCHEMAS)) {
      expect(schema(shape).def.type).toBe("object");
    }
  });

  it("marks structured read content as untrusted and describes restore differences", () => {
    expect(
      schema(MCP_OUTPUT_SCHEMAS.get).safeParse({
        documentId: "document",
        workspaceId: "workspace",
        slug: "page",
        type: "note",
        revisionId: "revision",
        revisionNumber: 1,
        parentRevisionId: null,
        title: "Title",
        body: "Body",
        summary: null,
        createdAt: "2026-07-19T00:00:00Z",
        principalId: "principal",
        clientId: "client",
        agentLabel: null,
        reason: "Reason",
        restoredFromRevisionId: null,
        metadata: [],
        links: [],
        nextCursor: null,
        storedContentTrust: "untrusted",
        linkResolution: "current_workspace_state"
      }).success
    ).toBe(true);

    expect(
      schema(MCP_OUTPUT_SCHEMAS.restore_preview).safeParse({
        slug: "page",
        targetRevisionId: "old",
        expectedCurrentRevisionId: "current",
        titleChanged: false,
        bodyChanged: true,
        summaryChanged: false,
        metadataChanged: false,
        linksChanged: false,
        storedContentTrust: "untrusted",
        differences: [
          {
            field: "body",
            currentPreview: "current body",
            targetPreview: "old body",
            currentCharacters: 12,
            targetCharacters: 8,
            currentTruncated: false,
            targetTruncated: false
          }
        ]
      }).success
    ).toBe(true);
  });
});
