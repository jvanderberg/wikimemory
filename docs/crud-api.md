# Wikimemory CRUD API

The versioned JSON API under `/api/v1` is the foundation for backups and custom
importers. Its machine-readable contract is [`openapi.yaml`](openapi.yaml), with the
revision write schema also available as
[`admin-revision-v1.schema.json`](schemas/admin-revision-v1.schema.json).

Reads require `memory:read`. Every mutation requires `memory:admin`; MCP's narrower
`memory:write` authority cannot use CRUD writes. Authorize the packaged client with:

```sh
npx wikimemory api login --deployment NAME
```

OAuth credentials are stored with owner-only permissions. For ephemeral automation,
`WIKIMEMORY_ACCESS_TOKEN` overrides the stored access token.

```text
GET    /api/v1/documents
POST   /api/v1/documents
GET    /api/v1/documents/{slug}
PUT    /api/v1/documents/{slug}
DELETE /api/v1/documents/{slug}?confirm={slug}
GET    /api/v1/documents/{slug}/revisions
POST   /api/v1/documents/{slug}/revisions
GET    /api/v1/documents/{slug}/revisions/{revisionId}
GET    /api/v1/metadata
GET    /api/v1/links
```

Create identities before revisions so cyclic link targets exist before history is
replayed. Revision writes are complete immutable snapshots: content, source timestamp
and actor, metadata cardinality, and links. Revision number and parent must extend the
chain exactly. An `operationId` makes identical replay safe and rejects altered replay.
Server audit events separately identify the authenticated administrator.
`DELETE` permanently purges a document and requires a recently authorized owner token.

## Custom importer

```ts
import { localWikimemoryClient } from "wikimemory/local-client";

const api = await localWikimemoryClient();
const document = await api.createDocument({ slug: "imported-note", type: "note" });
await api.appendRevision(document.slug, {
  operationId: "my-import:imported-note:1",
  revisionNumber: 1,
  parentRevisionId: null,
  title: "Imported note",
  body: "Imported body",
  summary: null,
  createdAt: "2025-01-01T00:00:00Z",
  sourceActor: "custom-importer",
  reason: "Import source revision 1",
  metadata: [{ key: "tag", value: "imported", cardinality: "multi" }],
  links: []
});
```

Pass a deployment name to `localWikimemoryClient("NAME")` when it is not the default.
The lower-level `WikimemoryClient` export accepts an origin and bearer token for other
environments. An LLM can write a source-specific converter using either client or the
OpenAPI contract.
