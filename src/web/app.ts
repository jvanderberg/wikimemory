import { ensureLocalOwner, localOwnerContext } from "../auth/local";
import { beginPasskeyAuthorization, endProductionWebSession, listProductionWebSessions, productionWebOwner, revokeProductionWebSession } from "../auth/passkey";
import { DomainError } from "../domain/errors";
import { ExportService } from "../domain/export-service";
import { MemoryService } from "../domain/memory-service";
import type { ActorContext, DocumentIndexEntry, DocumentSnapshot, OwnerContext, RecallHit, RevisionHeader } from "../domain/types";
import type { Env } from "../env";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function hasCookie(request: Request, name: string, value: string): boolean {
  return (request.headers.get("cookie") ?? "").split(";").some((part) => part.trim() === `${name}=${value}`);
}

function cookieValue(request: Request, name: string): string | null {
  const part = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return part === undefined ? null : part.slice(name.length + 1);
}

function csrfToken(request: Request): { token: string; setCookie: boolean } {
  const existing = cookieValue(request, "wm_csrf");
  return existing === null ? { token: crypto.randomUUID(), setCookie: true } : { token: existing, setCookie: false };
}

async function requireCsrf(request: Request): Promise<FormData> {
  const form = await request.formData();
  const submitted = form.get("csrf");
  const expected = cookieValue(request, "wm_csrf");
  if (typeof submitted !== "string" || expected === null || submitted !== expected) throw new DomainError("forbidden", "CSRF validation failed");
  return form;
}

const styles = `
:root{color-scheme:light dark;--bg:#f5f6f8;--panel:#fff;--panel-subtle:#f9fafb;--ink:#19211e;--muted:#66716c;--line:#dfe4e1;--line-strong:#cbd3cf;--accent:#176b52;--accent-strong:#0f5943;--accent-soft:#e7f4ef;--danger:#a83a3a;--shadow:0 1px 2px rgb(15 32 25/.05),0 8px 24px rgb(15 32 25/.04)}
*{box-sizing:border-box}html{font-size:16px}body{margin:0;background:var(--bg);color:var(--ink);font:400 1rem/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--accent);text-underline-offset:.18em}a:hover{color:var(--accent-strong)}
header{position:sticky;top:0;z-index:10;display:flex;gap:.25rem;align-items:center;width:100%;padding:.7rem max(1rem,calc((100% - 72rem)/2));border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(12px)}header a{padding:.45rem .65rem;border-radius:.5rem;color:var(--muted);font-size:.9rem;font-weight:600;text-decoration:none}header a:hover{background:var(--panel-subtle);color:var(--ink)}header .brand{display:flex;align-items:center;gap:.55rem;margin-right:auto;padding-left:0;color:var(--ink);font-size:1rem;font-weight:750;letter-spacing:-.01em}.brand-mark{display:grid;width:1.9rem;height:1.9rem;place-items:center;border-radius:.55rem;background:var(--accent);color:white;font-size:.88rem;font-weight:800;box-shadow:inset 0 0 0 1px rgb(255 255 255/.18)}
main{width:min(72rem,calc(100% - 2rem));margin:auto;padding:3rem 0 6rem}h1,h2{line-height:1.2;letter-spacing:-.025em}h1{margin:0 0 .55rem;font-size:clamp(1.8rem,4vw,2.45rem)}h2{font-size:1.15rem}p{max-width:68ch}.lede{margin:0 0 2rem;color:var(--muted);font-size:1.05rem}
.search{display:flex;gap:.6rem;max-width:48rem;margin:1.5rem 0 2.25rem}.search input,input{min-width:0;padding:.72rem .85rem;border:1px solid var(--line-strong);border-radius:.58rem;outline:none;background:var(--panel);color:inherit;font:inherit;box-shadow:0 1px 1px rgb(15 32 25/.03)}.search input{flex:1}.search input:focus,input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
button,.actions a{display:inline-flex;align-items:center;justify-content:center;min-height:2.65rem;padding:.62rem .95rem;border:1px solid var(--accent);border-radius:.58rem;background:var(--accent);color:#fff;font:600 .92rem/1 ui-sans-serif,system-ui,sans-serif;text-decoration:none;cursor:pointer;box-shadow:0 1px 2px rgb(15 32 25/.1)}button:hover,.actions a:hover{border-color:var(--accent-strong);background:var(--accent-strong);color:#fff}.danger{border-color:color-mix(in srgb,var(--danger) 45%,var(--line));background:transparent;color:var(--danger);box-shadow:none}.danger:hover{border-color:var(--danger);background:var(--danger);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,19rem),1fr));gap:1rem}.card,.document{border:1px solid var(--line);border-radius:.85rem;background:var(--panel);box-shadow:var(--shadow)}.card{min-height:11rem;padding:1.2rem 1.25rem;transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease}.card:hover{transform:translateY(-2px);border-color:var(--line-strong);box-shadow:0 2px 4px rgb(15 32 25/.06),0 14px 32px rgb(15 32 25/.07)}.card h2{margin:.7rem 0 .2rem}.card h2 a{color:var(--ink);text-decoration:none}.card p{margin:.75rem 0 0;color:var(--muted);font-size:.94rem}.document{margin:0 0 1.25rem;padding:clamp(1.2rem,3vw,2rem)}.document>h1:first-child,.document>h2:first-child{margin-top:0}
.meta{color:var(--muted);font-size:.82rem}.pill{display:inline-flex;align-items:center;margin:0 .3rem .25rem 0;padding:.13rem .48rem;border:1px solid var(--line);border-radius:99px;background:var(--panel-subtle);color:var(--muted);font-size:.74rem;font-weight:650;letter-spacing:.025em}.body{margin:1.75rem 0;padding:1.25rem;border:1px solid var(--line);border-radius:.65rem;background:var(--panel-subtle);white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}.history{margin:1rem 0 2rem;padding:0;list-style:none}.history li{padding:.8rem .25rem;border-bottom:1px solid var(--line)}.history form{margin-top:.65rem}.empty{color:var(--muted)}.actions{display:flex;gap:.65rem;flex-wrap:wrap;align-items:center}.notice{margin:0 0 1.25rem;padding:.75rem 1rem;border:1px solid color-mix(in srgb,var(--accent) 28%,var(--line));border-left:.3rem solid var(--accent);border-radius:.55rem;background:var(--accent-soft)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.login-shell{display:grid;min-height:100vh;place-items:center;padding:1.5rem}.login-card{width:min(30rem,100%);padding:clamp(1.6rem,6vw,3rem);text-align:center}.login-card .brand-mark{margin:0 auto 1.25rem;width:2.8rem;height:2.8rem;font-size:1.1rem}.login-card p{margin:0 auto 1.75rem;color:var(--muted)}
@media(max-width:40rem){header{overflow-x:auto}header .brand{position:sticky;left:0;background:var(--panel)}header a{white-space:nowrap}main{padding-top:2rem}.search{align-items:stretch}.search button{flex:0 0 auto}.document{border-radius:.7rem}.body{margin-inline:-.35rem;padding:1rem}}
@media(prefers-color-scheme:dark){:root{--bg:#111714;--panel:#19201d;--panel-subtle:#141b18;--ink:#edf3ef;--muted:#a6b0ab;--line:#2c3732;--line-strong:#3a4842;--accent:#74c9aa;--accent-strong:#98ddc4;--accent-soft:#183a2f;--danger:#ef8585;--shadow:0 1px 2px rgb(0 0 0/.2),0 10px 28px rgb(0 0 0/.12)}button,.actions a,.brand-mark{color:#10231c}}
`;

function page(title: string, content: string, status = 200): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · Wikimemory</title><style>${styles}</style></head><body>
  <header><a class="brand" href="/app"><span class="brand-mark">W</span>Wikimemory</a><a href="/app">Browse</a><a href="/app/history">Recent</a><a href="/app/manage">Manage</a><a href="/app/logout">Sign out</a></header><main>${content}</main></body></html>`;
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "cache-control": "no-store"
  }});
}

function loginPage(): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wikimemory</title><style>${styles}</style></head><body><main class="login-shell"><section class="document login-card"><span class="brand-mark">W</span><h1>Wikimemory</h1><p>Browse and search the durable memory shared by your AI tools.</p><form method="post" action="/app/login"><button>Continue as local test owner</button></form></section></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff" }});
}

function searchForm(query = ""): string {
  return `<form class="search" method="get" action="/app/search"><label class="sr-only" for="q">Search memory</label><input id="q" name="q" value="${escapeHtml(query)}" maxlength="500" placeholder="Search durable memory…"><button>Search</button></form>`;
}

function cards(items: Array<DocumentIndexEntry | RecallHit>): string {
  if (items.length === 0) return `<p class="empty">No documents found.</p>`;
  return `<div class="grid">${items.map((item) => `<article class="card"><div class="meta"><span class="pill">${escapeHtml(item.type)}</span>${"status" in item && item.status ? `<span class="pill">${escapeHtml(item.status)}</span>` : ""}</div><h2><a href="/app/docs/${encodeURIComponent(item.slug)}">${escapeHtml(item.title)}</a></h2><div class="meta">${escapeHtml(item.slug)}</div><p>${escapeHtml(item.summary ?? ("snippet" in item ? item.snippet : "No summary"))}</p></article>`).join("")}</div>`;
}

async function browse(service: MemoryService, actor: ActorContext): Promise<Response> {
  const items = await service.index(actor, { limit: 100 });
  return page("Browse", `<h1>Browse memory</h1><p class="lede">The current pages in your durable store.</p>${searchForm()}${cards(items)}`);
}

async function search(service: MemoryService, actor: ActorContext, url: URL): Promise<Response> {
  const query = (url.searchParams.get("q") ?? "").trim();
  const hits = query === "" ? [] : await service.recall(actor, query, 20);
  return page("Search", `<h1>Search</h1>${searchForm(query)}${query === "" ? `<p class="empty">Enter a query.</p>` : cards(hits)}`);
}

function metadata(document: DocumentSnapshot): string {
  const values = document.metadata.map((item) => `<span class="pill">${escapeHtml(item.key)}: ${escapeHtml(item.value)}</span>`).join(" ");
  return values === "" ? "" : `<p>${values}</p>`;
}

async function documentPage(service: MemoryService, actor: ActorContext, slug: string, url: URL, csrf: string): Promise<Response> {
  const revisionId = url.searchParams.get("revision") ?? undefined;
  const [document, current, history] = await Promise.all([service.get(actor, slug, revisionId), revisionId === undefined ? null : service.get(actor, slug), service.history(actor, slug, 25)]);
  const restore = current === null ? "" : `<section class="document"><h2>Restore this revision</h2><p>This appends a new revision; it does not remove newer history.</p><form method="post" action="/app/docs/${encodeURIComponent(slug)}/restore"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="targetRevisionId" value="${escapeHtml(document.revisionId)}"><input type="hidden" name="expectedRevisionId" value="${escapeHtml(current.revisionId)}"><button>Restore as a new revision</button></form></section>`;
  const purge = current === null ? "" : `<section class="document"><h2>Permanent purge</h2><p>Deletes this page and every revision. Recent passkey authentication and the exact slug are required.</p><form method="post" action="/app/docs/${encodeURIComponent(slug)}/purge-authorize"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Type <strong>${escapeHtml(slug)}</strong><br><input name="confirmation" autocomplete="off" required></label> <button class="danger">Authorize purge</button></form></section>`;
  const notice = url.searchParams.get("notice");
  return page(document.title, `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}<p><a href="/app">← Browse</a></p><article class="document"><div class="meta"><span class="pill">${escapeHtml(document.type)}</span> ${escapeHtml(document.slug)} · revision ${document.revisionNumber} · ${escapeHtml(document.createdAt)}</div><h1>${escapeHtml(document.title)}</h1>${document.summary ? `<p>${escapeHtml(document.summary)}</p>` : ""}${metadata(document)}<div class="body">${escapeHtml(document.body)}</div><hr><div class="meta">Actor ${escapeHtml(document.principalId)} · client ${escapeHtml(document.clientId)}${document.agentLabel ? ` · agent label ${escapeHtml(document.agentLabel)}` : ""} · ${escapeHtml(document.reason)}</div></article>${restore}<h2>History</h2>${historyList(slug, history)}${purge}`);
}

function historyList(slug: string, history: RevisionHeader[]): string {
  return `<ol class="history">${history.map((item) => `<li><a href="/app/docs/${encodeURIComponent(slug)}?revision=${encodeURIComponent(item.revisionId)}">revision ${item.revisionNumber}</a> · ${escapeHtml(item.createdAt)} · ${escapeHtml(item.reason)}</li>`).join("")}</ol>`;
}

async function recentPage(env: Env, actor: ActorContext): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT d.slug, r.id revision_id, r.revision_number, r.created_at, r.reason FROM revisions r JOIN documents d ON d.id = r.doc_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 100`).bind(actor.workspaceId).all<{ slug: string; revision_id: string; revision_number: number; created_at: string; reason: string }>();
  const list = rows.results.map((row) => `<li><a href="/app/docs/${encodeURIComponent(row.slug)}?revision=${encodeURIComponent(row.revision_id)}">${escapeHtml(row.slug)} revision ${row.revision_number}</a> · ${escapeHtml(row.created_at)} · ${escapeHtml(row.reason)}</li>`).join("");
  return page("Recent", `<h1>Recent revisions</h1><ol class="history">${list}</ol>`);
}

async function managePage(request: Request, env: Env, owner: OwnerContext, csrf: string, url: URL): Promise<Response> {
  const grants = await env.OAUTH_PROVIDER.listUserGrants(owner.principalId, { limit: 100 });
  const clients = new Map<string, string>();
  await Promise.all(grants.items.map(async (grant) => {
    const client = await env.OAUTH_PROVIDER.lookupClient(grant.clientId);
    clients.set(grant.clientId, client?.clientName ?? grant.clientId);
  }));
  const rows = grants.items.map((grant) => `<li><strong>${escapeHtml(clients.get(grant.clientId) ?? grant.clientId)}</strong><br><span class="meta">${escapeHtml(grant.scope.join(" "))} · authorized ${escapeHtml(new Date(grant.createdAt * 1000).toISOString())}</span><form method="post" action="/app/grants/revoke"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="grantId" value="${escapeHtml(grant.id)}"><button class="danger">Revoke client access</button></form></li>`).join("");
  const sessions = env.APP_ENV === "production" ? await listProductionWebSessions(request, env, owner.principalId) : [];
  const sessionRows = env.APP_ENV === "local"
    ? `<p>Current local test-owner session.</p>`
    : sessions.map((session) => `<li>${session.current ? "<strong>Current browser</strong>" : "Browser session"}<br><span class="meta">Created ${escapeHtml(session.createdAt)} · passkey authentication ${escapeHtml(session.authenticatedAt)}</span><form method="post" action="/app/sessions/revoke"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="sessionRef" value="${escapeHtml(session.sessionRef)}"><button class="danger">Revoke browser session</button></form></li>`).join("");
  const notice = url.searchParams.get("notice");
  return page("Manage", `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}<h1>Manage Wikimemory</h1><section class="document"><h2>Export</h2><p>Download a lossless, sanitized JSONL history or a readable Markdown snapshot of current pages.</p><div class="actions"><a href="/app/export.jsonl">Download JSONL history</a><a href="/app/export.md">Download current Markdown</a></div></section><section class="document"><h2>Authorized MCP clients</h2>${rows === "" ? `<p class="empty">No active MCP grants.</p>` : `<ol class="history">${rows}</ol>`}</section><section class="document"><h2>Browser sessions</h2>${sessionRows === "" ? `<p class="empty">No browser sessions.</p>` : `<ol class="history">${sessionRows}</ol>`}</section>`);
}

async function exportResponse(env: Env, owner: OwnerContext, format: "jsonl" | "md"): Promise<Response> {
  const service = new ExportService(env.DB);
  const content = format === "jsonl" ? await service.jsonl(owner) : await service.markdown(owner);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(content, { headers: {
    "content-type": format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="wikimemory-${date}.${format}"`,
    "cache-control": "no-store", "x-content-type-options": "nosniff"
  }});
}

async function restoreDocument(request: Request, service: MemoryService, owner: OwnerContext, slug: string): Promise<Response> {
  const form = await requireCsrf(request);
  const targetRevisionId = form.get("targetRevisionId");
  const expectedRevisionId = form.get("expectedRevisionId");
  if (typeof targetRevisionId !== "string" || typeof expectedRevisionId !== "string") throw new DomainError("validation_failed", "Restore fields are missing");
  const result = await service.restore(owner, { operationId: crypto.randomUUID(), reason: "owner web restore", slug, targetRevisionId, expectedRevisionId });
  return Response.redirect(new URL(`/app/docs/${encodeURIComponent(slug)}?notice=${encodeURIComponent(`Restored as revision ${result.revisionNumber}`)}`, request.url).toString(), 303);
}

async function authorizePurge(request: Request, service: MemoryService, owner: OwnerContext, slug: string, csrf: string): Promise<Response> {
  const form = await requireCsrf(request);
  const confirmation = form.get("confirmation");
  if (typeof confirmation !== "string") throw new DomainError("validation_failed", "Purge confirmation is missing");
  const authorization = await service.authorizePurge(owner, slug, confirmation);
  return page("Confirm purge", `<section class="document"><h1>Permanently purge ${escapeHtml(slug)}?</h1><p>This removes every revision and cannot be undone. A sanitized audit event and replay tombstones remain.</p><form method="post" action="/app/docs/${encodeURIComponent(slug)}/purge-apply"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="authorizationId" value="${escapeHtml(authorization.id)}"><button class="danger">Permanently purge all revisions</button></form></section>`);
}

async function applyPurge(request: Request, service: MemoryService, owner: OwnerContext, slug: string): Promise<Response> {
  const form = await requireCsrf(request);
  const authorizationId = form.get("authorizationId");
  if (typeof authorizationId !== "string") throw new DomainError("validation_failed", "Purge authorization is missing");
  const result = await service.purge(owner, authorizationId, slug);
  return Response.redirect(new URL(`/app/manage?notice=${encodeURIComponent(`Purged ${slug} (${result.purgedRevisions} revisions)`)}`, request.url).toString(), 303);
}

export async function handleWebApp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.APP_ENV === "production" && url.pathname === "/app/login") return beginPasskeyAuthorization(request, env, "web");
  if (url.pathname === "/app/login" && request.method === "POST") {
    await ensureLocalOwner(env);
    return new Response(null, { status: 303, headers: { location: "/app", "set-cookie": "wm_local_web=owner; HttpOnly; Path=/app; SameSite=Strict; Max-Age=86400" } });
  }
  if (url.pathname === "/app/logout") {
    if (env.APP_ENV === "production") await endProductionWebSession(request, env);
    return new Response(null, { status: 303, headers: { location: "/app", "set-cookie": `${env.APP_ENV === "production" ? "wm_web_session" : "wm_local_web"}=; HttpOnly; ${env.APP_ENV === "production" ? "Secure; " : ""}Path=/app; SameSite=Lax; Max-Age=0` } });
  }
  let owner: OwnerContext | null;
  if (env.APP_ENV === "local") {
    if (!hasCookie(request, "wm_local_web", "owner")) return loginPage();
    await ensureLocalOwner(env);
    owner = localOwnerContext();
  } else {
    owner = await productionWebOwner(request, env);
    if (owner === null) return Response.redirect(new URL("/app/login", request.url).toString(), 302);
  }
  const actor: ActorContext = owner;
  const csrf = csrfToken(request);
  const service = new MemoryService(env.DB);
  try {
    let response: Response;
    if (url.pathname === "/app" || url.pathname === "/app/") response = await browse(service, actor);
    else if (url.pathname === "/app/search") response = await search(service, actor, url);
    else if (url.pathname === "/app/history") response = await recentPage(env, actor);
    else if (url.pathname === "/app/manage") response = await managePage(request, env, owner, csrf.token, url);
    else if (url.pathname === "/app/export.jsonl") response = await exportResponse(env, owner, "jsonl");
    else if (url.pathname === "/app/export.md") response = await exportResponse(env, owner, "md");
    else if (url.pathname === "/app/grants/revoke" && request.method === "POST") {
      const form = await requireCsrf(request);
      const grantId = form.get("grantId");
      if (typeof grantId !== "string") throw new DomainError("validation_failed", "Grant ID is missing");
      await env.OAUTH_PROVIDER.revokeGrant(grantId, owner.principalId);
      response = Response.redirect(new URL("/app/manage?notice=Client%20access%20revoked", request.url).toString(), 303);
    } else if (url.pathname === "/app/sessions/revoke" && request.method === "POST" && env.APP_ENV === "production") {
      const form = await requireCsrf(request);
      const sessionRef = form.get("sessionRef");
      if (typeof sessionRef !== "string") throw new DomainError("validation_failed", "Session reference is missing");
      await revokeProductionWebSession(env, owner.principalId, sessionRef);
      response = Response.redirect(new URL("/app/manage?notice=Browser%20session%20revoked", request.url).toString(), 303);
    } else if (url.pathname.startsWith("/app/docs/")) {
      const path = url.pathname.slice(10).split("/");
      const slug = decodeURIComponent(path[0] ?? "");
      const action = path[1];
      if (request.method === "POST" && action === "restore") response = await restoreDocument(request, service, owner, slug);
      else if (request.method === "POST" && action === "purge-authorize") response = await authorizePurge(request, service, owner, slug, csrf.token);
      else if (request.method === "POST" && action === "purge-apply") response = await applyPurge(request, service, owner, slug);
      else if (request.method === "GET" && action === undefined) response = await documentPage(service, actor, slug, url, csrf.token);
      else response = page("Not found", "<h1>Not found</h1>");
    } else response = page("Not found", "<h1>Not found</h1>");
    if (csrf.setCookie && response.headers.get("content-type")?.startsWith("text/html")) {
      response.headers.append("set-cookie", `wm_csrf=${csrf.token}; HttpOnly; ${env.APP_ENV === "production" ? "Secure; " : ""}Path=/app; SameSite=Strict; Max-Age=86400`);
    }
    return response;
  } catch (error) {
    if (error instanceof DomainError) {
      const action = error.code === "reauthentication_required" && env.APP_ENV === "production" ? `<p><a href="/app/login">Reauthenticate with your passkey</a>, then try again.</p>` : "";
      const status = error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403
          : error.code === "revision_conflict" || error.code === "already_exists" || error.code === "idempotency_mismatch" ? 409
            : error.code === "reauthentication_required" ? 401
              : error.code === "limit_exceeded" ? 413
                : error.code === "internal_error" ? 500 : 400;
      return page("Error", `<h1>${escapeHtml(error.code)}</h1><p>${escapeHtml(error.message)}</p>${action}`, status);
    }
    throw error;
  }
}
