// @vitest-environment node
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../server";

// Validation + origin-lock tests for the extraction endpoints. These cover
// every non-network path (input validation, key resolution, CORS); the happy
// path hits the live Gemini API and is exercised manually from the modal.
describe("/api/extract/detect validation", () => {
  it("400s when image is missing", async () => {
    const res = await request(app)
      .post("/api/extract/detect")
      .send({ mimeType: "image/png", model: "m", apiKey: "k" });
    expect(res.status).toBe(400);
  });

  it("400s when mimeType is unsupported", async () => {
    const res = await request(app)
      .post("/api/extract/detect")
      .send({ image: "aGk=", mimeType: "image/svg+xml", model: "m", apiKey: "k" });
    expect(res.status).toBe(400);
  });

  it("400s when model is missing", async () => {
    const res = await request(app)
      .post("/api/extract/detect")
      .send({ image: "aGk=", mimeType: "image/png", apiKey: "k" });
    expect(res.status).toBe(400);
  });

  it("400s with a clear message when no API key is available", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const res = await request(app)
        .post("/api/extract/detect")
        .send({ image: "aGk=", mimeType: "image/png", model: "m" });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/key/i);
    } finally {
      if (prev) process.env.GEMINI_API_KEY = prev;
    }
  });

  it("blocks a foreign browser Origin with 403 (origin-lock)", async () => {
    const res = await request(app)
      .post("/api/extract/detect")
      .set("Origin", "http://evil.com")
      .send({ image: "aGk=", mimeType: "image/png", model: "m", apiKey: "k" });
    expect(res.status).toBe(403);
  });
});

describe("/api/extract/label validation", () => {
  it("400s when image is missing", async () => {
    const res = await request(app)
      .post("/api/extract/label")
      .send({ mimeType: "image/png", model: "m", apiKey: "k" });
    expect(res.status).toBe(400);
  });

  it("400s when mimeType is unsupported", async () => {
    const res = await request(app)
      .post("/api/extract/label")
      .send({ image: "aGk=", mimeType: "text/html", model: "m", apiKey: "k" });
    expect(res.status).toBe(400);
  });
});
