// ---------------------------------------------------------------------------
// Lightweight markdown renderer for assistant replies.
//
// LITERAL COPY of VST-Foundry-UI/VST-UI-FOUNDRY/src/components/orb/markdown.ts
// (the red orb's renderer), kept byte-for-byte — 2-space indent, double quotes
// — so the two files stay diffable against each other. Do not restyle it to
// theDAW's house format; fix it in both places or in neither.
//
// Why it replaced react-markdown here: theDAW's frontend has never had
// `@tailwindcss/typography` installed, so the `prose prose-invert prose-sm …`
// classes the old renderer hung on its container compiled to NOTHING, while
// Tailwind's preflight went on stripping heading sizes, list markers, table
// borders and code styling. Headings, lists, tables and code all rendered as
// flat text. This renderer emits plain HTML that `assistant-prose.css` styles
// directly, which is exactly how the Foundry gets its formatting.
//
// SECURITY — this output is fed to dangerouslySetInnerHTML. Two properties
// carry that, and both are covered by markdown.test.ts:
//   1. `&`, `<` and `>` are escaped BEFORE any HTML is built, in inlineMd and
//      in the fenced-code branch of simpleMarkdown. A `<script>` tag or an
//      `onerror=` attribute in assistant text can therefore only ever come out
//      as inert text.
//   2. Link hrefs are scheme-whitelisted (http/https/mailto/# / relative) and
//      any `"` in the surviving URL is percent-encoded, so `javascript:` and
//      `data:` links collapse to `#` and no URL can break out of the attribute.
// Keep both intact.
// ---------------------------------------------------------------------------
export function inlineMd(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
      // Security: only allow safe link schemes; block javascript:/data:/etc.,
      // and neutralize any quote that could break out of the href attribute.
      const raw = String(url).trim();
      const safe = /^(https?:|mailto:|#|\/)/i.test(raw) ? raw.replace(/"/g, "%22") : "#";
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
}

function buildTable(rows: string[]): string {
  if (rows.length < 1) return "";
  const parse = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const hdrs = parse(rows[0]);
  const sep = rows.length > 1 && /^[\s|:-]+$/.test(rows[1]);
  const start = sep ? 2 : 1;
  let h = "<table><thead><tr>" + hdrs.map((c) => `<th>${inlineMd(c)}</th>`).join("") + "</tr></thead><tbody>";
  for (let r = start; r < rows.length; r++) {
    if (/^[\s|:-]+$/.test(rows[r])) continue;
    h += "<tr>" + parse(rows[r]).map((c) => `<td>${inlineMd(c)}</td>`).join("") + "</tr>";
  }
  return h + "</tbody></table>";
}

function isBlockStart(line: string): boolean {
  const t = line.trim();
  return /^#{1,4}\s/.test(line) || /^>\s?/.test(line) || /^\s*[-*+]\s/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
    (/^\|.+\|$/.test(t)) || /^\x00P\d+\x00$/.test(line);
}

export function simpleMarkdown(text: string): string {
  const ph: string[] = [];
  const src = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    ph.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${esc}</code></pre>`);
    return `\x00P${ph.length - 1}\x00`;
  });
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const pm = line.match(/^\x00P(\d+)\x00$/);
    if (pm) { out.push(ph[parseInt(pm[1])]); i++; continue; }
    if (!trimmed) { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push("<hr/>"); i++; continue; }
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) { out.push(`<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${buf.map((l) => inlineMd(l)).join("<br/>")}</blockquote>`);
      continue;
    }
    if (/^\|.+\|$/.test(trimmed)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) { rows.push(lines[i]); i++; }
      out.push(buildTable(rows));
      continue;
    }
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s/, "")); i++; }
      out.push(`<ul>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s/, "")); i++; }
      out.push(`<ol>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</ol>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    if (para.length) out.push(`<p>${para.map((l) => inlineMd(l)).join("<br/>")}</p>`);
  }
  return out.join("\n");
}
