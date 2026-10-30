/**
 * whatsapp-campanas.routes — WhatsApp › Campañas (plan B5 T5).
 *
 *   GET  /api/v1/whatsapp/:schoolId/campanas                       ajustes, audiencia, plantillas y campañas con su avance
 *   POST /api/v1/whatsapp/:schoolId/campanas                       crea el borrador
 *   GET  /api/v1/whatsapp/:schoolId/campanas/:campanaId/simulacion conteo previsto («Lista: N personas»)
 *   POST /api/v1/whatsapp/:schoolId/campanas/:campanaId/aprobar    { declaracion_aceptada } → foto de la audiencia
 *   POST /api/v1/whatsapp/:schoolId/campanas/:campanaId/pausar
 *   POST /api/v1/whatsapp/:schoolId/campanas/:campanaId/reanudar
 *
 * Autorización: administración REAL de esa escuela (`administraEstaEscuela`).
 * Las cuatro tablas de campañas son solo-BFF (sin policies): la pantalla lee
 * por aquí. Con las campañas apagadas (sin fila de ajustes) el GET responde
 * `habilitadas:false` sin leer nada más; sin la migración, `disponible:false`.
 */

import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { administraEstaEscuela } from './whatsapp-admin.routes';
import { nombreDeEscuela } from '../services/plataforma-wa.service';
import {
    DECLARACION, aprobarCampana, audienciaVigente, avanceDeCampanas, campanasDeEscuela, contarFilas, crearCampana,
    integracionActivaDeEscuela, leerAjustesCampanas, pausarCampana, plantillasDeMarketing, reanudarCampana,
    simularCampana, type ResultadoOperacion,
} from '../services/whatsapp-campanas.service';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function autorizar(req: AuthenticatedRequest, res: Response): Promise<string | null> {
    const { schoolId, campanaId } = req.params as { schoolId: string; campanaId?: string };
    if (!UUID.test(schoolId) || (campanaId !== undefined && !UUID.test(campanaId))) {
        res.status(400).json({ error: 'id inválido' });
        return null;
    }
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        res.status(403).json({ error: 'forbidden' });
        return null;
    }
    return schoolId;
}

function responder(res: Response, r: ResultadoOperacion<any>, ok = 200) {
    if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.detalle ? { detalle: r.detalle } : {}) });
    const { ok: _ok, ...resto } = r;
    return res.status(ok).json(resto);
}

router.get('/:schoolId/campanas', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        const { disponible, ajustes } = await leerAjustesCampanas(schoolId);
        if (!disponible) return res.json({ disponible: false });
        if (!ajustes?.habilitadas) return res.json({ disponible: true, habilitadas: false });

        const integ = await integracionActivaDeEscuela(schoolId);
        const base = {
            disponible: true, habilitadas: true,
            ajustes: {
                base_consentimiento: ajustes.baseConsentimiento,
                tope_diario: ajustes.topeDiarioMax,
                lote_piloto: ajustes.lotePiloto,
                pausada: Boolean(ajustes.pausadaAt),
                pausa_motivo: ajustes.pausaMotivo,
            },
        };
        if (typeof integ === 'string') return res.json({ ...base, integracion: integ, campanas: [], plantillas: [] });

        const [filas, campanas, plantillas, { data: sedes }, escuela] = await Promise.all([
            audienciaVigente(integ.id, ajustes),
            campanasDeEscuela(schoolId),
            plantillasDeMarketing(integ),
            supabase.from('school_branches').select('id, name').eq('school_id', schoolId),
            nombreDeEscuela(schoolId),
        ]);
        const avance = await avanceDeCampanas(campanas.filter((c) => c.estado !== 'borrador').map((c) => c.id));
        return res.json({
            ...base,
            integracion: 'ok',
            audiencia: contarFilas(filas),
            sedes: ((sedes as any[]) ?? []).map((s) => ({ id: s.id, nombre: s.name })),
            plantillas,
            declaracion: ajustes.baseConsentimiento === 'contacto_previo_declarado'
                ? { version: DECLARACION.version, texto: DECLARACION.texto(escuela, ajustes.antiguedadMaxDias) }
                : null,
            campanas: campanas.map((c) => ({
                id: c.id, nombre: c.nombre, plantilla: c.plantilla, estado: c.estado, filtro: c.filtro,
                respuesta_si: c.respuesta_si, destinatarios: c.destinatarios, aprobada_at: c.aprobada_at,
                vence_at: c.vence_at, pausa_motivo: c.pausa_motivo,
                conteo_previsto: c.estado === 'borrador' ? contarFilas(filas, c.filtro).total : null,
                avance: avance.get(c.id) ?? null,
            })),
        });
    } catch (e: any) {
        console.error('[campanas] resumen falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudieron cargar las campañas' });
    }
});

router.post('/:schoolId/campanas', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    const b = req.body ?? {};
    try {
        const r = await crearCampana(schoolId, req.user.id, {
            nombre: String(b.nombre ?? ''),
            plantilla: String(b.plantilla ?? ''),
            idioma: typeof b.idioma === 'string' ? b.idioma : undefined,
            filtro: {
                intereses: Array.isArray(b.filtro?.intereses) ? b.filtro.intereses.map(String) : [],
                branch_ids: Array.isArray(b.filtro?.branch_ids) ? b.filtro.branch_ids.map(String) : [],
            },
            respuestaSi: typeof b.respuesta_si === 'string' ? b.respuesta_si : null,
            venceAt: typeof b.vence_at === 'string' && b.vence_at ? b.vence_at : null,
        });
        return responder(res, r, 201);
    } catch (e: any) {
        console.error('[campanas] crear falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo crear la campaña' });
    }
});

router.get('/:schoolId/campanas/:campanaId/simulacion', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        return responder(res, await simularCampana(schoolId, (req.params as any).campanaId));
    } catch (e: any) {
        console.error('[campanas] simular falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo contar la lista' });
    }
});

router.post('/:schoolId/campanas/:campanaId/aprobar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        const r = await aprobarCampana({
            schoolId, campanaId: (req.params as any).campanaId, por: req.user.id,
            declaracionAceptada: (req.body ?? {}).declaracion_aceptada === true,
        });
        req.log?.info({ schoolId, campanaId: (req.params as any).campanaId, ok: r.ok }, '[campanas] aprobación');
        return responder(res, r);
    } catch (e: any) {
        console.error('[campanas] aprobar falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo aprobar la campaña' });
    }
});

router.post('/:schoolId/campanas/:campanaId/pausar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        return responder(res, await pausarCampana(schoolId, (req.params as any).campanaId));
    } catch (e: any) {
        console.error('[campanas] pausar falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo pausar la campaña' });
    }
});

router.post('/:schoolId/campanas/:campanaId/reanudar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        return responder(res, await reanudarCampana(schoolId, (req.params as any).campanaId));
    } catch (e: any) {
        console.error('[campanas] reanudar falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo reanudar la campaña' });
    }
});

export default router;
