# The pull-request pytest job, run on Linux (WSL) before a PR opens.
#
#   scripts\ci_linux.ps1 [<branch>] [-DryRun]
#
# <branch> defaults to the current branch. It must be COMMITTED locally first:
# the WSL mirror clone (~/theDAW-ci) fetches from this Windows repository, so it
# sees commits and nothing else. -DryRun prints the command and stops.
#
# Exit code: pytest's. CLAUDE.md hard rule 5: this must pass before any pull
# request is opened.
param(
    [Parameter(Position = 0)][string]$Branch,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $Branch) {
    $Branch = (& git -C $PSScriptRoot rev-parse --abbrev-ref HEAD).Trim()
}
if ($Branch -notmatch '^[A-Za-z0-9._/-]+$' -or $Branch -eq 'HEAD') {
    Write-Error "ci_linux: usage: scripts\ci_linux.ps1 <branch>  (got '$Branch'; commit the branch locally first)"
    exit 2
}

# G:\a\b\scripts\ci_linux.sh -> /mnt/g/a/b/scripts/ci_linux.sh
$script = Join-Path $PSScriptRoot 'ci_linux.sh'
$linux = '/mnt/' + $script.Substring(0, 1).ToLower() + ($script.Substring(2) -replace '\\', '/')
$command = "bash '$linux' '$Branch'"

Write-Host "ci_linux: wsl.exe -e bash -lc `"$command`""
if ($DryRun) { exit 0 }

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
    Write-Error 'ci_linux: wsl.exe is not installed; the Linux run needs WSL with Ubuntu.'
    exit 2
}
& wsl.exe -e bash -lc $command
exit $LASTEXITCODE
