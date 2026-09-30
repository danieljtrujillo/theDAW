<#
  theDAW - Setup & Doctor

  theDAW.bat calls this automatically the first time a tool is missing. It can
  also be run directly: powershell -ExecutionPolicy Bypass -File install\setup.ps1

  It checks your system first (read-only), shows EXACTLY what needs to be
  installed and how big it is, asks once, then installs the missing pieces
  from official sources. No terminal commands are required from you.

  Exit codes (consumed by theDAW.bat):
    0   nothing to install, or everything REQUIRED is already present
    2   a required tool (uv / Node) is still missing (declined or failed)
    10  installed something - re-run theDAW.bat so PATH refreshes

  Switches:
    -Yes            assume "yes" to the prompts (non-interactive)
    -UnderfitVenv   only run the Underfit trainer-tab venv bootstrap, then exit
                    (theDAW.bat calls this after the main venv is built)
    -VstHost        only run the native live-VST host build offer, then exit
                    (theDAW.bat calls this when scripts/check_vst_host.py
                    reports the host exe missing and CMake is on PATH)
    -FFmpegCheck    only look for an FFmpeg with libsoxr, print nothing, and
                    exit 0 when one is found, 1 when none is (theDAW.bat calls
                    this when the first ffmpeg on PATH has no libsoxr)
#>
[CmdletBinding()]
param([switch]$Yes, [switch]$UnderfitVenv, [switch]$VstHost, [switch]$FFmpegCheck)
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

# Ask() reads an empty line as yes, which is right for a prompt a person is
# looking at. On a redirected or closed stdin Read-Host hands back that empty
# line straight away, so an OPTIONAL multi-minute build would start itself in
# CI or a piped launch. Callers that must not do that test the console first
# and treat 'no console' as a decline. -Yes still wins: it is a real answer.
function Interactive(){ try { return (-not [Console]::IsInputRedirected) } catch { return $false } }

function Have($name){ return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Re-read PATH from the registry so freshly installed tools are visible to
# checks later in THIS process (the parent cmd still needs a re-run).
function Update-Path(){
  $m = [Environment]::GetEnvironmentVariable('Path','Machine')
  $u = [Environment]::GetEnvironmentVariable('Path','User')
  $parts = @()
  if($m){ $parts += $m }
  if($u){ $parts += $u }
  $env:Path = ($parts -join ';')
}

# The Underfit LoRA-trainer tab runs its own uv-managed Python env
# (underfit/.venv). It's a large, opt-in feature, so this is consent-gated and
# never blocks theDAW — declining just leaves the tab's dashboard unavailable
# until you set it up. Creating the env is `uv sync --inexact` (the exact step
# from underfit/install.sh); the trainer backend + model packs are a separate,
# heavier step the tab installs on demand.
function Initialize-UnderfitVenv(){
  Update-Path
  $root  = Split-Path -Parent $PSScriptRoot
  $ufDir = Join-Path $root 'underfit'
  if(-not (Test-Path (Join-Path $ufDir 'pyproject.toml'))){ return }   # not vendored
  if(Test-Path (Join-Path $ufDir '.venv\Scripts\python.exe')){ OK 'Underfit trainer env present'; return }
  Head 'Underfit trainer tab (optional)'
  if(-not (Have 'uv')){ WARN 'uv is required to create the Underfit env - install uv first, then re-launch.'; return }
  Info "The Underfit LoRA-trainer tab needs a one-time Python env (underfit\.venv)."
  Info "This runs 'uv sync' in underfit\ (~a few minutes). Model packs download later, on demand."
  if(-not (Ask 'Create the Underfit trainer env now?')){ WARN 'Skipped - the Underfit tab stays unavailable until you set it up.'; return }
  Info 'Creating underfit\.venv via: uv sync --inexact'
  # Keep uv's cache on the repo's drive so wheels hardlink into underfit\.venv
  # instead of falling back to slow full copies across volumes (uv can't
  # hardlink across drives; its default cache is on the system drive). Honors an
  # inherited UV_CACHE_DIR (e.g. from theDAW.bat) and only sets a default here.
  if(-not $env:UV_CACHE_DIR){ $env:UV_CACHE_DIR = Join-Path $root '.uv-cache' }
  Push-Location $ufDir
  try {
    & uv sync --inexact
    if($LASTEXITCODE -eq 0){ OK 'Underfit trainer env created.' }
    else { WARN "uv sync exited $LASTEXITCODE - the Underfit tab stays unavailable for now." }
  } finally { Pop-Location }
}

# Remembering a 'no'. theDAW.bat skips its build offer while this file
# exists, so declining once is not re-asked on every launch; deleting it, or
# running setup.ps1 -VstHost by hand, brings the offer back, and a successful
# build clears it. ONLY an interactive decline writes it - the no-console
# auto-decline below must leave nothing behind, or one redirected launch (CI,
# a piped run) would silence the offer on a real console afterwards. Both the
# write and the delete are best-effort: on a read-only or locked checkout the
# next launch simply asks again, which is not worth a line of output.
function Set-VstHostDeclined($hostDir, $declined){
  $marker = Join-Path $hostDir '.build-declined'
  try {
    if($declined){
      $stamp = (Get-Date).ToString('s')
      Set-Content -Path $marker -Encoding Ascii -Value "$stamp  delete this file to be asked again"
    } else {
      Remove-Item -Force -ErrorAction SilentlyContinue $marker
    }
  } catch { }
}

# The native live-VST host (native/vst-host) is what lets real VST3 plugins
# process the live signal during playback. It is C++17 against Win32, built
# locally with CMake + the Visual Studio Build Tools, and never committed
# (native/vst-host/bin/ is gitignored), so a fresh clone has no exe. theDAW.bat
# offers this when scripts/check_vst_host.py reports the exe missing. Like the
# Underfit env above it is consent-gated and never blocks theDAW - declining
# leaves live VST hosting unavailable for the session and plugins still work
# offline. build.ps1 throws on a failed configure or build, so the call is
# wrapped: a broken toolchain must not take setup.ps1 down with it.
function Initialize-VstHost(){
  Update-Path
  $root    = Split-Path -Parent $PSScriptRoot
  $hostDir = Join-Path $root 'native\vst-host'
  $builder = Join-Path $hostDir 'build.ps1'
  if(-not (Test-Path $builder)){ return }   # not vendored
  if(Test-Path (Join-Path $hostDir 'bin\thedaw-vst-host.exe')){ OK 'Live VST host present'; return }
  Head 'Live VST host (optional)'
  if(-not (Have 'cmake')){ WARN 'CMake is required to build the live VST host - install CMake, then re-launch.'; return }
  Info 'Real VST3 plugins only process the live signal when this native host is built.'
  Info 'This runs native\vst-host\build.ps1 (needs the Visual Studio Build Tools; a few minutes).'
  if(-not (Interactive) -and -not $Yes){ WARN 'Skipped - no console to ask at; live VST hosting stays unavailable and plugins still work offline.'; return }
  if(-not (Ask 'Build the live VST host now?')){
    Set-VstHostDeclined $hostDir $true
    WARN 'Skipped, and not asked again at launch: delete native\vst-host\.build-declined or run install\setup.ps1 -VstHost to be offered it again, or set THEDAW_SKIP_VST_HOST_BUILD=1 to suppress the offer outright. Plugins still work offline.'
    return
  }
  Info 'Building via: native\vst-host\build.ps1'
  try {
    & $builder
    if($LASTEXITCODE -eq 0){ Set-VstHostDeclined $hostDir $false; OK 'Live VST host built.' }
    else { WARN "build.ps1 exited $LASTEXITCODE - live VST hosting stays unavailable; plugins still work offline." }
  } catch {
    WARN ('Live VST host build failed: ' + $_.Exception.Message)
  }
}

$wingetOk = Have 'winget'

function Install-Uv(){
  Info "Installing uv (Astral standalone installer, user scope)..."
  try {
    & powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    # A failed child powershell (download blocked, TLS error) does NOT throw
    # here — it just exits non-zero. Without this check the function reported
    # success, theDAW.bat told the user to re-run, and the loop never ended.
    if ($LASTEXITCODE -ne 0) {
      BAD ("uv install failed (exit code " + $LASTEXITCODE + ")")
      return $false
    }
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

function Install-AppInstaller(){
  # Best-effort install of the Windows App Installer (which provides winget)
  # when it is absent, so Node / FFmpeg / Git can be fetched. Downloads the
  # VCLibs dependency and the App Installer bundle, then registers them.
  Info "Installing the Windows App Installer (winget)..."
  try {
    $tmp = Join-Path $env:TEMP 'thedaw-winget'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $vc = Join-Path $tmp 'VCLibs.Desktop.appx'
    Invoke-WebRequest 'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' -OutFile $vc -UseBasicParsing
    Add-AppxPackage -Path $vc -ErrorAction SilentlyContinue
    $bundle = Join-Path $tmp 'AppInstaller.msixbundle'
    Invoke-WebRequest 'https://aka.ms/getwinget' -OutFile $bundle -UseBasicParsing
    Add-AppxPackage -Path $bundle
    Update-Path
    return [bool](Get-Command winget -ErrorAction SilentlyContinue)
  } catch {
    WARN ('Could not install winget automatically: ' + $_.Exception.Message)
    return $false
  }
}

# FFmpeg: theDAW needs a build with libsoxr. Classical Upsample, Super-Res and
# High-Quality SRC resample through it, and gyan.dev's "essentials" build, which
# other apps ship and put on PATH, has none. The backend
# (backend/lib/ffmpeg_tools.py) probes these same places in this same order and
# runs the first build that passes, so a full build anywhere here is enough.
function Get-FFmpegCandidates(){
  $list = New-Object System.Collections.ArrayList
  if($env:THEDAW_FFMPEG){
    $p = $env:THEDAW_FFMPEG.Trim().Trim('"')
    if(Test-Path -LiteralPath $p -PathType Container){ $p = Join-Path $p 'ffmpeg.exe' }
    [void]$list.Add($p)
  }
  foreach($c in @(Get-Command ffmpeg -All -CommandType Application -ErrorAction SilentlyContinue)){
    [void]$list.Add($c.Path)
  }
  $bases = @()
  if($env:LOCALAPPDATA){ $bases += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet') }
  if($env:ProgramFiles){ $bases += (Join-Path $env:ProgramFiles 'WinGet') }
  foreach($base in $bases){
    [void]$list.Add((Join-Path $base 'Links\ffmpeg.exe'))
    $packages = Join-Path $base 'Packages'
    if(Test-Path -LiteralPath $packages){
      foreach($pkg in @(Get-ChildItem -LiteralPath $packages -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue)){
        foreach($ver in @(Get-ChildItem -LiteralPath $pkg.FullName -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)){
          [void]$list.Add((Join-Path $ver.FullName 'bin\ffmpeg.exe'))
        }
      }
    }
  }
  if($env:USERPROFILE){ [void]$list.Add((Join-Path $env:USERPROFILE 'scoop\shims\ffmpeg.exe')) }
  if($env:ProgramData){ [void]$list.Add((Join-Path $env:ProgramData 'chocolatey\bin\ffmpeg.exe')) }
  $seen = @{}
  $out = New-Object System.Collections.ArrayList
  foreach($p in $list){
    if(-not $p){ continue }
    if(-not (Test-Path -LiteralPath $p -PathType Leaf)){ continue }
    $k = $p.ToLowerInvariant()
    if($seen.ContainsKey($k)){ continue }
    $seen[$k] = $true
    [void]$out.Add($p)
  }
  return ,$out
}

# A 50 ms sine resampled through soxr into the null muxer: exit 0 only when the
# build has libsoxr. Run through Process directly so ffmpeg's stderr never
# becomes a PowerShell error record under $ErrorActionPreference = 'Stop'.
function Test-FFmpegSoxr($exe){
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = '-hide_banner -nostdin -loglevel error -f lavfi -i sine=d=0.05 -af aresample=48000:resampler=soxr -f null -'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $errTask = $proc.StandardError.ReadToEndAsync()
    $null = $proc.StandardOutput.ReadToEnd()
    if(-not $proc.WaitForExit(20000)){
      try { $proc.Kill() } catch { }
      return $false
    }
    $null = $errTask.Result
    return ($proc.ExitCode -eq 0)
  } catch {
    return $false
  }
}

# State = 'ok' (a build with libsoxr, at Path), 'nosoxr' (FFmpeg present, none
# with libsoxr; Path is the one theDAW would run) or 'missing'.
function Get-FFmpegState(){
  $candidates = Get-FFmpegCandidates
  if($candidates.Count -eq 0){ return [pscustomobject]@{ State='missing'; Path=$null } }
  foreach($c in $candidates){
    if(Test-FFmpegSoxr $c){ return [pscustomobject]@{ State='ok'; Path=$c } }
  }
  return [pscustomobject]@{ State='nosoxr'; Path=$candidates[0] }
}

# Dedicated mode: theDAW.bat calls `setup.ps1 -FFmpegCheck` when the first
# ffmpeg on PATH fails the soxr probe, to learn whether a full build is
# installed somewhere else the backend looks. Silent; the exit code is the answer.
if($FFmpegCheck){
  if((Get-FFmpegState).State -eq 'ok'){ exit 0 } else { exit 1 }
}

# Dedicated mode: theDAW.bat calls `setup.ps1 -UnderfitVenv` after the main venv
# bootstrap to create the optional Underfit trainer env if it's missing.
if($UnderfitVenv){ Initialize-UnderfitVenv; exit 0 }

# Dedicated mode: theDAW.bat calls `setup.ps1 -VstHost` when the launch-time
# check finds no host exe. It always exits 0 - the launch continues either way.
if($VstHost){ Initialize-VstHost; exit 0 }

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
# FFmpeg counts as present only when a build with libsoxr is found. One without
# it is offered the full build (winget Gyan.FFmpeg) through the same consent.
$ffmpeg = Get-FFmpegState
if($ffmpeg.State -eq 'ok'){
  OK "FFmpeg with libsoxr found ($($ffmpeg.Path))"
} elseif($ffmpeg.State -eq 'nosoxr'){
  WARN "FFmpeg at $($ffmpeg.Path) has no libsoxr (recommended: the full build)"
  Info "Classical Upsample, Super-Res and High-Quality SRC resample with libsoxr and fail on this build."
  [void]$todo.Add([pscustomobject]@{ Name='ffmpeg'; Label='FFmpeg full build (libsoxr resampler)'; Size='~80 MB'; Required=$false; Action='Gyan.FFmpeg' })
} else {
  Need $false 'ffmpeg' 'FFmpeg full build (all audio I/O)' '~80 MB' $false 'Gyan.FFmpeg'
}
Need (Have 'git')    'git'    'Git'                      '~60 MB'  $false 'Git.Git'

# MuseScore engraves SVG score exports. PDF does NOT need it (that renders
# headlessly through the frontend's OpenSheetMusicDisplay), so this stays
# optional: without it the SCORE tab simply offers one format fewer.
# Detected by binary name AND by the default install path, because the
# installer does not always put MuseScore4.exe on PATH.
$museScore = (Have 'MuseScore4') -or (Have 'mscore') -or
             (Test-Path 'C:\Program Files\MuseScore 4\bin\MuseScore4.exe')
Need $museScore 'musescore' 'MuseScore 4 (SVG score export)' '~500 MB' $false 'Musescore.Musescore'

if($wingetOk){ OK "winget available (used for Node / FFmpeg / Git / MuseScore)" }
else { WARN "winget not found - uv still installs via its own installer; Node/FFmpeg/Git/MuseScore would need App Installer or a manual download." }

if($todo.Count -eq 0){
  Head "Everything theDAW needs is already installed"
  OK "No downloads needed."
  Initialize-UnderfitVenv
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
Info "uv comes from astral.sh; Node, FFmpeg, and Git come through winget (installed first if absent). Nothing leaves your PC."
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

# Node / FFmpeg / Git come through winget. If winget is missing, install it first.
$needsWinget = ($todo | Where-Object { $_.Name -ne 'uv' } | Measure-Object).Count -gt 0
if($needsWinget -and -not $wingetOk){
  if(Install-AppInstaller){ $wingetOk = $true; OK 'winget installed.' }
  else { WARN 'winget could not be installed; Node/FFmpeg/Git will need a manual download.' }
}

foreach($t in $todo){
  $done = $false
  if($t.Name -eq 'uv'){ $done = Install-Uv } else { $done = Install-Winget $t.Action $t.Label }
  if($done){ $installedAny = $true; OK "$($t.Label) installed." }
  else { WARN "$($t.Label) was not installed." }
}

Update-Path

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
