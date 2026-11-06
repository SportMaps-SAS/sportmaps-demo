<#
  ciclo_bloqueo_restaurar_sdk.ps1

  Prueba el ciclo COMPLETO de bloqueo fisico por "borrar y restaurar" con el SDK oficial, sobre UN
  usuario de pruebas:
     respaldar (rostro + huellas + datos)  ->  borrar del lector  ->  [la persona intenta marcar: NO debe pasar]
     ->  restaurar  ->  verificar que se escribio igual  ->  [la persona marca: DEBE pasar]

  SEGURIDAD
  - Sin -Confirmar es un ENSAYO: solo lee y muestra que respaldaria. No escribe ni borra nada.
  - Con -Confirmar:
      1) Guarda primero el respaldo en un archivo local (BackupDir) ANTES de borrar nada. Si el
         script se corta, el usuario se recupera con  -RestaurarDesde <archivo>.
      2) Borra SOLO el PIN indicado.
      3) Si la restauracion falla, NO borra el respaldo y avisa.
  - El respaldo contiene datos biometricos: queda solo en esta PC. No se sube a ningun servidor.
    Borra el archivo cuando termines la prueba.
  - Solo en el lector que indiques (-Ip). No deshabilita el equipo.
  - Respalda y restaura tambien la TARJETA RFID (se lee recorriendo la lista de usuarios del lector;
    no se imprime el numero, solo si tiene o no). Si el SDK no pudiera leerla, el aviso sale en el ensayo.

  Uso (PowerShell de 32 bits), PIN de pruebas con huella y/o rostro y que pueda marcar fisicamente:
    ... -File .\ciclo_bloqueo_restaurar_sdk.ps1 -Ip 192.168.1.201 -Pin 12              # ensayo
    ... -File .\ciclo_bloqueo_restaurar_sdk.ps1 -Ip 192.168.1.201 -Pin 12 -Confirmar   # ciclo real
    ... -File .\ciclo_bloqueo_restaurar_sdk.ps1 -Ip 192.168.1.201 -RestaurarDesde .\respaldo_pin12_XXXX.json
#>
param(
    [string]$Ip = '192.168.1.201',
    [int]   $Port = 4370,
    [string]$Pin,
    [string]$BackupDir = $PSScriptRoot,
    [string]$RestaurarDesde,
    [switch]$Confirmar,
    # La tarjeta RFID NO se usa en Dreamers: por defecto se omite (leerla recorre los ~600 usuarios del
    # lector). Agregar -ConTarjeta solo para un cliente que si la use.
    [switch]$ConTarjeta
)

if ([IntPtr]::Size -ne 4) { Write-Host "Necesita el PowerShell de 32 bits (SysWOW64)." -ForegroundColor Red; exit 1 }
if (-not $Pin -and -not $RestaurarDesde) { Write-Host "Indica -Pin <numero> (o -RestaurarDesde <archivo>)." -ForegroundColor Red; exit 1 }

$log = Join-Path $PSScriptRoot ("ciclo_bloqueo_{0}_{1}.log" -f $Ip.Replace('.', '-'), (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Say([string]$t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }

$zk = $null
foreach ($prog in 'zkemkeeper.ZKEM.1', 'zkemkeeper.ZKEM', 'zkemkeeper.CZKEM.1', 'zkemkeeper.CZKEM') {
    try { $zk = New-Object -ComObject $prog; break } catch { }
}
if (-not $zk) { Write-Host "No se pudo cargar el SDK." -ForegroundColor Red; exit 1 }
if (-not $zk.Connect_Net($Ip, $Port)) { Write-Host "No se pudo conectar a $Ip. Reintenta en un minuto." -ForegroundColor Red; exit 1 }

function UserInfo([string]$pin) {
    $n = ''; $p = ''; $pr = 0; $en = $false
    if ($zk.SSR_GetUserInfo(1, $pin, [ref]$n, [ref]$p, [ref]$pr, [ref]$en)) {
        return @{ name = $n; password = $p; privilege = $pr; enabled = $en }
    }
    return $null
}

# Tarjeta RFID: el SDK la expone por otra via. Se recorre la lista de usuarios hasta el PIN y se pide
# el numero de tarjeta del ultimo usuario leido. Devuelve '' si no tiene (o '0').
function LeerTarjeta([string]$pin) {
    $card = ''
    try {
        if ($zk.ReadAllUserID(1)) {
            $en = ''; $nm = ''; $pw = ''; $pv = 0; $ok = $false
            while ($zk.SSR_GetAllUserInfo(1, [ref]$en, [ref]$nm, [ref]$pw, [ref]$pv, [ref]$ok)) {
                if ($en -eq $pin) {
                    $c = ''
                    if ($zk.GetStrCardNumber([ref]$c)) { $card = [string]$c }
                    break
                }
            }
        }
    } catch { Say "  (aviso) no se pudo leer la tarjeta: $($_.Exception.Message)" }
    if ($card -eq '0') { $card = '' }
    return $card
}

function Leer([string]$pin) {
    $u = UserInfo $pin
    if (-not $u) { return $null }
    $face = ''; $flen = 0
    $okF = $zk.GetUserFaceStr(1, $pin, 50, [ref]$face, [ref]$flen)
    $dedos = @()
    foreach ($f in 0..9) {
        $flag = 0; $tmp = ''; $tlen = 0
        if ($zk.GetUserTmpExStr(1, $pin, $f, [ref]$flag, [ref]$tmp, [ref]$tlen) -and $tlen -gt 0) {
            $dedos += @{ index = $f; flag = $flag; data = $tmp; len = $tlen }
        }
    }
    return @{
        pin = $pin; name = $u.name; password = $u.password; privilege = $u.privilege; enabled = $u.enabled
        face = $(if ($okF -and $flen -gt 0) { $face } else { $null }); face_len = $flen
        fingers = $dedos
        card = $(if ($ConTarjeta) { LeerTarjeta $pin } else { '' })
    }
}

function Existe([string]$pin) { return [bool](UserInfo $pin) }

# El MB360 aplica el borrado al cerrar la conexion: leer en la misma sesion sigue mostrando el
# usuario (se vio con el PIN 9001 y el 12 el 2026-10-23). Por eso se RECONECTA antes de verificar.
function Reconectar {
    $null = $zk.Disconnect()
    Start-Sleep -Milliseconds 2000
    return [bool]$zk.Connect_Net($Ip, $Port)
}
function EsperarBorrado([string]$pin) {
    foreach ($k in 1..5) {
        if (Reconectar) { if (-not (Existe $pin)) { return $true } }
        Start-Sleep -Milliseconds 2000
    }
    return $false
}

function Borrar([string]$pin) {
    $null = $zk.SSR_DeleteEnrollDataExt(1, $pin, 12)
    $null = $zk.RefreshData(1)
    if (EsperarBorrado $pin) { return $true }
    $null = $zk.SSR_DeleteEnrollData(1, $pin, 12); $null = $zk.RefreshData(1)
    return (EsperarBorrado $pin)
}

function Restaurar($b) {
    # La tarjeta se fija ANTES de escribir el usuario (asi lo exige el SDK).
    if ($b.card) {
        $rc = [bool]$zk.SetStrCardNumber([string]$b.card)
        Say "  tarjeta (preparar): $(if ($rc) { 'OK' } else { 'FALLO' })"
    }
    $ok = [bool]$zk.SSR_SetUserInfo(1, $b.pin, $b.name, $b.password, [int]$b.privilege, [bool]$b.enabled)
    Say "  usuario: $(if ($ok) { 'OK' } else { 'FALLO' })"
    $todo = $ok
    if ($b.face) {
        $r = [bool]$zk.SetUserFaceStr(1, $b.pin, 50, $b.face, [int]$b.face_len)
        Say "  rostro: $(if ($r) { 'OK' } else { 'FALLO' })"; $todo = $todo -and $r
    }
    foreach ($d in $b.fingers) {
        $r = [bool]$zk.SetUserTmpExStr(1, $b.pin, [int]$d.index, [int]$d.flag, [string]$d.data)
        Say "  huella dedo $($d.index): $(if ($r) { 'OK' } else { 'FALLO' })"; $todo = $todo -and $r
    }
    $null = $zk.RefreshData(1)
    return $todo
}

function Verificar($b) {
    $n = Leer $b.pin
    if (-not $n) { Say "  verificacion: el usuario NO esta en el lector."; return $false }
    $bien = $true
    if ($b.face) {
        $igual = ($n.face -and $n.face_len -eq $b.face_len -and $n.face -ceq $b.face)
        Say ("  rostro releido: {0} bytes -> {1}" -f $n.face_len, $(if ($igual) { 'IDENTICO' } else { 'DISTINTO' })); $bien = $bien -and $igual
    }
    foreach ($d in $b.fingers) {
        $m = $n.fingers | Where-Object { $_.index -eq $d.index }
        $igual = ($m -and $m.len -eq $d.len -and $m.data -ceq $d.data)
        Say ("  huella dedo {0} releida: {1} bytes -> {2}" -f $d.index, $(if ($m) { $m.len } else { 0 }), $(if ($igual) { 'IDENTICA' } else { 'DISTINTA' })); $bien = $bien -and $igual
    }
    $mismoUsuario = ($n.name -ceq $b.name -and $n.privilege -eq $b.privilege -and $n.enabled -eq $b.enabled)
    Say "  datos del usuario (nombre/privilegio/habilitado): $(if ($mismoUsuario) { 'IGUALES' } else { 'DISTINTOS' })"
    # La clave (codigo) tambien debe volver igual: es una de las vias con que se marca.
    $mismaClave = ([string]$n.password -ceq [string]$b.password)
    Say "  clave (codigo): $(if ($b.password) { if ($mismaClave) { 'IGUAL' } else { 'DISTINTA' } } else { 'sin clave' })"
    $mismoUsuario = $mismoUsuario -and $mismaClave
    # La tarjeta tambien debe volver igual.
    $mismaTarjeta = ([string]$n.card -ceq [string]$b.card)
    Say "  tarjeta: $(if ($b.card) { if ($mismaTarjeta) { 'IGUAL' } else { 'DISTINTA' } } else { 'sin tarjeta' })"
    $mismoUsuario = $mismoUsuario -and $mismaTarjeta
    return ($bien -and $mismoUsuario)
}

try {
    $sn = ''; $null = $zk.GetSerialNumber(1, [ref]$sn)
    Say "=== Ciclo de bloqueo/restauracion -- $Ip -- equipo $sn -- $(Get-Date) ==="

    # ---- Restaurar desde un respaldo (recuperacion si algo se corto) ----
    if ($RestaurarDesde) {
        $b = Get-Content -Raw -Path $RestaurarDesde | ConvertFrom-Json
        $bh = @{ pin = [string]$b.pin; name = $b.name; password = $b.password; privilege = $b.privilege; enabled = $b.enabled
                 face = $b.face; face_len = $b.face_len; card = [string]$b.card
                 fingers = @($b.fingers | ForEach-Object { @{ index = $_.index; flag = $_.flag; data = $_.data; len = $_.len } }) }
        if (Existe $bh.pin) { Say "El PIN $($bh.pin) YA existe en el lector: no se restaura encima."; exit 1 }
        Say "Restaurando PIN $($bh.pin) desde $RestaurarDesde ..."
        $ok = Restaurar $bh
        $ver = Verificar $bh
        Say "Resultado: $(if ($ok -and $ver) { 'RESTAURADO y verificado' } else { 'CON PROBLEMAS: revisar arriba' })"
        exit 0
    }

    $b = Leer $Pin
    if (-not $b) { Say "El PIN $Pin no existe en este lector."; exit 1 }
    Say ("PIN {0}: nombre='{1}' privilegio={2} habilitado={3} clave={4} | tarjeta={8} | rostro={5} ({6} bytes) | huellas={7}" -f `
        $Pin, $b.name, $b.privilege, $b.enabled, $(if ($b.password) { 'si' } else { 'no' }), $(if ($b.face) { 'si' } else { 'no' }), $b.face_len, $b.fingers.Count, $(if ($b.card) { 'si' } else { 'no' }))
    if (-not $b.face -and $b.fingers.Count -eq 0 -and -not $b.password -and -not $b.card) { Say "Este PIN no tiene ninguna credencial legible (rostro, huella, clave o tarjeta): no sirve para la prueba."; exit 1 }

    if (-not $Confirmar) {
        Say "ENSAYO: se respaldaria, se borraria, y se restauraria este usuario. Para hacerlo de verdad agrega -Confirmar. No se toco nada."
        exit 0
    }

    # ---- 1) Respaldo a disco ANTES de borrar ----
    $archivo = Join-Path $BackupDir ("respaldo_pin{0}_{1}.json" -f $Pin, (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $b | ConvertTo-Json -Depth 6 | Set-Content -Path $archivo -Encoding UTF8
    if (-not (Test-Path $archivo) -or (Get-Item $archivo).Length -lt 200) { Say "No se pudo guardar el respaldo: ABORTADO sin borrar nada."; exit 1 }
    Say "Respaldo guardado: $archivo ($((Get-Item $archivo).Length) bytes). Contiene biometria: no lo compartas."

    # ---- 2) Borrar ----
    Say "Borrando el PIN $Pin del lector ..."
    if (-not (Borrar $Pin)) { Say "NO se pudo borrar (sigue en el lector). No se restaura nada. Respaldo conservado."; exit 1 }
    Say "Borrado confirmado: el PIN $Pin ya no esta en el lector."

    # ---- 3) Prueba fisica: debe NEGAR ----
    Write-Host ""
    Write-Host ">>> AHORA la persona del PIN $Pin debe intentar marcar de a UNA vía: el torniquete NO debe abrir con ninguna." -ForegroundColor Yellow
    foreach ($via in @('huella', 'codigo (PIN/clave)', 'rostro') + $(if ($ConTarjeta) { 'tarjeta' } else { @() })) {
        $r = Read-Host "  $via -> escribe 'no paso' si fue negada, 'paso' si abrio, o 'n/a' si no aplica"
        Say "Prueba fisica 1 (usuario BORRADO) - $via : '$r'"
    }

    # ---- 4) Restaurar y verificar ----
    Say "Restaurando ..."
    $ok = Restaurar $b
    $ver = Verificar $b
    Say "Restauracion: $(if ($ok -and $ver) { 'OK y verificada' } else { 'CON PROBLEMAS (respaldo conservado en ' + $archivo + ')' })"

    # ---- 5) Prueba fisica: debe PASAR ----
    Write-Host ""
    Write-Host ">>> AHORA la misma persona debe marcar de nuevo, de a UNA vía: el torniquete DEBE abrir con todas." -ForegroundColor Yellow
    foreach ($via in @('huella', 'codigo (PIN/clave)', 'rostro') + $(if ($ConTarjeta) { 'tarjeta' } else { @() })) {
        $r = Read-Host "  $via -> escribe 'paso' si abrio, 'no paso' si la nego, o 'n/a' si no aplica"
        Say "Prueba fisica 2 (usuario RESTAURADO) - $via : '$r'"
    }

    Say "=== Fin del ciclo. Respaldo: $archivo (borralo al terminar la prueba) ==="
}
finally {
    $null = $zk.Disconnect()
    Say "Registro guardado en: $log"
}
