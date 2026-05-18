@echo off
REM Arranca predict service (Python :8001) + Finance App (Node :3000) en dos ventanas.
REM Doble-click este archivo para iniciar todo.

setlocal
set ROOT=%~dp0..
set AGENT=%ROOT%\agent
set VENV_PY=%AGENT%\.venv\Scripts\python.exe

echo.
echo ==================================================
echo   Finance App - startup
echo ==================================================
echo.

if not exist "%VENV_PY%" (
    echo ERROR: no existe el venv de Python en:
    echo        %VENV_PY%
    echo.
    echo Crealo con:
    echo   cd "%AGENT%"
    echo   python -m venv .venv
    echo   .venv\Scripts\activate
    echo   pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

if not exist "%AGENT%\models\standalone_lgbm.joblib" (
    echo AVISO: no se encontro el modelo entrenado:
    echo        %AGENT%\models\standalone_lgbm.joblib
    echo.
    echo Entrenar primero con:
    echo   cd "%AGENT%"
    echo   .venv\Scripts\activate
    echo   python train_v2.py train --label-mode fixed --fixed-target 2.0 --fixed-stop 0.5 --horizon 60 --no-cv
    echo   python train_per_ticker.py --label-mode fixed --fixed-target 2.0 --fixed-stop 0.5 --horizon 60
    echo   python update_thresholds.py
    echo.
    choice /M "Continuar igual"
    if errorlevel 2 exit /b 1
)

echo [1/2] Lanzando predict service (Python uvicorn :8001) en ventana nueva...
start "Predict Service (Python :8001)" cmd /k "cd /d "%AGENT%" && set PYTHONIOENCODING=utf-8 && "%VENV_PY%" -m uvicorn predict_service:app --host 127.0.0.1 --port 8001"

REM Pequena pausa para que el predict service arranque antes que Node
timeout /t 2 /nobreak >nul

echo [2/2] Lanzando Finance App (Node :3000) en ventana nueva...
start "Finance App (Node :3000)" cmd /k "cd /d "%ROOT%" && node server.js"

echo.
echo Esperando 5s para health-check...
timeout /t 5 /nobreak >nul

echo.
echo ==================================================
echo   Listo. Abrir en el navegador:
echo     http://localhost:3000/live
echo ==================================================
echo.
echo Para apagar: cerra las dos ventanas, o corre stop.bat
echo.

choice /M "Abrir el browser ahora"
if errorlevel 2 goto :end
start "" "http://localhost:3000/live"

:end
endlocal
