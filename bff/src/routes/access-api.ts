import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, auditLog, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { invalidateDeviceCache, invalidateMappingCache, reprocessPinEventsForHourBank, getHourBankSettings, computeHourBankBilledMinutes, formatHourBankMinutes } from './access-adms';
import { getAccessBlockMechanism, buildBlockCommand, computeIsBlocked, athleteKey, BLOCK_COMMAND_TYPES } from '../utils/accessBlockMechanism';
import { confirmarSugeridas } from '../services/hour-bank-overage-auto.service';
import { normalizarEscalones } from '../services/hour-bank-balance-notices.shared';
import { wakeSchool } from '../services/bridgeWsHub';
import fs from 'fs';
import path from 'path';
import { dayNotAllowedBody, isDateAllowedForEnrollment } from '../utils/planDayRules';
import { FILTRO_SOLO_MENSUALIDAD } from '../services/payment-accounts';
import { getAccessRoster, isRosterEnabled, type RosterFilter } from '../services/accessRoster.service';

const router = Router();

// ─── /debug-logs — ELIMINADO (SEG-9, 2026-08-12) ─────────────────────────────
// Gemelos de los de `access-adms.ts`, montados acá como
// `GET /api/v1/access/debug-logs` y `POST /api/v1/access/debug-logs/clear`.
// Sin `requireAuth` ni `requireRole`, en un router donde TODAS las demás rutas
// sí los llevan — el descuido se ve al comparar con la línea siguiente.
//
// Servían `debug.log`: seriales de lector, IDs de usuario del dispositivo y
// horarios de entrada/salida. Datos de asistencia de personas identificables,
// legibles y borrables por cualquiera. Ver la nota larga en access-adms.ts.

// ─── GET /api/v1/access/events ───────────────────────────────────────────────
router.get('/events', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const limit  = parseInt(req.query.limit  as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const date   = req.query.date as string;

    let query = supabase
      .from('access_events')
      .select(`
        id, direction, access_granted, denial_reason,
        check_in_method, zk_user_id, occurred_at, user_id, unregistered_athlete_id, child_id,
        turnstile_devices!access_events_device_id_fkey(device_name, direction)
      `)
      .eq('school_id', schoolId)
      .order('occurred_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (date) {
      const startUTC = `${date}T05:00:00+00:00`;
      const endUTC   = new Date(new Date(startUTC).getTime() + 86400000).toISOString();
      query = query.gte('occurred_at', startUTC).lt('occurred_at', endUTC);
    }

    const { data: events, error } = await query;
    if (error) throw error;

    // IDs de perfiles registrados
    const userIds = [...new Set(
      (events || []).map((e: any) => e.user_id).filter(Boolean)
    )];

    // IDs de atletas no registrados
    const uaIds = [...new Set(
      (events || []).map((e: any) => e.unregistered_athlete_id).filter(Boolean)
    )];

    // IDs de alumnos (children)
    const childIds = [...new Set(
      (events || []).map((e: any) => e.child_id).filter(Boolean)
    )];

    // PINs de eventos "huérfanos" (sin user_id, unregistered_athlete_id ni
    // child_id guardados) que puedan tener un mapeo posterior — resuelve el
    // caso del caché/asignación tardía.
    const orphanPins = [...new Set(
      (events || [])
        .filter((e: any) => !e.user_id && !e.unregistered_athlete_id && !e.child_id && e.zk_user_id)
        .map((e: any) => e.zk_user_id)
    )];

    const profileMap: Record<string, string> = {};
    const uaMap: Record<string, string> = {};
    const childMap: Record<string, string> = {};

    if (userIds.length) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p.full_name; });
    }

    if (uaIds.length) {
      const { data: uas } = await supabase
        .from('unregistered_athletes')
        .select('id, full_name')
        .in('id', uaIds);
      (uas || []).forEach((ua: any) => { uaMap[ua.id] = ua.full_name; });
    }

    if (childIds.length) {
      const { data: kids } = await supabase
        .from('children')
        .select('id, full_name')
        .in('id', childIds);
      (kids || []).forEach((c: any) => { childMap[c.id] = c.full_name; });
    }

    // Resuelve PINs huérfanos contra el mapeo actual
    const pinNameMap: Record<number, string> = {};
    if (orphanPins.length) {
      const { data: mappings } = await supabase
        .from('zk_user_mappings')
        .select('zk_pin, user_id, unregistered_athlete_id, child_id')
        .eq('school_id', schoolId)
        .in('zk_pin', orphanPins);

      const mappedUserIds  = [...new Set((mappings || []).map((m: any) => m.user_id).filter(Boolean))];
      const mappedUaIds    = [...new Set((mappings || []).map((m: any) => m.unregistered_athlete_id).filter(Boolean))];
      const mappedChildIds = [...new Set((mappings || []).map((m: any) => m.child_id).filter(Boolean))];

      const extraProfileMap: Record<string, string> = {};
      if (mappedUserIds.length) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', mappedUserIds);
        (profiles || []).forEach((p: any) => { extraProfileMap[p.id] = p.full_name; });
      }
      const extraUaMap: Record<string, string> = {};
      if (mappedUaIds.length) {
        const { data: uas } = await supabase.from('unregistered_athletes').select('id, full_name').in('id', mappedUaIds);
        (uas || []).forEach((u: any) => { extraUaMap[u.id] = u.full_name; });
      }
      const extraChildMap: Record<string, string> = {};
      if (mappedChildIds.length) {
        const { data: kids } = await supabase.from('children').select('id, full_name').in('id', mappedChildIds);
        (kids || []).forEach((c: any) => { extraChildMap[c.id] = c.full_name; });
      }

      (mappings || []).forEach((m: any) => {
        const name = m.user_id
          ? extraProfileMap[m.user_id]
          : m.child_id
            ? extraChildMap[m.child_id]
            : extraUaMap[m.unregistered_athlete_id];
        if (name) pinNameMap[m.zk_pin] = name;
      });
    }

    // policy_warning (D11b, F-F) en una lectura aparte y tolerante: si la
    // migración 20261005214300 todavía no está aplicada, el listado sigue igual.
    const warningMap: Record<string, string> = {};
    if ((events || []).length) {
      const { data: warned, error: warnErr } = await supabase
        .from('access_events')
        .select('id, policy_warning')
        .in('id', (events || []).map((e: any) => e.id))
        .not('policy_warning', 'is', null);
      if (!warnErr) (warned || []).forEach((w: any) => { warningMap[w.id] = w.policy_warning; });
    }

    const enriched = (events || []).map((e: any) => ({
      ...e,
      policy_warning: warningMap[e.id] ?? null,
      user_name:
        (e.user_id && profileMap[e.user_id])
          ? profileMap[e.user_id]
          : (e.child_id && childMap[e.child_id])
            ? childMap[e.child_id]
            : (e.unregistered_athlete_id && uaMap[e.unregistered_athlete_id])
              ? uaMap[e.unregistered_athlete_id]
              : (pinNameMap[e.zk_user_id] ?? `ZK#${e.zk_user_id}`),
    }));

    return res.json({ events: enriched });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al obtener eventos de acceso' });
  }
});

// ─── GET /api/v1/access/stats ────────────────────────────────────────────────
router.get('/stats', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const today    = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const startUTC = `${today}T05:00:00+00:00`;
    const endUTC   = new Date(new Date(startUTC).getTime() + 86400000).toISOString();

    const { data: events, error } = await supabase
      .from('access_events')
      .select('direction, access_granted')
      .eq('school_id', schoolId)
      .gte('occurred_at', startUTC)
      .lt('occurred_at', endUTC);

    if (error) throw error;

    const granted  = (events || []).filter((e: any) =>  e.access_granted);
    const denied   = (events || []).filter((e: any) => !e.access_granted);
    const entries  = granted.filter((e: any) => e.direction === 'entry');
    const exits    = granted.filter((e: any) => e.direction === 'exit');

    return res.json({
      today,
      entries_count:     entries.length,
      exits_count:       exits.length,
      denied_count:      denied.length,
      current_occupancy: Math.max(0, entries.length - exits.length),
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al calcular estadísticas' });
  }
});

// ─── GET /api/v1/access/occupancy ────────────────────────────────────────────
// Quién está DENTRO ahora mismo y hace cuánto entró — para la tarjeta "Aforo"
// filtrada del panel. Por persona: el último evento concedido de hoy; si es
// 'entry', sigue adentro. Mismo patrón de resolución de nombre que /events.
router.get('/occupancy', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const today    = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const startUTC = `${today}T05:00:00+00:00`;
    const endUTC   = new Date(new Date(startUTC).getTime() + 86400000).toISOString();

    const { data: events, error } = await supabase
      .from('access_events')
      .select('direction, user_id, unregistered_athlete_id, child_id, zk_user_id, occurred_at')
      .eq('school_id', schoolId)
      .eq('access_granted', true)
      .gte('occurred_at', startUTC)
      .lt('occurred_at', endUTC)
      .order('occurred_at', { ascending: true });

    if (error) throw error;

    // Por identidad, se queda el último evento cronológico (el Map sobreescribe).
    const lastByIdentity = new Map<string, any>();
    for (const e of events || []) {
      const key = e.user_id
        ? `u:${e.user_id}`
        : e.child_id
          ? `c:${e.child_id}`
          : e.unregistered_athlete_id ? `a:${e.unregistered_athlete_id}` : `z:${e.zk_user_id}`;
      lastByIdentity.set(key, e);
    }

    const inside = [...lastByIdentity.values()].filter((e) => e.direction === 'entry');

    const userIds  = [...new Set(inside.map((e) => e.user_id).filter(Boolean))];
    const uaIds    = [...new Set(inside.map((e) => e.unregistered_athlete_id).filter(Boolean))];
    const childIds = [...new Set(inside.map((e) => e.child_id).filter(Boolean))];

    const profileMap: Record<string, string> = {};
    if (userIds.length) {
      const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', userIds);
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p.full_name; });
    }
    const uaMap: Record<string, string> = {};
    if (uaIds.length) {
      const { data: uas } = await supabase.from('unregistered_athletes').select('id, full_name').in('id', uaIds);
      (uas || []).forEach((u: any) => { uaMap[u.id] = u.full_name; });
    }
    const childMap: Record<string, string> = {};
    if (childIds.length) {
      const { data: kids } = await supabase.from('children').select('id, full_name').in('id', childIds);
      (kids || []).forEach((c: any) => { childMap[c.id] = c.full_name; });
    }

    const now = Date.now();
    const occupancy = inside
      .map((e) => ({
        name: e.user_id
          ? (profileMap[e.user_id] ?? 'Usuario')
          : e.child_id
            ? (childMap[e.child_id] ?? 'Alumno')
            : e.unregistered_athlete_id
              ? (uaMap[e.unregistered_athlete_id] ?? 'Atleta')
              : `ZK#${e.zk_user_id}`,
        entered_at: e.occurred_at,
        minutes_inside: Math.max(0, Math.round((now - new Date(e.occurred_at).getTime()) / 60000)),
      }))
      .sort((a, b) => b.minutes_inside - a.minutes_inside);

    return res.json({ occupancy });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al calcular el aforo' });
  }
});

// ─── POST /api/v1/access/manual-open ────────────────────────────────────────
router.post('/manual-open', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { direction } = req.body as { direction: 'entry' | 'exit' };

    if (!direction || !['entry', 'exit'].includes(direction)) {
      return res.status(400).json({ error: 'direction debe ser entry o exit' });
    }

    const { data: device } = await supabase
      .from('turnstile_devices')
      .select('id, ip_address, device_name')
      .eq('school_id', schoolId)
      .eq('direction', direction)
      .eq('is_active', true)
      .maybeSingle();

    if (!device) {
      return res.status(404).json({ error: `Sin dispositivo activo para ${direction}` });
    }

    if (!device.ip_address) {
      return res.status(422).json({
        error: 'IP pública no configurada. Contacta al administrador.',
        code: 'NO_IP_CONFIGURED',
      });
    }

    const { data: command } = await supabase
      .from('device_commands')
      .insert({
        school_id:    schoolId,
        device_id:    device.id,
        command_type: 'open_door',
        direction,
        status:       'pending',
        issued_by:    req.user.id,
        expires_at:   new Date(Date.now() + 30_000).toISOString(),
        metadata:     {},
      })
      .select('id')
      .single();

    // Si hay un bridge local conectado por WS (ej. GYM RM desde 2026-09-21,
    // ver bridgeWsHub.ts), avisarle que revise ahora en vez de esperar a que
    // vuelva a preguntar solo. No-op si no hay conexión (ej. Dreamers, que
    // sigue con el long-polling de siempre) -- wakeSchool() ya maneja eso.
    wakeSchool(schoolId);

    await supabase.from('access_events').insert({
      school_id:       schoolId,
      device_id:       device.id,
      user_id:         req.user.id,
      direction,
      access_granted:  true,
      check_in_method: 'manual',
      occurred_at:     new Date().toISOString(),
      raw_event:       { issued_by: req.user.id, command_id: command?.id },
    });

    return res.json({
      success:    true,
      command_id: command?.id,
      message:    `Comando enviado a ${device.device_name}`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al enviar comando de apertura' });
  }
});

// ─── POST /api/v1/access/enroll ──────────────────────────────────────────────
router.post('/enroll', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { user_id, pin, name, card } = req.body as {
      user_id: string; pin: number; name: string; card?: string;
    };

    if (!user_id || !pin || !name) {
      return res.status(400).json({ error: 'user_id, pin y name son requeridos' });
    }

    const { data: devices } = await supabase
      .from('turnstile_devices')
      .select('id, direction, device_name')
      .eq('school_id', schoolId)
      .eq('is_active', true);

    if (!devices || devices.length === 0) {
      return res.status(404).json({ error: 'Sin dispositivos activos' });
    }

    const commands = devices.map((device: any) => ({
      school_id:    schoolId,
      device_id:    device.id,
      command_type: 'enroll_user',
      direction:    device.direction,
      status:       'pending',
      issued_by:    req.user.id,
      expires_at:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      metadata:     { pin, name, card: card || null, user_id },
    }));

    const { error } = await supabase.from('device_commands').insert(commands);
    if (error) throw error;

    // Registrar el mapeo PIN→user para que validateAccess lo reconozca.
    await supabase.from('zk_user_mappings').upsert(
      { school_id: schoolId, zk_pin: pin, user_id, unregistered_athlete_id: null },
      { onConflict: 'school_id,zk_pin' },
    );

    invalidateMappingCache(pin);
    await reprocessPinEventsForHourBank(schoolId!, Number(pin));

    console.log(`[ENROLL] ${name} (PIN:${pin}) encolado en ${devices.length} dispositivo(s)`);

    return res.json({
      success: true,
      message: `Usuario encolado en ${devices.length} dispositivo(s). Se activará en el próximo polling.`,
      devices: devices.map((d: any) => d.device_name),
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al encolar enrolamiento' });
  }
});

// ─── POST /api/v1/access/revoke ──────────────────────────────────────────────
router.post('/revoke', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { pin } = req.body as { pin: number };

    if (!pin) return res.status(400).json({ error: 'pin es requerido' });

    const { data: devices } = await supabase
      .from('turnstile_devices')
      .select('id, device_name')
      .eq('school_id', schoolId)
      .eq('is_active', true);

    if (!devices || devices.length === 0) {
      return res.status(404).json({ error: 'Sin dispositivos activos' });
    }

    const commands = devices.map((device: any) => ({
      school_id:    schoolId,
      device_id:    device.id,
      command_type: 'delete_user',
      direction:    'entry',
      status:       'pending',
      issued_by:    req.user.id,
      expires_at:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      metadata:     { pin },
    }));

    await supabase.from('device_commands').insert(commands);

    return res.json({
      success: true,
      message: `Revocación encolada en ${devices.length} dispositivo(s).`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al encolar revocación' });
  }
});

// ─── GET /api/v1/access/members ──────────────────────────────────────────────
router.get('/members', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const q = (req.query.q as string || '').trim();

    // PINs ya asignados — se excluyen para evitar duplicidad
    const { data: mappings } = await supabase
      .from('zk_user_mappings')
      .select('user_id, unregistered_athlete_id, child_id')
      .eq('school_id', schoolId);
    const mappedUserIds  = new Set((mappings || []).map((m: any) => m.user_id).filter(Boolean));
    const mappedUaIds    = new Set((mappings || []).map((m: any) => m.unregistered_athlete_id).filter(Boolean));
    const mappedChildIds = new Set((mappings || []).map((m: any) => m.child_id).filter(Boolean));

    // Miembros con login
    const { data: members } = await supabase
      .from('school_members')
      .select('profile_id, role')
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .limit(500);
    const memberIds = [...new Set((members || []).map((m: any) => m.profile_id).filter(Boolean))]
      .filter((id: string) => !mappedUserIds.has(id));

    let registered: any[] = [];
    if (memberIds.length) {
      let pq = supabase.from('profiles').select('id, full_name').in('id', memberIds);
      if (q) pq = pq.ilike('full_name', `%${q}%`);
      const { data: profiles } = await pq.limit(50);
      const roleById: Record<string, string> = {};
      (members || []).forEach((m: any) => { roleById[m.profile_id] = m.role; });
      registered = (profiles || []).map((p: any) => ({
        user_id: p.id, full_name: p.full_name, role: roleById[p.id] ?? null, type: 'registered',
      }));
    }

    // Atletas sin login (la mayoría en tu caso)
    let uaq = supabase.from('unregistered_athletes').select('id, full_name, date_of_birth, created_at').eq('school_id', schoolId);
    if (mappedUaIds.size > 0) {
      uaq = uaq.not('id', 'in', `(${Array.from(mappedUaIds).join(',')})`);
    }
    if (q) uaq = uaq.ilike('full_name', `%${q}%`);
    const { data: uas } = await uaq.limit(50);
    const unregistered = (uas || [])
      .map((u: any) => ({ unregistered_athlete_id: u.id, full_name: u.full_name, role: null, type: 'unregistered', _dob: u.date_of_birth ?? null, _alta: u.created_at ?? null }));

    // Alumnos enrolados por el flujo normal de la escuela (sin login propio,
    // asociados a un parent_id) — hasta 2026-09-15 esta tabla nunca se
    // consultaba acá, así que ningún children podía vincularse a un PIN.
    let cq = supabase.from('children').select('id, full_name, date_of_birth, created_at').eq('school_id', schoolId).eq('is_active', true);
    if (mappedChildIds.size > 0) {
      cq = cq.not('id', 'in', `(${Array.from(mappedChildIds).join(',')})`);
    }
    if (q) cq = cq.ilike('full_name', `%${q}%`);
    const { data: kids } = await cq.limit(50);
    const children = (kids || [])
      .map((c: any) => ({ child_id: c.id, full_name: c.full_name, role: null, type: 'child', _dob: c.date_of_birth ?? null, _alta: c.created_at ?? null }));

    // Detalle para distinguir homónimos al asociar un PIN: plan, estado de cobro y fecha de
    // nacimiento. Dos lecturas de toda la escuela (inscripciones activas y mensualidades
    // vencidas), no una por persona.
    const [enrQ, payQ] = await Promise.all([
      supabase.from('enrollments')
        .select('child_id, user_id, unregistered_athlete_id, offering_plans(name)')
        .eq('school_id', schoolId).eq('status', 'active'),
      supabase.from('payments')
        .select('child_id, user_id, unregistered_athlete_id')
        .eq('school_id', schoolId).eq('status', 'overdue').or(FILTRO_SOLO_MENSUALIDAD),
    ]);
    const detailOk = !enrQ.error && !payQ.error;
    const enrolledKeys = new Set<string>();
    const planByKey = new Map<string, string>();
    ((enrQ.data ?? []) as any[]).forEach(e => {
      const k = athleteKey(e);
      if (!k) return;
      enrolledKeys.add(k);
      const plan = Array.isArray(e.offering_plans) ? e.offering_plans[0]?.name : e.offering_plans?.name;
      if (plan && !planByKey.has(k)) planByKey.set(k, plan);
    });
    const overdueKeys = new Set(((payQ.data ?? []) as any[]).map(p => athleteKey(p)).filter(Boolean) as string[]);
    const withDetail = (key: string, dob: string | null, alta: string | null) => ({
      plan: planByKey.get(key) ?? null,
      billing: !detailOk ? null : overdueKeys.has(key) ? 'mora' : enrolledKeys.has(key) ? 'al_dia' : 'sin_inscripcion',
      date_of_birth: dob,
      created_at: alta,
    });

    // Primero los deportistas (menores y sin cuenta): es a quienes casi siempre se asocia un PIN.
    const out = [
      ...children.map(({ _dob, _alta, ...c }) => ({ ...c, detail: withDetail(`c:${c.child_id}`, _dob, _alta) })),
      ...unregistered.map(({ _dob, _alta, ...u }) => ({ ...u, detail: withDetail(`a:${u.unregistered_athlete_id}`, _dob, _alta) })),
      ...registered.map((r: any) => ({ ...r, detail: withDetail(`u:${r.user_id}`, null, null) })),
    ];
    return res.json({ members: out });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al listar miembros' });
  }
});

// ─── GET /api/v1/access/device-users ─────────────────────────────────────────
// «IDs del lector» (F1): usuarios que reporta el lector, cruzados con los deportistas de la
// escuela, su estado de cobro y una sugerencia de a quién asociar cada PIN. Solo lectura.
// Habilitado por escuela con school_settings.access_roster_enabled.
router.get('/device-users', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    if (!schoolId) return res.status(400).json({ error: 'school_id requerido' });
    if (!(await isRosterEnabled(schoolId))) {
      return res.status(403).json({ error: 'Esta escuela no tiene activa la lista de IDs del lector.', code: 'ROSTER_NOT_ENABLED' });
    }
    const filter = (['all', 'sin', 'aso', 'mora'].includes(String(req.query.filter)) ? req.query.filter : 'all') as RosterFilter;
    const result = await getAccessRoster(schoolId, {
      filter,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      page: parseInt(String(req.query.page ?? '1'), 10) || 1,
      pageSize: parseInt(String(req.query.page_size ?? '25'), 10) || 25,
    });
    return res.json(result);
  } catch (err: any) {
    req.log?.error?.({ err: err?.message }, 'Error en GET /access/device-users');
    return res.status(500).json({ error: 'Error al listar los IDs del lector' });
  }
});

// ─── POST /api/v1/access/assign-user ─────────────────────────────────────────
// Mapea un PIN ya existente en el lector (ZK#<pin>) a un usuario registrado, a
// un atleta no registrado, o a un alumno (children). No envía comando al
// dispositivo (el PIN ya existe). chk_zk_mapping_subject_exclusivity en la
// base exige exactamente una de las tres columnas -- por eso las otras dos
// siempre van explícitas en null, nunca se dejan "como estaban" en el upsert.
router.post('/assign-user', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { zk_pin, user_id, unregistered_athlete_id, child_id } = req.body as {
      zk_pin: number; user_id?: string; unregistered_athlete_id?: string; child_id?: string;
    };

    if (!zk_pin || (!user_id && !unregistered_athlete_id && !child_id)) {
      return res.status(400).json({ error: 'zk_pin y (user_id, unregistered_athlete_id o child_id) son requeridos' });
    }

    // La persona debe ser de ESTA escuela: sin esto un admin podía atar un PIN a un menor o un
    // usuario de otra escuela. Se valida la identidad que de verdad se va a guardar
    // (user_id manda sobre unregistered_athlete_id y este sobre child_id).
    const subject = user_id
      ? supabase.from('school_members').select('id').eq('school_id', schoolId).eq('profile_id', user_id)
      : unregistered_athlete_id
        ? supabase.from('unregistered_athletes').select('id').eq('school_id', schoolId).eq('id', unregistered_athlete_id)
        : supabase.from('children').select('id').eq('school_id', schoolId).eq('id', child_id as string);
    const { data: subjectRows, error: subjectErr } = await subject.limit(1);
    if (subjectErr) throw subjectErr;
    if (!subjectRows?.length) {
      return res.status(403).json({ error: 'Esa persona no pertenece a esta escuela.', code: 'SUBJECT_NOT_IN_SCHOOL' });
    }

    const { error } = await supabase.from('zk_user_mappings').upsert(
      {
        school_id:               schoolId,
        zk_pin,
        user_id:                 user_id ?? null,
        unregistered_athlete_id: user_id ? null : (unregistered_athlete_id ?? null),
        child_id:                (user_id || unregistered_athlete_id) ? null : (child_id ?? null),
      },
      { onConflict: 'school_id,zk_pin' },
    );
    if (error) throw error;

    invalidateMappingCache(zk_pin);

    // Marcaciones de este PIN que llegaron antes de asociarlo (nunca lanza).
    const reproceso = await reprocessPinEventsForHourBank(schoolId!, Number(zk_pin));

    return res.json({ success: true, message: `PIN ${zk_pin} asignado.`, hour_bank_reprocessed: reproceso.reprocessed });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al asignar usuario al PIN' });
  }
});

// ─── GET /api/v1/access/devices ──────────────────────────────────────────────
router.get('/devices', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { data: devices, error } = await supabase
      .from('turnstile_devices')
      .select('id, serial_number, device_name, ip_address, ip_check_mode, direction, location, is_active, last_seen_at, brand, door_drive_time_seconds')
      .eq('school_id', schoolId)
      .order('direction');

    try {
      fs.appendFileSync(
        path.join(__dirname, '../../debug.log'),
        `${new Date().toISOString()} - /devices schoolId=${schoolId} role=${req.role} count=${devices?.length ?? 'null'} err=${error?.message ?? '-'}\n`,
      );
    } catch { /* no romper por el log */ }

    if (error) throw error;
    return res.json({ devices: devices || [] });
  } catch (err: any) {
    try {
      fs.appendFileSync(
        path.join(__dirname, '../../debug.log'),
        `${new Date().toISOString()} - /devices EXCEPTION: ${err?.message}\n`,
      );
    } catch { /* noop */ }
    return res.status(500).json({ error: 'Error al listar dispositivos' });
  }
});

// ─── POST /api/v1/access/devices — crear dispositivo ────────────────────────
router.post('/devices', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { serial_number, device_name, ip_address, ip_check_mode, direction, location, brand, door_drive_time_seconds } = req.body as {
      serial_number: string; device_name: string; ip_address?: string; ip_check_mode?: 'off' | 'warn' | 'enforce';
      direction: 'entry' | 'exit' | 'both'; location?: string; brand?: string;
      door_drive_time_seconds?: number;
    };

    if (!serial_number || !device_name || !direction) {
      return res.status(400).json({ error: 'serial_number, device_name y direction son requeridos' });
    }
    if (!['entry', 'exit', 'both'].includes(direction)) {
      return res.status(400).json({ error: 'direction debe ser entry, exit o both' });
    }
    if (ip_check_mode && !['off', 'warn', 'enforce'].includes(ip_check_mode)) {
      return res.status(400).json({ error: 'ip_check_mode debe ser off, warn o enforce' });
    }

    const { data: device, error } = await supabase
      .from('turnstile_devices')
      .insert({
        school_id:      schoolId,
        serial_number:  serial_number.trim(),
        device_name:    device_name.trim(),
        ip_address:     ip_address?.trim() || null,
        ip_check_mode:  ip_check_mode || 'off',
        direction,
        location:       location?.trim() || null,
        is_active:      true,
        brand:          brand?.trim() || 'Genérico',
        door_drive_time_seconds: door_drive_time_seconds ?? 5,
      })
      .select('id, serial_number, device_name, ip_address, ip_check_mode, direction, location, is_active, brand, door_drive_time_seconds')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ese número de serie ya está registrado' });
      }
      throw error;
    }

    // Invalida el cache al crear un nuevo dispositivo (por si acaso el serial ya estaba cacheado como null)
    invalidateDeviceCache(device.serial_number);

    if (door_drive_time_seconds) {
      await supabase.from('device_commands').insert({
        school_id: schoolId,
        device_id: device.id,
        command_type: 'set_drive_time',
        direction: device.direction === 'both' ? 'entry' : device.direction,
        status: 'pending',
        issued_by: req.user.id,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        metadata: { seconds: door_drive_time_seconds },
      });
    }

    return res.json({ success: true, device });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al crear dispositivo' });
  }
});

// ─── PATCH /api/v1/access/devices/:id — editar dispositivo ──────────────────
router.patch('/devices/:id', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { id } = req.params;
    const { serial_number, device_name, ip_address, ip_check_mode, direction, location, is_active, brand, door_drive_time_seconds } = req.body as {
      serial_number?: string; device_name?: string; ip_address?: string | null; ip_check_mode?: 'off' | 'warn' | 'enforce';
      direction?: 'entry' | 'exit' | 'both'; location?: string; is_active?: boolean; brand?: string;
      door_drive_time_seconds?: number;
    };

    if (direction && !['entry', 'exit', 'both'].includes(direction)) {
      return res.status(400).json({ error: 'direction debe ser entry, exit o both' });
    }
    if (ip_check_mode && !['off', 'warn', 'enforce'].includes(ip_check_mode)) {
      return res.status(400).json({ error: 'ip_check_mode debe ser off, warn o enforce' });
    }

    const updates: Record<string, unknown> = {};
    if (serial_number !== undefined) updates.serial_number = serial_number.trim();
    if (device_name   !== undefined) updates.device_name   = device_name.trim();
    if (ip_address    !== undefined) updates.ip_address     = ip_address?.trim() || null;
    if (ip_check_mode !== undefined) updates.ip_check_mode  = ip_check_mode;
    if (direction     !== undefined) updates.direction      = direction;
    if (location      !== undefined) updates.location       = location?.trim() || null;
    if (is_active     !== undefined) updates.is_active       = is_active;
    if (brand         !== undefined) updates.brand          = brand.trim();
    if (door_drive_time_seconds !== undefined) updates.door_drive_time_seconds = door_drive_time_seconds;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    // Primero obtenemos el dispositivo actual (serial anterior por si cambia, e
    // ip_address actual para el guardarraíl de 'enforce' de abajo).
    const { data: oldDevice } = await supabase
      .from('turnstile_devices')
      .select('serial_number, ip_address')
      .eq('id', id)
      .eq('school_id', schoolId)
      .maybeSingle();

    // Guardarraíl: no permitir 'enforce' si no va a quedar ip_address (evita
    // bloquear al propio device sin ninguna IP contra la que comparar).
    if (updates.ip_check_mode === 'enforce') {
      const resultingIp = updates.ip_address !== undefined ? updates.ip_address : oldDevice?.ip_address;
      if (!resultingIp) {
        return res.status(400).json({ error: 'No se puede activar enforce sin ip_address' });
      }
    }

    const { data: device, error } = await supabase
      .from('turnstile_devices')
      .update(updates)
      .eq('id', id)
      .eq('school_id', schoolId) // 🔒 evita editar dispositivos de otra escuela
      .select('id, serial_number, device_name, ip_address, ip_check_mode, direction, location, is_active, brand, door_drive_time_seconds')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ese número de serie ya está registrado' });
      }
      throw error;
    }
    if (!device) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    // Invalida el cache bajo el serial anterior (por si cambió) y el nuevo
    if (oldDevice?.serial_number && oldDevice.serial_number !== device.serial_number) {
      invalidateDeviceCache(oldDevice.serial_number);
    }
    invalidateDeviceCache(device.serial_number);

    if (door_drive_time_seconds !== undefined) {
      await supabase.from('device_commands').insert({
        school_id: schoolId,
        device_id: device.id,
        command_type: 'set_drive_time',
        direction: device.direction === 'both' ? 'entry' : device.direction,
        status: 'pending',
        issued_by: req.user.id,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        metadata: { seconds: door_drive_time_seconds },
      });
    }

    return res.json({ success: true, device });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al actualizar dispositivo' });
  }
});

// ─── POST /api/v1/access/set-access-group ───────────────────────────────────
// El nombre quedó del mecanismo original (Grupo 2) pero el contrato con el
// frontend (pin + group 1|2) no cambia — group:2 = bloquear, group:1 =
// restaurar. Lo que varía por escuela es el comando real que se encola
// (buildBlockCommand, bff/src/utils/accessBlockMechanism.ts): 'group' mueve
// el PIN de Grupo (torniquetes que sí soportan Zonas Horarias/Grupos, ej.
// GYM RM), 'disable' apaga/prende el bit de Privilege (Dreamers — su MB360
// no tiene Grupos, confirmado 2026-09-05).
router.post('/set-access-group', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { pin, group } = req.body as { pin: number; group: 1 | 2 };
    if (!pin || ![1, 2].includes(group)) {
      return res.status(400).json({ error: 'pin y group (1 o 2) son requeridos' });
    }
    const { data: devices } = await supabase
      .from('turnstile_devices').select('id, direction')
      .eq('school_id', schoolId).eq('is_active', true);
    if (!devices?.length) return res.status(404).json({ error: 'Sin dispositivos activos' });

    const mechanism = await getAccessBlockMechanism(schoolId);
    const { command_type, metadata } = buildBlockCommand(mechanism, pin, group === 2 ? 'block' : 'unblock');

    const commands = devices.map((d: any) => ({
      school_id: schoolId, device_id: d.id, command_type,
      direction: d.direction === 'both' ? 'entry' : d.direction,
      status: 'pending', issued_by: req.user.id,
      expires_at: new Date(Date.now() + 24*60*60*1000).toISOString(),
      metadata,
    }));
    await supabase.from('device_commands').insert(commands);
    // El puente de Dreamers ya no sondea: sin este aviso el bloqueo/restauración
    // esperaba hasta la próxima reconexión (la de las 3 am).
    wakeSchool(schoolId);
    return res.json({
      success: true,
      message: group === 2
        ? `PIN ${pin} bloqueado en ${devices.length} dispositivo(s).`
        : `PIN ${pin} restaurado en ${devices.length} dispositivo(s).`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al cambiar el acceso' });
  }
});

// ─── GET /api/v1/access/overdue ──────────────────────────────────────────────
// Lista atletas con pago vencido que tienen huella mapeada, para bloqueo/restauración manual.
router.get('/overdue', requireAuth, requireRole('owner', 'admin', 'school_admin'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;

    const { data: overduePayments, error } = await supabase
      .from('payments')
      .select('id, user_id, unregistered_athlete_id, child_id, due_date, amount')
      .eq('school_id', schoolId)
      .eq('status', 'overdue')
      // F0 (migración 20261010143132): solo la mensualidad vencida cuenta para
      // bloquear; mismo filtro que access-auto-block.job y access-adms.
      .or(FILTRO_SOLO_MENSUALIDAD);
    if (error) throw error;
    if (!overduePayments?.length) return res.json({ overdue: [] });

    const { data: mappings } = await supabase
      .from('zk_user_mappings')
      .select('zk_pin, user_id, unregistered_athlete_id, child_id')
      .eq('school_id', schoolId);

    const mapByKey: Record<string, number> = {};
    (mappings || []).forEach((m: any) => {
      const key = athleteKey(m);
      if (key) mapByKey[key] = m.zk_pin;
    });

    const userIds  = [...new Set(overduePayments.filter((p: any) => !p.child_id).map((p: any) => p.user_id).filter(Boolean))];
    const uaIds    = [...new Set(overduePayments.map((p: any) => p.unregistered_athlete_id).filter(Boolean))];
    const childIds = [...new Set(overduePayments.map((p: any) => p.child_id).filter(Boolean))];

    const childMap: Record<string, string> = {};
    if (childIds.length) {
      const { data: kids } = await supabase.from('children').select('id, full_name').in('id', childIds);
      (kids || []).forEach((k: any) => { childMap[k.id] = k.full_name; });
    }

    const profileMap: Record<string, string> = {};
    if (userIds.length) {
      const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', userIds);
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p.full_name; });
    }
    const uaMap: Record<string, string> = {};
    if (uaIds.length) {
      const { data: uas } = await supabase.from('unregistered_athletes').select('id, full_name').in('id', uaIds);
      (uas || []).forEach((u: any) => { uaMap[u.id] = u.full_name; });
    }

    // "Bloqueado" solo cuenta si TODOS los dispositivos activos de la escuela
    // coinciden en el último comando ejecutado — no basta con que uno solo
    // lo haya logrado (caso real: Edna, 2026-09-05, el lector de entrada
    // nunca ejecutó el bloqueo y el badge decía que sí igual). El tipo de
    // comando que cuenta depende del mecanismo de la escuela (Grupo vs
    // deshabilitar — ver bff/src/utils/accessBlockMechanism.ts).
    const mechanism = await getAccessBlockMechanism(schoolId);

    const { data: activeDevices } = await supabase
      .from('turnstile_devices')
      .select('id')
      .eq('school_id', schoolId)
      .eq('is_active', true);
    const activeDeviceIds = (activeDevices || []).map((d: any) => d.id as string);

    const { data: lastCmds } = await supabase
      .from('device_commands')
      .select('device_id, command_type, metadata, executed_at')
      .eq('school_id', schoolId)
      .in('command_type', BLOCK_COMMAND_TYPES)
      .eq('status', 'executed')
      .order('executed_at', { ascending: false });

    const isPinBlocked = computeIsBlocked(mechanism, lastCmds || [], activeDeviceIds);

    const overdue = overduePayments
      .map((p: any) => {
        const key = athleteKey(p);
        const pin = key ? mapByKey[key] : undefined;
        if (pin === undefined) return null;
        return {
          payment_id: p.id,
          name: p.child_id
            ? (childMap[p.child_id] ?? 'Alumno')
            : p.user_id ? (profileMap[p.user_id] ?? 'Usuario') : (uaMap[p.unregistered_athlete_id] ?? 'Atleta'),
          due_date: p.due_date,
          amount: p.amount,
          zk_pin: pin,
          blocked: isPinBlocked(pin),
        };
      })
      .filter(Boolean);

    return res.json({ overdue });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al listar vencidos' });
  }
});

// ─── GET /api/v1/access/hour-bank-balances ───────────────────────────────────
// F6: vista agregada para owner/coach — saldo de TODOS los atletas con plan de
// horas de la escuela, de un vistazo. Mismo patrón de resolución de nombre
// (profiles / unregistered_athletes) que ya usa este archivo en /events y
// /overdue-payments — child_id no se resuelve porque el ecosistema ADMS
// (zk_user_mappings, access_events) tampoco lo maneja, ver ese patrón arriba.
router.get('/hour-bank-balances', requireAuth, requireRole('owner', 'admin', 'school_admin', 'coach'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;

    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('id, user_id, unregistered_athlete_id, offering_plans!inner(name, included_minutes_per_period)')
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .not('offering_plans.included_minutes_per_period', 'is', null);

    if (!enrollments || enrollments.length === 0) return res.json({ balances: [] });

    const userIds = [...new Set(enrollments.map((e: any) => e.user_id).filter(Boolean))];
    const uaIds   = [...new Set(enrollments.map((e: any) => e.unregistered_athlete_id).filter(Boolean))];

    const profileMap: Record<string, string> = {};
    if (userIds.length) {
      const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', userIds);
      (profiles || []).forEach((p: any) => { profileMap[p.id] = p.full_name; });
    }
    const uaMap: Record<string, string> = {};
    if (uaIds.length) {
      const { data: uas } = await supabase.from('unregistered_athletes').select('id, full_name').in('id', uaIds);
      (uas || []).forEach((u: any) => { uaMap[u.id] = u.full_name; });
    }

    const balances = [];
    for (const e of enrollments as any[]) {
      const { data: periodId } = await supabase.rpc('get_or_open_hour_bank_period', { p_enrollment_id: e.id });
      if (!periodId) continue;

      const { data: period } = await supabase
        .from('hour_bank_periods')
        .select('period_start, period_end, included_minutes, reserved_minutes, consumed_minutes')
        .eq('id', periodId)
        .maybeSingle();
      if (!period) continue;

      balances.push({
        enrollment_id: e.id,
        athlete_name: e.user_id ? (profileMap[e.user_id] ?? 'Usuario') : (uaMap[e.unregistered_athlete_id] ?? 'Atleta'),
        plan_name: e.offering_plans?.name ?? 'Plan',
        period_start: period.period_start,
        period_end: period.period_end,
        included_minutes: period.included_minutes,
        reserved_minutes: period.reserved_minutes,
        consumed_minutes: period.consumed_minutes,
        available_minutes: period.included_minutes - period.reserved_minutes - period.consumed_minutes,
      });
    }

    return res.json({ balances });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al listar los saldos del banco de horas' });
  }
});

// ─── Banco de horas por torniquete (F5) — bandeja de revisión del owner ──────
// docs/specs/dreamers-banco-de-horas-torniquete.md, D-8. A propósito NO se usa
// requireRole('owner'): su PRIVILEGED_ROLES deja pasar también a admin/
// super_admin (ver authMiddleware.ts:47), y acá el negocio pidió "solo owner",
// sin excepción — por eso el chequeo de rol es manual en cada handler.

// ─── GET /api/v1/access/hour-bank-visits ─────────────────────────────────────
router.get('/hour-bank-visits', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede ver la bandeja de revisión del banco de horas' });
    }

    const status = (req.query.status as string) || 'pending_review';

    const { data: visits, error } = await supabase
      .from('hour_bank_visits')
      .select('id, enrollment_id, period_id, status, started_at, ended_at, billed_minutes, auto_closed, corrected_by, corrected_at, correction_reason')
      .eq('school_id', schoolId)
      .eq('status', status)
      .order('started_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: 'Error al listar visitas' });

    return res.json({ visits: visits ?? [] });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al listar visitas del banco de horas' });
  }
});

// ─── PATCH /api/v1/access/hour-bank-visits/:id/correct ───────────────────────
// El owner ajusta la hora real de salida de una visita pending_review. Recién
// acá se factura — mismo cómputo de gracia que closeHourBankVisit en
// access-adms.ts (F3), pero disparado a mano en vez de por el torniquete.
router.patch('/hour-bank-visits/:id/correct', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede corregir visitas del banco de horas' });
    }

    const { id } = req.params;
    const { ended_at, reason } = req.body as { ended_at?: string; reason?: string };
    if (!ended_at || Number.isNaN(new Date(ended_at).getTime())) {
      return res.status(400).json({ error: 'ended_at (ISO) es requerido' });
    }

    const { data: visit } = await supabase
      .from('hour_bank_visits')
      .select('id, period_id, status, started_at')
      .eq('id', id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!visit) return res.status(404).json({ error: 'Visita no encontrada' });
    if (visit.status !== 'pending_review') {
      return res.status(409).json({ error: `Solo se corrigen visitas pending_review (esta está en ${visit.status})` });
    }
    if (new Date(ended_at) < new Date(visit.started_at)) {
      return res.status(400).json({ error: 'ended_at no puede ser anterior a started_at' });
    }
    if (!visit.period_id) {
      return res.status(422).json({ error: 'Visita sin período asociado — no se puede facturar' });
    }

    // Ajusta el último segmento (el que el auto-cierre cortó con su cutoff) a
    // la hora real que da el owner.
    const { data: lastSeg } = await supabase
      .from('hour_bank_visit_segments')
      .select('id, entered_at')
      .eq('visit_id', id)
      .order('entered_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastSeg) return res.status(422).json({ error: 'Visita sin segmentos — dato inconsistente' });

    await supabase
      .from('hour_bank_visit_segments')
      .update({ exited_at: ended_at })
      .eq('id', lastSeg.id);

    const { data: segments } = await supabase
      .from('hour_bank_visit_segments')
      .select('entered_at, exited_at')
      .eq('visit_id', id);

    const settings = await getHourBankSettings(schoolId);
    const rawMinutes = (segments ?? []).reduce((sum: number, s: any) => {
      if (!s.exited_at) return sum;
      return sum + Math.round((new Date(s.exited_at).getTime() - new Date(s.entered_at).getTime()) / 60000);
    }, 0);
    const billedMinutes = await computeHourBankBilledMinutes(rawMinutes, settings);
    if (billedMinutes === null) {
      // La visita sigue pending_review (el segmento ya quedó ajustado, reintentar es idempotente).
      return res.status(500).json({ error: 'No se pudo calcular el cobro de la visita, intenta de nuevo' });
    }

    const { data: moveResult } = await supabase.rpc('move_hour_bank', {
      p_period_id: visit.period_id,
      p_reserved_delta: 0,
      p_consumed_delta: billedMinutes,
    });

    await supabase
      .from('hour_bank_visits')
      .update({
        status: 'corrected',
        ended_at,
        billed_minutes: billedMinutes,
        corrected_by: req.user.id,
        corrected_at: new Date().toISOString(),
        correction_reason: reason?.trim() || null,
      })
      .eq('id', id);

    // F-E: si el periodo ya tenía un cargo por horas de más SUGERIDO, se
    // recalcula en sitio con el consumo corregido (nunca toca uno confirmado).
    // Best-effort: la corrección ya quedó aplicada arriba.
    const { error: recomputeError } = await supabase.rpc('recompute_hour_bank_overage', { p_period_id: visit.period_id });
    if (recomputeError) console.error('[hour-bank] no se pudo recalcular el cargo por horas de más:', recomputeError.message);

    // D-10: mismo patrón de notificación que closeHourBankVisit (F3) y que
    // payment_overdue — solo avisa, sin bloqueo automático.
    const available = (moveResult as any)?.available_minutes;
    if (typeof available === 'number' && available < 0) {
      const { data: school } = await supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle();
      if (school?.owner_id) {
        await supabase.from('notifications').insert({
          user_id:  school.owner_id,
          school_id: schoolId,
          type:     'hour_bank_overage',
          title:    '⏱️ Banco de horas — saldo excedido',
          message:  `Corrección manual: ${formatHourBankMinutes(billedMinutes)} facturados, banco del período en ${formatHourBankMinutes(available)} (excedido).`,
          link:     '/school/access-control',
        });
      }
    }

    return res.json({ success: true, billed_minutes: billedMinutes, available_minutes: available });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al corregir la visita' });
  }
});

// ─── Banco de horas — cargo por horas de más (F-E) ───────────────────────────
// docs/specs/dreamers-reglas-completas-plan.md F-E / D8. El cron de las 03:00
// (jobs/hour-bank-overage.job.ts) deja filas 'suggested'; acá el owner las ve,
// las confirma (crea el cobro vía confirm_hour_bank_overage, FOR UPDATE) o las
// descarta. Mismo chequeo manual "solo owner" que D-8 (/hour-bank-visits/:id/correct):
// requireRole('owner') dejaría pasar a admin/super_admin.

const OVERAGE_STATUSES = ['suggested', 'confirmed', 'dismissed'] as const;

// ─── GET /api/v1/access/hour-bank-overage-settings ───────────────────────────
router.get('/hour-bank-overage-settings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede ver esta configuración' });
    }
    const { data } = await supabase
      .from('school_settings')
      .select('*')
      .eq('school_id', schoolId)
      .maybeSingle();
    const d = (data ?? {}) as Record<string, any>;
    return res.json({
      hours_plan_enabled: !!d.hours_plan_enabled,
      hour_bank_overage_charges_enabled: !!d.hour_bank_overage_charges_enabled,
      hours_billing_rounding: d.hours_billing_rounding ?? 'none',
      // Confirmación automática de excedentes (NULL = apagada) y avisos de saldo ('{}' = sin avisos).
      overage_auto_confirm_max_hours: d.hour_bank_overage_auto_confirm_max_hours == null ? null : Number(d.hour_bank_overage_auto_confirm_max_hours),
      overage_auto_confirm_max_amount: d.hour_bank_overage_auto_confirm_max_amount == null ? null : Number(d.hour_bank_overage_auto_confirm_max_amount),
      balance_notice_steps: normalizarEscalones(d.hour_bank_balance_notice_steps),
      balance_notice_email_enabled: d.hour_bank_balance_notice_email_enabled !== false,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al leer la configuración' });
  }
});

// ─── PATCH /api/v1/access/hour-bank-overage-settings ─────────────────────────
// Campos (todos opcionales, al menos uno): enabled, overage_auto_confirm_max_hours,
// overage_auto_confirm_max_amount (número > 0 o null = apagado), balance_notice_steps
// (enteros 0..100; [] = sin avisos) y balance_notice_email_enabled.
router.patch('/hour-bank-overage-settings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede cambiar esta configuración' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled debe ser true o false' });
      patch.hour_bank_overage_charges_enabled = body.enabled;
    }
    for (const [campo, columna, etiqueta] of [
      ['overage_auto_confirm_max_hours', 'hour_bank_overage_auto_confirm_max_hours', 'El tope de horas'],
      ['overage_auto_confirm_max_amount', 'hour_bank_overage_auto_confirm_max_amount', 'El tope de valor'],
    ] as const) {
      if (!(campo in body)) continue;
      const v = body[campo];
      if (v === null) { patch[columna] = null; continue; }
      const n = Number(v);
      if (typeof v === 'boolean' || v === '' || !Number.isFinite(n) || n <= 0 || n > 100000000) {
        return res.status(400).json({ error: `${etiqueta} debe ser un número mayor que 0, o null para apagarlo` });
      }
      patch[columna] = n;
    }
    if ('balance_notice_steps' in body) {
      const raw = body.balance_notice_steps;
      if (!Array.isArray(raw)) return res.status(400).json({ error: 'balance_notice_steps debe ser una lista de porcentajes' });
      const limpio = normalizarEscalones(raw);
      if (limpio.length !== new Set(raw.map((x) => Number(x))).size) {
        return res.status(400).json({ error: 'Cada escalón debe ser un entero entre 0 y 100' });
      }
      patch.hour_bank_balance_notice_steps = limpio;
    }
    if ('balance_notice_email_enabled' in body) {
      if (typeof body.balance_notice_email_enabled !== 'boolean') {
        return res.status(400).json({ error: 'balance_notice_email_enabled debe ser true o false' });
      }
      patch.hour_bank_balance_notice_email_enabled = body.balance_notice_email_enabled;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No hay nada que guardar' });
    }

    const { data: before } = await supabase
      .from('school_settings')
      .select('*')
      .eq('school_id', schoolId)
      .maybeSingle();
    if (!before) return res.status(404).json({ error: 'La escuela no tiene configuración' });

    const { error } = await supabase.from('school_settings').update(patch).eq('school_id', schoolId);
    if (error) return res.status(500).json({ error: 'No se pudo guardar la configuración' });

    const antes: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) antes[k] = (before as any)[k] ?? null;
    await auditLog(req, 'hour_bank_overage_settings_changed', 'school_settings', schoolId!, antes, patch);

    return res.json({ success: true, ...patch });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

// ─── GET /api/v1/access/hour-bank-overage-charges?status= ────────────────────
router.get('/hour-bank-overage-charges', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede ver los cargos por horas de más' });
    }

    const status = (req.query.status as string) || 'suggested';
    if (!(OVERAGE_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `status inválido (${OVERAGE_STATUSES.join(' | ')})` });
    }

    const { data: rows, error } = await supabase
      .from('hour_bank_overage_charges')
      .select('id, period_id, enrollment_id, included_minutes, consumed_minutes, overage_minutes, billable_hours, hourly_rate, amount, rounding, plan_price, status, payment_id, decided_at, dismiss_reason, created_at')
      .eq('school_id', schoolId)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: 'Error al listar los cargos' });
    if (!rows || rows.length === 0) return res.json({ charges: [] });

    const periodIds = [...new Set(rows.map((r: any) => r.period_id))];
    const enrollmentIds = [...new Set(rows.map((r: any) => r.enrollment_id))];

    const [{ data: periods }, { data: enrollments }] = await Promise.all([
      supabase.from('hour_bank_periods').select('id, period_start, period_end').in('id', periodIds),
      supabase.from('enrollments')
        .select('id, child_id, user_id, unregistered_athlete_id, offering_plans(name)')
        .in('id', enrollmentIds),
    ]);

    const childIds = [...new Set((enrollments ?? []).map((e: any) => e.child_id).filter(Boolean))];
    const userIds  = [...new Set((enrollments ?? []).map((e: any) => e.user_id).filter(Boolean))];
    const uaIds    = [...new Set((enrollments ?? []).map((e: any) => e.unregistered_athlete_id).filter(Boolean))];

    const empty = Promise.resolve({ data: [] as any[] });
    const [{ data: children }, { data: profiles }, { data: uas }] = await Promise.all([
      childIds.length ? supabase.from('children').select('id, full_name').in('id', childIds) : empty,
      userIds.length  ? supabase.from('profiles').select('id, full_name').in('id', userIds) : empty,
      uaIds.length    ? supabase.from('unregistered_athletes').select('id, full_name').in('id', uaIds) : empty,
    ]);

    const nameOf: Record<string, string> = {};
    for (const x of [...(children ?? []), ...(profiles ?? []), ...(uas ?? [])] as any[]) nameOf[x.id] = x.full_name;
    const periodMap: Record<string, any> = Object.fromEntries((periods ?? []).map((p: any) => [p.id, p]));
    const enrMap: Record<string, any> = Object.fromEntries((enrollments ?? []).map((e: any) => [e.id, e]));

    const charges = rows.map((r: any) => {
      const e = enrMap[r.enrollment_id];
      const athleteId = e?.child_id ?? e?.user_id ?? e?.unregistered_athlete_id;
      return {
        ...r,
        athlete_name: (athleteId && nameOf[athleteId]) || 'Atleta',
        plan_name: e?.offering_plans?.name ?? null,
        period_start: periodMap[r.period_id]?.period_start ?? null,
        period_end: periodMap[r.period_id]?.period_end ?? null,
      };
    });

    return res.json({ charges });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al listar los cargos por horas de más' });
  }
});

// ─── POST /api/v1/access/hour-bank-overage-charges/confirm-all ───────────────
// «Cobrar todos»: confirma de una vez las sugeridas elegibles de la escuela. Se omiten (quedan
// `suggested` para decidir a mano) las inscripciones no activas y lo del dueño. Idempotente.
router.post('/hour-bank-overage-charges/confirm-all', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede confirmar cargos por horas de más' });
    }
    const { data: esc } = await supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle();
    const r = await confirmarSugeridas({
      schoolId: schoolId!, actorId: req.user.id, ownerId: ((esc as any)?.owner_id as string | null) ?? null,
      origen: 'manual', log: req.log as any,
    });
    return res.json({ success: true, confirmed: r.confirmados, skipped: r.omitidos, errors: r.errores, payment_ids: r.pagos });
  } catch (err: any) {
    req.log?.error({ err: err?.message || err }, 'Error en «Cobrar todos» de excedentes');
    return res.status(500).json({ error: 'Error al confirmar los cargos' });
  }
});

// ─── POST /api/v1/access/hour-bank-overage-charges/:id/confirm ───────────────
router.post('/hour-bank-overage-charges/:id/confirm', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede confirmar cargos por horas de más' });
    }
    const id = String(req.params.id);

    // Aislamiento por escuela antes de la RPC (la RPC corre como service_role).
    const { data: row } = await supabase
      .from('hour_bank_overage_charges')
      .select('id, status, amount, period_id')
      .eq('id', id)
      .eq('school_id', schoolId)
      .maybeSingle();
    if (!row) return res.status(404).json({ error: 'Cargo no encontrado' });

    const { data, error } = await supabase.rpc('confirm_hour_bank_overage', { p_id: id, p_actor: req.user.id });
    if (error) {
      req.log?.error({ err: error.message }, 'Error confirmando cargo por horas de más');
      return res.status(500).json({ error: 'No se pudo crear el cobro' });
    }
    const result = (data ?? {}) as { payment_id?: string; error?: string; status?: string };
    if (result.error === 'not_suggested') {
      return res.status(409).json({
        error: `Este cargo ya fue ${result.status === 'confirmed' ? 'confirmado' : 'descartado'}`,
        status: result.status,
      });
    }
    if (result.error) return res.status(422).json({ error: result.error });

    await auditLog(req, 'hour_bank_overage_confirmed', 'hour_bank_overage_charges', id,
      { status: 'suggested' },
      { status: 'confirmed', payment_id: result.payment_id, amount: (row as any).amount, period_id: (row as any).period_id });

    return res.json({ success: true, payment_id: result.payment_id });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al confirmar el cargo' });
  }
});

// ─── POST /api/v1/access/hour-bank-overage-charges/:id/dismiss ───────────────
router.post('/hour-bank-overage-charges/:id/dismiss', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId, role } = req;
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Solo el owner de la escuela puede descartar cargos por horas de más' });
    }
    const id = String(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';

    // Guardado por status: si otra pestaña ya confirmó, no se pisa.
    const now = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from('hour_bank_overage_charges')
      .update({
        status: 'dismissed',
        dismiss_reason: reason || null,
        decided_by: req.user.id,
        decided_at: now,
        updated_at: now,
      })
      .eq('id', id)
      .eq('school_id', schoolId)
      .eq('status', 'suggested')
      .select('id, amount, period_id');
    if (error) return res.status(500).json({ error: 'No se pudo descartar el cargo' });
    if (!updated || updated.length === 0) {
      return res.status(409).json({ error: 'El cargo no existe o ya no está pendiente' });
    }

    await auditLog(req, 'hour_bank_overage_dismissed', 'hour_bank_overage_charges', id,
      { status: 'suggested' },
      { status: 'dismissed', reason: reason || null, amount: (updated[0] as any).amount, period_id: (updated[0] as any).period_id });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al descartar el cargo' });
  }
});

// ─── Banco de horas — reservas (F4) ──────────────────────────────────────────
// docs/specs/dreamers-banco-de-horas-torniquete.md, D-11: reserva flexible
// ("hoy voy"), sin franja horaria — tabla propia hour_bank_reservations, no
// session_bookings. Autorización: staff de la escuela, o el dueño de la
// inscripción (el atleta adulto o el padre del menor).

async function canManageHourBankEnrollment(
  req: AuthenticatedRequest,
  enrollment: { user_id: string | null; child_id: string | null }
): Promise<boolean> {
  if (['owner', 'admin', 'school_admin', 'coach'].includes(req.role)) return true;
  if (enrollment.user_id && enrollment.user_id === req.user.id) return true;
  if (enrollment.child_id) {
    const { data } = await supabase
      .from('children')
      .select('id')
      .eq('id', enrollment.child_id)
      .eq('parent_id', req.user.id)
      .maybeSingle();
    if (data) return true;
  }
  return false;
}

// ─── GET /api/v1/access/hour-bank-balance/:enrollmentId ──────────────────────
router.get('/hour-bank-balance/:enrollmentId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { enrollmentId } = req.params;

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('id, user_id, child_id, school_id')
      .eq('id', enrollmentId)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!enrollment) return res.status(404).json({ error: 'Inscripción no encontrada' });
    if (!(await canManageHourBankEnrollment(req, enrollment))) {
      return res.status(403).json({ error: 'Sin permiso para ver el saldo de esta inscripción' });
    }

    const { data: periodId } = await supabase.rpc('get_or_open_hour_bank_period', { p_enrollment_id: enrollmentId });
    if (!periodId) {
      return res.json({ has_hours_plan: false });
    }

    const { data: period } = await supabase
      .from('hour_bank_periods')
      .select('id, period_start, period_end, included_minutes, reserved_minutes, consumed_minutes')
      .eq('id', periodId)
      .maybeSingle();

    if (!period) return res.status(500).json({ error: 'Error al leer el período' });

    return res.json({
      has_hours_plan: true,
      period_id: period.id,
      period_start: period.period_start,
      period_end: period.period_end,
      included_minutes: period.included_minutes,
      reserved_minutes: period.reserved_minutes,
      consumed_minutes: period.consumed_minutes,
      available_minutes: period.included_minutes - period.reserved_minutes - period.consumed_minutes,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al leer el saldo del banco de horas' });
  }
});

// ─── GET /api/v1/access/hour-bank-periods/:enrollmentId ──────────────────────
// Histórico de períodos (meses anteriores) de UNA inscripción — para la
// pregunta "¿cuánto gastó cada mes?" desde el perfil del estudiante. El
// período actual también sale acá (basta con no filtrar por fecha), así que
// esta ruta reemplaza a /hour-bank-balance para quien ya está viendo el
// perfil completo — /hour-bank-balance se queda para el caso rápido (solo el
// saldo de hoy, como en HourBankBalanceCard).
router.get('/hour-bank-periods/:enrollmentId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { enrollmentId } = req.params;

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('id, user_id, child_id, school_id')
      .eq('id', enrollmentId)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!enrollment) return res.status(404).json({ error: 'Inscripción no encontrada' });
    if (!(await canManageHourBankEnrollment(req, enrollment))) {
      return res.status(403).json({ error: 'Sin permiso para ver el histórico de esta inscripción' });
    }

    // Asegura que el período de hoy exista (mismo efecto que abrirlo desde el
    // saldo) antes de listar — así el mes actual no falta en el historial la
    // primera vez que alguien lo consulta.
    await supabase.rpc('get_or_open_hour_bank_period', { p_enrollment_id: enrollmentId });

    const { data: periods, error } = await supabase
      .from('hour_bank_periods')
      .select('id, period_start, period_end, included_minutes, reserved_minutes, consumed_minutes')
      .eq('enrollment_id', enrollmentId)
      .order('period_start', { ascending: false });

    if (error) return res.status(500).json({ error: 'Error al leer el histórico' });

    return res.json({
      periods: (periods || []).map((p) => ({
        ...p,
        available_minutes: p.included_minutes - p.reserved_minutes - p.consumed_minutes,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al leer el histórico del banco de horas' });
  }
});

// ─── GET /api/v1/access/student-report/:enrollmentId ─────────────────────────
// Reporte de ingresos/salidas de UN estudiante — log crudo del torniquete y,
// si la inscripción tiene banco de horas, sus visitas y reservas del rango.
// Sirve para CUALQUIER inscripción (por sesiones o por horas), no solo Dreamers
// — "validar ingresos/salidas" es auditoría general de acceso.
router.get('/student-report/:enrollmentId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { enrollmentId } = req.params;

    const todayBogota = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const to   = (req.query.to as string)   || todayBogota;
    const from = (req.query.from as string) || new Date(new Date(to).getTime() - 29 * 86400000).toISOString().slice(0, 10);

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('id, user_id, child_id, unregistered_athlete_id, school_id')
      .eq('id', enrollmentId)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!enrollment) return res.status(404).json({ error: 'Inscripción no encontrada' });
    if (!(await canManageHourBankEnrollment(req, enrollment))) {
      return res.status(403).json({ error: 'Sin permiso para ver el reporte de esta inscripción' });
    }

    // Nombre — mismo patrón multi-fuente que el resto del archivo, + children
    // (que acá sí hace falta: es la única identidad que puede llegar por esta ruta).
    let athleteName = 'Atleta';
    if (enrollment.user_id) {
      const { data: p } = await supabase.from('profiles').select('full_name').eq('id', enrollment.user_id).maybeSingle();
      athleteName = p?.full_name ?? athleteName;
    } else if (enrollment.unregistered_athlete_id) {
      const { data: ua } = await supabase.from('unregistered_athletes').select('full_name').eq('id', enrollment.unregistered_athlete_id).maybeSingle();
      athleteName = ua?.full_name ?? athleteName;
    } else if (enrollment.child_id) {
      const { data: c } = await supabase.from('children').select('full_name').eq('id', enrollment.child_id).maybeSingle();
      athleteName = c?.full_name ?? athleteName;
    }

    const startUTC = `${from}T05:00:00+00:00`;
    const endUTC   = new Date(new Date(`${to}T05:00:00+00:00`).getTime() + 86400000).toISOString();

    // Log crudo del torniquete. child_id NO participa del circuito ADMS
    // (zk_user_mappings/access_events no tienen esa columna) — se avisa en
    // `no_turnstile_data` en vez de devolver una lista vacía sin explicación.
    let events: any[] = [];
    const noTurnstileData = !enrollment.user_id && !enrollment.unregistered_athlete_id;
    if (!noTurnstileData) {
      let q = supabase
        .from('access_events')
        .select('direction, access_granted, denial_reason, check_in_method, occurred_at')
        .eq('school_id', schoolId)
        .gte('occurred_at', startUTC)
        .lt('occurred_at', endUTC)
        .order('occurred_at', { ascending: false });
      q = enrollment.user_id
        ? q.eq('user_id', enrollment.user_id)
        : q.eq('unregistered_athlete_id', enrollment.unregistered_athlete_id);
      const { data } = await q;
      events = data || [];
    }

    // Banco de horas, si la inscripción tiene plan de horas.
    let hourBank: any = { has_hours_plan: false };
    const { data: periodId } = await supabase.rpc('get_or_open_hour_bank_period', { p_enrollment_id: enrollmentId });
    if (periodId) {
      const { data: visits } = await supabase
        .from('hour_bank_visits')
        .select('id, status, started_at, ended_at, billed_minutes, auto_closed')
        .eq('enrollment_id', enrollmentId)
        .gte('started_at', startUTC)
        .lt('started_at', endUTC)
        .order('started_at', { ascending: false });

      const { data: reservations } = await supabase
        .from('hour_bank_reservations')
        .select('id, reservation_date, minutes, status')
        .eq('enrollment_id', enrollmentId)
        .gte('reservation_date', from)
        .lte('reservation_date', to)
        .order('reservation_date', { ascending: false });

      hourBank = { has_hours_plan: true, visits: visits || [], reservations: reservations || [] };
    }

    return res.json({
      enrollment_id: enrollmentId,
      athlete_name: athleteName,
      range: { from, to },
      no_turnstile_data: noTurnstileData,
      events,
      hour_bank: hourBank,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al generar el reporte del estudiante' });
  }
});

// ─── POST /api/v1/access/hour-bank-reservations ──────────────────────────────
router.post('/hour-bank-reservations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { enrollment_id, reservation_date } = req.body as { enrollment_id?: string; reservation_date?: string };

    if (!enrollment_id || !reservation_date || !/^\d{4}-\d{2}-\d{2}$/.test(reservation_date)) {
      return res.status(400).json({ error: 'enrollment_id y reservation_date (YYYY-MM-DD) son requeridos' });
    }

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('id, user_id, child_id, school_id, status')
      .eq('id', enrollment_id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!enrollment) return res.status(404).json({ error: 'Inscripción no encontrada' });
    if (enrollment.status !== 'active') return res.status(400).json({ error: 'La inscripción no está activa' });
    if (!(await canManageHourBankEnrollment(req, enrollment))) {
      return res.status(403).json({ error: 'Sin permiso para reservar sobre esta inscripción' });
    }

    // Días permitidos del plan (D9, utils/planDayRules.ts) — 422 antes del RPC.
    {
      const dayRule = await isDateAllowedForEnrollment(enrollment_id, reservation_date);
      if (!dayRule.allowed) return res.status(422).json(dayNotAllowedBody(dayRule.allowedDays!));
    }

    const { data: result, error } = await supabase.rpc('reserve_hour_bank', {
      p_enrollment_id: enrollment_id,
      p_reservation_date: reservation_date,
      p_created_by: req.user.id,
    });

    if (error) return res.status(500).json({ error: 'Error al reservar' });

    const r = result as any;
    if (!r?.reserved) {
      // D-2: el sistema bloquea la reserva si no alcanza el saldo — el 422
      // lleva available_minutes para que el frontend muestre el saldo real
      // (D-9-bis) en vez de un mensaje genérico.
      return res.status(422).json(r);
    }

    return res.status(201).json(r);
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al reservar en el banco de horas' });
  }
});

// ─── POST /api/v1/access/hour-bank-reservations/:id/cancel ───────────────────
router.post('/hour-bank-reservations/:id/cancel', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { schoolId } = req;
    const { id } = req.params;

    const { data: reservation } = await supabase
      .from('hour_bank_reservations')
      .select('id, school_id, enrollment_id')
      .eq('id', id)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (!reservation) return res.status(404).json({ error: 'Reserva no encontrada' });

    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('id, user_id, child_id')
      .eq('id', reservation.enrollment_id)
      .maybeSingle();

    if (!enrollment || !(await canManageHourBankEnrollment(req, enrollment))) {
      return res.status(403).json({ error: 'Sin permiso para cancelar esta reserva' });
    }

    const { data: result, error } = await supabase.rpc('cancel_hour_bank_reservation', { p_reservation_id: id });
    if (error) return res.status(500).json({ error: 'Error al cancelar' });

    const r = result as any;
    if (!r?.cancelled) return res.status(409).json(r);

    return res.json(r);
  } catch (err: any) {
    return res.status(500).json({ error: 'Error al cancelar la reserva' });
  }
});

export default router;
