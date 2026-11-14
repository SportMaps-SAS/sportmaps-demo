/**
 * support.routes — Soporte in-app S0+S1 (MOD-21). Montado en /api/v1/support.
 * Spec: docs/specs/soporte-in-app-chat-y-bot.md · Plan: docs/plan-soporte-s0-migracion.md
 *
 * Un solo hilo persistente por (requester_id, audience='sportmaps') — v1 no
 * produce tickets de audience='school'. Todo el trabajo de negocio vive en
 * las RPCs `support_open_ticket()` / `support_post_message()`: estas rutas
 * son delgadas a propósito, llaman con `userClient(req)` para que `auth.uid()`
 * resuelva dentro de la RPC y la RLS aplique tal cual a cualquier otro
 * caller de PostgREST.
 *
 * S1 (bot) se dispara después de un mensaje de usuario exitoso, en la misma
 * request — es sincrónico porque el chat espera respuesta inmediata (como
 * cualquier LLM de chat), no porque haga falta cola. Si el bot falla, el
 * usuario igual ve su mensaje guardado (S0 ya entrega valor sin el bot).
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { userClient } from '../utils/userClient';
import { supabase } from '../config/supabase';
import { runSupportBotTurn } from '../services/inapp-support-bot.service';
import { avisarTicketSoportePorCorreo } from '../services/avisos-correo.service';
import { calificarRespuesta, feedbackDelTicket } from '../services/mapi-feedback.service';

const router = Router();

router.use(requireAuth);

/**
 * notifyNewSupportTicket — reusa el Despachador Unificado de Notificaciones
 * (trigger → outbox → dispatcher, ya construido y validado): un INSERT en
 * `notifications` es todo lo que hace falta, el resto ya corre solo.
 *
 * Enruta por ROL (`role='super_admin'`), nunca por UUID hardcodeado — la
 * propia spec de soporte lo pide explícito (§6): "un assignee_id hardcodeado
 * se rompe el día que entre alguien más a soporte".
 */
async function notifyNewSupportTicket(ticketId: string, requesterId: string): Promise<void> {
    const [{ data: agents }, { data: requester }] = await Promise.all([
        supabase.from('profiles').select('id').eq('role', 'super_admin'),
        supabase.from('profiles').select('full_name, email').eq('id', requesterId).maybeSingle(),
    ]);

    const requesterLabel = (requester as any)?.full_name || (requester as any)?.email || 'Un usuario';
    const rows = (agents || []).map((a: any) => ({
        user_id: a.id,
        title: '🎧 Nuevo ticket de soporte',
        message: `${requesterLabel} escribió un nuevo caso de soporte.`,
        type: 'info',
        category: 'support',
        link: '/admin/support',
        data: { ticketId },
    }));
    if (rows.length) await supabase.from('notifications').insert(rows);
}

// ─── GET /api/v1/support/thread ───────────────────────────────────────────
// El hilo más reciente del usuario (cualquier estado) + sus mensajes no
// internos. null si nunca ha escrito.
router.get('/thread', async (req: AuthenticatedRequest, res: Response) => {
    const client = userClient(req);

    const { data: ticket, error: ticketErr } = await client
        .from('support_tickets')
        .select('id, status, subject, category, created_at, updated_at, first_response_at, resolved_at')
        .eq('requester_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (ticketErr) {
        req.log?.error({ err: ticketErr }, 'support/thread: error leyendo ticket');
        return res.status(500).json({ error: 'No se pudo cargar tu conversación de soporte.' });
    }
    if (!ticket) return res.json({ ticket: null, messages: [] });

    const { data: messages, error: msgErr } = await client
        .from('support_messages')
        .select('id, author_type, body, created_at')
        .eq('ticket_id', ticket.id)
        .order('created_at', { ascending: true });

    if (msgErr) {
        req.log?.error({ err: msgErr }, 'support/thread: error leyendo mensajes');
        return res.status(500).json({ error: 'No se pudo cargar tu conversación de soporte.' });
    }

    res.json({ ticket, messages: messages || [], feedback: await feedbackDelTicket(ticket.id).catch(() => ({})) });
});

// ─── POST /api/v1/support/open ────────────────────────────────────────────
// Devuelve el hilo abierto del usuario, o crea uno. Idempotente (RPC).
router.post('/open', async (req: AuthenticatedRequest, res: Response) => {
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.slice(0, 200) : null;
    const category = typeof req.body?.category === 'string' ? req.body.category : null;

    const client = userClient(req);
    const { data: ticketId, error } = await client.rpc('support_open_ticket', {
        p_subject: subject,
        p_category: category,
    });

    if (error) {
        req.log?.error({ err: error }, 'support/open: error creando/recuperando ticket');
        return res.status(400).json({ error: error.message || 'No se pudo abrir el ticket de soporte.' });
    }

    const { data: ticket } = await client
        .from('support_tickets')
        .select('id, status, subject, category, created_at, updated_at')
        .eq('id', ticketId)
        .maybeSingle();

    res.json({ ticket });
});

// ─── POST /api/v1/support/messages ────────────────────────────────────────
// { ticketId, body, internal? } → escribe el mensaje (RPC decide author_type
// por caller — `internal` del cliente se ignora del lado del servidor si
// quien escribe no es agente, la RPC ya lo hace) y, si quien escribió NO es
// agente, dispara el bot en la misma request. Responde con el/los mensaje(s)
// nuevos para que el frontend no tenga que hacer polling inmediato.
router.post('/messages', async (req: AuthenticatedRequest, res: Response) => {
    const ticketId = req.body?.ticketId as string | undefined;
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const internal = req.body?.internal === true;

    if (!ticketId || !body) {
        return res.status(400).json({ error: 'Indica ticketId y body.' });
    }
    if (body.length > 4000) {
        return res.status(400).json({ error: 'Mensaje demasiado largo.' });
    }

    const client = userClient(req);
    const { error: postErr } = await client.rpc('support_post_message', {
        p_ticket_id: ticketId,
        p_body: body,
        p_internal: internal,
    });

    if (postErr) {
        req.log?.error({ err: postErr, ticketId }, 'support/messages: error posteando mensaje');
        return res.status(400).json({ error: postErr.message || 'No se pudo enviar el mensaje.' });
    }

    // El bot solo responde a usuarios, nunca a mensajes de agente, y solo si
    // ningún agente ha tomado ya el hilo (chequeado dentro del servicio).
    if (req.role !== 'super_admin') {
        // Notificar al super_admin SOLO en el primer mensaje del ticket — evita
        // spam en cada follow-up de la misma conversación.
        const { count: userMsgCount } = await supabase
            .from('support_messages')
            .select('id', { count: 'exact', head: true })
            .eq('ticket_id', ticketId)
            .eq('author_type', 'user');
        if (userMsgCount === 1) {
            notifyNewSupportTicket(ticketId, req.user.id).catch((err) => {
                req.log?.error({ err, ticketId }, 'support/messages: notificación de ticket nuevo falló');
            });
        }

        // La escuela de Mapi es la ACTIVA de la sesión (x-school-id validado
        // contra school_members en requireAuth), nunca la del ticket:
        // support_open_ticket guarda la del último vínculo (joined_at) y es solo
        // informativa. Con esa, a quien está en dos escuelas Mapi le respondía
        // con los datos (pagos, equipos, módulos) de la otra (2026-11-14).
        try {
            await runSupportBotTurn({
                ticketId,
                requesterId: req.user.id,
                schoolId: req.schoolId || null,
            });
        } catch (err: any) {
            // El mensaje del usuario ya quedó guardado (S0 no depende del bot);
            // un fallo acá no debe tumbar la respuesta HTTP.
            req.log?.error({ err }, 'support/messages: el turno del bot falló');
        }

        // Correo a SportMaps por ticket nuevo. Va DESPUÉS del turno del bot a
        // propósito: así el correo ya dice si Mapi lo resolvió o lo pasó a
        // una persona, y un caso que escala en el primer mensaje genera UN
        // correo y no dos. El push de arriba no alcanza: nadie lo ve.
        if (userMsgCount === 1) {
            void avisarTicketSoportePorCorreo({ ticketId, origen: 'nuevo' }).catch(() => {});
        }
    }

    const [{ data: messages, error: fetchErr }, { data: ticket }] = await Promise.all([
        client
            .from('support_messages')
            .select('id, author_type, body, created_at')
            .eq('ticket_id', ticketId)
            .order('created_at', { ascending: true }),
        client.from('support_tickets').select('id, status, subject, category, updated_at').eq('id', ticketId).maybeSingle(),
    ]);

    if (fetchErr) {
        return res.status(500).json({ error: 'Mensaje enviado, pero no se pudo recargar la conversación.' });
    }

    res.json({ messages: messages || [], ticket, feedback: await feedbackDelTicket(ticketId).catch(() => ({})) });
});

// ─── POST /api/v1/support/feedback ────────────────────────────────────────
// { ticketId, messageId, util: boolean } → «¿Te sirvió?» de una respuesta de
// Mapi. «No» pasa el caso a waiting_human y manda el correo «[Revisar] …»
// (services/mapi-feedback.service). Responde como /messages para que el chat
// se redibuje sin otra llamada.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/feedback', async (req: AuthenticatedRequest, res: Response) => {
    const ticketId = req.body?.ticketId;
    const messageId = req.body?.messageId;
    const util = req.body?.util;
    if (typeof ticketId !== 'string' || typeof messageId !== 'string' || !UUID_RE.test(ticketId) || !UUID_RE.test(messageId) || typeof util !== 'boolean') {
        return res.status(400).json({ error: 'Indica ticketId, messageId y util.' });
    }

    // El ticket tiene que ser del que califica: se lee con SU cliente (RLS) y
    // además se compara el requester, por si un agente de soporte llama acá.
    const client = userClient(req);
    const { data: propio } = await client
        .from('support_tickets')
        .select('id, requester_id')
        .eq('id', ticketId)
        .maybeSingle();
    if (!propio || (propio as any).requester_id !== req.user.id) {
        return res.status(404).json({ error: 'No encontramos esa conversación.' });
    }

    try {
        const r = await calificarRespuesta({ ticketId, messageId, valor: util ? 'si' : 'no' });
        if (r === 'no_es_respuesta_de_mapi') return res.status(400).json({ error: 'Ese mensaje no es una respuesta de Mapi.' });
    } catch (err: any) {
        req.log?.error({ err, ticketId }, 'support/feedback: no se pudo guardar la calificación');
        return res.status(500).json({ error: 'No pudimos guardar tu respuesta. Intenta de nuevo.' });
    }

    const [{ data: messages }, { data: ticket }, feedback] = await Promise.all([
        client
            .from('support_messages')
            .select('id, author_type, body, created_at')
            .eq('ticket_id', ticketId)
            .order('created_at', { ascending: true }),
        client.from('support_tickets').select('id, status, subject, category, updated_at').eq('id', ticketId).maybeSingle(),
        feedbackDelTicket(ticketId).catch(() => ({})),
    ]);
    res.json({ messages: messages || [], ticket, feedback });
});

export default router;
