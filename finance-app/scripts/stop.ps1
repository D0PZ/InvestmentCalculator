# Detiene el predict service (Python uvicorn :8001) y la app Node (:3000) si están corriendo.
# Cuidado: mata procesos por puerto. Si tenés OTRA app en esos puertos, no la corras.

$ErrorActionPreference = "SilentlyContinue"

function Stop-Port([int]$port, [string]$label) {
    $pids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    if (-not $pids) {
        Write-Host "  - puerto $port ($label) ya estaba libre" -ForegroundColor Gray
        return
    }
    foreach ($processId in $pids) {
        try {
            $proc = Get-Process -Id $processId -ErrorAction Stop
            Write-Host "  - matando PID $processId ($($proc.ProcessName)) en :$port ($label)" -ForegroundColor Yellow
            Stop-Process -Id $processId -Force -ErrorAction Stop
        } catch {
            Write-Host "  - no pude matar PID $processId : $_" -ForegroundColor Red
        }
    }
}

Write-Host "Deteniendo servicios..." -ForegroundColor Cyan
Stop-Port 8001 "predict service"
Stop-Port 3000 "node app"
Write-Host "Listo." -ForegroundColor Green
