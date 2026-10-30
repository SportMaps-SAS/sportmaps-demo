/**
 * whatsapp-cortesias.routes — «Clases de cortesía» de la escuela: dónde quedó
 * agendado cada prospecto (bot de WhatsApp o formulario web) y si vino.
 *
 *   GET   /api/v1/whatsapp/:schoolId/cortesias?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *   PATCH /api/v1/whatsapp/:schoolId/cortesias/:leadId/asistencia   { asistencia: 'asistio'|'no_vino'|null }
 *   POST  /api/v1/whatsapp/:schoolId/cortesias/sincronizar-franjas  { teamId? }   (staff: ver abajo)
 *
 * Autorización: administración REAL de esa escuela (owner, admin,
 * school_admin activos, o el dueño en schools.owner_id; platform_admins pasa).
 * Mismo criterio que whatsapp-admin.routes; se replica porque ese archivo lo
 * edita otro frente. Coaches, padres y atletas: 403. Todo filtra por school_id.
 * La sincronización de franjas la puede pedir además el STAFF de la escuela.
 */

import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { listarCortesias, marcarAsistencia, type Asistencia } from '../services/cortesia-reservas.service';
import { esStaffDeEscuela, type ClienteAlcance } from './athlete/biomechAlcance';

const router = Router();

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function administraEstaEscuela(userId: string, schoolId: string): Promise<boolean> {
    const [plataforma, escuela, miembro] = await Promise.all([
        supabase.from('platform_admins').select('profile_id')
            .eq('profile_id', userId).eq('is_active', true).limit(1),
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('role, status')
            .eq('school_id', schoolId).eq('profile_id', userId).maybeSingle(),
    ]);
    if (((plataforma as any).data ?? []).length > 0) return true;
    if ((escuela as any).data?.owner_id === userId) return true;
    const m = (miembro as any).data;
    return m?.status === 'active' && ['owner', 'admin', 'school_admin'].includes(String(m?.role));
}

router.get('/:schoolId/cortesias', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'school_id inválido' });
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });

    const desde = typeof req.query.desde === 'string' && FECHA.test(req.query.desde) ? req.query.desde : undefined;
    const hasta = typeof req.query.hasta === 'string' && FECHA.test(req.query.hasta) ? req.query.hasta : undefined;
    try {
        return res.json(await listarCortesias(schoolId, { desde, hasta }));
    } catch (e: any) {
        console.error('[cortesias] listar falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudieron cargar las clases de cortesía' });
    }
});

router.patch('/:schoolId/cortesias/:leadId/asistencia', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, leadId } = req.params as { schoolId: string; leadId: string };
    if (!UUID.test(schoolId) || !UUID.test(leadId)) return res.status(400).json({ error: 'id inválido' });
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });

    const valor = (req.body ?? {}).asistencia;
    if (valor !== null && valor !== 'asistio' && valor !== 'no_vino') {
        return res.status(400).json({ error: "asistencia debe ser 'asistio', 'no_vino' o null" });
    }
    try {
        const r = await marcarAsistencia(schoolId, leadId, valor as Asistencia | null, req.user.id);
        if (r === 'no_encontrado') return res.status(404).json({ error: 'No existe esa reserva en esta escuela' });
        if (r === 'sin_reserva') return res.status(409).json({ error: 'Ese prospecto no tiene una clase agendada' });
        return res.json({ ok: true, asistencia: valor });
    } catch (e: any) {
        console.error('[cortesias] asistencia falló', { schoolId, leadId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo guardar la asistencia' });
    }
});

/**
 * POST /api/v1/whatsapp/:schoolId/cortesias/sincronizar-franjas   { teamId?: uuid }  (o team_id)
 *
 * Lo llama «Mi semana» del entrenador (fire-and-forget) después de cancelar,
 * mover o agregar un entreno (plan B2/B3 §3, T7). Dos cosas, en este orden:
 *   1. A quien tenía una clase de prueba en una sesión cancelada o movida se le
 *      escribe «clase reprogramada» con el botón para elegir otro horario (sin
 *      volver a cobrar). Idempotente por lead y franja.
 *   2. Las franjas del generador se ajustan a la semana del profe — solo si la
 *      escuela las genera desde los entrenamientos (`courtesy_from_training`).
 *
 * Autorización: STAFF de esa escuela (el coach que ajusta su semana, además de
 * la administración). Padres y atletas: 403.
 */
router.post('/:schoolId/cortesias/sincronizar-franjas', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'school_id inválido' });
    // «Mi semana» manda `{ teamId }`; también vale `{ team_id }`.
    const teamId = (req.body ?? {}).teamId ?? (req.body ?? {}).team_id ?? null;
    if (teamId !== null && (typeof teamId !== 'string' || !UUID.test(teamId))) {
        return res.status(400).json({ error: 'team_id inválido' });
    }
    try {
        const permitido = (await administraEstaEscuela(req.user.id, schoolId))
            || (await esStaffDeEscuela(supabase as unknown as ClienteAlcance, req.user.id, schoolId));
        if (!permitido) return res.status(403).json({ error: 'forbidden' });
        if (teamId) {
            const { data: equipo } = await supabase.from('teams').select('id').eq('id', teamId).eq('school_id', schoolId).maybeSingle();
            if (!equipo) return res.status(404).json({ error: 'Ese equipo no es de esta escuela' });
        }

        const { avisarClasesCanceladas } = await import('../services/clase-prueba-agenda.service');
        const reprogramadas = await avisarClasesCanceladas({ schoolId, teamId });

        const { data: ajustes } = await supabase.from('school_settings')
            .select('courtesy_from_training').eq('school_id', schoolId).maybeSingle();
        if ((ajustes as any)?.courtesy_from_training !== true) {
            return res.json({ ok: true, reprogramadas, franjas: null, motivo: 'franjas_desde_entrenamientos_apagadas' });
        }
        const { sincronizarFranjasDeEscuela } = await import('../services/franjas-cortesia.service');
        // Con `teamId` solo se rehacen las franjas de ese equipo (B3: `soloEquipo`).
        const r = await sincronizarFranjasDeEscuela(schoolId, { aplicar: true, soloEquipo: teamId });
        return res.json({
            ok: true, reprogramadas,
            franjas: { creadas: r.creadas, cerradas: r.cerradas, conservadasConReserva: r.conservadasConReserva.length, errores: r.errores.length },
        });
    } catch (e: any) {
        console.error('[cortesias] sincronizar franjas falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudieron sincronizar las franjas' });
    }
});

export default router;
