// Stage the headless notation engraver (frontend/scripts + the Node packages it
// imports) at electron-ui/resources/notation-renderer, so electron-builder can
// copy it into the installer as python/frontend (see electron-builder.yml ->
// extraResources).
//
// Why the layout is exactly "python/frontend": backend/modules/notation/pdf_render.py
// derives its repo root from its own file location, which in a packaged app is
// <resources>/python, and then looks for <root>/frontend/scripts/renderScorePdf.mjs
// plus <root>/frontend/node_modules/opensheetmusicdisplay. It spawns node with cwd
// set to that frontend dir, so the packages have to sit in a node_modules BESIDE
// the scripts. Nothing in pdf_render.py needs to change; this staging just puts
// the tree where it already looks.
//
// Two decisions worth knowing about, both measured rather than guessed:
//
//   OPTIONAL DEPS ARE OMITTED. OpenSheetMusicDisplay declares `gl` (a native
//   WebGL binding, 85 MB with its node-gyp/prebuild toolchain) as an OPTIONAL
//   dependency and never requires it; the engraver runs the SVG backend. Dropping
//   optionals takes the tree from 188 MB to 85 MB and both renderers still produce
//   byte-identical PDFs.
//
//   SOURCE MAPS ARE STRIPPED. 36 MB of the remainder is .map files, which only a
//   debugger reads. Removing them takes the tree to roughly 49 MB.
//
// Pre-bundling the two scripts with esbuild was evaluated and rejected: jsdom
// resolves its node builtins through dynamic require(), so an ESM bundle dies at
// startup with "Dynamic require of \"path\" is not supported", and a CJS bundle
// cannot be produced at all because both renderers use top-level await.
//
// Run:  node scripts/fetch-notation-renderer.mjs

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..') // stable-audio-3
const frontendDir = resolve(repoRoot, 'frontend')
const stageDir = resolve(__dirname, '..', 'resources', 'notation-renderer')

// Everything the two renderers and scripts/lib import. Versions are not written
// here: they are read from frontend/package-lock.json so the packaged engraver is
// the SAME build the SCORE tab renders with. A different OSMD would paginate
// differently, and the whole point of engraving headlessly with OSMD is that the
// downloaded PDF is the sheet the user was just looking at.
const PACKAGES = [
  '@coderline/alphatab',
  'jsdom',
  'jspdf',
  'opensheetmusicdisplay',
  'svg2pdf.js',
]

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(cmd, args, cwd) {
  // On Windows npm resolves to npm.cmd, and Node 20+ refuses to execFile a .cmd
  // directly. Route through cmd.exe (not shell:true, which is deprecated for
  // argument arrays) so the shim resolves.
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd, stdio: 'inherit' })
  } else {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' })
  }
}

/** Exact installed versions from the frontend lockfile, keyed by package name. */
function pinnedVersions() {
  const lockPath = join(frontendDir, 'package-lock.json')
  if (!existsSync(lockPath)) {
    throw new Error(`[fetch-notation] frontend lockfile not found at ${lockPath}`)
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const pins = {}
  for (const name of PACKAGES) {
    const entry = lock.packages?.[`node_modules/${name}`]
    if (!entry?.version) {
      throw new Error(
        `[fetch-notation] ${name} is not resolved in ${lockPath}; ` +
          'run npm install in frontend/ first',
      )
    }
    pins[name] = entry.version
  }
  return pins
}

/** Delete every .map under dir, returning how many bytes that freed. */
function stripSourceMaps(dir) {
  let freed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      freed += stripSourceMaps(full)
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      freed += statSync(full).size
      rmSync(full)
    }
  }
  return freed
}

function treeSize(dir) {
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = treeSize(full)
      bytes += sub.bytes
      files += sub.files
    } else if (entry.isFile()) {
      bytes += statSync(full).size
      files += 1
    }
  }
  return { bytes, files }
}

/** The node the smoke render should use: the one the installer will ship, when
 *  fetch-runtime-tools.mjs has already put it in place, else this build's own.
 *  Engine ranges matter here (jsdom pins a minimum Node), so testing against the
 *  binary that will actually run the engraver is the only test worth having. */
function smokeNode() {
  const bundled = resolve(
    __dirname,
    '..',
    'resources',
    'tools',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
  return existsSync(bundled) ? bundled : process.execPath
}

/** Engrave a two-bar fixture through both renderers, from the staged tree only.
 *
 *  A staged tree that cannot render is worse than no staging at all, because the
 *  failure would only surface on an end user's machine after an install. This
 *  runs the real entry points the backend spawns, with the same cwd, and insists
 *  on a real PDF header. */
function smokeRender() {
  const work = mkdtempSync(join(tmpdir(), 'thedaw-notation-smoke-'))
  const musicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Smoke</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
`
  const alphaTex = ':4 3.3 5.3 3.4 5.4 | 3.5 5.5 3.6 5.6\n'
  const cases = [
    ['renderScorePdf.mjs', 'smoke.musicxml', musicXml, 'smoke-sheet.pdf'],
    ['renderTabPdf.mjs', 'smoke.alphatex', alphaTex, 'smoke-tab.pdf'],
  ]
  const node = smokeNode()
  console.log(`[fetch-notation] smoke node: ${node}`)
  try {
    for (const [script, sourceName, body, outName] of cases) {
      const source = join(work, sourceName)
      const output = join(work, outName)
      writeFileSync(source, body, 'utf8')
      // cwd is the staged root for the same reason pdf_render.py uses it: that is
      // where node finds the staged node_modules.
      execFileSync(node, [join('scripts', script), source, output], {
        cwd: stageDir,
        stdio: 'inherit',
      })
      const header = readFileSync(output).subarray(0, 5).toString('latin1')
      if (header !== '%PDF-') {
        throw new Error(`[fetch-notation] ${script} produced no PDF at ${output}`)
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function main() {
  const sourceScripts = join(frontendDir, 'scripts')
  if (!existsSync(join(sourceScripts, 'renderScorePdf.mjs'))) {
    throw new Error(`[fetch-notation] renderer scripts not found at ${sourceScripts}`)
  }
  const pins = pinnedVersions()
  console.log(
    `[fetch-notation] staging engraver with ${Object.entries(pins)
      .map(([n, v]) => `${n}@${v}`)
      .join(', ')}`,
  )

  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  cpSync(sourceScripts, join(stageDir, 'scripts'), { recursive: true })

  // "private" keeps npm from ever treating the stage as publishable; the name
  // matches nothing on the registry. No "type" field: both renderers are .mjs,
  // so they are ESM regardless, and the packages they pull are CJS.
  writeFileSync(
    join(stageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'thedaw-notation-renderer',
        version: '0.0.0',
        private: true,
        description: 'Headless MusicXML/alphaTex to PDF engraver shipped with theDAW.',
        dependencies: pins,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log('[fetch-notation] installing engraver dependencies into the stage')
  run(npmCmd, ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], stageDir)

  const modules = join(stageDir, 'node_modules')
  for (const name of PACKAGES) {
    if (!existsSync(join(modules, name))) {
      throw new Error(`[fetch-notation] ${name} did not install into ${modules}`)
    }
  }
  // scripts/lib/alphaTabSvg.mjs reads this file at render time to draw music
  // symbols as outlines; without it every tab PDF prints mojibake instead of
  // noteheads, and the renderer aborts.
  const bravura = join(modules, '@coderline', 'alphatab', 'dist', 'font', 'Bravura.svg')
  if (!existsSync(bravura)) {
    throw new Error(`[fetch-notation] Bravura.svg missing at ${bravura}`)
  }

  const freed = stripSourceMaps(modules)
  console.log(`[fetch-notation] stripped ${(freed / 1024 / 1024).toFixed(1)} MB of source maps`)

  console.log('[fetch-notation] smoke-rendering a sheet and a tab from the staged tree')
  smokeRender()

  const { bytes, files } = treeSize(stageDir)
  console.log(
    `[fetch-notation] staged engraver at ${stageDir} ` +
      `(${(bytes / 1024 / 1024).toFixed(1)} MB, ${files} files)`,
  )
}

main()
