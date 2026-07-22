import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { App, AppErrorBoundary } from "../src/main";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input, location.origin);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function session(environment: "local" | "production", authenticated = true): object {
  return {
    authenticated,
    environment,
    ...(authenticated ? {} : { loginUrl: "/app/login" })
  };
}

test.afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

test("shows a useful fallback when browser rendering fails", async () => {
  function Broken(): React.JSX.Element {
    throw new Error("Safari rendering failure");
  }
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await render(
    <AppErrorBoundary>
      <Broken />
    </AppErrorBoundary>
  );
  await expect
    .element(
      page.getByText("This browser could not start Wikimemory. Reload the page or update Safari.")
    )
    .toBeVisible();
});

test("signs in as the local owner and browses documents", async () => {
  history.replaceState(null, "", "/app");
  let authenticated = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local", authenticated));
    if (url.pathname === "/api/app/login") {
      authenticated = true;
      return response({ ok: true });
    }
    if (url.pathname === "/api/app/documents")
      return response({
        items: [
          {
            slug: "active-project",
            type: "project",
            title: "Active project",
            summary: "Current project summary",
            status: "active",
            project: null
          },
          {
            slug: "unsummarized-note",
            type: "note",
            title: "Unsummarized note",
            summary: null,
            project: "active-project"
          },
          {
            slug: "unfiled-source",
            type: "source",
            title: "Unfiled source",
            summary: "Outside a project",
            project: null
          }
        ]
      });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  const login = page.getByRole("button", { name: "Continue as local test owner" });
  await expect.element(login).toBeVisible();
  await login.click();
  await expect.element(page.getByRole("heading", { name: "Browse memory" })).toBeVisible();
  await expect.element(page.getByText("Current project summary")).toBeVisible();
  await expect.element(page.getByText("No summary")).toBeVisible();
  await expect.element(page.getByText("active", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Unfiled", exact: true })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Sources" })).toBeVisible();
});

test("shows production sign-in and a session loading error", async () => {
  history.replaceState(null, "", "/app");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response(session("production", false)));
  const signedOut = await render(<App />);
  await expect
    .element(signedOut.getByRole("link", { name: "Continue with passkey" }))
    .toHaveAttribute("href", "/app/login");
  await expect.poll(() => getComputedStyle(document.body).margin).toBe("0px");

  await signedOut.unmount();
  vi.mocked(fetch).mockResolvedValue(response({ error: "session unavailable" }, 503));
  await render(<App />);
  await expect.element(page.getByText("session unavailable")).toBeVisible();
});

test("reports a rejected local-owner login", async () => {
  history.replaceState(null, "", "/app");
  let attempts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local", false));
    if (url.pathname === "/api/app/login") {
      attempts += 1;
      return response(attempts === 1 ? {} : "refused", 403);
    }
    return response({}, 500);
  });
  await render(<App />);
  await page.getByRole("button", { name: "Continue as local test owner" }).click();
  await expect.element(page.getByText("HTTP 403")).toBeVisible();
  await page.getByRole("button", { name: "Continue as local test owner" }).click();
  await expect.element(page.getByText("HTTP 403")).toBeVisible();
});

test("submits a search and renders an empty result", async () => {
  history.replaceState(null, "", "/app/search");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    if (url.pathname === "/api/app/search") return response({ hits: [] });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  const input = page.getByPlaceholder("Search durable memory…");
  await input.fill("missing topic");
  await page.getByRole("button", { name: "Search" }).click();
  await expect.element(page.getByText("No documents found.")).toBeVisible();
});

test("loads a search from the URL and renders matching cards", async () => {
  history.replaceState(null, "", "/app/search?q=coverage");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    if (url.pathname === "/api/app/search")
      return response({
        hits: [
          {
            slug: "coverage-project",
            type: "project",
            title: "Coverage project",
            summary: "Raises behavioral confidence",
            status: null,
            snippet: "Coverage project context"
          }
        ]
      });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await expect.element(page.getByPlaceholder("Search durable memory…")).toHaveValue("coverage");
  await expect.element(page.getByText("Raises behavioral confidence")).toBeVisible();
});

test("renders recent revisions", async () => {
  history.replaceState(null, "", "/app/history");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    if (url.pathname === "/api/app/recent")
      return response({
        revisions: [
          {
            slug: "coverage-project",
            type: "project",
            revision_id: "revision-2",
            revision_number: 2,
            title: "Coverage project",
            summary: "Coverage status",
            created_at: "2026-07-19T12:00:00Z",
            reason: "raise coverage"
          }
        ]
      });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await expect.element(page.getByText("coverage-project revision 2")).toBeVisible();
  await expect.element(page.getByText(/raise coverage/u)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "List view" }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Icon view" }).click();
  await expect.element(page.getByRole("heading", { name: "Coverage project" })).toBeVisible();
  await expect.element(page.getByText("Coverage status")).toBeVisible();
  await page.getByRole("button", { name: "List view" }).click();
  await expect.element(page.getByText("coverage-project revision 2")).toBeVisible();
});

test("renders a historical document with metadata and restore control", async () => {
  history.replaceState(null, "", "/app/docs/coverage-project?revision=revision-1");
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    if (url.pathname === "/api/app/docs/coverage-project")
      return response({
        document: {
          revisionId: "revision-1",
          revisionNumber: 1,
          slug: "coverage-project",
          type: "project",
          title: "Coverage project",
          summary: null,
          body: "## Historical section\n\n**Historical body** is rendered as Markdown.",
          createdAt: "2026-07-19T11:00:00Z",
          metadata: [{ key: "status", value: "active" }]
        },
        current: { revisionId: "revision-2" },
        history: [
          {
            revisionId: "revision-1",
            revisionNumber: 1,
            createdAt: "2026-07-19T11:00:00Z",
            reason: "create project"
          }
        ]
      });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await expect.element(page.getByRole("heading", { name: "Coverage project" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Historical section" })).toBeVisible();
  await expect.element(page.getByText("Historical body", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Rendered" }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Raw" }).click();
  await expect
    .element(
      page.getByText("## Historical section\n\n**Historical body** is rendered as Markdown.")
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Rendered" }).click();
  await expect.element(page.getByRole("heading", { name: "Historical section" })).toBeVisible();
  await page.getByRole("button", { name: "Copy Markdown" }).click();
  expect(writeText).toHaveBeenCalledWith(
    "## Historical section\n\n**Historical body** is rendered as Markdown."
  );
  await expect.element(page.getByText("Markdown copied.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Restore this revision" })).toBeVisible();
  await expect.element(page.getByText("status")).toBeVisible();
  await expect.element(page.getByText("coverage-project", { exact: true })).toBeVisible();
});

test("renders current-document and document-error states", async () => {
  history.replaceState(null, "", "/app/docs/current-document");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    if (url.pathname === "/api/app/docs/current-document")
      return response({
        document: {
          revisionId: "current-revision",
          revisionNumber: 3,
          slug: "current-document",
          type: "note",
          title: "Current document",
          summary: "Current summary",
          body: "Current body",
          createdAt: "2026-07-19T12:00:00Z",
          metadata: []
        },
        current: null,
        history: []
      });
    return response({ error: "unexpected request" }, 500);
  });
  const current = await render(<App />);
  await expect.element(page.getByText("Current summary")).toBeVisible();
  await expect.element(page.getByText("Current body")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Restore this revision" }))
    .not.toBeInTheDocument();
  await current.unmount();

  history.replaceState(null, "", "/app/docs/missing-document");
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    return response({ message: "Document does not exist" }, 404);
  });
  await render(<App />);
  await expect.element(page.getByRole("heading", { name: "Document unavailable" })).toBeVisible();
  await expect.element(page.getByText("Document does not exist")).toBeVisible();
});

test("renders production passkey, client, session, and backup management", async () => {
  history.replaceState(null, "", "/app/manage");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("production"));
    if (url.pathname === "/api/app/manage")
      return response({
        passkeys: [
          {
            credentialRef: "a".repeat(64),
            label: "Password manager",
            deviceType: "multiDevice",
            backedUp: true,
            createdAt: "2026-07-19T10:00:00Z",
            lastUsedAt: "2026-07-19T12:00:00Z"
          }
        ],
        clients: [
          {
            id: "grant-1",
            clientName: "Codex CLI",
            scope: ["memory:read", "memory:write"],
            createdAt: "2026-07-19T09:00:00Z"
          }
        ],
        sessions: [
          {
            sessionRef: "b".repeat(64),
            authenticatedAt: "2026-07-19T12:00:00Z",
            createdAt: "2026-07-19T12:00:00Z",
            current: true
          }
        ],
        restoreConfirmation: "wikimemory"
      });
    return response({ ok: true });
  });

  await render(<App />);
  await expect.element(page.getByRole("heading", { name: "Manage Wikimemory" })).toBeVisible();
  await expect.element(page.getByText("Password manager")).toBeVisible();
  await expect.element(page.getByText(/backed up/u)).toBeVisible();
  await expect.element(page.getByText("Codex CLI")).toBeVisible();
  await expect.element(page.getByText("Current browser")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Revoke" }).first()).toBeDisabled();
});

test("revokes a passkey from a multi-credential management view", async () => {
  history.replaceState(null, "", "/app/manage");
  let revoked = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("production"));
    if (url.pathname === "/api/app/passkeys") {
      revoked = true;
      return response({ revoked: "a".repeat(64), sessionCleanupComplete: false });
    }
    if (url.pathname === "/api/app/manage")
      return response({
        passkeys: revoked
          ? [
              {
                credentialRef: "b".repeat(64),
                label: "Phone",
                deviceType: "singleDevice",
                backedUp: false,
                createdAt: "2026-07-19T11:00:00Z",
                lastUsedAt: null
              }
            ]
          : [
              {
                credentialRef: "a".repeat(64),
                label: "Old laptop",
                deviceType: "singleDevice",
                backedUp: false,
                createdAt: "2026-07-19T10:00:00Z",
                lastUsedAt: null
              },
              {
                credentialRef: "b".repeat(64),
                label: "Phone",
                deviceType: "singleDevice",
                backedUp: false,
                createdAt: "2026-07-19T11:00:00Z",
                lastUsedAt: null
              }
            ],
        clients: [],
        sessions: [
          {
            sessionRef: "c".repeat(64),
            authenticatedAt: "2026-07-19T11:00:00Z",
            createdAt: "2026-07-19T11:00:00Z",
            current: false
          }
        ],
        restoreConfirmation: "wikimemory"
      });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await expect.element(page.getByText("not backed up", { exact: false }).first()).toBeVisible();
  await expect.element(page.getByText("Browser session", { exact: true })).toBeVisible();
  const revoke = page.getByRole("button", { name: "Revoke" }).first();
  await expect.element(revoke).toBeEnabled();
  await revoke.click();
  await expect
    .element(page.getByText(/Passkey revoked\. Browser-session cleanup could not be confirmed/u))
    .toBeVisible();
  await expect.element(page.getByText("Old laptop")).not.toBeInTheDocument();
});

test("renders local management without passkey controls", async () => {
  history.replaceState(null, "", "/app/manage");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    return response({
      passkeys: [],
      clients: [],
      sessions: [],
      restoreConfirmation: "wikimemory-local"
    });
  });
  await render(<App />);
  await expect
    .element(page.getByText("Passkey management is disabled for the fake local owner."))
    .toBeVisible();
});

test("downloads, inspects, and restores a backup from management", async () => {
  history.replaceState(null, "", "/app/manage");
  const uploads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    if (url.pathname === "/api/app/manage")
      return response({
        passkeys: [],
        clients: [],
        sessions: [],
        restoreConfirmation: "wikimemory-local"
      });
    if (url.pathname === "/api/app/restore/preview") {
      expect(init?.body).toBeInstanceOf(FormData);
      uploads.push("preview");
      return response({
        manifest: {
          formatVersion: 1,
          createdAt: "2026-07-21T12:00:00Z",
          counts: { documents: 2, revisions: 4 }
        },
        preview: {
          documents: 2,
          revisions: 4,
          newDocuments: 1,
          matchingDocuments: 1,
          newRevisions: 2,
          replacesStarterContent: true,
          conflicts: []
        }
      });
    }
    if (url.pathname === "/api/app/restore") {
      expect(init?.body).toBeInstanceOf(FormData);
      uploads.push("restore");
      return response({ restored: true, documents: 2, newRevisions: 2 });
    }
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await expect
    .element(page.getByRole("link", { name: "Download complete backup" }))
    .toHaveAttribute("href", "/api/app/backup");
  await page
    .getByLabelText("Backup file")
    .upload(new File(["archive"], "test.wmem.zip", { type: "application/zip" }));
  await page.getByRole("button", { name: "Inspect backup" }).click();
  await expect.element(page.getByText("No conflicts found.")).toBeVisible();
  await expect.element(page.getByText(/2 documents, 4 revisions/u)).toBeVisible();
  await page.getByRole("button", { name: "Restore backup" }).click();
  await expect
    .element(page.getByText("Backup restored: 2 documents and 2 new revisions."))
    .toBeVisible();
  expect(uploads).toEqual(["preview", "restore"]);
});

test("requires explicit confirmation before replacing conflicting content", async () => {
  history.replaceState(null, "", "/app/manage");
  const replacements: FormData[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("local"));
    if (url.pathname === "/api/app/manage")
      return response({
        passkeys: [],
        clients: [],
        sessions: [],
        restoreConfirmation: "wikimemory-local"
      });
    if (url.pathname === "/api/app/restore/preview")
      return response({
        manifest: {
          formatVersion: 1,
          createdAt: "2026-07-21T12:00:00Z",
          counts: { documents: 1, revisions: 1 }
        },
        preview: {
          documents: 1,
          revisions: 1,
          newDocuments: 0,
          matchingDocuments: 0,
          newRevisions: 0,
          replacesStarterContent: false,
          conflicts: [{ slug: "home", message: "The target differs." }]
        }
      });
    if (url.pathname === "/api/app/restore") {
      if (init?.body instanceof FormData) replacements.push(init.body);
      return response({ restored: true, documents: 1, newRevisions: 1 });
    }
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await page
    .getByLabelText("Backup file")
    .upload(new File(["archive"], "conflict.wmem.zip", { type: "application/zip" }));
  await page.getByRole("button", { name: "Inspect backup" }).click();
  await expect.element(page.getByText("home", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Restore backup" })).toBeDisabled();
  await page.getByLabelText("Replace every existing document before restoring").click();
  await page.getByLabelText("Type wikimemory-local to confirm").fill("wikimemory-local");
  await page.getByRole("button", { name: "Replace and restore" }).click();
  await expect.poll(() => replacements.at(0)?.get("replace")).toBe("true");
  expect(replacements.at(0)?.get("confirmation")).toBe("wikimemory-local");
});

test("renders login, local authorization, and missing registration token routes", async () => {
  history.replaceState(null, "", "/login?flowId=00000000-0000-4000-8000-000000000000");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response({
      flowId: "00000000-0000-4000-8000-000000000000",
      kind: "mcp",
      options: { challenge: "challenge" },
      clientName: "Claude",
      requestedScopes: ["memory:read"]
    })
  );
  const login = await render(<App />);
  await expect.element(page.getByText("Claude")).toBeVisible();
  await expect.element(page.getByText("memory:read")).toBeVisible();
  await login.unmount();

  history.replaceState(null, "", "/local-authorize?client=coverage");
  vi.mocked(fetch).mockResolvedValue(
    response({ clientName: "Local Codex", requestedScopes: ["memory:read", "memory:write"] })
  );
  const local = await render(<App />);
  await expect.element(page.getByText("Local Codex")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Continue as local test owner" }))
    .toBeEnabled();
  await local.unmount();

  history.replaceState(null, "", "/setup");
  await render(<App />);
  await expect.element(page.getByRole("heading", { name: "Set up Wikimemory" })).toBeVisible();
  await expect.element(page.getByText("The one-time token is missing.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create passkey" })).toBeDisabled();
});

test("renders browser login, add-passkey, and setup-token route variants", async () => {
  history.replaceState(null, "", "/login?flowId=00000000-0000-4000-8000-000000000002");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    response({
      flowId: "00000000-0000-4000-8000-000000000002",
      kind: "web",
      options: { challenge: "challenge" }
    })
  );
  const login = await render(<App />);
  await expect.element(page.getByText("Sign in to browse your memory.")).toBeVisible();
  await login.unmount();

  history.replaceState(null, "", "/passkeys/add#registration-token");
  const add = await render(<App />);
  await expect.element(page.getByRole("heading", { name: "Add a passkey" })).toBeVisible();
  await expect.element(page.getByText(/without removing existing passkeys/u)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create passkey" })).toBeEnabled();
  await add.unmount();

  history.replaceState(null, "", "/setup#setup-token");
  await render(<App />);
  await expect.element(page.getByLabelText("Passkey name")).toHaveValue("Primary passkey");
  await expect.element(page.getByRole("button", { name: "Create passkey" })).toBeEnabled();
});

test("completes browser passkey authentication", async () => {
  history.replaceState(null, "", "/login?flowId=00000000-0000-4000-8000-000000000020");
  vi.mocked(startAuthentication).mockResolvedValue({
    id: "Y3JlZGVudGlhbA",
    rawId: "Y3JlZGVudGlhbA",
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "Y2xpZW50",
      authenticatorData: "YXV0aGVudGljYXRvcg",
      signature: "c2lnbmF0dXJl"
    }
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/auth/options")
      return response({
        flowId: "00000000-0000-4000-8000-000000000020",
        kind: "web",
        options: { challenge: "challenge" }
      });
    if (url.pathname === "/auth/passkey/verify") return response({ redirectTo: "#authorized" });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  const login = page.getByRole("button", { name: "Continue with passkey" });
  await expect.element(login).toBeEnabled();
  await login.click();
  await expect.poll(() => vi.mocked(startAuthentication).mock.calls.length).toBe(1);
  await expect.poll(() => location.hash).toBe("#authorized");
});

test("approves a local MCP authorization", async () => {
  history.replaceState(null, "", "/local-authorize?client=coverage");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/local-authorize/options")
      return response({ clientName: "Local Codex", requestedScopes: ["memory:read"] });
    if (url.pathname === "/api/local-authorize/approve")
      return response({ redirectTo: "#approved" });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  const approve = page.getByRole("button", { name: "Continue as local test owner" });
  await expect.element(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => location.hash).toBe("#approved");
});

test("completes setup registration with the edited passkey label", async () => {
  history.replaceState(null, "", "/setup#setup-token");
  vi.mocked(startRegistration).mockResolvedValue({
    id: "Y3JlZGVudGlhbA",
    rawId: "Y3JlZGVudGlhbA",
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "Y2xpZW50",
      attestationObject: "YXR0ZXN0YXRpb24",
      transports: ["internal"]
    }
  });
  let submittedLabel = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/setup/options") {
      const body: unknown = JSON.parse(String(init?.body));
      if (typeof body === "object" && body !== null && "label" in body) {
        submittedLabel = String(body.label);
      }
      return response({
        flowId: "00000000-0000-4000-8000-000000000021",
        options: {
          challenge: "challenge",
          user: { id: "owner", name: "owner", displayName: "Owner" },
          pubKeyCredParams: []
        }
      });
    }
    if (url.pathname === "/setup/verify") return response({ ok: true, mode: "recovery" });
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await page.getByLabelText("Passkey name").fill("Laptop Touch ID");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect.element(page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
  await expect
    .element(page.getByText(/Previous credentials and sessions were revoked/u))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Continue to Wikimemory" }))
    .toHaveAttribute("href", "/app/login");
  expect(submittedLabel).toBe("Laptop Touch ID");
  expect(startRegistration).toHaveBeenCalledOnce();
});

test("adds a passkey and revokes an MCP grant and browser session", async () => {
  history.replaceState(null, "", "/app/manage");
  const mutations: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/app/session") return response(session("production"));
    if (url.pathname === "/api/app/manage")
      return response({
        passkeys: [
          {
            credentialRef: "a".repeat(64),
            label: "Primary",
            deviceType: "multiDevice",
            backedUp: true,
            createdAt: "2026-07-19T10:00:00Z",
            lastUsedAt: null
          }
        ],
        clients: [
          {
            id: "grant-coverage",
            clientName: "Claude CLI",
            scope: ["memory:read"],
            createdAt: "2026-07-19T10:00:00Z"
          }
        ],
        sessions: [
          {
            sessionRef: "b".repeat(64),
            authenticatedAt: "2026-07-19T11:00:00Z",
            createdAt: "2026-07-19T11:00:00Z",
            current: false
          }
        ],
        restoreConfirmation: "wikimemory"
      });
    if (url.pathname === "/api/app/passkeys") {
      mutations.push(`${init?.method ?? "GET"} passkey`);
      return response({ registrationUrl: "#add-passkey" });
    }
    if (url.pathname === "/api/app/grants") {
      mutations.push(`${init?.method ?? "GET"} grant`);
      return response({ ok: true });
    }
    if (url.pathname === "/api/app/sessions") {
      mutations.push(`${init?.method ?? "GET"} session`);
      return response({ ok: true });
    }
    return response({ error: "unexpected request" }, 500);
  });

  await render(<App />);
  await page.getByLabelText("New passkey name").fill("Phone");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect.poll(() => location.hash).toBe("#add-passkey");
  const revokeButtons = page.getByRole("button", { name: "Revoke" });
  await revokeButtons.nth(1).click();
  await revokeButtons.nth(2).click();
  await expect.poll(() => mutations).toEqual(["POST passkey", "DELETE grant", "DELETE session"]);
});
