// bff/src/routes/bridge.routes.ts
//
// Canal para scripts locales (SDK pyzk por LAN, ej. scripts/gymrm-door-bridge/)
// que ejecutan físicamente comandos `open_door` que el firmware del F22ID
// acepta por ADMS (Return:0) pero no mueve el relé. Separado a propósito del
// canal ADMS (`/iclock/*`, ver access-adms.ts): ese habla el protocolo de
// texto plano del dispositivo; este es JSON para un proceso desatendido que
// actúa POR el dispositivo, no ES el dispositivo.
//
// NO usa JWT de usuario — es un proceso sin sesión corriendo en una PC del
// gym. Se valida con `X-Bridge-Api-Key` contra BRIDGE_API_KEY (mismo patrón
// fail-closed que internal-notifications.routes.ts: sin la env var, 401
// siempre, nunca se acepta sin secreto configurado).
//
// Ver scripts/gymrm-door-bridge/VALIDACION-2026-08-25.md y BACKEND_ENDPOINT_SPEC.md
// para el diseño completo y los hallazgos que este archivo resuelve.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { supabase } from '../config/supabase';
import { normalizeRosterUsers, replaceDeviceRoster } from '../services/accessRoster.service';

const router = Router();

function apiKeyOk(req: Request): boolean {
  const key = process.env.BRIDGE_API_KEY;
  if (!key) return false; // fail-closed: sin key en env, no se acepta nada
  const got = String(req.header('x-bridge-api-key') || '');
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── GET /bridge/door-commands?school_id=<uuid>&command_types=open_door,set_group ─
// Reclama atómicamente los comandos pendientes y no expirados de la escuela
// (UPDATE ... WHERE claimed_at IS NULL, en una sola sentencia — dos llamadas
// concurrentes o un reintento de red no pueden reclamar la misma fila dos
// veces). No se usa un valor 'claimed' de `status` porque no hay certeza
// sobre un eventual CHECK constraint aplicado a mano en Supabase (ver
// hallazgo 2 de la validación); `claimed_at` es una columna nueva y no
// cambia el significado de `status` para nadie más que lo lea.
//
// `command_types` (opcional, coma-separado) — default SOLO `open_door`, el
// comportamiento de siempre para quien no lo manda (GYM RM: su F22ID sí
// procesa `set_group` nativo por ADMS, agregar ese tipo acá lo dejaría en
// carrera con el propio dispositivo reclamando el mismo comando). Dreamers
// (MB360/ID, fix 2026-09-05) pasa `open_door,set_group`: sus lectores nunca
// completan el push ADMS en absoluto (ver dreamers_bridge.py), así que
// `set_group` (bloqueo por mora, banco de horas) tampoco les llegaba nunca
// por ese canal — quedaban 'pending' para siempre, nunca 'executed' ni
// 'failed'. Mismo mecanismo de reclamo, ejecución vía SDK local en vez de
// ADMS.
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Long-polling opcional (2026-09-06): `wait_seconds` (0-20, default 0 = el
// comportamiento de siempre, responder al instante haya o no comandos).
// Pedido explícito para GYM RM -- el pulso de apertura debe sentirse
// instantáneo, pero sin subir la frecuencia de sondeo del script. En vez de
// que el bridge pregunte "¿hay algo?" cada N segundos, la petición se queda
// abierta reintentando el reclamo cada LONG_POLL_STEP_MS hasta encontrar un
// comando o agotar wait_seconds. Mismo endpoint, mismo query de reclamo
// atómico -- Dreamers, que no manda este parámetro, sigue con el
// comportamiento anterior sin cambios.
const MAX_WAIT_SECONDS = 20;
const LONG_POLL_STEP_MS = 1500;

export async function claimPendingCommands(schoolId: string, commandTypes: string[]) {
  const { data: claimed, error } = await supabase
    .from('device_commands')
    .update({ claimed_at: new Date().toISOString() })
    .eq('school_id', schoolId)
    .in('command_type', commandTypes)
    .eq('status', 'pending')
    .is('claimed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id, device_id, direction, command_type, metadata');

  if (error) throw error;
  return claimed || [];
}

// Compartido entre el endpoint HTTP de siempre (long-poll, GET /door-commands
// -- lo sigue usando Dreamers) y el WS nuevo (bridgeWsServer.ts -- GYM RM
// desde 2026-09-21). Mismo mapeo, un solo lugar.
export async function claimAndMapCommands(schoolId: string, commandTypes: string[]) {
  const claimed = await claimPendingCommands(schoolId, commandTypes);
  if (claimed.length === 0) return [];

  const deviceIds = [...new Set(claimed.map((c: any) => c.device_id))];
  const { data: devices } = await supabase
    .from('turnstile_devices')
    .select('id, serial_number')
    .in('id', deviceIds);

  const deviceById = new Map((devices || []).map((d: any) => [d.id, d]));

  return claimed.map((c: any) => ({
    id: c.id,
    device_serial: deviceById.get(c.device_id)?.serial_number ?? null,
    direction: c.direction,
    command_type: c.command_type,
    metadata: c.metadata ?? {},
  }));
}

// Mismo chequeo de X-Bridge-Api-Key que usa el endpoint HTTP, pero contra un
// valor recibido en un mensaje WS en vez de un header -- usado por
// bridgeWsServer.ts en el mensaje `auth`.
export function apiKeyMatches(candidate: string): boolean {
  const key = process.env.BRIDGE_API_KEY;
  if (!key) return false;
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/door-commands', async (req: Request, res: Response) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const schoolId = req.query.school_id as string;
  if (!schoolId) return res.status(400).json({ error: 'school_id requerido' });

  const commandTypes = String(req.query.command_types || 'open_door')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number(req.query.wait_seconds) || 0));

  // Latido: cada sondeo exitoso del bridge (haya o no comandos) prueba que
  // sigue vivo y llegando al backend. alerted_at: null para que, si venia de
  // una caida ya avisada, el proximo chequeo del cron la vea sana de nuevo y
  // una caida futura pueda alertar otra vez. Best-effort -- un fallo acá no
  // debe tumbar el reclamo real de comandos. Se sella una sola vez al
  // entrar, no en cada reintento del long-poll -- el "sigue vivo" ya quedó
  // probado con esta conexión abierta.
  supabase.from('bridge_heartbeats').upsert(
    { school_id: schoolId, bridge_name: 'door-bridge', last_seen_at: new Date().toISOString(), alerted_at: null },
    { onConflict: 'school_id,bridge_name' },
  ).then(() => {}, () => {});

  try {
    const deadline = Date.now() + waitSeconds * 1000;
    let claimed = await claimPendingCommands(schoolId, commandTypes);
    while (claimed.length === 0 && Date.now() < deadline) {
      await sleep(Math.min(LONG_POLL_STEP_MS, deadline - Date.now()));
      claimed = await claimPendingCommands(schoolId, commandTypes);
    }

    if (claimed.length === 0) return res.json({ commands: [] });

    // Sin FK declarada entre device_commands.device_id y turnstile_devices
    // (device_id es un uuid suelto) — PostgREST no puede embeber el join, así
    // que se resuelve en dos pasos y se mergea acá.
    const deviceIds = [...new Set(claimed.map((c: any) => c.device_id))];
    const { data: devices } = await supabase
      .from('turnstile_devices')
      .select('id, serial_number')
      .in('id', deviceIds);

    const deviceById = new Map((devices || []).map((d: any) => [d.id, d]));

    const commands = claimed.map((c: any) => ({
      id: c.id,
      device_serial: deviceById.get(c.device_id)?.serial_number ?? null,
      direction: c.direction,
      command_type: c.command_type,
      // Solo relevante para set_group (pin/group) — open_door no lo usa.
      metadata: c.metadata ?? {},
      // NO se manda door_drive_time_seconds: el bridge dejo de usarlo (ver
      // scripts/gymrm-door-bridge/VALIDACION-2026-08-25.md, punto 6-bis del
      // 2026-08-26) -- ese campo trabaja en segundos enteros (CHECK 1-60) y
      // el torniquete de GYM RM necesita un pulso de decimas de segundo, una
      // granularidad que ese campo no puede expresar. El bridge trae su
      // propio valor fijo (PULSE_DECISECONDS).
    }));

    return res.json({ commands });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al reclamar comandos' });
  }
});

// ─── POST /bridge/door-commands/:id/ack ──────────────────────────────────────
// `school_id` es OPCIONAL a propósito: los scripts ya desplegados (Dreamers,
// GYM RM antes de migrar a WS) no lo mandan hoy y no hay forma de
// redesplegarlos desde acá. Si viene, se usa para acotar el UPDATE a esa
// escuela -- con la key global compartida (ver apiKeyOk arriba), cualquier
// bridge podía confirmar el comando de CUALQUIER escuela con solo adivinar
// o filtrar un id. Si no viene, se preserva el comportamiento de siempre.
router.post('/door-commands/:id/ack', async (req: Request, res: Response) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const { id } = req.params;
  const { success, error_message, school_id: schoolId } = req.body as {
    success?: boolean;
    error_message?: string;
    school_id?: string;
  };
  if (typeof success !== 'boolean') {
    return res.status(400).json({ error: 'success (boolean) requerido' });
  }

  try {
    let query = supabase
      .from('device_commands')
      .update({
        status: success ? 'executed' : 'failed',
        executed_at: new Date().toISOString(),
        error_message: success ? null : String(error_message || 'Fallo reportado por door_bridge local').slice(0, 500),
      })
      .eq('id', id);

    if (schoolId) {
      query = query.eq('school_id', schoolId);
    }

    const { error } = await query;

    if (error) throw error;
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al confirmar comando' });
  }
});

// ─── POST /bridge/device-users ───────────────────────────────────────────────
// «IDs del lector» (Control de acceso, F1): el bridge manda la lista de usuarios que tiene
// cargada UN lector (PIN, nombre, si tiene clave/huella/rostro). Reemplaza la foto de ese
// lector. Solo guarda banderas, nunca plantillas biométricas. La llave del bridge es global,
// así que el serial se valida CONTRA la escuela: no se puede escribir la lista de un lector
// que no es de ella.
router.post('/device-users', async (req: Request, res: Response) => {
  if (!apiKeyOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const { school_id: schoolId, device_serial: serial, users } = req.body as {
    school_id?: string; device_serial?: string; users?: unknown;
  };
  if (!schoolId || !serial) return res.status(400).json({ error: 'school_id y device_serial requeridos' });

  try {
    const { data: device, error: devErr } = await supabase
      .from('turnstile_devices')
      .select('id')
      .eq('school_id', schoolId)
      .eq('serial_number', serial)
      .maybeSingle();
    if (devErr) throw devErr;
    if (!device) return res.status(403).json({ error: 'Ese lector no pertenece a la escuela.', code: 'DEVICE_NOT_IN_SCHOOL' });

    const { users: limpios, descartados } = normalizeRosterUsers(users);
    if (limpios.length === 0) {
      // Una lista vacía NO borra la foto anterior: un fallo de lectura no debe vaciar la pantalla.
      return res.status(400).json({ error: 'Sin usuarios válidos: no se cambió nada.', code: 'EMPTY_ROSTER', descartados });
    }
    const r = await replaceDeviceRoster(schoolId, serial, limpios);
    return res.json({ success: true, ...r, descartados });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al guardar los usuarios del lector' });
  }
});

export default router;
