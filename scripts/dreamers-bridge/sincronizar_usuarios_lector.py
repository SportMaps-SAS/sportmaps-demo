"""
Sincroniza la lista de usuarios de los MB360 de Dreamers con SportMaps ("IDs del lector")
=========================================================================================

Qué hace: lee de cada lector (SOLO LECTURA) quién está cargado -- PIN, nombre, si tiene clave y,
opcionalmente, si tiene huella -- y se lo manda a SportMaps (POST /bridge/device-users) para la
pantalla Control de acceso > "IDs del lector", donde se asocia cada PIN a un deportista.

Qué NO hace: no escribe nada en los lectores (ni set_user, ni set_time, ni disable_device), no
manda plantillas biométricas (solo banderas), y NO ve rostros: pyzk no los lee, así que el rostro
viaja como "sin leer" (null), que la pantalla muestra como "—" y NO como "no tiene".

POR DEFECTO NO ENVÍA NADA: cuenta lo que leería y lo muestra (modo de prueba). Para enviar de
verdad hay que pasar --enviar. Son ~600 personas, muchas menores: no se envía hasta que el dueño
de la escuela lo autorice.

Uso (PowerShell, en la PC de Dreamers). El bridge compite por la conexión al lector: hay que
pararlo mientras corre esto y volver a arrancarlo.

    Stop-ScheduledTask -TaskName "SportMaps-DreamersBridge"
    python sincronizar_usuarios_lector.py                 # prueba, no envía
    python sincronizar_usuarios_lector.py --enviar        # envía de verdad
    python sincronizar_usuarios_lector.py --enviar --sin-huellas   # más rápido: no lee huellas
    Start-ScheduledTask -TaskName "SportMaps-DreamersBridge"

Variables: SPORTMAPS_BRIDGE_API_KEY (obligatoria con --enviar; la misma del bridge) y, opcional,
SPORTMAPS_BACKEND_URL (por defecto el mismo servidor al que apunta dreamers_bridge.py).
"""

import argparse
import os
import sys

from zk import ZK

try:
    import requests
except ImportError:  # el bridge ya la usa; avisar claro si falta
    requests = None

BACKEND_BASE_URL = os.environ.get("SPORTMAPS_BACKEND_URL", "https://bffdev.sportmaps.co").rstrip("/")
SCHOOL_ID = "57ba9352-2c11-4b5b-aa5b-e5ec6f526cbe"  # Dreamers Gymnastics
BRIDGE_API_KEY = os.environ.get("SPORTMAPS_BRIDGE_API_KEY", "")

DEVICES = [
    {"name": "LECTOR ENTRADA", "ip": "192.168.1.201", "port": 4370},
    {"name": "LECTOR SALIDA",  "ip": "192.168.1.202", "port": 4370},
]

# Solo se envía de los lectores cuyo serial es uno de estos (los de turnstile_devices): la IP no
# basta para saber qué equipo es.
SERIES_CONOCIDAS = {
    "CEZU222860004": "LECTOR ENTRADA",
    "CEZU214960067": "LECTOR SALIDA",
}

CONNECT_TIMEOUT = 15


def leer_lector(device, con_huellas):
    """Devuelve (serial, [usuarios]) de UN lector. Solo funciones de lectura."""
    zk = ZK(device["ip"], port=device["port"], timeout=CONNECT_TIMEOUT)
    conn = None
    try:
        conn = zk.connect()
        serial = str(conn.get_serialnumber()).strip()
        users = conn.get_users()

        uids_con_huella = None  # None = no se leyó
        if con_huellas:
            try:
                uids_con_huella = {t.uid for t in conn.get_templates()}
            except Exception as e:  # una lectura de huellas fallida no debe tumbar la lista
                print(f"  (aviso) no se pudieron leer las huellas: {type(e).__name__}: {e}")

        salida = []
        for u in users:
            try:
                pin = int(str(u.user_id).strip())
            except ValueError:
                continue  # PIN no numérico: SportMaps solo maneja PIN enteros
            salida.append({
                "pin": pin,
                "name": (u.name or "").strip(),
                "has_password": bool(u.password),
                "has_fingerprint": (u.uid in uids_con_huella) if uids_con_huella is not None else None,
                "has_face": None,  # pyzk no lee rostros: «sin leer», NO «no tiene»
                "privilege": int(u.privilege),
            })
        return serial, salida
    finally:
        if conn:
            try:
                conn.disconnect()
            except Exception:
                pass


def enviar(serial, usuarios):
    if requests is None:
        raise RuntimeError("Falta el paquete 'requests' (pip install requests).")
    total = {"guardados": 0, "eliminados": 0, "descartados": 0}
    # El backend reemplaza la foto del lector con cada llamada, así que el reemplazo es sobre el
    # ÚLTIMO lote: se manda todo en una sola petición si cabe; si no, no se puede reemplazar a medias.
    if len(usuarios) > 5000:
        raise RuntimeError("Más de 5000 usuarios: el backend no los aceptaría en una sola petición.")
    r = requests.post(
        f"{BACKEND_BASE_URL}/bridge/device-users",
        headers={"X-Bridge-Api-Key": BRIDGE_API_KEY, "Content-Type": "application/json"},
        json={"school_id": SCHOOL_ID, "device_serial": serial, "users": usuarios},
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(f"El servidor respondió {r.status_code}: {r.text[:300]}")
    for k, v in r.json().items():
        if k in total:
            total[k] += int(v)
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--enviar", action="store_true", help="enviar a SportMaps (sin esto solo cuenta)")
    ap.add_argument("--sin-huellas", action="store_true", help="no leer huellas (más rápido)")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if args.enviar and not BRIDGE_API_KEY:
        print("ERROR: falta la variable SPORTMAPS_BRIDGE_API_KEY (la misma llave del bridge). No se envió nada.")
        return 2

    print(f"Modo: {'ENVIAR a ' + BACKEND_BASE_URL if args.enviar else 'PRUEBA (no se envía nada)'}")
    ok = True
    for device in DEVICES:
        print(f"\n=== {device['name']} ({device['ip']}) ===")
        try:
            serial, usuarios = leer_lector(device, con_huellas=not args.sin_huellas)
        except Exception as e:
            print(f"ERROR leyendo {device['name']}: {type(e).__name__}: {e}")
            ok = False
            continue

        quien = SERIES_CONOCIDAS.get(serial)
        con_clave = sum(1 for u in usuarios if u["has_password"])
        con_huella = sum(1 for u in usuarios if u["has_fingerprint"])
        sin_nombre = sum(1 for u in usuarios if not u["name"])
        print(f"Serial: {serial}  ({quien or 'DESCONOCIDO'})")
        print(f"Usuarios legibles: {len(usuarios)} | con clave: {con_clave} | "
              f"con huella: {con_huella if not args.sin_huellas else 'no leído'} | sin nombre: {sin_nombre}")
        # A propósito NO se imprimen nombres: son datos de ~600 personas.

        if quien is None:
            print("  No se envía: el serial no es uno de los conocidos.")
            ok = False
            continue
        if not usuarios:
            print("  No se envía: la lista está vacía.")
            ok = False
            continue
        if not args.enviar:
            print("  (prueba) no se envió nada. Agregue --enviar para enviar.")
            continue
        try:
            r = enviar(serial, usuarios)
            print(f"  Enviado. Guardados: {r['guardados']} | retirados (ya no están): {r['eliminados']} | descartados: {r['descartados']}")
        except Exception as e:
            print(f"  ERROR enviando: {type(e).__name__}: {e}")
            ok = False

    print("\n=== Fin (no se escribió nada en los lectores) ===")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
