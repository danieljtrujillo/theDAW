#!/usr/bin/env python3
"""Generate a self-contained HTML git-graph of theDAW's entire history,
styled like a GitLens/Git-Graph view, from the real commit topology.

Horizontal layout: time runs left (oldest) -> right (newest); the main
line sits on the bottom as the flat edge and branches rise upward. The
whole topology is scaled to fit a single window (no scrolling).

Usage:  python scripts/gen_git_graph.py
Writes: docs/git-history.html  (open it in any browser)
"""

import subprocess
import html as _html
from collections import OrderedDict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "docs" / "git-history.html"
FIELD = "\x1f"
REC = "\x1e"


def git(args):
    return subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    ).stdout


fmt = FIELD.join(["%H", "%h", "%P", "%D", "%an", "%ad", "%s"]) + REC
raw = git(
    ["log", "--all", "--topo-order", "--date=format:%Y-%m-%d", f"--pretty=format:{fmt}"]
)

commits = []
for rec in raw.split(REC):
    rec = rec.strip("\n")
    if not rec.strip():
        continue
    H, h, P, D, an, ad, s = (rec.split(FIELD) + [""] * 7)[:7]
    commits.append(
        {
            "H": H,
            "h": h,
            "parents": P.split() if P.strip() else [],
            "refs": D,
            "an": an,
            "ad": ad,
            "s": s,
        }
    )

row_by_hash = {c["H"]: i for i, c in enumerate(commits)}

# ---- lane assignment (process newest -> oldest) -------------------------
PAL = [
    "#a855f7",
    "#e879f9",
    "#f472b6",
    "#fb7185",
    "#f59e0b",
    "#fb923c",
    "#a3e635",
    "#34d399",
    "#2dd4bf",
    "#22d3ee",
    "#38bdf8",
    "#818cf8",
]
active = []  # per-lane: hash the lane is waiting for, or None
col_color = []  # per-lane: color hex, or None
next_color = [0]


def alloc_color():
    c = PAL[next_color[0] % len(PAL)]
    next_color[0] += 1
    return c


def find_free():
    for i, v in enumerate(active):
        if v is None:
            return i
    active.append(None)
    col_color.append(None)
    return len(active) - 1


edges = []  # (child_row, parent_row, color, bend_near_child)
max_col = 0
for i, c in enumerate(commits):
    H = c["H"]
    incoming = [j for j, v in enumerate(active) if v == H]
    if incoming:
        col = incoming[0]
    else:
        col = find_free()
        col_color[col] = alloc_color()
    c["col"] = col
    c["color"] = col_color[col]
    max_col = max(max_col, col)
    for j in incoming:
        if j != col:
            active[j] = None  # converged into `col`
    parents = c["parents"]
    if parents:
        active[col] = parents[0]
        if parents[0] in row_by_hash:
            edges.append((i, row_by_hash[parents[0]], c["color"], False))
        for p in parents[1:]:
            existing = [j for j, v in enumerate(active) if v == p]
            if existing:
                pcol = existing[0]
            else:
                pcol = find_free()
                col_color[pcol] = alloc_color()
                active[pcol] = p
            if p in row_by_hash:
                edges.append((i, row_by_hash[p], col_color[pcol], True))
    else:
        active[col] = None
        col_color[col] = None

# ---- stats --------------------------------------------------------------
authors = OrderedDict()
for c in commits:
    authors[c["an"]] = authors.get(c["an"], 0) + 1
dates = [c["ad"] for c in commits if c["ad"]]
span = f"{min(dates)} → {max(dates)}" if dates else ""
n_branches = len(
    [
        r
        for r in git(["for-each-ref", "--format=%(refname)", "refs/heads"]).splitlines()
        if r.strip()
    ]
)
n_remotes = len(
    [
        r
        for r in git(
            ["for-each-ref", "--format=%(refname)", "refs/remotes"]
        ).splitlines()
        if r.strip()
    ]
)
n_tags = len(
    [
        r
        for r in git(["for-each-ref", "--format=%(refname)", "refs/tags"]).splitlines()
        if r.strip()
    ]
)
n_merges = sum(1 for c in commits if len(c["parents"]) > 1)
top_authors = sorted(authors.items(), key=lambda kv: -kv[1])[:6]


def stat(label, value):
    return f'<div class="stat"><div class="sv">{value}</div><div class="sl">{label}</div></div>'


stats_html = "".join(
    [
        stat("commits", f"{len(commits):,}"),
        stat("branches", f"{n_branches}<span class='sub'>+{n_remotes} remote</span>"),
        stat("tags", n_tags),
        stat("merges", f"{n_merges:,}"),
        stat("contributors", len(authors)),
        stat("span", f"<span class='span'>{span}</span>"),
    ]
)
auth_html = "".join(
    f'<span class="auth-chip">{_html.escape(a)}<b>{n}</b></span>'
    for a, n in top_authors
)

# ---- geometry -----------------------------------------------------------
# Transposed vs the classic vertical view: rotate 90deg clockwise, then
# flip vertically. Net effect: x = time (oldest left, newest right),
# y = lane (col 0 / main on the bottom, branches rising upward).
N = len(commits)
SX = 6.0  # content px per commit along the time axis
SY = 48.0  # content px per lane along the vertical axis
DOT = 3.0
PAD_L, PAD_R, PAD_T, PAD_B = 46, 150, 132, 52

content_h = PAD_T + max_col * SY + PAD_B
content_w = PAD_L + (N - 1 if N else 0) * SX + PAD_R


def esc(s):
    return _html.escape(s or "", quote=True)


def X(row):
    # row 0 = newest -> far right; row N-1 = oldest -> far left
    return PAD_L + (N - 1 - row) * SX


def Y(col):
    # col 0 = main -> bottom; higher cols rise upward
    return content_h - PAD_B - col * SY


def edge_path(cr, pr, bend_near_child):
    x1, y1 = X(cr), Y(commits[cr]["col"])
    x2, y2 = X(pr), Y(commits[pr]["col"])
    # child (cr) is newer -> x1 >= x2 (child sits to the right of its parent)
    if abs(y1 - y2) < 0.5:
        return f"M{x1:.1f},{y1:.1f} L{x2:.1f},{y2:.1f}"
    span = x1 - x2
    b = max(SX * 1.5, 7.0)
    if span > 0:
        b = min(b, span * 0.45)
    if bend_near_child:
        # change lanes just left of the child, then run flat to the parent
        return (
            f"M{x1:.1f},{y1:.1f} "
            f"C{x1 - b:.1f},{y1:.1f} {x1 - b:.1f},{y2:.1f} {x1 - 2 * b:.1f},{y2:.1f} "
            f"L{x2:.1f},{y2:.1f}"
        )
    # run flat along the child's lane, then change lanes near the parent
    return (
        f"M{x1:.1f},{y1:.1f} L{x2 + 2 * b:.1f},{y1:.1f} "
        f"C{x2 + b:.1f},{y1:.1f} {x2 + b:.1f},{y2:.1f} {x2:.1f},{y2:.1f}"
    )


edge_svg = "".join(
    f'<path d="{edge_path(cr, pr, b)}" stroke="{col}" stroke-width="2"/>'
    for (cr, pr, col, b) in edges
)


def node_circle(i, c):
    x, y = X(i), Y(c["col"])
    m = len(c["parents"]) > 1
    r = DOT + 1.7 if m else DOT
    return (
        f'<circle class="nd" cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" '
        f'fill="{"#0b0912" if m else c["color"]}" stroke="{c["color"]}" '
        f'stroke-width="{2.0 if m else 1.2}" '
        f'data-h="{c["h"]}" data-d="{c["ad"]}" '
        f'data-a="{esc(c["an"])}" data-s="{esc(c["s"])}"/>'
    )


node_svg = "".join(node_circle(i, c) for i, c in enumerate(commits))


def ref_labels_svg():
    out = []
    for i, c in enumerate(commits):
        if not c["refs"].strip():
            continue
        x, y = X(i), Y(c["col"])
        out.append(
            f'<line x1="{x:.1f}" y1="{y:.1f}" x2="{x:.1f}" y2="{y - 9:.1f}" '
            f'stroke="{c["color"]}" stroke-width="1" opacity="0.6"/>'
        )
        k = 0
        for r in c["refs"].split(","):
            r = r.strip()
            if not r:
                continue
            if r.startswith("tag: "):
                txt, fill = r[5:], "#f6c453"
            elif "HEAD ->" in r:
                txt, fill = r.split("->", 1)[1].strip(), "#c084fc"
            elif r == "HEAD":
                txt, fill = "HEAD", "#c084fc"
            else:
                txt, fill = r, c["color"]
            oy = 11 + k * 15
            out.append(
                f'<text transform="translate({x:.1f},{y - oy:.1f}) rotate(-45)" '
                f'class="reflbl" fill="{fill}">{_html.escape(txt)}</text>'
            )
            k += 1
    return "".join(out)


ref_svg = ref_labels_svg()

# ---- month gridlines (approximate: leftmost commit of each year-month) --
month_x = {}
for i, c in enumerate(commits):
    ym = (c["ad"] or "")[:7]
    if len(ym) != 7:
        continue
    x = X(i)
    if ym not in month_x or x < month_x[ym]:
        month_x[ym] = x
tick_parts = []
last_lbl = -1e9
for ym in sorted(month_x):
    x = month_x[ym]
    tick_parts.append(
        f'<line class="tick" x1="{x:.1f}" y1="{PAD_T - 22:.1f}" '
        f'x2="{x:.1f}" y2="{content_h - PAD_B + 8:.1f}"/>'
    )
    if x - last_lbl > 48:
        tick_parts.append(
            f'<text class="ticklbl" x="{x:.1f}" y="{content_h - PAD_B + 26:.1f}">{ym}</text>'
        )
        last_lbl = x
tick_svg = "".join(tick_parts)

# ---- styling ------------------------------------------------------------
CSS = """
* { box-sizing: border-box; }
:root {
  --ground:#0b0912; --panel:#141020; --line:#241d38; --text:#e6e3ef;
  --muted:#8f88a3; --hash:#6f6885; --accent:#c084fc;
  --sans: system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;
  --mono: ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace;
}
html,body { margin:0; height:100%; }
.wrap { background:var(--ground); color:var(--text); font-family:var(--sans);
  height:100vh; display:flex; flex-direction:column; overflow:hidden;
  -webkit-font-smoothing:antialiased; }
header { flex:none; background:linear-gradient(180deg,#0d0a16 0%,rgba(11,9,18,.92) 100%);
  border-bottom:1px solid var(--line); padding:12px clamp(14px,3vw,32px) 10px; }
.brand { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
h1 { font-size:18px; margin:0; font-weight:650; letter-spacing:-.01em; }
h1 b { color:var(--accent); }
.tag-line { color:var(--muted); font-size:12px; font-family:var(--mono); }
.authors { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }
.auth-chip { font-size:11px; font-family:var(--mono); color:var(--muted);
  background:var(--panel); border:1px solid var(--line); border-radius:999px; padding:3px 9px; }
.auth-chip b { color:var(--text); margin-left:5px; font-weight:600; }
.stats { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.stat { background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:5px 12px; }
.sv { font-size:16px; font-weight:650; font-family:var(--mono); font-variant-numeric:tabular-nums;
  display:flex; align-items:baseline; gap:6px; }
.sv .sub, .sv .span { font-size:10px; color:var(--muted); font-weight:500; }
.sl { font-size:9.5px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted); margin-top:1px; }
.legend { display:flex; gap:14px; margin-top:9px; flex-wrap:wrap; align-items:center;
  font-size:11px; color:var(--muted); }
.legend .k { display:inline-flex; align-items:center; gap:6px; }
.legend .swatch { width:20px; height:0; border-top:2px solid; border-radius:2px; }
.legend .dot { width:9px; height:9px; border-radius:50%; border:2px solid var(--accent); background:var(--ground); }
.graph { position:relative; flex:1 1 auto; min-height:0; }
.gsvg { width:100%; height:100%; display:block; }
.gsvg path { fill:none; }
.gsvg .reflbl { font:600 16px var(--mono); paint-order:stroke; stroke:#0b0912;
  stroke-width:3px; stroke-linejoin:round; }
.gsvg .tick { stroke:#241d38; stroke-width:1; opacity:.55; }
.gsvg .ticklbl { font:500 15px var(--mono); fill:#6f6885; text-anchor:middle; }
.gsvg .nd { cursor:pointer; }
.gsvg .nd:hover { stroke:#ffffff; }
.axis { position:absolute; top:8px; font:600 11px var(--mono); color:var(--muted);
  letter-spacing:.08em; pointer-events:none; }
.axis.l { left:14px; } .axis.r { right:14px; }
#tip { position:fixed; z-index:20; display:none; max-width:440px; pointer-events:none;
  background:#181328; border:1px solid var(--line); border-radius:8px; padding:8px 11px;
  box-shadow:0 8px 30px rgba(0,0,0,.55); }
#tip b { display:block; font-size:12.5px; color:var(--text); font-weight:600;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:418px; }
#tip span { display:block; margin-top:3px; font:11px var(--mono); color:var(--muted); }
footer { flex:none; color:var(--hash); font-size:10.5px; font-family:var(--mono);
  padding:6px clamp(14px,3vw,32px); border-top:1px solid var(--line); }
"""

JS = """
(function(){
  var svg=document.querySelector('.gsvg');
  var tip=document.getElementById('tip');
  var b=document.createElement('b'), s=document.createElement('span');
  tip.appendChild(b); tip.appendChild(s);
  svg.addEventListener('mouseover',function(e){
    var t=e.target;
    if(!(t.classList&&t.classList.contains('nd'))) return;
    b.textContent=t.getAttribute('data-s')||'';
    s.textContent=t.getAttribute('data-h')+'  \\u00b7  '+t.getAttribute('data-d')+'  \\u00b7  '+t.getAttribute('data-a');
    tip.style.display='block';
  });
  svg.addEventListener('mousemove',function(e){
    if(tip.style.display!=='block') return;
    var pad=14,w=tip.offsetWidth,h=tip.offsetHeight;
    var x=e.clientX+pad,y=e.clientY+pad;
    if(x+w>window.innerWidth) x=e.clientX-pad-w;
    if(y+h>window.innerHeight) y=e.clientY-pad-h;
    tip.style.left=x+'px'; tip.style.top=y+'px';
  });
  svg.addEventListener('mouseout',function(e){
    if(e.target.classList&&e.target.classList.contains('nd')) tip.style.display='none';
  });
})();
"""

lane_swatches = "".join(
    f'<span class="k"><span class="swatch" style="border-color:{PAL[i]}"></span></span>'
    for i in range(6)
)

HTML = f"""<title>theDAW — git history</title>
<style>{CSS}</style>
<div class="wrap">
<header>
  <div class="brand">
    <h1>the<b>DAW</b> · git history</h1>
    <span class="tag-line">gantasmo/theDAW — every commit across all branches, oldest at left</span>
    <span class="authors">{auth_html}</span>
  </div>
  <div class="stats">{stats_html}</div>
  <div class="legend">
    <span class="k"><span class="dot"></span> commit / <span style="color:var(--text)">merge</span> = ringed</span>
    <span class="k">lanes = branches {lane_swatches}</span>
    <span class="k">time: left = oldest -&gt; right = newest</span>
    <span class="k">main on the bottom, branches rise up</span>
  </div>
</header>
<div class="graph">
  <div class="axis l">&lt;- oldest</div>
  <div class="axis r">newest -&gt;</div>
  <svg class="gsvg" viewBox="0 0 {content_w:.0f} {content_h:.0f}" preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision">
    <g class="ticks">{tick_svg}</g>
    <g stroke-linecap="round" stroke-linejoin="round">{edge_svg}</g>
    <g class="nodes">{node_svg}</g>
    <g class="labels">{ref_svg}</g>
  </svg>
</div>
<footer>{len(commits):,} commits · {n_branches} local branches · {n_remotes} remote-tracking · {n_tags} tags · {n_merges} merges · {max_col + 1} lanes · generated from live git topology</footer>
</div>
<div id="tip"></div>
<script>{JS}</script>
"""

OUT.write_text(HTML, encoding="utf-8")
print(f"wrote {OUT}")
print(
    f"commits={len(commits)} lanes={max_col + 1} content_w={content_w:.0f} "
    f"content_h={content_h:.0f} edges={len(edges)} merges={n_merges}"
)
