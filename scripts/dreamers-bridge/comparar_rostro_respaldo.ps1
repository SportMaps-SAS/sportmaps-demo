<#
  comparar_rostro_respaldo.ps1  --  SOLO LECTURA

  Tras restaurar un usuario, el rostro releido dio el mismo tamano pero "DISTINTO" al respaldo, aunque el
  torniquete SI lo reconocio. Este script mide CUANTO y DONDE difieren, sin imprimir la plantilla:
    - cuantos caracteres difieren y que porcentaje es,
    - en que posiciones (primera y ultima),
    - si las diferencias se concentran al inicio (encabezado/metadatos) o estan repartidas (contenido).
  Una diferencia concentrada en los primeros bytes suele ser metadato que el lector reescribe; repartida
  por todo el cuerpo seria contenido distinto.

  Uso (PowerShell de 32 bits):
    ... -File .\comparar_rostro_respaldo.ps1 -Ip 192.168.1.201 -Pin 4 -Respaldo .\respaldo_pin4_XXXX.json
#>
param(
    [string]$Ip = '192.168.1.201',
    [int]   $Port = 4370,
    [Parameter(Mandatory = $true)][string]$Pin,
    [Parameter(Mandatory = $true)][string]$Respaldo
)

if ([IntPtr]::Size -ne 4) { Write-Host "Necesita el PowerShell de 32 bits (SysWOW64)." -ForegroundColor Red; exit 1 }

$zk = $null
foreach ($prog in 'zkemkeeper.ZKEM.1', 'zkemkeeper.ZKEM', 'zkemkeeper.CZKEM.1', 'zkemkeeper.CZKEM') {
    try { $zk = New-Object -ComObject $prog; break } catch { }
}
if (-not $zk) { Write-Host "No se pudo cargar el SDK." -ForegroundColor Red; exit 1 }
if (-not $zk.Connect_Net($Ip, $Port)) { Write-Host "No se pudo conectar." -ForegroundColor Red; exit 1 }

try {
    $b = Get-Content -Raw -Path $Respaldo | ConvertFrom-Json
    $orig = [string]$b.face
    if (-not $orig) { Write-Host "El respaldo no trae rostro."; exit 1 }

    $actual = ''; $len = 0
    if (-not ($zk.GetUserFaceStr(1, $Pin, 50, [ref]$actual, [ref]$len) -and $len -gt 0)) {
        Write-Host "No se pudo leer el rostro actual del PIN $Pin."; exit 1
    }

    Write-Host ("Respaldo: {0} caracteres | Actual: {1} caracteres" -f $orig.Length, $actual.Length)
    $n = [Math]::Min($orig.Length, $actual.Length)
    $difs = New-Object System.Collections.Generic.List[int]
    for ($i = 0; $i -lt $n; $i++) { if ($orig[$i] -cne $actual[$i]) { $difs.Add($i) } }

    if ($difs.Count -eq 0 -and $orig.Length -eq $actual.Length) { Write-Host "IDENTICOS."; exit 0 }
    Write-Host ("Posiciones distintas: {0} de {1} ({2:N2} %)" -f $difs.Count, $n, (100.0 * $difs.Count / $n))
    if ($difs.Count) {
        Write-Host ("Primera diferencia en la posicion {0}; ultima en {1}" -f $difs[0], $difs[$difs.Count - 1])
        # Reparto en 10 tramos iguales para ver si se concentra en una zona
        $tramo = [Math]::Ceiling($n / 10.0)
        $cuenta = @(0) * 10
        foreach ($d in $difs) { $cuenta[[Math]::Min(9, [int][Math]::Floor($d / $tramo))]++ }
        Write-Host ("Diferencias por decil del archivo (0 = inicio ... 9 = final): " + ($cuenta -join ' '))
    }
}
finally {
    $null = $zk.Disconnect()
}
