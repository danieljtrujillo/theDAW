import { promises as dnsp } from "dns";

// ===========================================================================
// Server-side webpage scraper / reader tool
// ===========================================================================

// SSRF guard: only http/https, and refuse hosts that resolve to loopback,
// private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, or
// reserved IPs. Applies to fetchWebPage on both the direct-API and Claude
// paths (shared helper — does not alter the Claude provider itself).
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true;
  return false;
}
export async function assertPublicUrl(urlStr: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked non-http(s) URL scheme: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    throw new Error("Blocked request to a local address");
  }
  const isLiteralIp = /^[0-9.]+$/.test(host) || host.includes(":");
  const addrs = isLiteralIp
    ? [host]
    : (await dnsp.lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addrs) {
    if (isPrivateIp(ip)) throw new Error("Blocked request to a private/internal address");
  }
}

export async function scrapeUrl(urlStr: string): Promise<string> {
  try {
    await assertPublicUrl(urlStr);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return `Failed to load web page: HTTP ${res.status} ${res.statusText}`;
    }

    const html = await res.text();
    const text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 15000);

    return text || "The web page loaded successfully, but had no readable text content.";
  } catch (err: any) {
    return `Error reading URL: ${err.message || err}`;
  }
}
