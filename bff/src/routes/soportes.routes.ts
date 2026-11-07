/**
 * soportes.routes — soportes obligatorios del deportista (spec
 * docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6b, F6).
 *
 * Montaje (NO está en bff/src/index.ts; lo agrega quien integre, junto al resto de routers):
 *
 *     import soportesRouter from './routes/soportes.routes';
 *     app.use('/api/v1/soportes', generalLimiter, soportesRouter);
 *
 *   GET  /api/v1/soportes/:schoolId/estado?solo_faltan=true
 *        Estado en lote de la escuela (filtro «Faltan soportes», informe «Soportes pendientes», contador X/7).
 *        Solo administración de ESA escuela (coach / otra escuela => 403).
 *   GET  /api/v1/soportes/:schoolId/deportistas/:tipoSujeto/:sujetoId
 *        Un deportista: { activo, completo, requeridos[], faltan[] }. tipoSujeto ∈ child | profile | unregistered.
 *   POST /api/v1/soportes/:schoolId/deportistas/:tipoSujeto/:sujetoId/:tipoDocumento
 *        Sube UN soporte. Body { archivoBase64, nombre? } (JPG/PNG/WEBP o PDF; fotos y firmas solo imagen; ≤ 4 MB).
 *        Pueden: la administración de la escuela o la propia familia del deportista (acudiente del hijo / el
 *        adulto con cuenta propia). El coach no sube por aquí.
 *
 * Nada es legible sin sesión; el archivo va al bucket PRIVADO identity-documents y las respuestas nunca traen
 * URLs ni el archivo. Con el flag de la escuela apagado (todas menos Monster) `activo` es false y la subida
 * sigue funcionando (guardar un soporte es útil aunque la escuela no lo exija).
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { administraEstaEscuela } from './whatsapp-admin.routes';
import {
    esFamiliaDelSujeto, esTipoSoporte, esTipoSujeto, esUuid, estadoDeEscuela, guardarSoporte, MAX_BYTES_SOPORTE,
    verificarSujeto, verificarSujetoDeFamilia, type Sujeto, type TipoSujeto,
} from '../services/soportes.service';

const router = Router();

const SubirSchema = z.object({
    archivoBase64: z.string().min(100),
    nombre: z.string().max(200).optional(),
});

const HTTP_DE_ERROR: Record<string, string> = {
    tipo_invalido: 'Ese tipo de soporte no existe.',
    archivo_vacio: 'El archivo llegó vacío.',
    archivo_muy_grande: 'El archivo pesa más de 4 MB. Tómalo de nuevo o recórtalo.',
    formato_no_permitido: 'Sube una foto (JPG, PNG o WEBP) o un PDF.',
    solo_imagen: 'Este soporte debe ser una foto, no un PDF.',
    sujeto_invalido: 'Deportista inválido.',
    deportista_no_encontrado: 'No encontramos a ese deportista en esta escuela.',
};

function leerIds(req: AuthenticatedRequest, res: Response): { schoolId: string; sujeto?: Sujeto } | null {
    const p = req.params as { schoolId: string; tipoSujeto?: string; sujetoId?: string };
    if (!esUuid(p.schoolId)) { res.status(400).json({ error: 'id inválido' }); return null; }
    if (p.tipoSujeto === undefined) return { schoolId: p.schoolId };
    if (!esTipoSujeto(p.tipoSujeto) || !esUuid(p.sujetoId)) { res.status(400).json({ error: 'deportista inválido' }); return null; }
    return { schoolId: p.schoolId, sujeto: { tipo: p.tipoSujeto as TipoSujeto, id: p.sujetoId } };
}

router.get('/:schoolId/estado', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const ids = leerIds(req, res);
    if (!ids) return;
    try {
        if (!(await administraEstaEscuela(req.user.id, ids.schoolId))) return res.status(403).json({ error: 'forbidden' });
        const r = await estadoDeEscuela(String(req.headers.authorization ?? ''), ids.schoolId);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        const soloFaltan = String((req.query as Record<string, unknown>).solo_faltan ?? '') === 'true';
        return res.json({
            activo: r.activo,
            requeridos: r.requeridos,
            resumen: r.resumen,
            deportistas: soloFaltan ? r.deportistas.filter((d) => !d.complete) : r.deportistas,
        });
    } catch (e: any) {
        console.error('[soportes] estado falló', { schoolId: ids.schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo cargar el estado de los soportes' });
    }
});

router.get('/:schoolId/deportistas/:tipoSujeto/:sujetoId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const ids = leerIds(req, res);
    if (!ids?.sujeto) return;
    try {
        // Administración (RPC con su JWT) o la propia familia (service role: la RPC solo admite administración).
        const esAdmin = await administraEstaEscuela(req.user.id, ids.schoolId);
        if (!esAdmin && !(await esFamiliaDelSujeto(req.user.id, ids.sujeto))) return res.status(403).json({ error: 'forbidden' });
        const r = esAdmin
            ? await verificarSujeto(String(req.headers.authorization ?? ''), ids.schoolId, ids.sujeto)
            : await verificarSujetoDeFamilia(ids.schoolId, ids.sujeto);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ activo: r.activo, completo: r.completo, requeridos: r.requeridos, faltan: r.faltan });
    } catch (e: any) {
        console.error('[soportes] sujeto falló', { schoolId: ids.schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo revisar los soportes del deportista' });
    }
});

router.post('/:schoolId/deportistas/:tipoSujeto/:sujetoId/:tipoDocumento', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const ids = leerIds(req, res);
    if (!ids?.sujeto) return;
    const tipoDocumento = String((req.params as { tipoDocumento: string }).tipoDocumento);
    if (!esTipoSoporte(tipoDocumento)) return res.status(400).json({ error: HTTP_DE_ERROR.tipo_invalido, codigo: 'tipo_invalido' });

    const parsed = SubirSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: HTTP_DE_ERROR.formato_no_permitido, codigo: 'formato_no_permitido' });

    try {
        const userId = req.user.id;
        // Administración de la escuela, o la propia familia. El coach no sube por aquí.
        const autorizado = (await administraEstaEscuela(userId, ids.schoolId)) || (await esFamiliaDelSujeto(userId, ids.sujeto));
        if (!autorizado) return res.status(403).json({ error: 'forbidden' });

        const buffer = Buffer.from(parsed.data.archivoBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (buffer.length > MAX_BYTES_SOPORTE) return res.status(413).json({ error: HTTP_DE_ERROR.archivo_muy_grande, codigo: 'archivo_muy_grande' });

        const r = await guardarSoporte({
            schoolId: ids.schoolId, sujeto: ids.sujeto, tipo: tipoDocumento,
            archivo: { buffer, nombre: parsed.data.nombre ?? null }, subidoPor: userId,
        });
        if (!r.ok) return res.status(r.status).json({ error: HTTP_DE_ERROR[r.error] ?? r.error, codigo: r.error });
        req.log?.info({ schoolId: ids.schoolId, sujeto: ids.sujeto, tipo: tipoDocumento }, '[soportes] guardado');
        return res.status(201).json({ id: r.id, tipo: r.tipo, activo: r.activo, completo: r.completo, faltan: r.faltan });
    } catch (e: any) {
        console.error('[soportes] subir falló', { schoolId: ids.schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo guardar el soporte. Intenta de nuevo.' });
    }
});

export default router;
