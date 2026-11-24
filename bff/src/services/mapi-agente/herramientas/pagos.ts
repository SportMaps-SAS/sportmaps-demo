/**
 * Herramientas de PAGOS de Mapi: identificar comprobantes y pedir aclaración
 * (plan §20.3, §20.4 y §21). Solo administración: el entrenador nunca ve plata
 * (plan §4). Todas declaran roles ['admin'] y además lo revisan adentro.
 *
 * Consultas (se ejecutan de una):
 *   · pagos_por_validar     → la lectura del resumen diario «Pagos por validar»
 *                             (jobs/pagos-por-validar.job: leerPendientes, armarResumen
 *                             y la regla de «Aprobar todos los verdes», exclusionVerde).
 *                             Todas las sedes salvo que se pida una.
 *   · por_que_no_se_aprobo  → receipt_verdict_reasons en palabras.
 *   · seguimiento_whatsapp  → el servicio de la pestaña Seguimiento.
 *   · auditar_pendientes    → cruza cada comprobante con su cobro, las cuentas de la
 *                             escuela (buildVerdictContext), los duplicados y el pie de
 *                             foto, y PROPONE. No aprueba ni rechaza nada.
 *   · estado_aprobacion_automatica → la lista de §20.5 contra la configuración real.
 *   · ventas_de_servicio    → interesados, cobros y cupos (catálogo + Seguimiento).
 *
 * Acción (borrador → Confirmar), apagada salvo MAPI_PAGOS_ACCIONES=true:
 *   · pedir_aclaracion      → glosa con el mismo servicio de glosas.routes (create_glosa).
 *
 * Lo que NO está aquí y por qué (detalle en docs del informe): aprobar_pago y
 * aprobar_verdes (la aprobación manual vive en el navegador, frontend/src/lib/
 * approvePayment.ts: UPDATE de payments + enrollments + notify_user sueltos) y
 * registrar_pago_efectivo (el modal escribe desde el navegador o llama
 * register_manual_payments, que exige auth.uid()). Requieren una RPC primero.
 *
 * Datos mínimos (§12.1): sin teléfonos, correos ni cuentas completas. Todo texto
 * que venga de la base (nombres, conceptos, pies de foto, mensajes) es DATO.
 */

import { z } from 'zod';
import { supabase } from '../../../config/supabase';
import {
    ORDEN_TIPOS, armarResumen, comprobantesCompartidos, cop, destinatariosEnLote, etiquetaDeDesglose, exclusionVerde,
    leerPendientes, periodosYaPagados, saldo, tipoDeCobro, type ClaveTipo, type ContextoVerdes, type PagoPorValidar,
} from '../../../jobs/pagos-por-validar.job';
import { formatoEspera } from '../../../jobs/receipt-review-alerts.job';
import { notasDeComprobantes } from '../../../routes/whatsapp-admin.routes';
import { classifyDestinationMatch, normalizeDestination, type VerdictContext } from '../../receipt-verdict';
import { buildVerdictContext } from '../../receipt-context.service';
import { categoriaDeCobro, describirCategorias, parseCuentasDePago } from '../../payment-accounts';
import { findDuplicatePaymentIds } from '../../duplicatePayerGuard.service';
import { createGlosa, sendGlosaCreatedEmail, GlosaRpcError, type GlosaReason } from '../../glosa.service';
import { listConfiguredProviders } from '../../ocr.service';
import {
    DIAS_MAXIMO, DIAS_POR_DEFECTO, ALERTA_ESPERA_MIN, etiquetaAutor, filtrarSeguimiento, leerRangoSeguimiento,
    resumirSeguimiento, seguimientoDeConversaciones, sinResponder, type FilaSeguimiento,
} from '../../whatsapp-seguimiento-conversaciones.service';
import { catalogoServicios } from '../../ventas-servicios.service';
import { normalizar } from '../deportistas';
import { fechaCorta, fechaLarga, sumarDias } from '../fechas';
import { RechazoHerramienta, type Alcance, type Herramienta, type HerramientaAccion, type HerramientaConsulta } from '../tipos';

// ─── Comunes ────────────────────────────────────────────────────────────────

const validarCon = <T>(schema: z.ZodType<T>) => (args: unknown): T => {
    const r = schema.safeParse(args ?? {});
    if (!r.success) throw new RechazoHerramienta(`Datos inválidos para la herramienta: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
    return r.data;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NINGUNO = '00000000-0000-0000-0000-000000000000';
/** Filas que se le muestran al modelo en una lista (cada una cuesta tokens). */
const MAX_LISTA = 10;
const MAX_AUDITORIA = 20;

/** Mapi no le muestra plata al entrenador: defensa adentro, además de `roles`. */
function soloAdmin(a: Alcance): void {
    if (a.rol !== 'admin') throw new RechazoHerramienta('Los pagos solo los ve la administración de la escuela.');
}

/** Las acciones de pagos nacen apagadas: se prenden con MAPI_PAGOS_ACCIONES=true después de revisarlas. */
export const accionesDePagosPrendidas = (a: Alcance): boolean =>
    a.rol === 'admin' && process.env.MAPI_PAGOS_ACCIONES === 'true';

/**
 * Texto libre de la base, listo para el modelo: una línea, corto y sin números
 * largos (teléfonos, cuentas). Los montos con puntos («$1.200.000») se respetan. Pura.
 */
export function textoSeguro(t: unknown, max = 140): string {
    const s = String(t ?? '').replace(/\s+/g, ' ').trim()
        .replace(/\+?\d[\d\s-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[número]' : m));
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Últimos 4 dígitos de una cuenta, para nombrarla sin darla completa. Pura. */
export function terminaEn(destino: unknown): string | null {
    const d = String(destino ?? '').replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : null;
}

const ESTADO_LEGIBLE: Record<string, string> = {
    awaiting_approval: 'por validar', partial: 'con abono (saldo pendiente)', paid: 'pagado', glosado: 'en aclaración con la familia',
    pending: 'pendiente', overdue: 'vencido', rejected: 'rechazado', cancelled: 'anulado', failed: 'fallido', approved: 'pagado',
};

/** «Clínica de armadores — Juan Pérez» → «Juan Pérez» (mismo separador que la pantalla). Pura. */
export function asistenteDelConcepto(concept: string | null | undefined): string | null {
    const c = String(concept ?? '');
    const i = c.indexOf(' — ');
    const despues = i >= 0 ? c.slice(i + 3).trim() : '';
    return despues || null;
}

interface CobroConSujeto {
    id: string;
    child_id?: string | null;
    user_id?: string | null;
    unregistered_athlete_id?: string | null;
    concept?: string | null;
}

/** Nombre del deportista de cada cobro (solo `full_name`, en tres lecturas en lote). */
async function nombresDeCobros(cobros: CobroConSujeto[]): Promise<Map<string, string>> {
    const unicos = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const hijos = unicos(cobros.map((c) => c.child_id));
    const sinCuenta = unicos(cobros.map((c) => (c.child_id ? null : c.unregistered_athlete_id)));
    const adultos = unicos(cobros.map((c) => (c.child_id || c.unregistered_athlete_id ? null : c.user_id)));
    const vacio = Promise.resolve({ data: [] as any[] });
    const [h, s, p] = await Promise.all([
        hijos.length ? supabase.from('children').select('id, full_name').in('id', hijos) : vacio,
        sinCuenta.length ? supabase.from('unregistered_athletes').select('id, full_name').in('id', sinCuenta) : vacio,
        adultos.length ? supabase.from('profiles').select('id, full_name').in('id', adultos) : vacio,
    ]);
    const nombre = new Map<string, string>();
    for (const r of [h, s, p]) for (const f of ((r as any).data as any[]) ?? []) if (f?.id && f.full_name) nombre.set(f.id, String(f.full_name).trim());
    const out = new Map<string, string>();
    for (const c of cobros) {
        const sujeto = c.child_id ?? (c.unregistered_athlete_id || null) ?? null;
        const n = (sujeto && nombre.get(sujeto)) || (!c.child_id && !c.unregistered_athlete_id && c.user_id && nombre.get(c.user_id))
            || asistenteDelConcepto(c.concept) || 'Sin ficha (ver el concepto)';
        out.set(c.id, textoSeguro(n, 60));
    }
    return out;
}

const trozos = <T,>(a: T[], n = 150) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

const COLS_DETALLE = 'id, status, amount, amount_paid, early_payment_discount_applied, concept, payment_category, '
    + 'child_id, user_id, parent_id, unregistered_athlete_id, due_date, period_year, period_month, '
    + 'receipt_url, receipt_verdict, receipt_verdict_reasons, ocr_amount, ocr_date, ocr_destination, '
    + 'requires_review, approved_by, approved_at, branch_id';

/** Lo que no trae `leerPendientes`: sujeto, motivos y destino. Por id, en trozos, siempre de esta escuela. */
async function detalleDeCobros(schoolId: string, ids: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    for (const t of trozos(ids)) {
        const { data, error } = await supabase.from('payments').select(COLS_DETALLE).eq('school_id', schoolId).in('id', t);
        if (error) throw new Error(`payments: ${error.message}`);
        for (const f of (data as any[]) ?? []) out.set(String(f.id), f);
    }
    return out;
}

/** Un cobro de ESTA escuela por id. Un id de otra escuela responde «no lo encontré», igual que uno que no existe. */
async function leerCobro(a: Alcance, pago: string): Promise<any> {
    if (!UUID.test(pago)) throw new RechazoHerramienta('Ese identificador de pago no es válido. Búscalo primero con pagos_por_validar.');
    const { data, error } = await supabase.from('payments').select(COLS_DETALLE)
        .eq('school_id', a.schoolId).eq('id', pago.toLowerCase()).maybeSingle();
    if (error) throw new Error(`payments: ${error.message}`);
    if (!data) throw new RechazoHerramienta('No encontré ese pago en esta escuela.');
    return data;
}

/** La fila del job a partir del detalle (mismas columnas que lee `leerPendientes`). Pura. */
function aPorValidar(f: any): PagoPorValidar {
    return {
        id: f.id, school_id: f.school_id ?? '', amount: Number(f.amount) || 0, amount_paid: Number(f.amount_paid) || 0,
        early_payment_discount_applied: Number(f.early_payment_discount_applied) || 0,
        concept: f.concept ?? null, payment_category: f.payment_category ?? null, receipt_verdict: f.receipt_verdict ?? null,
        receipt_url: f.receipt_url ?? null, ocr_amount: f.ocr_amount == null ? null : Number(f.ocr_amount),
        requires_review: f.requires_review === true, child_id: f.child_id ?? null,
        period_year: f.period_year ?? null, period_month: f.period_month ?? null, enviado_en: '', branch_id: f.branch_id ?? null,
    };
}

// ─── Motivos del veredicto en palabras ──────────────────────────────────────

/** Forma mínima de una razón tal como se guarda en `receipt_verdict_reasons`. */
export type MotivoGuardado = { code?: string; level?: string; message?: string; detail?: any };

const CAMPO: Record<string, string> = { amount: 'el monto', date: 'la fecha', reference: 'la referencia' };

/**
 * Un motivo de `receipt_verdict_reasons` dicho como lo diría una persona
 * («el comprobante dice $140.000 y el cobro es de $145.000»). Nunca devuelve las
 * cuentas con que se comparó (SEG-26) ni las señales de manipulación. Pura.
 */
export function motivoEnPalabras(r: MotivoGuardado): string {
    const d = (r?.detail ?? {}) as Record<string, any>;
    switch (r?.code) {
        case 'MONTO_DIFIERE': {
            const dice = Number(d.extracted);
            const es = Number(d.expected);
            if (Number.isFinite(dice) && Number.isFinite(es)) {
                return `El comprobante dice ${cop(dice)} y el cobro es de ${cop(es)}${dice < es ? ': puede ser un abono' : ''}.`;
            }
            return 'El monto del comprobante no coincide con el cobro.';
        }
        case 'DESTINO_NO_COINCIDE': {
            if (d.cuentaRestringida) {
                const para = Array.isArray(d.soloPara) && d.soloPara.length ? describirCategorias(d.soloPara) : 'otro concepto';
                return `Fue a una cuenta de la escuela que solo recibe ${para}.`;
            }
            const fin = terminaEn(d.destination);
            return `Fue a una cuenta que no está registrada por la escuela${fin ? ` (termina en ${fin})` : ''}.`;
        }
        case 'DESTINO_AUSENTE': return 'No se ve a qué cuenta se mandó la plata.';
        case 'FECHA_FUERA_VENTANA': {
            const fecha = typeof d.date === 'string' ? d.date.slice(0, 10) : null;
            const ventana = Number(d.windowDays);
            return `Es un comprobante viejo${fecha ? ` (del ${fechaCorta(fecha)})` : ''}${Number.isFinite(ventana) ? `: la escuela acepta hasta ${ventana} días` : ''}.`;
        }
        case 'FECHA_FUTURA': return 'Tiene una fecha futura.';
        case 'REFERENCIA_DUPLICADA': return 'Ya lo habían mandado: esa referencia se usó en otro pago.';
        case 'IMAGEN_DUPLICADA': return 'Esa misma foto ya se había subido antes.';
        case 'CAMPOS_ILEGIBLES': {
            const faltan = Array.isArray(d.missing) ? d.missing.map((m: string) => CAMPO[m] ?? m) : [];
            return faltan.length ? `No se lee bien ${faltan.join(', ')}.` : 'No se leen bien algunos datos.';
        }
        case 'NOT_A_RECEIPT': return 'La imagen no es un comprobante de pago.';
        case 'IS_TRANSACTION_LIST': return 'Es una lista de movimientos, no el comprobante del pago.';
        case 'FORMATO_REFERENCIA': return 'La referencia se leyó cortada o incompleta.';
        case 'POSIBLE_MANIPULACION': return 'El comprobante trae texto que no es de un banco: revísalo a mano en la pantalla Aprobar, con la foto al lado.';
        case 'LECTURA_INCONSISTENTE': return 'Las dos lecturas del comprobante no coinciden.';
        default: return textoSeguro(r?.message || 'Hay un dato del comprobante que no cuadra.', 160);
    }
}

const CORTO: Record<string, string> = {
    MONTO_DIFIERE: 'monto distinto', DESTINO_NO_COINCIDE: 'cuenta destino', DESTINO_AUSENTE: 'sin cuenta destino',
    FECHA_FUERA_VENTANA: 'fecha vieja', FECHA_FUTURA: 'fecha futura', REFERENCIA_DUPLICADA: 'referencia repetida',
    IMAGEN_DUPLICADA: 'foto repetida', CAMPOS_ILEGIBLES: 'ilegible', NOT_A_RECEIPT: 'no es comprobante',
    IS_TRANSACTION_LIST: 'lista de movimientos', FORMATO_REFERENCIA: 'referencia cortada', POSIBLE_MANIPULACION: 'texto sospechoso',
};

const motivosDe = (f: any): MotivoGuardado[] => (Array.isArray(f?.receipt_verdict_reasons) ? f.receipt_verdict_reasons : []);

/**
 * Nivel del comprobante (§21), calculado por el servidor con el veredicto que
 * guardó el BFF y la regla de «Aprobar todos los verdes». 2 = coincide (verde y
 * sin excepciones); 3 = dudoso, se revisa en la pantalla Aprobar. El nivel 1
 * (confirmado por el banco) se aprueba solo y no llega a esta cola. Pura.
 */
export function nivelDe(p: PagoPorValidar, ctx: ContextoVerdes): { nivel: 2 | 3; porque: string | null } {
    const exclusion = exclusionVerde(p, ctx);
    if (exclusion === null) return { nivel: 2, porque: null };
    if (p.receipt_verdict === 'verde') return { nivel: 3, porque: exclusion };
    if (!p.receipt_verdict) return { nivel: 3, porque: 'sin veredicto' };
    return { nivel: 3, porque: p.receipt_verdict === 'rojo' ? 'rojo' : 'amarillo' };
}

// ─── pagos_por_validar ──────────────────────────────────────────────────────

/** Sede por id o por nombre (sin tildes ni signos), solo de esta escuela. */
async function resolverSede(schoolId: string, texto: string): Promise<{ id: string; nombre: string }> {
    const { data, error } = await supabase.from('school_branches').select('id, name').eq('school_id', schoolId).limit(100);
    if (error) throw new Error(`school_branches: ${error.message}`);
    const todas = ((data as any[]) ?? []).map((s) => ({ id: String(s.id), nombre: String(s.name ?? '').trim() || 'Sede sin nombre' }));
    if (UUID.test(texto)) {
        const s = todas.find((x) => x.id === texto.toLowerCase());
        if (!s) throw new RechazoHerramienta('No encontré esa sede en esta escuela.');
        return s;
    }
    const clave = (s: string) => normalizar(s).replace(/[^a-z0-9]/g, '');
    const buscada = clave(texto);
    const exactas = todas.filter((s) => clave(s.nombre) === buscada);
    const candidatas = exactas.length ? exactas : todas.filter((s) => buscada && clave(s.nombre).includes(buscada));
    if (candidatas.length === 1) return candidatas[0];
    if (!candidatas.length) {
        throw new RechazoHerramienta(todas.length
            ? `No encontré la sede «${textoSeguro(texto, 40)}». Las sedes son: ${todas.map((s) => s.nombre).join(', ')}.`
            : 'Esta escuela no tiene sedes: los pagos son de toda la escuela.');
    }
    throw new RechazoHerramienta(`Hay varias sedes que coinciden: ${candidatas.map((s) => s.nombre).join(', ')}. ¿Cuál?`);
}

/** Orden de la cola en pantalla: nivel 2, verdes con excepción, amarillos, sin leer, rojos; dentro, el que más espera. */
const ORDEN_VEREDICTO = (p: PagoPorValidar, nivel: number) =>
    nivel === 2 ? 0 : p.receipt_verdict === 'verde' ? 1 : p.receipt_verdict === 'amarillo' ? 2 : !p.receipt_verdict ? 3 : 4;

export interface ArgsPorValidar { sede?: string; tipo?: ClaveTipo }

export const pagosPorValidar: HerramientaConsulta<ArgsPorValidar> = {
    tipo: 'consulta',
    nombre: 'pagos_por_validar',
    descripcion: 'Comprobantes «Por validar» de la escuela (la misma cola de Gestión de Pagos), de TODAS las sedes salvo que pidan una: cuántos, cuánto suman, el más viejo y cuántos son nivel 2 (coinciden con el cobro: se aprueban de un clic). Nivel 3 = algo no cuadra. Lista corta con el id de cada pago. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            sede: { type: ['string', 'null'], description: 'Nombre o id de la sede; null = todas' },
            tipo: { type: ['string', 'null'], enum: [...ORDEN_TIPOS, null], description: 'Tipo de cobro; null = todos' },
        },
        required: ['sede', 'tipo'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar(args) {
        const r = validarCon(z.object({
            sede: z.string().trim().max(80).nullish(),
            tipo: z.enum(ORDEN_TIPOS as unknown as [ClaveTipo, ...ClaveTipo[]]).nullish(),
        }))(args);
        return { ...(r.sede ? { sede: r.sede } : {}), ...(r.tipo ? { tipo: r.tipo } : {}) };
    },
    async ejecutar(a, args) {
        soloAdmin(a);
        const sede = args.sede ? await resolverSede(a.schoolId, args.sede) : null;
        const todos = await leerPendientes(a.schoolId);
        // «Aprobar todos los verdes» mira TODA la cola (un comprobante de varios
        // cobros sigue siendo compartido aunque se filtre por sede o tipo).
        const periodos = await periodosYaPagados(todos);
        const ctx: ContextoVerdes = { compartidos: comprobantesCompartidos(todos), periodosPagados: periodos };
        // Misma regla de sede que la pantalla (filtroDeSede): los «Sin sede» también salen.
        const pagos = todos
            .filter((p) => !sede || !p.branch_id || p.branch_id === sede.id)
            .filter((p) => !args.tipo || tipoDeCobro(p) === args.tipo);
        const ahora = Date.now();
        const r = armarResumen(a.schoolId, pagos, ahora, periodos);
        const niveles = new Map(pagos.map((p) => [p.id, nivelDe(p, ctx)]));
        const verdesConExcepcion: Record<string, number> = {};
        for (const p of pagos) {
            const n = niveles.get(p.id)!;
            if (n.nivel === 3 && p.receipt_verdict === 'verde' && n.porque) verdesConExcepcion[n.porque] = (verdesConExcepcion[n.porque] ?? 0) + 1;
        }
        const ordenados = [...pagos].sort((x, y) =>
            ORDEN_VEREDICTO(x, niveles.get(x.id)!.nivel) - ORDEN_VEREDICTO(y, niveles.get(y.id)!.nivel)
            || Date.parse(x.enviado_en) - Date.parse(y.enviado_en));
        const primeros = ordenados.slice(0, MAX_LISTA);
        const detalle = primeros.length ? await detalleDeCobros(a.schoolId, primeros.map((p) => p.id)) : new Map<string, any>();
        const nombres = await nombresDeCobros(primeros.map((p) => ({ id: p.id, concept: p.concept, ...(detalle.get(p.id) ?? {}) })));
        const filtro = [sede ? `sede ${sede.nombre} (incluye los cobros sin sede)` : 'todas las sedes', ...(args.tipo ? [etiquetaDeDesglose(args.tipo)] : [])].join(' · ');

        if (!pagos.length) return { filtro, por_validar: 0, nota: 'No hay comprobantes por validar.' };
        return {
            filtro,
            por_validar: r.total,
            suman: cop(r.monto),
            el_mas_viejo_espera: formatoEspera(r.esperaMasAntiguoMs),
            mas_de_24_horas: r.masDe24h,
            nivel_2: pagos.filter((p) => niveles.get(p.id)!.nivel === 2).length,
            en_verde: r.verdes,
            ...(Object.keys(verdesConExcepcion).length ? { verdes_que_se_revisan_a_mano: verdesConExcepcion } : {}),
            ...(r.desglose.length > 1 ? { por_tipo: r.desglose.map((l) => ({ tipo: l.etiqueta, cantidad: l.cantidad, suman: cop(l.monto) })) } : {}),
            lista: primeros.map((p) => {
                const n = niveles.get(p.id)!;
                const d = detalle.get(p.id);
                const porque = n.nivel === 2 ? null
                    : n.porque === 'amarillo' || n.porque === 'rojo'
                        ? [...new Set(motivosDe(d).map((m) => CORTO[m.code ?? ''] ?? 'otro'))].join(', ') || n.porque
                        : n.porque;
                return {
                    pago: p.id,
                    deportista: nombres.get(p.id) ?? 'Sin ficha',
                    concepto: textoSeguro(p.concept || etiquetaDeDesglose(tipoDeCobro(p)), 80),
                    cobro: cop(saldo(p)),
                    comprobante: p.ocr_amount == null ? 'sin leer' : cop(p.ocr_amount),
                    nivel: n.nivel,
                    espera: formatoEspera(ahora - Date.parse(p.enviado_en)),
                    ...(porque ? { revisar_por: porque } : {}),
                };
            }),
            ...(pagos.length > MAX_LISTA ? { nota: `Muestro ${MAX_LISTA} de ${pagos.length}: primero los de nivel 2 y después los que más llevan esperando.` } : {}),
        };
    },
};

// ─── por_que_no_se_aprobo ───────────────────────────────────────────────────

/** ¿El cobro está en la cola de Aprobar? Misma regla que la pantalla (con comprobante). Pura. */
export function estaEnLaCola(p: { status?: string | null; receipt_url?: string | null }): boolean {
    if (!p?.receipt_url) return false;
    return p.status === 'awaiting_approval' || p.status === 'partial' || p.status === 'pending';
}

export const porQueNoSeAprobo: HerramientaConsulta<{ pago: string }> = {
    tipo: 'consulta',
    nombre: 'por_que_no_se_aprobo',
    descripcion: 'Explica en palabras por qué un comprobante no se aprobó solo o quedó por validar: monto distinto, otra cuenta, ya lo habían mandado, fecha vieja… Usa el id que dio pagos_por_validar o el de la pantalla. Solo administración.',
    esquema: {
        type: 'object',
        properties: { pago: { type: 'string', description: 'id del pago (uuid)' } },
        required: ['pago'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar: validarCon(z.object({ pago: z.string().trim().min(8).max(60) })),
    async ejecutar(a, { pago }) {
        soloAdmin(a);
        const f = await leerCobro(a, pago);
        const p = aPorValidar(f);
        const [nombres, { data: ajustes }] = await Promise.all([
            nombresDeCobros([f]),
            supabase.from('school_settings').select('auto_approve_enabled, auto_approve_max_amount').eq('school_id', a.schoolId).maybeSingle(),
        ]);
        const base = {
            deportista: nombres.get(f.id) ?? 'Sin ficha',
            concepto: textoSeguro(f.concept || 'Cobro', 80),
            estado: ESTADO_LEGIBLE[f.status] ?? String(f.status),
            cobro: cop(saldo(p)),
            comprobante: f.receipt_url ? (p.ocr_amount == null ? 'sin leer' : cop(p.ocr_amount)) : 'no tiene',
        };
        if (f.status === 'paid' || f.status === 'approved') {
            return { ...base, explicacion: f.approved_by ? 'Ya está aprobado por una persona de la escuela.' : 'Ya está aprobado (lo aprobó el sistema).' };
        }
        if (f.status === 'glosado') return { ...base, explicacion: 'Se le pidió a la familia que aclare el comprobante; su respuesta se revisa en Gestión de Pagos.' };
        if (!f.receipt_url) return { ...base, explicacion: 'Este cobro no tiene comprobante: no hay nada que aprobar todavía.' };

        const motivos = motivosDe(f).map(motivoEnPalabras);
        // ¿Qué le falta para «Aprobar todos los verdes»? Con el resto de la cola (comprobante compartido) y los meses ya pagados.
        const [{ data: mismos }, periodos] = await Promise.all([
            supabase.from('payments').select('id').eq('school_id', a.schoolId).eq('receipt_url', f.receipt_url).in('status', ['awaiting_approval', 'partial', 'pending']).limit(5),
            periodosYaPagados([p]),
        ]);
        const compartidos = ((mismos as any[]) ?? []).length > 1 ? new Set([String(f.receipt_url)]) : new Set<string>();
        const n = nivelDe(p, { compartidos, periodosPagados: periodos });
        const s = ajustes as any;
        const tope = Number(s?.auto_approve_max_amount ?? 0);
        const automatica = !s?.auto_approve_enabled
            ? 'La aprobación automática está apagada en la escuela: todo comprobante lo aprueba una persona.'
            : tope > 0 && Number(f.amount) > tope
                ? `El cobro supera el tope de aprobación automática (${cop(tope)}).`
                : 'La aprobación automática no lo pudo confirmar (dos lecturas que no coinciden, PDF o un monto elegido en el navegador): lo revisa una persona.';
        return {
            ...base,
            veredicto: f.receipt_verdict === 'verde' ? 'coincide' : f.receipt_verdict === 'amarillo' ? 'dudoso' : f.receipt_verdict === 'rojo' ? 'no cuadra' : 'sin leer',
            ...(estaEnLaCola(f) ? { nivel: n.nivel } : {}),
            motivos: motivos.length ? motivos
                : f.receipt_verdict === 'verde'
                    ? [n.porque ? `Está en verde, pero ${n.porque}.` : 'El comprobante coincide con el cobro.']
                    : ['No hay motivos guardados: el comprobante no se pudo leer.'],
            ...(estaEnLaCola(f) ? { aprobacion_automatica: automatica } : {}),
        };
    },
};

// ─── seguimiento_whatsapp ───────────────────────────────────────────────────

const quienRespondio = (f: FilaSeguimiento) =>
    f.respondioEscuela && f.respondioBot ? 'la escuela y el bot' : f.respondioEscuela ? 'la escuela' : f.respondioBot ? 'el bot' : 'nadie';

function filaCorta(f: FilaSeguimiento) {
    return {
        contacto: textoSeguro(f.contacto.nombre || 'Sin nombre', 60),
        tema: textoSeguro(f.tema.nombre, 60),
        respondio: quienRespondio(f),
        ultimo_mensaje_de: etiquetaAutor(f.ultimoMensaje.de),
        esperando: f.esperandoMin === null ? null : formatoEspera(f.esperandoMin * 60_000),
        ...(f.pendientesEscuela.length ? { preguntas_para_la_escuela: f.pendientesEscuela.slice(0, 2).map((p) => textoSeguro(p.texto)) } : {}),
        ...(f.tomada ? { la_atiende_una_persona: true } : {}),
    };
}

export const seguimientoWhatsapp: HerramientaConsulta<{ dias?: number }> = {
    tipo: 'consulta',
    nombre: 'seguimiento_whatsapp',
    descripcion: 'La pestaña Seguimiento de WhatsApp: quién escribió en los últimos días, si respondió la escuela o el bot, quién lleva más de 2 h esperando y qué preguntas el bot le pasó a la escuela sin respuesta. Sin teléfonos. Solo administración.',
    esquema: {
        type: 'object',
        properties: { dias: { type: ['integer', 'null'], description: `Días hacia atrás (1–${DIAS_MAXIMO}); null = ${DIAS_POR_DEFECTO}` } },
        required: ['dias'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar(args) {
        const r = validarCon(z.object({ dias: z.number().int().min(1).max(DIAS_MAXIMO).nullish() }))(args);
        return r.dias ? { dias: r.dias } : {};
    },
    async ejecutar(a, args) {
        soloAdmin(a);
        const dias = args.dias ?? DIAS_POR_DEFECTO;
        const rango = leerRangoSeguimiento(sumarDias(a.hoy, -(dias - 1)), a.hoy);
        if (!rango.ok) throw new RechazoHerramienta(`Pídeme entre 1 y ${DIAS_MAXIMO} días.`);
        const r = await seguimientoDeConversaciones(a.schoolId, rango);
        const res = resumirSeguimiento(r.filas);
        const pendientes = filtrarSeguimiento(r.filas, { soloSinResponder: true });
        return {
            desde: fechaCorta(rango.desde),
            resumen: {
                escribieron: res.escribieron,
                respondio_la_escuela: res.respondioEscuela,
                respondio_el_bot: res.respondioBot,
                nadie_respondio: res.nadieRespondio,
                sin_responder: res.sinResponder,
                esperando_mas_de_2_horas: res.esperandoMas2h,
                con_preguntas_pasadas_a_la_escuela: res.conPendientes,
                con_comprobante: res.conComprobante,
            },
            sin_responder: pendientes.slice(0, MAX_LISTA).map(filaCorta),
            ...(pendientes.length > MAX_LISTA ? { nota: `Muestro ${MAX_LISTA} de ${pendientes.length} sin responder, primero las que llevan más de ${ALERTA_ESPERA_MIN / 60} h o tienen preguntas pendientes.` } : {}),
            ...(r.avisos.length ? { avisos: r.avisos.map((x) => textoSeguro(x, 160)) } : {}),
        };
    },
};

// ─── auditar_pendientes ─────────────────────────────────────────────────────

export type Propuesta = 'completo' | 'abono' | 'no aprobar' | 'revisar';
export type Destino = 'exacta' | 'mascara' | 'otro_concepto' | 'fuera_de_sportmaps' | 'ajena' | 'sin_leer' | 'sin_cuentas';

/**
 * ¿A qué cuenta fue la plata, contra las cuentas de HOY de la escuela? Mismas
 * funciones que el veredicto (normalizeDestination, classifyDestinationMatch) y el
 * mismo contexto (buildVerdictContext, por categoría del cobro). Pura.
 */
export function destinoDe(ocrDestination: string | null | undefined, ctx: Pick<VerdictContext, 'registeredAccounts' | 'restrictedAccounts' | 'cuentasFueraDeSportmaps'>): Destino {
    const cuentas = ctx.registeredAccounts ?? [];
    const restringidas = ctx.restrictedAccounts ?? [];
    const fuera = ctx.cuentasFueraDeSportmaps ?? [];
    if (!cuentas.length && !restringidas.length) return 'sin_cuentas';
    const norm = normalizeDestination(ocrDestination);
    if (!norm) return 'sin_leer';
    const m = classifyDestinationMatch(norm, cuentas);
    if (m === 'exact') return 'exacta';
    if (m === 'masked') return 'mascara';
    if (restringidas.some((r) => classifyDestinationMatch(norm, [r.value]) !== 'none')) return 'otro_concepto';
    if (fuera.length && classifyDestinationMatch(norm, fuera) !== 'none') return 'fuera_de_sportmaps';
    return 'ajena';
}

export interface EntradaPropuesta {
    veredicto: string | null;
    motivos: MotivoGuardado[];
    destino: Destino;
    /** exclusionVerde del job: null = entra en «Aprobar todos los verdes». */
    exclusionVerde: string | null;
    /** findDuplicatePaymentIds: ese mes ya figura pagado para el deportista (o una ficha gemela). */
    duplicado: boolean;
    saldo: number;
    comprobante: number | null;
}

const DESTINO_TEXTO: Partial<Record<Destino, string>> = {
    otro_concepto: 'Fue a una cuenta de la escuela que es para otro concepto.',
    fuera_de_sportmaps: 'Fue a una cuenta que la escuela marcó «por fuera de SportMaps».',
    sin_cuentas: 'La escuela no tiene cuentas registradas: no se puede confirmar a dónde fue la plata.',
    sin_leer: 'No se ve a qué cuenta se mandó la plata.',
};

/**
 * La propuesta de la auditoría para un comprobante. No decide reglas de plata
 * nuevas: rotula lo que ya dicen el veredicto (receipt-verdict), la regla de
 * «Aprobar todos los verdes» (exclusionVerde), los duplicados y las cuentas de hoy.
 *   · no aprobar → un motivo rojo (no es comprobante, referencia o foto repetida,
 *                  fecha futura) o la plata fue a una cuenta que no es de la escuela.
 *   · completo   → entra en «Aprobar todos los verdes» y la cuenta es de la escuela.
 *   · abono      → lo único que no cuadra es el monto y es MENOR que el saldo
 *                  (§20.4 regla 6: se aprueba lo pagado y queda el saldo).
 *   · revisar    → todo lo demás.
 * Pura.
 */
export function proponer(e: EntradaPropuesta): { propuesta: Propuesta; porque: string[] } {
    const rojos = e.motivos.filter((r) => r?.level === 'rojo');
    const rojosGraves = rojos.filter((r) => r.code !== 'DESTINO_NO_COINCIDE');
    if (rojosGraves.length) return { propuesta: 'no aprobar', porque: rojosGraves.map(motivoEnPalabras) };
    if (e.destino === 'ajena') {
        const r = rojos[0] ?? { code: 'DESTINO_NO_COINCIDE', detail: {} };
        return { propuesta: 'no aprobar', porque: [motivoEnPalabras(r)] };
    }
    if (rojos.length) {
        // Rojo por cuenta, pero hoy la cuenta sí es de la escuela (la registraron después).
        return { propuesta: 'revisar', porque: ['Cuando llegó, la cuenta destino no estaba registrada; hoy sí es de la escuela. Revisa la foto y apruébalo en la pantalla.'] };
    }
    if (e.motivos.some((r) => r?.code === 'POSIBLE_MANIPULACION')) {
        return { propuesta: 'revisar', porque: [motivoEnPalabras({ code: 'POSIBLE_MANIPULACION' })] };
    }
    if (e.duplicado) {
        return { propuesta: 'revisar', porque: ['Ese mes ya figura pagado para ese deportista (o una ficha con el mismo nombre): puede ser un pago doble o una ficha duplicada.'] };
    }
    const cuentaBien = e.destino === 'exacta' || e.destino === 'mascara';
    if (e.veredicto === 'verde' && e.exclusionVerde === null && cuentaBien) {
        return { propuesta: 'completo', porque: ['El comprobante coincide con el cobro.'] };
    }
    const amarillos = e.motivos.filter((r) => r?.level === 'amarillo');
    const soloMonto = amarillos.length > 0 && amarillos.every((r) => r.code === 'MONTO_DIFIERE');
    if (e.veredicto === 'amarillo' && soloMonto && cuentaBien && e.comprobante !== null && e.comprobante > 0 && e.comprobante < e.saldo) {
        return {
            propuesta: 'abono',
            porque: [`Pagó ${cop(e.comprobante)} de ${cop(e.saldo)}: se aprueba lo pagado y queda un saldo de ${cop(e.saldo - e.comprobante)}.`],
        };
    }
    const porque = [
        ...amarillos.map(motivoEnPalabras),
        ...(e.veredicto === 'verde' && e.exclusionVerde ? [`Está en verde, pero ${e.exclusionVerde}.`] : []),
        ...(!e.veredicto ? ['No tiene veredicto: el comprobante no se leyó.'] : []),
        ...(DESTINO_TEXTO[e.destino] && !amarillos.some((r) => String(r.code).startsWith('DESTINO')) ? [DESTINO_TEXTO[e.destino]!] : []),
    ];
    return { propuesta: 'revisar', porque: porque.length ? [...new Set(porque)] : ['Hay que mirarlo con la foto en la pantalla Aprobar.'] };
}

const ORDEN_PROPUESTA: Record<Propuesta, number> = { completo: 0, abono: 1, revisar: 2, 'no aprobar': 3 };

export const auditarPendientes: HerramientaConsulta<Record<string, never>> = {
    tipo: 'consulta',
    nombre: 'auditar_pendientes',
    descripcion: 'Audita los comprobantes por validar: cruza cada uno con su cobro, las cuentas de la escuela, los duplicados y lo que escribió la familia, y PROPONE «completo», «abono», «no aprobar» o «revisar» con el porqué. Solo propone: no aprueba ni rechaza. Solo administración.',
    esquema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    roles: ['admin'],
    validar: () => ({}),
    async ejecutar(a) {
        soloAdmin(a);
        const todos = await leerPendientes(a.schoolId);
        if (!todos.length) return { por_validar: 0, nota: 'No hay comprobantes por validar.' };
        const ids = todos.map((p) => p.id);
        const [detalle, periodos, notas] = await Promise.all([
            detalleDeCobros(a.schoolId, ids),
            periodosYaPagados(todos),
            // El pie de foto es informativo: si la cola de WhatsApp no se lee, la auditoría sigue.
            notasDeComprobantes(a.schoolId, ids).catch(() => ({} as Record<string, { pie: string }>)),
        ]);
        const ctxVerde: ContextoVerdes = { compartidos: comprobantesCompartidos(todos), periodosPagados: periodos };
        const filas = ids.map((id) => detalle.get(id)).filter(Boolean);
        const [duplicados, nombres] = await Promise.all([
            findDuplicatePaymentIds(a.schoolId, filas.map((f) => ({
                id: f.id, child_id: f.child_id ?? null, unregistered_athlete_id: f.unregistered_athlete_id ?? null, user_id: f.user_id ?? null,
                parent_id: f.parent_id ?? null, amount: Number(f.amount) || 0, due_date: f.due_date ?? null,
                period_year: f.period_year ?? null, period_month: f.period_month ?? null, concept: f.concept ?? null, payment_category: f.payment_category ?? null,
            }))),
            nombresDeCobros(filas),
        ]);
        // Las cuentas válidas dependen de la categoría del cobro (only_for): un contexto por categoría, sin dedup (no hace falta).
        const categoria = (f: any) => categoriaDeCobro(f.payment_category ?? null, f.concept ?? null) ?? null;
        const contextos = new Map<string | null, VerdictContext>();
        for (const c of [...new Set(filas.map(categoria))]) {
            contextos.set(c, await buildVerdictContext(a.schoolId, { referenceNorm: null, imageSha256: null, paymentCategory: c, concept: null }));
        }

        const auditados = todos.map((p) => {
            const f = detalle.get(p.id) ?? {};
            const restante = saldo(p);
            const { propuesta, porque } = proponer({
                veredicto: p.receipt_verdict,
                motivos: motivosDe(f),
                destino: destinoDe(f.ocr_destination, contextos.get(categoria(f)) ?? {}),
                exclusionVerde: exclusionVerde(p, ctxVerde),
                duplicado: duplicados.has(p.id) || exclusionVerde(p, ctxVerde) === 'ese mes ya estaba pagado',
                saldo: restante,
                comprobante: p.ocr_amount,
            });
            const nota = (notas as Record<string, { pie: string }>)[p.id]?.pie;
            return {
                p, propuesta, restante,
                fila: {
                    pago: p.id,
                    deportista: nombres.get(p.id) ?? 'Sin ficha',
                    concepto: textoSeguro(p.concept || etiquetaDeDesglose(tipoDeCobro(p)), 80),
                    cobro: cop(restante),
                    comprobante: p.ocr_amount == null ? 'sin leer' : cop(p.ocr_amount),
                    propuesta,
                    por_que: porque.slice(0, 2),
                    ...(nota ? { la_familia_escribio: textoSeguro(nota) } : {}),
                },
            };
        });
        auditados.sort((x, y) => ORDEN_PROPUESTA[x.propuesta] - ORDEN_PROPUESTA[y.propuesta] || Date.parse(x.p.enviado_en) - Date.parse(y.p.enviado_en));

        const propuestas: Record<string, { cantidad: number; suman: string }> = {};
        for (const k of Object.keys(ORDEN_PROPUESTA) as Propuesta[]) {
            const de = auditados.filter((x) => x.propuesta === k);
            if (!de.length) continue;
            const suma = de.reduce((s, x) => s + (k === 'abono' ? Number(x.p.ocr_amount) || 0 : x.restante), 0);
            propuestas[k] = { cantidad: de.length, suman: cop(suma) };
        }
        return {
            por_validar: todos.length,
            propuestas,
            lista: auditados.slice(0, MAX_AUDITORIA).map((x) => x.fila),
            ...(auditados.length > MAX_AUDITORIA ? { faltan_en_la_lista: auditados.length - MAX_AUDITORIA } : {}),
            nota: 'Es una propuesta: Mapi no aprueba ni rechaza. Cada pago se decide en la pantalla Aprobar, con la foto al lado. En «abono», «suman» es lo que pagaron.',
        };
    },
};

// ─── estado_aprobacion_automatica ───────────────────────────────────────────

type EstadoPunto = 'cumple' | 'falta' | 'verificar a mano';
interface Punto { punto: string; estado: EstadoPunto; detalle: string }

export const estadoAprobacionAutomatica: HerramientaConsulta<Record<string, never>> = {
    tipo: 'consulta',
    nombre: 'estado_aprobacion_automatica',
    descripcion: 'Revisa la lista de verificación antes de encender la aprobación automática de comprobantes (cuentas registradas, tope, lectores de comprobantes, resumen diario, pendientes viejos) y dice qué le falta a la escuela. Solo lectura: no la enciende. Solo administración.',
    esquema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    roles: ['admin'],
    validar: () => ({}),
    async ejecutar(a) {
        soloAdmin(a);
        const hace60 = sumarDias(a.hoy, -60);
        const [{ data: ajustes }, { data: escuela }, recientes, pendientes, ctx] = await Promise.all([
            supabase.from('school_settings').select('auto_approve_enabled, auto_approve_max_amount, payment_accounts').eq('school_id', a.schoolId).maybeSingle(),
            supabase.from('schools').select('id, owner_id').eq('id', a.schoolId).maybeSingle(),
            supabase.from('payments').select('amount, ocr_destination')
                .eq('school_id', a.schoolId).not('receipt_url', 'is', null).gte('created_at', `${hace60}T05:00:00.000Z`).limit(2000),
            leerPendientes(a.schoolId),
            buildVerdictContext(a.schoolId, { referenceNorm: null, imageSha256: null }),
        ]);
        if ((recientes as any).error) throw new Error(`payments: ${(recientes as any).error.message}`);
        const s = (ajustes as any) ?? {};
        const filas = ((recientes as any).data as any[]) ?? [];
        const puntos: Punto[] = [];

        // 1. Cuentas: todo destino de los últimos 60 días tiene que ser una cuenta registrada.
        const cuentas = parseCuentasDePago(s.payment_accounts).filter((c) => !c.fueraDeSportmaps);
        const conocidas = [...(ctx.registeredAccounts ?? []), ...(ctx.restrictedAccounts ?? []).map((r) => r.value), ...(ctx.cuentasFueraDeSportmaps ?? [])];
        const ajenas = new Map<string, number>();
        for (const f of filas) {
            const norm = normalizeDestination(f.ocr_destination);
            if (!norm || classifyDestinationMatch(norm, conocidas) !== 'none') continue;
            ajenas.set(norm, (ajenas.get(norm) ?? 0) + 1);
        }
        const finales = [...ajenas.keys()].map(terminaEn).filter(Boolean).slice(0, 5);
        puntos.push({
            punto: 'Todas las cuentas donde recibe la escuela están registradas en Medios de pago',
            estado: !cuentas.length || ajenas.size ? 'falta' : 'cumple',
            detalle: !cuentas.length
                ? 'No hay cuentas registradas en Medios de pago.'
                : ajenas.size
                    ? `${cuentas.length} cuentas registradas, pero ${[...ajenas.values()].reduce((x, y) => x + y, 0)} comprobantes de los últimos 60 días fueron a ${ajenas.size} cuenta(s) que no están${finales.length ? ` (terminan en ${finales.join(', ')})` : ''}.`
                    : `${cuentas.length} cuentas registradas; los comprobantes de los últimos 60 días fueron a ellas.`,
        });

        // 2. Tope por pago.
        const tope = Number(s.auto_approve_max_amount ?? 0);
        const masAlto = filas.reduce((m, f) => Math.max(m, Number(f.amount) || 0), 0);
        puntos.push({
            punto: 'El tope de monto es mayor que el cobro más alto habitual',
            estado: tope > 0 && tope >= masAlto ? 'cumple' : 'falta',
            detalle: tope <= 0 ? 'El tope está en $0.' : `Tope ${cop(tope)}; el cobro más alto con comprobante en 60 días fue de ${cop(masAlto)}.`,
        });

        // 3. Dos lectores de comprobantes en este servidor.
        const lectores = listConfiguredProviders().length;
        puntos.push({
            punto: 'El servidor tiene dos lectores de comprobantes',
            estado: lectores >= 2 ? 'cumple' : 'falta',
            detalle: `Hay ${lectores} configurado(s); hacen falta dos para confirmar cada comprobante.`,
        });

        puntos.push({ punto: 'Todos los caminos de entrada pasan por el aprobador', estado: 'verificar a mano', detalle: 'Una prueba por camino: cobro existente, venta de servicio, clase de prueba, enlace público y checkout.' });
        puntos.push({ punto: 'Al aprobar, la familia recibe la confirmación por WhatsApp', estado: 'verificar a mano', detalle: 'Se prueba en la escuela de pruebas.' });

        // 6. Resumen diario: dueño y admins con correo (mismo criterio del job).
        const dest = (await destinatariosEnLote([{ id: a.schoolId, owner_id: (escuela as any)?.owner_id ?? null }])).get(a.schoolId);
        const conCorreo = dest?.correos.length ?? 0;
        puntos.push({
            punto: 'El resumen diario de pagos por validar le llega al dueño y a los admins',
            estado: conCorreo ? 'cumple' : 'falta',
            detalle: conCorreo ? `${conCorreo} persona(s) de la administración con correo.` : 'Nadie de la administración tiene correo para recibirlo.',
        });

        // 7. Pendientes viejos resueltos.
        const r = armarResumen(a.schoolId, pendientes, Date.now());
        puntos.push({
            punto: 'Los pendientes viejos se auditaron y resolvieron',
            estado: r.total ? 'falta' : 'cumple',
            detalle: r.total ? `Hay ${r.total} por validar (${r.masDe24h} con más de 24 h). Revísalos con auditar_pendientes.` : 'No hay comprobantes por validar.',
        });
        puntos.push({ punto: 'Admins y entrenadores recibieron el manual de cobros de la escuela', estado: 'verificar a mano', detalle: 'Con los medios de pago de la escuela.' });

        const cuenta = (e: EstadoPunto) => puntos.filter((p) => p.estado === e).length;
        return {
            aprobacion_automatica: s.auto_approve_enabled ? 'encendida' : 'apagada',
            resumen: `${cuenta('cumple')} cumplen, ${cuenta('falta')} faltan y ${cuenta('verificar a mano')} se verifican a mano.`,
            lista: puntos,
            nota: 'Encenderla o cambiar el tope se hace en Gestión de Pagos › Configuración; Mapi no lo cambia.',
        };
    },
};

// ─── ventas_de_servicio ─────────────────────────────────────────────────────

const ESTADOS_COBRO_PENDIENTE = new Set(['pending', 'overdue', 'partial']);

export const ventasDeServicio: HerramientaConsulta<{ item?: string }> = {
    tipo: 'consulta',
    nombre: 'ventas_de_servicio',
    descripcion: 'Cómo va la venta de una clínica, torneo, vacacional u otro servicio: interesados por WhatsApp (31 días), a cuántos se les respondió, cobros pagados, por validar y pendientes, y cupos. Sin el nombre, todos los servicios. Solo administración.',
    esquema: {
        type: 'object',
        properties: { item: { type: ['string', 'null'], description: 'Nombre o id del servicio; null = todos' } },
        required: ['item'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar(args) {
        const r = validarCon(z.object({ item: z.string().trim().max(120).nullish() }))(args);
        return r.item ? { item: r.item } : {};
    },
    async ejecutar(a, args) {
        soloAdmin(a);
        const rango = leerRangoSeguimiento(sumarDias(a.hoy, -(DIAS_MAXIMO - 1)), a.hoy);
        if (!rango.ok) throw new Error(`rango: ${rango.error}`);
        const [cat, seg] = await Promise.all([
            catalogoServicios(a.schoolId, { limite: 20 }),
            seguimientoDeConversaciones(a.schoolId, rango),
        ]);
        const items = cat.ok ? cat.items : [];
        const deVenta = filtrarSeguimiento(seg.filas, { servicio: 'servicio' });

        // Un servicio por id: el catálogo vigente y lo que aparece en las conversaciones.
        const servicios = new Map<string, { nombre: string; filas: FilaSeguimiento[]; item: (typeof items)[number] | null }>();
        for (const it of items) servicios.set(it.id, { nombre: it.nombre, filas: [], item: it });
        for (const s of seg.servicios) if (!servicios.has(s.id)) servicios.set(s.id, { nombre: s.nombre, filas: [], item: null });
        for (const f of deVenta) {
            const id = f.tema.servicioId ?? NINGUNO;
            const s = servicios.get(id) ?? { nombre: f.tema.nombre, filas: [], item: null };
            s.filas.push(f);
            servicios.set(id, s);
        }
        let elegidos = [...servicios.entries()];
        if (args.item) {
            const buscado = normalizar(args.item);
            const exactos = elegidos.filter(([id, s]) => id === args.item!.toLowerCase() || normalizar(s.nombre) === buscado);
            elegidos = exactos.length ? exactos : elegidos.filter(([, s]) => buscado && normalizar(s.nombre).includes(buscado));
            if (!elegidos.length) {
                const nombres = [...servicios.values()].map((s) => textoSeguro(s.nombre, 60));
                throw new RechazoHerramienta(nombres.length
                    ? `No encontré «${textoSeguro(args.item, 60)}». Los servicios con venta son: ${nombres.slice(0, 10).join(', ')}.`
                    : 'No hay servicios en venta ni conversaciones de venta en los últimos 31 días.');
            }
        }
        const cuenta = (fs: FilaSeguimiento[], p: (f: FilaSeguimiento) => boolean) => fs.filter(p).length;
        const lista = elegidos
            .map(([, s]) => ({
                servicio: textoSeguro(s.nombre, 80),
                ...(s.item ? {
                    precio: cop(s.item.precio),
                    cupos: s.item.cupos === null ? 'sin límite'
                        : `${Math.max(0, s.item.cupos - (s.item.cuposRestantes ?? s.item.cupos))} de ${s.item.cupos} ocupados`,
                    ...(s.item.terminaEn ? { termina: fechaCorta(String(s.item.terminaEn).slice(0, 10)) } : {}),
                } : { en_catalogo: false }),
                interesados: s.filas.length,
                sin_responder: cuenta(s.filas, sinResponder),
                esperando_mas_de_2_horas: cuenta(s.filas, (f) => (f.esperandoMin ?? 0) > ALERTA_ESPERA_MIN),
                con_datos_de_pago: cuenta(s.filas, (f) => f.datosDePagoEnviados),
                con_comprobante: cuenta(s.filas, (f) => f.comprobanteRecibido),
                cobros: {
                    pagados: cuenta(s.filas, (f) => f.cobro?.estado === 'paid'),
                    por_validar: cuenta(s.filas, (f) => f.cobro?.estado === 'awaiting_approval'),
                    pendientes: cuenta(s.filas, (f) => ESTADOS_COBRO_PENDIENTE.has(String(f.cobro?.estado))),
                },
            }))
            .sort((x, y) => y.interesados - x.interesados)
            .slice(0, 8);
        return {
            servicios: lista,
            ...(!cat.ok ? { aviso: 'No pude leer el catálogo de servicios: faltan precio y cupos.' } : cat.habilitado ? {} : { aviso: 'La escuela no tiene activas las ventas por WhatsApp.' }),
            nota: 'Interesados y cobros salen de las conversaciones de WhatsApp de los últimos 31 días; los cupos, del catálogo (cuentan todos los caminos de venta, también los de recepción).',
        };
    },
};

// ─── pedir_aclaracion (glosa) ───────────────────────────────────────────────

/** = REASONS de glosas.routes (y GlosaReason). */
export const MOTIVOS_GLOSA = [
    'MONTO_DIFIERE', 'FECHA_FUERA_VENTANA', 'REFERENCIA_DUPLICADA', 'DESTINO_NO_COINCIDE',
    'CAMPOS_ILEGIBLES', 'LECTURA_INCONSISTENTE', 'NO_APARECE_EN_BANCO', 'OTRO',
] as const satisfies readonly GlosaReason[];

/** = REASON_ADMIN_LABELS del frontend (lib/api/glosas.ts), en minúscula para la tarjeta. */
const MOTIVO_GLOSA_LEGIBLE: Record<GlosaReason, string> = {
    MONTO_DIFIERE: 'el monto no coincide',
    FECHA_FUERA_VENTANA: 'la fecha está fuera del plazo',
    REFERENCIA_DUPLICADA: 'la referencia está repetida',
    DESTINO_NO_COINCIDE: 'la cuenta destino no coincide',
    CAMPOS_ILEGIBLES: 'hay datos ilegibles',
    LECTURA_INCONSISTENTE: 'la lectura es inconsistente',
    NO_APARECE_EN_BANCO: 'no aparece en el banco',
    OTRO: 'otro',
};

/** Estados de una glosa abierta (= OPEN_GLOSA_STATUSES del frontend). */
const GLOSA_ABIERTA = ['GLOSADA', 'EN_RESPUESTA', 'EN_CONCILIACION'];

export interface ArgsAclaracion { pago: string; motivo: GlosaReason }

async function diasParaResponder(schoolId: string): Promise<number> {
    const { data } = await supabase.from('school_settings').select('glosa_response_days').eq('school_id', schoolId).maybeSingle();
    const n = Number((data as any)?.glosa_response_days);
    return Number.isFinite(n) && n > 0 ? n : 5;
}

async function tieneGlosaAbierta(schoolId: string, paymentId: string): Promise<boolean> {
    const { data, error } = await supabase.from('payment_glosas').select('id')
        .eq('school_id', schoolId).eq('payment_id', paymentId).in('status', GLOSA_ABIERTA).limit(1);
    if (error) throw new Error(`payment_glosas: ${error.message}`);
    return ((data as any[]) ?? []).length > 0;
}

export const pedirAclaracion: HerramientaAccion<ArgsAclaracion> = {
    tipo: 'accion',
    nombre: 'pedir_aclaracion',
    descripcion: 'PREPARA pedirle a la familia que aclare un comprobante por validar (glosa), como el botón «Glosa» de Gestión de Pagos (la persona confirma en la tarjeta). El pago no se rechaza: queda «necesita aclaración» y la familia responde en la app. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            pago: { type: 'string', description: 'id del pago (uuid)' },
            motivo: { type: 'string', enum: [...MOTIVOS_GLOSA], description: 'Qué no cuadra; OTRO si ninguno aplica' },
        },
        required: ['pago', 'motivo'],
        additionalProperties: false,
    },
    roles: ['admin'],
    habilitada: accionesDePagosPrendidas,
    validar(args) {
        const r = z.object({ pago: z.string().trim().min(8).max(60), motivo: z.enum(MOTIVOS_GLOSA) }).safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Faltan datos: el id del pago y el motivo de la aclaración.');
        return { pago: r.data.pago.toLowerCase(), motivo: r.data.motivo };
    },
    async preparar(a, args) {
        soloAdmin(a);
        const f = await leerCobro(a, args.pago);
        if (f.status === 'glosado') return { ok: false, motivo: 'Ese pago ya tiene una aclaración en curso.' };
        if (!estaEnLaCola(f)) {
            return { ok: false, motivo: `Ese pago no está por validar (está ${ESTADO_LEGIBLE[f.status] ?? f.status}${f.receipt_url ? '' : ', sin comprobante'}). La aclaración se pide sobre un comprobante de la cola de Aprobar.` };
        }
        if (await tieneGlosaAbierta(a.schoolId, f.id)) return { ok: false, motivo: 'Ese pago ya tiene una aclaración en curso.' };
        const [nombres, dias] = await Promise.all([nombresDeCobros([f]), diasParaResponder(a.schoolId)]);
        const nombre = nombres.get(f.id) ?? 'Sin ficha';
        const p = aPorValidar(f);
        const hasta = sumarDias(a.hoy, dias);
        const concepto = textoSeguro(f.concept || 'Cobro', 80);
        return {
            ok: true,
            args,
            targetKey: `pago:${f.id}`,
            vista: {
                titulo: `Pedir aclaración · ${nombre}`,
                lineas: [
                    `${concepto} · cobro ${cop(saldo(p))} · comprobante ${p.ocr_amount == null ? 'sin leer' : cop(p.ocr_amount)}`,
                    `Motivo: ${MOTIVO_GLOSA_LEGIBLE[args.motivo]}`,
                    'El pago queda «necesita aclaración» y sale de la cola de Aprobar. No se rechaza.',
                    `La familia recibe el aviso en la app y por correo, y tiene hasta el ${fechaLarga(hasta)} para responder.`,
                ],
                aviso: 'La respuesta de la familia se revisa en Gestión de Pagos.',
                botonConfirmar: 'Pedir aclaración',
            },
            huella: { pago: f.id, estado: f.status, motivo: args.motivo, saldo: saldo(p), comprobante: p.ocr_amount, hasta },
        };
    },
    async ejecutar(a, args) {
        soloAdmin(a);
        const f = await leerCobro(a, args.pago);
        if (f.status === 'glosado') return { estado: 'failed', resultado: { motivo: 'Ese pago ya tenía una aclaración en curso.' } };
        if (!estaEnLaCola(f)) return { estado: 'failed', resultado: { motivo: 'El pago ya no está por validar.' } };
        let glosa: string;
        try {
            // El RPC autoriza por el actor (dueño o admin activo de la escuela del pago).
            glosa = await createGlosa(a.userId, f.id, args.motivo);
        } catch (err) {
            const code = err instanceof GlosaRpcError ? err.code : undefined;
            const motivo = code === '23505'
                ? 'Ese pago ya tenía una aclaración en curso.'
                : code === '42501'
                    ? 'Tu rol en la escuela no puede pedir aclaraciones: lo hace el dueño o un administrador.'
                    : 'No se pudo abrir la aclaración. Hazlo desde Gestión de Pagos.';
            if (!code || !['23505', '42501'].includes(code)) console.error('[mapi-agente] pedir_aclaracion falló:', (err as any)?.message || String(err));
            return { estado: 'failed', resultado: { motivo } };
        }
        // Mismo correo que la ruta (nunca lanza).
        await sendGlosaCreatedEmail(glosa);
        const [nombres, dias] = await Promise.all([nombresDeCobros([f]), diasParaResponder(a.schoolId)]);
        return {
            estado: 'executed',
            resultado: { glosa, nombre: nombres.get(f.id) ?? 'Sin ficha', concepto: textoSeguro(f.concept || 'Cobro', 80), hasta: sumarDias(a.hoy, dias) },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado !== 'executed') return `No se pidió la aclaración. ${x.motivo || ''}`.trim();
        return `Se le pidió a la familia de ${x.nombre} que aclare el comprobante (${x.concepto}). Tiene hasta el ${fechaLarga(x.hasta)} para responder; su respuesta llega a Gestión de Pagos.`;
    },
};

// ─── Catálogo del módulo ────────────────────────────────────────────────────

export const HERRAMIENTAS_PAGOS: Herramienta[] = [
    pagosPorValidar,
    porQueNoSeAprobo,
    seguimientoWhatsapp,
    auditarPendientes,
    estadoAprobacionAutomatica,
    ventasDeServicio,
    pedirAclaracion,
];
