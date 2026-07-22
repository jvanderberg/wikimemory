import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from "@simplewebauthn/browser";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  Component,
  type ReactNode,
  StrictMode,
  useCallback,
  useEffect,
  useEffectEvent,
  useState
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import "./styles.css";

const indexEntry = z.object({
  slug: z.string(),
  type: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  status: z.string().nullable().optional(),
  project: z.string().nullable().optional()
});
const sessionSchema = z.object({
  authenticated: z.boolean(),
  environment: z.enum(["local", "production"]),
  loginUrl: z.string().optional()
});
const indexSchema = z.object({ items: z.array(indexEntry) });
const searchSchema = z.object({ hits: z.array(indexEntry.extend({ snippet: z.string() })) });
const recentSchema = z.object({
  revisions: z.array(
    z.object({
      slug: z.string(),
      type: z.string(),
      revision_id: z.string(),
      revision_number: z.number(),
      title: z.string(),
      summary: z.string().nullable(),
      created_at: z.string(),
      reason: z.string()
    })
  )
});
const passkeySchema = z.object({
  credentialRef: z.string(),
  label: z.string(),
  deviceType: z.enum(["singleDevice", "multiDevice"]),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable()
});
const manageSchema = z.object({
  passkeys: z.array(passkeySchema),
  clients: z.array(
    z.object({
      id: z.string(),
      clientName: z.string(),
      scope: z.array(z.string()),
      createdAt: z.string()
    })
  ),
  sessions: z.array(
    z.object({
      sessionRef: z.string(),
      authenticatedAt: z.string(),
      createdAt: z.string(),
      current: z.boolean()
    })
  ),
  restoreConfirmation: z.string()
});
const restorePreviewSchema = z.object({
  manifest: z.object({
    formatVersion: z.number(),
    createdAt: z.string(),
    counts: z.object({ documents: z.number(), revisions: z.number() })
  }),
  preview: z.object({
    documents: z.number(),
    revisions: z.number(),
    newDocuments: z.number(),
    matchingDocuments: z.number(),
    newRevisions: z.number(),
    replacesStarterContent: z.boolean(),
    conflicts: z.array(z.object({ slug: z.string(), message: z.string() }))
  })
});
const restoreResultSchema = z.object({
  restored: z.literal(true),
  documents: z.number(),
  newRevisions: z.number()
});
const revokePasskeySchema = z.object({
  revoked: z.string(),
  sessionCleanupComplete: z.boolean()
});
const documentSchema = z.object({
  document: z.object({
    revisionId: z.string(),
    revisionNumber: z.number(),
    slug: z.string(),
    type: z.string(),
    title: z.string(),
    summary: z.string().nullable(),
    body: z.string(),
    createdAt: z.string(),
    metadata: z.array(z.object({ key: z.string(), value: z.string() }))
  }),
  current: z.object({ revisionId: z.string() }).nullable(),
  history: z.array(
    z.object({
      revisionId: z.string(),
      revisionNumber: z.number(),
      createdAt: z.string(),
      reason: z.string()
    })
  )
});
const registrationEnvelope = z.object({
  flowId: z.string(),
  options: z.unknown(),
  label: z.string().optional()
});
const authEnvelope = z.object({
  flowId: z.string(),
  kind: z.enum(["mcp", "web"]),
  options: z.unknown(),
  clientName: z.string().optional(),
  requestedScopes: z.array(z.string()).optional()
});
const localAuthorizationEnvelope = z.object({
  clientName: z.string(),
  requestedScopes: z.array(z.string())
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function registrationOptions(value: unknown): value is PublicKeyCredentialCreationOptionsJSON {
  return (
    record(value) &&
    typeof value["challenge"] === "string" &&
    record(value["user"]) &&
    typeof value["user"]["id"] === "string" &&
    Array.isArray(value["pubKeyCredParams"])
  );
}

function authenticationOptions(value: unknown): value is PublicKeyCredentialRequestOptionsJSON {
  return record(value) && typeof value["challenge"] === "string";
}

async function json(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      record(body) && typeof body["message"] === "string"
        ? body["message"]
        : record(body) && typeof body["error"] === "string"
          ? body["error"]
          : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return await json(await fetch(path, { ...init, headers }));
}

function useLoad<T>(
  load: () => Promise<T>,
  dependencyKey = ""
): { value: T | null; error: string | null; reload: () => void } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);
  const runLoad = useEffectEvent(load);
  useEffect(() => {
    let active = true;
    void runLoad()
      .then((result) => {
        if (active) setValue(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Request failed");
      });
    return () => {
      active = false;
    };
  }, [dependencyKey, generation]);
  return { value, error, reload };
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <header>
        <a className="brand" href="/app">
          <span>W</span>Wikimemory
        </a>
        <a href="/app">Browse</a>
        <a href="/app/search">Search</a>
        <a href="/app/history">Recent</a>
        <a href="/app/manage">Manage</a>
      </header>
      <main>{children}</main>
    </>
  );
}

function ListIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11" />
    </svg>
  );
}

function GridIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </svg>
  );
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M3 7.5h7l2-2h3.5A2.5 2.5 0 0 1 18 8v.5h2a2 2 0 0 1 1.9 2.6l-2 6A2.8 2.8 0 0 1 17.2 19H5.5A2.5 2.5 0 0 1 3 16.5v-9Z" />
    </svg>
  );
}

function DocumentIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 3.5h8l4 4V20H6V3.5Z" />
      <path d="M14 3.5v4h4M9 12h6M9 16h6" />
    </svg>
  );
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="8" y="8" width="11" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function Cards({ items }: { items: z.infer<typeof indexEntry>[] }): React.JSX.Element {
  if (items.length === 0) return <p className="muted">No documents found.</p>;
  return (
    <div className="grid">
      {items.map((item) => (
        <article className="card" key={item.slug}>
          <div className="meta">
            <span>{item.type}</span>
            {item.status ? <span>{item.status}</span> : null}
          </div>
          <h3>
            <a href={`/app/docs/${encodeURIComponent(item.slug)}`}>{item.title}</a>
          </h3>
          <small>{item.slug}</small>
          <p>{item.summary ?? "No summary"}</p>
        </article>
      ))}
    </div>
  );
}

async function loadDocumentIndex(): Promise<z.infer<typeof indexSchema>> {
  const items: z.infer<typeof indexEntry>[] = [];
  let after = "";
  for (;;) {
    const path =
      after === "" ? "/api/app/documents" : `/api/app/documents?after=${encodeURIComponent(after)}`;
    const page = indexSchema.parse(await api(path));
    items.push(...page.items);
    if (page.items.length < 100) return { items };
    const next = page.items.at(-1)?.slug;
    if (next === undefined || next === after)
      throw new Error("Document index pagination did not advance");
    after = next;
  }
}

const documentTypeOrder = ["note", "topic", "source"] as const;

function typeLabel(type: string): string {
  return type === "source" ? "Sources" : `${type.charAt(0).toUpperCase()}${type.slice(1)}s`;
}

function TypeGroups({ items }: { items: z.infer<typeof indexEntry>[] }): React.JSX.Element {
  return (
    <>
      {documentTypeOrder.map((type) => {
        const matching = items.filter((item) => item.type === type);
        return matching.length === 0 ? null : (
          <section className="document-type" key={type}>
            <h3>{typeLabel(type)}</h3>
            <Cards items={matching} />
          </section>
        );
      })}
    </>
  );
}

function Login(): React.JSX.Element {
  const flowId = new URLSearchParams(location.search).get("flowId");
  const flow = useLoad(
    async () =>
      authEnvelope.parse(await api(`/api/auth/options?flowId=${encodeURIComponent(flowId ?? "")}`)),
    flowId ?? ""
  );
  const [status, setStatus] = useState("Waiting for authorization details…");
  async function authenticate(): Promise<void> {
    if (flow.value === null || !authenticationOptions(flow.value.options)) return;
    setStatus("Waiting for your passkey…");
    try {
      const response = await startAuthentication({ optionsJSON: flow.value.options });
      const result = z.object({ redirectTo: z.string() }).parse(
        await api("/auth/passkey/verify", {
          method: "POST",
          body: JSON.stringify({ flowId: flow.value.flowId, response })
        })
      );
      location.assign(result.redirectTo);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Authentication failed");
    }
  }
  return (
    <main className="center">
      <section className="panel">
        <h1>Wikimemory</h1>
        {flow.value?.kind === "mcp" ? (
          <>
            <p>
              <strong>{flow.value.clientName ?? "An MCP client"}</strong> is requesting access.
            </p>
            <ul>
              {flow.value.requestedScopes?.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>Sign in to browse your memory.</p>
        )}
        <button disabled={flow.value === null} onClick={() => void authenticate()}>
          Continue with passkey
        </button>
        <p className="muted">{flow.error ?? status}</p>
      </section>
    </main>
  );
}

function LocalAuthorization(): React.JSX.Element {
  const query = location.search;
  const authorization = useLoad(
    async () => localAuthorizationEnvelope.parse(await api(`/api/local-authorize/options${query}`)),
    query
  );
  const [status, setStatus] = useState("Review this local test authorization.");
  async function approve(): Promise<void> {
    setStatus("Authorizing local test owner…");
    try {
      const result = z.object({ redirectTo: z.string() }).parse(
        await api(`/api/local-authorize/approve${query}`, {
          method: "POST",
          body: "{}"
        })
      );
      location.assign(result.redirectTo);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Authorization failed");
    }
  }
  return (
    <main className="center">
      <section className="panel">
        <h1>Authorize local Wikimemory</h1>
        <p>
          <strong>{authorization.value?.clientName ?? "An MCP client"}</strong> is requesting access
          to the explicit local test owner.
        </p>
        <ul>
          {authorization.value?.requestedScopes.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
        </ul>
        <button disabled={authorization.value === null} onClick={() => void approve()}>
          Continue as local test owner
        </button>
        <p className="muted">{authorization.error ?? status}</p>
      </section>
    </main>
  );
}

function Registration({ recovery }: { recovery: boolean }): React.JSX.Element {
  const [token] = useState(() => decodeURIComponent(location.hash.slice(1)));
  const [label, setLabel] = useState(recovery ? "Primary passkey" : "Backup passkey");
  const [status, setStatus] = useState("");
  const [completed, setCompleted] = useState<null | { message: string; label: string }>(null);
  useEffect(() => {
    history.replaceState(null, "", location.pathname);
  }, []);
  async function register(): Promise<void> {
    setStatus("Waiting for your passkey…");
    try {
      const endpoint = recovery ? "/setup" : "/passkeys/add";
      const requestBody = recovery ? { token, label } : { token };
      const envelope = registrationEnvelope.parse(
        await api(`${endpoint}/options`, { method: "POST", body: JSON.stringify(requestBody) })
      );
      if (!registrationOptions(envelope.options))
        throw new Error("Server returned invalid passkey options");
      const response = await startRegistration({ optionsJSON: envelope.options });
      const result = z
        .object({ ok: z.literal(true), mode: z.string().optional(), label: z.string().optional() })
        .parse(
          await api(`${endpoint}/verify`, {
            method: "POST",
            body: JSON.stringify({ flowId: envelope.flowId, response })
          })
        );
      setCompleted({
        label: result.label ?? label,
        message:
          result.mode === "recovery"
            ? "Previous credentials and sessions were revoked."
            : "Your existing credentials remain active."
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Registration failed");
    }
  }
  if (completed !== null)
    return (
      <main className="center">
        <section className="panel">
          <h1>Passkey created</h1>
          <p>
            <strong>{completed.label}</strong> is ready.
          </p>
          <p>{completed.message}</p>
          <a className="button" href={recovery ? "/app/login" : "/app/manage"}>
            {recovery ? "Continue to Wikimemory" : "Return to passkey management"}
          </a>
        </section>
      </main>
    );
  return (
    <main className="center">
      <section className="panel">
        <h1>{recovery ? "Set up Wikimemory" : "Add a passkey"}</h1>
        <p>
          {recovery
            ? "Initial setup creates the owner credential; recovery replaces every existing credential."
            : "This adds another owner credential without removing existing passkeys."}
        </p>
        {recovery ? (
          <label>
            Passkey name
            <input
              value={label}
              maxLength={80}
              onChange={(event) => {
                setLabel(event.target.value);
              }}
            />
          </label>
        ) : null}
        <button disabled={token === ""} onClick={() => void register()}>
          Create passkey
        </button>
        <p className="muted">{token === "" ? "The one-time token is missing." : status}</p>
      </section>
    </main>
  );
}

function Browse(): React.JSX.Element {
  const data = useLoad(loadDocumentIndex);
  if (data.error) return <p>{data.error}</p>;
  if (data.value === null) return <p>Loading…</p>;
  const system = data.value.items.filter((item) => item.type === "system");
  const projects = new Map<string, z.infer<typeof indexEntry>[]>();
  const unfiled: z.infer<typeof indexEntry>[] = [];
  for (const item of data.value.items) {
    if (item.type === "system") continue;
    const project =
      item.type === "project"
        ? item.slug
        : item.project !== null &&
            item.project !== undefined &&
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.project)
          ? item.project
          : null;
    if (project === null) unfiled.push(item);
    else projects.set(project, [...(projects.get(project) ?? []), item]);
  }
  return (
    <>
      <h1>Browse memory</h1>
      <p className="lede">The current pages in your durable store.</p>
      {system.length === 0 ? null : (
        <section className="browser-section">
          <h2>System</h2>
          <Cards items={system} />
        </section>
      )}
      {projects.size === 0 ? null : (
        <section className="browser-section">
          <h2>Projects</h2>
          {[...projects.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([slug, items]) => {
              const project = items.find((item) => item.type === "project");
              return (
                <section className="project-group" key={slug}>
                  <div className="project-heading">
                    <span className="folder-icon" aria-hidden="true">
                      <FolderIcon />
                    </span>
                    <div>
                      <h3>
                        {project === undefined ? (
                          slug
                        ) : (
                          <a href={`/app/docs/${encodeURIComponent(project.slug)}`}>
                            {project.title}
                          </a>
                        )}
                      </h3>
                      {project?.status ? (
                        <div className="meta project-meta">
                          <span>{project.status}</span>
                        </div>
                      ) : null}
                      <p>{project?.summary ?? slug}</p>
                    </div>
                  </div>
                  <TypeGroups items={items.filter((item) => item.type !== "project")} />
                </section>
              );
            })}
        </section>
      )}
      {unfiled.length === 0 ? null : (
        <section className="browser-section">
          <h2>Unfiled</h2>
          <TypeGroups items={unfiled} />
        </section>
      )}
      {data.value.items.length === 0 ? <p className="muted">No documents found.</p> : null}
    </>
  );
}

function Search(): React.JSX.Element {
  const initial = new URLSearchParams(location.search).get("q") ?? "";
  const [query, setQuery] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const data = useLoad(
    async () =>
      submitted === ""
        ? { hits: [] }
        : searchSchema.parse(await api(`/api/app/search?q=${encodeURIComponent(submitted)}`)),
    submitted
  );
  return (
    <>
      <h1>Search</h1>
      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Search durable memory…"
        />
        <button>Search</button>
      </form>
      {data.value ? <Cards items={data.value.hits} /> : null}
    </>
  );
}

function Recent(): React.JSX.Element {
  const data = useLoad(async () => recentSchema.parse(await api("/api/app/recent")));
  const [view, setView] = useState<"list" | "icons">("list");
  return (
    <>
      <div className="page-heading">
        <h1>Recent revisions</h1>
        <div className="view-selector" aria-label="Recent revision view">
          <button
            aria-label="List view"
            aria-pressed={view === "list"}
            className={view === "list" ? "selected" : undefined}
            onClick={() => {
              setView("list");
            }}
          >
            <ListIcon />
          </button>
          <button
            aria-label="Icon view"
            aria-pressed={view === "icons"}
            className={view === "icons" ? "selected" : undefined}
            onClick={() => {
              setView("icons");
            }}
          >
            <GridIcon />
          </button>
        </div>
      </div>
      {view === "list" ? (
        <ol className="list recent-list">
          {data.value?.revisions.map((revision) => (
            <li key={revision.revision_id}>
              <a
                href={`/app/docs/${encodeURIComponent(revision.slug)}?revision=${encodeURIComponent(revision.revision_id)}`}
              >
                {revision.slug} revision {revision.revision_number}
              </a>
              <small>
                {revision.created_at} · {revision.reason}
              </small>
            </li>
          ))}
        </ol>
      ) : (
        <div className="recent-icons">
          {data.value?.revisions.map((revision) => (
            <article className="recent-icon" key={revision.revision_id}>
              <span className="document-icon" aria-hidden="true">
                {revision.type === "project" ? <FolderIcon /> : <DocumentIcon />}
              </span>
              <div>
                <h2>
                  <a
                    href={`/app/docs/${encodeURIComponent(revision.slug)}?revision=${encodeURIComponent(revision.revision_id)}`}
                  >
                    {revision.title}
                  </a>
                </h2>
                <small>
                  {revision.slug} · revision {revision.revision_number}
                </small>
                <p>{revision.summary ?? revision.reason}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function DocumentPage({ slug }: { slug: string }): React.JSX.Element {
  const revisionId = new URLSearchParams(location.search).get("revision");
  const path = `/api/app/docs/${encodeURIComponent(slug)}${revisionId === null ? "" : `?revision=${encodeURIComponent(revisionId)}`}`;
  const data = useLoad(async () => documentSchema.parse(await api(path)), path);
  const [notice, setNotice] = useState("");
  const [bodyView, setBodyView] = useState<"rendered" | "raw">("rendered");
  if (data.error !== null)
    return (
      <>
        <h1>Document unavailable</h1>
        <p>{data.error}</p>
      </>
    );
  if (data.value === null) return <p>Loading…</p>;
  const { document, current, history: revisions } = data.value;
  const isHistoric = current !== null && current.revisionId !== document.revisionId;
  async function restore(): Promise<void> {
    if (current === null) return;
    await api(`/api/app/docs/${encodeURIComponent(slug)}/restore`, {
      method: "POST",
      body: JSON.stringify({
        targetRevisionId: document.revisionId,
        expectedRevisionId: current.revisionId
      })
    });
    setNotice("Restored as a new revision.");
    location.assign(`/app/docs/${encodeURIComponent(slug)}`);
  }
  async function copyMarkdown(): Promise<void> {
    try {
      await navigator.clipboard.writeText(document.body);
      setNotice("Markdown copied.");
    } catch {
      setNotice("Could not copy Markdown. Select Raw and copy it manually.");
    }
  }
  return (
    <article>
      <div className="meta">
        <span>{document.type}</span>
        <span>revision {document.revisionNumber}</span>
      </div>
      <h1>{document.title}</h1>
      <p className="lede">{document.summary ?? document.slug}</p>
      {notice === "" ? null : <p className="notice">{notice}</p>}
      {isHistoric ? <button onClick={() => void restore()}>Restore this revision</button> : null}
      {document.metadata.length === 0 ? null : (
        <dl className="metadata">
          {document.metadata.map((item) => (
            <div key={`${item.key}:${item.value}`}>
              <dt>{item.key}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="body-heading">
        <h2>Document</h2>
        <div className="body-actions">
          <div className="text-selector" aria-label="Document body view">
            <button
              aria-pressed={bodyView === "rendered"}
              className={bodyView === "rendered" ? "selected" : undefined}
              onClick={() => {
                setBodyView("rendered");
              }}
            >
              Rendered
            </button>
            <button
              aria-pressed={bodyView === "raw"}
              className={bodyView === "raw" ? "selected" : undefined}
              onClick={() => {
                setBodyView("raw");
              }}
            >
              Raw
            </button>
          </div>
          <button
            className="icon-button"
            aria-label="Copy Markdown"
            title="Copy Markdown"
            onClick={() => void copyMarkdown()}
          >
            <CopyIcon />
          </button>
        </div>
      </div>
      {bodyView === "rendered" ? (
        <div className="markdown-body">
          <Markdown remarkPlugins={[remarkGfm]} skipHtml>
            {document.body}
          </Markdown>
        </div>
      ) : (
        <pre className="document-body">{document.body}</pre>
      )}
      <section className="panel">
        <h2>History</h2>
        <ol className="list">
          {revisions.map((revision) => (
            <li key={revision.revisionId}>
              <a
                href={`/app/docs/${encodeURIComponent(slug)}?revision=${encodeURIComponent(revision.revisionId)}`}
              >
                Revision {revision.revisionNumber}
              </a>
              <small>
                {revision.createdAt} · {revision.reason}
              </small>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function Manage({ passkeysEnabled }: { passkeysEnabled: boolean }): React.JSX.Element {
  const data = useLoad(async () => manageSchema.parse(await api("/api/app/manage")));
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [backup, setBackup] = useState<File | null>(null);
  const [preview, setPreview] = useState<z.infer<typeof restorePreviewSchema> | null>(null);
  const [replace, setReplace] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  async function mutate(method: "POST" | "DELETE", path: string, body: object): Promise<unknown> {
    const result = await api(path, { method, body: JSON.stringify(body) });
    data.reload();
    return result;
  }
  async function archiveRequest(path: string, includeRestoreOptions: boolean): Promise<unknown> {
    if (backup === null) throw new Error("Choose a backup file");
    const form = new FormData();
    form.set("backup", backup);
    if (includeRestoreOptions) {
      form.set("replace", String(replace));
      if (replace) form.set("confirmation", confirmation);
    }
    return await json(await fetch(path, { method: "POST", body: form }));
  }
  async function inspectBackup(): Promise<void> {
    setArchiveBusy(true);
    setNotice("");
    try {
      setPreview(
        restorePreviewSchema.parse(await archiveRequest("/api/app/restore/preview", false))
      );
    } catch (error) {
      setPreview(null);
      setNotice(error instanceof Error ? error.message : "Could not inspect backup");
    } finally {
      setArchiveBusy(false);
    }
  }
  async function restoreBackup(): Promise<void> {
    setArchiveBusy(true);
    setNotice("");
    try {
      const result = restoreResultSchema.parse(await archiveRequest("/api/app/restore", true));
      setNotice(
        `Backup restored: ${result.documents} documents and ${result.newRevisions} new revisions.`
      );
      setPreview(null);
      setBackup(null);
      setReplace(false);
      setConfirmation("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Restore failed");
    } finally {
      setArchiveBusy(false);
    }
  }
  if (data.value === null) return <p>{data.error ?? "Loading…"}</p>;
  return (
    <>
      <h1>Manage Wikimemory</h1>
      {notice ? <p className="notice">{notice}</p> : null}
      {passkeysEnabled ? (
        <section className="panel">
          <h2>Passkeys</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate("POST", "/api/app/passkeys", { label }).then((raw) => {
                const result = z.object({ registrationUrl: z.string() }).parse(raw);
                location.assign(result.registrationUrl);
              });
            }}
          >
            <label>
              New passkey name
              <input
                required
                maxLength={80}
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                }}
              />
            </label>
            <button>Add passkey</button>
          </form>
          <ol className="list">
            {data.value.passkeys.map((passkey) => (
              <li key={passkey.credentialRef}>
                <strong>{passkey.label}</strong>
                <small>
                  {passkey.deviceType} · {passkey.backedUp ? "backed up" : "not backed up"} ·
                  created {passkey.createdAt}
                  {passkey.lastUsedAt ? ` · last used ${passkey.lastUsedAt}` : ""}
                </small>
                <button
                  className="danger"
                  disabled={data.value?.passkeys.length === 1}
                  onClick={() =>
                    void mutate("DELETE", "/api/app/passkeys", {
                      credentialRef: passkey.credentialRef
                    }).then((raw) => {
                      const result = revokePasskeySchema.parse(raw);
                      setNotice(
                        result.sessionCleanupComplete
                          ? "Passkey and its browser sessions were revoked."
                          : "Passkey revoked. Browser-session cleanup could not be confirmed; those sessions are blocked because the passkey no longer exists."
                      );
                    })
                  }
                >
                  Revoke
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <section className="panel">
          <h2>Passkeys</h2>
          <p className="muted">Passkey management is disabled for the fake local owner.</p>
        </section>
      )}
      <section className="panel">
        <h2>Authorized MCP clients</h2>
        <ol className="list">
          {data.value.clients.map((client) => (
            <li key={client.id}>
              <strong>{client.clientName}</strong>
              <small>
                {client.scope.join(" ")} · {client.createdAt}
              </small>
              <button
                className="danger"
                onClick={() => void mutate("DELETE", "/api/app/grants", { grantId: client.id })}
              >
                Revoke
              </button>
            </li>
          ))}
        </ol>
      </section>
      <section className="panel">
        <h2>Browser sessions</h2>
        <ol className="list">
          {data.value.sessions.map((session) => (
            <li key={session.sessionRef}>
              <strong>{session.current ? "Current browser" : "Browser session"}</strong>
              <small>{session.createdAt}</small>
              <button
                className="danger"
                onClick={() =>
                  void mutate("DELETE", "/api/app/sessions", { sessionRef: session.sessionRef })
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ol>
      </section>
      <section className="panel">
        <h2>Backup and restore</h2>
        <p>
          <a href="/api/app/backup">Download complete backup</a>
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void inspectBackup();
          }}
        >
          <label>
            Backup file
            <input
              type="file"
              accept=".zip,.wmem.zip,application/zip"
              required
              onChange={(event) => {
                setBackup(event.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          </label>
          <button disabled={archiveBusy || backup === null}>Inspect backup</button>
        </form>
        {preview === null ? null : (
          <div className="restore-preview">
            <p>
              Version {preview.manifest.formatVersion} backup from {preview.manifest.createdAt}:{" "}
              {preview.preview.documents} documents, {preview.preview.revisions} revisions.
            </p>
            <p>
              Restore would add {preview.preview.newDocuments} documents and{" "}
              {preview.preview.newRevisions} revisions.
            </p>
            {preview.preview.conflicts.length === 0 ? (
              <p className="notice">No conflicts found.</p>
            ) : (
              <>
                <p className="notice">
                  {preview.preview.conflicts.length} conflict(s) must be resolved or replaced.
                </p>
                <ul>
                  {preview.preview.conflicts.map((conflict) => (
                    <li key={conflict.slug}>
                      <strong>{conflict.slug}</strong>: {conflict.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <label>
              <input
                type="checkbox"
                checked={replace}
                onChange={(event) => {
                  setReplace(event.target.checked);
                  setConfirmation("");
                }}
              />
              Replace every existing document before restoring
            </label>
            {replace ? (
              <label>
                Type {data.value.restoreConfirmation} to confirm
                <input
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                  }}
                />
              </label>
            ) : null}
            <button
              className={replace ? "danger" : undefined}
              disabled={
                archiveBusy ||
                (!replace && preview.preview.conflicts.length > 0) ||
                (replace && confirmation !== data.value.restoreConfirmation)
              }
              onClick={() => void restoreBackup()}
            >
              {replace ? "Replace and restore" : "Restore backup"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function AuthenticatedApp(): React.JSX.Element {
  const session = useLoad(async () => sessionSchema.parse(await api("/api/app/session")));
  const [loginError, setLoginError] = useState("");
  if (session.error)
    return (
      <main className="center">
        <section className="panel">
          <h1>Wikimemory</h1>
          <p>{session.error}</p>
        </section>
      </main>
    );
  if (session.value === null) return <p>Loading…</p>;
  if (!session.value.authenticated) {
    async function localLogin(): Promise<void> {
      try {
        await api("/api/app/login", { method: "POST", body: "{}" });
        session.reload();
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : "Sign-in failed");
      }
    }
    return (
      <main className="center">
        <section className="panel">
          <h1>Wikimemory</h1>
          <p>
            {session.value.environment === "local"
              ? "Use the explicit local test owner. No production passkey is involved."
              : "Use an owner passkey to browse your memory."}
          </p>
          {session.value.environment === "local" ? (
            <button onClick={() => void localLogin()}>Continue as local test owner</button>
          ) : (
            <a className="button" href={session.value.loginUrl ?? "/app/login"}>
              Continue with passkey
            </a>
          )}
          {loginError === "" ? null : <p>{loginError}</p>}
        </section>
      </main>
    );
  }
  const path = location.pathname;
  const documentPrefix = "/app/docs/";
  const page =
    path === "/app/search" ? (
      <Search />
    ) : path === "/app/history" ? (
      <Recent />
    ) : path === "/app/manage" ? (
      <Manage passkeysEnabled={session.value.environment === "production"} />
    ) : path.startsWith(documentPrefix) ? (
      <DocumentPage slug={decodeURIComponent(path.slice(documentPrefix.length))} />
    ) : (
      <Browse />
    );
  return <Shell>{page}</Shell>;
}

export function App(): React.JSX.Element {
  if (location.pathname === "/login") return <Login />;
  if (location.pathname === "/local-authorize") return <LocalAuthorization />;
  if (location.pathname === "/setup") return <Registration recovery />;
  if (location.pathname === "/passkeys/add") return <Registration recovery={false} />;
  return <AuthenticatedApp />;
}

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed)
      return (
        <main className="center">
          <section className="panel">
            <h1>Wikimemory</h1>
            <p>This browser could not start Wikimemory. Reload the page or update Safari.</p>
          </section>
        </main>
      );
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>
  );
}
