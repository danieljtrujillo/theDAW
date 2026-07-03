// @vitest-environment node
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../server";

// Security regression tests: lock in the origin-lock + security headers so a
// future refactor can't silently re-open the drive-by hole. supertest drives
// the exported app directly — the startup guard means importing it never binds
// a port or auto-starts Stable Diffusion.
describe("origin-lock (CORS) on /api/assistant", () => {
  it("allows the app's own origin and echoes it (never '*')", async () => {
    const res = await request(app)
      .get("/api/assistant/providers")
      .set("Origin", "http://localhost:5472");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5472");
  });

  it("allows requests with no Origin (server-to-server / Claude MCP relay)", async () => {
    const res = await request(app).get("/api/assistant/providers");
    expect(res.status).toBe(200);
  });

  it("blocks a foreign browser Origin with 403", async () => {
    const res = await request(app)
      .get("/api/assistant/providers")
      .set("Origin", "http://evil.com");
    expect(res.status).toBe(403);
  });
});

describe("security response headers", () => {
  it("sets a conservative CSP + nosniff", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("object-src 'none'");
  });
});
