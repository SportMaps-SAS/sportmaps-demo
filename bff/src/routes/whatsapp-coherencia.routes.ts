/**
 * whatsapp-coherencia.routes — ¿el texto que la escuela le escribió al asistente
 * contradice su catálogo? (plan docs/specs/whatsapp-ventas-de-servicio-blindaje.md,
 * frente B).
 *
 *   GET /api/v1/whatsapp/:schoolId/coherencia-ficha
 *     → { servicios, ficha: boolean, contradicciones: ContradiccionFicha[] }
 *
 * Revisa la ficha de prospectos (`school_settings.wa_ficha_prospectos`) y la
 * descripción de cada servicio vigente contra los precios del catálogo
 * (`school_tournament_items`: precio, tramos por fecha, afiliado, abono,
 * opciones). Caso Monster 2026-11-08: la ficha decía «preventa hasta el 9 de
 * noviembre», el catálogo «hasta el 10», y la IA repitió el 9 a 12 personas. La
 * pantalla de WhatsApp › Configuración muestra cada contradicción en un aviso.
 *
 * Solo lectura: dos consultas (la ficha y el catálogo), nada más.
 * Autorización: administración REAL de esa escuela (`administraEstaEscuela`,
 * como Anuncios y Campañas).
 */

import { Router, Response } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { administraEstaEscuela } from './whatsapp-admin.routes';
import { fichaDeProspectos } from '../services/whatsapp-prospecto-ia.service';
import { serviciosDeAnuncio, type ItemConFicha } from '../services/whatsapp-anuncio-destino';
import { auditarFichaContraCatalogo, type ContradiccionFicha } from '../services/whatsapp-coherencia-ficha';
import { hoyBogota } from '../services/wa-cobro-desde-comprobante.service';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CoherenciaDeEscuela {
    /** Servicios vigentes revisados. */
    servicios: number;
    /** ¿La escuela tiene ficha de prospectos? */
    ficha: boolean;
    contradicciones: ContradiccionFicha[];
}

/** La ficha y cada descripción contra el catálogo vigente. Pura (los datos entran ya leídos). */
export function coherenciaDe(ficha: string | null, items: ItemConFicha[], hoy = hoyBogota()): CoherenciaDeEscuela {
    const contradicciones = [
        ...auditarFichaContraCatalogo(ficha, items, { hoy, fuente: 'ficha' }),
        ...items.flatMap((it) => auditarFichaContraCatalogo(it.description, items, { hoy, fuente: 'descripcion', itemFijo: it })),
    ];
    return { servicios: items.length, ficha: !!ficha, contradicciones };
}

/** Lee la ficha y el catálogo vigente de la escuela y los audita. Nunca lanza por datos faltantes. */
export async function coherenciaDeEscuela(schoolId: string): Promise<CoherenciaDeEscuela> {
    const [ficha, items] = await Promise.all([fichaDeProspectos(schoolId), serviciosDeAnuncio(schoolId)]);
    return coherenciaDe(ficha, items);
}

router.get('/:schoolId/coherencia-ficha', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'id inválido' });
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });
    try {
        return res.json(await coherenciaDeEscuela(schoolId));
    } catch (e: any) {
        console.error('[coherencia-ficha] falló', { schoolId, err: e?.message });
        return res.status(500).json({ error: 'No se pudo revisar el texto del asistente' });
    }
});

export default router;
