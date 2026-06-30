# One-shot setup + run for the memory-chat app (Windows, PowerShell 5+).
#   .\run.ps1            install deps if needed, then run backend + frontend
#   .\run.ps1 -Setup     install deps only, don't start servers
# Ctrl-C stops both servers.
#
# Never modifies your system: no global installs. Uses `uv` if you already have
# it, otherwise builds a project-local venv at backend\.venv with your own
# Python. Nothing is installed outside this repo.
#
# If blocked by execution policy, launch with:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1
[CmdletBinding()]
param([switch]$Setup)

$ErrorActionPreference = 'Stop'
$Root         = $PSScriptRoot
$Backend      = Join-Path $Root 'backend'
$Frontend     = Join-Path $Root 'frontend'
$BackendPort  = 8000
$FrontendPort = 5173
$Venv         = Join-Path $Backend '.venv'
$Vpy          = Join-Path $Venv 'Scripts\python.exe'

# mirrors backend/pyproject.toml [project].dependencies (pip fallback only)
$PyDeps = @(
    'fastapi>=0.138','uvicorn[standard]>=0.49','groq>=1.5','fastembed>=0.8',
    'sqlite-vec>=0.1.9','numpy>=2.1','python-dotenv>=1.2'
)

function Bold($m) { Write-Host $m -ForegroundColor White }
function Info($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "x $m" -ForegroundColor Red; exit 1 }

$script:UseUv = $false
$script:SysPy = ''

# -- backend toolchain detection (no installs) -------------------------------
function Find-Python {
    # py launcher first (lets us request an exact version), then bare exes.
    $cands = @(
        @{ exe='py';        args=@('-3.13') },
        @{ exe='py';        args=@('-3.12') },
        @{ exe='python3.13';args=@()        },
        @{ exe='python3.12';args=@()        },
        @{ exe='python';    args=@()        }
    )
    foreach ($c in $cands) {
        if (-not (Get-Command $c.exe -ErrorAction SilentlyContinue)) { continue }
        $code = 'import sys; raise SystemExit(0 if (3,12)<=sys.version_info[:2]<(3,14) else 1)'
        & $c.exe @($c.args + @('-c', $code)) 2>$null
        if ($LASTEXITCODE -eq 0) { return ($c.exe + ' ' + ($c.args -join ' ')).Trim() }
    }
    return ''
}

function Detect-Backend {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        $script:UseUv = $true; Info "Using uv for the backend"; return
    }
    Warn "uv not found - falling back to a project-local venv (no system changes)"
    $script:SysPy = Find-Python
    if (-not $script:SysPy) {
        Die "No suitable Python found. Need 3.12 or 3.13 (fastembed/onnxruntime lack 3.14 wheels). Install one, or install uv (https://docs.astral.sh/uv/), then re-run. Nothing was changed on your system."
    }
    Info "Using Python: $($script:SysPy)"
}

function Ensure-Node {
    if (Get-Command npm -ErrorAction SilentlyContinue) { return }
    Die "Node.js / npm not found. Install Node 18+ from https://nodejs.org, then re-run."
}

# run the picked system python (may be "py -3.13") with given args
function Invoke-SysPy {
    $parts = $script:SysPy -split ' '
    & $parts[0] @($parts[1..($parts.Count-1)] + $args)
}

# -- groq key ----------------------------------------------------------------
function Test-HasKey {
    $f = Join-Path $Backend '.env'
    if (-not (Test-Path $f)) { return $false }
    return [bool](Select-String -Path $f -Pattern '^\s*GROQ_API_KEY=\s*[^\s\.].*' -Quiet)
}

$script:GroqKey = ''
function Resolve-Key {
    if (Test-HasKey) { Info "Groq key found in backend/.env"; return }
    Warn "No Groq key in backend/.env (get one at https://console.groq.com/keys)"
    $secure = Read-Host "Paste GROQ_API_KEY" -AsSecureString
    $bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $script:GroqKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($script:GroqKey)) { Die "No key entered. Aborting." }
    Info "Key injected into the backend process for this run only (not written to disk)."
}

# -- install (project-local only) --------------------------------------------
function Invoke-Setup {
    if ($script:UseUv) {
        Bold "Setting up backend (uv sync)..."
        Push-Location $Backend; try { uv sync } finally { Pop-Location }
    } else {
        if (-not (Test-Path $Vpy)) {
            Bold "Creating backend venv at backend\.venv..."
            Invoke-SysPy '-m' 'venv' $Venv
        }
        Bold "Setting up backend (pip install into backend\.venv)..."
        & $Vpy -m pip install --upgrade pip | Out-Null
        & $Vpy -m pip install @PyDeps
    }
    Bold "Setting up frontend (npm install)..."
    Push-Location $Frontend; try { npm install } finally { Pop-Location }
}

# -- run ---------------------------------------------------------------------
$script:Procs = @()
function Stop-All {
    Info "Stopping servers..."
    foreach ($p in $script:Procs) {
        if ($p -and -not $p.HasExited) { taskkill /PID $p.Id /T /F *> $null }
    }
    Info "Stopped."
}

function Invoke-Run {
    Bold "Starting backend  -> http://localhost:$BackendPort"
    $env_backup = $env:GROQ_API_KEY
    if ($script:GroqKey) { $env:GROQ_API_KEY = $script:GroqKey }  # inject for child inheritance
    if ($script:UseUv) {
        $beFile = 'uv'
        $beArgs = @('run','uvicorn','app.main:app','--port',"$BackendPort")
    } else {
        $beFile = $Vpy
        $beArgs = @('-m','uvicorn','app.main:app','--port',"$BackendPort")
    }
    $script:Procs += Start-Process -PassThru -NoNewWindow -WorkingDirectory $Backend `
        -FilePath $beFile -ArgumentList $beArgs
    $env:GROQ_API_KEY = $env_backup  # don't leak the key into this shell beyond the spawn

    Bold "Starting frontend -> http://localhost:$FrontendPort"
    $npm = (Get-Command npm).Source  # npm is a .cmd shim; resolve full path for Start-Process
    $script:Procs += Start-Process -PassThru -NoNewWindow -WorkingDirectory $Frontend `
        -FilePath $npm -ArgumentList @('run','dev','--','--port',"$FrontendPort")

    Write-Host ''
    Bold  "Both running. Open http://localhost:$FrontendPort"
    Warn  "First chat downloads the embedding model (~0.21 GB) once - initial reply is slow."
    Info  "Press Ctrl-C to stop both."

    try {
        while ($true) {
            Start-Sleep -Milliseconds 500
            foreach ($p in $script:Procs) { if ($p.HasExited) { return } }
        }
    } finally { Stop-All }
}

# -- main --------------------------------------------------------------------
Detect-Backend
Ensure-Node
Invoke-Setup
if ($Setup) { Bold "Setup complete. Run .\run.ps1 to start the servers."; exit 0 }
Resolve-Key
Invoke-Run
