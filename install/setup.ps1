<#
  theDAW - Setup & Doctor

  Double-click Setup-theDAW.bat (which runs this), or let theDAW.bat call it
  automatically the first time a required tool is missing.

  It checks your system first (read-only), shows EXACTLY what needs to be
  installed and how big it is, asks once, then installs the missing pieces
  from official sources. No terminal commands are required from you.

  Exit codes (consumed by theDAW.bat):
    0   nothing to install, or everything REQUIRED is already present
    2   a required tool (uv / Node) is still missing (declined or failed)
    10  installed something - re-run theDAW.bat so PATH refreshes

  Switch:
    -Yes   assume "yes" to the prompts (non-interactive)
#>
[CmdletBinding()]
param([switch]$Yes)
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------- #
#  pretty printing
# --------------------------------------------------------------------------- #
function Line(){ Write-Host ("-" * 64) -ForegroundColor DarkGray }
function Head($t){ Write-Host ""; Line; Write-Host "  $t" -ForegroundColor Cyan; Line }
function OK($t){   Write-Host "  [OK]  $t" -ForegroundColor Green }
function WARN($t){ Write-Host "  [!!]  $t" -ForegroundColor Yellow }
function BAD($t){  Write-Host "  [XX]  $t" -ForegroundColor Red }
function Info($t){ Write-Host "        $t" -ForegroundColor Gray }
function Ask($q){
  if($Yes){ return $true }
  Write-Host ""
  $a = Read-Host "  $q  [Y/n]"
  return ($a -eq '' -or $a -match '^(y|yes)$')
}

function Have($name){ return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Re-read PATH from the registry so freshly installed tools are visible to
# checks later in THIS process (the parent cmd still needs a re-run).
function Refresh-Path(){
  $m = [Environment]::GetEnvironmentVariable('Path','Machine')
  $u = [Environment]::GetEnvironmentVariable('Path','User')
  $parts = @()
  if($m){ $parts += $m }
  if($u){ $parts += $u }
  $env:Path = ($parts -join ';')
}

$wingetOk = Have 'winget'

function Install-Uv(){
  Info "Installing uv (Astral standalone installer, user scope)..."
  try {
    & powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    return $true
  } catch {
    BAD ("uv install failed: " + $_.Exception.Message)
    return $false
  }
}

function Install-Winget($id, $label){
  if(-not $wingetOk){
    WARN "winget is not available, so $label cannot be auto-installed."
    Info "Install 'App Installer' from the Microsoft Store, or download $label from its site, then re-run."
    return $false
  }
  Info "Installing $label via winget ($id). Approve the Windows prompt if it appears."
  & winget install --id $id -e --accept-source-agreements --accept-package-agreements
  if($LASTEXITCODE -eq 0){ return $true }
  WARN "winget exited $LASTEXITCODE for $label."
  return $false
}

Clear-Host
Write-Host ""
Write-Host "  theDAW - SETUP" -ForegroundColor Magenta
Write-Host "  Detects your hardware and installs what theDAW needs to run." -ForegroundColor Gray

# =========================================================================== #
#  PHASE 1 - read-only system check
# =========================================================================== #
Head "Checking your system (nothing is installed yet)"

try {
  $build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
  OK "Windows build $build"
} catch { }

try {
  $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $cores = [int]$cs.NumberOfLogicalProcessors
  $ramGB = [int][math]::Round([double]$cs.TotalPhysicalMemory / 1GB)
  OK "CPU: $cores logical cores  |  RAM: ${ramGB} GB"
} catch { }

try {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $drive = (Split-Path -Qualifier $repoRoot).TrimEnd(':')
  $free = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
  if($free -ge 20){ OK "Free disk on ${drive}: ${free} GB" }
  else { WARN "Only ${free} GB free on ${drive}: - models + venv want ~20 GB. Free some space to be safe." }
} catch { }

$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if(-not $smi){ $p = "$env:SystemRoot\System32\nvidia-smi.exe"; if(Test-Path $p){ $smi = $p } }
if($smi){
  try {
    $g = (& $smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
    if($g){ OK "NVIDIA GPU: $($g.Trim())" } else { WARN "nvidia-smi present but returned no GPU." }
  } catch { WARN "nvidia-smi present but could not be queried." }
} else {
  WARN "No NVIDIA GPU / driver detected. The Small model runs on CPU; the Medium model and the Magenta sidecar need an NVIDIA GPU + driver 550+."
  Info "Driver download (optional): https://www.nvidia.com/Download/index.aspx"
}

# --- Tool inventory ---
$todo = New-Object System.Collections.ArrayList

function Need($present, $name, $label, $size, $required, $action){
  if($present){ OK "$label found"; return }
  $tag = 'recommended'
  if($required){ $tag = 'required' }
  WARN "$label missing ($tag)"
  [void]$todo.Add([pscustomobject]@{ Name=$name; Label=$label; Size=$size; Required=$required; Action=$action })
}

Need (Have 'uv')     'uv'     'uv (Python env manager)'  '~15 MB'  $true  'uv'
Need (Have 'node')   'node'   'Node.js LTS + npm'        '~30 MB'  $true  'OpenJS.NodeJS.LTS'
Need (Have 'ffmpeg') 'ffmpeg' 'FFmpeg (all audio I/O)'   '~80 MB'  $false 'Gyan.FFmpeg'
Need (Have 'git')    'git'    'Git'                      '~60 MB'  $false 'Git.Git'

if($wingetOk){ OK "winget available (used for Node / FFmpeg / Git)" }
else { WARN "winget not found - uv still installs via its own installer; Node/FFmpeg/Git would need App Installer or a manual download." }

if($todo.Count -eq 0){
  Head "Everything theDAW needs is already installed"
  OK "No downloads needed."
  exit 0
}

# =========================================================================== #
#  CONSENT
# =========================================================================== #
Head "Your OK before anything is downloaded or installed"
Write-Host "  theDAW would install the following:" -ForegroundColor White
foreach($t in $todo){
  $tag = 'recommended'
  if($t.Required){ $tag = 'required' }
  Write-Host ("    - {0}  ({1}, {2})" -f $t.Label, $t.Size, $tag) -ForegroundColor White
}
Write-Host ""
Info "uv comes from astral.sh; Node, FFmpeg, and Git come through winget. Nothing leaves your PC."
if(-not (Ask "Download and install the items above?")){
  WARN "No problem - nothing was changed."
  $reqMissing = ($todo | Where-Object { $_.Required } | Measure-Object).Count -gt 0
  if($reqMissing){ exit 2 } else { exit 0 }
}

# =========================================================================== #
#  PHASE 2 - install
# =========================================================================== #
Head "Installing"
$installedAny = $false
foreach($t in $todo){
  $done = $false
  if($t.Name -eq 'uv'){ $done = Install-Uv } else { $done = Install-Winget $t.Action $t.Label }
  if($done){ $installedAny = $true; OK "$($t.Label) installed." }
  else { WARN "$($t.Label) was not installed." }
}

Refresh-Path

# =========================================================================== #
#  DONE
# =========================================================================== #
if($installedAny){
  Head "Setup made changes"
  OK "Installed the items above."
  Info "Close this window and double-click theDAW.bat again so the new tools are on PATH."
  exit 10
}

$reqStillMissing = (-not (Have 'uv')) -or (-not (Have 'node'))
if($reqStillMissing){ exit 2 } else { exit 0 }
