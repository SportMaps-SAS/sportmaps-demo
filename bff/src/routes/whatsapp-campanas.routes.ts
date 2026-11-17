/**
 * whatsapp-campanas.routes — WhatsApp › Campañas (plan B5 T5).
 *
 *   GET  /api/v1/whatsapp/:schoolId/campanas                       ajustes, cupo de hoy, audiencia, plantillas y campañas con su avance
 *   POST /api/v1/whatsapp/:schoolId/campanas                       crea el borrador
 *   GET  /api/v1/whatsapp/:schoolId/campanas/:campanaId/simulacion conteo previsto («Lista: N personas»)
 *   GET  /api/v1/whatsapp/:schoolId/campanas/:campanaId/reporte    reporte de la campaña (F0.5): enviados, por salir, no enviados, fallidos y freno
 *   POST /api/v1/whatsapp/:schoolId/campanas/activar               { declaracion_aceptada } → la escuela prende sus campañas
 *   POST /api/v1/whatsapp/:schoolId/campanas/reanudar-escuela      { acepto_motivo } levanta la pausa de la escuela (no la de plataforma)
 *   POST /api/v1/whatsapp/:schoolId/campanas/pausar-escuela        la escuela pausa todas sus campañas
 *   POST /api/v1/whatsapp/:schoolId/campanas/:campanaId/aprobar    { declaracion_aceptada } → foto de la audiencia
 *   POST /api/v1/whatsapp/:schoolId/campanas/:campanaId/pausar
 *   POST /api/v1/whatsapp/:schoolId/campanas/:campanaId/reanudar
 *
 * Autorización: administración REAL de esa escuela (`administraEstaEscuela`).
 * Activar y aprobar los hace SOLO la escuela: las RPC validan a quien actúa y al
 * administrador de plataforma le responden 403 (`solo_la_escuela`). Cada una
 * registra la declaración de responsabilidad con usuario y fecha.
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
    RESPONSABILIDAD, activacionAceptada, activarCampanas, aprobarCampana, audienciaVigente, avanceDeCampanas,
    campanasDeEscuela, compradoresDeServicio, contarFilas, crearCampana, declaracionDeActivacion, serviciosParaCampana, integracionActivaDeEscuela,
    leerAjustesCampanas, leerFrenoGlobal, pausarCampana, pausarEscuela, plantillasDeMarketing, reanudarCampana,
    reanudarEscuela, textoDeAceptacionDePausa,
    simularCampana, type ResultadoOperacion,
} from '../services/whatsapp-campanas.service';
import { cupoDeCampanasHoy } from '../services/whatsapp-campanas-cupo';
import { leerReporteDeCampana } from '../services/whatsapp-campana-reporte.service';

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
        // Apagadas: la escuela las prende sola aceptando la declaración de responsabilidad.
        if (!ajustes?.habilitadas) {
            return res.json({ disponible: true, habilitadas: false, activacion: await declaracionDeActivacion(schoolId) });
        }

        const [integ, activada, frenoGlobal] = await Promise.all([
            integracionActivaDeEscuela(schoolId), activacionAceptada(schoolId), leerFrenoGlobal(),
        ]);
        const base = {
            disponible: true, habilitadas: true,
            // Prendidas antes de la declaración (las prendió SportMaps): falta que la escuela la acepte para aprobar.
            falta_activacion: !activada,
            activacion: activada ? null : await declaracionDeActivacion(schoolId),
            pausa_global: frenoGlobal.pausada,
            ajustes: {
                base_consentimiento: ajustes.baseConsentimiento,
                tope_diario: ajustes.topeDiarioMax,
                lote_piloto: ajustes.lotePiloto,
                pausada: Boolean(ajustes.pausadaAt),
                pausa_motivo: ajustes.pausaMotivo,
                pausa_origen: ajustes.pausaOrigen,
                // Lo que la escuela acepta al reanudar tras el freno (null si no hay pausa o es de plataforma).
                aceptacion: ajustes.pausadaAt && ajustes.pausaOrigen !== 'plataforma' && ajustes.pausaOrigen !== 'escuela'
                    ? textoDeAceptacionDePausa(ajustes.pausaMotivo) : null,
            },
        };
        if (typeof integ === 'string') return res.json({ ...base, integracion: integ, campanas: [], plantillas: [] });

        const [filas, campanas, plantillas, { data: sedes }, escuela, cupo, servicios] = await Promise.all([
            audienciaVigente(integ.id, ajustes),
            campanasDeEscuela(schoolId),
            plantillasDeMarketing(integ),
            supabase.from('school_branches').select('id, name').eq('school_id', schoolId),
            nombreDeEscuela(schoolId),
            cupoDeCampanasHoy(integ, ajustes.topeDiarioMax),
            serviciosParaCampana(schoolId),
        ]);
        // Quien ya pagó o abonó el servicio que vende un borrador no cuenta en su lista (una lectura por servicio).
        const compradores = new Map<string, Set<string>>();
        for (const id of new Set(campanas.filter((c) => c.estado === 'borrador' && c.servicio_id).map((c) => c.servicio_id as string))) {
            compradores.set(id, await compradoresDeServicio(schoolId, id));
        }
        const nombreServicio = new Map(servicios.map((s) => [s.id, s.nombre]));
        const avance = await avanceDeCampanas(campanas.filter((c) => c.estado !== 'borrador').map((c) => c.id));
        return res.json({
            ...base,
            integracion: 'ok',
            // «Cupo de hoy: X de Y · reserva Z para interesados y avisos» (null si no se pudo leer).
            cupo: cupo && {
                limite_meta: cupo.limite, tier: cupo.tier, fuente: cupo.fuente, reserva: cupo.reserva,
                usados_24h: cupo.usados24h, tope_diario: cupo.topeDiario, enviados_hoy: cupo.enviadosHoy,
                cupo_hoy: cupo.cupoHoy, disponible_hoy: cupo.disponibleHoy,
            },
            audiencia: contarFilas(filas),
            sedes: ((sedes as any[]) ?? []).map((s) => ({ id: s.id, nombre: s.name })),
            servicios,
            plantillas,
            // Toda aprobación la pide y la registra, sea cual sea la base de consentimiento.
            declaracion: {
                version: RESPONSABILIDAD.versionCampana,
                texto: RESPONSABILIDAD.textoCampana(escuela, ajustes.baseConsentimiento, ajustes.antiguedadMaxDias),
            },
            campanas: campanas.map((c) => ({
                id: c.id, nombre: c.nombre, plantilla: c.plantilla, estado: c.estado, filtro: c.filtro,
                respuesta_si: c.respuesta_si, destinatarios: c.destinatarios, aprobada_at: c.aprobada_at,
                vence_at: c.vence_at, pausa_motivo: c.pausa_motivo,
                servicio_id: c.servicio_id ?? null,
                servicio_nombre: c.servicio_id ? (nombreServicio.get(c.servicio_id) ?? null) : null,
                conteo_previsto: c.estado === 'borrador'
                    ? contarFilas(filas, c.filtro, c.servicio_id ? compradores.get(c.servicio_id) : null).total : null,
                // Cuántos de la lista ya pagaron o abonaron ese servicio y por eso no la reciben.
                ya_compraron: c.estado === 'borrador' && c.servicio_id
                    ? contarFilas(filas, c.filtro).total - contarFilas(filas, c.filtro, compradores.get(c.servicio_id)).total : null,
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
            servicioId: typeof b.servicio_id === 'string' && b.servicio_id ? b.servicio_id : null,
        });
        return responder(res, r, 201);
    } catch (e: any) {
        console.error('[campanas] crear falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo crear la campaña' });
    }
});

router.post('/:schoolId/campanas/activar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        const r = await activarCampanas({
            schoolId, por: req.user.id, declaracionAceptada: (req.body ?? {}).declaracion_aceptada === true,
        });
        req.log?.info({ schoolId, ok: r.ok }, '[campanas] activación por la escuela');
        return responder(res, r);
    } catch (e: any) {
        console.error('[campanas] activar falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudieron activar las campañas' });
    }
});

router.post('/:schoolId/campanas/reanudar-escuela', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        // Quien actúa sale SIEMPRE de la sesión (req.user.id), nunca del cuerpo de la petición.
        const r = await reanudarEscuela({ schoolId, por: req.user.id, aceptada: (req.body ?? {}).acepto_motivo === true });
        req.log?.info({ schoolId, ok: r.ok }, '[campanas] reanudación de la escuela');
        return responder(res, r);
    } catch (e: any) {
        console.error('[campanas] reanudar escuela falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo levantar la pausa' });
    }
});

router.post('/:schoolId/campanas/pausar-escuela', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        return responder(res, await pausarEscuela({ schoolId, por: req.user.id }));
    } catch (e: any) {
        console.error('[campanas] pausar escuela falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudieron pausar las campañas' });
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

// Reporte de la campaña (F0.5). Solo lee; quien consulta sale de la sesión (el gate de `autorizar`),
// nunca de la query ni del cuerpo.
router.get('/:schoolId/campanas/:campanaId/reporte', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        const r = await leerReporteDeCampana(schoolId, (req.params as any).campanaId);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json(r.reporte);
    } catch (e: any) {
        console.error('[campanas] reporte falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo armar el reporte' });
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
