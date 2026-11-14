/**
 * whatsapp-seguimiento.routes — WhatsApp › Seguimiento: la lista de quién escribió,
 * si respondió la escuela o el bot, quién quedó esperando y desde cuándo
 * (docs/specs/whatsapp-ventas-de-servicio-blindaje.md §4.E).
 *
 *   GET /api/v1/whatsapp/:schoolId/seguimiento?desde=&hasta=&servicio=&soloSinResponder=1&formato=csv
 *
 *   · desde / hasta: fechas de Bogotá (YYYY-MM-DD), ambas incluidas. Por defecto los
 *     últimos 14 días; máximo 31.
 *   · servicio: id de un ítem del catálogo, o un tema (servicio | clase_prueba |
 *     familia | otro).
 *   · soloSinResponder: solo las que esperan respuesta o tienen pendientes de la escuela.
 *   · formato=csv: el mismo listado para Excel (BOM, «;»).
 *
 * Autorización: administración REAL de esa escuela o administración de plataforma
 * (`administraEstaEscuela`, como Campañas y Anuncios). Solo lectura.
 * Las cuentas viven en services/whatsapp-seguimiento-conversaciones.service.ts.
 */
import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { administraEstaEscuela } from './whatsapp-admin.routes';
import {
    filtrarSeguimiento, filtroServicioValido, leerRangoSeguimiento, resumirSeguimiento, seguimientoCsv,
    seguimientoDeConversaciones,
} from '../services/whatsapp-seguimiento-conversaciones.service';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const verdadero = (v: unknown) => v === '1' || v === 'true' || v === 'si';

router.get('/:schoolId/seguimiento', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'id inválido' });
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });

    const q = req.query as Record<string, unknown>;
    const rango = leerRangoSeguimiento(q.desde, q.hasta);
    if (!rango.ok) return res.status(400).json({ error: rango.error, detalle: 'usa YYYY-MM-DD; máximo 31 días' });
    const servicio = typeof q.servicio === 'string' && q.servicio ? q.servicio : null;
    if (servicio && !filtroServicioValido(servicio)) return res.status(400).json({ error: 'servicio_invalido' });
    const soloSinResponder = verdadero(q.soloSinResponder);

    try {
        const r = await seguimientoDeConversaciones(schoolId, rango);
        const porServicio = filtrarSeguimiento(r.filas, { servicio });
        const filas = soloSinResponder ? filtrarSeguimiento(porServicio, { soloSinResponder }) : porServicio;
        if (q.formato === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="seguimiento-whatsapp-${rango.desde}-a-${rango.hasta}.csv"`);
            res.setHeader('Cache-Control', 'no-store');
            return res.send(seguimientoCsv(filas));
        }
        return res.json({
            rango: { desde: rango.desde, hasta: rango.hasta },
            servicios: r.servicios,
            // Los contadores cuentan todo lo del filtro de servicio; «solo sin responder» solo achica la tabla.
            resumen: resumirSeguimiento(porServicio),
            filas,
            avisos: r.avisos,
        });
    } catch (e: any) {
        console.error('[seguimiento] lectura falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo cargar el seguimiento de conversaciones' });
    }
});

export default router;
