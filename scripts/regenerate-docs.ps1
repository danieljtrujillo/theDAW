# Regenerate user-facing docs (Windows PowerShell variant).
#
# Mirrors scripts/regenerate-docs.sh — same effect, idiomatic PowerShell.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

function Write-Log  { param([string]$msg) Write-Host "[docs] $msg" -ForegroundColor Magenta }
function Write-Warn { param([string]$msg) Write-Host "[docs] $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "[docs] $msg" -ForegroundColor Red }

$src  = 'docs/USER_GUIDE.md'
$dest = 'frontend/public/USER_GUIDE.md'

if (-not (Test-Path $src)) {
    Write-Err "Source guide missing: $src"
    exit 1
}

# 1. Generate feature/docs coverage before syncing the in-app copy.
Write-Log 'Generating feature coverage report'
Push-Location frontend
try {
    & npm exec -- tsx ../scripts/screenshots/featureCoverage.ts
    if ($LASTEXITCODE -ne 0) { Write-Warn 'Coverage report generation failed. Continuing.' }
}
finally { Pop-Location }

# 2. Sync canonical guide → frontend/public for in-app modal.
Write-Log "Syncing $src -> $dest"
$destDir = Split-Path $dest -Parent
if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
Copy-Item -LiteralPath $src -Destination $dest -Force

# 3. Frontend build.
Write-Log 'Building frontend'
Push-Location frontend
try {
    & npx --no vite build *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Err 'Frontend build failed - fix before committing.'
        exit 2
    }
}
finally { Pop-Location }

# 4. Optional Playwright screenshots.
$screenshotScript = 'scripts/screenshots/capture.ts'
$hasPlaywright = (Test-Path 'frontend/node_modules/playwright') -or (Test-Path 'frontend/node_modules/@playwright/test')
$devServerUp = $false
try {
    $resp = Invoke-WebRequest -Uri 'http://localhost:5173' -TimeoutSec 2 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $devServerUp = $true }
} catch { $devServerUp = $false }

if ((Test-Path $screenshotScript) -and $hasPlaywright -and $devServerUp) {
    Write-Log 'Dev server up - taking Playwright screenshots'
    Push-Location frontend
    try {
        & npm exec -- tsx "../$screenshotScript"
        if ($LASTEXITCODE -ne 0) { Write-Warn 'Screenshot script exited non-zero. Continuing.' }
    }
    finally { Pop-Location }
} elseif (-not $hasPlaywright) {
    Write-Warn 'Playwright not installed - skipping screenshots. (Run: cd frontend; npm i -D playwright; npx playwright install chromium)'
} elseif (-not $devServerUp) {
    Write-Warn 'Dev server not running on :5173 - skipping screenshots.'
}

# 5. Stage updated files for the commit.
Write-Log 'Staging docs changes'
try { & git add docs/USER_GUIDE.md frontend/public/USER_GUIDE.md docs/reports scripts/screenshots/specs.ts scripts/screenshots/featureCoverage.ts 2>$null } catch {}
if (Test-Path 'docs/UI/screenshots') {
    try { & git add docs/UI/screenshots 2>$null } catch {}
}
if (Test-Path 'docs/screenshots') {
    try { & git add docs/screenshots 2>$null } catch {}
}

Write-Log 'Done.'
