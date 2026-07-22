import { isStarterRevision, STARTER_PAGES } from "../src/domain/starter-content";
import type { DocumentSnapshot } from "../src/domain/types";

function starter(slug: "home" | "now"): DocumentSnapshot {
  const page = STARTER_PAGES[slug];
  return {
    documentId: `seed-${slug}`,
    workspaceId: "workspace",
    slug,
    type: "system",
    revisionId: `seed-${slug}-revision`,
    revisionNumber: 1,
    parentRevisionId: null,
    title: page.title,
    body: page.body,
    summary: page.summary,
    createdAt: "2026-01-01T00:00:00Z",
    principalId: "owner",
    clientId: "client",
    agentLabel: "system",
    reason: "seed",
    restoredFromRevisionId: null,
    metadata: [],
    links:
      slug === "home"
        ? [
            {
              kind: "related",
              targetSlug: "now",
              targetDocumentId: "seed-now",
              origin: "body"
            }
          ]
        : []
  };
}

describe("starter content recognition", () => {
  it("accepts only the exact generated home and now revisions", () => {
    expect(isStarterRevision("home", starter("home"))).toBe(true);
    expect(isStarterRevision("now", starter("now"))).toBe(true);

    const changed = starter("home");
    changed.body = "Owner-edited content";
    expect(isStarterRevision("home", changed)).toBe(false);

    const extraMetadata = starter("now");
    extraMetadata.metadata = [{ key: "tag", value: "edited", cardinality: "multi" }];
    expect(isStarterRevision("now", extraMetadata)).toBe(false);
  });

  it("rejects changed history or generated links", () => {
    const laterRevision = starter("home");
    laterRevision.revisionNumber = 2;
    expect(isStarterRevision("home", laterRevision)).toBe(false);

    const missingLink = starter("home");
    missingLink.links = [];
    expect(isStarterRevision("home", missingLink)).toBe(false);

    const wrongLink = starter("home");
    wrongLink.links = [
      {
        kind: "related",
        targetSlug: "elsewhere",
        targetDocumentId: "seed-now",
        origin: "body"
      }
    ];
    expect(isStarterRevision("home", wrongLink)).toBe(false);

    const linkedNow = starter("now");
    linkedNow.links = starter("home").links;
    expect(isStarterRevision("now", linkedNow)).toBe(false);
  });
});
