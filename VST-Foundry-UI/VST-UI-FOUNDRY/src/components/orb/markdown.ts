// ---------------------------------------------------------------------------
// Lightweight markdown renderer for assistant replies (ported from theDAW's
// orb chat so the Foundry assistant renders identically to the Gantasmo orb).
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
