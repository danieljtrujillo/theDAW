# GANduit setup - fetch iPlug2 and stage the GANduit project from its WebView
# example. Run from the ganduit/ directory:  pwsh ./scripts/setup.ps1
#
# This does NOT build (that needs Visual Studio + the iPlug2 toolchain). It lays
# down the iPlug2 tree and copies our src/ over the IPlugWebUI example so the
# generated VST3/CLAP/AU projects pick up GANduit's class + config.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot           # ganduit/
$deps = Join-Path $root 'iPlug2'

if (-not (Test-Path $deps)) {
  Write-Host 'Cloning iPlug2 (shallow)...'
  git clone --depth 1 https://github.com/iPlug2/iPlug2.git $deps
} else {
  Write-Host 'iPlug2 already present - skipping clone.'
}

# iPlug2 ships its prebuilt dependencies as downloadable archives. Fetch the
# Windows set (VST3 SDK, WebView2, etc.) via the vendored script.
$dlWin = Join-Path $deps 'Dependencies/IPlug/download-iplug-sdks.sh'
Write-Host "Next: install dependencies per iPlug2 docs:"
Write-Host "  - Windows: run Dependencies\\download-prebuilt-libs.sh (Git Bash) and"
Write-Host "    Dependencies\\IPlug\\download-iplug-sdks.sh"
Write-Host "  - WebView2: ensure the Evergreen runtime is installed."

# The IPlugWebUI example is our project template; duplicate it, then overlay src/.
$example = Join-Path $deps 'Examples/IPlugWebUI'
$project = Join-Path $root 'project'
if (Test-Path $example) {
  if (-not (Test-Path $project)) {
    Write-Host "Duplicating IPlugWebUI -> project/ as GANduit..."
    python (Join-Path $deps 'Scripts/duplicate.py') $example 'GANduit' 'GTSM' $project
  }
  Write-Host "Overlaying ganduit/src over the generated project sources..."
  Copy-Item (Join-Path $root 'src/*') (Join-Path $project 'GANduit') -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "iPlug2 Examples/IPlugWebUI not found - check the clone." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done staging. Open project/GANduit/GANduit-app.sln (or the VST3/CLAP"
Write-Host "targets) in Visual Studio to build. See ganduit/README.md."
