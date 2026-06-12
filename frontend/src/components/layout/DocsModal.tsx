import React, { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { X, Download, BookOpen, Printer, ExternalLink, Search } from 'lucide-react';

interface DocsModalProps {
  open: boolean;
  onClose: () => void;
}

interface Heading {
  id: string;
  text: string;
  level: number;
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Three print styles for Save-as-PDF. Each is rendered into a clean iframe and
// printed from there, so the entire guide exports (every section, code block,
// table, image). Paper is a classic serif document, Studio is the modern
// hairline-and-accent house style, Carbon is a dark blue-accented theme.
// Carbon needs the print dialog's "Background graphics" option enabled.
type PrintTheme = { label: string; hint: string; swatch: string; css: string };

const PRINT_THEMES: Record<'paper' | 'studio' | 'carbon', PrintTheme> = {
  paper: {
    label: 'Paper', hint: 'classic', swatch: '#ffffff',
    css: `
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .page-frame { display: none; }
      .guide, .guide * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .guide { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; font-size: 11pt; line-height: 1.55; max-width: 6.9in; margin: 0 auto; }
      .guide h1, .guide h2, .guide h3, .guide h4 { font-family: Georgia, 'Times New Roman', serif; color: #000; line-height: 1.25; page-break-after: avoid; page-break-inside: avoid; }
      .guide h1 { font-size: 22pt; font-weight: 700; margin: 0 0 12pt; padding-bottom: 6pt; border-bottom: 1.5pt solid #333; }
      .guide h2 { font-size: 15pt; font-weight: 700; margin: 16pt 0 5pt; }
      .guide h3 { font-size: 12pt; font-weight: 700; margin: 11pt 0 3pt; color: #333; }
      .guide p { margin: 6pt 0; }
      .guide ul, .guide ol { margin: 6pt 0 6pt 22pt; padding: 0; }
      .guide li { margin: 3pt 0; }
      .guide a { color: #11457e; text-decoration: underline; }
      .guide strong { color: #000; font-weight: 700; }
      .guide em { font-style: italic; }
      .guide hr { border: none; border-top: 1pt solid #ccc; margin: 12pt 0; }
      .guide blockquote { margin: 8pt 0; padding: 4pt 12pt; border-left: 3pt solid #999; background: #f6f6f6; color: #333; page-break-inside: avoid; }
      .guide blockquote p { margin: 2pt 0; }
      .guide pre { background: #f4f4f4; border: 1pt solid #ddd; border-radius: 2pt; padding: 7pt 9pt; margin: 6pt 0; font-size: 8.5pt; line-height: 1.45; font-family: Consolas, 'Liberation Mono', Menlo, monospace; color: #222; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
      .guide code { font-family: Consolas, 'Liberation Mono', Menlo, monospace; font-size: 9pt; background: #f0f0f0; color: #a02060; padding: 1pt 3pt; border-radius: 2pt; word-break: break-word; }
      .guide pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
      .guide table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9pt; page-break-inside: avoid; }
      .guide th, .guide td { border: 1pt solid #bbb; padding: 4pt 7pt; text-align: left; vertical-align: top; }
      .guide th { background: #eee; color: #000; font-weight: 700; }
      .guide img { display: block; max-width: 100%; height: auto; margin: 9pt auto; page-break-inside: avoid; }
      .guide-cover { text-align: center; min-height: 8.4in; display: flex; flex-direction: column; align-items: center; justify-content: center; page-break-after: always; }
      @page { margin: 0.75in; size: letter; }
    `,
  },
  studio: {
    label: 'Studio', hint: 'modern', swatch: '#7c3aed',
    css: `
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .page-frame { display: none; }
      .guide, .guide * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .guide { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #20222b; font-size: 10pt; line-height: 1.55; max-width: 7.1in; margin: 0 auto; }
      .guide h1, .guide h2, .guide h3, .guide h4 { color: #0e0f15; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; page-break-after: avoid; page-break-inside: avoid; }
      .guide h1 { font-size: 20pt; margin: 0 0 12pt; padding-bottom: 6pt; border-bottom: 1pt solid #6d28d9; letter-spacing: -0.02em; }
      .guide h2 { font-size: 13.5pt; margin: 18pt 0 4pt; padding-bottom: 3pt; border-bottom: 0.5pt solid #e7e4ef; }
      .guide h3 { font-size: 9.5pt; margin: 12pt 0 3pt; color: #6d28d9; text-transform: uppercase; letter-spacing: 0.08em; }
      .guide p { margin: 5pt 0; }
      .guide ul, .guide ol { margin: 5pt 0 5pt 18pt; padding: 0; }
      .guide li { margin: 2.5pt 0; }
      .guide li::marker { color: #9b8bc4; }
      .guide a { color: #6d28d9; text-decoration: none; border-bottom: 0.5pt solid #cbb8f0; }
      .guide strong { color: #0e0f15; font-weight: 650; }
      .guide em { color: #3c3a45; }
      .guide hr { border: none; border-top: 0.5pt solid #e7e4ef; margin: 14pt 0; }
      .guide blockquote { margin: 7pt 0; padding: 1pt 0 1pt 12pt; border-left: 2pt solid #6d28d9; color: #44414f; font-style: italic; page-break-inside: avoid; }
      .guide blockquote p { margin: 2pt 0; }
      .guide pre { background: #f7f6fb; border: 0.5pt solid #e7e4ef; border-radius: 3pt; padding: 7pt 9pt; margin: 6pt 0; font-size: 8pt; line-height: 1.45; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; color: #2c2a38; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
      .guide code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 8.5pt; background: #f1eefa; color: #5b21b6; padding: 0.5pt 3pt; border-radius: 2pt; word-break: break-word; }
      .guide pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
      .guide table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 8.5pt; page-break-inside: avoid; }
      .guide th { text-align: left; font-weight: 700; color: #0e0f15; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.05em; padding: 4pt 8pt 4pt 0; border-bottom: 1pt solid #2c2a38; }
      .guide td { padding: 4pt 8pt 4pt 0; border-bottom: 0.5pt solid #ece9f3; vertical-align: top; color: #2c2a38; }
      .guide img { display: block; max-width: 100%; height: auto; margin: 9pt auto; border-radius: 3pt; page-break-inside: avoid; }
      .guide-cover { text-align: center; min-height: 8.4in; display: flex; flex-direction: column; align-items: center; justify-content: center; page-break-after: always; }
      @page { margin: 0.7in; size: letter; }
    `,
  },
  carbon: {
    label: 'Carbon', hint: 'dark', swatch: '#a855f7',
    css: `
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      html {
        background-color: #050208;
        background-image:
          radial-gradient(58% 40% at 50% -3%, rgba(150,55,230,0.13) 0%, transparent 60%),
          linear-gradient(rgba(6,3,12,0.46) 0%, rgba(6,3,12,0.62) 100%),
          url('/screenshots/carbon-ferro.png');
        background-size: 100% 100%, 100% 100%, cover;
        background-position: center, center, center;
        background-repeat: no-repeat;
      }
      body { margin: 0; padding: 0; background: transparent; }
      /* Soft edge vignette + faint neon glow, fixed so it repeats on every printed
         page. No hard border box, so flowing content can never look like it spills
         past an edge. */
      .page-frame { position: fixed; inset: 0; box-shadow: inset 0 0 130pt rgba(8,4,16,0.9), inset 0 0 26pt rgba(192,38,211,0.14); pointer-events: none; }
      /* Carbon supplies its own margins (page padding) so a full-bleed dark page
         needs the print dialog's Margins set to None; otherwise default margins add
         white edges around the dark sheet. */
      .guide { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #cabfe2; font-size: 10pt; line-height: 1.55; max-width: 6.7in; margin: 0 auto; padding: 0; }
      .guide h1, .guide h2, .guide h3, .guide h4 { color: #f4ecff; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; page-break-after: avoid; page-break-inside: avoid; }
      .guide h1 { font-size: 20pt; margin: 0 0 12pt; padding-bottom: 6pt; border-bottom: 1pt solid #c026d3; color: #fff; text-shadow: 0 0 16px rgba(217,70,239,0.5); letter-spacing: -0.02em; }
      .guide h2 { font-size: 13.5pt; margin: 18pt 0 4pt; padding-bottom: 3pt; border-bottom: 0.5pt solid #2a1740; color: #d8b4fe; }
      .guide h3 { font-size: 9.5pt; margin: 12pt 0 3pt; color: #c084fc; text-transform: uppercase; letter-spacing: 0.08em; }
      .guide p { margin: 5pt 0; }
      .guide ul, .guide ol { margin: 5pt 0 5pt 18pt; padding: 0; }
      .guide li { margin: 2.5pt 0; }
      .guide li::marker { color: #c026d3; }
      .guide a { color: #d8b4fe; text-decoration: none; border-bottom: 0.5pt solid #6b3aa0; }
      .guide strong { color: #fff; font-weight: 650; }
      .guide em { color: #bba7dc; }
      .guide hr { border: none; border-top: 0.5pt solid #2a1740; margin: 14pt 0; }
      .guide blockquote { margin: 7pt 0; padding: 3pt 0 3pt 12pt; border-left: 2pt solid #c026d3; background: #170c28; color: #c7b6e4; font-style: italic; page-break-inside: avoid; }
      .guide blockquote p { margin: 2pt 0; }
      .guide pre { background: #150b27; border: 0.5pt solid #2a1740; border-radius: 3pt; padding: 7pt 9pt; margin: 6pt 0; font-size: 8pt; line-height: 1.45; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; color: #ddccf5; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
      .guide code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 8.5pt; background: #231140; color: #e9d5ff; padding: 0.5pt 3pt; border-radius: 2pt; word-break: break-word; }
      .guide pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
      .guide table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 8.5pt; page-break-inside: avoid; }
      .guide th { text-align: left; font-weight: 700; color: #d8b4fe; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.05em; padding: 4pt 8pt 4pt 0; border-bottom: 1pt solid #c026d3; }
      .guide td { padding: 4pt 8pt 4pt 0; border-bottom: 0.5pt solid #21142f; vertical-align: top; color: #cabfe2; }
      .guide img { display: block; max-width: 100%; height: auto; margin: 9pt auto; border-radius: 3pt; page-break-inside: avoid; }
      .guide-cover { text-align: center; min-height: 8.4in; display: flex; flex-direction: column; align-items: center; justify-content: center; page-break-after: always; }
      @page { margin: 0.5in 0; size: letter; }
    `,
  },
};
type ThemeKey = keyof typeof PRINT_THEMES;

export const DocsModal: React.FC<DocsModalProps> = ({ open, onClose }) => {
  const [markdown, setMarkdown] = useState<string>('');
  const [html, setHtml] = useState<string>('');
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pdfMenuOpen, setPdfMenuOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (markdown) return;
    setLoading(true);
    setError(null);
    fetch('/USER_GUIDE.md')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setMarkdown(text);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [open, markdown]);

  useEffect(() => {
    if (!markdown) return;
    // Parse markdown → HTML and extract h1/h2/h3 for TOC.
    const renderer = new marked.Renderer();
    const collected: Heading[] = [];
    // De-duplicate heading slugs: the guide concatenates many docs that share
    // headings (e.g. "Purpose"), so a raw slug would collide — breaking the TOC
    // React keys AND the scroll-to anchors. Suffix repeats with -2, -3, …
    const slugCounts = new Map<string, number>();
    renderer.heading = ({ tokens, depth }: { tokens: Array<{ raw?: string; text?: string }>; depth: number }) => {
      const text = tokens.map((t) => t.text ?? t.raw ?? '').join('');
      let id = slugify(text);
      const n = (slugCounts.get(id) ?? 0) + 1;
      slugCounts.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      if (depth <= 3) collected.push({ id, text, level: depth });
      return `<h${depth} id="${id}" class="docs-h docs-h-${depth}">${text}</h${depth}>`;
    };
    renderer.code = ({ text, lang }: { text: string; lang?: string }) =>
      `<pre class="docs-code"><code data-lang="${lang || ''}">${text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
    renderer.codespan = ({ text }: { text: string }) =>
      `<code class="docs-inline-code">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`;
    renderer.link = ({ href, title, tokens }: { href: string; title?: string | null; tokens: Array<{ raw?: string; text?: string }> }) => {
      const text = tokens.map((t) => t.text ?? t.raw ?? '').join('');
      const isExternal = /^https?:\/\//.test(href);
      const isAnchor = href.startsWith('#');
      return `<a href="${href}" ${title ? `title="${title}"` : ''} class="docs-link${isExternal ? ' docs-link-external' : ''}" ${isExternal ? 'target="_blank" rel="noreferrer noopener"' : ''} data-anchor="${isAnchor ? '1' : '0'}">${text}</a>`;
    };
    renderer.image = ({ href, title, text }: { href: string; title?: string | null; text?: string }) => {
      // Guide images are written repo-relative (e.g. "screenshots/x.png") so
      // they render on GitHub from docs/. The in-app modal serves the guide
      // from the site root, so a relative path resolves to root-absolute and
      // loads from /screenshots/… regardless of the current route.
      let src = href || '';
      if (src && !/^(https?:|data:|\/)/.test(src)) src = '/' + src.replace(/^\.?\//, '');
      // The title doubles as an optional size hint: "full" spans the column, a
      // bare number is that many px of max-width, anything else stays a normal
      // title. Supporting screenshots default to a moderate width so they do not
      // each eat a whole page.
      let maxW = '500px';
      let titleAttr = '';
      if (title === 'full') maxW = '100%';
      else if (title && /^\d+$/.test(title)) maxW = `${title}px`;
      else if (title) titleAttr = ` title="${title}"`;
      return `<img src="${src}" alt="${text || ''}"${titleAttr} style="max-width:${maxW}" loading="lazy" />`;
    };
    const parsed = marked.parse(markdown, { renderer, gfm: true, breaks: false }) as string;
    setHtml(parsed);
    setHeadings(collected);
  }, [markdown]);

  // Esc closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Smooth-scroll for in-doc anchor links.
  const handleContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const a = target.closest('a[data-anchor="1"]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const id = a.getAttribute('href')?.slice(1);
    if (!id) return;
    const el = contentRef.current?.querySelector(`#${CSS.escape(id)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const scrollToHeading = (id: string) => {
    const el = contentRef.current?.querySelector(`#${CSS.escape(id)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handlePrint = (themeKey: ThemeKey) => {
    if (!html) return;
    // Render the whole guide into an offscreen same-origin iframe with the chosen
    // theme CSS and print THAT. Printing the live modal dropped code blocks and
    // left ghost pages from the hidden app shell. The iframe is given a real size
    // and kept onscreen-but-offset (not display:none or 0x0) and the guide's lazy
    // image loading is stripped, so every screenshot actually loads before print.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;height:1160px;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(iframe);
    const cleanup = () => { try { document.body.removeChild(iframe); } catch { /* already gone */ } };
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) { cleanup(); return; }
    // Eager-load every image in the print copy (lazy images never enter an
    // offscreen iframe's viewport, so they would otherwise print blank).
    const printHtml = html.replace(/\sloading="lazy"/g, '');
    doc.open();
    doc.write(
      '<!doctype html><html><head><meta charset="utf-8">' +
        `<base href="${window.location.origin}/">` +
        '<title>theDAW User Guide</title><style>' + PRINT_THEMES[themeKey].css + '</style></head>' +
        '<body><div class="page-frame"></div><div class="guide">' + printHtml + '</div></body></html>',
    );
    doc.close();
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      win.focus();
      win.print();
      window.setTimeout(cleanup, 1000);
    };
    // Print once images have loaded so none come out blank; fall back after 5s.
    const imgs = Array.from(doc.images);
    let pending = imgs.length;
    if (pending === 0) {
      window.setTimeout(fire, 60);
    } else {
      const tick = () => { pending -= 1; if (pending <= 0) fire(); };
      imgs.forEach((img) => {
        if (img.complete) tick();
        else {
          img.addEventListener('load', tick, { once: true });
          img.addEventListener('error', tick, { once: true });
        }
      });
      window.setTimeout(fire, 5000);
    }
  };

  const handleDownloadMd = () => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'theDAW-user-guide.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filteredHeadings = search.trim()
    ? headings.filter((h) => h.text.toLowerCase().includes(search.trim().toLowerCase()))
    : headings;

  if (!open) return null;

  return (
    <div
      className="docs-modal-root fixed inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="docs-modal-window relative w-[min(1100px,95vw)] h-[min(900px,92vh)] bg-[#0a080f] border border-purple-500/30 rounded-lg shadow-[0_0_40px_rgba(139,92,246,0.2)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="docs-modal-header flex items-center justify-between border-b border-white/10 px-4 py-2.5 bg-linear-to-r from-purple-900/30 to-indigo-900/20 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded bg-linear-to-br from-purple-600 to-indigo-600 flex items-center justify-center">
              <BookOpen className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-black text-[13px] tracking-widest text-white">theDAW Docs</span>
              <span className="text-[9px] font-mono text-purple-300/70 tracking-tighter">theDAW User Guide - by GANTASMO</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleDownloadMd}
              className="docs-btn flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 hover:bg-white/10 text-zinc-300 text-[10px] font-bold uppercase tracking-widest transition-colors"
              title="Download raw Markdown"
            >
              <Download className="w-3 h-3" /> MD
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setPdfMenuOpen((v) => !v)}
                className="docs-btn flex items-center gap-1.5 px-2 py-1 rounded border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/25 text-purple-200 text-[10px] font-bold uppercase tracking-widest transition-colors"
                title="Save the entire User Guide as a PDF in a chosen style"
              >
                <Printer className="w-3 h-3" /> Save as PDF
              </button>
              {pdfMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPdfMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 w-44 rounded-md border border-white/10 bg-[#120e1c] shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden py-1">
                    <div className="px-3 py-1 text-[8px] font-mono uppercase tracking-widest text-zinc-600">PDF style</div>
                    {(Object.keys(PRINT_THEMES) as ThemeKey[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => { setPdfMenuOpen(false); handlePrint(k); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-purple-500/15 hover:text-white transition-colors"
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-white/25" style={{ background: PRINT_THEMES[k].swatch }} />
                        <span className="font-bold uppercase tracking-widest">{PRINT_THEMES[k].label}</span>
                        <span className="ml-auto text-[9px] text-zinc-600 lowercase tracking-normal">{PRINT_THEMES[k].hint}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="docs-btn p-1.5 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body: sidebar TOC + scrollable content */}
        <div className="flex-1 min-h-0 flex">
          <aside className="docs-modal-toc w-65 shrink-0 border-r border-white/10 bg-black/40 flex flex-col min-h-0">
            <div className="px-3 pt-3 pb-2 shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
                <input
                  type="text"
                  name="docs-toc-search"
                  className="compact-input w-full pl-7"
                  placeholder="FILTER TOC..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-1 text-[11px]">
              {filteredHeadings.length === 0 ? (
                <p className="text-zinc-700 italic px-2 py-3">{loading ? 'Loading…' : 'No headings.'}</p>
              ) : (
                filteredHeadings.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => scrollToHeading(h.id)}
                    className={`block w-full text-left py-1 px-2 rounded hover:bg-white/5 transition-colors wrap-break-word ${
                      h.level === 1 ? 'text-zinc-100 font-bold' :
                      h.level === 2 ? 'text-zinc-300 pl-3' :
                      'text-zinc-500 pl-5 text-[10px]'
                    }`}
                  >
                    {h.text}
                  </button>
                ))
              )}
            </nav>
            <div className="px-3 py-2 border-t border-white/10 shrink-0">
              <a
                href="/USER_GUIDE.md"
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-zinc-500 hover:text-purple-300 transition-colors"
              >
                <ExternalLink className="w-2.5 h-2.5" /> Open raw markdown
              </a>
            </div>
          </aside>
          <main className="flex-1 min-h-0 overflow-y-auto bg-[#0e0a18]">
            <div
              ref={contentRef}
              onClick={handleContentClick}
              className="docs-content max-w-200 mx-auto px-8 py-6"
            >
              {loading && <p className="text-zinc-500 italic">Loading user guide…</p>}
              {error && (
                <div className="p-3 rounded border border-red-500/30 bg-red-500/10 text-red-300">
                  Failed to load user guide: {error}
                  <p className="mt-2 text-zinc-400 text-[11px]">
                    The guide is served from <code>/USER_GUIDE.md</code>. If you're running in dev mode, make sure{' '}
                    <code>frontend/public/USER_GUIDE.md</code> exists (the pre-commit hook syncs it from <code>docs/USER_GUIDE.md</code>).
                  </p>
                </div>
              )}
              {!loading && !error && (
                <div className="docs-html" dangerouslySetInnerHTML={{ __html: html }} />
              )}
            </div>
          </main>
        </div>
      </div>

      {/* Scoped styles — both screen + print */}
      <style>{`
        .docs-content h1, .docs-content h2, .docs-content h3 {
          font-family: var(--font-sans);
          color: #f5f3ff;
          letter-spacing: 0.02em;
          scroll-margin-top: 1rem;
        }
        .docs-content .docs-h-1 {
          font-size: 24px;
          font-weight: 900;
          margin-top: 0;
          margin-bottom: 0.5rem;
          padding-bottom: 0.4rem;
          border-bottom: 2px solid rgba(139,92,246,0.4);
        }
        .docs-content .docs-h-2 {
          font-size: 17px;
          font-weight: 800;
          margin-top: 1.4rem;
          margin-bottom: 0.4rem;
          color: #c4b5fd;
        }
        .docs-content .docs-h-3 {
          font-size: 13px;
          font-weight: 700;
          margin-top: 1rem;
          margin-bottom: 0.3rem;
          color: #a78bfa;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .docs-content,
        .docs-content * {
          box-sizing: border-box;
          min-width: 0;
        }
        .docs-content p {
          line-height: 1.55;
          margin: 0.4rem 0;
          font-size: 12px;
          color: #d4d4d8;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .docs-content ul, .docs-content ol {
          margin: 0.4rem 0 0.4rem 1.4rem;
          font-size: 12px;
          color: #d4d4d8;
          line-height: 1.55;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .docs-content li { margin: 0.15rem 0; }
        .docs-content blockquote {
          margin: 0.5rem 0;
          padding: 0.5rem 0.8rem;
          border-left: 3px solid rgba(139,92,246,0.6);
          background: rgba(139,92,246,0.08);
          font-size: 11.5px;
          color: #c4b5fd;
        }
        .docs-content blockquote p { color: #c4b5fd; margin: 0.2rem 0; }
        .docs-content table {
          border-collapse: collapse;
          margin: 0.6rem 0;
          font-size: 11px;
          width: 100%;
        }
        .docs-content th, .docs-content td {
          border: 1px solid rgba(255,255,255,0.08);
          padding: 0.3rem 0.6rem;
          text-align: left;
          color: #d4d4d8;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .docs-content th { background: rgba(139,92,246,0.12); color: #c4b5fd; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
        .docs-content tr:nth-child(2n) td { background: rgba(255,255,255,0.02); }
        .docs-content .docs-code {
          background: #07050a;
          border: 1px solid rgba(139,92,246,0.2);
          border-radius: 4px;
          padding: 0.6rem 0.8rem;
          margin: 0.4rem 0;
          overflow-x: auto;
          font-family: var(--font-mono);
          font-size: 11px;
          line-height: 1.45;
          color: #e9e7f5;
        }
        .docs-content .docs-inline-code {
          font-family: var(--font-mono);
          font-size: 10.5px;
          padding: 1px 5px;
          background: rgba(139,92,246,0.12);
          border-radius: 3px;
          color: #ddd6fe;
          overflow-wrap: anywhere;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .docs-content .docs-link {
          color: #a78bfa;
          text-decoration: underline;
          text-decoration-color: rgba(167,139,250,0.4);
          text-underline-offset: 2px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .docs-content img {
          display: block;
          max-width: 100%;
          height: auto;
          margin: 0.7rem auto;
          border-radius: 6px;
          background: rgba(10, 8, 15, 0.45);
          object-fit: contain;
        }
        .docs-content pre,
        .docs-content code,
        .docs-content a,
        .docs-content li,
        .docs-content blockquote {
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .docs-content table {
          display: block;
          max-width: 100%;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
        }
        .docs-content .docs-link:hover { color: #c4b5fd; text-decoration-color: #c4b5fd; }
        .docs-content hr {
          border: none;
          border-top: 1px solid rgba(255,255,255,0.08);
          margin: 1rem 0;
        }
        .docs-content em { color: #c4b5fd; }
        .docs-content strong { color: #f5f3ff; font-weight: 700; }
        .docs-content .docs-content > p:first-child { margin-top: 0; }
        .docs-content .guide-cover { text-align: center; margin: 0.5rem 0 1.6rem; }
      `}</style>
    </div>
  );
};

