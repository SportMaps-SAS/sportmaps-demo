/**
 * mapi-agente.routes — los botones de la tarjeta de acción de Mapi
 * (docs/specs/mapi-agente-plan.md §10). Montado en /api/v1/mapi.
 *
 *   POST /acciones/:id/confirmar  → ejecuta el borrador SIN pasar por el modelo
 *   POST /acciones/:id/cancelar
 *
 * El alcance se arma con la sesión de ESTA request (rol y flags actuales), no
 * con los del momento en que se preparó la acción.
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { supabase } from '../config/supabase';
import { alcanceDelTurno } from '../services/mapi-agente/alcance';
import { cancelarBorrador, confirmarBorrador, tarjetasDelTicket } from '../services/mapi-agente/borradores';
import { postBotMessage } from '../services/inapp-support-bot.service';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function hilo(userId: string, ticketId: string | null) {
    if (!ticketId) return { messages: [], acciones: [] };
    const [{ data: messages }, acciones] = await Promise.all([
        supabase.from('support_messages').select('id, author_type, body, created_at')
            .eq('ticket_id', ticketId).eq('internal_note', false).order('created_at', { ascending: true }),
        tarjetasDelTicket(userId, ticketId),
    ]);
    return { messages: messages ?? [], acciones };
}

router.post('/acciones/:id/confirmar', async (req: AuthenticatedRequest, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Acción inválida.' });
    try {
        const alcance = await alcanceDelTurno({
            userId: req.user.id,
            schoolId: req.schoolId,
            headerSchoolId: req.headers['x-school-id'] as string | undefined,
            rolSesion: req.role,
            // Token fresco de ESTE clic: las RPC que autorizan con auth.uid() corren como la persona.
            authorization: req.headers.authorization ?? null,
        });
        const r = await confirmarBorrador({
            userId: req.user.id,
            id,
            alcance,
            // Acciones largas (envíos masivos): el resultado llega al chat cuando
            // terminan; el chat lo ve al refrescar el hilo.
            alTerminar: async (f) => {
                if (f.ticketId) await postBotMessage(f.ticketId, f.mensaje);
            },
        });
        if (r.tipo === 'no_encontrado') return res.status(404).json({ error: 'No encontramos esa acción.' });
        if (r.tipo === 'en_curso') {
            return res.status(202).json({ accion: r.tarjeta, ...(await hilo(req.user.id, r.ticketId)) });
        }
        if (r.tipo === 'otra_escuela') {
            return res.status(409).json({ error: 'Esta acción es de otra escuela. Cambia a esa escuela para confirmarla.', accion: r.tarjeta });
        }
        if (r.tipo === 'sin_cambio') return res.json({ accion: r.tarjeta });
        if (r.tipo === 'cambio') {
            return res.status(409).json({
                error: 'Cambió algo desde que lo preparé. Revisa la propuesta nueva y confirma otra vez.',
                accion: r.tarjeta,
                nueva: r.nueva,
            });
        }
        // El «Listo» lo escribe el servidor con plantilla fija (§10.3).
        if (r.ticketId) await postBotMessage(r.ticketId, r.mensaje);
        return res.json({ accion: r.tarjeta, mensaje: r.mensaje, ...(await hilo(req.user.id, r.ticketId)) });
    } catch (err: any) {
        req.log?.error({ err, id }, 'mapi/confirmar falló');
        return res.status(500).json({ error: 'No pudimos confirmar la acción. Intenta de nuevo.' });
    }
});

router.post('/acciones/:id/cancelar', async (req: AuthenticatedRequest, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Acción inválida.' });
    try {
        const tarjeta = await cancelarBorrador(req.user.id, id);
        if (!tarjeta) return res.status(404).json({ error: 'No encontramos esa acción.' });
        return res.json({ accion: tarjeta });
    } catch (err: any) {
        req.log?.error({ err, id }, 'mapi/cancelar falló');
        return res.status(500).json({ error: 'No pudimos cancelar la acción.' });
    }
});

export default router;
