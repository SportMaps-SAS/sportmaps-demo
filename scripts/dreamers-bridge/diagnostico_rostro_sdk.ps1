<#
  diagnostico_rostro_sdk.ps1  --  SOLO LECTURA

  Pregunta que responde: ¿el SDK oficial de ZKTeco (zkemkeeper) puede LEER el rostro y las
  huellas de un usuario del MB360? pyzk 0.9 no puede con rostros; si el SDK si, borrar y
  restaurar seria viable tambien para quien marca con rostro.

  - NO escribe nada en el lector. NO imprime ni guarda plantillas: solo muestra si se pudo
    leer y cuantos bytes tiene (longitud), mas el estado del usuario.
  - Se conecta a UN lector por unos segundos. Los equipos aceptan una sola sesion: el bridge
    puede mostrar "cediendo el equipo" y reconectar solo. Hacerlo con poco movimiento.
  - Usa el SDK COM de 32 bits, asi que debe correr con el PowerShell de 32 bits:

      C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass `
        -File .\diagnostico_rostro_sdk.ps1 -Ip 192.168.1.201 -Pin 1

  Usar de preferencia un usuario ADULTO que de su consentimiento (por defecto PIN 1, Fabio).
#>
param(
    [string]$Ip   = '192.168.1.201',
    [int]   $Port = 4370,
    [string]$Pin  = '1'
)

if ([IntPtr]::Size -ne 4) {
    Write-Host "Este script necesita el PowerShell de 32 bits (el SDK zkemkeeper es de 32 bits)." -ForegroundColor Red
    Write-Host "Ejecutalo asi:"
    Write-Host "  C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File .\diagnostico_rostro_sdk.ps1 -Ip $Ip -Pin $Pin"
    exit 1
}

# El nombre registrado de la clase varia segun la version del SDK: se prueban los ProgID
# conocidos y, por ultimo, el CLSID de CZKEM.
$zk = $null
$usado = $null
foreach ($prog in 'zkemkeeper.ZKEM.1', 'zkemkeeper.ZKEM', 'zkemkeeper.CZKEM.1', 'zkemkeeper.CZKEM') {
    try { $zk = New-Object -ComObject $prog; $usado = "ProgID $prog"; break } catch { }
}
if (-not $zk) {
    try {
        $t = [Type]::GetTypeFromCLSID([Guid]'00853A19-BD51-419B-9269-2DABE57EB61F')
        $zk = [Activator]::CreateInstance($t)
        $usado = 'CLSID 00853A19-BD51-419B-9269-2DABE57EB61F'
    } catch { }
}
if (-not $zk) {
    Write-Host "No se pudo crear el objeto del SDK con ningun nombre conocido." -ForegroundColor Red
    Write-Host "Esto es lo que quedo registrado con 'zkem' en este equipo (vista de 32 bits):"
    Get-ChildItem 'Registry::HKEY_CLASSES_ROOT' -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -match 'zkem' } | Select-Object -ExpandProperty PSChildName
    Write-Host "Pasa esa lista; con el nombre real se ajusta el script."
    exit 1
}
Write-Host "SDK cargado por $usado"

$log = Join-Path $PSScriptRoot ("prueba_rostro_sdk_{0}_{1}.log" -f $Ip.Replace('.', '-'), (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Say([string]$t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }

Say "=== Prueba de lectura por SDK -- $Ip`:$Port -- PIN $Pin -- $(Get-Date) ==="

if (-not $zk.Connect_Net($Ip, $Port)) {
    $err = 0; $null = $zk.GetLastError([ref]$err)
    Say "No se pudo conectar (codigo $err). Puede que otra sesion tenga el equipo; reintenta en un minuto."
    exit 1
}

try {
    $sn = ''; $null = $zk.GetSerialNumber(1, [ref]$sn)
    Say "Equipo conectado. Serie: $sn"

    # Version del algoritmo de rostro (informativo)
    $fv = ''
    if ($zk.GetSysOption(1, '~ZKFaceVersion', [ref]$fv)) { Say "ZKFaceVersion: $fv" } else { Say "ZKFaceVersion: no disponible" }

    # Estado del usuario (SOLO lectura)
    $name = ''; $pass = ''; $priv = 0; $enabled = $false
    if ($zk.SSR_GetUserInfo(1, $Pin, [ref]$name, [ref]$pass, [ref]$priv, [ref]$enabled)) {
        Say ("Usuario {0}: nombre='{1}' privilegio={2} habilitado={3} clave_len={4}" -f $Pin, $name, $priv, $enabled, $pass.Length)
    } else {
        Say "El PIN $Pin no existe en este lector (o no se pudo leer)."
        exit 0
    }

    # Rostro: el SDK documenta el indice 50 para la plantilla de rostro.
    foreach ($idx in 50) {
        $face = ''; $len = 0
        $ok = $zk.GetUserFaceStr(1, $Pin, $idx, [ref]$face, [ref]$len)
        if ($ok -and $len -gt 0) { Say "ROSTRO indice ${idx}: LEIDO por el SDK ($len bytes)" }
        else {
            $err = 0; $null = $zk.GetLastError([ref]$err)
            Say "ROSTRO indice ${idx}: no se pudo leer (ok=$ok, len=$len, codigo=$err)"
        }
    }

    # Huellas: indices 0..9
    $conHuella = @()
    # El nombre del metodo depende de la version del SDK: en 6.2.5.x es GetUserTmpExStr.
    foreach ($f in 0..9) {
        $flag = 0; $tmp = ''; $tlen = 0; $leido = $false
        foreach ($metodo in 'GetUserTmpExStr', 'SSR_GetUserTmpStr') {
            try {
                if ($metodo -eq 'GetUserTmpExStr') { $leido = $zk.GetUserTmpExStr(1, $Pin, $f, [ref]$flag, [ref]$tmp, [ref]$tlen) }
                else                                { $leido = $zk.SSR_GetUserTmpStr(1, $Pin, $f, [ref]$tmp, [ref]$tlen) }
                break
            } catch { $leido = $false }
        }
        if ($leido -and $tlen -gt 0) { $conHuella += ("dedo {0} ({1} bytes)" -f $f, $tlen) }
    }
    if ($conHuella.Count) { Say ("HUELLAS leidas: " + ($conHuella -join ', ')) } else { Say "HUELLAS: ninguna legible para este PIN" }

    Say "=== Fin. No se escribio nada en el lector. ==="
}
finally {
    $null = $zk.Disconnect()
}
Say "Registro guardado en: $log"
