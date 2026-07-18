export interface SecretFinding {
  field: string;
  category: "private_key" | "aws_access_key" | "provider_token" | "credential_assignment";
  fingerprint: string;
}

const PATTERNS: Array<{ category: SecretFinding["category"]; regex: RegExp }> = [
  { category: "private_key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { category: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { category: "provider_token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g },
  {
    category: "credential_assignment",
    regex: /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{12,}/gi
  }
];

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function scanSecrets(fields: Readonly<Record<string, string>>): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const seen = new Set<string>();
    for (const { category, regex } of PATTERNS) {
      regex.lastIndex = 0;
      for (const match of value.matchAll(regex)) {
        const candidate = match[0];
        const key = `${category}:${candidate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ field, category, fingerprint: await fingerprint(candidate) });
      }
    }
  }
  return findings;
}
