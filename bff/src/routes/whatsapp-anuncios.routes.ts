/**
 * whatsapp-anuncios.routes — WhatsApp › Anuncios (fase 1 de
 * docs/specs/whatsapp-anuncios-atribucion.md).
 *
 *   GET    /api/v1/whatsapp/:schoolId/anuncios?desde=&hasta=&sede=   embudo por anuncio + mapeos + catálogo + sedes
 *   GET    /api/v1/whatsapp/:schoolId/anuncios/destinos              solo mapeos + catálogo
 *   PUT    /api/v1/whatsapp/:schoolId/anuncios/:sourceId/destino     { destino, servicio_id?, nota? }
 *   DELETE /api/v1/whatsapp/:schoolId/anuncios/:sourceId/destino     el bot vuelve a inferir por el texto
 *
 * Autorización: administración REAL de esa escuela (`administraEstaEscuela`,
 * como Campañas). El embudo además pasa por el candado de la RPC
 * `wa_embudo_anuncios`, que se llama con el JWT del usuario (ver el servicio).
 * Sin la migración 20261104115612 el GET responde `disponible:false`.
 *
 * Por qué por el BFF y no supabase-js directo desde la pantalla: la pestaña
 * necesita en un viaje el embudo, los mapeos, el catálogo y las sedes, y el
 * mapeo se escribe con la misma regla de autorización que el resto del panel
 * de WhatsApp (la tabla tiene RLS igual, por si algún día se lee directo).
 */

import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { administraEstaEscuela } from './whatsapp-admin.routes';
import {
    SOURCE_ID, borrarMapeo, embudoDeAnuncios, guardarMapeo, leerRangoAnuncios, mapeosDeEscuela, sedesDeEscuela,
    serviciosDeEscuela, validarMapeo,
} from '../services/whatsapp-anuncios.service';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function autorizar(req: AuthenticatedRequest, res: Response): Promise<string | null> {
    const { schoolId, sourceId } = req.params as { schoolId: string; sourceId?: string };
    if (!UUID.test(schoolId) || (sourceId !== undefined && !SOURCE_ID.test(sourceId))) {
        res.status(400).json({ error: 'id inválido' });
        return null;
    }
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        res.status(403).json({ error: 'forbidden' });
        return null;
    }
    return schoolId;
}

router.get('/:schoolId/anuncios', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    const q = req.query as Record<string, unknown>;
    const rango = leerRangoAnuncios(q.desde, q.hasta);
    if (!rango.ok) return res.status(400).json({ error: rango.error });
    const sede = typeof q.sede === 'string' && q.sede ? q.sede : null;
    if (sede && !UUID.test(sede)) return res.status(400).json({ error: 'sede_invalida' });
    try {
        const [embudo, mapeos, servicios, sedes] = await Promise.all([
            embudoDeAnuncios(String(req.headers.authorization ?? ''), {
                schoolId, desde: rango.desde, hasta: rango.hasta, branchId: sede,
            }),
            mapeosDeEscuela(schoolId),
            serviciosDeEscuela(schoolId),
            sedesDeEscuela(schoolId),
        ]);
        if (!embudo.ok) {
            if ('pendiente' in embudo) return res.json({ disponible: false });
            return res.status(embudo.status).json({ error: embudo.error });
        }
        return res.json({
            disponible: true,
            rango: { desde: rango.desde, hasta: rango.hasta },
            sede,
            sedes,
            servicios,
            mapeos: mapeos ?? [],
            anuncios: embudo.anuncios,
            total: embudo.total,
        });
    } catch (e: any) {
        console.error('[anuncios] embudo falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo cargar el embudo de anuncios' });
    }
});

router.get('/:schoolId/anuncios/destinos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    try {
        const [mapeos, servicios] = await Promise.all([mapeosDeEscuela(schoolId), serviciosDeEscuela(schoolId)]);
        if (mapeos === null) return res.json({ disponible: false });
        return res.json({ disponible: true, mapeos, servicios });
    } catch (e: any) {
        console.error('[anuncios] destinos falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudieron cargar los destinos' });
    }
});

router.put('/:schoolId/anuncios/:sourceId/destino', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    const v = validarMapeo(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const sourceId = (req.params as { sourceId: string }).sourceId;
    try {
        const r = await guardarMapeo(schoolId, sourceId, v.valor, req.user.id);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        req.log?.info({ schoolId, sourceId, destino: v.valor.destino }, '[anuncios] destino guardado');
        return res.json({ mapeo: r.mapeo });
    } catch (e: any) {
        console.error('[anuncios] guardar destino falló', { schoolId, sourceId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo guardar el destino' });
    }
});

router.delete('/:schoolId/anuncios/:sourceId/destino', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const schoolId = await autorizar(req, res);
    if (!schoolId) return;
    const sourceId = (req.params as { sourceId: string }).sourceId;
    try {
        const r = await borrarMapeo(schoolId, sourceId);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ borrados: r.borrados });
    } catch (e: any) {
        console.error('[anuncios] borrar destino falló', { schoolId, sourceId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo quitar el destino' });
    }
});

export default router;
