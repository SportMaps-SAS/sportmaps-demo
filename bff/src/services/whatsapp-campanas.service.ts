/**
 * whatsapp-campanas.service — campañas de marketing por escuela con una
 * plantilla de Meta, a la audiencia clasificada del historial (plan B5 T3,
 * docs/specs/whatsapp-monster-plan-B5.md; migración M3 `campanas_whatsapp`).
 *
 * POR QUÉ EXISTE
 *
 * Monster pidió escribirles del regalo de noviembre y de la clínica a quienes
 * le preguntaron por clases en los últimos meses. La cobranza no sirve para
 * eso: `plantillaAprobada` (whatsapp-plantillas.service) corta todo lo que no
 * sea UTILITY, y así debe seguir. Esto es un camino APARTE y el ÚNICO del
 * código que manda MARKETING (`plantillaDeCampana`).
 *
 * TODO DETRÁS DE UN INTERRUPTOR POR ESCUELA
 *
 * Sin fila en `whatsapp_campanas_ajustes` (o con `habilitadas=false`) no corre
 * nada: el cron hace UNA consulta a la tabla de campañas (chica) y termina, y
 * nada lee `whatsapp_messages`. Si la migración no está aplicada, las lecturas
 * fallan y todo vuelve vacío: el comportamiento de hoy.
 *
 * A LO SUMO UNA VEZ
 *
 * `wa_campana_tomar_lote` pasa los envíos a 'enviando' con lease de 10 min. Un
 * envío que se queda en 'enviando' (el proceso murió entre el POST a Meta y el
 * UPDATE) pasa a 'incierto' y NUNCA se reenvía: mandarle dos veces la misma
 * promoción a una familia es peor que perder un envío. Por eso el UPDATE a
 * 'enviado' va ANTES de registrar el saliente en el buzón.
 *
 * Dos bases de consentimiento (la escuela elige al encender, P1 del plan):
 *  - 'optin': solo a quien tiene opt-in vigente en `whatsapp_optins`.
 *  - 'contacto_previo_declarado': a quien le escribió a la escuela pidiendo
 *    información (la audiencia del historial), con la escuela declarando eso
 *    al aprobar. Un mensaje por persona, con «No recibir más».
 */

import { supabase } from '../config/supabase';
import { sendRawPayload, type WhatsAppIntegration } from './whatsapp.service';
import {
    armarPayloadPlantilla, dentroDeHorarioDeCobranza, limpiarParametro, renderizarCuerpo,
    variablesDelCuerpo, ventanaAbierta,
} from './whatsapp-plantillas.service';
import { escuelaActivaEn, HORAS_SILENCIO_ESCUELA } from './whatsapp-modo-discreto';
import { marcaPorNombre } from './whatsapp-tipo-contacto';
import { frenoDeCalidad, MOTIVO_LEGIBLE, type MotivoFreno } from './whatsapp-campanas-freno';
import { adminsDeEscuela } from './plataforma-wa.service';
import { correosDeSoporte, enviarConReserva, uuidDeClave } from './avisos-correo.service';
import { sendToUser } from './push.service';
import type { FilaReciente } from './whatsapp-reglas-turno';

// ─── Ajustes por escuela ─────────────────────────────────────────────────────

export type BaseConsentimiento = 'optin' | 'contacto_previo_declarado';

/** `palabras_sede` de los ajustes: nada de Monster en el código. */
export interface PalabrasDeSede { branch_id: string; palabras: string[] }

export interface AjustesCampanas {
    habilitadas: boolean;
    baseConsentimiento: BaseConsentimiento;
    topeDiarioMax: number;
    lotePiloto: number;
    frecuenciaMinDias: number;
    antiguedadMaxDias: number;
    palabrasSede: PalabrasDeSede[];
    pausadaAt: string | null;
    pausaMotivo: string | null;
}

const COLS_AJUSTES = 'school_id, habilitadas, base_consentimiento, tope_diario_max, lote_piloto, '
    + 'frecuencia_min_dias, antiguedad_max_dias, palabras_sede, pausada_at, pausa_motivo';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entero(v: unknown, min: number, max: number, porDefecto: number): number {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : porDefecto;
}

/** `[{branch_id, palabras:[…]}]` válido; lo demás se descarta. Pura. */
export function palabrasDeSedeValidas(v: unknown): PalabrasDeSede[] {
    if (!Array.isArray(v)) return [];
    return v.flatMap((x: any) => {
        if (!x || typeof x.branch_id !== 'string' || !UUID.test(x.branch_id) || !Array.isArray(x.palabras)) return [];
        const palabras = x.palabras.filter((p: unknown) => typeof p === 'string' && p.trim()).map((p: string) => p.trim());
        return palabras.length ? [{ branch_id: x.branch_id, palabras }] : [];
    });
}

/** Fila cruda → ajustes; null sin fila. Cualquier valor raro cae al default de la migración. Pura. */
export function ajustesCampanasDesdeFila(fila: Record<string, unknown> | null | undefined): AjustesCampanas | null {
    if (!fila) return null;
    return {
        // Estricto: solo `true` prende. Un ajuste a medio escribir no manda marketing.
        habilitadas: fila.habilitadas === true,
        baseConsentimiento: fila.base_consentimiento === 'contacto_previo_declarado' ? 'contacto_previo_declarado' : 'optin',
        topeDiarioMax: entero(fila.tope_diario_max, 1, 100000, 200),
        lotePiloto: entero(fila.lote_piloto, 1, 1000, 50),
        frecuenciaMinDias: entero(fila.frecuencia_min_dias, 1, 90, 7),
        antiguedadMaxDias: entero(fila.antiguedad_max_dias, 1, 365, 180),
        palabrasSede: palabrasDeSedeValidas(fila.palabras_sede),
        pausadaAt: typeof fila.pausada_at === 'string' && fila.pausada_at ? fila.pausada_at : null,
        pausaMotivo: typeof fila.pausa_motivo === 'string' && fila.pausa_motivo ? fila.pausa_motivo : null,
    };
}

/**
 * Lee los ajustes. `disponible=false` = la tabla no existe todavía (M3 sin
 * aplicar) o la lectura falló. Nunca lanza.
 */
export async function leerAjustesCampanas(schoolId: string): Promise<{ disponible: boolean; ajustes: AjustesCampanas | null }> {
    try {
        const { data, error } = await supabase.from('whatsapp_campanas_ajustes')
            .select(COLS_AJUSTES).eq('school_id', schoolId).maybeSingle();
        if (error) return { disponible: false, ajustes: null };
        return { disponible: true, ajustes: ajustesCampanasDesdeFila(data as Record<string, unknown> | null) };
    } catch {
        return { disponible: false, ajustes: null };
    }
}

/** Ajustes o null (sin fila, sin migración o error). Nunca lanza. */
export async function ajustesDeCampanas(schoolId: string): Promise<AjustesCampanas | null> {
    return (await leerAjustesCampanas(schoolId)).ajustes;
}

// ─── Declaración de la escuela (base 'contacto_previo_declarado') ───────────

export const DECLARACION = {
    version: 'contacto_previo_v1',
    texto: (escuela: string, dias: number) =>
        `Declaro que las personas de esta lista le escribieron a ${escuela} por WhatsApp en los últimos ${dias} días `
        + 'pidiendo información de clases, inscripción o eventos, y que no están inscritas. Cada persona recibe un '
        + 'solo mensaje, con la opción «No recibir más», y quien la toque no vuelve a recibir promociones.',
} as const;

/** Lo que queda en `declaracion_version` con la base de opt-in (no hay declaración que aceptar). */
export const VERSION_OPTIN = 'optin_v1';

// ─── Plantilla de campaña (el único camino MARKETING) ───────────────────────

export const PREFIJO_BOTON_CAMPANA = 'smc:';
export const ACCIONES_CAMPANA = ['si', 'luego', 'baja'] as const;
export type AccionCampana = typeof ACCIONES_CAMPANA[number];

/** `smc:<campana_id>:si|luego|baja` — vuelve tal cual en `button.payload` del webhook. */
export function payloadDeBoton(campanaId: string, accion: AccionCampana): string {
    return `${PREFIJO_BOTON_CAMPANA}${campanaId}:${accion}`;
}

/** Textos de los QUICK_REPLY de la plantilla, en orden. */
export function botonesRapidos(components: any[] | null | undefined): string[] {
    const b = (components ?? []).find((c: any) => String(c?.type).toUpperCase() === 'BUTTONS');
    return (b?.buttons ?? [])
        .filter((x: any) => String(x?.type).toUpperCase() === 'QUICK_REPLY')
        .map((x: any) => String(x?.text ?? ''));
}

/** ¿El texto del botón es el de la baja? El payload `:baja` va SIEMPRE al tercer botón. */
export const TEXTO_DE_BAJA = /no (recibir|quiero recibir|me (escriban|envien))|dejar de recibir|^baja\b|^no mas\b/i;

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();

export type MotivoPlantillaCampana =
    | 'plantilla_no_aprobada' | 'no_es_marketing' | 'otra_waba' | 'botones_no_cuadran' | 'variables_no_cuadran';

export type PlantillaCampana =
    | { ok: true; nombre: string; idioma: string; components: any[]; variables: number }
    | { ok: false; motivo: MotivoPlantillaCampana; detalle: string; estado: string | null };

/**
 * ¿La fila de `whatsapp_template_status` sirve para una campaña? Pura.
 *
 * APPROVED + MARKETING + la WABA actual + exactamente 3 QUICK_REPLY con la
 * baja de tercera + a lo sumo una variable ({{1}} = nombre) + sin encabezado
 * con datos. Si los botones no cuadran, el «No recibir más» podría quedar con
 * el payload del «Sí»: se rechaza.
 */
export function validarPlantillaDeCampana(fila: any, wabaId: string | null): PlantillaCampana {
    const nombre = String(fila?.name ?? '');
    const estado = (fila?.status ?? null) as string | null;
    if (!fila || estado !== 'APPROVED') {
        return { ok: false, motivo: 'plantilla_no_aprobada', detalle: `${nombre || 'plantilla'}: ${estado ?? 'sin sincronizar'}`, estado };
    }
    if (!wabaId || fila.waba_id !== wabaId) {
        return { ok: false, motivo: 'otra_waba', detalle: `${nombre}: registrada en otra WABA`, estado };
    }
    if (String(fila.category ?? '').toUpperCase() !== 'MARKETING') {
        return { ok: false, motivo: 'no_es_marketing', detalle: `${nombre}: ${fila.category ?? 'sin categoría'}`, estado };
    }
    const components: any[] = Array.isArray(fila.components) ? fila.components : [];
    const botones = botonesRapidos(components);
    const otrosBotones = ((components.find((c: any) => String(c?.type).toUpperCase() === 'BUTTONS')?.buttons ?? []) as any[])
        .some((x) => String(x?.type).toUpperCase() !== 'QUICK_REPLY');
    if (botones.length !== 3 || otrosBotones || !TEXTO_DE_BAJA.test(plano(botones[2]))) {
        return { ok: false, motivo: 'botones_no_cuadran', detalle: `${nombre}: se esperan 3 botones rápidos con la baja de tercera`, estado };
    }
    const encabezado = components.find((c: any) => String(c?.type).toUpperCase() === 'HEADER');
    if (encabezado && (String(encabezado.format ?? 'TEXT').toUpperCase() !== 'TEXT' || /\{\{\d+\}\}/.test(String(encabezado.text ?? '')))) {
        return { ok: false, motivo: 'variables_no_cuadran', detalle: `${nombre}: el encabezado lleva datos`, estado };
    }
    const variables = variablesDelCuerpo(components);
    if (variables > 1) {
        return { ok: false, motivo: 'variables_no_cuadran', detalle: `${nombre}: ${variables} variables (solo {{1}} = nombre)`, estado };
    }
    return { ok: true, nombre, idioma: String(fila.language ?? 'es_CO'), components, variables };
}

/** Lee la fila de la plantilla y la valida. Nunca lanza. */
export async function plantillaDeCampana(
    integ: { id: string; waba_id: string | null }, nombre: string, idioma: string,
): Promise<PlantillaCampana> {
    try {
        const { data, error } = await supabase.from('whatsapp_template_status')
            .select('name, language, category, status, components, waba_id')
            .eq('integration_id', integ.id).eq('name', nombre).eq('language', idioma)
            .maybeSingle();
        if (error) return { ok: false, motivo: 'plantilla_no_aprobada', detalle: error.message, estado: null };
        return validarPlantillaDeCampana(data, integ.waba_id);
    } catch (err: any) {
        return { ok: false, motivo: 'plantilla_no_aprobada', detalle: err?.message || 'error', estado: null };
    }
}

/** Palabras que Meta trae como «nombre» y no lo son. */
const NO_SON_NOMBRES = new Set([
    'mama', 'mami', 'papa', 'papi', 'sr', 'sra', 'senor', 'senora', 'don', 'dona', 'dr', 'dra', 'doctor', 'doctora',
    'ing', 'lic', 'prof', 'profe', 'profesor', 'profesora', 'familia', 'hola', 'la', 'el', 'los', 'las', 'de', 'mi',
    'tu', 'su', 'yo', 'hijo', 'hija', 'abuela', 'abuelo', 'abue', 'tia', 'tio', 'amor', 'bebe', 'nn',
]);

/**
 * `{{1}}` de la campaña: el primer nombre limpio del perfil de WhatsApp, o
 * «familia» (P3 del plan). Nunca un negocio, un emoji, un número ni «Mamá».
 * Pura.
 */
export function primerNombre(contactName: string | null | undefined): string {
    const crudo = String(contactName ?? '').normalize('NFC').trim();
    if (!crudo || marcaPorNombre(crudo)) return 'familia';
    const palabra = (crudo.split(/\s+/)[0] ?? '').replace(/[^\p{L}'-]/gu, '').replace(/^['-]+|['-]+$/g, '');
    if (palabra.length < 2 || palabra.length > 20) return 'familia';
    if (NO_SON_NOMBRES.has(plano(palabra))) return 'familia';
    return palabra.charAt(0).toLocaleUpperCase('es') + palabra.slice(1).toLocaleLowerCase('es');
}

/** Las variables de la plantilla para este contacto. Pura. */
export function variablesDeCampana(cantidad: number, contactName: string | null | undefined): string[] {
    return cantidad === 1 ? [limpiarParametro(primerNombre(contactName))] : [];
}

/**
 * Payload `type: template` de una campaña: el de la cobranza (sin botón URL)
 * más los 3 QUICK_REPLY con `smc:<campana_id>:si|luego|baja` en el orden de
 * la plantilla. Pura.
 */
export function armarPayloadCampana(p: {
    toWaId: string; plantilla: string; idioma: string; variables: string[]; campanaId: string;
}): any {
    const payload = armarPayloadPlantilla({
        toWaId: p.toWaId, plantilla: p.plantilla, idioma: p.idioma, variables: p.variables, tokenBoton: null,
    });
    // Sin variables no va el componente body (Meta no espera parámetros).
    const components: any[] = p.variables.length ? payload.template.components : [];
    ACCIONES_CAMPANA.forEach((accion, index) => {
        components.push({
            type: 'button', sub_type: 'quick_reply', index: String(index),
            parameters: [{ type: 'payload', payload: payloadDeBoton(p.campanaId, accion) }],
        });
    });
    payload.template.components = components;
    return payload;
}

// ─── Cupo y horario ──────────────────────────────────────────────────────────

/** Sin evento de Meta todavía, el tope más bajo de un número nuevo con Coexistence. */
export const LIMITE_META_POR_DEFECTO = 250;
/** Cada cuánto corre el cron (lo registra Integración en maintenance.job). */
export const MINUTOS_POR_TICK = 10;

/** 'TIER_250' → 250, 'TIER_1K' → 1000, 'TIER_UNLIMITED' → 1 000 000. Pura. */
export function limiteDeTier(tier: string | null | undefined): number | null {
    const t = String(tier ?? '').toUpperCase().trim();
    if (t === 'TIER_UNLIMITED' || t === 'UNLIMITED') return 1_000_000;
    const m = t.match(/^TIER_(\d+)(K)?$/);
    if (!m) return null;
    return Number(m[1]) * (m[2] ? 1000 : 1);
}

/** Inicio del día de hoy en Bogotá (UTC-5, sin horario de verano), como instante. */
export function inicioDelDiaCot(ahora: Date): Date {
    const cot = new Date(ahora.getTime() - 5 * 3600_000);
    return new Date(Date.UTC(cot.getUTCFullYear(), cot.getUTCMonth(), cot.getUTCDate()) + 5 * 3600_000);
}

/**
 * Ticks que le quedan al día dentro del horario de `dentroDeHorarioDeCobranza`
 * (L-V hasta las 19:00, sábado hasta las 15:00), contando el actual. 0 fuera
 * de horario (domingo, festivo, de noche). Pura.
 */
export function ticksRestantesDelDia(ahora: Date, cadaMin = MINUTOS_POR_TICK): number {
    if (!dentroDeHorarioDeCobranza(ahora)) return 0;
    const cot = new Date(ahora.getTime() - 5 * 3600_000);
    const minutos = cot.getUTCHours() * 60 + cot.getUTCMinutes();
    const fin = cot.getUTCDay() === 6 ? 15 * 60 : 19 * 60;
    return Math.max(1, Math.ceil((fin - minutos) / cadaMin));
}

/**
 * Cuántos envíos toma ESTE tick. Pura.
 *
 * Lo que queda del día (tope de la escuela; el primer día de la campaña,
 * además, el lote piloto) y del límite de Meta, repartido entre los ticks que
 * quedan: no 200 a las 7:00 en punto, que es como se ve un envío masivo.
 */
export function cupoDelTick(p: {
    topeDiario: number;
    lotePiloto: number;
    primerDia: boolean;
    enviadosHoyEscuela: number;
    enviadosHoyCampana: number;
    limiteMeta: number;
    /** Destinatarios de plantillas en las últimas 24 h (la RPC también lo descuenta). */
    usadosMeta?: number;
    ticksRestantes: number;
}): number {
    if (p.ticksRestantes <= 0) return 0;
    let restante = Math.max(0, p.topeDiario - p.enviadosHoyEscuela);
    if (p.primerDia) restante = Math.min(restante, Math.max(0, p.lotePiloto - p.enviadosHoyCampana));
    restante = Math.min(restante, Math.max(0, p.limiteMeta - (p.usadosMeta ?? 0)));
    if (restante === 0) return 0;
    return Math.min(restante, Math.ceil(restante / p.ticksRestantes));
}

// ─── Reintentos y conciliación (puras) ───────────────────────────────────────

/** Esperas tras un error de Graph al enviar: 5 min, 30 min, 2 h. Al tercero, 'fallido'. */
export const ESPERAS_REINTENTO_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000];
export const MAX_INTENTOS = 3;

/** 131050: la persona apagó el marketing de esta empresa en WhatsApp. */
export const ERROR_NO_QUIERE_MARKETING = /131050|stopped receiving marketing|chosen to stop receiving|stop receiving marketing/i;
/** 131049: Meta frena el marketing a ese usuario («healthy ecosystem engagement»). No es error nuestro. */
export const ERROR_TOPE_DE_META = /131049|healthy ecosystem|ecosystem engagement/i;

export type DestinoEnvio =
    | { estado: 'pendiente'; proximoIntentoAt: string; motivo: string }
    | { estado: 'fallido'; motivo: string }
    | { estado: 'baja'; motivo: string };

/**
 * Graph rechazó el envío (respuesta HTTP de error). `intentos` es el valor que
 * ya dejó la RPC al tomar el lote (incluye este intento). Pura.
 */
export function destinoTrasErrorDeEnvio(intentos: number, detalle: string | null | undefined, ahora: number): DestinoEnvio {
    const d = String(detalle ?? 'error_graph').slice(0, 300);
    if (ERROR_NO_QUIERE_MARKETING.test(d)) return { estado: 'baja', motivo: 'meta_131050' };
    if (intentos >= MAX_INTENTOS) return { estado: 'fallido', motivo: d };
    const espera = ESPERAS_REINTENTO_MS[Math.max(0, intentos - 1)] ?? ESPERAS_REINTENTO_MS[ESPERAS_REINTENTO_MS.length - 1];
    return { estado: 'pendiente', proximoIntentoAt: new Date(ahora + espera).toISOString(), motivo: d };
}

/**
 * El envío salió pero Meta avisó después que no se entregó (estado 'failed'
 * que escribe `procesarEstados` en whatsapp_messages). Pura.
 *  - 131050 → baja (y el contacto sale de la audiencia).
 *  - 131049 → UN reintento a las 24 h.
 *  - otro → 'fallido'.
 * Los códigos están por confirmar contra la tabla de errores de Meta: el
 * webhook guarda el título del error, no siempre el número.
 */
export function destinoTrasFalloAsincrono(intentos: number, detalle: string | null | undefined, ahora: number): DestinoEnvio {
    const d = String(detalle ?? 'failed').slice(0, 300);
    if (ERROR_NO_QUIERE_MARKETING.test(d)) return { estado: 'baja', motivo: 'meta_131050' };
    if (ERROR_TOPE_DE_META.test(d) && intentos < 2) {
        return { estado: 'pendiente', proximoIntentoAt: new Date(ahora + 24 * 3600_000).toISOString(), motivo: 'meta_131049' };
    }
    return { estado: 'fallido', motivo: d };
}

/** ¿El envío quedó tomado y su lease venció? Pasa a 'incierto' y no se reenvía. Pura. */
export function leaseVencido(envio: { estado: string; lease_hasta?: string | null }, ahora: number): boolean {
    if (envio.estado !== 'enviando' || !envio.lease_hasta) return false;
    return new Date(envio.lease_hasta).getTime() < ahora;
}

/**
 * ¿Se pospone 24 h? A quien tiene la ventana abierta (está hablando con la
 * escuela) o a quien una persona de la escuela le escribió en las últimas 12 h,
 * la promoción le llega encima de la charla. Pura.
 */
export function motivoParaPosponer(p: {
    ultimoEntrante: string | null | undefined;
    recientes: readonly FilaReciente[];
    ahora: number;
}): 'ventana_abierta' | 'escuela_escribio' | null {
    if (ventanaAbierta(p.ultimoEntrante ?? null, p.ahora)) return 'ventana_abierta';
    if (escuelaActivaEn(p.recientes, p.ahora)) return 'escuela_escribio';
    return null;
}

// ─── Filas ───────────────────────────────────────────────────────────────────

export type EstadoCampana = 'borrador' | 'aprobada' | 'enviando' | 'pausada' | 'terminada' | 'cancelada';
export type EstadoEnvio = 'pendiente' | 'enviando' | 'enviado' | 'incierto' | 'fallido' | 'omitido'
    | 'respondio_si' | 'respondio_luego' | 'baja';
export const ESTADOS_ENVIO: readonly EstadoEnvio[] = ['pendiente', 'enviando', 'enviado', 'incierto', 'fallido',
    'omitido', 'respondio_si', 'respondio_luego', 'baja'];

export const INTERESES_AUDIENCIA = ['clase_prueba', 'inscripcion', 'clinica', 'precio', 'horarios', 'informacion'] as const;
export type InteresAudiencia = typeof INTERESES_AUDIENCIA[number];

export interface FiltroCampana { intereses?: string[]; branch_ids?: string[] }

export interface CampanaFila {
    id: string;
    integration_id: string;
    school_id: string;
    nombre: string;
    plantilla: string;
    idioma: string;
    filtro: FiltroCampana | null;
    variables: string[] | null;
    respuesta_si: string | null;
    estado: EstadoCampana;
    destinatarios: number | null;
    aprobada_at: string | null;
    vence_at: string | null;
    pausa_motivo: string | null;
    declaracion_version?: string | null;
    created_at?: string;
}

export const COLS_CAMPANA = 'id, integration_id, school_id, nombre, plantilla, idioma, filtro, variables, respuesta_si, '
    + 'estado, destinatarios, aprobada_at, vence_at, pausa_motivo, declaracion_version, created_at';

interface EnvioFila {
    id: string;
    campana_id: string;
    integration_id: string;
    school_id: string;
    contact_wa_id: string;
    estado: EstadoEnvio;
    intentos: number;
    wa_message_id?: string | null;
    lease_hasta?: string | null;
}

const COLS_INTEG = 'id, school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted, status';

async function integracionPorId(id: string): Promise<WhatsAppIntegration | null> {
    const { data } = await supabase.from('school_whatsapp_integrations').select(COLS_INTEG).eq('id', id).maybeSingle();
    return data ? ({ verify_token: null, ...(data as any) } as WhatsAppIntegration) : null;
}

/** La integración activa de la escuela (una sola: si hay dos, no se adivina). */
export async function integracionActivaDeEscuela(schoolId: string): Promise<WhatsAppIntegration | 'sin_integracion' | 'integracion_ambigua'> {
    const { data } = await supabase.from('school_whatsapp_integrations').select(COLS_INTEG)
        .eq('school_id', schoolId).eq('status', 'active');
    const activas = ((data as any[]) ?? []).filter((i) => i.waba_id && i.access_token_encrypted);
    if (activas.length === 0) return 'sin_integracion';
    if (activas.length > 1) return 'integracion_ambigua';
    return { verify_token: null, ...activas[0] } as WhatsAppIntegration;
}

async function contar(consulta: PromiseLike<{ count: number | null; error: any }>): Promise<number> {
    try {
        const { count, error } = await consulta;
        return error ? 0 : Number(count ?? 0);
    } catch {
        return 0;
    }
}

/** El último límite de envío que Meta informó para el número (`current_limit`). */
export async function limiteMetaDeIntegracion(integrationId: string): Promise<number> {
    try {
        const { data } = await supabase.from('whatsapp_account_events')
            .select('nuevo_estado, payload, created_at')
            .eq('integration_id', integrationId).eq('field', 'phone_number_quality_update')
            .order('created_at', { ascending: false }).limit(1);
        const ev = (data as any[] | null)?.[0];
        return limiteDeTier(ev?.payload?.value?.current_limit ?? ev?.nuevo_estado) ?? LIMITE_META_POR_DEFECTO;
    } catch {
        return LIMITE_META_POR_DEFECTO;
    }
}

// ─── Avisos a la escuela ─────────────────────────────────────────────────────

/**
 * Notificación in-app (+ push) a owner y admins. Id determinístico por
 * `clave`: tres BFF o dos ticks no duplican el aviso. Nunca lanza.
 */
export async function avisarAdministracion(p: {
    schoolId: string; clave: string; titulo: string; mensaje: string; link: string;
    tipo?: 'info' | 'warning'; data?: Record<string, string>; push?: boolean;
}): Promise<number> {
    let avisados = 0;
    try {
        const ids = [...await adminsDeEscuela(p.schoolId)];
        await Promise.allSettled(ids.map(async (uid) => {
            const { error } = await supabase.from('notifications').insert({
                id: uuidDeClave(`${p.clave}:${uid}`),
                user_id: uid,
                school_id: p.schoolId,
                title: p.titulo,
                message: p.mensaje,
                type: p.tipo ?? 'info',
                // El CHECK de `notifications.category` no tiene 'whatsapp' (igual que las escalaciones).
                category: 'support',
                link: p.link,
                data: { ...(p.data ?? {}), school_id: p.schoolId },
            });
            if (error) return; // 23505: ya avisado.
            avisados++;
            if (p.push !== false) {
                await sendToUser(uid, { title: p.titulo, body: p.mensaje, data: { ...(p.data ?? {}), school_id: p.schoolId } })
                    .catch(() => undefined);
            }
        }));
    } catch { /* el aviso no tumba nada */ }
    return avisados;
}

/**
 * Freno: pausa la escuela (todas sus campañas) y avisa. Reanudar es a mano.
 * Nunca lanza.
 */
export async function pausarPorFreno(p: {
    campana: Pick<CampanaFila, 'id' | 'school_id' | 'nombre'>; motivo: MotivoFreno; detalle: string; ahora: Date;
}): Promise<void> {
    const ahoraIso = p.ahora.toISOString();
    try {
        await supabase.from('whatsapp_campanas_ajustes')
            .update({ pausada_at: ahoraIso, pausa_motivo: p.motivo, updated_at: ahoraIso })
            .eq('school_id', p.campana.school_id);
        await supabase.from('whatsapp_campanas')
            .update({ estado: 'pausada', pausa_motivo: p.motivo, updated_at: ahoraIso })
            .eq('school_id', p.campana.school_id).in('estado', ['aprobada', 'enviando']);
    } catch (err: any) {
        console.error('[campanas] no se pudo pausar', { campanaId: p.campana.id, err: err?.message });
    }
    const legible = MOTIVO_LEGIBLE[p.motivo];
    const fecha = ahoraIso.slice(0, 10);
    await avisarAdministracion({
        schoolId: p.campana.school_id,
        clave: `wa_campana_freno:${p.campana.id}:${p.motivo}:${fecha}`,
        titulo: 'Pausamos tu campaña de WhatsApp',
        mensaje: `«${p.campana.nombre}» quedó en pausa porque ${legible}. Así cuidamos tu número. `
            + 'Revísala en WhatsApp › Campañas y reanúdala cuando quieras.',
        link: '/whatsapp?tab=campanas',
        tipo: 'warning',
        data: { tipo: 'whatsapp_campana_pausada', campana_id: p.campana.id },
    });
    void enviarConReserva({
        clave: `wa_campana_freno:${p.campana.id}:${p.motivo}:${fecha}`,
        tipo: 'wa_campana_freno', schoolId: p.campana.school_id, refId: p.campana.id,
        destinos: correosDeSoporte(), data: {}, plantilla: null,
        respaldo: {
            subject: `[WhatsApp] Campaña pausada por el freno: ${p.campana.nombre}`,
            titulo: 'Campaña de WhatsApp pausada',
            lineas: [
                `Escuela: ${p.campana.school_id}`,
                `Campaña: ${p.campana.nombre} (${p.campana.id})`,
                `Motivo: ${legible} (${p.motivo})`,
                `Detalle: ${p.detalle}`,
                'Se reanuda a mano desde WhatsApp › Campañas o con scripts/wa-campana.ts.',
            ],
        },
    }).catch(() => undefined);
}

// ─── El cron ─────────────────────────────────────────────────────────────────

/** ≤ 20 mensajes por segundo (Meta admite 80; el número es el de diario). */
const PAUSA_ENTRE_ENVIOS_MS = process.env.VITEST ? 0 : 60;
const dormir = (ms: number) => (ms > 0 ? new Promise((ok) => setTimeout(ok, ms)) : Promise.resolve());

export interface ResultadoCampanas {
    campanas: number;
    enviados: number;
    pospuestos: number;
    omitidos: number;
    reintentos: number;
    fallidos: number;
    conciliados: number;
    pausadas: number;
    terminadas: number;
    saltadas: Record<string, number>;
}

function resultadoVacio(): ResultadoCampanas {
    return { campanas: 0, enviados: 0, pospuestos: 0, omitidos: 0, reintentos: 0, fallidos: 0, conciliados: 0,
        pausadas: 0, terminadas: 0, saltadas: {} };
}

const saltar = (r: ResultadoCampanas, motivo: string) => { r.saltadas[motivo] = (r.saltadas[motivo] ?? 0) + 1; };

/**
 * Un tick de todas las campañas en curso. Lo registra Integración en
 * `jobs/maintenance.job.ts` cada 10 min bajo `DISABLE_WHATSAPP_QUEUE_CRON`.
 *
 * Sin campañas 'aprobada'|'enviando' (todas las escuelas hoy) es UNA consulta
 * a una tabla chica y nada más. Nunca lanza.
 */
export async function runCampanas(ahora: Date = new Date()): Promise<ResultadoCampanas> {
    const r = resultadoVacio();
    let campanas: CampanaFila[] = [];
    try {
        const { data, error } = await supabase.from('whatsapp_campanas').select(COLS_CAMPANA)
            .in('estado', ['aprobada', 'enviando'])
            .order('aprobada_at', { ascending: true })
            .limit(50);
        if (error || !Array.isArray(data) || data.length === 0) return r;
        campanas = data as unknown as CampanaFila[];
    } catch {
        return r;
    }

    const ctx = { calidadCache: new Map<string, string | null>(), ajustes: new Map<string, AjustesCampanas | null>() };
    for (const c of campanas) {
        r.campanas++;
        try {
            await tickDeCampana(c, ahora, r, ctx);
        } catch (err: any) {
            console.error('[campanas] el tick de la campaña falló', { campanaId: c.id, err: err?.message || err });
        }
    }
    return r;
}

async function tickDeCampana(
    c: CampanaFila,
    ahora: Date,
    r: ResultadoCampanas,
    ctx: { calidadCache: Map<string, string | null>; ajustes: Map<string, AjustesCampanas | null> },
): Promise<void> {
    const ahoraMs = ahora.getTime();
    const ahoraIso = ahora.toISOString();

    // 1. Interruptor de la escuela (sin fila = apagado) y pausa del freno.
    if (!ctx.ajustes.has(c.school_id)) ctx.ajustes.set(c.school_id, await ajustesDeCampanas(c.school_id));
    const ajustes = ctx.ajustes.get(c.school_id) ?? null;
    if (!ajustes?.habilitadas) return saltar(r, 'apagadas');
    if (ajustes.pausadaAt) {
        await supabase.from('whatsapp_campanas')
            .update({ estado: 'pausada', pausa_motivo: ajustes.pausaMotivo ?? 'escuela_en_pausa', updated_at: ahoraIso })
            .eq('id', c.id);
        r.pausadas++;
        return;
    }

    // 2. Vencida (las fechas del texto ya pasaron): se cierra sin mandar más.
    if (c.vence_at && new Date(c.vence_at).getTime() <= ahoraMs) {
        await supabase.from('whatsapp_campanas').update({ estado: 'terminada', updated_at: ahoraIso }).eq('id', c.id);
        await supabase.from('whatsapp_campana_envios')
            .update({ estado: 'omitido', motivo: 'campana_vencida', updated_at: ahoraIso })
            .eq('campana_id', c.id).eq('estado', 'pendiente');
        r.terminadas++;
        return;
    }

    // 3. Horario «Ley 2300» del código (D11 abierta): ni domingos ni festivos.
    if (!dentroDeHorarioDeCobranza(ahora)) return saltar(r, 'fuera_de_horario');

    // 4. Integración y plantilla.
    const integ = await integracionPorId(c.integration_id);
    if (!integ || integ.status !== 'active' || !integ.access_token_encrypted) {
        await supabase.from('whatsapp_campanas')
            .update({ estado: 'pausada', pausa_motivo: 'sin_integracion', updated_at: ahoraIso }).eq('id', c.id);
        r.pausadas++;
        return;
    }
    const plantilla = await plantillaDeCampana(integ, c.plantilla, c.idioma);
    if (!plantilla.ok) {
        if (plantilla.motivo === 'plantilla_no_aprobada' && plantilla.estado) {
            // Meta la pausó o la desactivó: señal de calidad, frena la escuela.
            await pausarPorFreno({ campana: c, motivo: 'plantilla_no_aprobada', detalle: plantilla.detalle, ahora });
        } else {
            await supabase.from('whatsapp_campanas')
                .update({ estado: 'pausada', pausa_motivo: plantilla.motivo, updated_at: ahoraIso }).eq('id', c.id);
        }
        r.pausadas++;
        return;
    }

    // 5. Freno de calidad.
    const freno = await frenoDeCalidad({
        integ, plantilla: { nombre: c.plantilla, estado: 'APPROVED' }, aprobadaAt: c.aprobada_at, ahora: ahoraMs,
        calidadCache: ctx.calidadCache,
    });
    if (freno.frenar) {
        await pausarPorFreno({ campana: c, motivo: freno.motivo, detalle: freno.detalle, ahora });
        ctx.ajustes.set(c.school_id, { ...ajustes, pausadaAt: ahoraIso, pausaMotivo: freno.motivo });
        r.pausadas++;
        return;
    }

    // 6. Lo que quedó tomado y venció: 'incierto' (no se reenvía nunca).
    await supabase.from('whatsapp_campana_envios')
        .update({ estado: 'incierto', motivo: 'lease_vencido', lease_hasta: null, updated_at: ahoraIso })
        .eq('campana_id', c.id).eq('estado', 'enviando').lt('lease_hasta', ahoraIso);

    // 7. Lo que Meta rechazó después de aceptar (131050, 131049…).
    r.conciliados += await conciliarFallosAsincronos(c, ahoraMs);

    // 8. Cupo del tick.
    const inicioHoy = inicioDelDiaCot(ahora).toISOString();
    const [enviadosHoyEscuela, enviadosHoyCampana, enviadosAntes, limiteMeta] = await Promise.all([
        contar(supabase.from('whatsapp_campana_envios').select('id', { count: 'exact', head: true })
            .eq('school_id', c.school_id).gte('enviado_at', inicioHoy)),
        contar(supabase.from('whatsapp_campana_envios').select('id', { count: 'exact', head: true })
            .eq('campana_id', c.id).gte('enviado_at', inicioHoy)),
        contar(supabase.from('whatsapp_campana_envios').select('id', { count: 'exact', head: true })
            .eq('campana_id', c.id).lt('enviado_at', inicioHoy)),
        limiteMetaDeIntegracion(integ.id),
    ]);
    const cupo = cupoDelTick({
        topeDiario: ajustes.topeDiarioMax, lotePiloto: ajustes.lotePiloto, primerDia: enviadosAntes === 0,
        enviadosHoyEscuela, enviadosHoyCampana, limiteMeta, ticksRestantes: ticksRestantesDelDia(ahora),
    });
    if (cupo <= 0) return saltar(r, 'sin_cupo');

    // 9. Lote (a lo sumo una vez: lease, SKIP LOCKED, omitidos adentro).
    const { data: tomados, error: errLote } = await supabase.rpc('wa_campana_tomar_lote', {
        p_campana_id: c.id, p_max: cupo, p_limite_meta: limiteMeta,
    });
    if (errLote) {
        console.error('[campanas] wa_campana_tomar_lote falló', { campanaId: c.id, err: errLote.message });
        return saltar(r, 'error_lote');
    }
    const lote = ((tomados as EnvioFila[] | null) ?? []).filter((e) => e && e.id && e.contact_wa_id);
    // aprobada → enviando lo hace la RPC bajo su candado (M3): repetirlo aquí con el
    // estado leído al inicio del tick despausaba una campaña pausada a mitad del tick.
    if (lote.length) await enviarLote(c, integ, ajustes, plantilla, lote, ahoraMs, r);

    // 10. ¿Terminó? Sin pendientes ni tomados.
    const quedan = await contar(supabase.from('whatsapp_campana_envios').select('id', { count: 'exact', head: true })
        .eq('campana_id', c.id).in('estado', ['pendiente', 'enviando']));
    if (quedan === 0) {
        // Solo desde aprobada/enviando: nunca encima de una pausa o una cancelación.
        await supabase.from('whatsapp_campanas').update({ estado: 'terminada', updated_at: ahoraIso })
            .eq('id', c.id).in('estado', ['aprobada', 'enviando']);
        r.terminadas++;
    }
}

async function enviarLote(
    c: CampanaFila,
    integ: WhatsAppIntegration,
    ajustes: AjustesCampanas,
    plantilla: Extract<PlantillaCampana, { ok: true }>,
    lote: EnvioFila[],
    ahoraMs: number,
    r: ResultadoCampanas,
): Promise<void> {
    const ids = lote.map((e) => e.contact_wa_id);

    // Tres lecturas por lote, no tres por envío: conversación, mensajes de las
    // últimas 12 h y consentimiento.
    const [{ data: convs }, { data: optins }] = await Promise.all([
        supabase.from('whatsapp_conversations').select('id, contact_wa_id, contact_name, last_inbound_at')
            .eq('integration_id', integ.id).in('contact_wa_id', ids),
        supabase.from('whatsapp_optins').select('contact_wa_id, opted_in_at, opted_out_at')
            .eq('integration_id', integ.id).in('contact_wa_id', ids),
    ]);
    const convPorWa = new Map(((convs as any[]) ?? []).map((x) => [String(x.contact_wa_id), x]));
    const optinPorWa = new Map(((optins as any[]) ?? []).map((x) => [String(x.contact_wa_id), x]));
    const convIds = [...convPorWa.values()].map((x) => x.id).filter(Boolean);
    const recientesPorConv = new Map<string, FilaReciente[]>();
    if (convIds.length) {
        const { data: recientes } = await supabase.from('whatsapp_messages')
            .select('conversation_id, direction, type, ai_generated, payload, wa_timestamp, created_at')
            .in('conversation_id', convIds)
            .gte('created_at', new Date(ahoraMs - HORAS_SILENCIO_ESCUELA * 3600_000 - 60_000).toISOString())
            .limit(5000);
        for (const m of (recientes as any[]) ?? []) {
            const lista = recientesPorConv.get(m.conversation_id) ?? [];
            lista.push(m as FilaReciente);
            recientesPorConv.set(m.conversation_id, lista);
        }
    }

    for (const envio of lote) {
        const conv = convPorWa.get(envio.contact_wa_id);
        const optin = optinPorWa.get(envio.contact_wa_id);
        const ahoraIso = new Date(ahoraMs).toISOString();

        // Defensa en profundidad (la RPC ya los omite): nunca marketing a quien
        // pidió la baja, ni sin opt-in cuando la base es 'optin'.
        const dadoDeBaja = Boolean(optin?.opted_out_at)
            && (!optin?.opted_in_at || new Date(optin.opted_out_at) >= new Date(optin.opted_in_at));
        const conOptin = Boolean(optin?.opted_in_at) && !dadoDeBaja;
        if (dadoDeBaja || (ajustes.baseConsentimiento === 'optin' && !conOptin)) {
            await supabase.from('whatsapp_campana_envios')
                .update({ estado: 'omitido', motivo: dadoDeBaja ? 'baja' : 'sin_optin', lease_hasta: null, updated_at: ahoraIso })
                .eq('id', envio.id);
            r.omitidos++;
            continue;
        }

        const posponer = motivoParaPosponer({
            ultimoEntrante: conv?.last_inbound_at, recientes: conv ? (recientesPorConv.get(conv.id) ?? []) : [], ahora: ahoraMs,
        });
        if (posponer) {
            await supabase.from('whatsapp_campana_envios').update({
                estado: 'pendiente', motivo: posponer, lease_hasta: null,
                // Posponer no gasta un intento: lo devuelve.
                intentos: Math.max(0, Number(envio.intentos ?? 1) - 1),
                proximo_intento_at: new Date(ahoraMs + 24 * 3600_000).toISOString(),
                updated_at: ahoraIso,
            }).eq('id', envio.id);
            r.pospuestos++;
            continue;
        }

        const variables = variablesDeCampana(plantilla.variables, conv?.contact_name ?? null);
        const payload = armarPayloadCampana({
            toWaId: envio.contact_wa_id, plantilla: plantilla.nombre, idioma: plantilla.idioma, variables, campanaId: c.id,
        });
        const envioMeta = await sendRawPayload(integ, payload);

        if (envioMeta.ok) {
            // 'enviado' ANTES del buzón: si lo que sigue falla, no se reenvía.
            await supabase.from('whatsapp_campana_envios').update({
                estado: 'enviado', wa_message_id: envioMeta.waMessageId ?? null, enviado_at: ahoraIso,
                lease_hasta: null, motivo: null, updated_at: ahoraIso,
            }).eq('id', envio.id);
            r.enviados++;
            await registrarSalienteDeCampana({
                integ, conversationId: conv?.id ?? null, toWaId: envio.contact_wa_id,
                waMessageId: envioMeta.waMessageId ?? null,
                texto: renderizarCuerpo(plantilla.components, variables),
                payload: { step: 'campana', campana_id: c.id, envio_id: envio.id, plantilla: plantilla.nombre, variables },
            }).catch(() => undefined);
        } else {
            const destino = destinoTrasErrorDeEnvio(Number(envio.intentos ?? 1), envioMeta.error, ahoraMs);
            await aplicarDestino(c, envio, destino, ahoraMs);
            if (destino.estado === 'pendiente') r.reintentos++;
            else r.fallidos++;
        }
        await dormir(PAUSA_ENTRE_ENVIOS_MS);
    }
}

async function aplicarDestino(
    c: Pick<CampanaFila, 'id' | 'integration_id'>, envio: Pick<EnvioFila, 'id' | 'contact_wa_id'>, d: DestinoEnvio, ahoraMs: number,
): Promise<void> {
    const ahoraIso = new Date(ahoraMs).toISOString();
    await supabase.from('whatsapp_campana_envios').update({
        estado: d.estado, motivo: d.motivo, lease_hasta: null,
        ...(d.estado === 'pendiente' ? { proximo_intento_at: d.proximoIntentoAt, wa_message_id: null } : {}),
        updated_at: ahoraIso,
    }).eq('id', envio.id);
    // Quien apagó el marketing en WhatsApp sale de la audiencia de la escuela.
    if (d.estado === 'baja') {
        await supabase.from('whatsapp_audiencia').update({ excluido: 'baja' })
            .eq('integration_id', c.integration_id).eq('contact_wa_id', envio.contact_wa_id);
    }
}

/**
 * Concilia los salientes de la campaña que Meta marcó 'failed' después de
 * aceptarlos (los escribe `procesarEstados` en routes/whatsapp.ts). Una sola
 * consulta: solo los fallidos de las últimas 72 h de ESTA campaña.
 */
async function conciliarFallosAsincronos(c: CampanaFila, ahoraMs: number): Promise<number> {
    try {
        const { data: fallidos, error } = await supabase.from('whatsapp_messages')
            .select('wa_message_id, error_detail')
            .eq('integration_id', c.integration_id)
            .eq('status', 'failed')
            .eq('payload->>campana_id', c.id)
            .gte('created_at', new Date(ahoraMs - 72 * 3600_000).toISOString())
            .limit(500);
        if (error || !Array.isArray(fallidos) || fallidos.length === 0) return 0;
        const detallePorWamid = new Map((fallidos as any[]).filter((m) => m.wa_message_id)
            .map((m) => [String(m.wa_message_id), m.error_detail as string | null]));
        if (!detallePorWamid.size) return 0;
        const { data: envios } = await supabase.from('whatsapp_campana_envios')
            .select('id, contact_wa_id, estado, intentos, wa_message_id')
            .eq('campana_id', c.id).eq('estado', 'enviado').in('wa_message_id', [...detallePorWamid.keys()]);
        let n = 0;
        for (const e of (envios as EnvioFila[] | null) ?? []) {
            const destino = destinoTrasFalloAsincrono(Number(e.intentos ?? 1), detallePorWamid.get(String(e.wa_message_id)), ahoraMs);
            await aplicarDestino(c, e, destino, ahoraMs);
            n++;
        }
        return n;
    } catch {
        return 0;
    }
}

/**
 * Deja la plantilla en el buzón. `step:'campana'` + `automatico:true`: no es una
 * persona de la escuela (modo discreto) y el bot la reconoce como seguimiento.
 */
async function registrarSalienteDeCampana(a: {
    integ: WhatsAppIntegration; conversationId: string | null; toWaId: string; waMessageId: string | null;
    texto: string; payload: Record<string, unknown>;
}): Promise<void> {
    let convId = a.conversationId;
    if (!convId) {
        await supabase.from('whatsapp_conversations').upsert({
            integration_id: a.integ.id, school_id: a.integ.school_id, contact_wa_id: a.toWaId,
        }, { onConflict: 'integration_id,contact_wa_id', ignoreDuplicates: true });
        const { data: conv } = await supabase.from('whatsapp_conversations').select('id')
            .eq('integration_id', a.integ.id).eq('contact_wa_id', a.toWaId).maybeSingle();
        convId = (conv as any)?.id ?? null;
    }
    if (!convId) return;
    await supabase.rpc('wa_record_outbound_message', {
        p_conversation_id: convId,
        p_integration_id: a.integ.id,
        p_wa_message_id: a.waMessageId || `local-${crypto.randomUUID()}`,
        p_type: 'template',
        p_text_body: a.texto,
        p_payload: { ...a.payload, automatico: true },
        p_ai_generated: false,
        p_to_wa_id: a.toWaId,
    });
}

// ─── Audiencia: conteo previsto ──────────────────────────────────────────────

export interface FilaAudiencia {
    contact_wa_id: string;
    intereses: string[] | null;
    branch_id: string | null;
    ultimo_entrante_at?: string | null;
}

/** ¿La persona entra en el filtro de la campaña? Intereses: alguno en común. Sede: una de las elegidas. Pura. */
export function filtroCoincide(f: Pick<FilaAudiencia, 'intereses' | 'branch_id'>, filtro: FiltroCampana | null | undefined): boolean {
    const intereses = filtro?.intereses ?? [];
    const sedes = filtro?.branch_ids ?? [];
    if (intereses.length && !(f.intereses ?? []).some((i) => intereses.includes(i))) return false;
    if (sedes.length && !(f.branch_id && sedes.includes(f.branch_id))) return false;
    return true;
}

/** Tipos de contacto que nunca reciben una campaña (los mismos que excluye `wa_campana_aprobar`). */
const TIPOS_SIN_CAMPANA = ['personal', 'negocio', 'otro_club', 'plataforma', 'staff', 'familia', 'familia_sin_cuenta'];

/**
 * Las filas vigentes de la audiencia, con el MISMO filtro que `wa_campana_aprobar`
 * (M3), para que el conteo previsto sea lo que se aprueba: sin exclusión; la
 * antigüedad solo con base 'contacto_previo_declarado'; con base 'optin', solo
 * opt-in vigente (`opted_in_at` y sin `opted_out_at`); en las dos bases, fuera
 * quien se dio de baja, los números bloqueados y los contactos marcados como
 * personales, negocio, otro club, plataforma, staff o familia. Lectura paginada
 * de tablas propias: no toca `whatsapp_messages`.
 */
export async function audienciaVigente(integrationId: string, ajustes: AjustesCampanas, ahora = Date.now()): Promise<FilaAudiencia[]> {
    const desde = new Date(ahora - ajustes.antiguedadMaxDias * 24 * 3600_000).toISOString();
    const declarada = ajustes.baseConsentimiento === 'contacto_previo_declarado';
    const filas: FilaAudiencia[] = [];
    for (let desdeFila = 0; desdeFila < 50_000; desdeFila += 1000) {
        let q = supabase.from('whatsapp_audiencia')
            .select('contact_wa_id, intereses, branch_id, ultimo_entrante_at')
            .eq('integration_id', integrationId).is('excluido', null);
        if (declarada) q = q.gte('ultimo_entrante_at', desde);
        const { data, error } = await q
            .order('contact_wa_id', { ascending: true })
            .range(desdeFila, desdeFila + 999);
        if (error || !Array.isArray(data)) break;
        filas.push(...(data as FilaAudiencia[]));
        if (data.length < 1000) break;
    }
    if (filas.length === 0) return filas;

    const conOptin = new Set<string>();
    const fuera = new Set<string>();
    for (let i = 0; i < filas.length; i += 500) {
        const lote = filas.slice(i, i + 500).map((f) => f.contact_wa_id);
        const [optins, conversaciones, bloqueados] = await Promise.all([
            supabase.from('whatsapp_optins').select('contact_wa_id, opted_in_at, opted_out_at')
                .eq('integration_id', integrationId).in('contact_wa_id', lote),
            supabase.from('whatsapp_conversations').select('contact_wa_id, contact_kind')
                .eq('integration_id', integrationId).in('contact_wa_id', lote),
            supabase.from('whatsapp_blocked_numbers').select('contact_wa_id, integration_id')
                .in('contact_wa_id', lote),
        ]);
        for (const o of ((optins as any)?.data as any[]) ?? []) {
            if (o.opted_out_at) fuera.add(String(o.contact_wa_id));
            else if (o.opted_in_at) conOptin.add(String(o.contact_wa_id));
        }
        for (const c of ((conversaciones as any)?.data as any[]) ?? []) {
            if (TIPOS_SIN_CAMPANA.includes(String(c.contact_kind ?? ''))) fuera.add(String(c.contact_wa_id));
        }
        for (const b of ((bloqueados as any)?.data as any[]) ?? []) {
            if (b.integration_id == null || b.integration_id === integrationId) fuera.add(String(b.contact_wa_id));
        }
    }
    return filas.filter((f) => !fuera.has(f.contact_wa_id)
        && (ajustes.baseConsentimiento !== 'optin' || conOptin.has(f.contact_wa_id)));
}

export interface Conteo { total: number; porInteres: Record<string, number>; porSede: Record<string, number> }

/** Conteo por interés y por sede ('sin_sede' si no se supo). Pura. */
export function contarFilas(filas: FilaAudiencia[], filtro?: FiltroCampana | null): Conteo {
    const c: Conteo = { total: 0, porInteres: {}, porSede: {} };
    for (const f of filas) {
        if (!filtroCoincide(f, filtro)) continue;
        c.total++;
        for (const i of f.intereses ?? []) c.porInteres[i] = (c.porInteres[i] ?? 0) + 1;
        const s = f.branch_id ?? 'sin_sede';
        c.porSede[s] = (c.porSede[s] ?? 0) + 1;
    }
    return c;
}

// ─── Operaciones de la pantalla y del script ─────────────────────────────────

export type ResultadoOperacion<T = Record<string, unknown>> =
    | ({ ok: true } & T)
    | { ok: false; status: number; error: string; detalle?: string };

const falla = (status: number, error: string, detalle?: string) => ({ ok: false as const, status, error, ...(detalle ? { detalle } : {}) });

export async function campanaDeEscuela(schoolId: string, campanaId: string): Promise<CampanaFila | null> {
    if (!UUID.test(campanaId)) return null;
    const { data } = await supabase.from('whatsapp_campanas').select(COLS_CAMPANA)
        .eq('id', campanaId).eq('school_id', schoolId).maybeSingle();
    return (data as unknown as CampanaFila) ?? null;
}

export interface DatosNuevaCampana {
    nombre: string;
    plantilla: string;
    idioma?: string;
    filtro?: FiltroCampana;
    respuestaSi?: string | null;
    venceAt?: string | null;
}

/** Valida los datos de una campaña nueva. Devuelve el error legible o null. Pura. */
export function errorEnDatosDeCampana(d: DatosNuevaCampana, ahora = Date.now()): string | null {
    const nombre = String(d.nombre ?? '').trim();
    if (nombre.length < 3 || nombre.length > 80) return 'El nombre va de 3 a 80 caracteres.';
    if (!/^[a-z0-9_]{3,60}$/.test(String(d.plantilla ?? ''))) return 'Elige una plantilla aprobada.';
    const intereses = d.filtro?.intereses ?? [];
    if (!Array.isArray(intereses) || intereses.some((i) => !(INTERESES_AUDIENCIA as readonly string[]).includes(i))) {
        return 'Hay un interés que no existe.';
    }
    const sedes = d.filtro?.branch_ids ?? [];
    if (!Array.isArray(sedes) || sedes.some((s) => !UUID.test(String(s)))) return 'Hay una sede inválida.';
    if (d.respuestaSi != null && String(d.respuestaSi).length > 1024) return 'La respuesta al «Sí» va hasta 1024 caracteres.';
    if (d.venceAt) {
        const t = new Date(d.venceAt).getTime();
        if (Number.isNaN(t) || t <= ahora) return 'La fecha de vencimiento tiene que ser futura.';
    }
    return null;
}

/** Crea el borrador. La plantilla puede estar todavía en revisión: se valida al aprobar. */
export async function crearCampana(schoolId: string, por: string | null, d: DatosNuevaCampana): Promise<ResultadoOperacion<{ campana: CampanaFila }>> {
    const { disponible, ajustes } = await leerAjustesCampanas(schoolId);
    if (!disponible) return falla(503, 'campanas_no_disponibles');
    if (!ajustes?.habilitadas) return falla(409, 'campanas_apagadas');
    const err = errorEnDatosDeCampana(d);
    if (err) return falla(400, 'datos_invalidos', err);
    const integ = await integracionActivaDeEscuela(schoolId);
    if (typeof integ === 'string') return falla(409, integ);

    const plantilla = await plantillaDeCampana(integ, d.plantilla, d.idioma || 'es_CO');
    const { data, error } = await supabase.from('whatsapp_campanas').insert({
        integration_id: integ.id,
        school_id: schoolId,
        nombre: d.nombre.trim(),
        plantilla: d.plantilla,
        idioma: d.idioma || 'es_CO',
        filtro: { intereses: d.filtro?.intereses ?? [], branch_ids: d.filtro?.branch_ids ?? [] },
        variables: plantilla.ok && plantilla.variables === 1 ? ['nombre'] : [],
        respuesta_si: d.respuestaSi?.trim() || null,
        vence_at: d.venceAt || null,
        estado: 'borrador',
        creada_por: por,
    }).select(COLS_CAMPANA).single();
    if (error) return falla(500, 'no_se_pudo_crear', error.message);
    return { ok: true, campana: data as unknown as CampanaFila };
}

/** Conteo previsto del borrador («Lista: N personas»). No escribe nada. */
export async function simularCampana(schoolId: string, campanaId: string): Promise<ResultadoOperacion<{ conteo: Conteo; plantilla: PlantillaCampana }>> {
    const campana = await campanaDeEscuela(schoolId, campanaId);
    if (!campana) return falla(404, 'campana_no_existe');
    const { ajustes } = await leerAjustesCampanas(schoolId);
    if (!ajustes?.habilitadas) return falla(409, 'campanas_apagadas');
    const integ = await integracionPorId(campana.integration_id);
    if (!integ) return falla(409, 'sin_integracion');
    const [filas, plantilla] = await Promise.all([
        audienciaVigente(integ.id, ajustes),
        plantillaDeCampana(integ, campana.plantilla, campana.idioma),
    ]);
    return { ok: true, conteo: contarFilas(filas, campana.filtro), plantilla };
}

/**
 * Aprobar = foto de la audiencia (`wa_campana_aprobar` valida ADENTRO que quien
 * aprueba administre ESA escuela, que esté en 'borrador' y que las campañas
 * estén encendidas). Con la base 'contacto_previo_declarado' exige la
 * declaración aceptada.
 */
export async function aprobarCampana(p: {
    schoolId: string; campanaId: string; por: string; declaracionAceptada: boolean;
}): Promise<ResultadoOperacion<{ destinatarios: number }>> {
    const campana = await campanaDeEscuela(p.schoolId, p.campanaId);
    if (!campana) return falla(404, 'campana_no_existe');
    if (campana.estado !== 'borrador') return falla(409, 'no_es_borrador');
    const { ajustes } = await leerAjustesCampanas(p.schoolId);
    if (!ajustes?.habilitadas) return falla(409, 'campanas_apagadas');
    if (ajustes.pausadaAt) return falla(409, 'escuela_en_pausa', ajustes.pausaMotivo ?? undefined);
    const declarada = ajustes.baseConsentimiento === 'contacto_previo_declarado';
    if (declarada && !p.declaracionAceptada) return falla(400, 'falta_declaracion');

    const integ = await integracionPorId(campana.integration_id);
    if (!integ) return falla(409, 'sin_integracion');
    const plantilla = await plantillaDeCampana(integ, campana.plantilla, campana.idioma);
    if (!plantilla.ok) return falla(409, 'plantilla_no_lista', plantilla.detalle);

    const { data, error } = await supabase.rpc('wa_campana_aprobar', {
        p_campana_id: campana.id, p_por: p.por, p_declaracion: declarada ? DECLARACION.version : VERSION_OPTIN,
    });
    if (error) return falla(409, 'no_se_pudo_aprobar', error.message);
    // 0 = nadie cumple el filtro: la RPC deja la campaña en borrador (no es un éxito).
    if (!Number(data)) return falla(409, 'sin_destinatarios');
    return { ok: true, destinatarios: Number(data) };
}

export async function pausarCampana(schoolId: string, campanaId: string): Promise<ResultadoOperacion> {
    const campana = await campanaDeEscuela(schoolId, campanaId);
    if (!campana) return falla(404, 'campana_no_existe');
    if (!['aprobada', 'enviando'].includes(campana.estado)) return falla(409, 'no_esta_en_curso');
    await supabase.from('whatsapp_campanas')
        .update({ estado: 'pausada', pausa_motivo: 'manual', updated_at: new Date().toISOString() }).eq('id', campana.id);
    return { ok: true };
}

/**
 * Reanudar (a mano): la campaña vuelve a 'enviando' y, si la escuela estaba en
 * pausa por el freno, se levanta. Si la señal sigue, el próximo tick vuelve a
 * frenar.
 */
export async function reanudarCampana(schoolId: string, campanaId: string): Promise<ResultadoOperacion> {
    const campana = await campanaDeEscuela(schoolId, campanaId);
    if (!campana) return falla(404, 'campana_no_existe');
    if (campana.estado !== 'pausada') return falla(409, 'no_esta_en_pausa');
    const ahoraIso = new Date().toISOString();
    await supabase.from('whatsapp_campanas_ajustes')
        .update({ pausada_at: null, pausa_motivo: null, updated_at: ahoraIso }).eq('school_id', schoolId);
    await supabase.from('whatsapp_campanas')
        .update({ estado: campana.aprobada_at ? 'enviando' : 'borrador', pausa_motivo: null, updated_at: ahoraIso })
        .eq('id', campana.id);
    return { ok: true };
}

export type Avance = Record<EstadoEnvio, number> & { total: number };

/** Envíos por estado de varias campañas (una lectura paginada de una columna). */
export async function avanceDeCampanas(campanaIds: string[]): Promise<Map<string, Avance>> {
    const out = new Map<string, Avance>();
    const vacio = (): Avance => ({ total: 0, ...Object.fromEntries(ESTADOS_ENVIO.map((e) => [e, 0])) } as Avance);
    for (const id of campanaIds) out.set(id, vacio());
    if (!campanaIds.length) return out;
    for (let desde = 0; desde < 100_000; desde += 1000) {
        const { data, error } = await supabase.from('whatsapp_campana_envios').select('campana_id, estado')
            .in('campana_id', campanaIds).order('id', { ascending: true }).range(desde, desde + 999);
        if (error || !Array.isArray(data)) break;
        for (const f of data as { campana_id: string; estado: EstadoEnvio }[]) {
            const a = out.get(f.campana_id);
            if (!a) continue;
            a.total++;
            if (f.estado in a) a[f.estado]++;
        }
        if (data.length < 1000) break;
    }
    return out;
}

/** Las campañas de la escuela, las más nuevas primero. */
export async function campanasDeEscuela(schoolId: string, limite = 20): Promise<CampanaFila[]> {
    const { data, error } = await supabase.from('whatsapp_campanas').select(COLS_CAMPANA)
        .eq('school_id', schoolId).order('created_at', { ascending: false }).limit(limite);
    return error ? [] : ((data as unknown as CampanaFila[]) ?? []);
}

/** Plantillas MARKETING de la WABA con su validación (para elegir al crear). */
export async function plantillasDeMarketing(integ: { id: string; waba_id: string | null }): Promise<
    { nombre: string; idioma: string; estado: string; lista: boolean; motivo: string | null; texto: string; botones: string[] }[]
> {
    const { data, error } = await supabase.from('whatsapp_template_status')
        .select('name, language, category, status, components, waba_id')
        .eq('integration_id', integ.id).eq('category', 'MARKETING');
    if (error) return [];
    return ((data as any[]) ?? []).filter((f) => f.status !== 'DELETED').map((f) => {
        const v = validarPlantillaDeCampana(f, integ.waba_id);
        const body = (f.components ?? []).find((c: any) => String(c?.type).toUpperCase() === 'BODY');
        return {
            nombre: f.name, idioma: f.language, estado: f.status, lista: v.ok, motivo: v.ok ? null : v.detalle,
            texto: String(body?.text ?? ''), botones: botonesRapidos(f.components),
        };
    });
}
