import type { DocumentSnapshot } from "./types.js";

export const STARTER_PAGES = {
  home: {
    slug: "home",
    type: "system",
    title: "Wikimemory home",
    summary: "Standard orientation page.",
    body: "# Wikimemory\n\nThe database is authoritative. See [[now]] for current focus."
  },
  now: {
    slug: "now",
    type: "system",
    title: "Now",
    summary: "Current focus and active threads.",
    body: "# Now\n\n_(No active work has been recorded yet.)_"
  }
} as const;

export type StarterSlug = keyof typeof STARTER_PAGES;

export function isStarterRevision(slug: StarterSlug, revision: DocumentSnapshot): boolean {
  const page = STARTER_PAGES[slug];
  const firstLink = revision.links.at(0);
  const linksMatch =
    slug === "home"
      ? firstLink !== undefined &&
        revision.links.length === 1 &&
        firstLink.kind === "related" &&
        firstLink.targetSlug === "now" &&
        firstLink.origin === "body"
      : revision.links.length === 0;
  return (
    revision.slug === page.slug &&
    revision.type === page.type &&
    revision.revisionNumber === 1 &&
    revision.parentRevisionId === null &&
    revision.restoredFromRevisionId === null &&
    revision.title === page.title &&
    revision.summary === page.summary &&
    revision.body === page.body &&
    revision.metadata.length === 0 &&
    linksMatch
  );
}
