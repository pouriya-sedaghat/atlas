/**
 * Strict IPv4 / CIDR parsing for access configuration. Octet-shaped regexes are not enough:
 * values above 255, leading zeros (read as octal by some tools) and non-canonical networks are
 * rejected here, before anything is persisted or started.
 */
const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** Narrowest-allowed LAN allowlist breadth: entries broader than /8 (incl. 0.0.0.0/0) are refused. */
export const MIN_LAN_PREFIX = 8;

export function parseIPv4(s: string): number | null {
  if (!IPV4_RE.test(s)) return null;
  return s.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}

export function isLoopbackIPv4(s: string): boolean {
  const n = parseIPv4(s);
  return n !== null && n >>> 24 === 127;
}

export interface Cidr {
  network: number;
  prefix: number;
}

/** Parse a canonical IPv4 CIDR (host bits zero) with MIN_LAN_PREFIX <= prefix <= 32. */
export function parseLanCidr(s: string): Cidr {
  const m = /^([0-9.]+)\/(3[0-2]|[12][0-9]|[0-9])$/.exec(s);
  const network = m ? parseIPv4(m[1]!) : null;
  if (!m || network === null) throw new Error(`invalid CIDR "${s}" (expected a.b.c.d/n with octets 0-255 and n 0-32)`);
  const prefix = Number(m[2]);
  if (prefix < MIN_LAN_PREFIX) throw new Error(`CIDR "${s}" is broader than /${MIN_LAN_PREFIX}; list the actual LAN ranges`);
  const hostBits = prefix === 32 ? 0 : 2 ** (32 - prefix) - 1;
  if (network % (hostBits + 1) !== 0) throw new Error(`CIDR "${s}" has host bits set; use its network address`);
  return { network, prefix };
}

/** Comma-separated CIDR list; empty entries are rejected rather than skipped. */
export function parseLanCidrs(list: string): Cidr[] {
  const entries = list.split(',').map((c) => c.trim());
  if (entries.length === 0 || entries.some((c) => c === '')) throw new Error('LAN CIDR allowlist has an empty entry');
  return entries.map(parseLanCidr);
}

/** Is IPv4 address `ip` (32-bit value) inside `c`? */
export function inCidr(ip: number, c: Cidr): boolean {
  const size = 2 ** (32 - c.prefix);
  return Math.floor(ip / size) === Math.floor(c.network / size);
}
