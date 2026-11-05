/**
 * recordatorios-cobro.service — la CADENCIA de recordatorios de cobro por
 * WhatsApp, con las plantillas de Meta aprobadas en la WABA de cada escuela.
 *
 * QUÉ HABÍA ANTES (2026-10-06)
 *   · payment-lifecycle-emails: un aviso cuando nace el cobro (recordatorio_previo)
 *     y otro cuando pasa a 'overdue' (pendiente_suave). WhatsApp primero, correo
 *     de respaldo.
 *   · estado-de-cuenta: un mensaje mensual por familia.
 *   Nadie mandaba los escalones intermedios: "mañana vence", "vence hoy", ni la
 *   escalera de mora. Las 10 plantillas de Dynasty estaban APPROVED sin uso.
 *
 * LA ESCALERA (días respecto a payments.due_date, hora de Bogotá)
 *
 *   recordatorio_previo  -3   (ventana -3..-2)
 *   vence_manana         -1   (solo ese día: el texto dice "mañana vence")
 *   vence_hoy             0   (solo ese día)
 *   pendiente_suave      +3   (ventana +3..+9)
 *   pendiente_directo   +10   (ventana +10..+19; dice "presenta N días de vencida")
 *   aviso_final         +20   (ventana +20..+23)
 *
 * Las ventanas existen porque el job corre solo en días hábiles: un escalón que
 * cae en domingo o festivo sale el siguiente día hábil si el texto sigue siendo
 * cierto. Las de "mañana"/"hoy" no tienen ventana: el lunes ya no es verdad que
 * "vence hoy". Pasado +23 no sale nada por aquí: activar la cadencia en una
 * escuela con deuda vieja (Dynasty: 193 cobros a +26 días) NO dispara una
 * ráfaga de "último aviso"; esa deuda la recoge el estado de cuenta mensual.
 *
 * El spec de cobranza v2 (§4.3) habla de pre_due_3d / due_today /
 * overdue_1d/3d/7d. Aquí manda lo que las plantillas aprobadas dicen y la
 * cadencia pedida el 2026-10-06; la tabla es la `collection_notices` del spec
 * con los nombres de los conceptos de las plantillas.
 *
 * REGLAS
 *   · Ley 2300 de 2023: solo días hábiles a las 8:00 COT (dentro del horario),
 *     y MÁXIMO un contacto de cobranza por familia y día. Una familia con varios
 *     cobros en el mismo escalón recibe UN mensaje ("Samuel y Sofía", total).
 *     Si tiene cobros en escalones distintos, sale el más severo y los demás
 *     esperan su ventana (o se pierden si era "mañana"/"hoy": la ley manda).
 *     Se salta a quien HOY ya recibió estado de cuenta, aviso de cobro
 *     generado o de vencido.
 *   · Solo opt-in (wa_can_send_template, que enviarCobroPorPlantilla vuelve a
 *     preguntar justo antes de mandar) y solo plantilla APPROVED + UTILITY.
 *   · Sin correo duplicado: este servicio NO manda correos. Si el previo sale
 *     por WhatsApp se estampa charge_notice_sent_at, y si sale un escalón de
 *     mora se estampa overdue_notice_sent_at: así payment-lifecycle-emails no
 *     manda después el correo/WhatsApp de ese mismo momento.
 *   · Idempotente en la base entre los tres BFF: UNIQUE(payment_id,
 *     notice_type) y candado familia-día (índice único parcial is_lead) en
 *     collection_notices (migración 20261006101656).
 *   · Activación: env DISABLE_RECORDATORIOS_COBRO_WHATSAPP=true apaga el
 *     proceso; por escuela charge_notifications_enabled AND
 *     whatsapp_collection_reminders_enabled (default false). Mientras el estado
 *     de cuenta del mes de la escuela esté pendiente, la escuela espera.
 *
 * CANAL CORREO (2026-10-14, pedido para Besser)
 *   Con school_settings.email_collection_reminders_enabled, la familia SIN
 *   WhatsApp con opt-in recibe la misma escalera por correo, salvo
 *   «vence_mañana» (ESCALONES_CORREO: -3 · 0 · +3 · +10 · +20). Cada familia va
 *   por UN canal: WhatsApp si tiene opt-in, si no correo — nunca los dos, que
 *   la Ley 2300 no permite contactar por varios canales en la misma semana.
 *   Mismo candado familia-día y mismo estampado; family_key = el correo, que es
 *   la clave que payment-lifecycle-emails consulta para no repetir el día.
 */

import { supabase } from '../config/supabase';
import { fechaColombia } from './avisos-correo.service';
import {
    CONCEPTOS, dentroDeHorarioDeCobranza, enviarCobroPorPlantilla, plantillaAprobada,
    type ConceptoCobro, type DatosCobro,
} from './whatsapp-plantillas.service';
import { emitirTokenCobro } from './cobro-enlace-publico.service';
import { emailClient } from '../utils/emailClient';
import { BrandedEmailTemplates } from '../utils/emailTemplates';
import { appPublica, enlaceDeCobro } from '../utils/url-publica-familias';
import { findDuplicatePaymentIds } from './duplicatePayerGuard.service';
import { esMensualidad } from './tipo-de-cobro';
import { desgloseMora, montoConMora } from '../utils/desglose-mora';
import { COLUMNAS_CONTACTO_FICHA, COLUMNAS_CONTACTO_HIJO } from './contacto-acudiente';
import {
    agruparPorFamilia, contactosConEstadoDeCuentaHoy, esDiaHabil, escuelasConEstadoPendiente,
    fmtCop, mesColombia, type Familia, type PagoEstado,
} from './estado-de-cuenta.service';

// ─── La escalera ─────────────────────────────────────────────────────────────

export type ConceptoRecordatorio = Extract<ConceptoCobro,
    'recordatorio_previo' | 'vence_manana' | 'vence_hoy' | 'pendiente_suave' | 'pendiente_directo' | 'aviso_final'>;

export interface Escalon { concepto: ConceptoRecordatorio; desde: number; hasta: number; mora: boolean }

/** En orden de severidad creciente. */
export const ESCALONES: Escalon[] = [
    { concepto: 'recordatorio_previo', desde: -3, hasta: -2, mora: false },
    { concepto: 'vence_manana', desde: -1, hasta: -1, mora: false },
    { concepto: 'vence_hoy', desde: 0, hasta: 0, mora: false },
    { concepto: 'pendiente_suave', desde: 3, hasta: 9, mora: true },
    { concepto: 'pendiente_directo', desde: 10, hasta: 19, mora: true },
    { concepto: 'aviso_final', desde: 20, hasta: 23, mora: true },
];

const SEVERIDAD = new Map(ESCALONES.map((e, i) => [e.concepto, i]));

/** Escalones que también salen por correo: sin «mañana vence» (dos correos seguidos es ruido). */
export const ESCALONES_CORREO: ReadonlySet<ConceptoRecordatorio> = new Set(
    ESCALONES.map((e) => e.concepto).filter((c) => c !== 'vence_manana'),
);

export type CanalRecordatorio = 'whatsapp' | 'email';

/** Días entre el vencimiento y hoy (ambos 'YYYY-MM-DD'): negativo = falta. */
export function diasDesdeVencimiento(dueDate: string, hoyISO: string): number {
    const a = Date.UTC(+dueDate.slice(0, 4), +dueDate.slice(5, 7) - 1, +dueDate.slice(8, 10));
    const b = Date.UTC(+hoyISO.slice(0, 4), +hoyISO.slice(5, 7) - 1, +hoyISO.slice(8, 10));
    return Math.round((b - a) / 86_400_000);
}

export function escalonDelDia(delta: number): Escalon | null {
    return ESCALONES.find((e) => delta >= e.desde && delta <= e.hasta) ?? null;
}

/** Fecha 'YYYY-MM-DD' corrida n días. */
export function sumarDias(iso: string, n: number): string {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * El cobro ya recibió el recordatorio_previo por otro camino (aviso "cobro
 * generado" o estado de cuenta, que usan la MISMA plantilla) hace menos de esto:
 * no se repite.
 */
export const DIAS_SIN_REPETIR_PREVIO = 5;

// ─── Plan (puro) ─────────────────────────────────────────────────────────────

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const fechaLarga = (d: string) => {
    const f = new Date(`${d.slice(0, 10)}T12:00:00Z`);
    return `${f.getUTCDate()} de ${MESES[f.getUTCMonth()]}`;
};

function periodoDe(p: PagoEstado | undefined): string | null {
    if (!p) return null;
    if (p.period_year && p.period_month && p.period_month >= 1 && p.period_month <= 12) return `${MESES[p.period_month - 1]} ${p.period_year}`;
    if (!p.due_date) return null;
    const d = new Date(`${p.due_date.slice(0, 10)}T12:00:00Z`);
    return `${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Samuel", "Samuel y Sofía", "Samuel, Sofía y Tomás" (primer nombre, sin repetir). */
export function unirNombres(nombres: (string | null | undefined)[]): string {
    const n = [...new Set(nombres.map((x) => String(x ?? '').trim().split(/\s+/)[0]).filter(Boolean))];
    if (n.length <= 1) return n[0] ?? '';
    return `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`;
}

export interface ContactoPlaneado {
    canal: CanalRecordatorio;
    familyKey: string;           // 'wa:<wa_id>' o el correo en minúscula
    waId: string | null;
    email: string | null;
    perfilId: string | null;
    /** Día de corte de la escuela, para el recordatorio del correo. */
    diaCorte?: number | null;
    /** Aviso de política de cobranza de la escuela (school_settings.collection_policy_notice). */
    avisoPolitica?: string | null;
    concepto: ConceptoRecordatorio;
    /** Cobros que menciona el mensaje; el primero es el "líder" (el más viejo): botón y candado. */
    paymentIds: string[];
    /**
     * Total del mensaje (suma de saldos, mora incluida) y la parte que es
     * recargo por mora (suma de late_fee_amount). `datos.monto` ya lo dice para
     * WhatsApp; el correo lo muestra desglosado.
     */
    total?: number;
    mora?: number;
    datos: DatosCobro;
}

export type MotivoDescarte =
    | 'sin_escalon_hoy' | 'ya_enviado' | 'previo_ya_recibido' | 'vencido_ya_avisado'
    | 'ya_contactada_hoy' | 'sin_telefono' | 'sin_optin';

export interface Plan {
    hoy: string;
    contactos: ContactoPlaneado[];
    /** Por familia (no por cobro), salvo los que cuentan cobros: ver cada clave. */
    descartes: Record<MotivoDescarte, number>;
}

export interface EntradaPlan {
    hoy: string;                         // 'YYYY-MM-DD' COT
    escuela: string;
    familias: Familia[];
    pagos: Map<string, PagoEstado>;
    /** 'paymentId|concepto' ya registrados en collection_notices. */
    enviados: Set<string>;
    /** wa_id con opt-in vigente en la integración de la escuela. */
    optin: Set<string>;
    /** Claves ('wa:<id>' o correo) que HOY ya recibieron un contacto de cobranza. */
    contactadosHoy: Set<string>;
    /** La escuela tiene la cadencia por correo: la familia sin WhatsApp con opt-in la recibe por correo. */
    canalCorreo?: boolean;
    /**
     * Qué familias de avisos tiene prendidas la escuela (cada una con su propio interruptor):
     * `previo` = antes de vencer y el día; `mora` = +3, +10 y +20 días. Por defecto, ambas.
     */
    tipos?: { previo: boolean; mora: boolean };
    /** Día del mes hasta el que se paga (calendario fijo): el correo lo recuerda. */
    diaCorte?: number | null;
    /** Aviso de política de cobranza de la escuela, destacado en el correo. */
    avisoPolitica?: string | null;
}

/**
 * Decide qué sale hoy. Puro: lo prueban los tests y lo usa el script de
 * simulación tal cual. Agrupa por TELÉFONO (dos "familias" por correo con el
 * mismo celular son un solo contacto para la ley y para el acudiente).
 */
export function planificar(e: EntradaPlan): Plan {
    const descartes: Record<MotivoDescarte, number> = {
        sin_escalon_hoy: 0, ya_enviado: 0, previo_ya_recibido: 0, vencido_ya_avisado: 0,
        ya_contactada_hoy: 0, sin_telefono: 0, sin_optin: 0,
    };
    const limitePrevio = `${sumarDias(e.hoy, -DIAS_SIN_REPETIR_PREVIO)}T05:00:00Z`; // 00:00 COT

    type Cand = { paymentId: string; escalon: Escalon; delta: number; atleta: string; saldo: number; mora: number; vence: string };
    // Clave del destinatario: 'wa:<id>' (WhatsApp) o el correo (correo).
    const porDestino = new Map<string, { canal: CanalRecordatorio; familias: Familia[]; cands: Cand[] }>();

    for (const f of e.familias) {
        const cands: Cand[] = [];
        for (const r of f.filas) {
            if (!r.vence) continue;
            const delta = diasDesdeVencimiento(r.vence, e.hoy);
            const esc = escalonDelDia(delta);
            if (!esc) { descartes.sin_escalon_hoy++; continue; }
            if (esc.mora ? e.tipos?.mora === false : e.tipos?.previo === false) { descartes.sin_escalon_hoy++; continue; }
            if (e.enviados.has(`${r.paymentId}|${esc.concepto}`)) { descartes.ya_enviado++; continue; }
            const p = e.pagos.get(r.paymentId);
            if (esc.concepto === 'recordatorio_previo' && p?.charge_notice_sent_at && p.charge_notice_sent_at >= limitePrevio) {
                descartes.previo_ya_recibido++; continue;
            }
            // El aviso de vencido (pendiente_suave o su correo) ya salió por payment-lifecycle.
            if (esc.concepto === 'pendiente_suave' && p?.overdue_notice_sent_at) {
                descartes.vencido_ya_avisado++; continue;
            }
            cands.push({ paymentId: r.paymentId, escalon: esc, delta, atleta: r.atleta, saldo: r.saldo, mora: r.mora ?? 0, vence: r.vence });
        }
        if (cands.length === 0) continue;
        if (f.avisadaHoy || e.contactadosHoy.has(f.clave) || (f.waId && e.contactadosHoy.has(`wa:${f.waId}`))) {
            descartes.ya_contactada_hoy++; continue;
        }
        let destino: string;
        let canal: CanalRecordatorio;
        let suyos = cands;
        if (f.waId && e.optin.has(f.waId)) {
            destino = `wa:${f.waId}`;
            canal = 'whatsapp';
        } else if (e.canalCorreo && f.email) {
            suyos = cands.filter((c) => ESCALONES_CORREO.has(c.escalon.concepto));
            if (suyos.length === 0) { descartes.sin_escalon_hoy++; continue; }
            destino = f.email.trim().toLowerCase();
            canal = 'email';
        } else {
            if (!f.waId) descartes.sin_telefono++; else descartes.sin_optin++;
            continue;
        }
        const g = porDestino.get(destino) ?? { canal, familias: [], cands: [] };
        g.familias.push(f);
        g.cands.push(...suyos);
        porDestino.set(destino, g);
    }

    const contactos: ContactoPlaneado[] = [];
    for (const [destino, g] of porDestino) {
        const max = Math.max(...g.cands.map((c) => SEVERIDAD.get(c.escalon.concepto)!));
        const grupo = g.cands
            .filter((c) => SEVERIDAD.get(c.escalon.concepto) === max)
            .sort((a, b) => a.vence.localeCompare(b.vence));
        const lider = grupo[0];
        const fam = g.familias[0];
        const total = grupo.reduce((s, c) => s + c.saldo, 0);
        const mora = grupo.reduce((s, c) => s + c.mora, 0);
        contactos.push({
            canal: g.canal,
            familyKey: destino,
            waId: g.canal === 'whatsapp' ? destino.slice(3) : null,
            email: g.canal === 'email' ? destino : null,
            perfilId: g.familias.find((f) => f.perfilId)?.perfilId ?? null,
            diaCorte: e.diaCorte ?? null,
            avisoPolitica: e.avisoPolitica ?? null,
            concepto: lider.escalon.concepto,
            paymentIds: grupo.map((c) => c.paymentId),
            total,
            mora,
            datos: {
                nombreContacto: fam.nombre.split(' ')[0] || fam.nombre,
                nombreAtleta: unirNombres(grupo.map((c) => c.atleta)),
                nombreEscuela: e.escuela,
                periodo: periodoDe(e.pagos.get(lider.paymentId)),
                fechaVencimiento: fechaLarga(lider.vence),
                // Con mora: «$165.000, que incluye $15.000 de recargo por mora»
                // (la plantilla de Meta es fija; solo cambia la variable).
                monto: montoConMora(total, mora, fmtCop),
                diasVencido: lider.delta > 0 ? lider.delta : null,
            },
        });
    }
    return { hoy: e.hoy, contactos, descartes };
}

/** ¿Hoy, a esta hora, corre la cadencia? Día hábil (L-V, no festivo), desde las 8:00 COT y dentro del horario legal. */
export function esHoraDeRecordatorios(ahora: Date): boolean {
    const hora = new Date(ahora.getTime() - 5 * 3600_000).getUTCHours();
    return esDiaHabil(ahora) && hora >= 8 && dentroDeHorarioDeCobranza(ahora);
}

/**
 * ¿Este cobro entra en la escalera de recordatorios? Solo la MENSUALIDAD: las
 * seis plantillas dicen «la mensualidad de …». Un pago único (inscripción,
 * seguro, torneo… — `payment_type='one_time'` y/o `payment_category` distinta
 * de 'mensualidad') NO se recuerda por acá: decirle «mensualidad» a una
 * inscripción es mentirle, y la mora sobre pagos únicos no es regla de
 * ninguna escuela todavía (decisión pendiente, 2026-10-10). El filtro de la
 * consulta (`payment_type='subscription'`) no alcanza solo: `payment_type`
 * no es fiable y hay filas 'subscription' con categoría de pago único. Pura.
 */
export function entraEnRecordatorios(p: { payment_type?: string | null; payment_category?: string | null; concept?: string | null }): boolean {
    // Sin payment_type en la fila (la consulta ya filtra 'subscription') se toma como tal.
    const tipo = p.payment_type ?? 'subscription';
    return tipo === 'subscription' && esMensualidad({ ...p, payment_type: tipo });
}

/**
 * Cobros cuyo atleta la escuela dio de baja: no se le recuerdan a la familia
 * (caso Dynasty 2026-10-06: a la familia de un atleta inactivo le seguían
 * llegando avisos). Mismo criterio que el estado de cuenta: hijo/ficha con
 * is_active=false; adulto con membresía athlete 'inactive' y ninguna 'active'.
 * NULL se lee como activo.
 */
export function cobrosDeAtletaDadoDeBaja(
    pagos: PagoEstado[],
    d: {
        hijos: Map<string, { is_active?: boolean | null }>;
        noRegistrados: Map<string, { is_active?: boolean | null }>;
        estadosAdulto: Map<string, string[]>;
    },
): Set<string> {
    const out = new Set<string>();
    for (const p of pagos) {
        if (p.child_id) { if (d.hijos.get(p.child_id)?.is_active === false) out.add(p.id); continue; }
        if (p.unregistered_athlete_id) { if (d.noRegistrados.get(p.unregistered_athlete_id)?.is_active === false) out.add(p.id); continue; }
        const e = p.user_id ? d.estadosAdulto.get(p.user_id) : undefined;
        if (e?.includes('inactive') && !e.includes('active')) out.add(p.id);
    }
    return out;
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

const trozos = <T,>(a: T[], n = 200) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function leerPorIds(tabla: string, cols: string, ids: string[]): Promise<any[]> {
    const res = await Promise.all(trozos(ids).map((t) => supabase.from(tabla).select(cols).in('id', t)));
    return res.flatMap((r) => (r.data ?? []) as any[]);
}

export class MigracionPendienteError extends Error {
    constructor(detalle: string) { super(`collection_notices no disponible (¿migración 20261006101656 sin aplicar?): ${detalle}`); }
}

/** 'paymentId|concepto' ya registrados. Lanza MigracionPendienteError si la tabla no existe. */
export async function avisosRegistrados(paymentIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const t of trozos(paymentIds)) {
        const { data, error } = await supabase.from('collection_notices').select('payment_id, notice_type').in('payment_id', t);
        if (error) throw new MigracionPendienteError(error.message);
        for (const r of (data as any[]) ?? []) out.add(`${r.payment_id}|${r.notice_type}`);
    }
    return out;
}

/**
 * Claves de familia ('wa:<id>') a las que esta cadencia ya contactó HOY en la
 * escuela. Lo usa payment-lifecycle-emails para no mandar otro aviso el mismo
 * día. Ante error (tabla sin crear) devuelve vacío: nada que respetar.
 */
export async function contactosConRecordatorioHoy(schoolId: string, ahora: Date = new Date()): Promise<Set<string>> {
    const { data, error } = await supabase.from('collection_notices')
        .select('family_key, status')
        .eq('school_id', schoolId)
        .eq('contact_day', fechaColombia(ahora))
        .eq('is_lead', true);
    if (error) return new Set();
    return new Set(((data as any[]) ?? []).filter((r) => r.status !== 'failed').map((r) => String(r.family_key)));
}

async function integracionActiva(schoolId: string): Promise<string | null> {
    const { data } = await supabase.from('school_whatsapp_integrations')
        .select('id, waba_id, access_token_encrypted').eq('school_id', schoolId).eq('status', 'active');
    const activas = ((data as any[]) ?? []).filter((i) => i.waba_id && i.access_token_encrypted);
    return activas.length === 1 ? activas[0].id : null;
}

/** wa_id con opt-in vigente (misma condición que wa_can_send_template, sin el bloqueo: ese lo valida el envío). */
export async function telefonosConOptin(integrationId: string): Promise<Set<string>> {
    const { data } = await supabase.from('whatsapp_optins')
        .select('contact_wa_id, opted_in_at, opted_out_at')
        .eq('integration_id', integrationId)
        .not('opted_in_at', 'is', null)
        .is('opted_out_at', null);
    return new Set(((data as any[]) ?? []).map((r) => String(r.contact_wa_id)));
}

export interface CanalesEscuela { whatsapp: boolean; correo: boolean; previo?: boolean; mora?: boolean }

/** Escuelas con la cadencia prendida en algún canal, y por cuál. */
export async function escuelasConRecordatorios(): Promise<Map<string, CanalesEscuela>> {
    const out = new Map<string, CanalesEscuela>();
    // `collection_pre_due_enabled` y `overdue_notices_enabled` (migración 20261105…): si aún no existen,
    // se reintenta sin ellas y ambas familias de avisos quedan prendidas, como antes.
    let { data, error } = await supabase.from('school_settings')
        .select('school_id, whatsapp_collection_reminders_enabled, email_collection_reminders_enabled, collection_pre_due_enabled, overdue_notices_enabled')
        .eq('charge_notifications_enabled', true);
    if (error) {
        ({ data, error } = await supabase.from('school_settings')
            .select('school_id, whatsapp_collection_reminders_enabled, email_collection_reminders_enabled')
            .eq('charge_notifications_enabled', true));
    }
    if (error) {
        // Sin la columna del correo (migración 20261014112226 sin aplicar): solo WhatsApp, como antes.
        // Sin ninguna de las dos: apagado en los tres BFF.
        const { data: soloWa, error: e2 } = await supabase.from('school_settings')
            .select('school_id')
            .eq('charge_notifications_enabled', true)
            .eq('whatsapp_collection_reminders_enabled', true);
        if (e2) return out;
        for (const r of (soloWa as any[]) ?? []) out.set(r.school_id, { whatsapp: true, correo: false });
        return out;
    }
    for (const r of (data as any[]) ?? []) {
        const c = {
            whatsapp: r.whatsapp_collection_reminders_enabled === true,
            correo: r.email_collection_reminders_enabled === true,
            previo: r.collection_pre_due_enabled !== false,
            mora: r.overdue_notices_enabled !== false,
        };
        if (c.whatsapp || c.correo) out.set(r.school_id, c);
    }
    return out;
}

export interface DiagnosticoEscuela {
    escuela: string;
    integracion: string | null;
    plantillas: Record<ConceptoRecordatorio, string>;
    telefonosConOptin: number;
    cobrosEnVentana: number;
    duplicadosExcluidos: number;
    /** Cobros de atletas que la escuela dio de baja: no se recuerdan. */
    atletaDadoDeBaja: number;
    migracionAplicada: boolean;
}

/**
 * Arma el plan de una escuela para el día de `ahora`. No escribe nada.
 * `hoyOverride` sirve al script para simular mañana. `canales` por defecto =
 * solo WhatsApp (lo de siempre); el job pasa lo que la escuela tiene prendido.
 */
export async function planDeEscuela(
    schoolId: string, ahora: Date, hoyOverride?: string,
    canales: CanalesEscuela = { whatsapp: true, correo: false },
): Promise<{ plan: Plan; diag: DiagnosticoEscuela }> {
    const hoy = hoyOverride ?? fechaColombia(ahora);
    const desde = sumarDias(hoy, -ESCALONES[ESCALONES.length - 1].hasta);
    const hasta = sumarDias(hoy, -ESCALONES[0].desde);

    const [{ data: escuela }, integracion, { data: ajustes }] = await Promise.all([
        supabase.from('schools').select('name').eq('id', schoolId).maybeSingle(),
        integracionActiva(schoolId),
        supabase.from('school_settings').select('payment_cutoff_day, billing_cycle_type, collection_policy_notice').eq('school_id', schoolId).maybeSingle(),
    ]);
    const nombreEscuela = String((escuela as any)?.name ?? '').replace(/&amp;/g, '&');
    // «Los primeros N días de cada mes» solo es cierto con calendario fijo
    // (con ciclo por aniversario cada atleta vence en su propia fecha).
    const diaCorte = (ajustes as any)?.billing_cycle_type === 'fixed_calendar'
        ? Number((ajustes as any)?.payment_cutoff_day) || null
        : null;
    const avisoPolitica = String((ajustes as any)?.collection_policy_notice ?? '').trim() || null;

    // Solo mensualidades (las plantillas dicen "la mensualidad de …"), con saldo
    // y sin comprobante en revisión: a quien ya pagó y espera aprobación no se le cobra.
    const { data: crudos, error } = await supabase.from('payments')
        .select('id, school_id, parent_id, user_id, child_id, unregistered_athlete_id, concept, amount, amount_paid, early_payment_discount_applied, late_fee_amount, status, due_date, payment_type, payment_category, period_year, period_month, charge_notice_sent_at, overdue_notice_sent_at, requires_review')
        .eq('school_id', schoolId)
        .eq('payment_type', 'subscription')
        .in('status', ['pending', 'overdue', 'partial'])
        .gte('due_date', desde)
        .lte('due_date', hasta)
        .limit(5000);
    if (error) throw new Error(`payments: ${error.message}`);
    const pagos = ((crudos as any[]) ?? [])
        .filter((p) => p.requires_review !== true && entraEnRecordatorios(p)) as PagoEstado[];

    const duplicados = new Set(await findDuplicatePaymentIds(schoolId, pagos as any));
    const vivos = pagos.filter((p) => !duplicados.has(p.id));

    const ids = (f: (p: PagoEstado) => string | null) => [...new Set(vivos.map(f).filter(Boolean))] as string[];
    const adultos = ids((p) => (!p.child_id && !p.unregistered_athlete_id ? p.user_id : null));
    const [perfiles, hijos, noReg, membresias] = await Promise.all([
        leerPorIds('profiles', 'id, full_name, email, phone', ids((p) => p.parent_id || p.user_id)),
        leerPorIds('children', `id, is_active, ${COLUMNAS_CONTACTO_HIJO}`, ids((p) => p.child_id)),
        leerPorIds('unregistered_athletes', `id, is_active, ${COLUMNAS_CONTACTO_FICHA}`, ids((p) => p.unregistered_athlete_id)),
        Promise.all(trozos(adultos).map(async (t) => {
            const { data } = await supabase.from('school_members')
                .select('profile_id, status').eq('school_id', schoolId).eq('role', 'athlete').in('profile_id', t);
            return (data ?? []) as { profile_id: string; status: string }[];
        })).then((r) => r.flat()),
    ]);
    const estadosAdulto = new Map<string, string[]>();
    for (const m of membresias) estadosAdulto.set(m.profile_id, [...(estadosAdulto.get(m.profile_id) ?? []), m.status]);
    const inactivos = cobrosDeAtletaDadoDeBaja(vivos, {
        hijos: new Map(hijos.map((x) => [x.id, x])),
        noRegistrados: new Map(noReg.map((x) => [x.id, x])),
        estadosAdulto,
    });
    const cobrables = vivos.filter((p) => !inactivos.has(p.id));

    const ahoraDelDia = hoyOverride ? new Date(`${hoyOverride}T13:00:00Z`) : ahora;
    const { familias } = agruparPorFamilia(cobrables, {
        perfiles: new Map(perfiles.map((x) => [x.id, x])),
        hijos: new Map(hijos.map((x) => [x.id, x])),
        noRegistrados: new Map(noReg.map((x) => [x.id, x])),
    }, ahoraDelDia, mesColombia(ahoraDelDia));

    let migracionAplicada = true;
    let enviados = new Set<string>();
    try {
        enviados = await avisosRegistrados(cobrables.map((p) => p.id));
    } catch (e) {
        if (!(e instanceof MigracionPendienteError)) throw e;
        migracionAplicada = false;
    }

    const [optin, estadoHoy, recordatorioHoy] = await Promise.all([
        // Sin el canal WhatsApp prendido, nadie tiene opt-in para la cadencia: todo va por correo (si está).
        integracion && canales.whatsapp ? telefonosConOptin(integracion) : Promise.resolve(new Set<string>()),
        contactosConEstadoDeCuentaHoy(schoolId, ahoraDelDia).catch(() => new Set<string>()),
        contactosConRecordatorioHoy(schoolId, ahoraDelDia),
    ]);

    const plantillas = {} as Record<ConceptoRecordatorio, string>;
    for (const esc of ESCALONES) {
        if (!integracion) { plantillas[esc.concepto] = 'sin_integracion'; continue; }
        const v = await plantillaAprobada(integracion, esc.concepto);
        plantillas[esc.concepto] = v.aprobada ? `APPROVED (${CONCEPTOS[esc.concepto].plantilla})` : `${v.motivo}${v.detalle ? `: ${v.detalle}` : ''}`;
    }

    const plan = planificar({
        hoy, escuela: nombreEscuela, familias,
        pagos: new Map(cobrables.map((p) => [p.id, p])),
        enviados, optin,
        contactadosHoy: new Set([...estadoHoy, ...recordatorioHoy]),
        canalCorreo: canales.correo,
        tipos: { previo: canales.previo !== false, mora: canales.mora !== false },
        diaCorte,
        avisoPolitica,
    });
    return {
        plan,
        diag: {
            escuela: nombreEscuela, integracion, plantillas, telefonosConOptin: optin.size,
            cobrosEnVentana: cobrables.length, duplicadosExcluidos: duplicados.size, atletaDadoDeBaja: inactivos.size, migracionAplicada,
        },
    };
}

// ─── Envío ───────────────────────────────────────────────────────────────────

export type ResultadoContacto = 'enviado' | 'ya_reclamado' | `no_enviado:${string}`;

type EnvioCanal = { enviado: true; waMessageId?: string | null; plantilla?: string | null } | { enviado: false; motivo: string };

/**
 * Desglose de mora del correo («Mensualidad $X · Recargo por mora $Y · Total
 * $Z»), o null si el mensaje no lleva mora. El total ya la incluye.
 */
export function moraParaCorreo(c: Pick<ContactoPlaneado, 'total' | 'mora'>): { base: string; fee: string } | null {
    const d = desgloseMora(c.total ?? 0, c.mora ?? 0);
    return d ? { base: fmtCop(d.mensualidad), fee: fmtCop(d.recargo) } : null;
}

/** El escalón por correo. El botón abre /p/:token del cobro líder (paga sin iniciar sesión). */
async function enviarPorCorreo(schoolId: string, c: ContactoPlaneado, lider: string): Promise<EnvioCanal> {
    if (!c.email) return { enviado: false, motivo: 'sin_correo' };
    // Sin token (falló la emisión) el botón cae a «Mis pagos», que pide iniciar sesión.
    const token = await emitirTokenCobro(lider).catch(() => null);
    const link = token ? enlaceDeCobro(appPublica(), token) : `${appPublica()}/my-payments`;
    const tpl = await BrandedEmailTemplates.recordatorioCobro({
        concepto: c.concepto,
        parentName: c.datos.nombreContacto,
        athletes: c.datos.nombreAtleta,
        // El total solo («$165.000»): `datos.monto` trae la frase de mora de la
        // plantilla de WhatsApp; el correo la muestra desglosada (lateFee).
        amount: c.total != null ? fmtCop(c.total) : c.datos.monto,
        period: c.datos.periodo ?? null,
        dueDate: c.datos.fechaVencimiento ?? '',
        daysOverdue: c.datos.diasVencido ?? null,
        paymentLink: link,
        schoolId,
        cutoffDay: c.diaCorte ?? null,
        policyNotice: c.avisoPolitica ?? null,
        lateFee: moraParaCorreo(c),
    });
    const r = await emailClient.send({ to: c.email, subject: tpl.subject, html: tpl.html });
    if (!r?.success) return { enviado: false, motivo: 'correo_fallo' };
    return { enviado: true, waMessageId: null, plantilla: `correo:${c.concepto}` };
}

/**
 * Reclama el contacto en la base y lo manda. Orden:
 *   1. fila líder (candado familia-día + cobro-escalón). 23505 = otro BFF o ya hecho.
 *   2. filas del resto de cobros del mensaje (ignoreDuplicates).
 *   3. enviarCobroPorPlantilla (vuelve a validar opt-in, plantilla y horario).
 *   4. Salió: status 'sent' + estampa charge/overdue_notice_sent_at.
 *      No salió: se borran las filas (la familia no fue contactada; otro día
 *      dentro de la ventana puede intentarse).
 */
export async function enviarContacto(schoolId: string, c: ContactoPlaneado, ahora: Date, hoy = fechaColombia(ahora)): Promise<ResultadoContacto> {
    const base = { school_id: schoolId, notice_type: c.concepto, channel: c.canal, family_key: c.familyKey, contact_day: hoy, status: 'claimed' };
    const [lider, ...resto] = c.paymentIds;
    const { data: filaLider, error: errLider } = await supabase.from('collection_notices')
        .insert({ ...base, payment_id: lider, is_lead: true }).select('id').maybeSingle();
    if (errLider) {
        if ((errLider as any).code === '23505') return 'ya_reclamado';
        return `no_enviado:reserva ${errLider.message}`;
    }
    if (resto.length) {
        await supabase.from('collection_notices')
            .upsert(resto.map((payment_id) => ({ ...base, payment_id, is_lead: false })), { onConflict: 'payment_id,notice_type', ignoreDuplicates: true });
    }
    const r = c.canal === 'email'
        ? await enviarPorCorreo(schoolId, c, lider)
        : await enviarCobroPorPlantilla({
            schoolId, concepto: c.concepto, telefono: c.waId!, datos: c.datos,
            tokenBoton: await emitirTokenCobro(lider), paymentId: lider, parentId: c.perfilId, ahora,
        });

    if (!r.enviado) {
        await supabase.from('collection_notices').delete()
            .eq('school_id', schoolId).eq('family_key', c.familyKey).eq('contact_day', hoy)
            .eq('notice_type', c.concepto).in('payment_id', c.paymentIds);
        return `no_enviado:${r.motivo}`;
    }

    const ahoraIso = new Date().toISOString();
    await supabase.from('collection_notices')
        .update({ status: 'sent', sent_at: ahoraIso, wa_message_id: r.waMessageId ?? null, detail: r.plantilla })
        .eq('school_id', schoolId).eq('family_key', c.familyKey).eq('contact_day', hoy)
        .eq('notice_type', c.concepto).in('payment_id', c.paymentIds);
    const esMora = ESCALONES.find((e) => e.concepto === c.concepto)!.mora;
    const columna = esMora ? 'overdue_notice_sent_at' : 'charge_notice_sent_at';
    await supabase.from('payments').update({ [columna]: ahoraIso }).in('id', c.paymentIds).is(columna, null);
    return 'enviado';
}

export interface ResumenCorrida {
    escuela: string;
    contactos: number;
    enviados: number;
    yaReclamados: number;
    noEnviados: Record<string, number>;
    porEscalon: Record<string, number>;
    descartes: Plan['descartes'];
}

/** El job: todas las escuelas habilitadas, una vez por día hábil a las 8:00 COT. */
export async function runRecordatoriosCobro(ahora: Date = new Date()): Promise<Record<string, ResumenCorrida | string>> {
    const out: Record<string, ResumenCorrida | string> = {};
    if (process.env.DISABLE_RECORDATORIOS_COBRO_WHATSAPP === 'true') return out;
    if (!esHoraDeRecordatorios(ahora)) return out;

    const escuelas = await escuelasConRecordatorios();
    if (escuelas.size === 0) return out;
    // El estado de cuenta del mes manda primero: la escuela espera hasta que salga.
    const ids = [...escuelas.keys()];
    const pendientes = await escuelasConEstadoPendiente(ids, ahora).catch(() => new Set(ids));

    for (const [schoolId, canales] of escuelas) {
        if (pendientes.has(schoolId)) { out[schoolId] = 'estado de cuenta del mes pendiente: se espera'; continue; }
        try {
            const { plan, diag } = await planDeEscuela(schoolId, ahora, undefined, canales);
            if (!diag.migracionAplicada) { out[schoolId] = 'migración 20261006101656 sin aplicar: no se manda nada'; continue; }
            const r: ResumenCorrida = {
                escuela: diag.escuela, contactos: plan.contactos.length, enviados: 0, yaReclamados: 0,
                noEnviados: {}, porEscalon: {}, descartes: plan.descartes,
            };
            for (const c of plan.contactos) {
                const res = await enviarContacto(schoolId, c, ahora, plan.hoy);
                if (res === 'enviado') { r.enviados++; r.porEscalon[c.concepto] = (r.porEscalon[c.concepto] || 0) + 1; }
                else if (res === 'ya_reclamado') r.yaReclamados++;
                else { const m = res.slice('no_enviado:'.length); r.noEnviados[m] = (r.noEnviados[m] || 0) + 1; }
            }
            out[schoolId] = r;
            console.log('[recordatorios-cobro]', JSON.stringify(r));
        } catch (e: any) {
            console.error('[recordatorios-cobro] escuela falló', { schoolId, error: e?.message || String(e) });
            out[schoolId] = `error: ${e?.message || e}`;
        }
    }
    return out;
}

