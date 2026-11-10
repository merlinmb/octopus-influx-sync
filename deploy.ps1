# deploy.ps1 - Build and deploy octopus-influx-sync to the Pi via SSH
#
# Usage (from the project folder in PowerShell):
#   .\deploy.ps1
#
# Prerequisites:
#   - OpenSSH installed and ssh-keygen run (built into Windows 10/11)
#   - SSH key-based auth set up for pi@homebridge.local
#       ssh-copy-id pi@homebridge.local   (from Git Bash or WSL)
#       -- OR --
#       type $env:USERPROFILE\.ssh\id_rsa.pub | ssh pi@homebridge.local "cat >> ~/.ssh/authorized_keys"
#   - Docker installed on the Pi
#   - .env file created at ~/octopus-influx-sync/.env on the Pi
#       (copy .env.example over and fill in your real values)

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Remote   = 'pi@homebridge.local'
$RemoteDir = '~/octopus-influx-sync'

# Files to deploy (explicit list — includes .env, excludes node_modules and .git)
$FilesToCopy = @(
    'index.js'
    'monthly-costs.html'
    'package.json'
    'Dockerfile'
    'docker-compose.yml'
    '.env'
    '.env.example'
    '.gitignore'
    'deploy.sh'
    'deploy.ps1'
)

function Write-Step($msg) {
    Write-Host "-> $msg" -ForegroundColor Cyan
}

function Write-Success($msg) {
    Write-Host $msg -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host $msg -ForegroundColor Yellow
}

function Invoke-SSH($cmd) {
    # Run a remote command and surface a clean error if it fails
    ssh $Remote $cmd
    if ($LASTEXITCODE -ne 0) {
        throw "SSH command failed (exit $LASTEXITCODE): $cmd"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor DarkCyan
Write-Host "  Deploying octopus-influx-sync -> Pi  " -ForegroundColor DarkCyan
Write-Host "========================================" -ForegroundColor DarkCyan
Write-Host ""

# ── 1. Verify ssh is available ────────────────────────────────────────────────
Write-Step "Checking SSH availability..."
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "ERROR: 'ssh' not found. Enable OpenSSH in Windows Settings:" -ForegroundColor Red
    Write-Host "  Settings -> Apps -> Optional Features -> OpenSSH Client" -ForegroundColor Red
    exit 1
}
Write-Host "  OK" -ForegroundColor Green

# ── 2. Ensure remote directory exists ────────────────────────────────────────
Write-Step "Preparing remote directory..."
Invoke-SSH "mkdir -p $RemoteDir"

# ── 3. Copy source files to the Pi ───────────────────────────────────────────
# scp is used (built into Windows 10+). node_modules and .env are never copied.
Write-Step "Copying files to Pi..."

$projectRoot = $PSScriptRoot
$localEnvPath = Join-Path $projectRoot '.env'
if (-not (Test-Path $localEnvPath)) {
    throw "Local .env file not found at $localEnvPath"
}

foreach ($file in $FilesToCopy) {
    $localPath = Join-Path $projectRoot $file
    if (Test-Path $localPath) {
        Write-Host "  $file" -ForegroundColor Gray
        scp -q "$localPath" "${Remote}:${RemoteDir}/${file}"
        if ($LASTEXITCODE -ne 0) {
            throw "scp failed for $file"
        }
    } else {
        Write-Host "  (skipping $file - not found locally)" -ForegroundColor DarkGray
    }
}

Write-Host "  Done." -ForegroundColor Green
Invoke-SSH "chmod 600 $RemoteDir/.env"

# ── 4. Check .env exists on Pi ───────────────────────────────────────────────
Write-Step "Checking .env on Pi..."
$envCheck = ssh $Remote "test -f $RemoteDir/.env && echo exists || echo missing"

if ($envCheck -ne 'exists') {
    Write-Host ""
    Write-Warn "WARNING: No .env file found at $RemoteDir/.env on the Pi."
    Write-Warn "Create it before the container will start:"
    Write-Host ""
    Write-Host "  ssh $Remote" -ForegroundColor White
    Write-Host "  cp $RemoteDir/.env.example $RemoteDir/.env" -ForegroundColor White
    Write-Host "  nano $RemoteDir/.env" -ForegroundColor White
    Write-Host ""
    exit 1
}
Write-Host "  .env found." -ForegroundColor Green

# ── 5. Build and restart the container on the Pi ─────────────────────────────
Write-Step "Building and restarting container on Pi..."
Invoke-SSH @"
set -e
cd $RemoteDir
docker compose down --remove-orphans 2>/dev/null || true
docker compose build --no-cache
docker compose up -d
echo ''
echo 'Container status:'
docker compose ps
echo ''
echo 'Last 30 log lines:'
docker compose logs --tail=30
"@

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Success "Deployment complete!"
Write-Host ""
Write-Host "To follow live logs, run:" -ForegroundColor DarkGray
Write-Host "  ssh ${Remote} 'docker compose -f ${RemoteDir}/docker-compose.yml logs -f'" -ForegroundColor White
Write-Host ""
