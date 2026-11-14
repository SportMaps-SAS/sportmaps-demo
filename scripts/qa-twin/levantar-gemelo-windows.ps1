# Levanta Docker Desktop + el gemelo en Windows (build Insider 26300).
#
# En este Windows los sockets AF_UNIX que Docker deja al cerrarse quedan inaccesibles
# ("The file cannot be accessed by the system") y el siguiente arranque falla con
# "An unexpected error occurred". No se pueden borrar, pero si renombrar la carpeta:
# Docker crea una nueva. NUNCA usar "Reset to factory defaults": borra los volumenes,
# incluida la base del gemelo.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa-twin\levantar-gemelo-windows.ps1
$ErrorActionPreference = 'Stop'
$env:Path = "$env:LOCALAPPDATA\supabase-cli;$env:LOCALAPPDATA\ffmpeg\bin;$env:Path"
$stamp = Get-Date -Format 'yyyyMMddHHmmss'

cmd /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host '== Docker apagado: apartando sockets viejos y arrancandolo'
    Get-Process | Where-Object { $_.ProcessName -match '^(Docker Desktop|com\.docker\.backend|docker-ai)$' } | Stop-Process -Force -Confirm:$false
    Start-Sleep 3
    foreach ($d in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
        if (Test-Path $d) { Rename-Item $d ("{0}.viejo-{1}" -f (Split-Path $d -Leaf), $stamp) }
    }
    Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) { Start-Sleep 3; cmd /c "docker info >nul 2>&1"; if ($LASTEXITCODE -eq 0) { $ok = $true; break } }
    if (-not $ok) { throw 'Docker no arranco en 3 minutos' }
}
Write-Host '== Docker listo'

Set-Location (Join-Path $PSScriptRoot '..\..')
npm run qa:twin:up
if ($LASTEXITCODE -ne 0) { throw 'qa:twin:up fallo' }
Write-Host 'GEMELO LISTO'
