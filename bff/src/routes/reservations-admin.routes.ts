// bff/src/routes/reservations-admin.routes.ts
//
// Cancelar / reprogramar reservas desde la pestaña "Reservas" del owner
// (SchoolFacilitiesPage.tsx), con correo de confirmación al prospecto/socio.
// Cubre los dos tipos que esa pestaña mezcla en una sola tabla:
//   · facility_reservations — alquiler manual del owner (OwnerReservationModal).
//     Cancelar/reprogramar ya existía escribiendo Supabase DIRECTO desde el
//     navegador (sin BFF, sin correo). Se mueve acá solo para poder mandar
//     el correo del lado del servidor — el trigger de choque de horario
//     (trg_check_facility_overlap) ya protegía esto, no hizo falta RPC nueva.
//   · session_bookings de clases de cortesía (creadas en /agendar/:slug) —
//     cancelar solo cambiaba el status; reprogramar fecha/hora NO existía.
//     Ver migración 20260828232516_session_booking_reschedule_y_notificaciones.sql.
//
// "Eliminar" (borrado físico) también vive acá, no en el navegador: RLS
// bloquea a propósito el DELETE directo —
// session_bookings_delete_none (USING false) para cualquier authenticated, y
// facility_reservations solo deja borrar al propio autor con status='pending'.
// El botón "Eliminar" del frontend llamaba Supabase directo, la policy
// negaba la fila silenciosamente (DELETE sobre 0 filas no es un error) y el
// toast decía "eliminado" sin haber borrado nada. Acá sí se puede, con
// service_role, solo para owner/admin.
//
// Días permitidos por plan (offering_plans.allowed_days_of_week, D9 / F-F):
// lo que hace el staff/admin desde acá NO se valida contra esos días, a
// propósito — la escuela puede reprogramar o hacer una excepción. El 422
// day_not_allowed solo aplica a las reservas del atleta/acudiente
// (utils/planDayRules.ts).



import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole, auditLog } from '../middlewares/authMiddleware';
import { FACILITY_ADMIN_ROLES, isFacilityStaffRole } from '../utils/facilityRoles';
import { BrandedEmailTemplates } from '../utils/emailTemplates';
import { emailClient } from '../utils/emailClient';
import { zodBadRequest } from '../middlewares/reservationsInput';
import { dateYmd, timeHm, uuid, reasonField, EmptyBody, isoZoned, freeText } from '../utils/reservations.schemas';

const router = Router();

const requireOwnerOrAdmin = requireRole(...FACILITY_ADMIN_ROLES);

// Estados desde los que el staff puede cancelar / mover una reserva (contrato F1 §4 y §5).
// completed / no_show / expired / cancelled son históricos: no se tocan.
const CANCELLABLE_STATUSES = ['hold', 'pending', 'pending_payment', 'confirmed', 'pending_reconciliation'];
const RESCHEDULABLE_STATUSES = ['hold', 'pending', 'pending_payment', 'confirmed'];
const isUuid = (v: unknown) => z.string().uuid().safeParse(v).success;

const CancelSchema = z.strictObject({
    reason: reasonField.optional(),
});

const hmToMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const endAfterStart = (b: { start_time: string; end_time: string }) => hmToMin(b.end_time) > hmToMin(b.start_time);
const endMsg = { message: 'end_time debe ser posterior a start_time', path: ['end_time'] as PropertyKey[] };

const RescheduleFacilitySchema = z.strictObject({
    reservation_date: dateYmd,
    start_time: timeHm,
    end_time: timeHm,
}).refine(endAfterStart, endMsg);

const RescheduleCourtesySchema = z.strictObject({
    facility_availability_id: uuid('facility_availability_id'),
    date: dateYmd,
    start_time: timeHm,
    end_time: timeHm,
}).refine(endAfterStart, endMsg);

/** Query de los slots de cortesía: rango acotado (el bucle recorre día por día). */
const CourtesySlotsQuery = z.strictObject({
    facility_id: uuid('facility_id'),
    from: dateYmd,
    to: dateYmd,
}).refine((q) => q.to >= q.from, { message: 'to debe ser >= from', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 62, { message: 'El rango máximo es de 62 días', path: ['to'] });

/** Los PATCH/DELETE sin datos aceptan solo cuerpo vacío. */
function emptyBodyOr400(req: Request, res: Response): boolean {
    const p = EmptyBody.safeParse(req.body ?? {});
    if (!p.success) { zodBadRequest(res, p.error.issues); return false; }
    return true;
}

function dateLabel(d: string): string {
    return new Date(`${d}T00:00:00`).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
}

function timeLabel(t: string): string {
    return t?.slice(0, 5) ?? '';
}

// ── facility_reservations (alquiler manual del owner) ──────────────────────

// PATCH /api/v1/reservations-admin/facility/:id/cancel
router.patch('/facility/:id/cancel', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ error: 'Id de reserva inválido.' });
        const parsed = CancelSchema.safeParse(req.body ?? {});
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);

        const { data: resv, error: fetchErr } = await supabase
            .from('facility_reservations')
            .select('id, status, amount_paid, reservation_date, start_time, facility:facilities(id, name, school_id, min_cancellation_hours), requester:profiles!facility_reservations_user_id_fkey(full_name, email)')
            .eq('id', id)
            .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!resv || (resv.facility as any)?.school_id !== schoolId) {
            return res.status(404).json({ error: 'Reserva no encontrada.' });
        }

        // Guard de estado (QA T1): antes se podía «cancelar» una reserva completada / no_show / expirada
        // (reescribía el historial) y re-enviar el correo de una ya cancelada.
        if (resv.status === 'cancelled') return res.json({ success: true, already_cancelled: true, email_sent: false });
        if (!CANCELLABLE_STATUSES.includes(String(resv.status))) {
            return res.status(409).json({ error: 'Esta reserva ya no se puede cancelar.', reason: 'invalid_status', status: resv.status });
        }

        // Ventana mínima de cancelación: solo aplica a quien NO es staff (el staff
        // puede cancelar siempre). Hoy la ruta ya exige rol de staff, pero el
        // chequeo queda por si se abre a otros actores.
        if (!isFacilityStaffRole(req.role)) {
            const minH = Number((resv.facility as any)?.min_cancellation_hours ?? 0);
            const startMs = new Date(`${resv.reservation_date}T${String(resv.start_time).slice(0, 8)}-05:00`).getTime();
            if (minH > 0 && Number.isFinite(startMs) && startMs - Date.now() < minH * 3600 * 1000) {
                return res.status(409).json({
                    error: `Ya no puedes cancelar: faltan menos de ${minH} horas para la reserva. Comunícate con la escuela.`,
                    reason: 'cancellation_window_closed',
                    min_cancellation_hours: minH,
                });
            }
        }

        const { error: updErr } = await supabase
            .from('facility_reservations')
            // El staff cancela con devolución del 100 % (contrato F1 §4): si ya había plata, queda marcada para devolver a mano.
            .update({ status: 'cancelled', cancelled_by: req.user.id, cancellation_reason: parsed.data.reason ?? null, cancelled_at: new Date().toISOString(), refund_status: Number((resv as any).amount_paid) > 0 ? 'manual' : 'none' })
            .eq('id', id)
            .in('status', CANCELLABLE_STATUSES);
        if (updErr) throw updErr;
        await auditLog(req, 'facility_reservation_cancel_staff', 'facility_reservations', String(id),
            { status: resv.status, amount_paid: (resv as any).amount_paid }, { status: 'cancelled', reason: parsed.data.reason ?? null });

        let emailSent = false;
        const requesterEmail = (resv.requester as any)?.email;
        if (requesterEmail) {
            try {
                const { subject, html } = await BrandedEmailTemplates.reservationCancelled({
                    recipientName: (resv.requester as any)?.full_name || 'cliente',
                    facilityName: (resv.facility as any)?.name ?? '',
                    dateLabel: dateLabel(resv.reservation_date),
                    timeLabel: timeLabel(resv.start_time),
                    cancelReason: parsed.data.reason ?? null,
                    schoolId,
                });
                const sendResult = await emailClient.send({ to: requesterEmail, subject, html });
                emailSent = !!sendResult.success;
            } catch (emailErr) {
                req.log?.error({ err: emailErr, id }, 'reservations-admin: fallo enviando correo de cancelación');
            }
        }

        res.json({ success: true, email_sent: emailSent });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin facility cancel unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

const FACILITY_RESV_SELECT = '*, facility:facilities(id, school_id)';

// PATCH /api/v1/reservations-admin/facility/:id/approve   (pending -> confirmed)
router.patch('/facility/:id/approve', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!z.string().uuid().safeParse(id).success) return res.status(400).json({ error: 'Id de reserva inválido.' });
        if (!emptyBodyOr400(req, res)) return;

        const { data: resv, error: fetchErr } = await supabase
            .from('facility_reservations').select(FACILITY_RESV_SELECT).eq('id', id).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!resv || (resv.facility as any)?.school_id !== schoolId) {
            return res.status(404).json({ error: 'Reserva no encontrada.' });
        }
        if (resv.status !== 'pending') {
            return res.status(409).json({ error: 'Solo se pueden aprobar reservas pendientes.', reason: 'invalid_status', status: resv.status });
        }

        const now = new Date().toISOString();
        const { data: updated, error: updErr } = await supabase
            .from('facility_reservations')
            .update({ status: 'confirmed', approved_by: req.user.id, approved_at: now, updated_at: now })
            .eq('id', id)
            .eq('status', 'pending')
            .select()
            .maybeSingle();
        if (updErr) {
            if (updErr.message?.includes('facility_slot_conflict')) {
                return res.status(409).json({ error: 'Ese horario ya está ocupado por otra reserva.', reason: 'capacity_full' });
            }
            throw updErr;
        }
        if (!updated) {
            return res.status(409).json({ error: 'La reserva cambió de estado mientras la aprobabas. Recarga e intenta de nuevo.', reason: 'invalid_status' });
        }

        await auditLog(req, 'facility_reservation_approve', 'facility_reservations', String(id), { status: 'pending' }, { status: 'confirmed' });
        res.json({ success: true, reservation: updated });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin facility approve unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// PATCH /api/v1/reservations-admin/facility/:id/complete   (confirmed -> completed)
router.patch('/facility/:id/complete', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!z.string().uuid().safeParse(id).success) return res.status(400).json({ error: 'Id de reserva inválido.' });
        if (!emptyBodyOr400(req, res)) return;

        const { data: resv, error: fetchErr } = await supabase
            .from('facility_reservations').select(FACILITY_RESV_SELECT).eq('id', id).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!resv || (resv.facility as any)?.school_id !== schoolId) {
            return res.status(404).json({ error: 'Reserva no encontrada.' });
        }
        if (resv.status !== 'confirmed') {
            return res.status(409).json({ error: 'Solo se pueden completar reservas confirmadas.', reason: 'invalid_status', status: resv.status });
        }

        const { data: updated, error: updErr } = await supabase
            .from('facility_reservations')
            .update({ status: 'completed', updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('status', 'confirmed')
            .select()
            .maybeSingle();
        if (updErr) throw updErr;
        if (!updated) {
            return res.status(409).json({ error: 'La reserva cambió de estado mientras la completabas. Recarga e intenta de nuevo.', reason: 'invalid_status' });
        }

        await auditLog(req, 'facility_reservation_complete', 'facility_reservations', String(id), { status: 'confirmed' }, { status: 'completed' });
        res.json({ success: true, reservation: updated });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin facility complete unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// PATCH /api/v1/reservations-admin/facility/:id/reschedule
router.patch('/facility/:id/reschedule', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ error: 'Id de reserva inválido.' });
        const parsed = RescheduleFacilitySchema.safeParse(req.body ?? {});
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        const r = parsed.data;

        const { data: resv, error: fetchErr } = await supabase
            .from('facility_reservations')
            .select('id, facility:facilities(id, name, school_id), requester:profiles!facility_reservations_user_id_fkey(full_name, email)')
            .eq('id', id)
            .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!resv || (resv.facility as any)?.school_id !== schoolId) {
            return res.status(404).json({ error: 'Reserva no encontrada.' });
        }

        // Solo reservas vivas: mover una completed / cancelled / expired / no_show reescribe el historial
        // (y una cancelled movida «resucitaría» fecha y hora sin ocupar la franja).
        const { data: moved, error: updErr } = await supabase
            .from('facility_reservations')
            .update({
                reservation_date: r.reservation_date,
                start_time: r.start_time,
                end_time: r.end_time,
                updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .in('status', RESCHEDULABLE_STATUSES)
            .select('id');

        if (updErr) {
            if (updErr.message?.includes('facility_slot_conflict')) {
                return res.status(409).json({ error: 'Ese horario ya está ocupado por otra reserva.', reason: 'capacity_full' });
            }
            throw updErr;
        }
        if (!moved || moved.length === 0) {
            return res.status(409).json({ error: 'Esta reserva ya no se puede reprogramar.', reason: 'invalid_status' });
        }
        await auditLog(req, 'facility_reservation_reschedule_staff', 'facility_reservations', String(id), null,
            { reservation_date: r.reservation_date, start_time: r.start_time, end_time: r.end_time });

        let emailSent = false;
        const requesterEmail = (resv.requester as any)?.email;
        if (requesterEmail) {
            try {
                const { subject, html } = await BrandedEmailTemplates.reservationRescheduled({
                    recipientName: (resv.requester as any)?.full_name || 'cliente',
                    facilityName: (resv.facility as any)?.name ?? '',
                    dateLabel: dateLabel(r.reservation_date),
                    timeLabel: timeLabel(r.start_time),
                    schoolId,
                });
                const sendResult = await emailClient.send({ to: requesterEmail, subject, html });
                emailSent = !!sendResult.success;
            } catch (emailErr) {
                req.log?.error({ err: emailErr, id }, 'reservations-admin: fallo enviando correo de reprogramación');
            }
        }

        res.json({ success: true, email_sent: emailSent });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin facility reschedule unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── session_bookings de clases de cortesía (/agendar/:slug) ────────────────

async function resolveCourtesyRequester(bookingRow: any): Promise<{ name: string; email: string | null }> {
    if (bookingRow.unregistered_athlete_id) {
        const { data } = await supabase.from('unregistered_athletes').select('full_name, email').eq('id', bookingRow.unregistered_athlete_id).maybeSingle();
        return { name: data?.full_name || 'Invitado', email: data?.email ?? null };
    }
    if (bookingRow.child_id) {
        const { data: child } = await supabase.from('children').select('full_name, parent_id').eq('id', bookingRow.child_id).maybeSingle();
        const { data: parent } = child?.parent_id
            ? await supabase.from('profiles').select('email').eq('id', child.parent_id).maybeSingle()
            : { data: null as any };
        return { name: child?.full_name || 'Estudiante', email: parent?.email ?? null };
    }
    if (bookingRow.user_id) {
        const { data } = await supabase.from('profiles').select('full_name, email').eq('id', bookingRow.user_id).maybeSingle();
        return { name: data?.full_name || 'Usuario', email: data?.email ?? null };
    }
    return { name: 'Usuario', email: null };
}

// GET /api/v1/reservations-admin/courtesy/slots?facility_id=&from=&to=
// Slots libres SOLO por cancha (sin coach) — para el picker de reprogramar.
router.get('/courtesy/slots', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const qParsed = CourtesySlotsQuery.safeParse(req.query);
        if (!qParsed.success) return zodBadRequest(res, qParsed.error.issues);
        const { facility_id, from, to } = qParsed.data;

        const { data: facility } = await supabase
            .from('facilities')
            .select('id')
            .eq('id', facility_id)
            .eq('school_id', schoolId)
            .maybeSingle();
        if (!facility) return res.status(404).json({ error: 'Instalación no encontrada.' });

        const { data: availData } = await supabase
            .from('facility_availability')
            .select('id, day_of_week, start_time, end_time, max_group_capacity')
            .eq('facility_id', facility_id);

        const { data: existingSessions } = await supabase
            .from('attendance_sessions')
            .select('facility_availability_id, session_date, id')
            .eq('facility_id', facility_id)
            .gte('session_date', from)
            .lte('session_date', to);

        const bookedSessionIds = (existingSessions || []).map((s: any) => s.id);
        const { data: activeCounts } = bookedSessionIds.length
            ? await supabase.from('session_bookings').select('session_id').in('session_id', bookedSessionIds).neq('status', 'cancelled')
            : { data: [] as any[] };

        const countBySession: Record<string, number> = {};
        (activeCounts || []).forEach((b: any) => { countBySession[b.session_id] = (countBySession[b.session_id] ?? 0) + 1; });

        const sessionByAvailDate: Record<string, { id: string; count: number }> = {};
        (existingSessions || []).forEach((s: any) => {
            sessionByAvailDate[`${s.facility_availability_id}_${s.session_date}`] = { id: s.id, count: countBySession[s.id] ?? 0 };
        });

        const fromDate = new Date(`${from}T00:00:00Z`);
        const toDate = new Date(`${to}T00:00:00Z`);
        const slots: any[] = [];
        for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            const dbDay = d.getUTCDay();
            for (const avail of (availData || []).filter((a: any) => a.day_of_week === dbDay)) {
                const existing = sessionByAvailDate[`${avail.id}_${dateStr}`];
                const max = avail.max_group_capacity ?? 10;
                const current = existing?.count ?? 0;
                if (current >= max) continue;
                slots.push({
                    facility_availability_id: avail.id,
                    slot_date: dateStr,
                    slot_start_time: avail.start_time,
                    slot_end_time: avail.end_time,
                    available_spots: max - current,
                });
            }
        }

        res.json(slots);
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin courtesy slots unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// PATCH /api/v1/reservations-admin/courtesy/:id/cancel
router.patch('/courtesy/:id/cancel', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ error: 'Id de reserva inválido.' });
        const parsed = CancelSchema.safeParse(req.body ?? {});
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);

        const { data: booking, error: fetchErr } = await supabase
            .from('session_bookings')
            .select('id, user_id, child_id, unregistered_athlete_id, session:attendance_sessions(session_date, start_time, facility:facilities(name))')
            .eq('id', id)
            .eq('school_id', schoolId)
            .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!booking) return res.status(404).json({ error: 'Reserva no encontrada.' });

        const { error: updErr } = await supabase
            .from('session_bookings')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('id', id);
        if (updErr) throw updErr;

        const requester = await resolveCourtesyRequester(booking);
        let emailSent = false;
        if (requester.email) {
            try {
                const session = booking.session as any;
                const { subject, html } = await BrandedEmailTemplates.reservationCancelled({
                    recipientName: requester.name,
                    facilityName: session?.facility?.name ?? '',
                    dateLabel: dateLabel(session?.session_date ?? ''),
                    timeLabel: timeLabel(session?.start_time ?? ''),
                    cancelReason: parsed.data.reason ?? null,
                    schoolId,
                });
                const sendResult = await emailClient.send({ to: requester.email, subject, html });
                emailSent = !!sendResult.success;
            } catch (emailErr) {
                req.log?.error({ err: emailErr, id }, 'reservations-admin: fallo enviando correo de cancelación (cortesía)');
            }
        }

        res.json({ success: true, email_sent: emailSent });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin courtesy cancel unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// PATCH /api/v1/reservations-admin/courtesy/:id/reschedule
router.patch('/courtesy/:id/reschedule', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ error: 'Id de reserva inválido.' });
        const parsed = RescheduleCourtesySchema.safeParse(req.body ?? {});
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        const r = parsed.data;

        const { data: booking, error: fetchErr } = await supabase
            .from('session_bookings')
            .select('id, user_id, child_id, unregistered_athlete_id')
            .eq('id', id)
            .eq('school_id', schoolId)
            .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!booking) return res.status(404).json({ error: 'Reserva no encontrada.' });

        const { data: rpcData, error: rpcErr } = await supabase.rpc('session_booking_reschedule', {
            p_id: id,
            p_school_id: schoolId,
            p_facility_availability_id: r.facility_availability_id,
            p_new_date: r.date,
            p_new_start_time: r.start_time,
            p_new_end_time: r.end_time,
        });

        if (rpcErr) {
            if (rpcErr.message?.includes('CAPACITY_FULL')) {
                return res.status(409).json({ error: 'Este horario ya alcanzó su cupo máximo.', reason: 'capacity_full' });
            }
            return res.status(409).json({ error: rpcErr.message });
        }

        const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
        const { data: facility } = row?.facility_id
            ? await supabase.from('facilities').select('name').eq('id', row.facility_id).maybeSingle()
            : { data: null as any };

        const requester = await resolveCourtesyRequester(booking);
        let emailSent = false;
        if (requester.email) {
            try {
                const { subject, html } = await BrandedEmailTemplates.reservationRescheduled({
                    recipientName: requester.name,
                    facilityName: facility?.name ?? '',
                    dateLabel: dateLabel(r.date),
                    timeLabel: timeLabel(r.start_time),
                    schoolId,
                });
                const sendResult = await emailClient.send({ to: requester.email, subject, html });
                emailSent = !!sendResult.success;
            } catch (emailErr) {
                req.log?.error({ err: emailErr, id }, 'reservations-admin: fallo enviando correo de reprogramación (cortesía)');
            }
        }

        res.json({ success: true, email_sent: emailSent });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin courtesy reschedule unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── Eliminar (borrado físico) — ver nota arriba: RLS lo bloquea a propósito
// para authenticated, así que solo funciona desde acá (service_role) ────────

// DELETE /api/v1/reservations-admin/facility/:id
router.delete('/facility/:id', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ error: 'Id de reserva inválido.' });
        if (!emptyBodyOr400(req, res)) return;

        const { data: resv, error: fetchErr } = await supabase
            .from('facility_reservations')
            .select('*, facility:facilities(school_id)')
            .eq('id', id)
            .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!resv || (resv.facility as any)?.school_id !== schoolId) {
            return res.status(404).json({ error: 'Reserva no encontrada.' });
        }

        const { error: delErr } = await supabase.from('facility_reservations').delete().eq('id', id);
        if (delErr) throw delErr;

        // Rastro del borrado físico: quién, cuándo (created_at del log) y qué fila
        // se perdió (snapshot completo en old_value de security_audit_log).
        const { facility: _fac, ...snapshot } = resv as any;
        await auditLog(req, 'facility_reservation_delete', 'facility_reservations', String(id), snapshot, null);
        req.log?.warn({ reservationId: id, schoolId, actor: req.user.id, role: req.role, status: snapshot.status }, 'reservations-admin: reserva eliminada físicamente');

        res.json({ success: true });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin facility delete unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// DELETE /api/v1/reservations-admin/courtesy/:id
router.delete('/courtesy/:id', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ error: 'Id de reserva inválido.' });

        const { data: booking, error: fetchErr } = await supabase
            .from('session_bookings')
            .select('id')
            .eq('id', id)
            .eq('school_id', schoolId)
            .maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!booking) return res.status(404).json({ error: 'Reserva no encontrada.' });

        const { error: delErr } = await supabase.from('session_bookings').delete().eq('id', id);
        if (delErr) throw delErr;
        await auditLog(req, 'session_booking_delete', 'session_bookings', String(id), { id }, null);

        res.json({ success: true });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin courtesy delete unhandled error');
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── Bloqueos internos de cancha (facility_blackouts) ───────────────────────
// Reemplaza el «Bloqueo interno» que el dueño insertaba directo en facility_reservations desde el
// navegador. La tabla facility_blackouts escribe la ocupación 'blackout' con trigger; si choca con
// una reserva vigente el trigger falla con 23P01 BLACKOUT_OVERLAPS_OCCUPANCY (-> 409 aquí).
// Solo roles administrativos de la escuela dueña de la cancha (requireOwnerOrAdmin); escribe service_role.

const BLACKOUT_KINDS = ['maintenance', 'weather', 'closed', 'other'] as const;
const MAX_BLACKOUT_MS = 365 * 24 * 3600_000;

const BlackoutCreateSchema = z.strictObject({
    facility_id: uuid('facility_id'),
    starts_at: isoZoned,
    ends_at: isoZoned,
    kind: z.enum(BLACKOUT_KINDS).default('maintenance'),
    reason: freeText(200).optional(),
}).refine((b) => Date.parse(b.ends_at) > Date.parse(b.starts_at), { message: 'ends_at debe ser posterior a starts_at', path: ['ends_at'] })
  .refine((b) => Date.parse(b.ends_at) - Date.parse(b.starts_at) <= MAX_BLACKOUT_MS, { message: 'El bloqueo no puede durar más de 365 días', path: ['ends_at'] });

const dateOrIso = z.union([dateYmd, isoZoned]);
const BlackoutListQuery = z.strictObject({
    facility_id: uuid('facility_id').optional(),
    from: dateOrIso.optional(),
    to: dateOrIso.optional(),
});

const BLACKOUT_COLS = 'id, school_id, facility_id, starts_at, ends_at, kind, reason, created_by, created_at';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// POST /api/v1/reservations-admin/blackouts
router.post('/blackouts', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const parsed = BlackoutCreateSchema.safeParse(req.body ?? {});
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        const b = parsed.data;

        const { data: fac, error: facErr } = await supabase
            .from('facilities').select('id, school_id').eq('id', b.facility_id).maybeSingle();
        if (facErr) throw facErr;
        if (!fac || (fac as any).school_id !== schoolId) return res.status(404).json({ error: 'Cancha no encontrada.', code: 'FACILITY_NOT_FOUND' });

        const { data: row, error } = await supabase
            .from('facility_blackouts')
            .insert({ facility_id: b.facility_id, school_id: schoolId, starts_at: b.starts_at, ends_at: b.ends_at, kind: b.kind, reason: b.reason || null, created_by: req.user.id })
            .select(BLACKOUT_COLS)
            .single();
        if (error) {
            if ((error as any).code === '23P01' || String(error.message).includes('BLACKOUT_OVERLAPS_OCCUPANCY')) {
                return res.status(409).json({
                    error: 'Ya hay una reserva vigente en ese horario. Cancela o reprograma la reserva antes de bloquear la cancha.',
                    code: 'BLACKOUT_OVERLAPS_OCCUPANCY', reason: 'blackout_overlaps_occupancy',
                });
            }
            if ((error as any).code === '23514') {
                return res.status(422).json({ error: 'El rango del bloqueo no es válido.', code: 'INVALID_RANGE' });
            }
            throw error;
        }
        await auditLog(req, 'facility_blackout_create', 'facility_blackouts', String((row as any).id), null,
            { facility_id: b.facility_id, starts_at: b.starts_at, ends_at: b.ends_at, kind: b.kind, reason: b.reason ?? null });
        return res.status(201).json({ blackout: row });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin blackout create unhandled error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// GET /api/v1/reservations-admin/blackouts?facility_id=&from=&to=
router.get('/blackouts', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const parsed = BlackoutListQuery.safeParse(req.query);
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        const q = parsed.data;
        let query = supabase.from('facility_blackouts').select(BLACKOUT_COLS).eq('school_id', schoolId).order('starts_at', { ascending: true }).limit(500);
        if (q.facility_id) query = query.eq('facility_id', q.facility_id);
        if (q.from) query = query.gt('ends_at', YMD.test(q.from) ? q.from + 'T00:00:00-05:00' : q.from);
        if (q.to) query = query.lt('starts_at', YMD.test(q.to) ? q.to + 'T23:59:59-05:00' : q.to);
        const { data, error } = await query;
        if (error) throw error;
        return res.json({ blackouts: data ?? [] });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin blackout list unhandled error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// DELETE /api/v1/reservations-admin/blackouts/:id
router.delete('/blackouts/:id', requireAuth, requireOwnerOrAdmin, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ error: 'Id de bloqueo inválido.' });
        if (!emptyBodyOr400(req, res)) return;
        const { data: row, error: fetchErr } = await supabase
            .from('facility_blackouts').select(BLACKOUT_COLS).eq('id', id).maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!row || (row as any).school_id !== schoolId) return res.status(404).json({ error: 'Bloqueo no encontrado.', code: 'BLACKOUT_NOT_FOUND' });
        const { error: delErr } = await supabase.from('facility_blackouts').delete().eq('id', id).eq('school_id', schoolId);
        if (delErr) throw delErr;
        await auditLog(req, 'facility_blackout_delete', 'facility_blackouts', String(id), row as any, null);
        return res.json({ success: true });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations-admin blackout delete unhandled error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

export default router;
