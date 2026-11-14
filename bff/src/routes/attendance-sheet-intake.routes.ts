/**
 * /api/v1/attendance-sheet-intake — bandeja «Planillas por revisar»
 * (asistencia en papel por foto; docs/specs/fotos-de-planillas-y-autorregistro.md F1 y
 * docs/specs/whatsapp-conversacion-v2-dynasty.md §3.8). Mismo patrón que enrollment-intake.routes.ts.
 *
 * Las filas las crea el bot de WhatsApp (whatsapp-asistencia-staff.service) o
 * `POST /upload` desde la app. NADA se guarda sin `POST /:id/confirmar`: revisión obligatoria.
 * Guardar reusa `guardarSesionAsistencia` (la lógica de POST /attendance/session: crédito del
 * plan, reservas, avisos, finalized=true en días pasados).
 *
 * Roles: owner/admin/super_admin/school_admin/school ven todo; `coach` solo lo suyo
 * (filas que él mandó) y solo de equipos asignados a él. Padres/atletas: 403.
 *
 * ───────────────────────── CONTRATO JSON (para el frontend) ─────────────────────────
 * Estados: 'por_revisar' | 'guardada' | 'descartada' | 'error'.
 *
 * GET /?status=por_revisar            (default por_revisar)
 *   → { items: Item[] }
 *   Item = {
 *     id, source: 'whatsapp'|'app', status, modo: 'foto'|'lista'|null,
 *     teamId: string|null, teamName: string|null,          // null = falta elegir el grupo
 *     sessionDate: 'YYYY-MM-DD'|null, createdAt, notas: string|null,
 *     submittedBy: { id: string|null, name: string|null },
 *     photoUrl: string|null,                               // URL firmada, 10 min
 *     equipos: Array<{ teamId, teamName,
 *        fechas: Array<{ fecha, presentes: number, sinMarca: number, dudosas: number }>,
 *        noEncontradas: number, ambiguas: number, duplicados: number }>,
 *     candidatos: Array<{ teamId, teamName, fraccion: number }>,   // para «¿de qué grupo es?»
 *     confianza: 'alta'|'media'|'baja'|null, motivo: string|null
 *   }
 *
 * GET /:id → { ...Item, extracted, matches, teamCandidates,
 *     rosters: Array<{ teamId, teamName, atletas: Array<{ id, nombre }> }> }
 *   · extracted  = transcripción cruda del OCR { groupHeader, monthHeader, columns[], rows[{n,name,marks,note,struck}] }
 *   · matches    = { modo:'foto', hoy, equipos: [{ team_id, team_name, fechas[], cruce:{
 *         filas[{nombreHoja, atletaId, atletaNombre, score, estado:'exacto'|'probable'|'ambiguo'|'no_encontrada'|'ignorada',
 *                sugerencia:{id,nombre,score}|null, marcasPorFecha:{[fecha]:'asistio'|'sin_marca'|'dudosa'}}],
 *         porFecha[{ fecha, presentes[], sinMarca[], dudosas[] }], noEncontradas[], ambiguas[], duplicados[], ignoradas[] }}] }
 *     o { modo:'lista', team_id, team_name, fecha, roster:[{n,id,kind,nombre}] }
 *   · «sin marca» NO es falta: solo los presentes se escriben.
 *
 * POST /:id/equipo    body { teamId: string }   → recalcula el cruce con el roster de ese equipo
 *   → { estado:'resumen', texto, botones, item }  (texto/botones son los del bot; la app puede ignorarlos)
 *
 * POST /:id/confirmar body { correcciones?: { teamId?: string,
 *                                              porFecha?: [{ teamId?, fecha: 'YYYY-MM-DD', presentes: string[] (ids de atleta) }] } }
 *   → 200 { estado:'guardada', texto, sesiones:[{ teamId, fecha, sessionId, presentes, ausentes }] }
 *   → 409 si ya estaba guardada/descartada · 422 { estado:'error', texto } si no se pudo guardar
 *     (p. ej. «la lista del 22-sep ya estaba cerrada»: hay que reabrirla desde Asistencia)
 *   `presentes` en correcciones = los ids que quedan marcados como presentes ESE día (reemplaza
 *   lo que el OCR dedujo); omitirlo guarda lo del cruce tal cual.
 *
 * POST /:id/descartar → { estado:'descartada' }
 *
 * POST /upload        body { imageBase64, mimeType: 'image/jpeg'|'image/png'|'image/webp'|'application/pdf' }  (≤ 4 MB)
 *   → 201 { id, estado:'resumen'|'pregunta_equipo', texto, botones, item }
 *   → 422 { error } si la foto no es una planilla de asistencia · 503 si el OCR no responde
 *     (la foto queda guardada y la fila en 'error') · 503 { reason:'no_disponible' } sin migración.
 *
 * Si la tabla `attendance_sheet_intake` aún no existe en la base: GET devuelve { items: [], disponible:false }.
 * ───────────────────────────────────────────────────────────────────────────────────
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import {
    BUCKET_PLANILLAS, cargarEquipos, cargarRosters, coachPuedeSubirPlanillas, confirmarPlanilla, equiposPermitidos, esTablaAusente,
    puedeSubirPlanilla, recibirPlanillaDeStaff, TEXTO_SIN_PERMISO_PLANILLA, type StaffIdentificado, type Correcciones,
} from '../services/whatsapp-asistencia-staff.service';

const router = Router();
const ROLES_ADMIN = ['owner', 'admin', 'super_admin', 'school_admin', 'school'] as const;
const SIGNED_URL_TTL_SEG = 600;
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
const MAX_BYTES = 4 * 1024 * 1024;

function staffDe(req: AuthenticatedRequest): StaffIdentificado {
    return {
        resultado: 'staff', profileId: req.user?.id, schoolId: req.schoolId,
        role: req.role === 'coach' ? 'coach' : req.role === 'owner' ? 'owner' : 'admin',
    };
}

async function aItem(row: any, nombres: Map<string, string>, equiposNombre: Map<string, string>) {
    let photoUrl: string | null = null;
    if (row.photo_path) {
        const { data } = await supabase.storage.from(BUCKET_PLANILLAS).createSignedUrl(row.photo_path, SIGNED_URL_TTL_SEG);
        photoUrl = data?.signedUrl ?? null;
    }
    const m = row.matches ?? null;
    const equipos = (m?.modo === 'foto' ? m.equipos : []).map((e: any) => ({
        teamId: e.team_id, teamName: e.team_name,
        fechas: (e.cruce?.porFecha ?? []).filter((d: any) => d.presentes?.length || d.dudosas?.length).map((d: any) => ({
            fecha: d.fecha, presentes: d.presentes.length, sinMarca: d.sinMarca.length, dudosas: d.dudosas.length,
        })),
        noEncontradas: e.cruce?.noEncontradas?.length ?? 0, ambiguas: e.cruce?.ambiguas?.length ?? 0, duplicados: e.cruce?.duplicados?.length ?? 0,
    }));
    const cand = row.team_candidates ?? null;
    return {
        id: row.id, source: row.source, status: row.status, modo: m?.modo ?? null,
        teamId: row.team_id ?? null, teamName: row.team_id ? (equiposNombre.get(row.team_id) ?? null) : null,
        sessionDate: row.session_date ?? null, createdAt: row.created_at, notas: row.notas ?? null,
        submittedBy: { id: row.submitted_by ?? null, name: row.submitted_by ? (nombres.get(row.submitted_by) ?? null) : null },
        photoUrl, equipos,
        candidatos: (cand?.candidatos ?? []).map((c: any) => ({ teamId: c.team_id, teamName: c.team_name, fraccion: c.fraccion })),
        confianza: cand?.confianza ?? null, motivo: cand?.motivo ?? null,
    };
}

async function nombresDe(rows: any[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.submitted_by).filter(Boolean))] as string[];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
    for (const p of (data ?? []) as any[]) out.set(p.id, p.full_name);
    return out;
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireRole(...ROLES_ADMIN, 'coach'), async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req;
    const status = typeof req.query.status === 'string' ? req.query.status : 'por_revisar';
    let q = supabase.from('attendance_sheet_intake').select('*').eq('school_id', schoolId).eq('status', status)
        .order('created_at', { ascending: true }).limit(200);
    if (req.role === 'coach') q = q.eq('submitted_by', req.user?.id);
    const { data: rows, error } = await q;
    if (error) {
        if (esTablaAusente(error)) return res.json({ items: [], disponible: false });
        req.log?.error({ err: error }, '[attendance-sheet-intake] error listando');
        return res.status(500).json({ error: 'No se pudo cargar la bandeja de planillas.' });
    }
    const equipos = await cargarEquipos(schoolId!);
    const eqn = new Map(equipos.map((e) => [e.id, e.name]));
    const nombres = await nombresDe(rows ?? []);
    const items = await Promise.all((rows ?? []).map((r) => aItem(r, nombres, eqn)));
    return res.json({ items });
});

// ── POST /upload ──────────────────────────────────────────────────────────────
const UploadSchema = z.object({ imageBase64: z.string().min(100), mimeType: z.enum(MIMES) });

router.post('/upload', requireAuth, requireRole(...ROLES_ADMIN, 'coach'), async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req;
    if (!schoolId || !req.user?.id) return res.status(400).json({ error: 'Falta la escuela activa.' });
    // El coach entra por requireRole, pero solo sube si su escuela lo activó
    // (`coach_can_upload_attendance_sheets`, igual que la hoja de matrícula). El BFF corre con service role: este es el gate.
    if (req.role === 'coach' && !puedeSubirPlanilla(req.role, await coachPuedeSubirPlanillas(schoolId))) {
        return res.status(403).json({ error: TEXTO_SIN_PERMISO_PLANILLA, reason: 'coach_sin_permiso' });
    }
    const parsed = UploadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Sube una foto (JPG, PNG o WEBP) o un PDF.', details: parsed.error.issues });
    const buffer = Buffer.from(parsed.data.imageBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'El archivo llegó vacío.' });
    if (buffer.length > MAX_BYTES) return res.status(413).json({ error: 'La foto pesa más de 4 MB. Tómala de nuevo o recórtala.' });

    const r = await recibirPlanillaDeStaff({
        integration: { id: null as any, school_id: schoolId }, waId: '', staff: staffDe(req),
        buffer, mime: parsed.data.mimeType, source: 'app',
    });
    if (r.estado === 'no_disponible') return res.status(503).json({ error: r.texto, reason: 'no_disponible' });
    if (r.estado === 'no_aplica') return res.status(422).json({ error: 'No reconocí la foto como una planilla de asistencia. Toma la hoja completa, de frente y con buena luz.' });
    if (r.estado === 'error') {
        const sinOcr = /No pude leer la planilla en este momento/.test(r.texto);
        return res.status(sinOcr ? 503 : 422).json({ error: r.texto });
    }
    const item = await itemPorId(r.intakeId!, schoolId);
    return res.status(201).json({ id: r.intakeId, estado: r.estado, texto: r.texto, botones: r.botones ?? [], item });
});

async function itemPorId(id: string, schoolId: string) {
    const { data: row } = await supabase.from('attendance_sheet_intake').select('*').eq('id', id).eq('school_id', schoolId).maybeSingle();
    if (!row) return null;
    const equipos = await cargarEquipos(schoolId);
    return aItem(row, await nombresDe([row]), new Map(equipos.map((e) => [e.id, e.name])));
}

/** Carga la fila y valida que quien llama pueda tocarla (misma escuela; coach solo lo suyo). */
async function filaAccesible(req: AuthenticatedRequest, id: string) {
  const { data: row, error } = await supabase.from('attendance_sheet_intake').select('*').eq('id', id).eq('school_id', req.schoolId).maybeSingle();
  if (error) return { error: esTablaAusente(error) ? 503 : 500, row: null };
  if (!row || (req.role === 'coach' && row.submitted_by !== req.user?.id)) return { error: 404, row: null };
  return { error: 0, row };
}

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, requireRole(...ROLES_ADMIN, 'coach'), async (req: AuthenticatedRequest, res: Response) => {
    const { error, row } = await filaAccesible(req, String(req.params.id));
    if (!row) return res.status(error || 404).json({ error: error === 503 ? 'La bandeja de planillas aún no está habilitada.' : 'Planilla no encontrada.' });
    const schoolId = req.schoolId!;
    const equipos = await cargarEquipos(schoolId);
    const permitidos = await equiposPermitidos(schoolId, staffDe(req), equipos);
    const item = await aItem(row, await nombresDe([row]), new Map(equipos.map((e) => [e.id, e.name])));
    // Rosters para editar la grilla: equipos del cruce + candidatos (acotados a los permitidos).
    const ids = new Set<string>([...(item.equipos ?? []).map((e: any) => e.teamId), ...item.candidatos.map((c: any) => c.teamId), ...(row.team_id ? [row.team_id] : [])]);
    const rosters = await cargarRosters(schoolId, permitidos.filter((e) => ids.has(e.id)));
    return res.json({
        ...item, extracted: row.extracted, matches: row.matches, teamCandidates: row.team_candidates,
        rosters: rosters.map((r) => ({ teamId: r.team_id, teamName: r.team_name, atletas: r.atletas.map((a) => ({ id: a.id, nombre: a.nombre })) })),
    });
});

// ── POST /:id/equipo ──────────────────────────────────────────────────────────
router.post('/:id/equipo', requireAuth, requireRole(...ROLES_ADMIN, 'coach'), async (req: AuthenticatedRequest, res: Response) => {
    const parsed = z.object({ teamId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Falta teamId.' });
    const { error, row } = await filaAccesible(req, String(req.params.id));
    if (!row) return res.status(error || 404).json({ error: 'Planilla no encontrada.' });
    const r = await confirmarPlanilla(row.id, { equipo: parsed.data.teamId }, { staff: staffDe(req) });
    if (r.estado === 'error') return res.status(422).json({ error: r.texto });
    return res.json({ estado: r.estado, texto: r.texto, botones: r.botones ?? [], item: await itemPorId(row.id, req.schoolId!) });
});

// ── POST /:id/confirmar ───────────────────────────────────────────────────────
const ConfirmarSchema = z.object({
    correcciones: z.object({
        teamId: z.string().uuid().optional(),
        porFecha: z.array(z.object({
            teamId: z.string().uuid().optional(),
            fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            presentes: z.array(z.string().uuid()).max(500),
        })).max(62).optional(),
    }).optional(),
});

router.post('/:id/confirmar', requireAuth, requireRole(...ROLES_ADMIN, 'coach'), async (req: AuthenticatedRequest, res: Response) => {
    const parsed = ConfirmarSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Correcciones inválidas.', details: parsed.error.issues });
    const { error, row } = await filaAccesible(req, String(req.params.id));
    if (!row) return res.status(error || 404).json({ error: 'Planilla no encontrada.' });
    if (row.status === 'guardada' || row.status === 'descartada') return res.status(409).json({ estado: row.status, error: `Esa planilla ya estaba ${row.status}.` });
    const r = await confirmarPlanilla(row.id, 'guardar', { staff: staffDe(req), correcciones: parsed.data.correcciones as Correcciones | undefined });
    if (r.estado !== 'guardada') return res.status(422).json({ estado: r.estado, texto: r.texto, error: r.texto });
    return res.json({ estado: r.estado, texto: r.texto, sesiones: r.sesiones ?? [] });
});

// ── POST /:id/descartar ───────────────────────────────────────────────────────
router.post('/:id/descartar', requireAuth, requireRole(...ROLES_ADMIN, 'coach'), async (req: AuthenticatedRequest, res: Response) => {
    const { error, row } = await filaAccesible(req, String(req.params.id));
    if (!row) return res.status(error || 404).json({ error: 'Planilla no encontrada.' });
    if (row.status === 'guardada') return res.status(409).json({ estado: row.status, error: 'Esa planilla ya estaba guardada.' });
    const r = await confirmarPlanilla(row.id, 'descartar', { staff: staffDe(req) });
    return res.json({ estado: r.estado, texto: r.texto });
});

export default router;
