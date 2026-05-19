# Install StableDAW git hooks (PowerShell variant for Windows).
#
# Usage:  .\scripts\install-hooks.ps1
#
# Copies hook scripts from scripts/git-hooks/ into .git/hooks/.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$hooksSrc = Join-Path $repoRoot 'scripts/git-hooks'
$hooksDst = Join-Path $repoRoot '.git/hooks'

if (-not (Test-Path $hooksDst)) {
    Write-Error "[hooks] $hooksDst does not exist - is this a git repo?"
    exit 1
}

Get-ChildItem -File -Path $hooksSrc | ForEach-Object {
    $dst = Join-Path $hooksDst $_.Name
    Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
    Write-Host "[hooks] Installed: $($_.Name)" -ForegroundColor Magenta
}

Write-Host '[hooks] Done. Hooks run on every commit; bypass with --no-verify.' -ForegroundColor Magenta
