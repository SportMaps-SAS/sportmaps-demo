/**
 * whatsapp-venta-servicios — ventas por WhatsApp, CARRIL B (servicios):
 * clase extra / perfeccionamiento / refuerzo, vacacionales, torneos y viajes.
 * Spec: docs/specs/ventas-por-whatsapp.md §4.4, §5.3, §5.5, §6.1, §6.3 (F1 y F2).
 *
 * Por qué (Dynasty, 2026-10-06): 15 comprobantes del día no eran mensualidad y
 * dos se aplicaron a «Mensualidad $180.000». Vendiendo el servicio por el chat
 * cada peso entra con su concepto y sale por el link con el monto exacto.
 *
 * Regla dura: el modelo de lenguaje NO participa. Precio, cupos, total y
 * vencimiento salen del catálogo (RPC de F0) y del link; los textos con dinero
 * son plantillas deterministas de este archivo.
 *
 * Flujo (estado en `whatsapp_conversation_flows`, flow='venta'):
 *
 *   pregunta por un servicio ──► 0 ítems: «no lo tengo» → a la escuela
 *        │                       varios: lista → venta_elegir_item
 *        ▼                       1 ítem agotado: ficha «ya no quedan cupos» (cierra)
 *   ficha (foto si hay) ──► varios hijos: «¿para quién?» → venta_elegir_atleta
 *        │ uno (o no es por atleta)
 *        ▼
 *   «Así quedaría … Total $X ¿Procedemos?» [Sí, procedemos] [No] → venta_confirmar
 *        │ Sí                                      │ No → cierra
 *        ▼
 *   wa_crear_cobro_suelto (idempotente) → crearLinkWompiConMonto (60 min)
 *   → registrarAvisoDePagoPorLink → «Aquí está tu link…» → venta_esperando_pago
 *        │ «ya no» → anula el cobro         │ «retomar» con el cobro vencido → nuevo resumen
 *        │ foto del comprobante → la cola la aplica a ESTE cobro (cobroDeVentaAbierta)
 *
 * Quién compra: SOLO la familia identificada (parent_id del turno). Al
 * desconocido se le muestra la ficha con el precio y queda como prospecto
 * (lo registra el bot); nunca se le crea un cobro (D-V5).
 *
 * Una respuesta por turno: cada camino llama `enviar` UNA vez (o `escalar`,
 * que manda su único mensaje con el texto de la venta delante).
 */

import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase';
import type { BotonInteractivo } from './whatsapp.service';
import { normalizarFrase, anunciaComprobante } from './whatsapp-reglas-turno';
import { crearLinkWompiConMonto, type LinkWompiConMonto } from './wompi-link-con-monto.service';
import { emitirTokenCobro } from './cobro-enlace-publico.service';
import { appPublica, enlaceDeCobro } from '../utils/url-publica-familias';
import { plazoParaPagar } from './whatsapp-enlaces-de-pago.service';
import {
    catalogoServicios, crearCobroSuelto, MINUTOS_VIGENCIA_COBRO_SUELTO,
    type ServicioEnVenta, type TipoServicio, type CrearCobroSueltoInput,
    type CobroSueltoCreado, type CobroSueltoFallido,
} from './ventas-servicios.service';

// ─── Contrato con F0 (docs/specs/ventas-por-whatsapp.md §17) ────────────────
//
// El catálogo y el cobro son de F0 (`ventas-servicios.service.ts`). Este
// módulo los usa a través de un puerto para poder probar las conversaciones
// sin base; `puertoPorDefecto` lo conecta con F0.

export type { ServicioEnVenta, TipoServicio };

export interface PuertoVentasServicios {
    /** Servicios vendibles (≤ 10). null = ventas apagadas o migración sin aplicar: el bot sigue como hoy. */
    catalogo(schoolId: string): Promise<ServicioEnVenta[] | null>;
    /** `wa_crear_cobro_suelto`: una fila en payments, idempotente por la clave. */
    crearCobroSuelto(input: CrearCobroSueltoInput): Promise<CobroSueltoCreado | CobroSueltoFallido>;
    /**
     * Anular YA el cobro suelto («ya no»). F0 no lo expone (solo anula los
     * vencidos con el job): sin esto, se le dice a la familia que no lo pague
     * y el job lo anula a la hora.
     */
    anularCobroSuelto?(p: { paymentId: string; motivo: string }): Promise<boolean>;
    /** payments.status del cobro, o null si no existe. */
    estadoCobro(paymentId: string): Promise<string | null>;
}

// ─── Estado del flujo ───────────────────────────────────────────────────────

export const FLUJO_VENTA = 'venta';
export type PasoVenta = 'venta_elegir_item' | 'venta_elegir_atleta' | 'venta_confirmar' | 'venta_esperando_pago';
/** Sin actividad antes de pagar: 2 h (1 h de pago + margen, §6.1). */
export const VIGENCIA_FLUJO_MS = 2 * 60 * 60 * 1000;
/** Esperando el pago: 24 h, para que «retomar» y el comprobante encuentren el cobro. */
export const VIGENCIA_ESPERANDO_PAGO_MS = 24 * 60 * 60 * 1000;
/** 1 hora para pagar (D-V6): la misma vigencia del cobro suelto de F0. */
export const MINUTOS_LINK_VENTA = MINUTOS_VIGENCIA_COBRO_SUELTO;
export const MOTIVO_ANULACION = 'venta_whatsapp_cancelada_por_la_familia';

export interface HijoVenta { id: string | null; nombre: string }

export interface DatosVenta {
    carril: 'servicio';
    /** Ficha del ítem elegido, tal como la devolvió el catálogo (para el resumen). */
    servicio?: ServicioEnVenta;
    /** Ítems ofrecidos en la lista (venta_elegir_item), en orden. */
    opciones?: ServicioEnVenta[];
    hijos?: HijoVenta[];
    child_id?: string | null;
    atleta?: string | null;
    idempotency_key?: string;
    payment_id?: string;
    link_url?: string;
    link_expires_at?: string;
    total?: number;
}

export interface FlujoVenta { step: PasoVenta; data: DatosVenta; expires_at: string }

export interface AlmacenVenta {
    leer(conversationId: string): Promise<FlujoVenta | null>;
    guardar(conversationId: string, step: PasoVenta, data: DatosVenta, vigenciaMs: number): Promise<boolean>;
    borrar(conversationId: string): Promise<void>;
}

export const almacenVentaSupabase: AlmacenVenta = {
    async leer(conversationId) {
        try {
            const { data, error } = await supabase.from('whatsapp_conversation_flows')
                .select('step, data, expires_at, flow')
                .eq('conversation_id', conversationId).maybeSingle();
            if (error || !data || (data as any).flow !== FLUJO_VENTA) return null;
            return data as FlujoVenta;
        } catch {
            return null;
        }
    },
    async guardar(conversationId, step, data, vigenciaMs) {
        try {
            const ahora = new Date();
            const { error } = await supabase.from('whatsapp_conversation_flows').upsert({
                conversation_id: conversationId,
                flow: FLUJO_VENTA,
                step,
                data,
                expires_at: new Date(ahora.getTime() + vigenciaMs).toISOString(),
                updated_at: ahora.toISOString(),
            }, { onConflict: 'conversation_id' });
            return !error;
        } catch {
            return false;
        }
    },
    async borrar(conversationId) {
        try {
            // Solo el flujo de VENTA: nunca se borra una factura en curso.
            await supabase.from('whatsapp_conversation_flows').delete()
                .eq('conversation_id', conversationId).eq('flow', FLUJO_VENTA);
        } catch { /* sin tabla: nada que borrar */ }
    },
};

// ─── Adaptador por defecto (F0) ─────────────────────────────────────────────

export const puertoPorDefecto: PuertoVentasServicios = {
    async catalogo(schoolId) {
        const r = await catalogoServicios(schoolId, { limite: 10 });
        return r.ok && r.habilitado ? r.items : null;
    },
    crearCobroSuelto: (input) => crearCobroSuelto(input),
    async estadoCobro(paymentId) {
        try {
            const { data } = await supabase.from('payments').select('status').eq('id', paymentId).maybeSingle();
            return ((data as any)?.status as string) ?? null;
        } catch {
            return null;
        }
    },
};

// ─── Lectura del texto (pura) ───────────────────────────────────────────────

const PATRONES_TIPO: [TipoServicio, RegExp][] = [
    ['vacacional', /\b(vacacional(es)?|curso(s)? de vacaciones|plan(es)? (de )?vacaciones)\b/],
    ['clase_extra', /\b(perfeccionamiento|refuerzo|clases? (extra|extras|adicional(es)?|particular(es)?|personalizada(s)?|privada(s)?))\b/],
    ['torneo', /\b(torneos?|campeonatos?|copa|festival)\b/],
    ['viaje', /\b(viajes?|excursion(es)?|gira)\b/],
];

/** Señales de que PREGUNTA o QUIERE (no de que ya pagó). */
const PIDE = /\b(cuanto (vale|valen|cuesta|cuestan|es|sale|salen|seria)|valor|precio|costo|hay|habra|tienen|quiero|quisiera|queremos|me interesa|informacion|info|como (pago|hago|le hago|inscribo|separo|aparto|agendo|cancelo)|te cancelo|le cancelo|inscribir(lo|la)?|apartar|separar|agendar|agendame|agendala|agendalo|cupos?|cuando (es|son|empieza|empiezan)|que (dia|fecha|horario))\b/;
/** «Ya pagué», «te envío el comprobante»: lo atiende la regla de comprobantes, no la venta. */
const YA_PAGO = /\b(ya (pague|pagamos|transferi|consigne|cancele)|pague|transferi|consigne|comprobante|soporte|recibo)\b/;

/** ¿Qué tipo de servicio nombra el texto? Pura. */
export function tipoNombrado(texto: string | null | undefined): TipoServicio | null {
    const t = normalizarFrase(texto);
    for (const [tipo, re] of PATRONES_TIPO) if (re.test(t)) return tipo;
    return null;
}

/**
 * ¿La familia pregunta por (o quiere) un servicio vendible? Pura.
 * «¿Cuánto vale la clase de perfeccionamiento?», «hay vacacionales?»,
 * «cómo te cancelo la perfeccionamiento» (en Colombia, cancelar = pagar).
 * No: «ya pagué el torneo», «te envío el comprobante del viaje».
 *
 * `nombres`: nombres del catálogo (normalizados): «el torneo Fénix» o «Fénix?»
 * cuenta aunque no diga la palabra «torneo».
 */
export function preguntaPorServicio(texto: string | null | undefined, nombres: string[] = []): boolean {
    const crudo = (texto ?? '').trim();
    const t = normalizarFrase(crudo);
    if (!pideOQuiereServicio(crudo)) return false;
    return tipoNombrado(t) !== null || nombres.some((n) => tokensDistintivos(n).some((k) => t.split(' ').includes(k)));
}

/**
 * ¿El texto PREGUNTA o QUIERE algo (precio, información, inscribirse, «?»), y no
 * avisa que ya pagó ni que manda el comprobante? Sin mirar QUÉ servicio nombra:
 * lo usa también el destino por anuncio (whatsapp-anuncio-destino). Pura.
 */
export function pideOQuiereServicio(texto: string | null | undefined): boolean {
    const crudo = (texto ?? '').trim();
    const t = normalizarFrase(crudo);
    if (!t) return false;
    if (YA_PAGO.test(t) || anunciaComprobante(crudo)) return false;
    return PIDE.test(t) || crudo.includes('?') || nombraEventoParaInscribirse(t);
}

/**
 * Clínica, campamento o vacacional SOLOS («Vacacional», «el vacacional») o con
 * registro / inscripción / matrícula («registro para el vacacional del 17 de nov…»):
 * la familia escribió el nombre del evento para preguntar por él (Monster 2026-11-11: el
 * bot contestaba con los horarios de la clase de prueba). «Torneo» no entra: sin ítem
 * de torneo en el catálogo siempre pasaría a una persona. Sobre texto ya normalizado.
 */
const EVENTO_PALABRA = /\b(clinicas?|campamentos?|vacacional(es)?)\b/;
const EVENTO_SOLO = /^(?:(?:el|la|los|las|un|una) )?(?:clinicas?|campamentos?|vacacional(?:es)?)$/;
const REGISTRO_DE_EVENTO = /\b(registro|registrar(?:se|lo|la)?|inscripcion(?:es)?|inscribir(?:se|lo|la)?|matricula|matricular(?:se|lo|la)?)\b/;
function nombraEventoParaInscribirse(t: string): boolean {
    return EVENTO_SOLO.test(t) || (EVENTO_PALABRA.test(t) && REGISTRO_DE_EVENTO.test(t));
}

const VACIAS = new Set([
    'clase', 'clases', 'de', 'del', 'la', 'las', 'el', 'los', 'para', 'con', 'por', 'una', 'uno', 'curso',
    'cursos', 'plan', 'sub', 'categoria', 'escuela', 'club',
]);

/** Palabras de un nombre que sirven para reconocerlo en el chat (≥ 4 letras, sin vacías). Pura. */
export function tokensDistintivos(nombre: string): string[] {
    return normalizarFrase(nombre).split(' ').filter((w) => w.length >= 4 && !VACIAS.has(w));
}

/**
 * Qué ítems del catálogo nombra el texto. Pura.
 *  · Si alguna palabra distintiva del NOMBRE aparece («Fénix», «perfeccionamiento»),
 *    quedan los de más coincidencias.
 *  · Si no, los del TIPO nombrado («hay vacacionales?» → todos los vacacionales).
 */
export function serviciosNombrados(texto: string, catalogo: ServicioEnVenta[]): ServicioEnVenta[] {
    const palabras = new Set(normalizarFrase(texto).split(' '));
    const tipo = tipoNombrado(texto);
    const puntaje = catalogo.map((s) => ({
        s, hits: tokensDistintivos(s.nombre).filter((k) => palabras.has(k)).length,
    }));
    const max = Math.max(0, ...puntaje.map((p) => p.hits));
    if (max > 0) return puntaje.filter((p) => p.hits === max).map((p) => p.s);
    return tipo ? catalogo.filter((s) => s.tipo === tipo) : [];
}

const SI = /^(si|sii+|sip|dale|de una|listo|ok|okay|okey|claro|procedamos|procede|procedemos|si procedemos|si por favor|si porfa|confirmo|correcto|hagale|hagamosle|va|vale)\b/;
const NO = /^(no|nop|nel|mejor no|no gracias|ahora no|despues|luego)\b/;
/** Desistir de lo que ya se pidió. «Cancelar» suelto en Colombia también es pagar: solo cuenta solo o con el objeto. */
const DESISTE = /^(cancela(r|lo|la)?|anula(r|lo|la)?)$|\b(ya no|no lo quiero|no la quiero|ya no lo quiero|ya no la quiero|mejor no|olvidalo|olvidelo|olvidate|anula(r|lo|la)?( el| la)? (cobro|pedido|compra|reserva)|cancela(r|lo|la)? (el|la) (cobro|pedido|compra|reserva|clase)|no voy a (pagar|ir))\b/;
const RETOMAR = /\b(retomar|retoma|retomemos|otra vez el link|nuevo link|otro link|reenviame el link|mandame el link|el link|link de pago|pagar ya)\b/;

export function esSi(texto: string): boolean { return SI.test(normalizarFrase(texto)); }
export function esNo(texto: string): boolean { return NO.test(normalizarFrase(texto)); }
export function desiste(texto: string): boolean { return DESISTE.test(normalizarFrase(texto)); }
export function quiereRetomar(texto: string): boolean { return RETOMAR.test(normalizarFrase(texto)); }

/** «2», «la 2», «opción 2» → 1-based, o null. Pura. */
export function numeroElegido(texto: string, max: number): number | null {
    const m = normalizarFrase(texto).match(/^(la |el |opcion |numero )?(\d{1,2})$/);
    if (!m) return null;
    const n = Number(m[2]);
    return n >= 1 && n <= max ? n : null;
}

/** El hijo que nombra el texto (primer nombre o nombre completo), si es UNO solo. Pura. */
export function hijoNombrado(texto: string, hijos: HijoVenta[]): HijoVenta | null {
    const palabras = new Set(normalizarFrase(texto).split(' '));
    const hit = hijos.filter((h) => {
        const partes = normalizarFrase(h.nombre).split(' ').filter((p) => p.length >= 3);
        return partes.length > 0 && palabras.has(partes[0]);
    });
    return hit.length === 1 ? hit[0] : null;
}

// ─── Plantillas (puras) ─────────────────────────────────────────────────────

export const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

const NOMBRE_TIPO: Record<TipoServicio, string> = {
    clase_extra: 'clases extra', vacacional: 'vacacionales', torneo: 'torneos', viaje: 'viajes', otro: 'ese servicio',
};

const ZONA = 'America/Bogota';

function partesFecha(iso: string): { dia: string; hora: string | null; ymd: string; mes: string; num: string } {
    const d = new Date(iso);
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, ...o }).format(d);
    const hh = Number(f({ hour: 'numeric', hourCycle: 'h23' })) % 24;
    const mm = Number(f({ minute: 'numeric' }));
    const hora = hh === 0 && mm === 0
        ? null
        : `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'a. m.' : 'p. m.'}`;
    return {
        dia: `${f({ weekday: 'long' })} ${f({ day: 'numeric' })} de ${f({ month: 'long' })}`,
        hora,
        ymd: f({ year: 'numeric', month: '2-digit', day: '2-digit' }),
        mes: f({ month: 'long' }),
        num: f({ day: 'numeric' }),
    };
}

/** «jueves 9 de octubre, 4:00 p. m.» / «del 14 al 18 de octubre». null sin fecha. Pura. */
export function cuandoEs(s: Pick<ServicioEnVenta, 'iniciaEn' | 'terminaEn'>): string | null {
    if (!s.iniciaEn || Number.isNaN(new Date(s.iniciaEn).getTime())) return null;
    const a = partesFecha(s.iniciaEn);
    if (s.terminaEn && !Number.isNaN(new Date(s.terminaEn).getTime())) {
        const b = partesFecha(s.terminaEn);
        if (b.ymd !== a.ymd) {
            return a.mes === b.mes ? `del ${a.num} al ${b.num} de ${b.mes}` : `del ${a.num} de ${a.mes} al ${b.num} de ${b.mes}`;
        }
    }
    return a.hora ? `${a.dia}, ${a.hora}` : a.dia;
}

function lineaCupos(s: ServicioEnVenta): string | null {
    if (s.cuposRestantes === null) return null;
    if (s.cuposRestantes <= 0) return 'Ya no quedan cupos.';
    return s.cuposRestantes === 1 ? 'queda 1 cupo' : `quedan ${s.cuposRestantes} cupos`;
}

/** Ficha de un servicio: nombre, descripción, fecha, valor y cupos, todo de la base. Pura. */
export function textoFicha(s: ServicioEnVenta): string {
    const cupos = lineaCupos(s);
    const cuando = cuandoEs(s);
    const valor = `Valor: *${cop(s.precio)}*` + (cupos && s.cuposRestantes! > 0 ? ` · ${cupos}` : '');
    return [
        `*${s.nombre}*`,
        s.descripcion?.trim() ? s.descripcion.trim().slice(0, 300) : null,
        cuando ? `Cuándo: ${cuando}` : null,
        valor,
        s.cuposRestantes !== null && s.cuposRestantes <= 0 ? cupos : null,
    ].filter(Boolean).join('\n');
}

/** Resumen con plantilla fija (§5.3). El total es el precio del catálogo. Pura. */
export function textoResumen(s: ServicioEnVenta, atleta: string | null): string {
    const cuando = cuandoEs(s);
    return [
        'Así quedaría:',
        `• ${s.nombre}${cuando ? ` (${cuando})` : ''}`,
        atleta ? `• Para: ${atleta}` : null,
        `Total: *${cop(s.precio)}*`,
        '¿Procedemos?',
    ].filter(Boolean).join('\n');
}

/** Lista de opciones cuando el texto nombra varios ítems. Pura. */
export function textoLista(opciones: ServicioEnVenta[]): string {
    const lineas = opciones.map((s, i) => {
        const cuando = cuandoEs(s);
        const agotado = s.cuposRestantes !== null && s.cuposRestantes <= 0 ? ' (sin cupos)' : '';
        return `${i + 1}. *${s.nombre}*${cuando ? ` — ${cuando}` : ''} — ${cop(s.precio)}${agotado}`;
    });
    return `Esto es lo que tiene la escuela:\n\n${lineas.join('\n')}\n\n¿Cuál te interesa? Escríbeme el número.`;
}

/** Mensaje del link. «Te aviso por aquí» SOLO si el aviso quedó registrado. Pura. */
export function textoLink(p: { url: string; total: number; base: number; recargo: number; minutos: number; avisa: boolean }): string {
    const recargo = p.recargo > 0 ? ` (incluye ${cop(p.recargo)} del pago en línea)` : '';
    return `Listo. Aquí está tu link de pago por *${cop(p.total)}*${recargo}:\n${p.url}\n\n` +
        `Tienes ${plazoParaPagar(p.minutos)} para pagar` +
        (p.avisa ? '; cuando se apruebe te aviso por aquí.' : '.');
}

/** Sin link con monto (la escuela no tiene pago en línea): la página del cobro. Pura. */
export function textoPaginaCobro(url: string, total: number): string {
    return `Listo, quedó tu cobro por *${cop(total)}*. Puedes pagarlo aquí:\n${url}\n\n` +
        'Si pagas por transferencia, mándame la foto del comprobante por este chat y lo aplico a este cobro.';
}

// ─── Botones ────────────────────────────────────────────────────────────────

export const BOTON_VENTA = {
    SI: 'sm_vt_si',
    NO: 'sm_vt_no',
    ITEM: 'sm_vt_item:',
    HIJO: 'sm_vt_hijo:',
} as const;

const BOTONES_CONFIRMAR: BotonInteractivo[] = [
    { id: BOTON_VENTA.SI, title: 'Sí, procedemos' },
    { id: BOTON_VENTA.NO, title: 'No' },
];

export function esBotonVenta(id: string | null | undefined): boolean {
    return !!id && id.startsWith('sm_vt_');
}

// ─── Contexto del turno ─────────────────────────────────────────────────────

export interface EnvioVenta {
    botones?: BotonInteractivo[];
    /** URL https de la foto del servicio (encabezado del mensaje). */
    imagen?: string | null;
    /** Botón URL «Pagar». */
    cta?: { texto: string; url: string };
}

export interface CtxVenta {
    conversationId: string;
    schoolId: string;
    integrationId: string;
    contactWaId: string;
    /** Acudiente identificado EN ESTE TURNO. null = desconocido: solo consulta. */
    parentId: string | null;
    enviar: (texto: string, paso: string, extra?: EnvioVenta) => Promise<void>;
    /** Escala a la escuela con `antes` delante del aviso (un solo mensaje). */
    escalar: (motivo: string, antes: string) => Promise<void>;
    /** Desconocido que preguntó: queda como prospecto. */
    registrarProspecto?: () => Promise<void>;
    puerto?: PuertoVentasServicios;
    almacen?: AlmacenVenta;
    hijos?: (schoolId: string, parentId: string) => Promise<HijoVenta[]>;
    crearLink?: (paymentId: string, opts: { minutos?: number }) => Promise<LinkWompiConMonto>;
    registrarAviso?: (paymentId: string) => Promise<boolean>;
    paginaCobro?: (paymentId: string) => Promise<string | null>;
    nuevaClave?: () => string;
    ahora?: () => Date;
}

async function hijosPorDefecto(schoolId: string, parentId: string): Promise<HijoVenta[]> {
    const { candidatosDeLaFamilia } = await import('./whatsapp-ausencias.service');
    const c = await candidatosDeLaFamilia(schoolId, parentId);
    return c.map((x) => ({ id: x.childId, nombre: x.nombre })).filter((h) => h.nombre);
}

async function registrarAvisoPorDefecto(ctx: CtxVenta, paymentId: string): Promise<boolean> {
    try {
        const { registrarAvisoDePagoPorLink } = await import('../jobs/whatsapp-payment-outcome.job');
        const r = await registrarAvisoDePagoPorLink({
            integrationId: ctx.integrationId, schoolId: ctx.schoolId, waPhone: ctx.contactWaId, paymentId,
        });
        return r.ok;
    } catch {
        return false;
    }
}

async function paginaCobroPorDefecto(paymentId: string): Promise<string | null> {
    try {
        const token = await emitirTokenCobro(paymentId);
        return token ? enlaceDeCobro(appPublica(), token) : null;
    } catch {
        return null;
    }
}

// ─── Turno ──────────────────────────────────────────────────────────────────

/**
 * Un turno de venta. true = lo resolvió este módulo (mandó UNA respuesta).
 * false = no era para acá (sigue el bot normal).
 *
 * `iniciar=false`: solo continúa un flujo abierto (o un botón `sm_vt_*`).
 * `iniciar=true`: además arranca si la familia pregunta por un servicio.
 */
export async function atenderTurnoVenta(
    ctx: CtxVenta, textoCrudo: string, botonId: string | null, opts: { iniciar: boolean },
): Promise<boolean> {
    const almacen = ctx.almacen ?? almacenVentaSupabase;
    const ahora = (ctx.ahora ?? (() => new Date()))();
    const texto = (textoCrudo || '').trim();

    let flujo = ctx.parentId ? await almacen.leer(ctx.conversationId) : null;
    if (flujo && new Date(flujo.expires_at).getTime() <= ahora.getTime()) {
        await almacen.borrar(ctx.conversationId);
        flujo = null;
    }

    if (flujo) {
        const r = await continuar(ctx, almacen, flujo, texto, botonId);
        if (r) return true;
    } else if (esBotonVenta(botonId)) {
        // Botón de una venta que ya venció o se cerró.
        await ctx.enviar('Esa opción ya venció. Si todavía lo quieres, pregúntame de nuevo por el servicio.', 'venta_vencida');
        return true;
    }

    if (!opts.iniciar) return false;
    return iniciar(ctx, almacen, texto);
}

async function iniciar(ctx: CtxVenta, almacen: AlmacenVenta, texto: string): Promise<boolean> {
    const puerto = ctx.puerto ?? puertoPorDefecto;
    // Barato primero: sin palabra de servicio ni pregunta no se consulta nada.
    const tipo = tipoNombrado(texto);
    const crudo = normalizarFrase(texto);
    if (!crudo || YA_PAGO.test(crudo) || anunciaComprobante(texto)) return false;
    const pareceServicio = tipo !== null || crudo.includes('?') || PIDE.test(crudo) || texto.includes('?');
    if (!pareceServicio) return false;

    const catalogo = await puerto.catalogo(ctx.schoolId);
    // Ventas apagadas o migración sin aplicar: el bot sigue como hoy.
    if (!catalogo) return false;
    if (!preguntaPorServicio(texto, catalogo.map((s) => s.nombre))) return false;

    const nombrados = serviciosNombrados(texto, catalogo);
    if (nombrados.length === 0) {
        // Nombró un tipo que la escuela no tiene. Nunca se inventa un precio.
        const que = tipo ? NOMBRE_TIPO[tipo] : 'ese servicio';
        if (!ctx.parentId) return false;   // el desconocido sigue por el camino del prospecto
        await ctx.escalar('venta_sin_catalogo',
            `Por ahora no tengo ${que} en el catálogo de la escuela. Dejo tu pregunta con la escuela.`);
        return true;
    }

    if (!ctx.parentId) {
        // Desconocido: ficha con precio, sin cobro (D-V5). Queda como prospecto.
        await ctx.registrarProspecto?.().catch(() => undefined);
        const cuerpo = nombrados.length === 1 ? textoFicha(nombrados[0]) : textoLista(nombrados.slice(0, 10))
            .replace(/\n\n¿Cuál te interesa\?.*$/s, '');
        await ctx.enviar(
            `${cuerpo}\n\nPara apartar un cupo, la escuela te contacta por aquí. ` +
            'Si ya eres familia de la escuela, escríbeme el correo con el que estás registrado.',
            'venta_consulta_desconocido',
            nombrados.length === 1 ? { imagen: nombrados[0].imagenUrl } : undefined,
        );
        return true;
    }

    if (nombrados.length > 1) {
        const opciones = nombrados.slice(0, 10);
        if (!(await almacen.guardar(ctx.conversationId, 'venta_elegir_item', { carril: 'servicio', opciones }, VIGENCIA_FLUJO_MS))) {
            return falloDeEstado(ctx);
        }
        await ctx.enviar(textoLista(opciones), 'venta_elegir_item', {
            botones: opciones.map((s, i) => ({ id: `${BOTON_VENTA.ITEM}${i}`, title: s.nombre, descripcion: cop(s.precio) })),
        });
        return true;
    }

    return mostrarFicha(ctx, almacen, nombrados[0], texto);
}

/** Ficha + siguiente pregunta (para quién / ¿procedemos?) en UN mensaje. */
async function mostrarFicha(ctx: CtxVenta, almacen: AlmacenVenta, s: ServicioEnVenta, texto: string): Promise<boolean> {
    const ficha = textoFicha(s);
    if (s.cuposRestantes !== null && s.cuposRestantes <= 0) {
        await almacen.borrar(ctx.conversationId);
        await ctx.enviar(`${ficha}\n\nSi quieres, escríbele a la escuela para quedar en lista de espera.`,
            'venta_sin_cupos', { imagen: s.imagenUrl });
        return true;
    }

    let hijos: HijoVenta[] = [];
    if (s.porAtleta) {
        hijos = await (ctx.hijos ?? hijosPorDefecto)(ctx.schoolId, ctx.parentId!).catch(() => []);
        if (hijos.length === 0) {
            // Sin deportista activo en la escuela no hay a nombre de quién cobrar.
            await almacen.borrar(ctx.conversationId);
            await ctx.escalar('venta_sin_atleta_activo',
                `${ficha}\n\nNo encuentro un deportista activo a tu nombre para agendarlo. Paso tu pedido a la escuela.`);
            return true;
        }
    }
    const elegido = !s.porAtleta ? null : hijos.length === 1 ? hijos[0] : hijoNombrado(texto, hijos);

    if (s.porAtleta && !elegido) {
        if (!(await almacen.guardar(ctx.conversationId, 'venta_elegir_atleta',
            { carril: 'servicio', servicio: s, hijos }, VIGENCIA_FLUJO_MS))) {
            return falloDeEstado(ctx);
        }
        const lista = hijos.map((h, i) => `${i + 1}. ${h.nombre}`).join('\n');
        await ctx.enviar(`${ficha}\n\n¿Para quién es?\n${lista}`, 'venta_elegir_atleta', {
            imagen: s.imagenUrl,
            botones: hijos.map((h, i) => ({ id: `${BOTON_VENTA.HIJO}${i}`, title: h.nombre.split(' ')[0] || h.nombre })),
        });
        return true;
    }

    return pedirConfirmacion(ctx, almacen, s, elegido, { conFicha: ficha, imagen: s.imagenUrl });
}

async function pedirConfirmacion(
    ctx: CtxVenta, almacen: AlmacenVenta, s: ServicioEnVenta, hijo: HijoVenta | null,
    extra: { conFicha?: string; imagen?: string | null } = {},
): Promise<boolean> {
    const data: DatosVenta = {
        carril: 'servicio', servicio: s,
        child_id: hijo?.id ?? null, atleta: hijo?.nombre ?? null,
        // La clave nace al entrar a confirmar: un doble toque o un reintento de
        // Meta devuelven el MISMO cobro.
        idempotency_key: (ctx.nuevaClave ?? randomUUID)(),
    };
    if (!(await almacen.guardar(ctx.conversationId, 'venta_confirmar', data, VIGENCIA_FLUJO_MS))) {
        return falloDeEstado(ctx);
    }
    const resumen = textoResumen(s, hijo?.nombre ?? null);
    await ctx.enviar(extra.conFicha ? `${extra.conFicha}\n\n${resumen}` : resumen, 'venta_confirmar', {
        botones: BOTONES_CONFIRMAR, imagen: extra.imagen ?? null,
    });
    return true;
}

async function falloDeEstado(ctx: CtxVenta): Promise<boolean> {
    await ctx.escalar('venta_sin_estado', 'No pude dejar listo tu pedido en este momento. Paso tu mensaje a la escuela.');
    return true;
}

/** Con flujo abierto. false = el mensaje no es para la venta (sigue el bot). */
async function continuar(
    ctx: CtxVenta, almacen: AlmacenVenta, flujo: FlujoVenta, texto: string, botonId: string | null,
): Promise<boolean> {
    const d = flujo.data ?? ({ carril: 'servicio' } as DatosVenta);

    // Un botón de OTRA cosa: elección explícita. Antes del pago, la venta se
    // descarta; esperando el pago, el cobro sigue vivo y el flujo también.
    if (botonId && !esBotonVenta(botonId)) {
        if (flujo.step !== 'venta_esperando_pago') await almacen.borrar(ctx.conversationId);
        return false;
    }

    if (flujo.step === 'venta_esperando_pago') {
        // Doble toque de «Sí, procedemos»: la misma clave → el MISMO cobro y el mismo link.
        if (botonId === BOTON_VENTA.SI) return confirmar(ctx, almacen, d);
        if (botonId === BOTON_VENTA.NO) return continuarEsperandoPago(ctx, almacen, d, 'ya no');
        return continuarEsperandoPago(ctx, almacen, d, texto);
    }

    // Desistir antes de pagar: no hay cobro que anular.
    if (botonId === BOTON_VENTA.NO || (!botonId && (desiste(texto) || (flujo.step === 'venta_confirmar' && esNo(texto))))) {
        await almacen.borrar(ctx.conversationId);
        await ctx.enviar('Listo, no lo agendo. Si cambias de opinión, pregúntame de nuevo.', 'venta_cancelada');
        return true;
    }

    if (flujo.step === 'venta_elegir_item') {
        const opciones = d.opciones ?? [];
        let i: number | null = null;
        if (botonId?.startsWith(BOTON_VENTA.ITEM)) i = Number(botonId.slice(BOTON_VENTA.ITEM.length)) + 1;
        else i = numeroElegido(texto, opciones.length);
        if (!i) {
            const porNombre = serviciosNombrados(texto, opciones);
            if (porNombre.length === 1) i = opciones.indexOf(porNombre[0]) + 1;
        }
        const s = i ? opciones[i - 1] : null;
        if (!s) {
            await almacen.borrar(ctx.conversationId);
            return false;
        }
        // Se relee del catálogo: precio y cupos pueden haber cambiado.
        const fresco = (await (ctx.puerto ?? puertoPorDefecto).catalogo(ctx.schoolId))?.find((x) => x.id === s.id);
        if (!fresco) {
            await almacen.borrar(ctx.conversationId);
            await ctx.enviar(`*${s.nombre}* ya no está disponible. Si quieres, pregúntale a la escuela.`, 'venta_no_disponible');
            return true;
        }
        return mostrarFicha(ctx, almacen, fresco, texto);
    }

    if (flujo.step === 'venta_elegir_atleta') {
        const hijos = d.hijos ?? [];
        let h: HijoVenta | null = null;
        if (botonId?.startsWith(BOTON_VENTA.HIJO)) h = hijos[Number(botonId.slice(BOTON_VENTA.HIJO.length))] ?? null;
        else {
            const n = numeroElegido(texto, hijos.length);
            h = n ? hijos[n - 1] : hijoNombrado(texto, hijos);
        }
        if (!h || !d.servicio) {
            await almacen.borrar(ctx.conversationId);
            return false;
        }
        return pedirConfirmacion(ctx, almacen, d.servicio, h);
    }

    // venta_confirmar
    if (botonId === BOTON_VENTA.SI || (!botonId && esSi(texto))) {
        return confirmar(ctx, almacen, d);
    }
    // «Mejor para Sara»: cambia el atleta y vuelve a mostrar el resumen.
    if (!botonId && d.servicio?.porAtleta) {
        const hijos = await (ctx.hijos ?? hijosPorDefecto)(ctx.schoolId, ctx.parentId!).catch(() => []);
        const otro = hijoNombrado(texto, hijos);
        if (otro && otro.id !== d.child_id) return pedirConfirmacion(ctx, almacen, d.servicio, otro);
    }
    // Otra cosa: la venta (sin cobro todavía) se descarta y atiende el bot.
    await almacen.borrar(ctx.conversationId);
    return false;
}

/** «Sí, procedemos»: cobro suelto → link con monto → aviso registrado → UN mensaje. */
async function confirmar(ctx: CtxVenta, almacen: AlmacenVenta, d: DatosVenta): Promise<boolean> {
    const puerto = ctx.puerto ?? puertoPorDefecto;
    const s = d.servicio;
    if (!s || !ctx.parentId) {
        await almacen.borrar(ctx.conversationId);
        return false;
    }
    const clave = d.idempotency_key ?? (ctx.nuevaClave ?? randomUUID)();
    const cobro = await puerto.crearCobroSuelto({
        schoolId: ctx.schoolId, itemId: s.id, parentId: ctx.parentId, childId: d.child_id ?? null,
        idempotencyKey: clave, conversationId: ctx.conversationId, minutosVigencia: MINUTOS_LINK_VENTA,
    });

    let paymentId: string;
    let monto: number;
    let previo = false;
    if (cobro.ok) {
        // Clave repetida de un cobro que ya venció (doble toque tardío): se vuelve a cotizar.
        if (cobro.estado === 'cancelled') return reCotizar(ctx, almacen, d, s);
        if (cobro.estado === 'paid') return yaPagado(ctx, almacen, s);
        paymentId = cobro.paymentId;
        monto = cobro.monto;
    } else if (cobro.code === 'ya_inscrito' && cobro.paymentId) {
        // Ya hay un cobro vivo de ese servicio para ese atleta: se reenvía SU link.
        if ((await puerto.estadoCobro(cobro.paymentId)) === 'paid') return yaPagado(ctx, almacen, s);
        paymentId = cobro.paymentId;
        monto = 0;
        previo = true;
    } else {
        await almacen.borrar(ctx.conversationId);
        if (cobro.code === 'sin_cupos') {
            await ctx.enviar(`Lo siento, se acabaron los cupos de *${s.nombre}* justo ahora. No se generó ningún cobro.`,
                'venta_sin_cupos');
            return true;
        }
        if (cobro.code === 'item_vencido' || cobro.code === 'item_no_disponible') {
            await ctx.enviar(`*${s.nombre}* ya no está disponible. No se generó ningún cobro.`, 'venta_no_disponible');
            return true;
        }
        await ctx.escalar(`venta_cobro_fallo:${cobro.code}`,
            `No pude generar el cobro de *${s.nombre}*. No se cobró nada; paso tu pedido a la escuela.`);
        return true;
    }
    const antes = previo ? `Ya tenías un cobro pendiente de *${s.nombre}*${d.atleta ? ` para ${d.atleta}` : ''}. ` : '';

    const link = await (ctx.crearLink ?? crearLinkWompiConMonto)(paymentId, { minutos: MINUTOS_LINK_VENTA })
        .catch(() => ({ ok: false, code: 'error', error: '' }) as LinkWompiConMonto);

    if (link.ok) {
        // Enlace corto (2026-10-13): la página del cobro, no la URL firmada de Wompi.
        const enlace = link.paginaCobro ?? link.url;
        const avisa = await (ctx.registrarAviso ?? ((id: string) => registrarAvisoPorDefecto(ctx, id)))(paymentId)
            .catch(() => false);
        await almacen.guardar(ctx.conversationId, 'venta_esperando_pago', {
            ...d, idempotency_key: clave, payment_id: paymentId,
            link_url: enlace, link_expires_at: link.venceEn, total: link.total,
        }, VIGENCIA_ESPERANDO_PAGO_MS);
        await ctx.enviar(
            antes + textoLink({ url: enlace, total: link.total, base: link.base, recargo: link.recargo, minutos: link.minutos, avisa }),
            'venta_link_enviado',
            { cta: { texto: 'Pagar', url: enlace } },
        );
        return true;
    }

    // Sin pago en línea o falla del link: la página del cobro (/p/:token).
    const pagina = await (ctx.paginaCobro ?? paginaCobroPorDefecto)(paymentId).catch(() => null);
    const total = monto > 0 ? monto : s.precio;
    await almacen.guardar(ctx.conversationId, 'venta_esperando_pago', {
        ...d, idempotency_key: clave, payment_id: paymentId, link_url: pagina ?? undefined, total,
    }, VIGENCIA_ESPERANDO_PAGO_MS);
    if (pagina) {
        await ctx.enviar(antes + textoPaginaCobro(pagina, total), 'venta_link_enviado', { cta: { texto: 'Pagar', url: pagina } });
    } else {
        await ctx.enviar(
            `${antes}Listo, quedó tu cobro de *${s.nombre}* por *${cop(total)}*. Mándame la foto del comprobante ` +
            'por este chat cuando pagues y lo aplico a este cobro.',
            'venta_cobro_sin_link');
    }
    return true;
}

async function yaPagado(ctx: CtxVenta, almacen: AlmacenVenta, s: ServicioEnVenta): Promise<boolean> {
    await almacen.borrar(ctx.conversationId);
    await ctx.enviar(`Tu pago de *${s.nombre}* ya está aprobado ✅ No tienes que hacer nada más.`, 'venta_ya_pagada');
    return true;
}

/** El cobro venció y F0 lo anuló: se vuelve a cotizar (precio y cupos pudieron cambiar), con clave nueva. */
async function reCotizar(ctx: CtxVenta, almacen: AlmacenVenta, d: DatosVenta, s: ServicioEnVenta): Promise<boolean> {
    const fresco = (await (ctx.puerto ?? puertoPorDefecto).catalogo(ctx.schoolId))?.find((x) => x.id === s.id);
    if (!fresco) {
        await almacen.borrar(ctx.conversationId);
        await ctx.enviar(`*${s.nombre}* ya no está disponible. Si quieres, pregúntale a la escuela.`, 'venta_no_disponible');
        return true;
    }
    if (fresco.cuposRestantes !== null && fresco.cuposRestantes <= 0) {
        await almacen.borrar(ctx.conversationId);
        await ctx.enviar(`${textoFicha(fresco)}\n\nSi quieres, escríbele a la escuela para quedar en lista de espera.`,
            'venta_sin_cupos');
        return true;
    }
    return pedirConfirmacion(ctx, almacen, fresco, d.atleta ? { id: d.child_id ?? null, nombre: d.atleta } : null);
}

async function continuarEsperandoPago(
    ctx: CtxVenta, almacen: AlmacenVenta, d: DatosVenta, texto: string,
): Promise<boolean> {
    const puerto = ctx.puerto ?? puertoPorDefecto;
    const s = d.servicio;
    if (!d.payment_id || !s) return false;

    if (desiste(texto)) {
        const estado = await puerto.estadoCobro(d.payment_id);
        if (estado === 'paid') {
            await ctx.escalar('venta_desiste_pagada',
                `Tu pago de *${s.nombre}* ya está aprobado, así que no lo puedo anular por aquí. Paso tu mensaje a la escuela.`);
            return true;
        }
        if (estado && estado !== 'pending' && estado !== 'overdue') {
            await almacen.borrar(ctx.conversationId);
            await ctx.enviar(`Listo, ese cobro de *${s.nombre}* ya no está vigente; no tienes que pagar nada.`, 'venta_cancelada');
            return true;
        }
        await almacen.borrar(ctx.conversationId);
        if (!puerto.anularCobroSuelto) {
            // F0 anula solo los vencidos: sin pago, el job lo pasa a anulado al vencer la hora.
            await ctx.enviar(`Listo, no lo pagues. Si no se paga, el cobro de *${s.nombre}* se anula solo al vencer la hora.`,
                'venta_cancelada');
            return true;
        }
        const anulado = await puerto.anularCobroSuelto({ paymentId: d.payment_id, motivo: MOTIVO_ANULACION });
        if (anulado) {
            await ctx.enviar(`Listo, anulé el cobro de *${s.nombre}*. No tienes que pagar nada.`, 'venta_cancelada');
        } else {
            await ctx.escalar('venta_anular_fallo',
                `Entendido, ya no lo quieres. Le pido a la escuela que anule el cobro de *${s.nombre}*; no lo pagues.`);
        }
        return true;
    }

    if (quiereRetomar(texto)) {
        const estado = await puerto.estadoCobro(d.payment_id);
        if (estado === 'paid') return yaPagado(ctx, almacen, s);
        // Sigue vigente: el mismo cobro, link de nuevo (idempotente).
        if (estado === 'pending' || estado === 'overdue') return confirmar(ctx, almacen, d);
        return reCotizar(ctx, almacen, d, s);
    }

    // Cualquier otra cosa (incluida la foto del comprobante, que va por la
    // cola): lo atiende el bot; el flujo queda para que la cola lo encuentre.
    return false;
}

// ─── Comprobante con una venta abierta (lo usa la cola) ─────────────────────

export interface VentaAbierta { paymentId: string; nombre: string | null }

/**
 * ¿Esta conversación tiene una venta esperando el pago? La cola de
 * comprobantes la consulta ANTES de buscar a qué cobro va una foto: si hay
 * una venta abierta, el comprobante es de ESE cobro suelto, nunca de la
 * mensualidad (§5.3). Nunca lanza.
 */
export async function ventaAbiertaDeContacto(
    integrationId: string, contactWaId: string, almacen: AlmacenVenta = almacenVentaSupabase, ahora = new Date(),
): Promise<VentaAbierta | null> {
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id').eq('integration_id', integrationId).eq('contact_wa_id', contactWaId).maybeSingle();
        const convId = (conv as any)?.id;
        if (!convId) return null;
        const f = await almacen.leer(convId);
        if (!f || f.step !== 'venta_esperando_pago' || !f.data?.payment_id) return null;
        if (new Date(f.expires_at).getTime() <= ahora.getTime()) return null;
        return { paymentId: f.data.payment_id, nombre: f.data.servicio?.nombre ?? null };
    } catch {
        return null;
    }
}

export type DecisionComprobanteVenta<P> =
    | { tipo: 'seguir' }
    | { tipo: 'aplicar'; pago: P }
    | { tipo: 'a_la_escuela'; motivo: string; mensaje: string };

/**
 * Qué hacer con un comprobante cuando hay una venta abierta. Pura.
 *  · El cobro de la venta sigue pendiente → se aplica a ESE cobro.
 *  · Ya no está pendiente (pagado por el link, vencido o anulado) → a la
 *    escuela, sin tocar la mensualidad: lo más probable es que la foto sea
 *    del servicio.
 */
export function decidirComprobanteDeVenta<P extends { id: string }>(
    venta: VentaAbierta | null, pendientes: P[],
): DecisionComprobanteVenta<P> {
    if (!venta) return { tipo: 'seguir' };
    const pago = pendientes.find((p) => p.id === venta.paymentId);
    if (pago) return { tipo: 'aplicar', pago };
    const que = venta.nombre ? `*${venta.nombre}*` : 'tu compra';
    return {
        tipo: 'a_la_escuela',
        motivo: `otro_concepto: venta por WhatsApp (${venta.nombre ?? 'servicio'}) sin cobro pendiente`.slice(0, 500),
        mensaje: `Recibí tu comprobante 📄 Parece ser de ${que}, pero ese cobro ya no está pendiente. ` +
            'Se lo paso a la escuela para que lo registre; no lo apliqué a la mensualidad.',
    };
}
