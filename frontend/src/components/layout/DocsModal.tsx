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

export const DocsModal: React.FC<DocsModalProps> = ({ open, onClose }) => {
  const [markdown, setMarkdown] = useState<string>('');
  const [html, setHtml] = useState<string>('');
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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
    renderer.heading = ({ tokens, depth }: { tokens: Array<{ raw?: string; text?: string }>; depth: number }) => {
      const text = tokens.map((t) => t.text ?? t.raw ?? '').join('');
      const id = slugify(text);
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

  const handlePrint = () => {
    // Print CSS in the component scopes the print output to just the docs content.
    window.print();
  };

  const handleDownloadMd = () => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stabledaw-user-guide.md';
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
              <span className="font-black text-[13px] uppercase tracking-widest text-white">The DAW Docs</span>
              <span className="text-[9px] font-mono text-purple-300/70 tracking-tighter uppercase">User Guide / Reference</span>
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
            <button
              type="button"
              onClick={handlePrint}
              className="docs-btn flex items-center gap-1.5 px-2 py-1 rounded border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/25 text-purple-200 text-[10px] font-bold uppercase tracking-widest transition-colors"
              title="Print → Save as PDF (use the browser's print dialog)"
            >
              <Printer className="w-3 h-3" /> Save as PDF
            </button>
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
          <aside className="docs-modal-toc w-65 shrink-0 border-r border-white/10 bg-black/40 flex flex-col">
            <div className="px-3 pt-3 pb-2 shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
                <input
                  type="text"
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
                    className={`block w-full text-left py-1 px-2 rounded hover:bg-white/5 transition-colors ${
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
        .docs-content p { line-height: 1.55; margin: 0.4rem 0; font-size: 12px; color: #d4d4d8; }
        .docs-content ul, .docs-content ol { margin: 0.4rem 0 0.4rem 1.4rem; font-size: 12px; color: #d4d4d8; line-height: 1.55; }
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
        }
        .docs-content .docs-link {
          color: #a78bfa;
          text-decoration: underline;
          text-decoration-color: rgba(167,139,250,0.4);
          text-underline-offset: 2px;
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

        @media print {
          /* Force white background on everything — overrides Chrome's "background graphics" behaviour. */
          html, body { background: white !important; background-image: none !important; }
          /* Hide everything except the docs content. */
          body * { visibility: hidden !important; }
          .docs-modal-root, .docs-modal-root * { visibility: visible !important; }
          .docs-modal-root {
            position: static !important;
            background: white !important;
            background-image: none !important;
            backdrop-filter: none !important;
            display: block !important;
            height: auto !important;
          }
          .docs-modal-window {
            position: static !important;
            width: 100% !important;
            height: auto !important;
            max-width: 100% !important;
            background: white !important;
            background-image: none !important;
            border: none !important;
            box-shadow: none !important;
            border-radius: 0 !important;
            display: block !important;
          }
          .docs-modal-window > div { display: block !important; }
          .docs-modal-header, .docs-modal-toc { display: none !important; }
          .docs-modal-window main {
            background: white !important;
            background-image: none !important;
            overflow: visible !important;
          }
          .docs-content { max-width: 100% !important; padding: 0 !important; color: black !important; background: white !important; }
          .docs-content * { color: black !important; background-color: transparent !important; }
          .docs-content .docs-h-1 { border-bottom-color: #7c3aed !important; }
          .docs-content blockquote { background: #f3f0ff !important; border-left-color: #7c3aed !important; }
          .docs-content blockquote * { color: #4c1d95 !important; background-color: #f3f0ff !important; }
          .docs-content .docs-code { background: #f5f3ff !important; border: 1px solid #ddd !important; color: #1a1a1a !important; }
          .docs-content .docs-inline-code { background: #ede9fe !important; color: #4c1d95 !important; }
          .docs-content th { background: #ede9fe !important; color: #4c1d95 !important; }
          .docs-content tr:nth-child(2n) td { background: #faf5ff !important; }
          .docs-content td { border-color: #e0d9f7 !important; }
          .docs-content a { color: #6d28d9 !important; }
          @page { margin: 0.7in; size: letter; }
        }
      `}</style>
    </div>
  );
};
