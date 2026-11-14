/**
 * payment-lifecycle-emails.job — dos correos automáticos del ciclo de cobro,
 * apagados por defecto (`school_settings.charge_notifications_enabled`):
 *
 *   1. sendChargeCreatedEmails(): el cobro del mes ya está disponible.
 *      Dispara por *polling*, no desde dentro de `open_month()` — cubre
 *      tanto la apertura manual (botón) como el cron `auto_generate_payments`
 *      sin acoplarse a ninguna de las dos (ambas terminan en la misma fila
 *      `payments` con `charge_notice_sent_at IS NULL`).
 *   2. sendOverdueNoticeEmails(): el pago pasó los días de gracia y sigue sin
 *      pagarse. Corre después de `apply_late_fees()` (pg_cron), que es quien
 *      marca `status='overdue'` — este job solo agrega el correo.
 *
 * Ninguno de los dos reemplaza al `send_payment_reminders` in-app existente
 * (previo al vencimiento, gateado por `reminder_enabled`) — son momentos y
 * canales distintos.
 *
 * Idempotencia por CLAIM: se marca `*_notice_sent_at` inmediatamente después
 * de intentar el envío (falle o no) — mismo trade-off ya aceptado en
 * `glosa-notifications.job.ts`: se prioriza no duplicar sobre garantizar
 * entrega. Antes de enviar, se excluyen los cobros que
 * `duplicatePayerGuard` marca como ya pagados bajo una ficha gemela del
 * mismo atleta (el bug real que le llegó a familias al día en Dynasty,
 * ago-2026, cuando el envío era manual y sin este filtro).
 *
 * WhatsApp primero (2026-10-04). Antes de cada correo se intenta la plantilla
 * de Meta APROBADA en la WABA de la escuela (whatsapp-plantillas.service). Si
 * sale, no va el correo (dos avisos del mismo cobro es ruido). Si no — sin
 * plantilla aprobada, sin opt-in, sin enlace — va el correo como siempre. La
 * única excepción es 'fuera_de_horario' en el aviso de cobro: ese cobro se deja
 * sin reclamar y lo toma el siguiente tick de 15 min dentro del horario.
 *
 * Convivencia con el ESTADO DE CUENTA mensual (2026-10-05,
 * services/estado-de-cuenta.service): mientras el de una escuela esté
 * pendiente en el mes, sus avisos de aquí se posponen sin reclamar (el estado
 * de cuenta los incluye y estampa *_notice_sent_at); y a quien ya recibió el
 * estado de cuenta HOY no se le manda nada más hoy (Ley 2300: 1 contacto/día).
 *
 * Cadencia de recordatorios (2026-10-06, services/recordatorios-cobro.service):
 * quien recibió hoy un recordatorio de la cadencia tampoco recibe aviso aquí, y
 * la cadencia estampa charge/overdue_notice_sent_at de lo que manda, así este
 * job no repite ese momento por correo.
 */

import { supabase } from '../config/supabase';
import { COLUMNAS_CONTACTO_FICHA, COLUMNAS_CONTACTO_HIJO, contactoDeFicha, contactoDeHijoSinCuenta, type FichaContacto } from '../services/contacto-acudiente';
import { emailClient } from '../utils/emailClient';
import { BrandedEmailTemplates } from '../utils/emailTemplates';
import { findDuplicatePaymentIds } from '../services/duplicatePayerGuard.service';
import {
    enviarCobroPorPlantilla, dentroDeHorarioDeCobranza, aWaId, type ConceptoCobro, type MotivoNoEnvio,
} from '../services/whatsapp-plantillas.service';
import { emitirTokenCobro } from '../services/cobro-enlace-publico.service';
import { contactosConEstadoDeCuentaHoy, escuelasConEstadoPendiente } from '../services/estado-de-cuenta.service';
import { contactosConRecordatorioHoy } from '../services/recordatorios-cobro.service';
import { esCobroUnico, etiquetaDeCobro } from '../services/payment-accounts';
import { desgloseMora, montoConMora } from '../utils/desglose-mora';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.sportmaps.co';

const fmtCop = (n?: number | null) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

const fmtDate = (d?: string | null) =>
    d ? new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

interface PaymentRow {
    id: string;
    school_id: string;
    amount: number;
    due_date: string | null;
    concept: string | null;
    parent_id: string | null;
    child_id: string | null;
    user_id: string | null;
    unregistered_athlete_id: string | null;
    period_year: number | null;
    period_month: number | null;
    payment_category?: string | null;
    payment_type?: string | null;
    /** Recargo por mora que apply_late_fees ya sumó DENTRO de `amount` (0 si no hay). */
    late_fee_amount?: number | string | null;
}

/**
 * Desglose para el correo de un cobro con mora («Mensualidad $X · Recargo por
 * mora $Y · Total $Z»), o null si no tiene. `amount` ya trae la mora.
 */
export function moraParaCorreo(p: Pick<PaymentRow, 'amount' | 'late_fee_amount'>): { base: string; fee: string } | null {
    const d = desgloseMora(Number(p.amount), p.late_fee_amount);
    return d ? { base: fmtCop(d.mensualidad), fee: fmtCop(d.recargo) } : null;
}

/**
 * Cobros ÚNICOS (inscripción, seguro, artículos… — categoría explícita distinta
 * de mensualidad, ver esCobroUnico) en el aviso de VENCIDO (2026-10-10):
 *   · NO van por WhatsApp: todas las plantillas aprobadas de cobro dicen «la
 *     mensualidad de …» (pago_pendiente_suave, pago_recordatorio_previo_v*), así
 *     que a un seguro vencido le llegaba «quedó pendiente la mensualidad».
 *     Va el correo, que sí nombra el cobro.
 *   · El aviso de COBRO GENERADO sigue siendo solo de mensualidades
 *     (payment_type 'subscription'): los cobros únicos del alta nacen junto con
 *     la mensualidad y sumarlos aquí mandaría hasta tres correos el mismo día
 *     a la misma familia (Ley 2300: 1 contacto/día). La familia los ve en Mis
 *     Pagos, en la página /p/:token del cobro (lista «otros pendientes») y en el
 *     estado de cuenta mensual, que ya los incluye.
 */
export function avisoDeCobroUnico(p: Pick<PaymentRow, 'payment_category' | 'concept' | 'payment_type'>): string | null {
    return esCobroUnico(p.payment_category) ? etiquetaDeCobro(p) : null;
}

interface Resolved {
    contactName: string;
    contactEmail: string | null;
    athleteName: string;
    /** Mismo orden que template-renderer: perfil → teléfono temporal del menor → no registrado. */
    contactPhone: string | null;
    contactProfileId: string | null;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "octubre 2026": periodo facturado; si el cobro no lo trae, el mes del vencimiento. */
export function periodoDe(p: Pick<PaymentRow, 'period_year' | 'period_month' | 'due_date'>): string | null {
    if (p.period_year && p.period_month) return `${MESES[p.period_month - 1]} ${p.period_year}`;
    if (!p.due_date) return null;
    const d = new Date(`${p.due_date.slice(0, 10)}T12:00:00Z`);
    return `${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "5 de octubre" — mismo formato que los ejemplos que Meta aprobó. */
export function fechaCorta(d?: string | null): string | null {
    if (!d) return null;
    const f = new Date(`${d.slice(0, 10)}T12:00:00Z`);
    return `${f.getUTCDate()} de ${MESES[f.getUTCMonth()]}`;
}

/**
 * Token del botón https://sportmaps.co/p/{token}.
 *
 * La ruta pública existe desde el 2026-10-04: GET /api/v1/public/cobro/:token
 * (BFF) + página /p/:token (frontend) + redirect sportmaps.co/p/* → app (landing).
 * El token lo emite/reusa la RPC cobro_enlace_publico_emitir (uno por cobro, 30
 * días, se rota cuando le quedan < 7). Si la RPC falla —p.ej. la migración
 * 20261004083707 aún no está aplicada— devuelve null y, como antes,
 * enviarCobroPorPlantilla responde 'sin_enlace' y sale el correo.
 */
async function tokenDelBoton(paymentId: string): Promise<string | null> {
    return emitirTokenCobro(paymentId);
}

/** Nombres de escuela del lote (las variables {{2}}/{{3}} los necesitan). */
async function schoolNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data } = await supabase.from('schools').select('id, name').in('id', ids);
    return new Map(((data as any[]) || []).map((s) => [s.id, s.name]));
}

/** Intenta el cobro por WhatsApp; si no sale, devuelve el motivo para que el llamador decida. */
async function tryWhatsApp(
    p: PaymentRow, contact: Resolved | undefined, schoolName: string | undefined, concepto: ConceptoCobro,
): Promise<{ sent: true } | { sent: false; motivo: MotivoNoEnvio }> {
    if (!contact) return { sent: false, motivo: 'telefono_invalido' };
    const r = await enviarCobroPorPlantilla({
        schoolId: p.school_id,
        concepto,
        telefono: contact.contactPhone,
        tokenBoton: await tokenDelBoton(p.id),
        paymentId: p.id,
        parentId: contact.contactProfileId,
        datos: {
            nombreContacto: contact.contactName,
            nombreAtleta: contact.athleteName,
            nombreEscuela: schoolName || '',
            periodo: periodoDe(p),
            fechaVencimiento: fechaCorta(p.due_date),
            // Con mora: «$165.000, que incluye $15.000 de recargo por mora».
            monto: montoConMora(Number(p.amount), p.late_fee_amount, fmtCop),
        },
    });
    return r.enviado ? { sent: true } : { sent: false, motivo: r.motivo };
}

const contarMotivo = (m: Record<string, number>, k: string) => { m[k] = (m[k] || 0) + 1; };

/**
 * Filtro de convivencia con el estado de cuenta. Devuelve si este cobro debe
 * esperar (no se reclama: lo toma un tick posterior o lo estampa el estado de
 * cuenta). Exportado para las pruebas.
 */
export function creaFiltroEstadoDeCuenta(ahora: Date) {
    let pospuestas: Set<string> | null = null;
    const hoyPorEscuela = new Map<string, Set<string>>();
    return {
        async inicializar(schoolIds: string[]) {
            pospuestas = await escuelasConEstadoPendiente(schoolIds, ahora).catch(() => new Set<string>());
        },
        async debeEsperar(p: { school_id: string }, c: Resolved | undefined): Promise<'estado_pendiente' | 'estado_hoy' | null> {
            if (pospuestas?.has(p.school_id)) return 'estado_pendiente';
            if (!c) return null;
            if (!hoyPorEscuela.has(p.school_id)) {
                // Estado de cuenta de hoy + recordatorio de la cadencia de hoy
                // (recordatorios-cobro.service): ambos cuentan como EL contacto del día.
                const [estado, recordatorio] = await Promise.all([
                    contactosConEstadoDeCuentaHoy(p.school_id, ahora).catch(() => new Set<string>()),
                    contactosConRecordatorioHoy(p.school_id, ahora).catch(() => new Set<string>()),
                ]);
                hoyPorEscuela.set(p.school_id, new Set([...estado, ...recordatorio]));
            }
            const hoy = hoyPorEscuela.get(p.school_id)!;
            if (hoy.size === 0) return null;
            const email = String(c.contactEmail ?? '').trim().toLowerCase();
            const wa = aWaId(c.contactPhone);
            if ((email && hoy.has(email)) || (wa && hoy.has(`wa:${wa}`))) return 'estado_hoy';
            return null;
        },
    };
}

/**
 * Registro en email_sends de los dos correos de este job — mismo patrón que
 * las invitaciones (`invitations.routes.ts`) y `avisos-correo.service.ts`:
 * antes de esto, `emailClient.send(...)` se llamaba y su resultado se tiraba,
 * así que `charge_notice_sent_at`/`overdue_notice_sent_at` quedaban marcados
 * aunque el correo nunca saliera (o no hubiera ni correo que intentar). Con
 * esto, "¿de verdad le llegó?" se responde con un SELECT a email_sends
 * filtrando por `batch_id = payment.id`, igual que hoy se hace por
 * `invitation_id`. No cambia la idempotencia (sigue en claimNotice): esto
 * solo deja rastro de lo que pasó con el intento ya reclamado.
 */
async function logEmailSend(p: {
    schoolId: string;
    paymentId: string;
    tipo: 'cobro_generado' | 'pago_vencido';
    to: string | null;
    resultado?: { success?: boolean; data?: any; error?: any };
}): Promise<void> {
    try {
        const exito = !!p.to && p.resultado?.success !== false;
        const messageId = p.resultado?.data?.id ?? p.resultado?.data?.data?.id ?? null;
        await supabase.from('email_sends').insert({
            school_id: p.schoolId,
            to_email: p.to || '(sin correo de contacto)',
            email_type: p.tipo,
            provider: 'resend',
            provider_message_id: messageId,
            status: exito ? 'sent' : 'failed',
            error: exito ? null : (p.to
                ? recortarError(p.resultado?.error)
                : 'sin correo de contacto resuelto para este pago'),
            batch_id: p.paymentId,
        });
    } catch (e: unknown) {
        // El log nunca debe tumbar el envío real.
        console.warn('[payment-lifecycle] no se pudo registrar email_sends', { paymentId: p.paymentId, e });
    }
}

function recortarError(err: unknown): string {
    const s = typeof err === 'string' ? err : JSON.stringify(err ?? 'error desconocido');
    return s.length > 1000 ? `${s.slice(0, 997)}…` : s;
}

type NoticeColumn = 'charge_notice_sent_at' | 'overdue_notice_sent_at';

/**
 * Reclama el aviso ANTES de enviarlo: UPDATE condicional (`IS NULL`) que solo
 * gana un proceso. Los tres BFF (dev/stg/prod) corren este job a la misma hora
 * contra la misma base; con leer → enviar → marcar, los tres leían la misma
 * lista y cada familia recibía el correo hasta tres veces.
 */
async function claimNotice(paymentId: string, column: NoticeColumn): Promise<boolean> {
    const { data, error } = await supabase
        .from('payments')
        .update({ [column]: new Date().toISOString() })
        .eq('id', paymentId)
        .is(column, null)
        .select('id');
    if (error) {
        console.warn('[payment-lifecycle] no se pudo reclamar el aviso', { paymentId, column, error: error.message });
        return false;
    }
    return (data?.length ?? 0) > 0;
}

async function releaseNotice(paymentId: string, column: NoticeColumn): Promise<void> {
    await supabase.from('payments').update({ [column]: null }).eq('id', paymentId);
}

/** Contactos de un lote de pagos, mismo criterio que payment-reminders.ts:
 * menor → acudiente (parent_id → profiles, o el parent_*_temp que cargó la
 * escuela si aún no tiene cuenta); adulto → user_id → profiles; ficha sin cuenta
 * → contactoDeFicha: si es MENOR, el ACUDIENTE (guardian_*), nunca el niño (H-06). */
export async function resolveContacts(payments: PaymentRow[]): Promise<Map<string, Resolved>> {
    const parentIds = [...new Set(payments.map(p => p.parent_id || p.user_id).filter(Boolean))] as string[];
    const childIds = [...new Set(payments.map(p => p.child_id).filter(Boolean))] as string[];
    const unregIds = [...new Set(payments.map(p => p.unregistered_athlete_id).filter(Boolean))] as string[];

    const [{ data: profiles }, { data: children }, { data: unregistered }] = await Promise.all([
        parentIds.length ? supabase.from('profiles').select('id, full_name, email, phone').in('id', parentIds) : Promise.resolve({ data: [] as any[] }),
        childIds.length ? supabase.from('children').select(`id, ${COLUMNAS_CONTACTO_HIJO}`).in('id', childIds) : Promise.resolve({ data: [] as any[] }),
        unregIds.length ? supabase.from('unregistered_athletes').select(`id, ${COLUMNAS_CONTACTO_FICHA}`).in('id', unregIds) : Promise.resolve({ data: [] as any[] }),
    ]);

    const profileMap = new Map((profiles || []).map(p => [p.id, p]));
    const childMap = new Map((children || []).map(c => [c.id, c]));
    const unregMap = new Map((unregistered || []).map(u => [u.id, u]));

    const out = new Map<string, Resolved>();
    for (const p of payments) {
        const profile = profileMap.get(p.parent_id || p.user_id || '');
        const child = childMap.get(p.child_id || '');
        const unreg = unregMap.get(p.unregistered_athlete_id || '');
        out.set(p.id, contactoDePago(profile as any, child as any, unreg as any));
    }
    return out;
}

/**
 * Contacto de UN cobro a partir de lo ya leído. Exportado para probarlo con
 * datos del gemelo (bff/test/integration/monster-contacto-acudiente.test.ts).
 */
export function contactoDePago(
    profile: { id?: string | null; full_name?: string | null; email?: string | null; phone?: string | null } | null | undefined,
    child: { full_name?: string | null; parent_name_temp?: string | null; parent_email_temp?: string | null; parent_phone_temp?: string | null } | null | undefined,
    unreg: FichaContacto | null | undefined,
): Resolved {
    const hijo = child ? contactoDeHijoSinCuenta(child) : null;
    const ficha = unreg ? contactoDeFicha(unreg) : null;
    return {
        contactName: profile?.full_name || hijo?.nombre || ficha?.nombre || 'Familia',
        contactEmail: profile?.email || hijo?.email || ficha?.email || null,
        athleteName: child?.full_name || unreg?.full_name || 'tu deportista',
        contactPhone: profile?.phone || hijo?.phone || ficha?.phone || null,
        contactProfileId: profile?.id || null,
    };
}

async function enabledSchoolIds(tipo: 'generado' | 'vencido' = 'generado'): Promise<string[]> {
    const { data } = await supabase
        .from('school_settings')
        .select('school_id')
        .eq('charge_notifications_enabled', true);
    const ids = (data || []).map(r => r.school_id);
    if (ids.length === 0) return ids;
    // Cada aviso tiene su propio interruptor (la escuela decide su cobranza):
    //   generado → charge_created_notice_enabled · vencido → overdue_notices_enabled.
    // Si la columna aún no existe (migración sin aplicar) no se excluye a nadie.
    const columna = tipo === 'vencido' ? 'overdue_notices_enabled' : 'charge_created_notice_enabled';
    const { data: apagadas, error } = await supabase
        .from('school_settings')
        .select('school_id')
        .eq(columna, false)
        .in('school_id', ids);
    if (error) return ids;
    const fuera = new Set((apagadas || []).map(r => r.school_id));
    return ids.filter(id => !fuera.has(id));
}

async function filterOutDuplicates(payments: PaymentRow[]): Promise<PaymentRow[]> {
    const bySchool = new Map<string, PaymentRow[]>();
    for (const p of payments) {
        if (!bySchool.has(p.school_id)) bySchool.set(p.school_id, []);
        bySchool.get(p.school_id)!.push(p);
    }
    const excluded = new Set<string>();
    for (const [schoolId, rows] of bySchool) {
        const ids = await findDuplicatePaymentIds(schoolId, rows);
        ids.forEach(id => excluded.add(id));
    }
    return payments.filter(p => !excluded.has(p.id));
}

/**
 * Horario de cobranza (Ley 2300 de 2023) también para el CORREO, no solo para
 * WhatsApp. Antes solo la plantilla lo respetaba y el correo de respaldo salía
 * a cualquier hora: con `auto_generate_payments` el cron abre el mes a las
 * 01:30 COT del día 1 (el 1-nov-2026 es domingo y el 2 es festivo), y el tick
 * de las 01:45 mandaba el correo de madrugada a toda familia sin WhatsApp.
 * Fuera de horario no se reclama nada: el primer tick dentro del horario
 * procesa la cola completa, así que nada se pierde, solo se corre.
 */
export function puedeAvisarCobranzaAhora(ahora: Date = new Date()): boolean {
    return dentroDeHorarioDeCobranza(ahora);
}

/**
 * Cobros creados por el modal «Cobros y pagos» SIN «Avisar a las familias»
 * (spec cobros-multiples I21, Q9): no mandan el correo de «cobro generado».
 * El lote ya dejó UNA notificación in-app por familia; con `notify_families =
 * true` el aviso agrupado es de F5 y por ahora sigue el camino de siempre.
 *
 * Se consulta aparte y sin nombrar `charge_batch_id` en el SELECT principal: la
 * columna la crea la F1 y, mientras no esté aplicada, nombrarla rompería todo
 * el job (42703). Si la consulta falla, no se excluye nada (como antes).
 */
export async function idsDeLotesSinAviso(paymentIds: string[]): Promise<Set<string>> {
    const fuera = new Set<string>();
    if (paymentIds.length === 0) return fuera;
    try {
        const { data: filas, error } = await supabase
            .from('payments')
            .select('id, charge_batch_id')
            .in('id', paymentIds)
            .not('charge_batch_id', 'is', null);
        if (error || !filas || filas.length === 0) return fuera;
        const lotes = [...new Set((filas as { charge_batch_id: string }[]).map((f) => f.charge_batch_id))];
        const { data: batches, error: errLotes } = await supabase
            .from('charge_batches')
            .select('id, notify_families')
            .in('id', lotes);
        if (errLotes) return fuera;
        const silenciosos = new Set(((batches ?? []) as { id: string; notify_families: boolean }[])
            .filter((b) => b.notify_families !== true).map((b) => b.id));
        for (const f of filas as { id: string; charge_batch_id: string }[]) {
            if (silenciosos.has(f.charge_batch_id)) fuera.add(f.id);
        }
    } catch {
        /* sin dato: no se excluye nada */
    }
    return fuera;
}

export async function sendChargeCreatedEmails(ahora: Date = new Date()): Promise<{ sent: number; whatsapp: number }> {
    if (!puedeAvisarCobranzaAhora(ahora)) return { sent: 0, whatsapp: 0 };
    let sent = 0;
    let whatsapp = 0;
    const motivos: Record<string, number> = {};
    try {
        const schoolIds = await enabledSchoolIds();
        if (schoolIds.length === 0) return { sent: 0, whatsapp: 0 };

        const { data: candidates, error } = await supabase
            .from('payments')
            .select('id, school_id, amount, late_fee_amount, due_date, concept, parent_id, child_id, user_id, unregistered_athlete_id, period_year, period_month')
            .eq('payment_type', 'subscription')
            .eq('status', 'pending')
            .is('charge_notice_sent_at', null)
            .in('school_id', schoolIds);
        if (error) throw error;
        if (!candidates || candidates.length === 0) return { sent: 0, whatsapp: 0 };

        const deLoteSinAviso = await idsDeLotesSinAviso((candidates as PaymentRow[]).map((p) => p.id));
        const toSend = await filterOutDuplicates((candidates as PaymentRow[]).filter((p) => !deLoteSinAviso.has(p.id)));
        const contacts = await resolveContacts(toSend);
        const schools = await schoolNames([...new Set(toSend.map(p => p.school_id))]);
        const filtro = creaFiltroEstadoDeCuenta(ahora);
        await filtro.inicializar([...new Set(toSend.map(p => p.school_id))]);

        for (const p of toSend) {
            const contact = contacts.get(p.id);
            const espera = await filtro.debeEsperar(p, contact);
            if (espera) { contarMotivo(motivos, espera); continue; }
            if (!(await claimNotice(p.id, 'charge_notice_sent_at'))) continue; // otro BFF lo tomó
            // Estado de cuenta con fecha de vencimiento = pago_recordatorio_previo_v3.
            const wa = await tryWhatsApp(p, contact, schools.get(p.school_id), 'recordatorio_previo');
            if (wa.sent) {
                whatsapp++;
                continue;
            }
            contarMotivo(motivos, wa.motivo);
            // Listo para WhatsApp pero de noche (auto_generate corre 06:30 COT):
            // se devuelve el reclamo; el primer tick dentro del horario lo manda.
            if (wa.motivo === 'fuera_de_horario') {
                await releaseNotice(p.id, 'charge_notice_sent_at');
                continue;
            }
            try {
                if (contact?.contactEmail) {
                    const tpl = await BrandedEmailTemplates.chargeCreated({
                        parentName: contact.contactName,
                        amount: fmtCop(p.amount),
                        childName: contact.athleteName,
                        concept: p.concept || 'Mensualidad',
                        dueDate: fmtDate(p.due_date),
                        paymentLink: `${FRONTEND_URL}/my-payments`,
                        schoolId: p.school_id,
                    });
                    const r = await emailClient.send({ to: contact.contactEmail, subject: tpl.subject, html: tpl.html });
                    await logEmailSend({ schoolId: p.school_id, paymentId: p.id, tipo: 'cobro_generado', to: contact.contactEmail, resultado: r });
                    if (r?.success !== false) sent++;
                } else {
                    await logEmailSend({ schoolId: p.school_id, paymentId: p.id, tipo: 'cobro_generado', to: null });
                }
            } catch (e: unknown) {
                console.warn('[payment-lifecycle] correo de cobro generado falló', { paymentId: p.id, e });
                await logEmailSend({ schoolId: p.school_id, paymentId: p.id, tipo: 'cobro_generado', to: contact?.contactEmail ?? null, resultado: { success: false, error: e } });
            }
        }
    } catch (err: any) {
        console.error('[payment-lifecycle] sendChargeCreatedEmails falló:', err?.message || err);
    }
    if (sent > 0 || whatsapp > 0) {
        console.log(`[payment-lifecycle] cobro generado: correos=${sent} whatsapp=${whatsapp}`, { sinWhatsApp: motivos });
    }
    return { sent, whatsapp };
}

export async function sendOverdueNoticeEmails(ahora: Date = new Date()): Promise<{ sent: number; whatsapp: number }> {
    // Corre una vez al día (07:15 COT). Domingo, festivo o sábado antes de las
    // 8:00 queda fuera de horario: no se reclama nada y lo toma la corrida del
    // siguiente día hábil (los avisos siguen con overdue_notice_sent_at NULL).
    if (!puedeAvisarCobranzaAhora(ahora)) return { sent: 0, whatsapp: 0 };
    let sent = 0;
    let whatsapp = 0;
    const motivos: Record<string, number> = {};
    try {
        const schoolIds = await enabledSchoolIds('vencido');
        if (schoolIds.length === 0) return { sent: 0, whatsapp: 0 };

        const { data: candidates, error } = await supabase
            .from('payments')
            .select('id, school_id, amount, late_fee_amount, due_date, concept, parent_id, child_id, user_id, unregistered_athlete_id, period_year, period_month, payment_category, payment_type')
            .eq('status', 'overdue')
            .is('overdue_notice_sent_at', null)
            .in('school_id', schoolIds);
        if (error) throw error;
        if (!candidates || candidates.length === 0) return { sent: 0, whatsapp: 0 };

        const toSend = await filterOutDuplicates(candidates as PaymentRow[]);
        const contacts = await resolveContacts(toSend);
        const schools = await schoolNames([...new Set(toSend.map(p => p.school_id))]);
        const filtro = creaFiltroEstadoDeCuenta(ahora);
        await filtro.inicializar([...new Set(toSend.map(p => p.school_id))]);

        for (const p of toSend) {
            const contact = contacts.get(p.id);
            const espera = await filtro.debeEsperar(p, contact);
            if (espera) { contarMotivo(motivos, espera); continue; }
            if (!(await claimNotice(p.id, 'overdue_notice_sent_at'))) continue; // otro BFF lo tomó
            // Primer aviso tras la gracia = pago_pendiente_suave ("si tuviste algún
            // inconveniente, responde"), el escalón que abre conversación.
            // OJO: este job corre 07:15 UTC = 02:15 COT, fuera del horario legal,
            // así que hoy devuelve 'fuera_de_horario' y cae al correo (aquí NO se
            // pospone: corre una vez al día y posponer sería no avisar nunca).
            // Mover su cron a '15 12 * * *' (07:15 COT) en maintenance.job.ts lo destraba.
            const cobroUnico = avisoDeCobroUnico(p);
            if (cobroUnico) {
                // La plantilla dice «mensualidad»: un cobro único va por correo.
                contarMotivo(motivos, 'cobro_unico');
            } else {
                const wa = await tryWhatsApp(p, contact, schools.get(p.school_id), 'pendiente_suave');
                if (wa.sent) {
                    whatsapp++;
                    continue;
                }
                contarMotivo(motivos, wa.motivo);
            }
            try {
                if (contact?.contactEmail) {
                    const tpl = await BrandedEmailTemplates.paymentOverdue({
                        parentName: contact.contactName,
                        amount: fmtCop(p.amount),
                        childName: contact.athleteName,
                        chargeLabel: cobroUnico,
                        concept: cobroUnico ? p.concept : null,
                        dueDate: fmtDate(p.due_date),
                        paymentLink: `${FRONTEND_URL}/my-payments`,
                        schoolId: p.school_id,
                        lateFee: moraParaCorreo(p),
                    });
                    const r = await emailClient.send({ to: contact.contactEmail, subject: tpl.subject, html: tpl.html });
                    await logEmailSend({ schoolId: p.school_id, paymentId: p.id, tipo: 'pago_vencido', to: contact.contactEmail, resultado: r });
                    if (r?.success !== false) sent++;
                } else {
                    await logEmailSend({ schoolId: p.school_id, paymentId: p.id, tipo: 'pago_vencido', to: null });
                }
            } catch (e: unknown) {
                console.warn('[payment-lifecycle] correo de vencido falló', { paymentId: p.id, e });
                await logEmailSend({ schoolId: p.school_id, paymentId: p.id, tipo: 'pago_vencido', to: contact?.contactEmail ?? null, resultado: { success: false, error: e } });
            }
        }
    } catch (err: any) {
        console.error('[payment-lifecycle] sendOverdueNoticeEmails falló:', err?.message || err);
    }
    if (sent > 0 || whatsapp > 0) {
        console.log(`[payment-lifecycle] vencido: correos=${sent} whatsapp=${whatsapp}`, { sinWhatsApp: motivos });
    }
    return { sent, whatsapp };
}
