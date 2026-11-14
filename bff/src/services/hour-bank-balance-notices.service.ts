/**
 * Escalera de avisos de saldo del banco de horas — corrida periódica.
 * Plan: docs/specs/dreamers-horas-agotadas-bloqueo-y-excedentes-automaticos.md §2.1.
 *
 * Por qué un barrido y no solo un gancho en la salida: el consumo NO se descuenta en el evento de
 * salida sino al CERRAR la visita (próxima entrada fuera de la ventana de reingreso, o el
 * auto-cierre, que vive en SQL). El período es la única fuente fiable del saldo, así que se lee
 * de ahí cada 15 min y se avisa lo que cruzó un escalón.
 *
 * Seguro por diseño:
 *  · Solo escuelas con hours_plan_enabled Y escalones configurados (default '{}' = apagado).
 *  · Si las columnas de la migración 20261023194135 aún no existen, no hace nada (no rompe).
 *  · «Reclama» el escalón con un UPDATE condicional (balance_notices->>S IS NULL): el mismo cron
 *    corre a la vez en los 3 BFF contra una sola base y solo uno envía.
 *  · Solo manda dentro de 8:00–19:59 hora Colombia; fuera de ese horario no evalúa nada, así que
 *    el aviso espera a la mañana (no se pierde: sigue «sin marcar»).
 *  · Un correo por acudiente por corrida, con todas sus hijas (hermanas = un solo mensaje).
 *  · Sin acudiente vinculado: el aviso va solo al dueño de la escuela.
 *  · Nunca cobra ni bloquea nada.
 */
import { supabase } from '../config/supabase';
import { emailClient } from '../utils/emailClient';
import { BrandedEmailTemplates } from '../utils/emailTemplates';
import { todayInZone } from '../utils/businessDate';
import {
    normalizarEscalones, umbralesDelPeriodo, decidirAvisos, aplicarDecision, armarMensaje,
    fechaDeRenovacion, dentroDeHorarioDeCorreo, type EscalonMarca, type MensajeDeSaldo,
} from './hour-bank-balance-notices.shared';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.sportmaps.co';
const BLOQUE_POR_DEFECTO = 120;

export interface ResultadoDeAvisos {
    escuelas: number;
    avisos: number;
    correos: number;
    omitido?: 'fuera_de_horario' | 'sin_columnas' | 'sin_escuelas';
}

interface ItemDeCorreo { athlete: string; title: string; body: string; severity: MensajeDeSaldo['severidad'] }

let avisoColumnasFaltantes = false;

export async function runHourBankBalanceNotices(ahora: Date = new Date()): Promise<ResultadoDeAvisos> {
    const out: ResultadoDeAvisos = { escuelas: 0, avisos: 0, correos: 0 };
    if (!dentroDeHorarioDeCorreo(ahora)) return { ...out, omitido: 'fuera_de_horario' };

    const { data: ajustes, error } = await supabase
        .from('school_settings')
        .select('school_id, hour_bank_balance_notice_steps, hour_bank_balance_notice_email_enabled, hours_session_block_minutes')
        .eq('hours_plan_enabled', true);
    if (error) {
        if (!avisoColumnasFaltantes) {
            avisoColumnasFaltantes = true;
            console.warn('[CRON] avisos de saldo de horas: sin columnas (¿migración 20261023194135 sin aplicar?):', error.message);
        }
        return { ...out, omitido: 'sin_columnas' };
    }

    const escuelas = ((ajustes ?? []) as Record<string, any>[])
        .map((a) => ({
            schoolId: a.school_id as string,
            steps: normalizarEscalones(a.hour_bank_balance_notice_steps),
            correo: a.hour_bank_balance_notice_email_enabled !== false,
            bloqueEscuela: Number(a.hours_session_block_minutes) > 0 ? Number(a.hours_session_block_minutes) : BLOQUE_POR_DEFECTO,
        }))
        .filter((e) => e.steps.length > 0);
    if (escuelas.length === 0) return { ...out, omitido: 'sin_escuelas' };

    const hoy = todayInZone();
    const ahoraIso = ahora.toISOString();
    // Un correo por destinatario (clave = correo) con todas las hijas de esta corrida.
    const correos = new Map<string, { nombre: string; schoolId: string; items: ItemDeCorreo[] }>();

    for (const esc of escuelas) {
        out.escuelas += 1;
        try {
            out.avisos += await procesarEscuela(esc, hoy, ahoraIso, correos);
        } catch (err: any) {
            console.error(`[CRON] avisos de saldo de horas — error en escuela ${esc.schoolId}:`, err?.message || err);
        }
    }

    for (const [correo, c] of correos) {
        try {
            const tpl = await BrandedEmailTemplates.hourBankBalance({
                recipientName: c.nombre, items: c.items, link: `${FRONTEND_URL}/enrollments`, schoolId: c.schoolId,
            });
            const r = await emailClient.send({ to: correo, subject: tpl.subject, html: tpl.html });
            if (r?.success) out.correos += 1;
        } catch (err: any) {
            console.error('[CRON] avisos de saldo de horas — error enviando correo:', err?.message || err);
        }
    }
    if (out.avisos > 0) console.log(`[CRON] avisos de saldo de horas: ${out.avisos} aviso(s), ${out.correos} correo(s).`);
    return out;
}

async function procesarEscuela(
    esc: { schoolId: string; steps: number[]; correo: boolean; bloqueEscuela: number },
    hoy: string,
    ahoraIso: string,
    correos: Map<string, { nombre: string; schoolId: string; items: ItemDeCorreo[] }>,
): Promise<number> {
    const { data: periodos } = await supabase
        .from('hour_bank_periods')
        .select('id, enrollment_id, included_minutes, consumed_minutes, period_end, balance_notices')
        .eq('school_id', esc.schoolId)
        .lte('period_start', hoy).gte('period_end', hoy)
        .gt('included_minutes', 0).gt('consumed_minutes', 0);
    const filas = (periodos ?? []) as Record<string, any>[];
    if (filas.length === 0) return 0;

    // Datos de contexto en lote (nada de una consulta por fila: ver CLAUDE.md, jobs de cada minuto).
    // El bloque del plan hace falta ANTES de decidir: los escalones «quedan 2 clases» dependen de él.
    const enrollmentIds = [...new Set(filas.map((p) => p.enrollment_id as string))];
    const { data: insc } = await supabase
        .from('enrollments').select('id, child_id, user_id, offering_plan_id').in('id', enrollmentIds);
    const enrollments = new Map(((insc ?? []) as Record<string, any>[]).map((e) => [e.id as string, e]));

    const planIds = [...new Set([...enrollments.values()].map((e) => e.offering_plan_id).filter(Boolean))] as string[];
    const bloques = new Map<string, number>();
    if (planIds.length) {
        const { data: planes } = await supabase.from('offering_plans').select('id, session_block_minutes').in('id', planIds);
        ((planes ?? []) as Record<string, any>[]).forEach((pl) => {
            if (Number(pl.session_block_minutes) > 0) bloques.set(pl.id, Number(pl.session_block_minutes));
        });
    }
    const bloqueDe = (enrollmentId: string) => bloques.get(enrollments.get(enrollmentId)?.offering_plan_id as string) ?? esc.bloqueEscuela;

    // Solo los períodos donde hay algo que hacer (casi siempre ninguno).
    const pendientes = filas.map((p) => {
        const marcas = (p.balance_notices && typeof p.balance_notices === 'object' ? p.balance_notices : {}) as EscalonMarca;
        const incluido = Number(p.included_minutes);
        const restante = Math.max(0, incluido - Number(p.consumed_minutes));
        const umbrales = umbralesDelPeriodo(esc.steps, incluido, bloqueDe(p.enrollment_id as string));
        return { p, marcas, decision: decidirAvisos(umbrales, restante, marcas) };
    }).filter((x) => x.decision.aEnviar !== null || x.decision.marcarEnSilencio.length > 0 || x.decision.borrarMarcas.length > 0);
    if (pendientes.length === 0) return 0;

    const childIds = [...new Set([...enrollments.values()].map((e) => e.child_id).filter(Boolean))] as string[];
    const { data: hijos } = childIds.length
        ? await supabase.from('children').select('id, full_name, parent_id').in('id', childIds)
        : { data: [] as Record<string, any>[] };
    const hijoPor = new Map(((hijos ?? []) as Record<string, any>[]).map((h) => [h.id as string, h]));

    const perfilIds = [...new Set([
        ...[...hijoPor.values()].map((h) => h.parent_id),
        ...[...enrollments.values()].map((e) => e.user_id),
    ].filter(Boolean))] as string[];
    const { data: perfiles } = perfilIds.length
        ? await supabase.from('profiles').select('id, full_name, email').in('id', perfilIds)
        : { data: [] as Record<string, any>[] };
    const perfilPor = new Map(((perfiles ?? []) as Record<string, any>[]).map((pf) => [pf.id as string, pf]));

    const { data: escuela } = await supabase.from('schools').select('owner_id').eq('id', esc.schoolId).maybeSingle();
    const ownerId = (escuela as any)?.owner_id as string | null | undefined;

    let enviados = 0;
    for (const { p, marcas, decision } of pendientes) {
        const nuevas = aplicarDecision(marcas, decision, ahoraIso);

        // Reclamar el escalón: solo la instancia que logra el UPDATE condicional avisa.
        let consulta = supabase.from('hour_bank_periods').update({ balance_notices: nuevas }).eq('id', p.id);
        if (decision.aEnviar !== null) consulta = consulta.is(`balance_notices->>${decision.aEnviar.clave}`, null);
        const { data: reclamado, error: errUpd } = await consulta.select('id');
        if (errUpd || !reclamado || reclamado.length === 0) continue;
        if (decision.aEnviar === null) continue; // solo se limpiaron marcas

        const insc1 = enrollments.get(p.enrollment_id as string);
        const hijo = insc1?.child_id ? hijoPor.get(insc1.child_id as string) : null;
        const adulto = insc1?.user_id ? perfilPor.get(insc1.user_id as string) : null;
        const atleta = (hijo?.full_name || adulto?.full_name || 'Tu deportista') as string;
        const destinatarioId = (hijo?.parent_id || insc1?.user_id || null) as string | null;
        const destino = destinatarioId ? perfilPor.get(destinatarioId) : null;

        const restante = Math.max(0, Number(p.included_minutes) - Number(p.consumed_minutes));
        const msg = armarMensaje({
            aviso: decision.aEnviar, atleta,
            restanteMinutos: restante, incluidoMinutos: Number(p.included_minutes),
            bloqueMinutos: bloqueDe(p.enrollment_id as string),
            seRenueva: fechaDeRenovacion(p.period_end as string, hoy), momento: 'cierre',
        });

        // Push + in-app (el despachador de notificaciones las recoge). Sin acudiente vinculado:
        // solo el dueño de la escuela, dicho claramente.
        const paraId = destinatarioId ?? ownerId;
        if (paraId) {
            await supabase.from('notifications').insert({
                user_id: paraId, school_id: esc.schoolId, type: 'hour_bank_balance',
                title: destinatarioId ? msg.titulo : `${msg.titulo} (sin acudiente vinculado)`,
                message: msg.cuerpo, link: destinatarioId ? '/enrollments' : '/school/access-control',
            });
            enviados += 1;
        }

        // Correo: solo a quien tiene correo y la escuela lo permite; hermanas = un solo correo.
        if (esc.correo && destino?.email) {
            const c = correos.get(destino.email) ?? { nombre: destino.full_name || 'Familia', schoolId: esc.schoolId, items: [] as ItemDeCorreo[] };
            c.items.push({ athlete: atleta, title: msg.titulo, body: msg.cuerpo, severity: msg.severidad });
            correos.set(destino.email, c);
        }
    }
    return enviados;
}
