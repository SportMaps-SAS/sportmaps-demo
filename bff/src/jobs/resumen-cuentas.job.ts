/**
 * resumen-cuentas.job — correo cada 4 horas (07:00, 11:00, 15:00 y 19:00 COT) al dueño y a los admins de las
 * escuelas de `RESUMEN_CUENTAS_ESCUELAS`, para ayudarles a revisar comprobantes y repartir el dinero entre
 * cuentas (Nequi, Daviplata…).
 *
 * Por qué (2026-11-18): Monster´s Volley revisa comprobantes los lunes, miércoles y viernes y reparte lo que
 * entra entre sus cuentas. Entre revisión y revisión se acumulaban comprobantes sin que nadie lo notara.
 *
 * Contenido de cada correo (solo si hay algo pendiente):
 *   · Por validar y por clasificar: cuántos son y cuánto dinero entra, DESGLOSADO POR CUENTA.
 *   · El más antiguo y cuántos llevan más de 4 h sin que nadie decida.
 * Lunes, miércoles y viernes a las 07:00 (los días de revisión de Monster) el correo es el INFORME COMPLETO:
 * además, lo aprobado desde la revisión anterior por cuenta (el valor que ingresó) y lo que sigue pendiente.
 *
 * CUENTA = el banco que leyó el OCR del comprobante («Nequi», «Daviplata», «BBVA»…). El destino NO sirve para
 * separar: en Monster Nequi y Daviplata son el MISMO número (3194505150). Sin banco leído, se usa el método
 * del pago (efectivo, en línea); si tampoco, «Otro / sin banco». Es una pista para repartir, no contabilidad.
 *
 * Destinatarios: los de siempre (`destinatariosEnLote`: owner + admins activos, nunca coach, sin demos).
 * Idempotencia SIN migración: reserva en `email_sends` por escuela + día + hora, como el resumen diario.
 * Disk IO: tres lecturas en lote para todas las escuelas (`.in`), nada por escuela salvo la reserva y el envío.
 * Solo producción (`resumenCuentasActivo`); kill-switch DISABLE_RESUMEN_CUENTAS=true.
 */

import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { cerrarEnvio, enviarPlantilla, escaparHtml, fechaColombia, horaColombia, reservarEnvio, uuidDeClave } from '../services/avisos-correo.service';
import { idsConResumenDeCuentas } from '../services/resumen-cuentas.config';
import { destinatariosEnLote, escuelaElegible, cop, URL_PANEL } from './pagos-por-validar.job';

export const TIPO_CORREO_CUENTAS = 'resumen_cuentas';
/** Horas COT de los cortes: de 7 a 7, cada 4 horas. */
export const HORAS_DE_CORTE = [7, 11, 15, 19] as const;
export const UMBRAL_SIN_DECIDIR_MS = 4 * 3600_000;
const LIMITE = 5000;

export function resumenCuentasActivo(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.DISABLE_RESUMEN_CUENTAS === 'true') return false;
    if (idsConResumenDeCuentas(env).size === 0) return false;
    if (env.NODE_ENV === 'production') return true;
    return env.RESUMEN_CUENTAS_FUERA_DE_PROD === 'true';
}

// ─── Cuenta (pura) ───────────────────────────────────────────────────────────

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** A qué cuenta se atribuye un pago: el banco del comprobante; si no, el método del pago. Pura. */
export function cuentaDe(banco: string | null | undefined, metodo?: string | null): string {
    const b = sinTildes(String(banco ?? '')).replace(/[^a-z0-9]/g, '');
    if (b) {
        if (b.includes('nequi')) return 'Nequi';
        if (b.includes('daviplata') || b === 'davi') return 'Daviplata';
        if (b.includes('breb') || b.includes('bre')) return 'Bre-B';
        if (b.includes('bancolombia')) return 'Bancolombia';
        if (b.includes('bbva')) return 'BBVA';
        if (b.includes('davivienda')) return 'Davivienda';
        if (b.includes('bogota')) return 'Banco de Bogotá';
        if (b.includes('nu') && b.length <= 4) return 'Nu';
        if (b === 'otro' || b === 'otros' || b === 'unknown' || b === 'desconocido') return 'Otro / sin banco';
        return String(banco).trim().slice(0, 30);
    }
    const m = sinTildes(String(metodo ?? ''));
    if (m === 'cash') return 'Efectivo';
    if (m === 'pse' || m === 'card') return 'En línea (PSE / tarjeta)';
    return 'Otro / sin banco';
}

export interface LineaCuenta { cuenta: string; cantidad: number; monto: number }

/** Suma por cuenta, de mayor a menor monto. Pura. */
export function sumarPorCuenta(items: readonly { banco?: string | null; metodo?: string | null; monto: number }[]): LineaCuenta[] {
    const m = new Map<string, LineaCuenta>();
    for (const i of items) {
        const cuenta = cuentaDe(i.banco, i.metodo);
        const l = m.get(cuenta) ?? { cuenta, cantidad: 0, monto: 0 };
        l.cantidad++; l.monto += Number(i.monto) || 0;
        m.set(cuenta, l);
    }
    return [...m.values()].sort((a, b) => b.monto - a.monto || a.cuenta.localeCompare(b.cuenta));
}

// ─── Calendario (puro; Colombia es UTC−5 todo el año) ────────────────────────

const COT_MS = 5 * 3600_000;
/** 0 = domingo … 6 = sábado, en hora de Colombia. */
export const diaSemanaCO = (ms: number): number => new Date(ms - COT_MS).getUTCDay();
export const horaCO = (ms: number): number => new Date(ms - COT_MS).getUTCHours();
/** Lunes, miércoles y viernes: los días de revisión. */
export const esDiaDeInforme = (ms: number): boolean => [1, 3, 5].includes(diaSemanaCO(ms));

/**
 * Desde cuándo cuenta el informe: la revisión anterior (viernes → lunes = 3 días; lunes → miércoles y
 * miércoles → viernes = 2), a las 07:00 COT de ese día. Pura. `null` si hoy no es día de informe.
 */
export function inicioDelInforme(ms: number): number | null {
    const dia = diaSemanaCO(ms);
    const atras = dia === 1 ? 3 : dia === 3 || dia === 5 ? 2 : null;
    if (atras === null) return null;
    const hoyCO = new Date(ms - COT_MS);
    const inicioDeHoy = Date.UTC(hoyCO.getUTCFullYear(), hoyCO.getUTCMonth(), hoyCO.getUTCDate(), 7, 0, 0) + COT_MS;
    return inicioDeHoy - atras * 86_400_000;
}

// ─── Armado del resumen (puro) ───────────────────────────────────────────────

export interface ItemPendiente { banco: string | null; metodo: string | null; monto: number; desde: string }
export interface ItemAprobado { banco: string | null; metodo: string | null; monto: number }

export interface Resumen {
    porValidar: { cantidad: number; monto: number; cuentas: LineaCuenta[] };
    porClasificar: { cantidad: number; monto: number; cuentas: LineaCuenta[] };
    masAntiguoMs: number | null;
    sinDecidir4h: number;
    /** Solo en el informe de L/M/V. */
    aprobado: { cantidad: number; monto: number; cuentas: LineaCuenta[] } | null;
    desde: number | null;
}

const total = (l: readonly LineaCuenta[]) => l.reduce((s, x) => s + x.monto, 0);
const cant = (l: readonly LineaCuenta[]) => l.reduce((s, x) => s + x.cantidad, 0);

export function armarResumen(i: {
    ahora: number; porValidar: readonly ItemPendiente[]; porClasificar: readonly ItemPendiente[];
    aprobados?: readonly ItemAprobado[] | null; desde?: number | null;
}): Resumen {
    const pv = sumarPorCuenta(i.porValidar);
    const pc = sumarPorCuenta(i.porClasificar);
    const edades = [...i.porValidar, ...i.porClasificar].map((p) => new Date(p.desde).getTime()).filter((n) => Number.isFinite(n));
    const ap = i.aprobados ? sumarPorCuenta(i.aprobados) : null;
    return {
        porValidar: { cantidad: cant(pv), monto: total(pv), cuentas: pv },
        porClasificar: { cantidad: cant(pc), monto: total(pc), cuentas: pc },
        masAntiguoMs: edades.length ? Math.min(...edades) : null,
        sinDecidir4h: edades.filter((t) => i.ahora - t >= UMBRAL_SIN_DECIDIR_MS).length,
        aprobado: ap ? { cantidad: cant(ap), monto: total(ap), cuentas: ap } : null,
        desde: i.desde ?? null,
    };
}

/** ¿Vale la pena mandar el correo? Informe completo: siempre. Resumen de 4 h: solo si hay algo pendiente. Pura. */
export const debeEnviar = (r: Resumen, esInforme: boolean): boolean =>
    esInforme || r.porValidar.cantidad + r.porClasificar.cantidad > 0;

export function asuntoDe(r: Resumen, escuela: string, esInforme: boolean, ahora: number): string {
    const hora = new Date(ahora - COT_MS).getUTCHours();
    const corte = `${hora > 12 ? hora - 12 : hora} ${hora >= 12 ? 'p. m.' : 'a. m.'}`;
    if (esInforme) return `${escuela}: informe de revisión · ${cop(r.aprobado?.monto ?? 0)} ingresaron, ${cop(r.porValidar.monto + r.porClasificar.monto)} pendientes`;
    return `${escuela}: ${cop(r.porValidar.monto + r.porClasificar.monto)} por revisar (corte ${corte})`;
}

// ─── Correo (HTML simple, sin plantilla de marca: cabe en un correo de gestión) ──

function tablaCuentas(titulo: string, bloque: { cantidad: number; monto: number; cuentas: LineaCuenta[] }, nota?: string): string {
    const filas = bloque.cuentas.map((c) =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escaparHtml(c.cuenta)}</td>`
        + `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${c.cantidad}</td>`
        + `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600">${escaparHtml(cop(c.monto))}</td></tr>`).join('');
    return `<h3 style="margin:22px 0 4px;font-size:16px;color:#123416">${escaparHtml(titulo)} · ${bloque.cantidad} · ${escaparHtml(cop(bloque.monto))}</h3>`
        + (nota ? `<p style="margin:0 0 8px;color:#6b7280;font-size:13px">${escaparHtml(nota)}</p>` : '')
        + (bloque.cantidad
            ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="background:#f3f4f6"><th style="padding:6px 10px;text-align:left">Cuenta</th><th style="padding:6px 10px;text-align:right">Pagos</th><th style="padding:6px 10px;text-align:right">Valor</th></tr>${filas}</table>`
            : '<p style="margin:0;color:#6b7280;font-size:14px">Nada pendiente.</p>');
}

export function htmlDelResumen(r: Resumen, escuela: string, esInforme: boolean, ahora: number): string {
    const partes: string[] = [];
    partes.push(`<h2 style="margin:0 0 4px;font-size:20px;color:#123416">${esInforme ? 'Informe de revisión' : 'Resumen de comprobantes'}</h2>`);
    partes.push(`<p style="margin:0;color:#6b7280;font-size:13px">${escaparHtml(escuela)} · corte ${escaparHtml(horaColombia(ahora))}</p>`);
    if (esInforme && r.aprobado) {
        partes.push(tablaCuentas('Ingresó desde la revisión anterior (aprobado)', r.aprobado,
            r.desde ? `Aprobado desde ${horaColombia(r.desde)}. Es lo que hay para repartir entre cuentas.` : undefined));
    }
    partes.push(tablaCuentas('Por validar', r.porValidar, 'Comprobantes que esperan tu aprobación en «Cobros por Aprobar». El valor es el que dice el comprobante.'));
    partes.push(tablaCuentas('Por clasificar', r.porClasificar, 'Llegaron por WhatsApp y el asistente no supo a qué cobro van: decide en Cobros.'));
    const avisos: string[] = [];
    if (r.sinDecidir4h > 0) avisos.push(`${r.sinDecidir4h} llevan más de 4 horas sin que nadie decida.`);
    if (r.masAntiguoMs) avisos.push(`El más antiguo entró ${horaColombia(r.masAntiguoMs)}.`);
    if (avisos.length) partes.push(`<p style="margin:18px 0 0;padding:10px 12px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;font-size:14px">${avisos.map(escaparHtml).join(' ')}</p>`);
    partes.push(`<p style="margin:22px 0 0"><a href="${escaparHtml(URL_PANEL)}" style="background:#123416;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Abrir Cobros</a></p>`);
    partes.push('<p style="margin:18px 0 0;color:#9ca3af;font-size:12px">La cuenta es el banco que leyó el comprobante (Nequi y Daviplata comparten número, por eso no se separa por el destino). Es una guía para repartir, no un cierre contable.</p>');
    return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#14201a">${partes.join('')}</div>`;
}

// ─── Lecturas y corrida ──────────────────────────────────────────────────────

export interface OpcionesResumen { ahora?: number; aplicar?: boolean; escuela?: string; log?: Logger | Console; env?: NodeJS.ProcessEnv }
export interface PlanResumen { schoolId: string; escuela: string; clave: string; esInforme: boolean; yaEnviado: boolean; resumen: Resumen; correos: string[]; asunto: string }
export interface ResultadoResumen {
    fecha: string; hora: number; esInforme: boolean; plan: PlanResumen[];
    enviadas: number; duplicadas: number; fallosCorreo: number; sinCorreo: number; nadaQueAvisar: number;
}

export const claveDeCorte = (schoolId: string, fecha: string, hora: number) => `resumen_cuentas:${schoolId}:${fecha}:${String(hora).padStart(2, '0')}`;

export async function runResumenCuentas(opts: OpcionesResumen = {}): Promise<ResultadoResumen> {
    const ahora = opts.ahora ?? Date.now();
    const aplicar = opts.aplicar !== false;
    const log: Logger | Console = opts.log ?? console;
    const fecha = fechaColombia(ahora);
    const hora = horaCO(ahora);
    const esInforme = esDiaDeInforme(ahora) && hora === HORAS_DE_CORTE[0];
    const res: ResultadoResumen = { fecha, hora, esInforme, plan: [], enviadas: 0, duplicadas: 0, fallosCorreo: 0, sinCorreo: 0, nadaQueAvisar: 0 };

    let ids = [...idsConResumenDeCuentas(opts.env)];
    const soloEsta = opts.escuela?.toLowerCase();
    if (soloEsta) ids = ids.filter((x) => x === soloEsta);
    if (!ids.length) return res;

    const { data: escuelas, error: eEsc } = await supabase.from('schools').select('id, name, owner_id, account_type, is_demo').in('id', ids);
    if (eEsc) throw new Error(`schools: ${eEsc.message}`);
    const elegibles = ((escuelas ?? []) as any[]).filter(escuelaElegible);
    if (!elegibles.length) return res;
    const idsOk = elegibles.map((e) => e.id as string);

    // Tres lecturas para todas las escuelas.
    const [{ data: pv, error: ePv }, pcR] = await Promise.all([
        supabase.from('payments')
            .select('school_id, ocr_amount, amount_paid, amount, ocr_bank, payment_method, receipt_submitted_at, receipt_verdict_at, created_at')
            .in('school_id', idsOk).eq('status', 'awaiting_approval').not('receipt_url', 'is', null).limit(LIMITE),
        supabase.from('wa_comprobantes_por_clasificar')
            .select('school_id, monto, banco, created_at').in('school_id', idsOk).eq('estado', 'por_clasificar').limit(LIMITE),
    ]);
    if (ePv) throw new Error(`payments: ${ePv.message}`);
    // La tabla de «por clasificar» puede no existir todavía (migración sin aplicar): se sigue sin ella.
    const pcFilas = pcR.error ? [] : ((pcR.data ?? []) as any[]);

    const desde = esInforme ? inicioDelInforme(ahora) : null;
    let aprobadosFilas: any[] = [];
    if (esInforme && desde !== null) {
        const { data: ap, error: eAp } = await supabase.from('payments')
            .select('school_id, amount_paid, ocr_bank, payment_method, approved_at')
            .in('school_id', idsOk).in('status', ['paid', 'partial'])
            .gte('approved_at', new Date(desde).toISOString()).limit(LIMITE);
        if (eAp) throw new Error(`payments(aprobados): ${eAp.message}`);
        aprobadosFilas = (ap ?? []) as any[];
    }

    const destinatarios = await destinatariosEnLote(elegibles.map((e) => ({ id: e.id, owner_id: e.owner_id ?? null })));
    const claves = elegibles.map((e) => claveDeCorte(e.id, fecha, hora));
    const { data: hechas, error: eHechas } = await supabase.from('email_sends').select('id').in('id', claves.map(uuidDeClave));
    if (eHechas) throw new Error(`email_sends: ${eHechas.message}`);
    const yaHechas = new Set(((hechas ?? []) as any[]).map((h) => h.id));

    for (const e of elegibles) {
        const porValidar: ItemPendiente[] = ((pv ?? []) as any[]).filter((p) => p.school_id === e.id).map((p) => ({
            banco: p.ocr_bank ?? null, metodo: p.payment_method ?? null,
            monto: Number(p.ocr_amount ?? p.amount_paid ?? p.amount) || 0,
            desde: p.receipt_submitted_at ?? p.receipt_verdict_at ?? p.created_at,
        }));
        const porClasificar: ItemPendiente[] = pcFilas.filter((p) => p.school_id === e.id).map((p) => ({
            banco: p.banco ?? null, metodo: null, monto: Number(p.monto) || 0, desde: p.created_at,
        }));
        const aprobados: ItemAprobado[] | null = esInforme
            ? aprobadosFilas.filter((p) => p.school_id === e.id).map((p) => ({ banco: p.ocr_bank ?? null, metodo: p.payment_method ?? null, monto: Number(p.amount_paid) || 0 }))
            : null;
        const resumen = armarResumen({ ahora, porValidar, porClasificar, aprobados, desde });
        if (!debeEnviar(resumen, esInforme)) { res.nadaQueAvisar++; continue; }
        const escuela = String(e.name ?? '').trim() || 'tu escuela';
        const clave = claveDeCorte(e.id, fecha, hora);
        res.plan.push({
            schoolId: e.id, escuela, clave, esInforme, yaEnviado: yaHechas.has(uuidDeClave(clave)), resumen,
            correos: destinatarios.get(e.id)?.correos ?? [], asunto: asuntoDe(resumen, escuela, esInforme, ahora),
        });
    }
    if (!aplicar) return res;

    for (const p of res.plan) {
        if (p.yaEnviado) { res.duplicadas++; continue; }
        try {
            const reserva = await reservarEnvio({
                clave: p.clave, tipo: TIPO_CORREO_CUENTAS, schoolId: p.schoolId, refId: null,
                destinos: p.correos.length ? p.correos : ['(sin correo)'],
            });
            if (!reserva) { res.duplicadas++; continue; }
            if (!p.correos.length) { await cerrarEnvio(reserva, { ok: false, error: 'sin destinatarios con correo' }); res.sinCorreo++; continue; }
            const html = htmlDelResumen(p.resumen, p.escuela, p.esInforme, ahora);
            const envio = await enviarPlantilla(null, p.correos, {}, { subject: p.asunto, titulo: p.asunto, lineas: [], html });
            await cerrarEnvio(reserva, envio);
            if (envio.ok) res.enviadas++;
            else { res.fallosCorreo++; (log as any).error?.({ schoolId: p.schoolId, err: envio.error }, '[resumen-cuentas] el correo no salió'); }
        } catch (err: any) {
            res.fallosCorreo++;
            (log as any).error?.({ schoolId: p.schoolId, err: err?.message || String(err) }, '[resumen-cuentas] falló la escuela');
        }
    }
    return res;
}
