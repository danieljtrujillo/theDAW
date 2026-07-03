// @vitest-environment node
import { describe, it, expect } from "vitest";
import { assertPublicUrl, isPrivateIp } from "../server";

// Regression: the SSRF guard on fetchWebPage. Pins the private-range detection
// and the URL scheme/host rejection. Literal IPs only (no DNS -> deterministic).
describe("isPrivateIp", () => {
  it("flags loopback / private / link-local / CGNAT / metadata / v4-mapped", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1",
      "fd00::1", "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("allows genuinely public IPs (incl. 172.x outside 16-31)", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe("assertPublicUrl (SSRF guard)", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("javascript:alert(1)")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("ftp://host/x")).rejects.toThrow();
  });

  it("rejects loopback / private / metadata / localhost", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicUrl("http://10.0.0.5/")).rejects.toThrow();
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost/")).rejects.toThrow();
  });

  it("allows a public literal IP", async () => {
    await expect(assertPublicUrl("http://8.8.8.8/")).resolves.toBeUndefined();
  });
});
