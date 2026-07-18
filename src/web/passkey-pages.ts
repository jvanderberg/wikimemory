import type { MemoryScope } from "../domain/types";

function securityHeaders(nonce: string): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cache-control": "no-store"
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

const CSS = `:root{color-scheme:light dark}body{font:16px/1.55 ui-sans-serif,system-ui;max-width:38rem;margin:10vh auto;padding:0 1.25rem;color:#19211e;background:#f5f7f6}main{background:#fff;border:1px solid #dce3df;border-radius:16px;padding:2rem;box-shadow:0 12px 36px #10251d12}h1{margin-top:0}button{font:inherit;font-weight:650;color:#fff;background:#176b52;border:0;border-radius:9px;padding:.75rem 1rem;cursor:pointer}button:disabled{opacity:.55}#status{color:#66716c}.admin{color:#8d2929;font-weight:650}@media(prefers-color-scheme:dark){body{color:#edf5f1;background:#101613}main{background:#18201c;border-color:#344139}#status{color:#acb8b2}.admin{color:#ffaaaa}}`;

const BROWSER_HELPERS = `
const b64=(value)=>{const bytes=new Uint8Array(value);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')};
const bytes=(value)=>{const normalized=value.replaceAll('-','+').replaceAll('_','/');const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4));return Uint8Array.from(binary,c=>c.charCodeAt(0))};
const registrationOptions=(options)=>({...options,challenge:bytes(options.challenge),user:{...options.user,id:bytes(options.user.id)},excludeCredentials:(options.excludeCredentials||[]).map(c=>({...c,id:bytes(c.id)}))});
const authenticationOptions=(options)=>({...options,challenge:bytes(options.challenge),allowCredentials:(options.allowCredentials||[]).map(c=>({...c,id:bytes(c.id)}))});
const registrationJSON=(credential)=>({id:credential.id,rawId:b64(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment??undefined,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:b64(credential.response.clientDataJSON),attestationObject:b64(credential.response.attestationObject),transports:typeof credential.response.getTransports==='function'?credential.response.getTransports():undefined}});
const authenticationJSON=(credential)=>({id:credential.id,rawId:b64(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment??undefined,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:b64(credential.response.clientDataJSON),authenticatorData:b64(credential.response.authenticatorData),signature:b64(credential.response.signature),userHandle:credential.response.userHandle===null?undefined:b64(credential.response.userHandle)}});
`;

function document(title: string, body: string, script: string, nonce: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${CSS}</style></head><body><main>${body}</main><script nonce="${nonce}">${script}</script></body></html>`, { headers: securityHeaders(nonce) });
}

export function renderPasskeySetupPage(): Response {
  const nonce = crypto.randomUUID();
  const script = `${BROWSER_HELPERS}
const status=document.querySelector('#status');const button=document.querySelector('button');
const token=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname);
if(!token){button.disabled=true;status.textContent='This setup link is missing its one-time token.'}
button.addEventListener('click',async()=>{button.disabled=true;status.textContent='Waiting for your passkey…';try{const optionsResponse=await fetch('/setup/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});const envelope=await optionsResponse.json();if(!optionsResponse.ok)throw new Error(envelope.error||'Setup was rejected');const credential=await navigator.credentials.create({publicKey:registrationOptions(envelope.options)});if(!credential)throw new Error('No passkey was created');const verifyResponse=await fetch('/setup/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({flowId:envelope.flowId,response:registrationJSON(credential)})});const result=await verifyResponse.json();if(!verifyResponse.ok)throw new Error(result.error||'Passkey verification failed');status.textContent='Passkey saved. Wikimemory is ready.';button.hidden=true}catch(error){status.textContent=error instanceof Error?error.message:'Setup failed';button.disabled=false}});`;
  return document("Set up Wikimemory", `<h1>Set up your passkey</h1><p>This creates the owner credential for Wikimemory. Your passkey stays in your password manager or security key.</p><button type="button">Create passkey</button><p id="status" aria-live="polite">Use the one-time link printed by the installer.</p>`, script, nonce);
}

export function renderPasskeyAuthorizationPage(input: {
  flowId: string;
  options: unknown;
  kind: "mcp" | "web";
  clientName?: string;
  requestedScopes?: MemoryScope[];
}): Response {
  const nonce = crypto.randomUUID();
  const script = `${BROWSER_HELPERS}
const status=document.querySelector('#status');const button=document.querySelector('button');const flowId=${JSON.stringify(input.flowId)};const options=${JSON.stringify(input.options)};let attempted=false;
button.addEventListener('click',async()=>{if(attempted){location.reload();return}attempted=true;button.disabled=true;status.textContent='Waiting for your passkey…';try{const credential=await navigator.credentials.get({publicKey:authenticationOptions(options)});if(!credential)throw new Error('No passkey was selected');const response=await fetch('/auth/passkey/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({flowId,response:authenticationJSON(credential)})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Authentication failed');location.assign(result.redirectTo)}catch(error){status.textContent=(error instanceof Error?error.message:'Authentication failed')+' Restart sign-in to try again.';button.textContent='Restart sign-in';button.disabled=false}});`;
  const adminWarning = input.requestedScopes?.includes("memory:admin") === true
    ? `<p class="admin">Administrative access can restore prior revisions.</p>`
    : "";
  const target = input.kind === "mcp"
    ? `<p><strong>${escapeHtml(input.clientName ?? "An MCP client")}</strong> is requesting access to Wikimemory.</p>${input.requestedScopes === undefined ? "" : `<ul>${input.requestedScopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")}</ul>`}${adminWarning}`
    : "<p>Sign in to browse your memory.</p>";
  return document("Sign in to Wikimemory", `<h1>Wikimemory</h1>${target}<button type="button">Continue with passkey</button><p id="status" aria-live="polite"></p>`, script, nonce);
}
