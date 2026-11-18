/**
 * estado-de-cuenta.service — UN mensaje por familia con todo lo que debe
 * (vencido + pendiente) y todo lo necesario para pagar: botón /p/:token por
 * cobro, QR, llaves y cuentas de la escuela, y el WhatsApp para el comprobante.
 *
 * Pedido del usuario (2026-10-05): "Todos los meses se debe enviar por correo
 * la notificación, y cuando acepten, por WhatsApp; con métodos de pago, link de
 * pago, QR de pago; todo es todo para facilitarles."
 *
 * Lo usan dos llamadores:
 *   · el job mensual (jobs/estado-de-cuenta-mensual.job.ts), modo 'mensual';
 *   · el script manual (scripts/enviar-estado-de-cuenta.ts), modos 'manual' y
 *     'reenvio' (el reenvío del 2026-10-06 tras los 304 correos con enlace a
 *     localhost).
 *
 * ─── Ley 2300 de 2023 ───────────────────────────────────────────────────────
 * Horario (L-V 7-19, sáb 8-15, nunca domingos ni festivos) y UN contacto por
 * día: por eso es un solo mensaje por familia y no un aviso por cobro, y por
 * eso el canal es WhatsApp O correo, nunca los dos (ver `elegirCanal`).
 *
 * ─── Idempotencia en la base ────────────────────────────────────────────────
 * Los tres BFF (dev/stg/prod) comparten la base y corren los mismos cron. Cada
 * familia reserva una fila en email_sends con id determinístico
 * (`claveEstadoDeCuenta`): escuela + familia + MES en el modo mensual. El
 * segundo proceso choca contra el PK y no manda nada. Al terminar la corrida
 * mensual de una escuela se escribe una marca (`estado_de_cuenta_corrida`) que
 * libera a los avisos por cobro (ver "Convivencia").
 *
 * ─── Convivencia con payment-lifecycle-emails (aviso por cobro) ─────────────
 * Con auto_generate_payments los cobros del mes nacen el día 1 a las 01:30 COT
 * y el aviso "cobro generado" (cada 15 min, desde las 7:00) le ganaría por una
 * hora al estado de cuenta de las 8:00: dos contactos el mismo día. Regla:
 *   1. Mientras el estado de cuenta del mes de una escuela esté PENDIENTE
 *      (`escuelasConEstadoPendiente`: activo en la escuela, ya hay cobros de
 *      mensualidad del mes y no está la marca de la corrida), los avisos por
 *      cobro y de vencido de esa escuela se POSPONEN (no se reclaman).
 *   2. El estado de cuenta estampa `charge_notice_sent_at` /
 *      `overdue_notice_sent_at` de los cobros que incluyó: el job por cobro ya
 *      no los toca.
 *   3. Escrita la marca, el job por cobro sigue solo con lo que nace después
 *      en el mes (alta nueva, cobro manual), y salta a quien ya recibió el
 *      estado de cuenta HOY (`contactosConEstadoDeCuentaHoy`): 1 contacto/día.
 *   4. Freno de seguridad: la posposición dura hasta el día 15. Si el job
 *      mensual no corre (kill-switch en los tres BFF, caída), los avisos por
 *      cobro vuelven a salir solos en vez de quedar mudos todo el mes.
 *
 * ─── Activación ─────────────────────────────────────────────────────────────
 * Por escuela: `charge_notifications_enabled` (el mismo gate de los avisos por
 * cobro) Y `monthly_statement_enabled` (migración 20261005*; si la columna no
 * existe todavía, se lee como APAGADO: la coordinación entre los tres BFF tiene
 * que vivir en la base, no en el env de cada uno). Por proceso: kill-switch
 * `DISABLE_ESTADO_CUENTA_MENSUAL=true` (solo apaga el envío de ese BFF).
 * Desde `ESTADO_CUENTA_DESDE` (default 2026-11): octubre ya tuvo su estado de
 * cuenta manual el 2026-10-05.
 */

import { supabase } from '../config/supabase';
import { emailClient } from '../utils/emailClient';
import { buildBrandedEmail } from '../utils/emailLayout';
import { resolveSchoolBranding } from '../utils/schoolBrandingResolver';
import { esFestivoColombia } from '../utils/festivos-colombia';
import {
    appPublica, bffPublico, enlaceDeCobro, urlPublicaSegura, urlQrDeCobro,
} from '../utils/url-publica-familias';
import { findDuplicatePaymentIds } from './duplicatePayerGuard.service';
import {
    aWaId, dentroDeHorarioDeCobranza, enviarCobroPorPlantilla, plantillaAprobada,
} from './whatsapp-plantillas.service';
import { cerrarEnvio, escaparHtml, fechaColombia, reservarEnvio, uuidDeClave } from './avisos-correo.service';
import { emitirTokenCobro, enlaceWhatsApp, nombreCorto, whatsappDeLaEscuela } from './cobro-enlace-publico.service';
import { saldoDelCobro } from '../utils/saldo-cobro';
import { mediosDePago, type MediosDePago } from './whatsapp-medios-de-pago.service';
// Los textos del link viven en payment-accounts (módulo puro): varias pruebas
// moquean el servicio de medios entero y no exportarían estas constantes.
import { AVISO_LINK_DE_PAGO, textoBotonLinkDePago, esCobroUnico, etiquetaDeCobro } from './payment-accounts';
import { COLUMNAS_CONTACTO_FICHA, COLUMNAS_CONTACTO_HIJO, contactoDeFicha, contactoDeHijoSinCuenta, type FichaContacto } from './contacto-acudiente';
import { escuelaFacturaElectronicamente } from './factura-pagador.service';
import { enlaceActivarAvisos } from './whatsapp-activar-avisos';
import { desgloseMora, montoConMora, recargoMora, textoDesgloseMora } from '../utils/desglose-mora';

export const TIPO_ESTADO = 'estado_de_cuenta';
export const TIPO_CORRIDA = 'estado_de_cuenta_corrida';
/** La posposición de los avisos por cobro no pasa de este día del mes. */
export const DIA_LIMITE_POSPOSICION = 15;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export interface PagoEstado {
    id: string;
    school_id: string;
    parent_id: string | null;
    user_id: string | null;
    child_id: string | null;
    unregistered_athlete_id: string | null;
    concept: string | null;
    amount: number | string;
    amount_paid?: number | string | null;
    /** Descuento por pronto pago ya aplicado: resta del saldo (saldoDelCobro). */
    early_payment_discount_applied?: number | string | null;
    /** Recargo por mora que apply_late_fees ya sumó DENTRO de `amount` (0 si no hay). */
    late_fee_amount?: number | string | null;
    status: string;
    due_date: string | null;
    payment_type?: string | null;
    /** Categoría explícita: un cobro único (inscripción, seguro…) no es «del mes». */
    payment_category?: string | null;
    period_year?: number | null;
    period_month?: number | null;
    charge_notice_sent_at?: string | null;
    overdue_notice_sent_at?: string | null;
}

export interface FilaEstado {
    paymentId: string;
    atleta: string;
    concepto: string;
    vence: string | null;
    saldo: number;
    /** Parte del saldo que es recargo por mora (late_fee_amount, recortado al saldo); 0 o ausente si no hay. */
    mora?: number;
    vencido: boolean;
    /** Cobro del mes del estado de cuenta (lo que menciona la plantilla de WhatsApp). */
    delMes: boolean;
    status: string;
    token?: string | null;
}

export interface Familia {
    /** Clave estable: correo en minúscula, o 'wa:<wa_id>' si no tiene correo. */
    clave: string;
    email: string | null;
    waId: string | null;
    nombre: string;
    perfilId: string | null;
    filas: FilaEstado[];
    /** Algún cobro suyo ya tuvo aviso (cobro generado o vencido) HOY. */
    avisadaHoy: boolean;
}

export type ModoEstado = 'mensual' | 'manual' | 'reenvio';
export type CanalPedido = 'auto' | 'correo';
export type Canal = 'whatsapp_o_correo' | 'correo' | 'whatsapp' | 'ninguno';

// ─────────────────────────────────────────────────────────────────────────────
// Puras (testeables sin base)
// ─────────────────────────────────────────────────────────────────────────────

export const fmtCop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

export const fechaCorta = (d: string | null) => {
    if (!d) return '—';
    const f = new Date(`${d.slice(0, 10)}T12:00:00Z`);
    return `${f.getUTCDate()} ${MESES[f.getUTCMonth()].slice(0, 3)}`;
};

/** 'YYYY-MM' del instante en hora de Bogotá. */
export const mesColombia = (ahora: Date) => fechaColombia(ahora).slice(0, 7);

export const etiquetaMes = (mes: string) => `${MESES[Number(mes.slice(5, 7)) - 1]} ${mes.slice(0, 4)}`;

/**
 * Día hábil para el estado de cuenta: lunes a viernes, no festivo. El sábado
 * está dentro del horario legal pero no es "día hábil": el envío mensual
 * espera al lunes (o al martes, si el lunes es festivo).
 */
export function esDiaHabil(ahora: Date): boolean {
    const dia = new Date(ahora.getTime() - 5 * 3600_000).getUTCDay();
    return dia >= 1 && dia <= 5 && !esFestivoColombia(ahora);
}

/** Primer día hábil (YYYY-MM-DD) desde `fecha` inclusive. */
export function primerDiaHabilDesde(fechaISO: string): string {
    let t = new Date(`${fechaISO}T17:00:00Z`); // 12:00 COT
    for (let i = 0; i < 15; i++) {
        if (esDiaHabil(t)) return fechaColombia(t);
        t = new Date(t.getTime() + 86_400_000);
    }
    return fechaColombia(t);
}

/** ¿Es la hora del envío mensual? Día hábil, desde las 8:00 COT y dentro del horario legal. */
export function esHoraDelEnvioMensual(ahora: Date): boolean {
    const hora = new Date(ahora.getTime() - 5 * 3600_000).getUTCHours();
    return esDiaHabil(ahora) && hora >= 8 && dentroDeHorarioDeCobranza(ahora);
}

/**
 * Clave de idempotencia (→ id de email_sends).
 *   mensual: una por familia y MES — los tres BFF y los ticks de 8 a 12 chocan.
 *   manual:  una por familia y DÍA — misma forma que el script original, así
 *            correrlo dos veces el mismo día no duplica.
 *   reenvio: prefijo propio — la reserva del envío original no lo frena.
 */
export function claveEstadoDeCuenta(p: { modo: ModoEstado; schoolId: string; familia: string; ahora: Date }): string {
    const dia = fechaColombia(p.ahora);
    if (p.modo === 'mensual') return `${TIPO_ESTADO}:${p.schoolId}:${p.familia}:${dia.slice(0, 7)}`;
    if (p.modo === 'reenvio') return `${TIPO_ESTADO}_reenvio:${p.schoolId}:${p.familia}:${dia}`;
    return `${TIPO_ESTADO}:${p.schoolId}:${p.familia}:${dia}`;
}

export const claveCorrida = (schoolId: string, mes: string) => `${TIPO_CORRIDA}:${schoolId}:${mes}`;

/**
 * Canal de UNA familia. WhatsApp solo si la familia lo aceptó, la escuela tiene
 * la plantilla de estado de cuenta aprobada y hay cobros del mes (la plantilla
 * habla de "la mensualidad de X correspondiente a <mes>"); si el envío de
 * WhatsApp no sale (sin opt-in, Graph caído), cae al correo en la misma
 * corrida — sigue siendo un solo contacto, porque el primero no llegó. Nunca
 * los dos: la Ley 2300 cuenta contactos, no canales.
 */
export function elegirCanal(p: {
    pedido: CanalPedido; whatsappEscuela: boolean; waId: string | null; email: string | null; filasDelMes: number;
}): Canal {
    const puedeWa = p.pedido === 'auto' && p.whatsappEscuela && !!p.waId && p.filasDelMes > 0;
    if (puedeWa) return p.email ? 'whatsapp_o_correo' : 'whatsapp';
    return p.email ? 'correo' : 'ninguno';
}

/**
 * Lo que falta por pagar: la MISMA regla que el enlace /p/:token y el modal de
 * cobros (amount - amount_paid - early_payment_discount_applied, nunca
 * negativo). Antes solo restaba amount_paid en 'partial' e ignoraba el pronto
 * pago: el estado de cuenta podía decir más que la página del cobro.
 */
const saldoDe = (p: PagoEstado) => saldoDelCobro(p);

/**
 * Agrupa los cobros vivos por familia. Contacto: mismo criterio que
 * payment-lifecycle-emails (perfil del pagador → contacto temporal del menor →
 * ficha sin cuenta vía contactoDeFicha: si es MENOR, el ACUDIENTE, nunca el niño
 * — H-06). Dos perfiles con el mismo correo son UNA familia: dos hermanas con
 * ficha y el mismo acudiente reciben UN solo estado de cuenta.
 */
export function agruparPorFamilia(
    pagos: PagoEstado[],
    datos: {
        perfiles: Map<string, { id: string; full_name?: string | null; email?: string | null; phone?: string | null }>;
        hijos: Map<string, { full_name?: string | null; parent_name_temp?: string | null; parent_email_temp?: string | null; parent_phone_temp?: string | null }>;
        noRegistrados: Map<string, FichaContacto>;
    },
    ahora: Date,
    mes: string,
): { familias: Familia[]; sinContacto: number } {
    const hoy = fechaColombia(ahora);
    const inicioHoy = new Date(`${hoy}T00:00:00-05:00`).toISOString();
    const [anio, numMes] = [Number(mes.slice(0, 4)), Number(mes.slice(5, 7))];
    const porClave = new Map<string, Familia>();
    let sinContacto = 0;

    for (const p of pagos) {
        const perfil = datos.perfiles.get(p.parent_id || p.user_id || '');
        const hijo = datos.hijos.get(p.child_id || '');
        const nr = datos.noRegistrados.get(p.unregistered_athlete_id || '');
        const cHijo = hijo ? contactoDeHijoSinCuenta(hijo) : null;
        const cFicha = nr ? contactoDeFicha(nr, hoy) : null;
        const email = String(perfil?.email || cHijo?.email || cFicha?.email || '').trim().toLowerCase();
        const waId = aWaId(perfil?.phone || cHijo?.phone || cFicha?.phone || null);
        const clave = email.includes('@') ? email : (waId ? `wa:${waId}` : null);
        if (!clave) { sinContacto++; continue; }

        const saldo = saldoDe(p);
        if (saldo <= 0) continue;

        const f = porClave.get(clave) ?? {
            clave,
            email: email.includes('@') ? email : null,
            waId,
            nombre: perfil?.full_name || cHijo?.nombre || cFicha?.nombre || 'Familia',
            perfilId: perfil?.id ?? null,
            filas: [],
            avisadaHoy: false,
        };
        if (!f.waId && waId) f.waId = waId;
        // «Del mes» = la mensualidad del mes: es lo que nombra la plantilla de
        // WhatsApp («la mensualidad de … vence … por …»). Un cobro único (seguro,
        // inscripción del alta) lleva period_year/period_month del mes en que
        // nació, pero no es la mensualidad: va en el correo (tabla con su
        // concepto) y en la página del cobro, no en el monto de la plantilla.
        const delMes = !esCobroUnico(p.payment_category) && (
            (p.period_year === anio && p.period_month === numMes)
            || (!p.period_year && !!p.due_date && p.due_date.slice(0, 7) === mes));
        f.filas.push({
            paymentId: p.id,
            atleta: hijo?.full_name || nr?.full_name || perfil?.full_name || '',
            concepto: p.concept || etiquetaDeCobro(p),
            vence: p.due_date ? p.due_date.slice(0, 10) : null,
            saldo,
            mora: Math.min(recargoMora(p.late_fee_amount), saldo),
            vencido: p.status === 'overdue' || (!!p.due_date && p.due_date.slice(0, 10) < hoy),
            delMes,
            status: p.status,
        });
        if ((p.charge_notice_sent_at && p.charge_notice_sent_at >= inicioHoy)
            || (p.overdue_notice_sent_at && p.overdue_notice_sent_at >= inicioHoy)) f.avisadaHoy = true;
        porClave.set(clave, f);
    }

    // Lo más viejo primero: es lo que conviene pagar primero y el botón del QR
    // apunta a ese cobro.
    const familias = [...porClave.values()];
    for (const f of familias) f.filas.sort((a, b) => (a.vence ?? '9999').localeCompare(b.vence ?? '9999'));
    return { familias, sinContacto };
}

/**
 * Cobros cuyo atleta la escuela dio de baja: no van en el estado de cuenta
 * (caso Dynasty 2026-10-06 — a la familia de un atleta inactivo le seguían
 * llegando correos). Defensa en profundidad: la baja (set_school_athlete_status)
 * ya anula los cobros pendientes, pero lo que quedó vivo por otra vía no debe
 * salir.
 *   · child_id → children.is_active = false
 *   · unregistered_athlete_id → unregistered_athletes.is_active = false
 *   · adulto (user_id sin child ni ficha) → membresía athlete 'inactive' en la
 *     escuela y ninguna 'active'.
 * El enrollment no se cruza: payments no tiene enrollment_id (verificado en
 * information_schema el 2026-10-06) y un atleta puede tener varias
 * inscripciones; inferirlo sería adivinar.
 * is_active NULL o ausente se lee como activo.
 */
export function cobrosDeAtletaInactivo(
    pagos: PagoEstado[],
    datos: {
        hijos: Map<string, { is_active?: boolean | null }>;
        noRegistrados: Map<string, { is_active?: boolean | null }>;
        /** profile_id → estados de su membresía athlete en la escuela. */
        membresiasAtleta: Map<string, string[]>;
    },
): Set<string> {
    const out = new Set<string>();
    for (const p of pagos) {
        if (p.child_id) {
            if (datos.hijos.get(p.child_id)?.is_active === false) out.add(p.id);
            continue;
        }
        if (p.unregistered_athlete_id) {
            if (datos.noRegistrados.get(p.unregistered_athlete_id)?.is_active === false) out.add(p.id);
            continue;
        }
        const estados = p.user_id ? datos.membresiasAtleta.get(p.user_id) : undefined;
        if (estados?.includes('inactive') && !estados.includes('active')) out.add(p.id);
    }
    return out;
}

/** Variables de pago_recordatorio_previo_v3 para una familia (solo cobros del mes). */
export function datosWhatsAppDeFamilia(f: Familia, escuela: string, mes: string) {
    const delMes = f.filas.filter((r) => r.delMes);
    const nombres = [...new Set(delMes.map((r) => nombreCorto(r.atleta)?.split(' ')[0]).filter(Boolean))] as string[];
    const atletas = nombres.length <= 1 ? (nombres[0] ?? '')
        : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
    const vence = delMes.map((r) => r.vence).filter(Boolean).sort()[0] ?? null;
    return {
        nombreContacto: f.nombre.split(' ')[0] || f.nombre,
        nombreAtleta: atletas,
        nombreEscuela: escuela,
        periodo: etiquetaMes(mes),
        fechaVencimiento: vence ? (() => { const d = new Date(`${vence}T12:00:00Z`); return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`; })() : null,
        // Con mora: «$165.000, que incluye $15.000 de recargo por mora».
        monto: montoConMora(
            delMes.reduce((s, r) => s + r.saldo, 0),
            delMes.reduce((s, r) => s + (r.mora ?? 0), 0),
            fmtCop,
        ),
        /** El botón abre el cobro del mes que vence primero; esa página lista los demás. */
        paymentIdBoton: delMes[0]?.paymentId ?? null,
    };
}

export interface ContenidoCorreo {
    escuela: string;
    familia: Familia;
    appBase: string;
    bffBase: string;
    medios: MediosDePago['cuentas'];
    qrEscuelaUrl: string | null;
    whatsappComprobante: string | null;
    /**
     * Link de pago genérico de la escuela (p.ej. Wompi de Dynasty), o null. No
     * reemplaza los botones «Pagar» de cada cobro (esos abren /p/<token>): es
     * un camino más dentro de «Cómo pagar», con el aviso de mandar comprobante
     * porque Wompi no sabe a qué cobro corresponde.
     */
    linkDePago?: string | null;
    nota?: string | null;
    /** La escuela emite factura electrónica: se ofrece completar los datos (lleva a /p/<token>#factura). */
    ofrecerFactura?: boolean;
    /**
     * wa.me con «… ACTIVAR AVISOS» prellenado (whatsapp-activar-avisos): la
     * familia que recibe esto por correo porque no dio el consentimiento lo da
     * desde su WhatsApp con un toque. null/ausente = no se ofrece.
     */
    whatsappAvisos?: string | null;
}

/**
 * Cuerpo del correo. Sin data: URIs (Gmail los bloquea): los QR son <img> con
 * URL https — el de la escuela (su imagen cargada en school-assets) y el del
 * enlace de pago (PNG del BFF de producción).
 */
/** Bajo el valor de la fila: «Mensualidad $X · Recargo por mora $Y · Total $Z», si tiene mora. */
function lineaMoraFila(r: FilaEstado): string {
    const d = desgloseMora(r.saldo, r.mora ?? 0);
    if (!d) return '';
    // white-space normal: el desglose es más ancho que la columna del valor.
    return `<br><span style="color:#b91c1c;font-size:12px;white-space:normal;">${escaparHtml(textoDesgloseMora(d, fmtCop))}</span>`;
}

export function cuerpoCorreoEstado(c: ContenidoCorreo): string {
    const f = c.familia;
    const deuda = f.filas.reduce((s, r) => s + r.saldo, 0);
    const vencido = f.filas.filter((r) => r.vencido).reduce((s, r) => s + r.saldo, 0);
    const boton = (url: string, texto: string) =>
        `<a href="${escaparHtml(url)}" style="display:inline-block;padding:6px 12px;background:#248223;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:bold;">${texto}</a>`;

    const filas = f.filas.map((r) => `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee;">${escaparHtml(r.atleta)}<br><span style="color:#666;font-size:12px;">${escaparHtml(r.concepto)}</span></td>
              <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">${fechaCorta(r.vence)}${r.vencido ? '<br><span style="color:#b91c1c;font-size:12px;">Vencido</span>' : ''}</td>
              <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${fmtCop(r.saldo)}${lineaMoraFila(r)}${r.token ? `<br>${boton(enlaceDeCobro(c.appBase, r.token), 'Pagar')}` : ''}</td>
            </tr>`).join('');

    const tokenQr = f.filas.find((r) => r.token)?.token ?? null;
    const medios = c.medios.length
        ? `<ul style="padding-left:18px;margin:8px 0;">${c.medios.map((m) =>
            `<li style="margin:4px 0;">${escaparHtml(m.tipo)}: <strong style="font-family:monospace;font-size:15px;">${escaparHtml(m.numero)}</strong>${m.titular ? ` <span style="color:#666;">(${escaparHtml(m.titular)})</span>` : ''}</li>`).join('')}</ul>`
        : '';

    const qrs = [
        c.qrEscuelaUrl
            ? `<td align="center" style="padding:8px;vertical-align:top;"><img src="${escaparHtml(c.qrEscuelaUrl)}" alt="QR de pago de ${escaparHtml(c.escuela)}" width="200" style="display:block;width:200px;max-width:100%;border:0;"><div style="font-size:12px;color:#666;margin-top:4px;">Escanéalo desde la app de tu banco</div></td>`
            : '',
        tokenQr
            ? `<td align="center" style="padding:8px;vertical-align:top;"><img src="${escaparHtml(urlQrDeCobro(c.bffBase, tokenQr))}" alt="QR del enlace de pago" width="160" height="160" style="display:block;width:160px;height:160px;border:0;"><div style="font-size:12px;color:#666;margin-top:4px;">Escanéalo con la cámara para abrir el pago</div></td>`
            : '',
    ].filter(Boolean).join('');

    return `
        ${c.nota ? `<p style="background:#fff7e6;border-left:4px solid #FB9F1E;padding:10px 12px;margin:0 0 16px;">${escaparHtml(c.nota)}</p>` : ''}
        <p>Este es el resumen de lo que tienes pendiente con <strong>${escaparHtml(c.escuela)}</strong>:</p>
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;margin:12px 0;">
          <tr style="background:#f5f5f5;"><th align="left" style="padding:6px 8px;">Deportista / concepto</th><th align="left" style="padding:6px 8px;">Vence</th><th align="right" style="padding:6px 8px;">Valor</th></tr>
          ${filas}
          <tr><td colspan="2" style="padding:8px;"><strong>Total</strong></td><td style="padding:8px;text-align:right;"><strong>${fmtCop(deuda)}</strong></td></tr>
        </table>
        ${vencido > 0 ? `<p style="color:#b91c1c;">De ese total, <strong>${fmtCop(vencido)}</strong> ya están vencidos.</p>` : ''}
        <p>Cada botón <strong>Pagar</strong> abre el cobro sin tener que iniciar sesión.</p>
        <h3 style="font-size:16px;margin:20px 0 4px;">Cómo pagar</h3>
        ${c.linkDePago
            ? `<p style="margin:8px 0 4px;"><a href="${escaparHtml(c.linkDePago)}" style="display:inline-block;padding:10px 16px;background:#248223;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:bold;">${escaparHtml(textoBotonLinkDePago(c.linkDePago))}</a></p>
        <p style="margin:0 0 12px;font-size:13px;color:#444;">${escaparHtml(AVISO_LINK_DE_PAGO)}.</p>`
            : ''}
        ${medios ? `<p style="margin:0;">${c.linkDePago ? 'O transfiere' : 'Transfiere'} a cualquiera de estas cuentas de la escuela:</p>${medios}` : ''}
        ${qrs ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0;"><tr>${qrs}</tr></table>` : ''}
        ${c.whatsappComprobante
            ? `<p>Después de pagar, <a href="${escaparHtml(c.whatsappComprobante)}">envía el comprobante por WhatsApp a la escuela</a>. Si pagas por el botón en línea, no tienes que enviar nada.</p>`
            : '<p>Después de pagar, envía el comprobante a la escuela.</p>'}
        ${c.ofrecerFactura && tokenQr
            ? `<p style="margin-top:16px;font-size:13px;color:#444;">¿Necesitas <strong>factura electrónica</strong> a tu nombre? <a href="${escaparHtml(`${enlaceDeCobro(c.appBase, tokenQr)}#factura`)}">Completa tus datos aquí</a>; quedan guardados para los próximos pagos.</p>`
            : ''}
        ${c.whatsappAvisos
            ? `<p style="margin-top:16px;font-size:13px;color:#444;">¿Prefieres recibir estos avisos por <strong>WhatsApp</strong>? <a href="${escaparHtml(c.whatsappAvisos)}">Actívalos aquí</a>: se abre WhatsApp con el mensaje listo, solo tienes que enviarlo. Puedes darte de baja cuando quieras escribiendo BAJA.</p>`
            : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

async function todas<T>(q: (desde: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
    const out: T[] = [];
    for (let desde = 0; ; desde += 1000) {
        const { data, error } = await q(desde);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
        if ((data?.length ?? 0) < 1000) return out;
    }
}

const trozos = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / 200) }, (_, i) => a.slice(i * 200, i * 200 + 200));

async function leerPorIds(tabla: string, cols: string, ids: string[]): Promise<any[]> {
    const res = await Promise.all(trozos(ids).map((t) => supabase.from(tabla).select(cols).in('id', t)));
    return res.flatMap((r) => (r.data ?? []) as any[]);
}

/** Familias con deuda de una escuela, sin cobros duplicados por pagador. */
export async function familiasConDeuda(schoolId: string, ahora: Date, mes = mesColombia(ahora)) {
    const pagos = await todas<PagoEstado>((desde) => supabase.from('payments')
        .select('id, school_id, parent_id, user_id, child_id, unregistered_athlete_id, concept, amount, amount_paid, early_payment_discount_applied, late_fee_amount, status, due_date, payment_type, payment_category, period_year, period_month, charge_notice_sent_at, overdue_notice_sent_at')
        .eq('school_id', schoolId).in('status', ['pending', 'overdue', 'partial'])
        .order('due_date').range(desde, desde + 999));

    const duplicados = new Set(await findDuplicatePaymentIds(schoolId, pagos as any));
    const vivos = pagos.filter((p) => !duplicados.has(p.id));

    const ids = (f: (p: PagoEstado) => string | null) => [...new Set(vivos.map(f).filter(Boolean))] as string[];
    const adultos = ids((p) => (!p.child_id && !p.unregistered_athlete_id ? p.user_id : null));
    const [perfiles, hijos, noReg, membresias] = await Promise.all([
        leerPorIds('profiles', 'id, full_name, email, phone', ids((p) => p.parent_id || p.user_id)),
        leerPorIds('children', `id, is_active, ${COLUMNAS_CONTACTO_HIJO}`, ids((p) => p.child_id)),
        leerPorIds('unregistered_athletes', `id, is_active, ${COLUMNAS_CONTACTO_FICHA}`, ids((p) => p.unregistered_athlete_id)),
        Promise.all(trozos(adultos).map(async (t) => {
            const { data, error } = await supabase.from('school_members')
                .select('profile_id, status').eq('school_id', schoolId).eq('role', 'athlete').in('profile_id', t);
            if (error) throw new Error(error.message);
            return (data ?? []) as { profile_id: string; status: string }[];
        })).then((r) => r.flat()),
    ]);
    const membresiasAtleta = new Map<string, string[]>();
    for (const m of membresias) membresiasAtleta.set(m.profile_id, [...(membresiasAtleta.get(m.profile_id) ?? []), m.status]);
    const inactivos = cobrosDeAtletaInactivo(vivos, {
        hijos: new Map(hijos.map((x) => [x.id, x])),
        noRegistrados: new Map(noReg.map((x) => [x.id, x])),
        membresiasAtleta,
    });
    const cobrables = vivos.filter((p) => !inactivos.has(p.id));

    const { familias, sinContacto } = agruparPorFamilia(cobrables, {
        perfiles: new Map(perfiles.map((x) => [x.id, x])),
        hijos: new Map(hijos.map((x) => [x.id, x])),
        noRegistrados: new Map(noReg.map((x) => [x.id, x])),
    }, ahora, mes);
    return { familias, cobros: cobrables.length, duplicados: duplicados.size, sinContacto, atletaInactivo: inactivos.size };
}

/** ¿La escuela puede mandar el estado de cuenta por WhatsApp? (integración única + plantilla aprobada) */
export async function whatsappDisponibleEnEscuela(schoolId: string): Promise<boolean> {
    const { data } = await supabase.from('school_whatsapp_integrations')
        .select('id, waba_id, access_token_encrypted').eq('school_id', schoolId).eq('status', 'active');
    const activas = ((data as any[]) ?? []).filter((i) => i.waba_id && i.access_token_encrypted);
    if (activas.length !== 1) return false;
    const v = await plantillaAprobada(activas[0].id, 'recordatorio_previo');
    return v.aprobada;
}

async function qrDeLaEscuela(schoolId: string): Promise<string | null> {
    const { data } = await supabase.from('school_settings').select('payment_qr_url').eq('school_id', schoolId).maybeSingle();
    const url = (data as any)?.payment_qr_url;
    if (!url) return null;
    try { return urlPublicaSegura(url, 'El QR de la escuela'); } catch { return null; }
}

/**
 * Escuelas con el estado de cuenta mensual activo. `monthly_statement_enabled`
 * llega con la migración 20261005*: si la columna no existe aún, la consulta
 * falla y se devuelve [] — apagado en los tres BFF a la vez, que es lo único
 * coherente (ver encabezado).
 */
export async function escuelasConEstadoMensual(): Promise<string[]> {
    const { data, error } = await supabase.from('school_settings')
        .select('school_id')
        .eq('charge_notifications_enabled', true)
        .eq('monthly_statement_enabled', true);
    if (error) return [];
    return ((data as any[]) ?? []).map((r) => r.school_id);
}

export const primerMesActivo = () => process.env.ESTADO_CUENTA_DESDE || '2026-11';

/** ¿Ya hay cobros de mensualidad del mes? (los crea open_month: manual o auto_generate) */
async function hayCobrosDelMes(schoolId: string, mes: string): Promise<boolean> {
    const { count } = await supabase.from('payments')
        .select('id', { count: 'exact', head: true })
        .eq('school_id', schoolId)
        .eq('payment_type', 'subscription')
        .eq('period_year', Number(mes.slice(0, 4)))
        .eq('period_month', Number(mes.slice(5, 7)));
    return (count ?? 0) > 0;
}

async function corridaHecha(schoolId: string, mes: string): Promise<boolean> {
    const { data } = await supabase.from('email_sends').select('id').eq('id', uuidDeClave(claveCorrida(schoolId, mes))).maybeSingle();
    return !!data;
}

/**
 * Escuelas (de `schoolIds`) cuyos avisos por cobro deben esperar al estado de
 * cuenta del mes. Ver "Convivencia" en el encabezado.
 */
export async function escuelasConEstadoPendiente(schoolIds: string[], ahora: Date = new Date()): Promise<Set<string>> {
    const out = new Set<string>();
    const mes = mesColombia(ahora);
    if (mes < primerMesActivo()) return out;
    if (Number(fechaColombia(ahora).slice(8, 10)) > DIA_LIMITE_POSPOSICION) return out;
    const activas = new Set(await escuelasConEstadoMensual());
    for (const id of schoolIds) {
        if (!activas.has(id)) continue;
        if (!(await hayCobrosDelMes(id, mes))) continue;
        if (await corridaHecha(id, mes)) continue;
        out.add(id);
    }
    return out;
}

/**
 * Contactos (correo en minúscula y 'wa:<id>') que recibieron un estado de
 * cuenta HOY en esta escuela. El job por cobro los salta: 1 contacto/día.
 */
export async function contactosConEstadoDeCuentaHoy(schoolId: string, ahora: Date = new Date()): Promise<Set<string>> {
    const inicioHoy = new Date(`${fechaColombia(ahora)}T00:00:00-05:00`).toISOString();
    const { data } = await supabase.from('email_sends')
        .select('to_email, status, error')
        .eq('school_id', schoolId)
        .eq('email_type', TIPO_ESTADO)
        .gte('created_at', inicioHoy);
    const out = new Set<string>();
    for (const r of (data as any[]) ?? []) {
        for (const c of String(r.to_email ?? '').split(',')) {
            const v = c.trim().toLowerCase();
            if (v) out.add(v);
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Envío
// ─────────────────────────────────────────────────────────────────────────────

export interface OpcionesEnvio {
    modo: ModoEstado;
    /** false = simulación: no reserva, no emite tokens, no manda. */
    aplicar: boolean;
    canal?: CanalPedido;
    nota?: string | null;
    /**
     * Si viene, la nota solo va a estos correos. Reenvío del 2026-10-06: la
     * línea «corregimos el enlace de ayer» es para quien recibió el de ayer, no
     * para los acudientes que reciben su primer estado de cuenta.
     */
    notaSoloPara?: Set<string> | null;
    ahora?: Date;
    /** Overrides de los scripts (--frontend / --bff); siempre validados. */
    appUrl?: string | null;
    bffUrl?: string | null;
    /** Pausa entre correos (Resend ~2/s). */
    pausaMs?: number;
}

export interface ResumenEnvio {
    modo: string;
    escuela: string;
    cobros: number;
    duplicados_excluidos: number;
    /** Cobros vivos de atletas dados de baja: no salen (ver cobrosDeAtletaInactivo). */
    cobros_atleta_inactivo: number;
    cobros_sin_contacto: number;
    familias: number;
    familias_con_correo: number;
    familias_solo_whatsapp: number;
    ya_avisadas_hoy: number;
    por_whatsapp: number;
    por_correo: number;
    ya_enviados_antes: number;
    sin_canal: number;
    fallos: number;
    deuda_total: string;
    whatsapp_disponible: boolean;
    medios_de_pago: number;
    qr_escuela: boolean;
    motivos_whatsapp: Record<string, number>;
}

async function estamparAvisos(f: Familia): Promise<void> {
    const ahoraIso = new Date().toISOString();
    const ids = f.filas.map((r) => r.paymentId);
    const vencidos = f.filas.filter((r) => r.status === 'overdue').map((r) => r.paymentId);
    for (const t of trozos(ids)) {
        await supabase.from('payments').update({ charge_notice_sent_at: ahoraIso }).in('id', t).is('charge_notice_sent_at', null);
    }
    for (const t of trozos(vencidos)) {
        await supabase.from('payments').update({ overdue_notice_sent_at: ahoraIso }).in('id', t).is('overdue_notice_sent_at', null);
    }
}

/**
 * Manda (o simula) el estado de cuenta de una escuela. Lanza solo por
 * configuración inválida (URL no pública, fuera de horario con aplicar): el
 * llamador decide. Por familia nunca lanza.
 */
export async function enviarEstadoDeCuenta(schoolId: string, o: OpcionesEnvio): Promise<ResumenEnvio> {
    const ahora = o.ahora ?? new Date();
    const appBase = appPublica(o.appUrl);   // lanza si es localhost
    const bffBase = bffPublico(o.bffUrl);   // ídem
    if (o.aplicar && !dentroDeHorarioDeCobranza(ahora)) {
        throw new Error('Fuera del horario de cobranza (Ley 2300). No se manda nada.');
    }
    const mes = mesColombia(ahora);
    const canalPedido: CanalPedido = o.canal ?? 'auto';

    const [{ familias, cobros, duplicados, sinContacto, atletaInactivo }, branding, medios, qrEscuela, waEscuela, waDisponible] = await Promise.all([
        familiasConDeuda(schoolId, ahora, mes),
        resolveSchoolBranding(schoolId),
        // Las restringidas (only_for) que no valen para mensualidades no salen
        // (el Nequi personal de inscripciones de Dynasty).
        mediosDePago(schoolId, { categoria: 'mensualidad' }),
        qrDeLaEscuela(schoolId),
        whatsappDeLaEscuela(schoolId),
        canalPedido === 'auto' ? whatsappDisponibleEnEscuela(schoolId) : Promise.resolve(false),
    ]);
    const escuela = branding.schoolName.replace(/&amp;/g, '&');
    // Solo se ofrece la factura si la escuela la emite (facturador activo).
    const ofrecerFactura = await escuelaFacturaElectronicamente(schoolId);
    const whatsappComprobante = enlaceWhatsApp(waEscuela, `Hola, envío el comprobante de pago de ${escuela}.`);
    const whatsappAvisos = enlaceActivarAvisos(waEscuela, escuela);

    const r: ResumenEnvio = {
        modo: o.aplicar ? `APLICADO (${o.modo})` : `SIMULACION (${o.modo})`,
        escuela, cobros, duplicados_excluidos: duplicados, cobros_atleta_inactivo: atletaInactivo, cobros_sin_contacto: sinContacto,
        familias: familias.length,
        familias_con_correo: familias.filter((f) => f.email).length,
        familias_solo_whatsapp: familias.filter((f) => !f.email).length,
        ya_avisadas_hoy: 0, por_whatsapp: 0, por_correo: 0, ya_enviados_antes: 0, sin_canal: 0, fallos: 0,
        deuda_total: fmtCop(familias.reduce((s, f) => s + f.filas.reduce((x, y) => x + y.saldo, 0), 0)),
        whatsapp_disponible: waDisponible, medios_de_pago: medios.cuentas.length, qr_escuela: !!qrEscuela,
        motivos_whatsapp: {},
    };

    for (const f of familias) {
        if (f.avisadaHoy) { r.ya_avisadas_hoy++; continue; }
        const canal = elegirCanal({
            pedido: canalPedido, whatsappEscuela: waDisponible, waId: f.waId, email: f.email,
            filasDelMes: f.filas.filter((x) => x.delMes).length,
        });
        if (canal === 'ninguno') { r.sin_canal++; continue; }
        if (!o.aplicar) {
            if (canal === 'correo') r.por_correo++; else r.por_whatsapp++;
            continue;
        }

        const destinos = [f.email, f.waId ? `wa:${f.waId}` : null].filter(Boolean) as string[];
        const reserva = await reservarEnvio({
            clave: claveEstadoDeCuenta({ modo: o.modo, schoolId, familia: f.clave, ahora }),
            tipo: TIPO_ESTADO, schoolId, refId: null, destinos,
        });
        if (!reserva) { r.ya_enviados_antes++; continue; }

        try {
            for (const fila of f.filas) fila.token = await emitirTokenCobro(fila.paymentId);

            let salioPorWa = false;
            /** Se ofrece activar WhatsApp si no se intentó o si faltó el consentimiento (no por otros fallos). */
            let ofrecerWa = true;
            if (canal === 'whatsapp' || canal === 'whatsapp_o_correo') {
                const d = datosWhatsAppDeFamilia(f, escuela, mes);
                const tokenBoton = f.filas.find((x) => x.paymentId === d.paymentIdBoton)?.token ?? null;
                const wa = await enviarCobroPorPlantilla({
                    schoolId, concepto: 'recordatorio_previo', telefono: f.waId, tokenBoton,
                    paymentId: d.paymentIdBoton ?? undefined, parentId: f.perfilId, datos: d, ahora,
                });
                if (wa.enviado) {
                    salioPorWa = true;
                    r.por_whatsapp++;
                    await cerrarEnvio(reserva, { ok: true, messageId: wa.waMessageId });
                    await supabase.from('email_sends').update({ provider: 'whatsapp' }).eq('id', reserva.id);
                } else {
                    r.motivos_whatsapp[wa.motivo] = (r.motivos_whatsapp[wa.motivo] || 0) + 1;
                    ofrecerWa = wa.motivo === 'sin_optin' || wa.motivo === 'telefono_invalido';
                }
            }

            if (!salioPorWa) {
                if (!f.email) {
                    r.sin_canal++;
                    await cerrarEnvio(reserva, { ok: false, error: 'whatsapp no salió y no hay correo' });
                    continue;
                }
                const html = buildBrandedEmail({
                    branding,
                    title: 'Tu estado de cuenta',
                    greeting: `Hola ${f.nombre},`,
                    bodyHtml: cuerpoCorreoEstado({
                        escuela, familia: f, appBase, bffBase, medios: medios.cuentas,
                        qrEscuelaUrl: qrEscuela, whatsappComprobante,
                        // `?? null`: si mediosDePago no lo trae (mock viejo), no hay botón.
                        linkDePago: medios.link_de_pago ?? null,
                        nota: o.notaSoloPara && !o.notaSoloPara.has(f.email.toLowerCase()) ? null : o.nota,
                        ofrecerFactura,
                        whatsappAvisos: ofrecerWa ? whatsappAvisos : null,
                    }),
                    cta: { label: 'Ver y pagar', url: f.filas.find((x) => x.token) ? enlaceDeCobro(appBase, f.filas.find((x) => x.token)!.token!) : `${appBase}/my-payments` },
                    closingHtml: 'Si ya pagaste, ignora este mensaje: la escuela lo está revisando.',
                });
                const env = await emailClient.send({ to: f.email, subject: `Estado de cuenta — ${escuela}`, html });
                const ok = !!env.success && !(env as any).simulated;
                await cerrarEnvio(reserva, { ok, error: ok ? undefined : String((env as any).error?.message ?? (env as any).error ?? 'simulado') });
                if (!ok) { r.fallos++; continue; }
                r.por_correo++;
                if (o.pausaMs !== 0) await new Promise((res) => setTimeout(res, o.pausaMs ?? 600));
            }
            await estamparAvisos(f);
        } catch (e: any) {
            r.fallos++;
            await cerrarEnvio(reserva, { ok: false, error: e?.message || String(e) });
        }
    }
    return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corrida mensual (la llama el job)
// ─────────────────────────────────────────────────────────────────────────────

async function marcarCorrida(schoolId: string, mes: string, resumen: ResumenEnvio): Promise<void> {
    const { error } = await supabase.from('email_sends').insert({
        id: uuidDeClave(claveCorrida(schoolId, mes)),
        school_id: schoolId,
        to_email: `corrida ${mes}: correo=${resumen.por_correo} whatsapp=${resumen.por_whatsapp} fallos=${resumen.fallos}`.slice(0, 1000),
        email_type: TIPO_CORRIDA,
        provider: 'interno',
        status: 'sent',
        attempts: 1,
    });
    // 23505 = otro BFF la escribió primero: lo mismo.
    if (error && (error as any).code !== '23505') {
        console.error('[estado-de-cuenta] no se pudo escribir la marca de la corrida', { schoolId, mes, error: error.message });
    }
}

export async function runEstadoDeCuentaMensual(ahora: Date = new Date()): Promise<Record<string, ResumenEnvio | string>> {
    const out: Record<string, ResumenEnvio | string> = {};
    if (process.env.DISABLE_ESTADO_CUENTA_MENSUAL === 'true') return out;
    if (!esHoraDelEnvioMensual(ahora)) return out;
    const mes = mesColombia(ahora);
    if (mes < primerMesActivo()) return out;

    for (const schoolId of await escuelasConEstadoMensual()) {
        try {
            if (await corridaHecha(schoolId, mes)) continue;
            // Hasta que open_month cree los cobros del mes no hay estado de
            // cuenta: sale el primer día hábil desde ese día (8:00 COT).
            if (!(await hayCobrosDelMes(schoolId, mes))) { out[schoolId] = 'sin cobros del mes todavía'; continue; }
            const resumen = await enviarEstadoDeCuenta(schoolId, { modo: 'mensual', aplicar: true, canal: 'auto', ahora });
            await marcarCorrida(schoolId, mes, resumen);
            out[schoolId] = resumen;
            console.log('[estado-de-cuenta] corrida mensual', JSON.stringify(resumen));
        } catch (e: any) {
            // URL no pública (localhost) cae acá: se registra y NO se manda nada.
            console.error('[estado-de-cuenta] corrida mensual falló', { schoolId, error: e?.message || String(e) });
            out[schoolId] = `error: ${e?.message || e}`;
        }
    }
    return out;
}
