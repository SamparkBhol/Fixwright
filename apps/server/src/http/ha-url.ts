// Which Home Assistant addresses /demo/link-ha accepts (only reachable with ALLOW_HA_LINK=1). The Worker
// fetches whatever base_url it is given, so this is an SSRF guard: https only, no credentials, query or
// fragment, and never a private, loopback, link-local, carrier-grade NAT, multicast or reserved IP literal, a
// cloud metadata address, or a name that only resolves inside a network (single label, .local, .internal,
// .localhost). Plain http to localhost is allowed only while the Worker itself runs on a loopback host
// (wrangler dev on this machine), where the local Home Assistant test hub lives. Redirects are not followed
// (household.ts and house.ts fetch with redirect: 'manual'), so an allowed host cannot bounce the token to a
// blocked one. A public name that resolves to a private address cannot be caught here; Cloudflare's network
// does not route Workers to private ranges.

export type HaUrlCheck = { ok: true; url: string } | { ok: false; error: string };

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for localhost, 127.0.0.0/8 and [::1]: the hosts a dev server on this machine answers on. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;
  const v4 = ipv4(h);
  return v4 !== null && v4[0] === 127;
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Blocked IPv4 ranges (RFC 6890 special purpose, plus multicast and reserved). */
function blockedV4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // IETF protocol assignments, 192.0.2.0/24 documentation
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // documentation
    (a === 203 && b === 0) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands a bracketed IPv6 literal (as WHATWG URL normalizes it) to eight 16-bit groups. */
function ipv6Groups(host: string): number[] | null {
  if (!host.startsWith('[') || !host.endsWith(']')) return null;
  let text = host.slice(1, -1).toLowerCase();
  // An embedded dotted IPv4 tail (URL usually rewrites it to hex, but be sure).
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail) {
    const v4 = ipv4(tail[1] as string);
    if (!v4) return null;
    text = `${text.slice(0, -(tail[1] as string).length)}${((v4[0] as number) * 256 + (v4[1] as number)).toString(16)}:${((v4[2] as number) * 256 + (v4[3] as number)).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0] as string);
  const rest = halves.length === 2 ? parse(halves[1] as string) : [];
  const groups = halves.length === 2 ? [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest] : head;
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0) ? groups : null;
}

function blockedV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    // ::, ::1, IPv4-compatible and IPv4-mapped (::ffff:a.b.c.d): judge by the IPv4 address inside.
    return g5 === 0 && g6 === 0 ? true : blockedV4(embedded);
  }
  if (g0 === 0x64 && g1 === 0xff9b) return blockedV4(embedded); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local (fd00:ec2::254 is AWS metadata)
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/;

export function checkHaUrl(raw: string, opts: { allowLoopback: boolean }): HaUrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'base_url is not a URL.' };
  }
  if (u.username || u.password) return { ok: false, error: 'Put the token in the token field, not in base_url.' };
  if (u.search || u.hash) return { ok: false, error: 'base_url takes no query or fragment.' };
  const host = u.hostname.toLowerCase();
  const loopback = isLoopbackHost(host);
  if (loopback) {
    if (!opts.allowLoopback) return { ok: false, error: 'Home Assistant on localhost only links while the server runs on this machine.' };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'base_url must use https.' };
  } else {
    if (u.protocol !== 'https:') return { ok: false, error: 'base_url must use https (plain http only for localhost in development).' };
    const v4 = ipv4(host);
    const v6 = ipv6Groups(host);
    if ((v4 && blockedV4(v4)) || (host.startsWith('[') && (!v6 || blockedV6(v6)))) {
      return { ok: false, error: 'base_url points at a private or reserved address. Use your public Home Assistant address.' };
    }
    if (!v4 && !v6 && (!host.includes('.') || INTERNAL_NAME.test(host) || host === 'metadata')) {
      return { ok: false, error: 'base_url must be a public host name (one that works from the internet).' };
    }
  }
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}
