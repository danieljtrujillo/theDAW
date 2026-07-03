import { describe, it, expect } from "vitest";
import { inlineMd } from "./AIAssistantOrb";

// Regression: assistant markdown link sanitization. Pins the scheme filter
// (blocks javascript:/data:) and attribute-breakout neutralization.
describe("inlineMd link sanitization (XSS guard)", () => {
  it("blocks javascript: links (href becomes #)", () => {
    const out = inlineMd("[click](javascript:alert(1))");
    expect(out).toContain('href="#"');
    expect(out).not.toContain("javascript:");
  });

  it("allows http/https links", () => {
    expect(inlineMd("[ok](https://example.com)")).toContain('href="https://example.com"');
  });

  it("neutralizes attribute-breakout quotes in URLs", () => {
    const out = inlineMd('[x](http://a" onmouseover=alert(1))');
    expect(out).toContain("%22");
    expect(out).not.toContain('" onmouseover');
  });

  it("escapes raw HTML", () => {
    expect(inlineMd("<script>x</script>")).toContain("&lt;script&gt;");
  });

  it("renders bold and italic", () => {
    expect(inlineMd("**b**")).toContain("<strong>b</strong>");
    expect(inlineMd("*i*")).toContain("<em>i</em>");
  });
});
