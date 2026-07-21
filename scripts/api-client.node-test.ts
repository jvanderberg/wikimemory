import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WikimemoryApiError, WikimemoryClient } from "./api-client.ts";

await describe("published API client", async () => {
  await it("paginates documents and authenticates every request", async () => {
    const urls: string[] = [];
    const mockFetch: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      urls.push(url);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
      const second = url.includes("after=one");
      return Promise.resolve(
        Response.json({
          items: second
            ? [
                {
                  documentId: "two-id",
                  workspaceId: "workspace",
                  slug: "two",
                  type: "note",
                  createdAt: "2026-01-01T00:00:00Z"
                }
              ]
            : [
                {
                  documentId: "one-id",
                  workspaceId: "workspace",
                  slug: "one",
                  type: "note",
                  createdAt: "2026-01-01T00:00:00Z"
                }
              ],
          next: second ? null : "one"
        })
      );
    };
    const client = new WikimemoryClient("https://memory.example/", "token", mockFetch);
    assert.deepEqual(
      (await client.listDocuments()).map((document) => document.slug),
      ["one", "two"]
    );
    assert.equal(urls.length, 2);
  });

  await it("rejects malformed success payloads and reports API failures", async () => {
    const malformed: typeof fetch = () => Promise.resolve(Response.json({ items: [], next: 1 }));
    await assert.rejects(
      () => new WikimemoryClient("https://memory.example", "token", malformed).listDocuments(),
      /Invalid input/u
    );
    const denied: typeof fetch = () =>
      Promise.resolve(
        Response.json({ error: "forbidden", message: "Missing admin scope" }, { status: 403 })
      );
    await assert.rejects(
      () =>
        new WikimemoryClient("https://memory.example", "token", denied).createDocument({
          slug: "test",
          type: "note"
        }),
      (error) => error instanceof WikimemoryApiError && error.status === 403
    );
  });
});
