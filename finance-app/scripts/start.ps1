# Arranca el sistema completo: predict service Python + app Node, cada uno en su propia ventana.
# Uso: doble-click o `powershell -File scripts/start.ps1` (o `.\scripts\start.ps1` desde una terminal)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$AgentDir = Join-Path $Root "agent"
$VenvPy = Join-Path $AgentDir ".venv\Scripts\python.exe"

# --- Pre-flight checks ---
Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Finance App — startup"                            -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $VenvPy)) {
    Write-Host "ERROR: no existe el venv de Python en:" -ForegroundColor Red
    Write-Host "       $VenvPy"                          -ForegroundColor Red
    Write-Host ""
    Write-Host "Crealo con:" -ForegroundColor Yellow
    Write-Host "  cd `"$AgentDir`""
    Write-Host "  python -m venv .venv"
    Write-Host "  .\.venv\Scripts\activate"
    Write-Host "  pip install -r requirements.txt"
    Read-Host "Press Enter to exit"
    exit 1
}

$ModelPath = Join-Path $AgentDir "models\standalone_lgbm.joblib"
if (-not (Test-Path $ModelPath)) {
    Write-Host "AVISO: no se encontró el modelo entrenado:" -ForegroundColor Yellow
    Write-Host "       $ModelPath"                          -ForegroundColor Yellow
    Write-Host ""
    Write-Host "El predict service va a fallar al cargar. Para entrenar primero:" -ForegroundColor Yellow
    Write-Host "  cd `"$AgentDir`""
    Write-Host "  .\.venv\Scripts\activate"
    Write-Host "  `$env:PYTHONIOENCODING='utf-8'"
    Write-Host "  python train_v2.py train --label-mode fixed --fixed-target 2.0 --fixed-stop 0.5 --horizon 60 --no-cv"
    Write-Host "  python train_per_ticker.py --label-mode fixed --fixed-target 2.0 --fixed-stop 0.5 --horizon 60"
    Write-Host "  python update_thresholds.py"
    Write-Host ""
    $cont = Read-Host "¿Continuar igual? (s/n)"
    if ($cont -ne "s") { exit 1 }
}

# --- Launch Terminal 1: predict service ---
Write-Host "[1/2] Lanzando predict service (Python uvicorn) en ventana nueva..." -ForegroundColor Green
$predictCmd = @"
`$Host.UI.RawUI.WindowTitle = 'Predict Service (Python :8001)'
Set-Location '$AgentDir'
`$env:PYTHONIOENCODING = 'utf-8'
Write-Host '======================================' -ForegroundColor Cyan
Write-Host '  PREDICT SERVICE — port 8001'           -ForegroundColor Cyan
Write-Host '  Ctrl+C para detener'                   -ForegroundColor Yellow
Write-Host '======================================' -ForegroundColor Cyan
& '$VenvPy' -m uvicorn predict_service:app --host 127.0.0.1 --port 8001
Write-Host ''
Write-Host 'Predict service detenido. Presioná Enter para cerrar.' -ForegroundColor Yellow
Read-Host
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $predictCmd | Out-Null

Start-Sleep -Seconds 2

# --- Launch Terminal 2: Node app ---
Write-Host "[2/2] Lanzando app Node en ventana nueva..." -ForegroundColor Green
$nodeCmd = @"
`$Host.UI.RawUI.WindowTitle = 'Finance App (Node :3000)'
Set-Location '$Root'
Write-Host '======================================' -ForegroundColor Cyan
Write-Host '  FINANCE APP — port 3000'               -ForegroundColor Cyan
Write-Host '  Ctrl+C para detener'                   -ForegroundColor Yellow
Write-Host '======================================' -ForegroundColor Cyan
node server.js
Write-Host ''
Write-Host 'Node detenido. Presioná Enter para cerrar.' -ForegroundColor Yellow
Read-Host
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $nodeCmd | Out-Null

# --- Wait + open browser ---
Write-Host ""
Write-Host "Esperando 5s para que arranquen los servicios..." -ForegroundColor Gray
Start-Sleep -Seconds 5

# Quick health check
$predictOk = $false
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8001/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
        $predictOk = $true
        Write-Host "  ✓ predict service responde en :8001" -ForegroundColor Green
    }
} catch {
    Write-Host "  ⚠ predict service aún no responde (sigue arrancando, no es problema)" -ForegroundColor Yellow
}

$nodeOk = $false
try {
    $null = Invoke-WebRequest -Uri "http://localhost:3000/login" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    $nodeOk = $true
    Write-Host "  ✓ Node app responde en :3000" -ForegroundColor Green
} catch {
    Write-Host "  ⚠ Node app aún no responde (esperá unos segundos más)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Listo. Abrir en el navegador:" -ForegroundColor Cyan
Write-Host "    → http://localhost:3000/live" -ForegroundColor White
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Para apagar: Ctrl+C en cada ventana, o cerrá las ventanas." -ForegroundColor Gray
Write-Host ""

# Auto-open browser
$openBrowser = Read-Host "Abrir el browser ahora? (s/n)"
if ($openBrowser -eq "s") {
    Start-Process "http://localhost:3000/live"
}
