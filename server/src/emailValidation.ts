import { promises as dns } from 'node:dns';

// Basic shape check: local@domain.tld with a TLD of at least 2 chars.
// The MX/DNS check below does the real "can this address receive mail" work.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isDnsNotFound(e: any): boolean {
  return !!e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer!)), timeout]);
}

type DnsLike = Pick<typeof dns, 'resolveMx' | 'resolve4' | 'resolve6'>;

/**
 * Does this domain look able to receive email?
 * Returns true  -> MX (or fallback A/AAAA) records exist.
 * Returns false -> domain definitively has no mail records.
 * Returns null  -> DNS itself couldn't be checked (blocked/timeout) — the
 *                 caller should FAIL OPEN and not block signup on our network.
 */
export async function emailDomainReceivesMail(
  domain: string,
  lookup: DnsLike = dns
): Promise<boolean | null> {
  const d = domain.toLowerCase().trim();
  if (!d || d.length > 253) return false;
  try {
    const mx = await withTimeout(lookup.resolveMx(d), 5000);
    if (mx.length > 0) return true;
  } catch (e) {
    if (!isDnsNotFound(e)) return null;
  }
  // RFC 5321 §5.1: when no MX records exist, mail falls back to A/AAAA.
  let v4: string[];
  let v6: string[];
  try {
    v4 = await withTimeout(
      lookup.resolve4(d).catch((e) => {
        if (!isDnsNotFound(e)) throw e;
        return [] as string[];
      }),
      5000
    );
  } catch {
    return null;
  }
  try {
    v6 = await withTimeout(
      lookup.resolve6(d).catch((e) => {
        if (!isDnsNotFound(e)) throw e;
        return [] as string[];
      }),
      5000
    );
  } catch {
    return null;
  }
  return v4.length + v6.length > 0;
}
