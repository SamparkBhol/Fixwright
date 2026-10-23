// Content Security Policy for the sandbox page, built from the view's declared `_meta.ui.csp`
// (sent by the host as ?csp=<json>). With nothing declared, this is the MCP Apps spec's restrictive
// default: inline script and style only, no network, no frames. Declared domains are appended only
// when they are plain origins, so a crafted ?csp= cannot inject directives.

export interface UiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

const MAX_DOMAINS = 20;
// scheme://host[:port][/path], optional leading "*." on the host. No quotes, spaces, ';' or ','.
const SOURCE = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?(?:\/[a-z0-9._~%!$&()*+=:@/-]*)?$/i;
// Same shape, without paths or wildcards: what an embedding host origin looks like.
const ORIGIN = /^https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

export function sanitizeSources(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length > 200 || !SOURCE.test(item)) continue;
    if (!out.includes(item)) out.push(item);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

/** Parse ?csp=: JSON of McpUiResourceCsp. Anything malformed means "nothing declared". */
export function parseCspParam(raw: string | null): UiCsp {
  if (!raw || raw.length > 8000) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  return {
    connectDomains: sanitizeSources(v['connectDomains']),
    resourceDomains: sanitizeSources(v['resourceDomains']),
    frameDomains: sanitizeSources(v['frameDomains']),
    baseUriDomains: sanitizeSources(v['baseUriDomains']),
  };
}

/** Parse the HOST_ORIGINS variable: comma or space separated exact origins. Invalid entries are dropped. */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const o = part.trim().replace(/\/$/, '');
    if (o && ORIGIN.test(o) && !out.includes(o.toLowerCase())) out.push(o.toLowerCase());
  }
  return out;
}

const join = (base: string, extra: string[] | undefined): string => [base, ...(extra ?? [])].join(' ');

export function buildCsp(csp: UiCsp, hostOrigins: readonly string[]): string {
  const res = csp.resourceDomains ?? [];
  const connect = csp.connectDomains ?? [];
  const frame = csp.frameDomains ?? [];
  const base = csp.baseUriDomains ?? [];
  return [
    "default-src 'none'",
    join("script-src 'self' 'unsafe-inline'", res),
    join("style-src 'self' 'unsafe-inline'", res),
    join("img-src 'self' data:", res),
    join("font-src 'self' data:", res),
    join("media-src 'self' data:", res),
    connect.length ? `connect-src ${connect.join(' ')}` : "connect-src 'none'",
    frame.length ? `frame-src ${frame.join(' ')}` : "frame-src 'none'",
    "object-src 'none'",
    base.length ? `base-uri ${base.join(' ')}` : "base-uri 'self'",
    "form-action 'none'",
    // Only the allowlisted hosts may embed the proxy page.
    `frame-ancestors ${hostOrigins.length ? hostOrigins.join(' ') : "'none'"}`,
  ].join('; ');
}
