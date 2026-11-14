/**
 * admin-whatsapp-plataforma.routes — el canal de WhatsApp de SportMaps desde la
 * pantalla /admin/whatsapp. Montado en /api/v1/admin/whatsapp-plataforma.
 * Gateado a admin de PLATAFORMA (platform_admins), nunca a dueños de escuela.
 *
 *  GET  /estado                → canal, estado en Meta, plantillas, escuelas, suscriptores, auditoría
 *  POST /conectar              → { code, sesion } del diálogo de Meta
 *  POST /desconectar
 *  POST /interruptor           → { habilitado }
 *  POST /escuelas/:schoolId    → { habilitado }
 *  GET  /escuelas/buscar?q=
 *  POST /plantillas            → registra en Meta las que faltan
 *  POST /prueba                → { numero }
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { requirePlatformAdmin } from '../middlewares/requirePlatformAdmin';
import {
    estadoDelCanal, conectarCanal, desconectarCanal, cambiarInterruptor, cambiarEscuela,
    buscarEscuelas, registrarPlantillasFaltantes, enviarPrueba,
} from '../services/plataforma-wa-admin.service';

const router = Router();
router.use(requireAuth);
router.use(requirePlatformAdmin);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/estado', async (_req: AuthenticatedRequest, res: Response) => {
    try {
        return res.json(await estadoDelCanal());
    } catch (err: any) {
        return res.status(500).json({ error: err?.message || 'No se pudo leer el canal' });
    }
});

const ConectarSchema = z.object({
    code: z.string().min(10).max(2000),
    sesion: z.object({
        event: z.string().optional(),
        waba_id: z.string().optional(),
        phone_number_id: z.string().optional(),
        business_id: z.string().optional(),
    }).nullable().optional(),
});

router.post('/conectar', async (req: AuthenticatedRequest, res: Response) => {
    const p = ConectarSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Datos de conexión inválidos' });
    // El code es una credencial de un solo uso: nunca va al log.
    const r = await conectarCanal(p.data.code, p.data.sesion ?? null, req.user.id);
    if (!r.ok) {
        req.log?.warn({ error: r.error }, '[admin-wa-plataforma] conexión fallida');
        return res.status(502).json({ error: r.error });
    }
    return res.status(201).json(r);
});

router.post('/desconectar', async (req: AuthenticatedRequest, res: Response) => {
    const r = await desconectarCanal(req.user.id);
    return r.ok ? res.json(r) : res.status(500).json(r);
});

router.post('/interruptor', async (req: AuthenticatedRequest, res: Response) => {
    const p = z.object({ habilitado: z.boolean() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Falta habilitado' });
    const r = await cambiarInterruptor(p.data.habilitado, req.user.id);
    return r.ok ? res.json(r) : res.status(409).json(r);
});

router.get('/escuelas/buscar', async (req: AuthenticatedRequest, res: Response) => {
    return res.json({ escuelas: await buscarEscuelas(String(req.query.q ?? '')) });
});

router.post('/escuelas/:schoolId', async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    const p = z.object({ habilitado: z.boolean() }).safeParse(req.body);
    if (!UUID.test(schoolId) || !p.success) return res.status(400).json({ error: 'Datos inválidos' });
    const r = await cambiarEscuela(schoolId, p.data.habilitado, req.user.id);
    return r.ok ? res.json(r) : res.status(404).json(r);
});

router.post('/plantillas', async (req: AuthenticatedRequest, res: Response) => {
    const r = await registrarPlantillasFaltantes(req.user.id);
    return r.ok ? res.json(r) : res.status(409).json(r);
});

router.post('/prueba', async (req: AuthenticatedRequest, res: Response) => {
    const p = z.object({ numero: z.string().min(7).max(20) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'Falta el número' });
    const r = await enviarPrueba(p.data.numero, req.user.id);
    return r.ok ? res.json(r) : res.status(409).json(r);
});

export default router;
