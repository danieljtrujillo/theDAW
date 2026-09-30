/**
 * A SING, STUDY or LYRIC surface drawn over other content is opaque in every theme.
 *
 * The edit-theme scope remaps each hardcoded surface class onto a theme tier
 * with unlayered rules in index.css. Brushed Steel, Aurora, Sunset, Deep Sea
 * and the custom image give those tiers translucent values so the backdrop
 * shows through the panes. On an element positioned over other content that
 * translucency shows the content underneath: the rhyme web's dialog resolved
 * to --et-canvas, rgba(14,15,18,0.72) under Brushed Steel, and the analysis
 * pane was visible behind its arcs.
 *
 * Every JSX element under sing/ and lyricstudio/ that is positioned
 * (absolute, fixed or sticky) and carries a themed surface class is resolved
 * against those rules for each theme in EDIT_THEMES and for the custom image.
 * Its background must come out at alpha 1.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';
import { CUSTOM_IMAGE_ID, EDIT_THEMES, resolveEditThemeVars } from '../../../lib/editThemes';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', '..', '..');
const SCANNED_DIRS = [here, join(here, '..', 'lyricstudio')];

// --- the unlayered theme rules ----------------------------------------------

/** One requirement of a compound selector: any alternative, each a set of classes. */
type Requirement = string[][];

interface SurfaceRule {
  order: number;
  selector: string;
  light: boolean | null;
  compound: Requirement[];
  specificity: number;
  value: string;
}

const unescape = (ident: string): string => ident.replace(/\\(.)/g, '$1');

/** Split on a separator that is outside every pair of parentheses. */
const splitTop = (text: string, sep: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};

const CLASS = /^\.((?:\\.|[\w-])+)/;

/** Classes chained with no combinator, e.g. `.a.b`; null for anything else. */
const classChain = (text: string): string[] | null => {
  const classes: string[] = [];
  let rest = text.trim();
  while (rest) {
    const m = CLASS.exec(rest);
    if (!m) return null;
    classes.push(unescape(m[1]));
    rest = rest.slice(m[0].length);
  }
  return classes.length ? classes : null;
};

/** A compound of classes and `:is()` lists of class chains; null when it holds anything else. */
const parseCompound = (text: string): Requirement[] | null => {
  const out: Requirement[] = [];
  let rest = text;
  while (rest) {
    const cls = CLASS.exec(rest);
    if (cls) {
      out.push([[unescape(cls[1])]]);
      rest = rest.slice(cls[0].length);
      continue;
    }
    if (!rest.startsWith(':is(')) return null;
    let depth = 0;
    let end = -1;
    for (let i = 3; i < rest.length; i += 1) {
      if (rest[i] === '(') depth += 1;
      else if (rest[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const alternatives = splitTop(rest.slice(4, end), ',').map(classChain);
    if (alternatives.some((a) => a === null)) return null;
    out.push(alternatives as string[][]);
    rest = rest.slice(end + 1);
  }
  return out.length ? out : null;
};

const SCOPED = /^\.edit-theme-scope(\[data-et-light="1"\]|:not\(\[data-et-light="1"\]\))?\s+([\s\S]+)$/;

/** Whitespace outside every pair of parentheses is a descendant combinator. */
const hasCombinator = (text: string): boolean => {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (/\s/.test(ch) && depth === 0) return true;
  }
  return false;
};

const surfaceRules = (css: string): SurfaceRule[] => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: SurfaceRule[] = [];
  let i = 0;
  let order = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < text.length; close += 1) {
      if (text[close] === '{') depth += 1;
      else if (text[close] === '}' && --depth === 0) break;
    }
    const prelude = text.slice(i, open).trim();
    const body = text.slice(open + 1, close);
    i = close + 1;
    // Layered and at-rule blocks lose to the unlayered remaps, so only top-level rules count.
    if (prelude.startsWith('@')) continue;
    const value = body
      .split(';')
      .map((d) => /^\s*background(?:-color)?\s*:\s*([\s\S]+?)\s*$/.exec(d))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1])
      .pop();
    if (!value) continue;
    for (const selector of splitTop(prelude, ',')) {
      const m = SCOPED.exec(selector);
      if (!m || hasCombinator(m[2].trim())) continue;
      const compound = parseCompound(m[2].trim());
      if (!compound) continue;
      const light = m[1] === undefined ? null : !m[1].startsWith(':not');
      const specificity =
        1 + (m[1] ? 1 : 0) + compound.reduce((sum, req) => sum + Math.max(...req.map((alt) => alt.length)), 0);
      rules.push({ order: order++, selector, light, compound, specificity, value });
    }
  }
  return rules;
};

const matches = (rule: SurfaceRule, classes: ReadonlySet<string>): boolean =>
  rule.compound.every((req) => req.some((alt) => alt.every((c) => classes.has(c))));

// --- colour arithmetic --------------------------------------------------------

const substitute = (value: string, vars: Record<string, string>): string => {
  let out = value;
  for (let pass = 0; /var\(/.test(out); pass += 1) {
    assert.ok(pass < 10, `var() did not resolve in ${value}`);
    out = out.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
      const v = vars[name] ?? fallback;
      assert.ok(v !== undefined, `${name} has no value in ${value}`);
      return v;
    });
  }
  return out.trim();
};

const number = (text: string): number => {
  const t = text.trim();
  return t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
};

const alphaOf = (color: string): number => {
  const c = color.trim();
  let m = /^rgb\(from\s+(.+)\s+r\s+g\s+b\s*\/\s*([\d.]+%?)\s*\)$/.exec(c);
  if (m) {
    alphaOf(m[1]);
    return number(m[2]);
  }
  m = /^#([0-9a-f]+)$/i.exec(c);
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 6) return 1;
    if (hex.length === 4) return parseInt(hex[3] + hex[3], 16) / 255;
    if (hex.length === 8) return parseInt(hex.slice(6), 16) / 255;
  }
  m = /^rgba?\(([^()]*)\)$/.exec(c);
  if (m) {
    const slash = m[1].split('/');
    if (slash.length === 2) return number(slash[1]);
    const commas = m[1].split(',');
    return commas.length === 4 ? number(commas[3]) : 1;
  }
  m = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(c);
  if (m) return (alphaOf(m[1]) * Number(m[2])) / 100;
  if (c === 'transparent') return 0;
  throw new Error(`cannot read the alpha of ${c}`);
};

// --- the positioned elements ----------------------------------------------------

interface Overlay {
  where: string;
  name: string;
  classes: Set<string>;
}

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });

/** Every piece of literal text in a className, template parts included. */
const classText = (node: ts.Node): string => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return ` ${node.text} `;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return ` ${node.text} `;
  let out = '';
  node.forEachChild((child) => {
    out += classText(child);
  });
  return out;
};

const POSITIONED = ['absolute', 'fixed', 'sticky'];

const overlaysIn = (file: string): Overlay[] => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Overlay[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let classes: Set<string> | null = null;
      let name = node.tagName.getText();
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
        const key = attr.name.getText();
        if (key === 'className') classes = new Set(classText(attr.initializer).split(/\s+/).filter(Boolean));
        else if ((key === 'role' || key === 'id') && ts.isStringLiteral(attr.initializer)) {
          name += ` ${key}="${attr.initializer.text}"`;
        }
      }
      if (classes && POSITIONED.some((p) => classes!.has(p))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push({ where: `${relative(srcRoot, file).replace(/\\/g, '/')}:${line + 1}`, name, classes });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
};

// --- the check ----------------------------------------------------------------------

const rules = surfaceRules(readFileSync(join(srcRoot, 'index.css'), 'utf8'));
assert.ok(rules.length > 20, `read only ${rules.length} surface rules from index.css`);

assert.equal(EDIT_THEMES.length, 28, 'the theme list changed size; docs/guides/themes.md names 28');
const themes = [
  ...EDIT_THEMES.map((t) => ({ label: t.label, ...resolveEditThemeVars(t.id, null) })),
  { label: 'custom image', ...resolveEditThemeVars(CUSTOM_IMAGE_ID, 'data:image/png;base64,AAAA') },
];

const overlays = SCANNED_DIRS.flatMap(tsxFiles)
  .flatMap(overlaysIn)
  .filter((o) => rules.some((r) => matches(r, o.classes)));

assert.ok(
  overlays.some((o) => o.where.includes('sing/RhymeWeb.tsx') && o.name.includes('role="dialog"')),
  'the rhyme web dialog was not found among the positioned themed surfaces',
);

const failures: string[] = [];
for (const overlay of overlays) {
  for (const theme of themes) {
    const winner = rules
      .filter((r) => (r.light === null || r.light === theme.light) && matches(r, overlay.classes))
      .sort((a, b) => b.specificity - a.specificity || b.order - a.order)[0];
    const resolved = substitute(winner.value, theme.vars);
    const alpha = alphaOf(resolved);
    if (alpha !== 1) {
      failures.push(
        `${overlay.where} <${overlay.name}> under ${theme.label}: ${winner.selector} -> ${resolved} (alpha ${alpha})`,
      );
    }
  }
}

assert.equal(failures.length, 0, `see-through overlay surfaces:\n${failures.join('\n')}`);

console.log(
  `opaque overlays: ok (${overlays.length} surfaces x ${themes.length} themes)\n` +
    overlays.map((o) => `  ${o.where} <${o.name}>`).join('\n'),
);
