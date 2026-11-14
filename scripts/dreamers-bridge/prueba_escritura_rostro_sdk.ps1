<#
  prueba_escritura_rostro_sdk.ps1

  Pregunta que responde: ¿se puede ESCRIBIR de vuelta en el MB360 un rostro y una huella leidos
  con el SDK (zkemkeeper), y el lector los conserva idénticos? Es la mitad que falta para saber
  si "borrar y restaurar" sirve tambien para quien marca con rostro.

  SEGURIDAD
  - Nunca toca a un usuario real: copia los datos de un usuario ORIGEN (adulto con consentimiento,
    por defecto PIN 1) a un usuario de PRUEBA inventado (por defecto PIN 9001, "PRUEBA SPORTMAPS").
  - Si el PIN de prueba YA existe en el lector, aborta sin escribir nada.
  - Sin -Confirmar es un ENSAYO: solo lee y dice que metodos del SDK existen. No escribe.
  - Con -Confirmar escribe SOLO el PIN de prueba y, al terminar, lo BORRA (salvo -Mantener, para
    poder hacer la prueba fisica de rostro; luego se limpia con -SoloBorrar).
  - No imprime ni guarda plantillas: solo longitudes y si coinciden. Nada se escribe a disco salvo el log.
  - No deshabilita el equipo (no corta el ingreso mientras corre).

  Uso (PowerShell de 32 bits):
    # 1) ensayo (no escribe)
    C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -File .\prueba_escritura_rostro_sdk.ps1 -Ip 192.168.1.201
    # 2) prueba real, borra el PIN de prueba al final
    ... -Ip 192.168.1.201 -Confirmar
    # 3) dejarlo para marcar con el rostro y despues limpiar
    ... -Ip 192.168.1.201 -Confirmar -Mantener
    ... -Ip 192.168.1.201 -SoloBorrar
#>
param(
    [string]$Ip        = '192.168.1.201',
    [int]   $Port      = 4370,
    [string]$SourcePin = '1',
    [string]$TestPin   = '9001',
    [switch]$Confirmar,
    [switch]$Mantener,
    [switch]$SoloBorrar,
    # Para un PIN de origen que solo tiene huella: prueba unicamente la escritura de la huella.
    [switch]$SoloHuella
)

if ([IntPtr]::Size -ne 4) {
    Write-Host "Necesita el PowerShell de 32 bits (C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe)." -ForegroundColor Red
    exit 1
}
if ($TestPin -eq $SourcePin) { Write-Host "El PIN de prueba no puede ser el de origen." -ForegroundColor Red; exit 1 }

$log = Join-Path $PSScriptRoot ("prueba_escritura_rostro_{0}_{1}.log" -f $Ip.Replace('.', '-'), (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Say([string]$t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }

$zk = $null
foreach ($prog in 'zkemkeeper.ZKEM.1', 'zkemkeeper.ZKEM', 'zkemkeeper.CZKEM.1', 'zkemkeeper.CZKEM') {
    try { $zk = New-Object -ComObject $prog; break } catch { }
}
if (-not $zk) { Write-Host "No se pudo cargar el SDK (ejecuta primero diagnostico_rostro_sdk.ps1)." -ForegroundColor Red; exit 1 }

Say "=== Prueba de ESCRITURA por SDK -- $Ip`:$Port -- origen $SourcePin -> prueba $TestPin -- $(Get-Date) ==="
Say ("Modo: " + $(if ($SoloBorrar) { 'SOLO BORRAR el PIN de prueba' } elseif ($Confirmar) { 'REAL (escribe solo el PIN de prueba)' } else { 'ENSAYO (no escribe)' }))

if (-not $zk.Connect_Net($Ip, $Port)) { Say "No se pudo conectar. Reintenta en un minuto."; exit 1 }

function UserExists([string]$pin) {
    $n = ''; $p = ''; $pr = 0; $en = $false
    return [bool]$zk.SSR_GetUserInfo(1, $pin, [ref]$n, [ref]$p, [ref]$pr, [ref]$en)
}
# Borra SOLO el PIN indicado. Prueba varias formas porque en este firmware no todas aplican, y
# dice cual funciono (o el codigo de error de cada una). Se vuelve a leer el usuario para confirmar.
function DeleteTestUser([string]$pin) {
    $intentos = @(
        @{ n = 'SSR_DeleteEnrollDataExt(12)'; f = { $zk.SSR_DeleteEnrollDataExt(1, $pin, 12) } },
        @{ n = 'SSR_DeleteEnrollData(12)';    f = { $zk.SSR_DeleteEnrollData(1, $pin, 12) } },
        @{ n = 'DeleteEnrollData(12)';        f = { $zk.DeleteEnrollData(1, $pin, 1, 12) } },
        @{ n = 'borrar rostro(50)+huellas(11)+usuario(12)'; f = {
            $a = $zk.SSR_DeleteEnrollDataExt(1, $pin, 50)
            $b = $zk.SSR_DeleteEnrollDataExt(1, $pin, 11)
            $c = $zk.SSR_DeleteEnrollDataExt(1, $pin, 12)
            return ($a -or $b -or $c) } }
    )
    foreach ($i in $intentos) {
        $ok = $false; $err = 0
        try { $ok = [bool](& $i.f) } catch { Say ("  {0}: no disponible ({1})" -f $i.n, $_.Exception.Message) ; continue }
        $null = $zk.GetLastError([ref]$err)
        $null = $zk.RefreshData(1)
        # El lector tarda un instante en reflejar el borrado: se espera hasta ~10 s antes de dar fallo
        # (sin esta espera, la prueba del 2026-10-23 dio un falso "FALLO" y el usuario si se habia borrado).
        $sigue = $true
        foreach ($k in 1..10) { Start-Sleep -Milliseconds 1000; if (-not (UserExists $pin)) { $sigue = $false; break } }
        Say ("  {0}: devolvio {1}, codigo {2}, el usuario {3}" -f $i.n, $ok, $err, $(if ($sigue) { 'SIGUE' } else { 'ya no esta' }))
        if (-not $sigue) { return $true }
    }
    return $false
}

try {
    $sn = ''; $null = $zk.GetSerialNumber(1, [ref]$sn); Say "Equipo: $sn"

    if ($SoloBorrar) {
        if (-not (UserExists $TestPin)) { Say "El PIN $TestPin no existe: nada que borrar."; exit 0 }
        Say ("Borrado del PIN de prueba {0}: {1}" -f $TestPin, $(if (DeleteTestUser $TestPin) { 'OK' } else { 'FALLO' }))
        exit 0
    }

    # Metodos de escritura disponibles en esta version del SDK
    $necesarios = 'SSR_SetUserInfo', 'SetUserFaceStr', 'SetUserTmpExStr', 'SSR_DeleteEnrollDataExt', 'RefreshData'
    $faltan = @($necesarios | Where-Object { -not ($zk | Get-Member -Name $_ -MemberType Method) })
    if ($faltan.Count) { Say ("FALTAN metodos en este SDK: " + ($faltan -join ', ') + " -> no se puede probar la escritura."); exit 1 }
    Say "Metodos de escritura disponibles: OK"

    # Origen (solo lectura)
    if (-not (UserExists $SourcePin)) { Say "El PIN de origen $SourcePin no existe."; exit 1 }
    $face = ''; $flen = 0
    $okFace = $zk.GetUserFaceStr(1, $SourcePin, 50, [ref]$face, [ref]$flen)
    $flag = 0; $tmp = ''; $tlen = 0
    $okTmp = $zk.GetUserTmpExStr(1, $SourcePin, 0, [ref]$flag, [ref]$tmp, [ref]$tlen)
    Say ("Origen {0}: rostro={1} ({2} bytes), huella dedo0={3} ({4} bytes)" -f $SourcePin, $(if ($okFace -and $flen -gt 0) { 'leido' } else { 'NO' }), $flen, $(if ($okTmp -and $tlen -gt 0) { 'leida' } else { 'NO' }), $tlen)
    $tieneRostro = ($okFace -and $flen -gt 0)
    $tieneHuella = ($okTmp -and $tlen -gt 0)
    if (-not $tieneRostro -and -not $SoloHuella) { Say "No hay rostro que copiar. (Si solo quieres probar la huella de este PIN, agrega -SoloHuella.)"; exit 1 }
    if ($SoloHuella -and -not $tieneHuella) { Say "Este PIN tampoco tiene huella legible: nada que copiar."; exit 1 }
    if ($SoloHuella) { $tieneRostro = $false; Say "Modo -SoloHuella: no se prueba el rostro." }

    # El PIN de prueba no debe existir
    if (UserExists $TestPin) { Say "ABORTADO: el PIN de prueba $TestPin YA existe en el lector. No se escribio nada."; exit 1 }

    if (-not $Confirmar) {
        Say "ENSAYO terminado: todo en orden para escribir. Para la prueba real agrega -Confirmar. No se escribio nada."
        exit 0
    }

    # ---- Escritura SOLO del PIN de prueba ----
    $creado = $false
    try {
        $creado = [bool]$zk.SSR_SetUserInfo(1, $TestPin, 'PRUEBA SPORTMAPS', '', 0, $true)
        Say "Crear usuario de prueba ${TestPin}: $(if ($creado) { 'OK' } else { 'FALLO' })"
        if ($creado) {
            if ($tieneRostro) {
                $okW = [bool]$zk.SetUserFaceStr(1, $TestPin, 50, $face, $flen)
                Say "Escribir rostro: $(if ($okW) { 'OK' } else { 'FALLO' })"
            }
            if ($tieneHuella) {
                $okT = [bool]$zk.SetUserTmpExStr(1, $TestPin, 0, $flag, $tmp)
                Say "Escribir huella dedo0: $(if ($okT) { 'OK' } else { 'FALLO' })"
            }
            $null = $zk.RefreshData(1)

            # Releer y comparar (sin imprimir contenido)
            if ($tieneRostro) {
                $face2 = ''; $flen2 = 0
                $okR = $zk.GetUserFaceStr(1, $TestPin, 50, [ref]$face2, [ref]$flen2)
                $igualF = ($okR -and $flen2 -eq $flen -and $face2 -ceq $face)
                Say ("Rostro releido: {0} bytes -> {1}" -f $flen2, $(if ($igualF) { 'IDENTICO al original' } else { 'DISTINTO o ilegible' }))
            }
            if ($tieneHuella) {
                $flag2 = 0; $tmp2 = ''; $tlen2 = 0
                $okR2 = $zk.GetUserTmpExStr(1, $TestPin, 0, [ref]$flag2, [ref]$tmp2, [ref]$tlen2)
                $igualT = ($okR2 -and $tlen2 -eq $tlen -and $tmp2 -ceq $tmp)
                Say ("Huella releida: {0} bytes -> {1}" -f $tlen2, $(if ($igualT) { 'IDENTICA al original' } else { 'DISTINTA o ilegible' }))
            }
        }
    }
    finally {
        if ($creado -and -not $Mantener) {
            Say ("Limpieza: borrar PIN de prueba {0}: {1}" -f $TestPin, $(if (DeleteTestUser $TestPin) { 'OK' } else { 'FALLO - borrarlo con -SoloBorrar' }))
        } elseif ($creado) {
            Say "-Mantener: el PIN $TestPin SIGUE en el lector. Marca con el rostro de origen para ver si lo reconoce y luego ejecuta con -SoloBorrar."
        }
    }
    Say "=== Fin. Solo se escribio el PIN de prueba $TestPin. ==="
}
finally {
    $null = $zk.Disconnect()
    Say "Registro guardado en: $log"
}
