/**
 * whatsapp-precios-escuela.routes — WhatsApp › Precios: los valores que el bot
 * usa para reconocer pagos y responder precios, en un solo lugar.
 *
 *   GET   /api/v1/whatsapp/:schoolId/precios                 interruptores, mensualidades, matrícula, clase de prueba, artículos, servicios y avisos
 *   PUT   /api/v1/whatsapp/:schoolId/precios/interruptores   { responde_precios?, cobra_desde_comprobante? }
 *   PUT   /api/v1/whatsapp/:schoolId/precios/matricula       { valor } → igual en TODOS los planes activos (null o 0 = sin matrícula)
 *   PUT   /api/v1/whatsapp/:schoolId/precios/clase-prueba    { valor } (null o 0 = sin valor)
 *   POST  /api/v1/whatsapp/:schoolId/precios/articulos       { nombre, precio }
 *   PATCH /api/v1/whatsapp/:schoolId/precios/articulos/:id   { nombre?, precio?, activo? } (nunca se borra: se desactiva)
 *
 * Autorización: administración REAL de esa escuela (`administraEstaEscuela`),
 * igual que Campañas. El BFF escribe con service role, así que este gate y el
 * filtro por `school_id` del servicio son la única protección. Quien actúa sale
 * SIEMPRE de la sesión, nunca del cuerpo. Toda escritura devuelve el objeto del
 * GET ya actualizado; los errores, `{ error: '<clave_en_snake>' }`.
 */

import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { administraEstaEscuela } from './whatsapp-admin.routes';
import {
    actualizarArticulo, crearArticulo, guardarClasePrueba, guardarInterruptores, guardarMatricula,
    leerPreciosDeEscuela, type ResultadoPrecios,
} from '../services/whatsapp-precios-escuela.service';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function autorizar(req: AuthenticatedRequest, res: Response): Promise<string | null> {
    const { schoolId, id } = req.params as { schoolId: string; id?: string };
    if (!UUID.test(schoolId) || (id !== undefined && !UUID.test(id))) {
        res.status(400).json({ error: 'id_invalido' });
        return null;
    }
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        res.status(403).json({ error: 'forbidden' });
        return null;
    }
    return schoolId;
}

function responder(res: Response, r: ResultadoPrecios, ok = 200) {
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    return res.status(ok).json(r.precios);
}

type Accion = (schoolId: string, req: AuthenticatedRequest) => Promise<ResultadoPrecios>;

/** Gate + acción + respuesta. Nada lanza hacia el cliente: lo inesperado es un 500 con clave. */
function ruta(nombre: string, accion: Accion, ok = 200) {
    return async (req: AuthenticatedRequest, res: Response) => {
        let schoolId: string | null = null;
        try {
            schoolId = await autorizar(req, res);
            if (!schoolId) return;
            const r = await accion(schoolId, req);
            if (req.method !== 'GET') req.log?.info({ schoolId, por: req.user.id, ok: r.ok }, `[precios-escuela] ${nombre}`);
            return responder(res, r, ok);
        } catch (e: any) {
            console.error(`[precios-escuela] ${nombre} falló`, { schoolId, err: e?.message });
            if (!res.headersSent) return res.status(500).json({ error: 'error_interno' });
        }
    };
}

router.get('/:schoolId/precios', requireAuth, ruta('leer', (schoolId) => leerPreciosDeEscuela(schoolId)));

router.put('/:schoolId/precios/interruptores', requireAuth,
    ruta('interruptores', (schoolId, req) => guardarInterruptores(schoolId, req.body)));

router.put('/:schoolId/precios/matricula', requireAuth,
    ruta('matrícula', (schoolId, req) => guardarMatricula(schoolId, req.body)));

router.put('/:schoolId/precios/clase-prueba', requireAuth,
    ruta('clase de prueba', (schoolId, req) => guardarClasePrueba(schoolId, req.body)));

router.post('/:schoolId/precios/articulos', requireAuth,
    ruta('crear artículo', (schoolId, req) => crearArticulo(schoolId, req.body), 201));

router.patch('/:schoolId/precios/articulos/:id', requireAuth,
    ruta('actualizar artículo', (schoolId, req) => actualizarArticulo(schoolId, (req.params as any).id, req.body)));

export default router;
