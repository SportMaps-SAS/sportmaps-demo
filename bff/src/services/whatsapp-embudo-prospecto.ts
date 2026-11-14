/**
 * whatsapp-embudo-prospecto — el embudo del interesado POR ESCUELA (B2, plan
 * docs/specs/whatsapp-monster-plan-B2-B3.md §3 y plan maestro §2–§3; maqueta
 * docs/specs/whatsapp-monster-maqueta.html pasos 1–5).
 *
 * Monster 2026-10-30 reemplaza «Google Form + pago + correo con los datos» por
 * UN chat:
 *
 *   1. Bienvenida de la escuela (`wa_bienvenida`) con sus sedes como botones
 *      (`wa_botones_sede`, con su emoji) + «Ya soy del club» (lo atiende la
 *      puerta de siempre, `sm_pd_club`).
 *   2. Sus preguntas (`wa_preguntas_prospecto`): texto, fecha, botones o lista,
 *      varias respuestas en un mensaje («Mariana, 14/03/2011, punta»), un
 *      detalle condicional («Club y torneos» → en qué clubes) y dos intentos
 *      fallidos → una persona con lo que haya.
 *   3. El grupo (por inyección: `elegirGrupoEmbudo` de B3) y los horarios reales
 *      de ese grupo (solo los días que la escuela agenda).
 *   4. Al elegir: `tomarCupo`. Separada → primero el consentimiento [Sí, claro]
 *      [No, gracias] (`wa_register_optin`, fuente `bot_prospecto`), después las
 *      cuentas de la escuela; el comprobante lo agenda B4 con
 *      `confirmarClasePruebaPagada`. Sin cuentas → una persona y se suelta el cupo.
 *      Agendada (sin valor o ya pagó) → confirmación + consentimiento.
 *   5. «Cambiar horario» / «Elegir otro horario» vuelve a la lista del mismo grupo
 *      y `tomarCupo` agenda sin volver a cobrar (el pago está atado al lead).
 *   6. «¿Y para matricularla?» con el flujo abierto: la matrícula va DESPUÉS de la
 *      clase (el profe evalúa y la escuela define el grupo), se le dice eso y la
 *      escuela recibe el aviso con los datos del interesado (Monster 2026-11-03).
 *
 * Solo corre si la escuela tiene `wa_preguntas_prospecto` válido
 * (`embudoActivo`); Dynasty y las demás no lo ven nunca.
 *
 * El estado viaja en el payload del último saliente (`flujo: 'embudo'`,
 * `paso_embudo`, `datos_embudo`), igual que la puerta y la clase de cortesía.
 * Los botones llevan el prefijo `sm_em_`.
 *
 * El motor no habla con Meta: todo entra por `CtxEmbudo` (inyectable en
 * pruebas). Las funciones de B3-motor (`elegirGrupoEmbudo`, `textosDeClase`,
 * franjas con las sesiones canceladas filtradas) llegan por el contexto: este
 * archivo no las importa. Nunca dice «gratis» cuando la clase tiene valor.
 */

import type { BotonInteractivo } from './whatsapp.service';
import { supabase } from '../config/supabase';
import { enCortafuegos } from '../config/cortafuegos-simulacion';
import {
    normalizar, leerNumeroOpcion, quiereSalirDelFlujo, fechaLegible, horaLegible, leerDia, esPreguntaDeOtroTema,
} from './whatsapp-clase-cortesia.service';
import { BOTON_PUERTA, leerNombreDeDeportista, leerOpcionDePuerta, leerVariosDeportistas } from './whatsapp-puerta-desconocido';
import { quierePagarMensualidad } from './whatsapp-pagar-mensualidad';

/**
 * Otra conversación a mitad del embudo: una pregunta de otro tema o «quiero pagar una
 * mensualidad» (Monster 2026-11-05: en la pregunta del nombre se leía como nombre, «¡Mucho
 * gusto, Quiero!»). La contesta el bot general y el paso queda donde iba.
 */
const esOtroTema = (texto: string): boolean => esPreguntaDeOtroTema(texto) || quierePagarMensualidad(texto);
import {
    embudoActivo, cobraClaseEnElBot,
    type AjustesClasePrueba, type AjustesWhatsAppEscuela, type BotonSede, type PreguntaProspecto,
} from './whatsapp-ajustes-escuela.service';
import type { ResultadoCupo } from './clase-prueba-agenda.service';

export const FLUJO_EMBUDO = 'embudo';

/** Vigencia del flujo: pasado este tiempo la persona vuelve a empezar. */
export const VIGENCIA_FLUJO_EMBUDO_MS = 24 * 60 * 60 * 1000;

/** Ids = contrato con el webhook. Títulos ≤ 20 (botones) y ≤ 24 (filas de lista). */
export const BOTON_EMBUDO = {
    SEDE: 'sm_em_sede:',        // + branch_id
    OPCION: 'sm_em_o:',         // + clave + ':' + índice de la opción
    FRANJA: 'sm_em_f:',         // + id de la franja
    MAS: 'sm_em_mas',
    OTRA_SEDE: 'sm_em_otra:',   // + branch_id
    PERSONA: 'sm_em_persona',
    OPTIN_SI: 'sm_em_optin_si',
    OPTIN_NO: 'sm_em_optin_no',
    CAMBIAR: 'sm_em_cambiar',
    REPROGRAMAR: 'sm_em_reprogramar',
    AHI_ESTAREMOS: 'sm_em_ahi',
} as const;

export function esBotonEmbudo(id: string | null | undefined): boolean {
    return !!id && id.startsWith('sm_em_');
}

/**
 * Los botones de respuesta rápida de una PLANTILLA no traen nuestro id: el
 * webhook trae `button.payload` = el texto del botón. Se traducen aquí
 * (recordatorio de clase de prueba y «clase reprogramada»). Pura.
 */
export function botonDePlantilla(botonId: string | null | undefined): string | null {
    if (!botonId || botonId.startsWith('sm_')) return null;
    const n = normalizar(botonId);
    if (n === 'elegir otro horario') return BOTON_EMBUDO.REPROGRAMAR;
    if (n === 'cambiar horario' || n === 'no puedo ir') return BOTON_EMBUDO.CAMBIAR;
    if (n === 'ahi estaremos') return BOTON_EMBUDO.AHI_ESTAREMOS;
    return null;
}

/** steps que quedan en el payload (cuentan para frenos y métricas). */
export const PASO_EMBUDO = {
    BIENVENIDA: 'embudo_bienvenida',
    PREGUNTA: 'embudo_pregunta',
    HORARIOS: 'embudo_horarios',
    OTRA_SEDE: 'embudo_otra_sede',
    CONSENTIMIENTO: 'embudo_consentimiento',
    PAGO: 'embudo_esperando_pago',
    AGENDADA: 'embudo_agendada',
    A_PERSONA: 'embudo_a_persona',
    /** «¿Y la matrícula?» contestado sin cerrar el flujo. */
    MATRICULA: 'embudo_matricula',
    /** «¿Dónde queda?» con la clase elegida. */
    DONDE: 'embudo_donde',
} as const;

export type PasoEmbudo =
    | 'sede' | 'pregunta' | 'detalle' | 'otra_sede' | 'elegir_franja'
    | 'consentimiento' | 'esperando_pago' | 'agendada' | 'reprogramar';

export interface DatosEmbudo {
    branchId?: string | null;
    sedeTitulo?: string | null;
    /** Índice de la pregunta en curso. */
    i?: number;
    /** Todas las respuestas por clave (las reservadas también, como texto). */
    respuestas?: Record<string, string>;
    nombre?: string | null;
    fechaNacimiento?: string | null;
    anio?: number | null;
    genero?: 'f' | 'm' | null;
    intentos?: number;
    leadId?: string | null;
    teamId?: string | null;
    grupo?: string | null;
    profe?: string | null;
    /** Ids de las franjas de la página mostrada, en orden («la 2»). */
    lista?: string[];
    desde?: number;
    /** Franja separada o agendada. */
    slotId?: string | null;
    hasta?: string | null;
    /** Cambio de horario de una clase ya agendada (o reprogramada por la escuela). */
    cambio?: boolean;
    consentimiento?: 'si' | 'no' | null;
    /** Qué sigue después del consentimiento. */
    siguiente?: 'pago' | 'fin';
    /** Ya se le avisó a la escuela que pide la matrícula: en este flujo no se repite el aviso. */
    matriculaAvisada?: boolean;
    /** La clase ya está pagada (la confirmó B4 al recibir el comprobante). */
    pagada?: boolean;
}

export interface EstadoEmbudo { paso: PasoEmbudo; datos: DatosEmbudo }

export interface SedeEmbudo { branchId: string; nombre: string | null; direccion: string | null }

/** El grupo con que sigue el embudo (nombre ya en título, profe de la lista de B3). */
export interface GrupoEmbudo { teamId: string; nombre: string; profe?: string | null }

/** Lo que el motor usa de `RangoGrupo` (B3, grupos-por-edad.service): estructuralmente compatible. */
export interface RangoEmbudo {
    teamId: string;
    nombre: string;
    branchId?: string | null;
    /** Nombres de los profes del equipo; el primero es el que «recibe». */
    coachNombres?: string[];
}

/** Forma de B3 `EleccionEmbudo` (`elegirGrupoEmbudo(rangos, { branchId, anio, genero })`). */
export interface EleccionGrupoEmbudo {
    principal: RangoEmbudo | null;
    candidatos?: RangoEmbudo[];
    /** Sin grupo en la sede pedida: el mejor de OTRA sede (para «Ver Sede X»). */
    otraSede: RangoEmbudo | null;
    motivo: 'sin_anio' | 'sin_grupo' | null;
}

export interface FranjaEmbudo {
    id: string;
    fecha: string;          // YYYY-MM-DD
    horaInicio: string;     // HH:MM[:SS]
    horaFin: string | null;
    /** Cancha o sede. */
    lugar: string | null;
    cupos: number;
    profe?: string | null;
}

export interface CuentaDePagoEmbudo { tipo: string; numero: string; titular?: string | null }

/** Contrato de B3 `textosDeClase({ nombre_clase, trial_price })`. */
export interface TextosClase {
    /** «clase de cortesía» | «clase de prueba». */
    nombre: string;
    gratis: boolean;
    /** «$15.000»; null si es gratis. */
    precio: string | null;
    tipo?: 'cortesia' | 'prueba';
    nombreInicial?: string;
}

/** Lo que queda en `school_signup_leads` (ver `leadCompletoDeEmbudo`). */
export interface LeadEmbudo {
    deportista: string;
    fechaNacimiento: string | null;
    anio: number | null;
    genero: 'f' | 'm' | null;
    branchId: string | null;
    teamId: string | null;
    grupo: string | null;
    /** Solo las claves NO reservadas (posición, trayectoria, detalle…). */
    respuestas: Record<string, string>;
}

export type MotivoPersona = 'sin_grupo' | 'sin_horarios' | 'sin_cuentas_de_pago' | 'no_entendio' | 'error' | 'pide_persona'
    | 'pide_matricula';

/** Lo que `franjaDeAgenda` (clase-prueba-agenda) sabe de dónde es la clase. */
export interface LugarDeClase {
    fecha: string;
    horaInicio: string;
    lugar: string | null;
    direccion: string | null;
    mapsUrl: string | null;
    indicaciones: string | null;
}

export interface LeadDelContacto {
    leadId: string;
    nombre: string | null;
    teamId: string | null;
    branchId: string | null;
    slotId: string | null;
    separadoSlotId: string | null;
    consentimiento?: 'si' | 'no' | null;
    /** La clase quedó agendada con un pago (B4). */
    pagada?: boolean;
}

export interface CtxEmbudo {
    conversationId: string;
    schoolId: string;
    contactWaId: string;
    /**
     * Envía un mensaje. `estado` null = terminal (cierra el flujo). `contexto` se
     * mezcla en el payload: `{ texto_de_la_escuela: true }` marca la bienvenida
     * que escribió la escuela (no recortarle los emojis de sus sedes).
     */
    enviar: (texto: string, step: string, estado: EstadoEmbudo | null,
        botones?: BotonInteractivo[], enTexto?: string, contexto?: Record<string, unknown>) => Promise<void>;
    ajustes: () => Promise<AjustesWhatsAppEscuela>;
    clase: () => Promise<AjustesClasePrueba>;
    sedes: (branchIds: string[]) => Promise<SedeEmbudo[]>;
    /**
     * B3 tal cual: `async (q) => elegirGrupoEmbudo(await rangosDeEscuela(schoolId), q)`.
     * Sin `principal` no hay grupo (nunca se inventa); `otraSede` ofrece «Ver Sede X».
     */
    elegirGrupo: (q: { branchId: string | null; anio: number | null; genero: 'f' | 'm' | null }) => Promise<EleccionGrupoEmbudo | null>;
    /** Franjas abiertas con cupo de ese equipo (las canceladas ya filtradas). */
    franjas: (teamId: string) => Promise<FranjaEmbudo[]>;
    /** B3 `textosDeClase`. Sin él: «clase de prueba»/«clase de cortesía» y el valor, nunca «gratis» si hay valor. */
    textosDeClase?: (c: { nombre_clase: string | null; trial_price: number | null }) => TextosClase;
    /** Crea o actualiza el lead (uno por escuela + teléfono). Devuelve el id o null. */
    guardarLead: (l: LeadEmbudo) => Promise<string | null>;
    /** Mezcla `extra` en source_detail del lead (consentimiento). */
    marcarLead?: (leadId: string, extra: Record<string, unknown>) => Promise<void>;
    /**
     * `o.pagada`: el lead ya pagó la clase (cambio de horario tras pagar). La RPC lo sabe
     * por su cuenta; solo lo usa la simulación (`cupoSimulado`) para no volver a cobrar.
     */
    tomarCupo: (leadId: string, slotId: string, o?: { pagada?: boolean }) => Promise<ResultadoCupo>;
    soltarCupo: (leadId: string) => Promise<void>;
    cuentasDePago: () => Promise<CuentaDePagoEmbudo[]>;
    /** B4. Por defecto, import dinámico de ./wa-concepto-esperado.service (si no existe, se sigue sin él). */
    registrarConceptoEsperado?: (p: { motivo: 'clase_prueba'; monto: number | null; leadId: string; venceEn: string | null }) => Promise<void>;
    /** `wa_register_optin` con `p_source: 'bot_prospecto'` y el mensaje de la confirmación como prueba. */
    registrarOptIn: () => Promise<void>;
    /** Agendada sin pago de por medio: texto de confirmación + avisos (clase-prueba-agenda `confirmarClaseAgendada`). */
    confirmarAgenda: (p: { leadId: string; slotId: string; evento: 'agendada' | 'cambiada' }) => Promise<{ texto: string; consentimientoPendiente: boolean }>;
    /** Deja la conversación para una persona (buzón + aviso a la escuela). */
    avisarEscuela: (motivo: MotivoPersona, detalle: string | null) => Promise<void>;
    /** «Ya soy del club» escrito (no tocado): lo atiende la puerta de siempre. */
    yaSoyDelClub?: () => Promise<void>;
    /** Lead del contacto, para botones que llegan sin estado (plantilla, B4). */
    leadDelContacto?: () => Promise<LeadDelContacto | null>;
    /** Cancha, dirección e indicaciones de la franja elegida («¿dónde queda?»). Sin él, lo contesta el bot general. */
    lugarDeLaClase?: (slotId: string) => Promise<LugarDeClase | null>;
    leerEstado?: (conversationId: string) => Promise<EstadoEmbudo | null>;
    ahora?: () => Date;
}

// ─── Utilidades puras ────────────────────────────────────────────────────────

const MAX_INTENTOS = 2;
/** Filas de una lista de WhatsApp (límite de Meta). Con «Ver más» van 9 franjas. */
const MAX_FILAS = 10;
const MAX_FRANJAS = 45;
/** No se ofrece una franja que empieza en menos de 2 h. */
export const ANTICIPACION_MIN_EMBUDO = 120;
const TZ = 'America/Bogota';
const NUMEROS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const CLAVES_RESERVADAS = new Set(['nombre', 'fecha_nacimiento', 'sexo']);

const recortar = (t: string, max: number) => Array.from(String(t ?? '').trim()).slice(0, max).join('');
const primerNombre = (n: string | null | undefined) => String(n ?? '').trim().split(/\s+/)[0] ?? '';
const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
/** «🟡 Sede Norte» → «Sede Norte». Pura. */
export const sinEmojis = (t: string | null | undefined) => String(t ?? '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
const escapar = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function partesFecha(fecha: string): { y: number; m: number; d: number; dow: number } {
    const [y, m, d] = fecha.slice(0, 10).split('-').map(Number);
    return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() };
}

function ahoraBogota(ahora: Date): { y: number; fecha: string; minutos: number } {
    const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ahora);
    const v = (t: string) => p.find((x) => x.type === t)?.value ?? '0';
    return { y: Number(v('year')), fecha: `${v('year')}-${v('month')}-${v('day')}`, minutos: Number(v('hour')) * 60 + Number(v('minute')) };
}

const minutosAbs = (fecha: string, hora: string) => {
    const { y, m, d } = partesFecha(fecha);
    const [hh, mm] = hora.split(':').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 60_000) + hh * 60 + (mm || 0);
};

/**
 * Las franjas que se ofrecen: con cupo, en los días que la escuela agenda
 * (`dias_semana`), que empiezan en 2 h o más, sin la que ya tiene. Ordenadas. Pura.
 */
export function franjasOfrecibles(
    franjas: FranjaEmbudo[], o: { ahora: Date; diasSemana: number[] | null; excluir?: string | null },
): FranjaEmbudo[] {
    const hoy = ahoraBogota(o.ahora);
    const limite = minutosAbs(hoy.fecha, '00:00') + hoy.minutos + ANTICIPACION_MIN_EMBUDO;
    return franjas
        .filter((f) => f.cupos > 0 && f.id !== o.excluir)
        .filter((f) => !o.diasSemana || o.diasSemana.includes(partesFecha(f.fecha).dow))
        .filter((f) => minutosAbs(f.fecha, f.horaInicio) >= limite)
        .sort((a, b) => (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio))
        .slice(0, MAX_FRANJAS);
}

const hhmm = (h: string) => { const [a, b] = h.split(':').map(Number); return `${a}:${String(b || 0).padStart(2, '0')}`; };

/**
 * Fila de la lista de horarios: «Sáb 31 oct · 8:00–10:00» (≤ 24) y debajo
 * «Pinar 2 · Profe Iván · 5 cupos» (≤ 72; sin cifra cuando no hay tope). Pura.
 */
export function filaDeFranja(f: FranjaEmbudo, grupo: string | null): BotonInteractivo {
    const { m, d, dow } = partesFecha(f.fecha);
    const titulo = `${DIAS_CORTOS[dow]} ${d} ${MESES_CORTOS[m - 1]} · ${hhmm(f.horaInicio)}${f.horaFin ? `–${hhmm(f.horaFin)}` : ''}`;
    const cupos = f.cupos >= 999 ? '' : f.cupos === 1 ? '1 cupo' : `${f.cupos} cupos`;
    const desc = [f.lugar ?? '', f.profe ? `Profe ${primerNombre(f.profe)}` : '', cupos].filter(Boolean).join(' · ');
    return {
        id: `${BOTON_EMBUDO.FRANJA}${f.id}`,
        title: recortar(titulo, 24),
        ...(desc ? { descripcion: recortar(desc, 72) } : {}),
        seccion: recortar(grupo ? sinEmojis(grupo) : 'Horarios', 24),
    };
}

/** «sábado 31 de octubre a las 8:00 a. m.». Pura. */
export function cuandoEs(f: Pick<FranjaEmbudo, 'fecha' | 'horaInicio'>): string {
    return `${fechaLegible(f.fecha)} a las ${horaLegible(f.horaInicio)}`;
}

/** Los textos de la clase cuando B3 no los inyecta: nunca «gratis» con valor. Pura. */
export function textosPorDefecto(c: { nombre_clase: string | null; trial_price: number | null }): TextosClase {
    const precio = c.trial_price != null && c.trial_price > 0 ? `$${Math.round(c.trial_price).toLocaleString('es-CO')}` : null;
    return { nombre: c.nombre_clase === 'prueba' ? 'clase de prueba' : 'clase de cortesía', gratis: !precio, precio };
}

/**
 * Fecha de nacimiento: «14/03/2011», «2011-03-14», «14 de marzo de 2011» o solo
 * el año («2011», «nació en el 2011»). Una edad («14 años») NO vale: el grupo va
 * por año exacto. null si no hay fecha. Pura.
 */
export function leerFechaNacimiento(texto: string | null | undefined, ahora: Date): { fecha: string | null; anio: number; coincidencia: string } | null {
    const t = String(texto ?? '');
    const n = normalizar(t);
    const hoyY = ahoraBogota(ahora).y;
    const valida = (y: number, m: number, d: number) => {
        const f = new Date(Date.UTC(y, m - 1, d));
        return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d && y >= hoyY - 90 && y <= hoyY - 2;
    };
    const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dmy = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
    if (dmy && valida(+dmy[3], +dmy[2], +dmy[1])) return { fecha: iso(+dmy[3], +dmy[2], +dmy[1]), anio: +dmy[3], coincidencia: dmy[0] };
    const ymd = t.match(/\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/);
    if (ymd && valida(+ymd[1], +ymd[2], +ymd[3])) return { fecha: iso(+ymd[1], +ymd[2], +ymd[3]), anio: +ymd[1], coincidencia: ymd[0] };
    const larga = n.match(new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')}) (?:de |del )?(\\d{4})\\b`));
    if (larga) {
        const m = MESES.indexOf(larga[2]) + 1;
        if (valida(+larga[3], m, +larga[1])) {
            const original = t.match(new RegExp(`\\d{1,2}\\s+de\\s+\\S+\\s+(?:de\\s+|del\\s+)?${larga[3]}`, 'i'));
            return { fecha: iso(+larga[3], m, +larga[1]), anio: +larga[3], coincidencia: original?.[0] ?? larga[0] };
        }
    }
    const anio = t.match(/\b(19\d{2}|20\d{2})\b/);
    if (anio && +anio[1] >= hoyY - 90 && +anio[1] <= hoyY - 2) return { fecha: null, anio: +anio[1], coincidencia: anio[0] };
    return null;
}

const F = /\b(mujer|mujeres|femenino|femenina|nina|ninas|dama|damas|chica|hija|ella)\b/;

/** Género que dice una opción o un texto corto. Pura. */
export function generoDeTexto(t: string | null | undefined): 'f' | 'm' | null {
    const n = normalizar(t);
    if (!n) return null;
    if (F.test(n) && !/\b(hombre|masculino|nino|varon)\b/.test(n)) return 'f';
    if (/\b(hombre|hombres|masculino|masculina|nino|ninos|varon|caballero|chico|hijo)\b/.test(n) && !F.test(n)) return 'm';
    return null;
}

/**
 * ¿El texto elige una opción de la pregunta? Igualdad normalizada (también sin
 * espacios: «armadora» = «Armador(a)»), la opción como palabra dentro de un
 * texto corto («juega de punta»), la primera palabra de la opción, y para la
 * pregunta de sexo el género. Pura.
 */
export function opcionDeTexto(texto: string | null | undefined, p: PreguntaProspecto): { titulo: string; j: number } | null {
    const opciones = p.opciones ?? [];
    const n = normalizar(texto);
    if (!n || !opciones.length) return null;
    const compacto = n.replace(/\s/g, '');
    const norm = opciones.map((o) => normalizar(sinEmojis(o.titulo)));
    for (let j = 0; j < opciones.length; j++) {
        if (n === norm[j] || compacto === norm[j].replace(/\s/g, '')) return { titulo: opciones[j].titulo, j };
    }
    if (n.split(' ').length <= 6) {
        const dentro = norm.map((o, j) => ({ o, j }))
            .filter(({ o }) => o.length >= 4 && new RegExp(`(^| )${escapar(o)}( |$)`).test(n));
        if (dentro.length === 1) return { titulo: opciones[dentro[0].j].titulo, j: dentro[0].j };
        const primera = norm.map((o, j) => ({ w: o.split(' ')[0], j })).filter(({ w }) => w.length >= 4 && w === n);
        if (primera.length === 1) return { titulo: opciones[primera[0].j].titulo, j: primera[0].j };
    }
    if (p.clave === 'sexo' && n.split(' ').length <= 6) {
        const g = generoDeTexto(n);
        const j = g ? opciones.findIndex((o) => generoDeTexto(o.titulo) === g) : -1;
        if (j >= 0) return { titulo: opciones[j].titulo, j };
    }
    return null;
}

/** Respuestas leídas de un mensaje: por clave. `nombre` y `fecha_nacimiento` traen su dato. */
export interface Leidas {
    respuestas: Record<string, string>;
    nombre?: string;
    fechaNacimiento?: string | null;
    anio?: number;
    /** Otros deportistas que vinieron en el mismo mensaje («Valeria … y Camila …»): el embudo sigue con el primero. */
    otros?: string[];
}

/**
 * Varias respuestas en UN mensaje: «Mariana, 14/03/2011, punta» llena nombre,
 * fecha y posición. Parte por comas, punto y coma o renglones; en cada pedazo
 * busca primero la fecha, después una opción de las preguntas pendientes y por
 * último el nombre. Las preguntas de texto libre no se leen así (su respuesta
 * es el mensaje entero). Pura.
 */
export function leerVarias(texto: string | null | undefined, pendientes: PreguntaProspecto[], ahora: Date): Leidas {
    const r: Leidas = { respuestas: {} };
    const pend = (clave: string) => pendientes.some((p) => p.clave === clave) && !(clave in r.respuestas);
    const conOpciones = pendientes.filter((p) => p.tipo === 'botones' || p.tipo === 'lista');
    const fechaP = pendientes.find((p) => p.tipo === 'fecha');
    for (let seg of String(texto ?? '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
        if (fechaP && pend(fechaP.clave)) {
            const f = leerFechaNacimiento(seg, ahora);
            if (f) {
                r.respuestas[fechaP.clave] = f.fecha ? f.fecha : String(f.anio);
                if (fechaP.clave === 'fecha_nacimiento') { r.fechaNacimiento = f.fecha; r.anio = f.anio; }
                seg = seg.replace(f.coincidencia, ' ').replace(/\s+/g, ' ').trim();
                if (!seg) continue;
            }
        }
        let usado = false;
        for (const p of conOpciones) {
            if (!pend(p.clave)) continue;
            const o = opcionDeTexto(seg, p);
            if (o) { r.respuestas[p.clave] = o.titulo; usado = true; break; }
        }
        if (usado) continue;
        if (pend('nombre')) {
            const varios = leerVariosDeportistas(seg);
            if (varios) {
                r.respuestas.nombre = varios[0]; r.nombre = varios[0];
                r.respuestas.otros_deportistas = varios.slice(1).join(', '); r.otros = varios.slice(1);
                continue;
            }
            const leido = leerNombreDeDeportista(seg, ahora);
            if (leido) { r.respuestas.nombre = leido.nombre; r.nombre = leido.nombre; }
        }
    }
    return r;
}

/** «Sí, claro» / «No, gracias» escritos. Pura. */
export function siNoDeTexto(texto: string | null | undefined): 'si' | 'no' | null {
    const n = normalizar(texto).replace(/\s+/g, ' ').trim();
    if (!n) return null;
    if (/^(no|nop|no gracias|mejor no|no por ahora|no me escribas|no quiero)\b/.test(n)) return 'no';
    if (n.split(' ').length <= 5 && /^(si|claro|dale|ok|okay|listo|de una|bueno|vale|por favor|perfecto|si claro|si senor|si senora)\b/.test(n)) return 'si';
    return null;
}

/** ¿Escribió una sede? Por nombre, por una palabra propia («Suba», «la del norte») o por la dirección («calle 152»). Pura. */
export function leerSede(texto: string | null | undefined, botones: BotonSede[], sedes: SedeEmbudo[]): string | null {
    const n = normalizar(texto);
    if (!n || n.split(' ').length > 10) return null;
    const GENERICAS = new Set(['sede', 'la', 'el', 'del', 'de', 'las', 'los', 'club', 'escuela']);
    const coinciden = botones.filter((b) => {
        const s = sedes.find((x) => x.branchId === b.branchId);
        const palabras = new Set([...normalizar(sinEmojis(b.titulo)).split(' '), ...normalizar(s?.nombre).split(' ')]
            .filter((w) => w.length >= 3 && !GENERICAS.has(w)));
        if ([...palabras].some((w) => new RegExp(`(^| )${escapar(w)}( |$)`).test(n))) return true;
        const dir = normalizar(s?.direccion);
        // «calle 152», «cll 152», «la 201»: el número de la vía principal.
        const via = dir.match(/^(calle|cl|cll|carrera|cra|kr|avenida|av|diagonal|dg|transversal|tv)\s*(\d+)/);
        return !!via && new RegExp(`(^| )${via[2]}( |$|[a-z])`).test(n);
    });
    return coinciden.length === 1 ? coinciden[0].branchId : null;
}

/** El lead que se guarda, con las claves reservadas fuera de `respuestas`. Pura. */
export function leadDeDatos(d: DatosEmbudo, grupo: GrupoEmbudo | null): LeadEmbudo {
    const respuestas: Record<string, string> = {};
    for (const [k, v] of Object.entries(d.respuestas ?? {})) if (!CLAVES_RESERVADAS.has(k)) respuestas[k] = v;
    return {
        deportista: d.nombre ?? d.respuestas?.nombre ?? '',
        fechaNacimiento: d.fechaNacimiento ?? null,
        anio: d.anio ?? null,
        genero: d.genero ?? null,
        branchId: d.branchId ?? null,
        teamId: grupo?.teamId ?? null,
        grupo: grupo?.nombre ?? null,
        respuestas,
    };
}

/**
 * `completo` de `registrarLeadDeProspecto` para el lead del embudo. Integración
 * lo usa en el `guardarLead` del contexto (con los textos y el nombre del
 * contacto, como la puerta). Pura.
 */
export function leadCompletoDeEmbudo(l: LeadEmbudo) {
    const hoy = new Date().getUTCFullYear();
    return {
        deportista: l.deportista, fechaNacimiento: l.fechaNacimiento,
        edad: l.anio ? hoy - l.anio : null, categoriaSugerida: l.grupo, quiere: 'clase_prueba',
        branchId: l.branchId, teamId: l.teamId, genero: l.genero, respuestas: l.respuestas, via: 'embudo' as const,
    };
}

// ─── Mensajes ────────────────────────────────────────────────────────────────

function botonesDePregunta(p: PreguntaProspecto): { botones?: BotonInteractivo[]; enTexto?: string } {
    if (!p.opciones?.length) return {};
    const botones = p.opciones.map((o, j) => ({
        id: `${BOTON_EMBUDO.OPCION}${p.clave}:${j}`,
        title: recortar(o.titulo, p.tipo === 'lista' ? 24 : 20),
        ...(o.descripcion ? { descripcion: o.descripcion } : {}),
        // Una lista con 3 opciones o menos saldría como botones: la sección la fuerza.
        ...(p.tipo === 'lista' ? { seccion: recortar(p.boton ?? 'Opciones', 24) } : {}),
    }));
    const enTexto = p.tipo === 'lista'
        ? `${p.opciones.map((o, j) => `${j + 1}. ${o.titulo}`).join('\n')}\nResponde con el número o el nombre.`
        : `Responde ${p.opciones.map((o) => `*${o.titulo}*`).join(', ').replace(/, ([^,]*)$/, ' o $1')}.`;
    return { botones, enTexto };
}

/** ¿El texto ya trae su número («1️⃣ ¿Cuál es…», «2. ¿…»)? Entonces no se le pone otro. */
const YA_NUMERADA = /\d\uFE0F?\u20E3|\u{1F51F}|^\s*\d{1,2}[.)]\s/u;

function textoPregunta(preguntas: PreguntaProspecto[], i: number): string {
    const t = preguntas[i].texto;
    return YA_NUMERADA.test(t) ? t : `${NUMEROS[i] ?? `${i + 1}.`} ${t}`;
}

/**
 * «Te hago 5 preguntas rápidas». Vacío si la escuela ya lo escribió en su primera
 * pregunta (Monster: «Para ubicarte… te hago 5 preguntas rápidas 🙌\n\n1️⃣ ¿Cuál…»).
 */
function introPreguntas(preguntas: PreguntaProspecto[]): string {
    if (/\bpreguntas?\b/.test(normalizar(preguntas[0]?.texto))) return '';
    const n = preguntas.length;
    return n === 1 ? 'Para ubicarte en la categoría correcta te hago una pregunta rápida 🙌'
        : `Para ubicarte en la categoría correcta te hago ${n} preguntas rápidas 🙌`;
}

async function seguro<T>(f: () => Promise<T> | T | undefined): Promise<T | null> {
    try { return ((await f()) as T) ?? null; } catch { return null; }
}

/** Línea de cada sede con su dirección, si la bienvenida no la dice ya. Pura. */
export function lineasDeSedes(bienvenida: string, botones: BotonSede[], sedes: SedeEmbudo[]): string[] {
    const b = normalizar(bienvenida);
    const renglones = bienvenida.split('\n').map(normalizar);
    return botones.flatMap((bt) => {
        const s = sedes.find((x) => x.branchId === bt.branchId);
        const dir = String(s?.direccion ?? '').trim();
        if (!dir || b.includes(normalizar(dir))) return [];
        // La bienvenida de la escuela ya trae la sede con SU dirección («🟡 *Sede Norte* ·
        // Calle 201 #67-12»): repetirla con el formato de la base («AV. El Polo, Cl. 201…») confunde.
        const nombre = normalizar(sinEmojis(bt.titulo));
        if (nombre && renglones.some((r) => r.includes(nombre) && /\d/.test(r))) return [];
        return [`${bt.titulo} · ${dir}`];
    });
}

/** Bienvenida con los botones de sede (≤ 2 sedes = botones; más = lista) y «Ya soy del club». Pura. */
export function mensajeDeBienvenida(
    bienvenida: string | null, botones: BotonSede[], sedes: SedeEmbudo[], saludo = '',
): { texto: string; botones: BotonInteractivo[]; enTexto: string } {
    const propia = !!bienvenida;
    const base = bienvenida ?? `${saludo ? `${saludo}\n\n` : '¡Hola! 👋 Gracias por escribirnos.\n\n'}¿Cuál sede te queda más cerca?`;
    const lineas = lineasDeSedes(base, botones, sedes);
    const texto = [base, lineas.join('\n')].filter(Boolean).join('\n\n')
        + (propia && !base.includes('?') ? '\n\n¿Cuál sede te queda más cerca?' : '');
    const lista = botones.length > 2;
    const opciones: BotonInteractivo[] = [
        ...botones.map((b) => ({
            id: `${BOTON_EMBUDO.SEDE}${b.branchId}`, title: b.titulo,
            ...(lista ? { seccion: 'Sedes' } : {}),
        })),
        { id: BOTON_PUERTA.CLUB, title: 'Ya soy del club', ...(lista ? { seccion: 'Sedes' } : {}) },
    ];
    const enTexto = `Responde ${[...botones.map((b) => `*${sinEmojis(b.titulo)}*`), '*Ya soy del club*'].join(', ').replace(/, ([^,]*)$/, ' o $1')}.`;
    return { texto, botones: opciones, enTexto };
}

// ─── Motor ───────────────────────────────────────────────────────────────────

const hoyDe = (ctx: CtxEmbudo) => (ctx.ahora ?? (() => new Date()))();

// Una lectura de ajustes por turno (Disk IO): el contexto vive lo que dura el turno.
const memo = new WeakMap<CtxEmbudo, { aj?: Promise<AjustesWhatsAppEscuela>; clase?: Promise<AjustesClasePrueba | null> }>();
function memoDe(ctx: CtxEmbudo) {
    let m = memo.get(ctx);
    if (!m) { m = {}; memo.set(ctx, m); }
    return m;
}
const ajustesDe = (ctx: CtxEmbudo) => (memoDe(ctx).aj ??= ctx.ajustes());
const claseDe = (ctx: CtxEmbudo) => (memoDe(ctx).clase ??= seguro(() => ctx.clase()));

/**
 * Arranca el embudo (primer mensaje de un interesado). false = la escuela no
 * tiene embudo (quien llama sigue con lo de siempre). `saludo`: la
 * presentación de 24 h o ''. `step`: el del primer mensaje (el bot usa el de
 * «primera respuesta al prospecto» para su freno de 30 días).
 */
export async function iniciarEmbudo(ctx: CtxEmbudo, opciones: { saludo?: string; step?: string } = {}): Promise<boolean> {
    const aj = await ajustesDe(ctx);
    if (!embudoActivo(aj)) return false;
    const preguntas = aj.preguntasProspecto!;
    const botones = aj.botonesSede ?? null;
    const step = opciones.step ?? PASO_EMBUDO.BIENVENIDA;
    const contexto = aj.bienvenida ? { texto_de_la_escuela: true } : undefined;
    const sedes = botones?.length ? (await seguro(() => ctx.sedes(botones.map((b) => b.branchId)))) ?? [] : [];
    if (botones && botones.length > 1) {
        const m = mensajeDeBienvenida(aj.bienvenida ?? null, botones, sedes, opciones.saludo ?? '');
        await ctx.enviar(m.texto, step, { paso: 'sede', datos: {} }, m.botones, m.enTexto, contexto);
        return true;
    }
    // Sin pregunta de sede, o con UNA sola (no hay nada que elegir: antes salía un botón de
    // sede solo junto a «Ya soy del club»): la sede queda fijada y la bienvenida va junto a la
    // primera pregunta. «Ya soy del club» sigue como botón si esa pregunta no trae los suyos;
    // si los trae, escribirlo también lleva a la puerta (`leerOpcionDePuerta`).
    const unica = botones?.length === 1 ? botones[0] : null;
    const base = aj.bienvenida ?? (opciones.saludo || '¡Hola! 👋 Gracias por escribirnos.');
    const lineaSede = unica ? lineasDeSedes(base, [unica], sedes).join('\n') : '';
    const p0 = preguntas[0];
    const b = botonesDePregunta(p0);
    const conClub = !b.botones;
    await ctx.enviar([base, lineaSede, introPreguntas(preguntas), textoPregunta(preguntas, 0)].filter(Boolean).join('\n\n'), step,
        { paso: 'pregunta', datos: { i: 0, respuestas: {}, ...(unica ? { branchId: unica.branchId, sedeTitulo: unica.titulo } : {}) } },
        conClub ? [{ id: BOTON_PUERTA.CLUB, title: 'Ya soy del club' }] : b.botones,
        conClub ? 'Si ya eres del club, responde *Ya soy del club*.' : b.enTexto, contexto);
    return true;
}

/**
 * Turno del embudo. true = lo resolvió este módulo. false = no era para acá
 * (sin flujo abierto, botón de otra cosa, pide una persona, o texto que es otra
 * conversación): sigue el bot de siempre.
 */
export async function atenderTurnoEmbudo(ctx: CtxEmbudo, textoCrudo: string, botonId: string | null): Promise<boolean> {
    const texto = (textoCrudo || '').trim();
    // «Ya soy del club» tocado: lo atiende la puerta por su id.
    if (botonId === BOTON_PUERTA.CLUB) return false;
    const boton = botonDePlantilla(botonId) ?? botonId;
    const estado = await (ctx.leerEstado ?? leerEstadoDeEmbudoDeSupabase)(ctx.conversationId);

    // Botones que valen con o sin estado (los manda B4, una plantilla o un job).
    if (boton === BOTON_EMBUDO.OPTIN_SI || boton === BOTON_EMBUDO.OPTIN_NO) {
        return responderConsentimiento(ctx, estado, boton === BOTON_EMBUDO.OPTIN_SI);
    }
    if (boton === BOTON_EMBUDO.CAMBIAR || boton === BOTON_EMBUDO.REPROGRAMAR) return ofrecerCambio(ctx, estado);
    if (boton === BOTON_EMBUDO.AHI_ESTAREMOS) {
        await ctx.enviar('¡Súper! Nos vemos en la cancha 🙌', PASO_EMBUDO.AGENDADA,
            estado ? { paso: 'agendada', datos: estado.datos } : null);
        return true;
    }

    if (!estado) {
        if (boton?.startsWith(BOTON_EMBUDO.SEDE)) {
            const aj = await ajustesDe(ctx);
            if (!embudoActivo(aj)) return false;
            return elegirSede(ctx, aj, boton.slice(BOTON_EMBUDO.SEDE.length), {});
        }
        if (boton?.startsWith(BOTON_EMBUDO.FRANJA)) return franjaSinEstado(ctx, boton.slice(BOTON_EMBUDO.FRANJA.length));
        if (!boton) return textoSinEstado(ctx, texto);
        return false;
    }
    // Con flujo abierto, un botón de OTRA cosa es una elección explícita: se suelta.
    if (boton && !esBotonEmbudo(boton)) return false;
    // «Necesito hablar con alguien» escrito = el botón «Hablar con alguien»: se le confirma
    // y la escuela recibe lo que ya contó. Antes se soltaba al bot general, que con un
    // número desconocido se queda callado (batería qa:embudo, 2026-10-31).
    if (!boton && quiereSalirDelFlujo(texto)) return aPersona(ctx, estado.datos, 'pide_persona', null);
    if (!boton && leerOpcionDePuerta(texto) === 'club' && (estado.paso === 'sede' || estado.paso === 'pregunta')) {
        if (!ctx.yaSoyDelClub) return false;
        await ctx.yaSoyDelClub();
        return true;
    }
    if (boton === BOTON_EMBUDO.PERSONA) return aPersona(ctx, estado.datos, 'pide_persona', null);

    const aj = await ajustesDe(ctx);
    if (!embudoActivo(aj)) return false;
    // «Y para matricularla qué tengo que hacer?» con el flujo abierto (Monster 2026-11-03):
    // caía al bot general, que contestaba con el modelo («paga ya la matrícula») o se
    // quedaba callado. Se contesta acá, sin perder el paso en que va.
    if (!boton && pideMatricula(texto) && await responderMatricula(ctx, aj, estado, texto)) return true;
    switch (estado.paso) {
        case 'sede': return pasoSede(ctx, aj, estado, texto, boton);
        case 'pregunta': return pasoPregunta(ctx, aj, estado, texto, boton);
        case 'detalle': return pasoDetalle(ctx, aj, estado, texto);
        case 'otra_sede': return pasoOtraSede(ctx, aj, estado, texto, boton);
        case 'elegir_franja': return pasoFranja(ctx, estado, texto, boton);
        case 'consentimiento': return pasoConsentimiento(ctx, estado, texto, boton);
        case 'esperando_pago':
        case 'agendada':
        case 'reprogramar':
            // «Cambiar horario» escrito; lo demás (una pregunta, el comprobante) es del bot general / B4,
            // que nunca deja en silencio a quien pasó por el embudo (`acuseDelEmbudo` del bot).
            if (!boton && pideCambioDeHorario(texto)) return ofrecerCambio(ctx, estado);
            // «¿Dónde queda?» con la clase elegida: la cancha de ESA franja. El bot general
            // contestaba con la dirección de la escuela (la de Suba a una familia de la Norte).
            if (!boton && preguntaDonde(texto)) return responderDonde(ctx, estado);
            return false;
        default: return false;
    }
}

// ── Sede ────────────────────────────────────────────────────────────────────

async function pasoSede(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, estado: EstadoEmbudo, texto: string, boton: string | null): Promise<boolean> {
    const botones = aj.botonesSede ?? [];
    if (boton?.startsWith(BOTON_EMBUDO.SEDE)) return elegirSede(ctx, aj, boton.slice(BOTON_EMBUDO.SEDE.length), estado.datos);
    if (!botones.length) return elegirSede(ctx, aj, null, estado.datos);
    const sedes = (await seguro(() => ctx.sedes(botones.map((b) => b.branchId)))) ?? [];
    const branchId = leerSede(texto, botones, sedes);
    if (branchId) return elegirSede(ctx, aj, branchId, estado.datos);
    // Una pregunta (también sin «?»: «cuanto vale la mensualidad») o una frase larga es
    // otra conversación: la contesta el bot general.
    if (texto.includes('?') || texto.split(/\s+/).length > 7 || esOtroTema(texto)) return false;
    const intentos = (estado.datos.intentos ?? 0) + 1;
    if (intentos >= MAX_INTENTOS) return aPersona(ctx, estado.datos, 'no_entendio', 'No eligió sede.');
    const m = mensajeDeBienvenida(null, botones, [], '');
    await ctx.enviar('Elige la sede que te queda más cerca 👇', PASO_EMBUDO.BIENVENIDA,
        { paso: 'sede', datos: { ...estado.datos, intentos } }, m.botones, m.enTexto);
    return true;
}

async function elegirSede(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, branchId: string | null, datos: DatosEmbudo): Promise<boolean> {
    const preguntas = aj.preguntasProspecto!;
    const boton = branchId ? (aj.botonesSede ?? []).find((b) => b.branchId === branchId) : null;
    if (branchId && !boton) return false; // un botón de sede que la escuela ya no tiene
    const d: DatosEmbudo = {
        ...datos, branchId: boton?.branchId ?? null, sedeTitulo: boton?.titulo ?? null,
        i: 0, respuestas: datos.respuestas ?? {}, intentos: 0,
    };
    const siguiente = siguientePendiente(preguntas, d.respuestas!, 0);
    const encabezado = [boton ? `¡Genial, ${boton.titulo}! 🙌` : '', introPreguntas(preguntas)].filter(Boolean).join('\n');
    if (siguiente == null) return terminarPreguntas(ctx, aj, d, encabezado);
    return preguntar(ctx, preguntas, { ...d, i: siguiente }, encabezado);
}

// ── Preguntas ───────────────────────────────────────────────────────────────

function siguientePendiente(preguntas: PreguntaProspecto[], respuestas: Record<string, string>, desde: number): number | null {
    for (let j = desde; j < preguntas.length; j++) if (!(preguntas[j].clave in respuestas)) return j;
    return null;
}

async function preguntar(ctx: CtxEmbudo, preguntas: PreguntaProspecto[], d: DatosEmbudo, encabezado = ''): Promise<boolean> {
    const i = d.i ?? 0;
    const b = botonesDePregunta(preguntas[i]);
    await ctx.enviar(`${encabezado ? `${encabezado}\n\n` : ''}${textoPregunta(preguntas, i)}`, PASO_EMBUDO.PREGUNTA,
        { paso: 'pregunta', datos: d }, b.botones, b.enTexto);
    return true;
}

function pista(p: PreguntaProspecto): string {
    if (p.clave === 'nombre') return 'No alcancé a leer el nombre. Escríbeme el *nombre y apellido* del deportista (por ejemplo: Sofía Gómez).';
    if (p.tipo === 'fecha') return 'Necesito la *fecha de nacimiento* (por ejemplo 14/03/2011) o al menos el *año* (2011).';
    if (p.opciones?.length) return 'Elige una de las opciones 👇';
    return `${p.texto}`;
}

/** Aplica lo leído a los datos (y el género de la opción de sexo). Pura. */
function aplicar(d: DatosEmbudo, l: Leidas, preguntas: PreguntaProspecto[]): DatosEmbudo {
    const r = { ...(d.respuestas ?? {}), ...l.respuestas };
    const sexo = preguntas.find((p) => p.clave === 'sexo');
    return {
        ...d, respuestas: r,
        ...(l.nombre ? { nombre: l.nombre } : {}),
        ...(l.anio ? { anio: l.anio, fechaNacimiento: l.fechaNacimiento ?? null } : {}),
        ...(sexo && r.sexo ? { genero: generoDeTexto(r.sexo) } : {}),
    };
}

async function pasoPregunta(
    ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, estado: EstadoEmbudo, texto: string, boton: string | null,
): Promise<boolean> {
    const preguntas = aj.preguntasProspecto!;
    const i = Math.min(Math.max(estado.datos.i ?? 0, 0), preguntas.length - 1);
    const p = preguntas[i];
    const ahora = hoyDe(ctx);
    let leidas: Leidas = { respuestas: {} };

    if (boton?.startsWith(BOTON_EMBUDO.OPCION)) {
        const [clave, j] = boton.slice(BOTON_EMBUDO.OPCION.length).split(':');
        const q = preguntas.find((x) => x.clave === clave);
        const o = q?.opciones?.[Number(j)];
        if (q && o) leidas.respuestas[q.clave] = o.titulo;
    } else if (boton) {
        return false;
    } else if (p.tipo === 'texto' && p.clave !== 'nombre') {
        // Texto libre: la respuesta es el mensaje entero (con sus comas).
        if (texto.replace(EMOJI, '').trim().length >= 2) leidas.respuestas[p.clave] = recortar(texto, 500);
    } else {
        const pendientes = preguntas.filter((q, j) => j >= i && !(q.clave in (estado.datos.respuestas ?? {}))
            && !(q.tipo === 'texto' && q.clave !== 'nombre'));
        leidas = leerVarias(texto, pendientes, ahora);
        // «3» en una pregunta con opciones = la tercera.
        if (!(p.clave in leidas.respuestas) && p.opciones?.length) {
            const k = leerNumeroOpcion(texto);
            if (k && k >= 1 && k <= p.opciones.length) leidas.respuestas[p.clave] = p.opciones[k - 1].titulo;
        }
    }

    // «cuanto vale la mensualidad» en la pregunta del nombre se leía como nombre («¡Mucho
    // gusto, Cuanto!»). Una pregunta de otro tema sin «?» de la que no salió más que un
    // «nombre» es otra conversación: la contesta el bot y el paso queda donde iba.
    if (!boton && esOtroTema(texto) && Object.keys(leidas.respuestas).every((k) => k === 'nombre')) return false;
    const d = aplicar(estado.datos, leidas, preguntas);
    if (!(p.clave in leidas.respuestas)) {
        // Un mensaje que es otra conversación («¿cuánto vale?») no gasta un intento: lo contesta el bot.
        if (!Object.keys(leidas.respuestas).length && (texto.includes('?') || texto.split(/\s+/).length > 12)) return false;
        // Pidiendo la fecha de nacimiento, otro NOMBRE completo es el segundo deportista que quiere
        // inscribir (Monster 2026-11-09: el segundo nombre recibía «necesito la fecha»): se anota para después
        // y se sigue con el primero, sin gastar un intento.
        if (!boton && p.tipo === 'fecha' && !Object.keys(leidas.respuestas).length && d.nombre && !esOtroTema(texto)) {
            const otro = leerNombreDeDeportista(texto);
            if (otro && otro.nombre.split(' ').length >= 2 && normalizar(otro.nombre) !== normalizar(d.nombre)) {
                const previos = String(d.respuestas?.otros_deportistas ?? '').split(', ').filter(Boolean);
                const todos = [...new Set([...previos, otro.nombre])];
                const d2: DatosEmbudo = { ...d, respuestas: { ...(d.respuestas ?? {}), otros_deportistas: todos.join(', ') } };
                const bb = botonesDePregunta(p);
                await ctx.enviar(`Anoté a *${otro.nombre}* para después 🙌 Sigamos con *${d.nombre}*:

${pista(p)}`, PASO_EMBUDO.PREGUNTA,
                    { paso: 'pregunta', datos: { ...d2, i, intentos: estado.datos.intentos ?? 0 } }, bb.botones, bb.enTexto);
                return true;
            }
        }
        const intentos = (estado.datos.intentos ?? 0) + 1;
        if (intentos >= MAX_INTENTOS) return aPersona(ctx, d, 'no_entendio', `No entendió: «${recortar(p.texto, 80)}».`);
        const b = botonesDePregunta(p);
        await ctx.enviar(pista(p), PASO_EMBUDO.PREGUNTA, { paso: 'pregunta', datos: { ...d, i, intentos } }, b.botones, b.enTexto);
        return true;
    }
    const respondida = d.respuestas![p.clave];
    const aviso2 = leidas.otros?.length
        ? `
Veo que también quieres inscribir a *${leidas.otros.join('* y a *')}* 🙌 Empecemos con *${d.nombre}*; cuando terminemos, me escribes el nombre y hacemos su registro.`
        : '';
    const encabezado = p.clave === 'nombre' && d.nombre ? `¡Mucho gusto, ${primerNombre(d.nombre)}! 😊${aviso2}` : '';
    // Detalle condicional («Club y torneos» → en qué clubes ha entrenado).
    if (p.detalle && !(p.detalle.clave in d.respuestas!)
        && p.detalle.si.some((s) => normalizar(sinEmojis(s)) === normalizar(sinEmojis(respondida)))) {
        await ctx.enviar(p.detalle.texto, PASO_EMBUDO.PREGUNTA, { paso: 'detalle', datos: { ...d, i, intentos: 0 } });
        return true;
    }
    return seguirPreguntando(ctx, aj, { ...d, intentos: 0 }, i + 1, encabezado);
}

async function pasoDetalle(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, estado: EstadoEmbudo, texto: string): Promise<boolean> {
    const preguntas = aj.preguntasProspecto!;
    const i = estado.datos.i ?? 0;
    const det = preguntas[i]?.detalle;
    if (!det) return seguirPreguntando(ctx, aj, estado.datos, i + 1, '');
    if (texto.replace(EMOJI, '').trim().length < 2) {
        const intentos = (estado.datos.intentos ?? 0) + 1;
        if (intentos >= MAX_INTENTOS) return seguirPreguntando(ctx, aj, { ...estado.datos, intentos: 0 }, i + 1, '');
        await ctx.enviar(det.texto, PASO_EMBUDO.PREGUNTA, { paso: 'detalle', datos: { ...estado.datos, intentos } });
        return true;
    }
    const d = { ...estado.datos, respuestas: { ...(estado.datos.respuestas ?? {}), [det.clave]: recortar(texto, 500) }, intentos: 0 };
    return seguirPreguntando(ctx, aj, d, i + 1, '');
}

async function seguirPreguntando(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, d: DatosEmbudo, desde: number, encabezado: string): Promise<boolean> {
    const preguntas = aj.preguntasProspecto!;
    const j = siguientePendiente(preguntas, d.respuestas ?? {}, desde) ?? siguientePendiente(preguntas, d.respuestas ?? {}, 0);
    if (j == null) return terminarPreguntas(ctx, aj, d, encabezado);
    return preguntar(ctx, preguntas, { ...d, i: j }, encabezado);
}

// ── Grupo y horarios ────────────────────────────────────────────────────────

async function textos(ctx: CtxEmbudo): Promise<{ t: TextosClase; clase: AjustesClasePrueba | null }> {
    const clase = await claseDe(ctx);
    const c = { nombre_clase: clase?.nombreClase ?? null, trial_price: clase?.precio ?? null };
    const t = (ctx.textosDeClase ? seguroSync(() => ctx.textosDeClase!(c)) : null) ?? textosPorDefecto(c);
    // Red de seguridad: con valor nunca se dice gratis, aunque el texto inyectado lo diga.
    return { t: t.precio ? { ...t, gratis: false } : t, clase };
}

function seguroSync<T>(f: () => T): T | null {
    try { return f() ?? null; } catch { return null; }
}

/** «INFANTIL FEMENINO» → «Infantil Femenino» (igual que tituloGrupo de grupos-por-edad). Pura. */
export function tituloDeGrupo(nombre: string): string {
    return nombre.trim().toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

/** El rango de B3 → el grupo con que sigue el embudo. Pura. */
export function grupoDeRango(r: RangoEmbudo): GrupoEmbudo {
    const profe = (r.coachNombres ?? []).map((n) => String(n ?? '').trim()).find(Boolean) ?? null;
    return { teamId: r.teamId, nombre: tituloDeGrupo(r.nombre), profe };
}

async function terminarPreguntas(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, d: DatosEmbudo, encabezado: string): Promise<boolean> {
    const eleccion = await seguro(() => ctx.elegirGrupo({ branchId: d.branchId ?? null, anio: d.anio ?? null, genero: d.genero ?? null }));
    if (!eleccion?.principal) return sinGrupo(ctx, aj, d, eleccion);
    const grupo = grupoDeRango(eleccion.principal);
    const leadId = (await seguro(() => ctx.guardarLead(leadDeDatos(d, grupo)))) ?? d.leadId ?? null;
    if (!leadId) return aPersona(ctx, d, 'error', 'No se pudo guardar el registro.');
    const datos: DatosEmbudo = { ...d, leadId, teamId: grupo.teamId, grupo: grupo.nombre, profe: grupo.profe ?? null, intentos: 0 };
    const { t } = await textos(ctx);
    const nombre = primerNombre(d.nombre);
    const sede = d.sedeTitulo ? ` en la ${sinEmojis(d.sedeTitulo)}` : '';
    // «Su profe es…»: sirve igual para Iván que para Tatiana (no hay género del staff).
    const profe = grupo.profe ? `. Su profe es ${grupo.profe.trim()}` : '';
    const porAnio = d.anio ? `Por su año (${d.anio}) a ${nombre || 'tu deportista'}` : `A ${nombre || 'tu deportista'}`;
    const evalua = d.genero === 'f' ? 'la evalúa' : d.genero === 'm' ? 'lo evalúa' : 'evalúa al deportista';
    const valor = t.precio ? `, que cuesta ${t.precio}` : t.gratis ? ', sin costo' : '';
    const cabeza = [
        encabezado,
        `¡Listo! ✨ ${porAnio} le corresponde *${grupo.nombre}*${sede}${profe}.`,
        `Para empezar en el club se agenda una ${t.nombre}${valor}. En ella el entrenador ${evalua} y confirma su grupo y nivel.`,
    ].filter(Boolean).join('\n');
    return ofrecerFranjas(ctx, datos, cabeza);
}

async function sinGrupo(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, d: DatosEmbudo, eleccion: EleccionGrupoEmbudo | null): Promise<boolean> {
    const leadId = (await seguro(() => ctx.guardarLead(leadDeDatos(d, null)))) ?? d.leadId ?? null;
    const datos = { ...d, leadId };
    const nombre = primerNombre(d.nombre) || 'tu deportista';
    // La otra sede la propone B3 (`otraSede`); solo se ofrece si es una de las sedes con botón.
    const otra = eleccion?.otraSede?.branchId
        ? (aj.botonesSede ?? []).find((b) => b.branchId === eleccion.otraSede!.branchId && b.branchId !== d.branchId)
        : undefined;
    const conGrupo: BotonSede[] = otra ? [otra] : [];
    if (!conGrupo.length) {
        return aPersona(ctx, datos, 'sin_grupo', `Sin grupo para ${nombre}${d.anio ? ` (${d.anio})` : ''}.`,
            `No encontré un grupo para ${nombre}${d.anio ? ` (${d.anio})` : ''}${d.sedeTitulo ? ` en la ${sinEmojis(d.sedeTitulo)}` : ''}. ` +
            'Ya le pasé tus datos a la escuela y alguien te responde por aquí 🙌');
    }
    const aqui = d.sedeTitulo ? `En la ${sinEmojis(d.sedeTitulo)}` : 'Aquí';
    await ctx.enviar(
        `${aqui} no tengo un grupo para ${nombre}${d.anio ? ` (${d.anio})` : ''}. En ${conGrupo.map((b) => `la ${sinEmojis(b.titulo)}`).join(' o ')} sí 👇`,
        PASO_EMBUDO.OTRA_SEDE, { paso: 'otra_sede', datos },
        [
            ...conGrupo.slice(0, 2).map((b) => ({ id: `${BOTON_EMBUDO.OTRA_SEDE}${b.branchId}`, title: recortar(`Ver ${sinEmojis(b.titulo)}`, 20) })),
            { id: BOTON_EMBUDO.PERSONA, title: 'Hablar con alguien' },
        ],
        `Responde ${conGrupo.map((b) => `*Ver ${sinEmojis(b.titulo)}*`).join(', ')} o *Hablar con alguien*.`);
    return true;
}

async function pasoOtraSede(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, estado: EstadoEmbudo, texto: string, boton: string | null): Promise<boolean> {
    let branchId = boton?.startsWith(BOTON_EMBUDO.OTRA_SEDE) ? boton.slice(BOTON_EMBUDO.OTRA_SEDE.length) : null;
    if (!branchId && !boton) {
        const otras = (aj.botonesSede ?? []).filter((b) => b.branchId !== estado.datos.branchId);
        const sedes = (await seguro(() => ctx.sedes(otras.map((b) => b.branchId)))) ?? [];
        branchId = leerSede(texto, otras, sedes) ?? (otras.length === 1 && siNoDeTexto(texto) === 'si' ? otras[0].branchId : null);
    }
    const b = branchId ? (aj.botonesSede ?? []).find((x) => x.branchId === branchId) : null;
    if (!b) return false;
    return terminarPreguntas(ctx, aj, { ...estado.datos, branchId: b.branchId, sedeTitulo: b.titulo }, '');
}

async function ofrecerFranjas(ctx: CtxEmbudo, d: DatosEmbudo, encabezado: string): Promise<boolean> {
    if (!d.teamId) return aPersona(ctx, d, 'sin_grupo', 'Sin grupo asignado.');
    const clase = await claseDe(ctx);
    const todas = franjasOfrecibles((await seguro(() => ctx.franjas(d.teamId!))) ?? [], {
        ahora: hoyDe(ctx), diasSemana: clase?.diasSemana ?? null, excluir: d.cambio ? d.slotId : null,
    }).map((f) => ({ ...f, profe: f.profe ?? d.profe ?? null }));
    if (!todas.length) {
        return aPersona(ctx, d, 'sin_horarios', `Sin horarios abiertos para ${d.grupo ?? 'su grupo'}.`,
            `${encabezado ? `${encabezado}\n\n` : ''}Por ahora no tengo horarios abiertos para *${d.grupo ?? 'ese grupo'}*. ` +
            'Ya le pasé tus datos a la escuela y te escriben por aquí para agendar 🙌');
    }
    const desde = Math.min(Math.max(d.desde ?? 0, 0), Math.max(todas.length - 1, 0));
    const porPagina = todas.length - desde > MAX_FILAS ? MAX_FILAS - 1 : MAX_FILAS;
    const pagina = todas.slice(desde, desde + porPagina);
    const hayMas = todas.length > desde + porPagina;
    const filas = pagina.map((f) => filaDeFranja(f, d.grupo ?? null));
    if (hayMas) filas.push({ id: BOTON_EMBUDO.MAS, title: 'Ver más horarios', seccion: filas[0]?.seccion });
    const enTexto = pagina.map((f, k) => `${k + 1}. ${filaDeFranja(f, null).title}${f.lugar ? ` (${f.lugar})` : ''}`).join('\n') +
        '\nResponde con el número del horario.';
    await ctx.enviar(`${encabezado ? `${encabezado}\n\n` : ''}Estos son los próximos horarios 👇`, PASO_EMBUDO.HORARIOS,
        { paso: 'elegir_franja', datos: { ...d, lista: pagina.map((f) => f.id), desde, intentos: 0 } }, filas, enTexto);
    return true;
}

async function pasoFranja(ctx: CtxEmbudo, estado: EstadoEmbudo, texto: string, boton: string | null): Promise<boolean> {
    const d = estado.datos;
    const lista = d.lista ?? [];
    if (boton === BOTON_EMBUDO.MAS || (!boton && /^(ver )?mas( horarios)?$|^otros?( horarios)?$/.test(normalizar(texto)))) {
        return ofrecerFranjas(ctx, { ...d, desde: (d.desde ?? 0) + lista.length }, 'Te muestro más horarios.');
    }
    let slotId: string | null = null;
    if (boton?.startsWith(BOTON_EMBUDO.FRANJA)) slotId = boton.slice(BOTON_EMBUDO.FRANJA.length);
    else if (boton) return false;
    else {
        const k = leerNumeroOpcion(texto);
        if (k && k >= 1 && k <= lista.length) slotId = lista[k - 1];
        else {
            const dia = leerDia(texto);
            if (dia != null) {
                const franjas = ((await seguro(() => ctx.franjas(d.teamId ?? ''))) ?? []).filter((f) => lista.includes(f.id) && partesFecha(f.fecha).dow === dia);
                if (franjas.length === 1) slotId = franjas[0].id;
            }
        }
    }
    if (!slotId) {
        // Otra conversación («cuanto vale la mensualidad», sin «?»): la contesta el bot sin
        // gastar un intento, como en la sede y en las preguntas.
        if (texto.includes('?') || texto.split(/\s+/).length > 7 || esOtroTema(texto)) return false;
        const intentos = (d.intentos ?? 0) + 1;
        if (intentos >= MAX_INTENTOS) return aPersona(ctx, d, 'no_entendio', 'No eligió horario.');
        return ofrecerFranjas(ctx, { ...d, intentos }, 'Elige uno de los horarios de la lista 👇');
    }
    return tomar(ctx, d, slotId);
}

/** Un horario tocado sin estado (lista vieja o de B4): se recupera el lead por teléfono. */
async function franjaSinEstado(ctx: CtxEmbudo, slotId: string): Promise<boolean> {
    const aj = await ajustesDe(ctx);
    if (!embudoActivo(aj)) return false;
    const lead = await seguro(() => ctx.leadDelContacto?.());
    if (!lead?.leadId || !lead.teamId) return false;
    const franjas = (await seguro(() => ctx.franjas(lead.teamId!))) ?? [];
    if (!franjas.some((f) => f.id === slotId)) return ofrecerFranjas(ctx, datosDeLead(lead), 'Ese horario ya no está disponible 😕');
    return tomar(ctx, { ...datosDeLead(lead), cambio: !!(lead.slotId || lead.separadoSlotId) }, slotId);
}

function datosDeLead(l: LeadDelContacto): DatosEmbudo {
    return {
        leadId: l.leadId, nombre: l.nombre, teamId: l.teamId, branchId: l.branchId,
        slotId: l.slotId ?? l.separadoSlotId ?? null, consentimiento: l.consentimiento ?? null, respuestas: {},
        ...(l.pagada ? { pagada: true } : {}),
    };
}

// ── Cupo: agendar o separar ─────────────────────────────────────────────────

async function tomar(ctx: CtxEmbudo, d: DatosEmbudo, slotId: string): Promise<boolean> {
    if (!d.leadId) return aPersona(ctx, d, 'error', 'Sin registro para tomar el cupo.');
    // La franja se lee ANTES de tomar el cupo: si era el último, después ya no sale en la lista.
    const franja = ((await seguro(() => ctx.franjas(d.teamId ?? ''))) ?? []).find((f) => f.id === slotId) ?? null;
    const r = await seguro(() => ctx.tomarCupo(d.leadId!, slotId, { pagada: d.pagada === true }));
    const estado = r?.estado ?? 'error';
    if (estado === 'lleno' || estado === 'cerrada') {
        return ofrecerFranjas(ctx, { ...d, desde: 0 }, `Ese horario ${estado === 'lleno' ? 'se acaba de llenar' : 'ya no está disponible'} 😕 Elige otro:`);
    }
    if (estado === 'error') {
        return aPersona(ctx, d, 'error', 'No se pudo tomar el cupo.',
            'Ya le pasé tus datos a la escuela para que te confirme el horario por aquí 🙌');
    }
    const datos: DatosEmbudo = { ...d, slotId, hasta: r?.hasta ?? null, lista: undefined, desde: undefined, intentos: 0 };
    if (estado === 'agendada') {
        const c = await seguro(() => ctx.confirmarAgenda({ leadId: d.leadId!, slotId, evento: d.cambio ? 'cambiada' : 'agendada' }));
        await ctx.enviar(c?.texto ?? 'Tu clase quedó agendada 🎉 La escuela te confirma los detalles por aquí.',
            PASO_EMBUDO.AGENDADA, { paso: 'agendada', datos });
        const pendiente = (c?.consentimientoPendiente ?? true) && datos.consentimiento !== 'si' && datos.consentimiento !== 'no';
        if (pendiente) {
            await ctx.enviar(PREGUNTA_CONSENTIMIENTO, PASO_EMBUDO.CONSENTIMIENTO,
                { paso: 'consentimiento', datos: { ...datos, siguiente: 'fin' } }, BOTONES_CONSENTIMIENTO, EN_TEXTO_CONSENTIMIENTO);
        }
        return true;
    }
    // Separada: sin cuentas de pago no hay cómo confirmarla → una persona y se suelta el cupo.
    const cuentas = (await seguro(() => ctx.cuentasDePago())) ?? [];
    const { t, clase } = await textos(ctx);
    if (!cuentas.length) {
        await seguro(() => ctx.soltarCupo(d.leadId!));
        return aPersona(ctx, datos, 'sin_cuentas_de_pago', 'La escuela no tiene cuentas de pago cargadas.',
            `Ya le pasé tus datos a la escuela para confirmar la ${t.nombre}${d.nombre ? ` de ${primerNombre(d.nombre)}` : ''}: ` +
            'te escriben por aquí con los datos de pago 🙌');
    }
    // El motivo queda esperado desde ya: si el comprobante llega antes de contestar, B4 lo reconoce igual.
    await seguro(() => (ctx.registrarConceptoEsperado ?? conceptoEsperadoPorDefecto(ctx))({
        motivo: 'clase_prueba', monto: clase?.precio ?? null, leadId: d.leadId!, venceEn: r?.hasta ?? null,
    }));
    const horas = clase?.separarHoras ?? 24;
    const separado = `¡Perfecto! Te separo el cupo del ${franja ? cuandoEs(franja) : 'horario que elegiste'} durante ${horas} horas ⏳`;
    if (datos.consentimiento === 'si' || datos.consentimiento === 'no') {
        return instruccionesDePago(ctx, datos, `${separado}\n\n`);
    }
    await ctx.enviar(`${separado}\n\n${PREGUNTA_CONSENTIMIENTO} Enseguida te paso los datos de pago.`, PASO_EMBUDO.CONSENTIMIENTO,
        { paso: 'consentimiento', datos: { ...datos, siguiente: 'pago' } }, BOTONES_CONSENTIMIENTO, EN_TEXTO_CONSENTIMIENTO);
    return true;
}

/** «3194505150» → «319 450 5150» (celular colombiano); cualquier otro número, como lo escribió la escuela. Pura. */
export function numeroLegible(numero: string): string {
    const crudo = String(numero ?? '').trim();
    const cel = /^(?:57)?(3\d{9})$/.exec(crudo.replace(/[\s()+.-]/g, ''))?.[1];
    return cel ? `${cel.slice(0, 3)} ${cel.slice(3, 6)} ${cel.slice(6)}` : crudo;
}

/**
 * «por Nequi o Daviplata al 319 450 5150, a nombre de Iván Sossa»: TODOS los medios
 * de ese número (Monster recibe por los dos y el bot decía solo «Nequi», 2026-11-08),
 * o la lista de cuentas. Pura.
 */
export function comoPagar(cuentas: CuentaDePagoEmbudo[]): string {
    const numeros = [...new Set(cuentas.map((c) => c.numero.replace(/\D/g, '') || c.numero))];
    if (numeros.length === 1) {
        const tipos = [...new Set(cuentas.map((c) => c.tipo))];
        const titular = cuentas.find((c) => c.titular)?.titular;
        return `por ${tipos.join(', ').replace(/, ([^,]*)$/, ' o $1')} al ${numeroLegible(cuentas[0].numero)}${titular ? `, a nombre de ${titular}` : ''}`;
    }
    return 'a una de estas cuentas:\n' + cuentas.map((c) => `• ${c.tipo}: ${numeroLegible(c.numero)}${c.titular ? ` (a nombre de ${c.titular})` : ''}`).join('\n') + '\n';
}

async function instruccionesDePago(ctx: CtxEmbudo, d: DatosEmbudo, prefijo: string): Promise<boolean> {
    const cuentas = (await seguro(() => ctx.cuentasDePago())) ?? [];
    const { t } = await textos(ctx);
    if (!cuentas.length) {
        if (d.leadId) await seguro(() => ctx.soltarCupo(d.leadId!));
        return aPersona(ctx, d, 'sin_cuentas_de_pago', 'La escuela no tiene cuentas de pago cargadas.');
    }
    const valor = t.precio ? ` (${t.precio})` : '';
    const como = comoPagar(cuentas);
    await ctx.enviar(
        `${prefijo}Para confirmarlo, paga la ${t.nombre}${valor} ${como}${como.endsWith('\n') ? '\n' : ' '}` +
        'y envíame aquí mismo la foto o el PDF del comprobante 📸',
        PASO_EMBUDO.PAGO, { paso: 'esperando_pago', datos: { ...d, siguiente: undefined } });
    return true;
}

// ── Consentimiento ──────────────────────────────────────────────────────────

export const PREGUNTA_CONSENTIMIENTO = '¿Te puedo escribir por aquí el recordatorio de la clase y las novedades del club?';
export const BOTONES_CONSENTIMIENTO: BotonInteractivo[] = [
    { id: BOTON_EMBUDO.OPTIN_SI, title: 'Sí, claro' },
    { id: BOTON_EMBUDO.OPTIN_NO, title: 'No, gracias' },
];
const EN_TEXTO_CONSENTIMIENTO = 'Responde *Sí, claro* o *No, gracias*.';

async function pasoConsentimiento(ctx: CtxEmbudo, estado: EstadoEmbudo, texto: string, boton: string | null): Promise<boolean> {
    if (boton) return false; // los botones del consentimiento se atienden arriba; otro botón es otra cosa
    const r = siNoDeTexto(texto);
    if (r) return responderConsentimiento(ctx, estado, r === 'si');
    // No contestó: con el pago pendiente se le dan los datos igual (sin registrar el «sí»).
    if (estado.datos.siguiente === 'pago') return instruccionesDePago(ctx, estado.datos, '');
    return false;
}

async function responderConsentimiento(ctx: CtxEmbudo, estado: EstadoEmbudo | null, si: boolean): Promise<boolean> {
    if (si) await seguro(() => ctx.registrarOptIn());
    let datos: DatosEmbudo = estado?.datos ?? {};
    if (!datos.leadId) {
        const lead = await seguro(() => ctx.leadDelContacto?.());
        if (lead) datos = { ...datosDeLead(lead), ...datos, leadId: lead.leadId };
    }
    if (datos.leadId && ctx.marcarLead) {
        await seguro(() => ctx.marcarLead!(datos.leadId!, { consentimiento: si ? 'si' : 'no', consentimiento_at: hoyDe(ctx).toISOString() }));
    }
    datos = { ...datos, consentimiento: si ? 'si' : 'no' };
    if (estado?.paso === 'consentimiento' && estado.datos.siguiente === 'pago') {
        return instruccionesDePago(ctx, datos, si ? '¡Listo! 🙌 ' : 'Entendido. ');
    }
    await ctx.enviar(si
        ? '¡Listo! 🙌 Te escribo antes de la clase para recordártela.'
        : 'Entendido, no te enviaré recordatorios. ¡Nos vemos en la cancha!',
    PASO_EMBUDO.AGENDADA, datos.leadId ? { paso: 'agendada', datos: { ...datos, siguiente: undefined } } : null);
    return true;
}

// ── Cambiar horario (sin volver a cobrar) ───────────────────────────────────

/**
 * «Quiero cambiar el horario», «necesito cambiar de día», «no puedo ir»: pide otro
 * horario (con o sin artículo: antes «necesito cambiar el horario» no entraba). Pura.
 */
export function pideCambioDeHorario(texto: string | null | undefined): boolean {
    const n = normalizar(texto).replace(/^((hola|buenas|buenos dias|buenas tardes|buenas noches|profe|disculpa|perdon|oye) )+/, '');
    const art = '(de |el |la |mi |su |los |las |del )?';
    return new RegExp(`\\b(cambiar(la|lo)?|cambio|mover(la|lo)?) ${art}(horario|dia|fecha|hora|clase)\\b`).test(n)
        || new RegExp(`\\b(otro|otra) ${art}(horario|dia|fecha|hora)\\b`).test(n)
        || /\breprogramar(la|lo)?\b/.test(n)
        || /^(no|ya no) (puedo|podemos|voy a poder|vamos a poder|podre|podremos|alcanzo|alcanzamos) (ir|asistir|llegar)\b/.test(n);
}

async function ofrecerCambio(ctx: CtxEmbudo, estado: EstadoEmbudo | null, conocido?: LeadDelContacto | null): Promise<boolean> {
    const aj = await ajustesDe(ctx);
    if (!embudoActivo(aj)) return false;
    let d: DatosEmbudo = estado?.datos ?? {};
    if (!d.leadId || !d.teamId) {
        const lead = conocido ?? await seguro(() => ctx.leadDelContacto?.());
        if (!lead?.leadId) return false;
        d = { ...datosDeLead(lead), ...d, leadId: d.leadId ?? lead.leadId, teamId: d.teamId ?? lead.teamId };
    }
    if (!d.teamId) return aPersona(ctx, d, 'sin_grupo', 'Pidió cambiar el horario y no tiene grupo asignado.');
    // «No tienes que pagar de nuevo» solo con la clase ya pagada (la confirmó B4): esperando
    // el pago, o con una clase sin valor, la frase prometía algo que no aplica.
    return ofrecerFranjas(ctx, { ...d, cambio: true, desde: 0 },
        d.pagada ? 'Claro, elige el nuevo horario. No tienes que pagar de nuevo 🙌' : 'Claro 🙌 Elige el nuevo horario.');
}

/**
 * Texto de un interesado SIN flujo abierto (vencido a las 24 h, o el último saliente
 * fue otra cosa) que ya tiene su clase: «quiero cambiar el horario», «¿y la
 * matrícula?» y «¿dónde queda?» se atienden con su lead, igual que los botones de las
 * plantillas. Antes caían al bot general: las franjas de cortesía de todos los grupos
 * o la dirección de la otra sede. Lo demás sigue siendo del bot general.
 */
async function textoSinEstado(ctx: CtxEmbudo, texto: string): Promise<boolean> {
    const cambio = pideCambioDeHorario(texto);
    const matricula = !cambio && pideMatricula(texto);
    if (!cambio && !matricula && !preguntaDonde(texto)) return false;
    const aj = await ajustesDe(ctx);
    if (!embudoActivo(aj)) return false;
    const lead = await seguro(() => ctx.leadDelContacto?.());
    if (!lead?.leadId) return false;
    if (cambio) return ofrecerCambio(ctx, null, lead);
    const paso: PasoEmbudo | null = lead.slotId ? 'agendada' : lead.separadoSlotId ? 'esperando_pago' : null;
    if (!paso) return false;
    const estado: EstadoEmbudo = { paso, datos: datosDeLead(lead) };
    return matricula ? responderMatricula(ctx, aj, estado, texto) : responderDonde(ctx, estado);
}

// ── Dónde es la clase ───────────────────────────────────────────────────────

/** «¿Dónde queda?», «la dirección», «¿cómo llego?». Pura. */
export function preguntaDonde(texto: string | null | undefined): boolean {
    return /\b(donde (queda|quedan|es|son|sera|seria|esta|estan|entrenan|practican|juegan)|en donde|direccion|ubicacion|ubicados|como (llego|llegar|llegamos)|que (lugar|sitio|cancha|parque|colegio))\b/
        .test(normalizar(texto));
}

/**
 * «La clase de prueba de Mariana es el sábado 7 de noviembre a las 8:00 a. m. en
 * 📍 Colegio La Enseñanza · Calle …», con el enlace de Maps y las indicaciones de
 * la cancha si están cargados. null si no se sabe el lugar (nunca se inventa). Pura.
 */
export function textoDonde(l: LugarDeClase, t: Pick<TextosClase, 'nombre'>, nombre: string | null | undefined): string | null {
    const lugar = [l.lugar, l.direccion].map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ');
    if (!lugar) return null;
    const quien = primerNombre(nombre);
    return [
        `La ${t.nombre}${quien ? ` de *${quien}*` : ''} es el ${cuandoEs(l)} en:`,
        `📍 ${lugar}`,
        l.mapsUrl ? `Cómo llegar: ${l.mapsUrl}` : '',
        l.indicaciones ?? '',
    ].filter(Boolean).join('\n');
}

async function responderDonde(ctx: CtxEmbudo, estado: EstadoEmbudo): Promise<boolean> {
    const d = estado.datos;
    if (!d.slotId || !ctx.lugarDeLaClase) return false;
    const l = await seguro(() => ctx.lugarDeLaClase!(d.slotId!));
    const { t } = await textos(ctx);
    const texto = l ? textoDonde(l, t, d.nombre ?? d.respuestas?.nombre) : null;
    if (!texto) return false;
    await ctx.enviar(texto, PASO_EMBUDO.DONDE, { paso: estado.paso, datos: d });
    return true;
}

// ── Matrícula (después de la clase) ─────────────────────────────────────────
//
// Monster 2026-11-03: tras la clase de prueba el profe da su feedback y la escuela
// define el grupo; recién ahí se matricula. Al interesado que lo pregunta con el
// flujo abierto se le dice eso (nunca «paga ya la matrícula») y la escuela recibe
// el aviso con lo que contó, porque es alguien que ya quiere quedarse.

const MATRICULA = /\b(matricul\w*|inscrib\w*|inscripcion(es)?)\b/;
const PIDE_PRECIO = /\b(cuanto|cuantos|valor(es)?|precios?|costos?|vale|valen|cuesta|cuestan|tarifas?)\b/;
const PIDE_ALGO = new RegExp('\\b(quiero|queremos|quisiera|quisieramos|deseo|deseamos|como|cual|cuales|cuando|donde|'
    + 'proceso|pasos?|requisitos?|puedo|podemos|se puede|hay que|que (tengo|tenemos|hay|debo|debemos|necesito|necesitamos|sigue))\\b');

/**
 * ¿Pregunta por la matrícula o la inscripción? «quiero matricularla», «¿y para
 * inscribirlo qué hago?». No cuentan el precio («¿cuánto vale la matrícula?»: lo
 * contesta el bot con los valores) ni contarlo («estuvo matriculada en otro
 * club», la respuesta a la trayectoria). Pura.
 */
export function pideMatricula(texto: string | null | undefined): boolean {
    const crudo = String(texto ?? '');
    const n = normalizar(crudo);
    if (!MATRICULA.test(n) || PIDE_PRECIO.test(n)) return false;
    return crudo.includes('?') || PIDE_ALGO.test(n);
}

/** «matricularla» / «inscribirlo»: el género que dice el verbo. Pura. */
function generoDelVerbo(texto: string): 'f' | 'm' | null {
    const n = normalizar(texto);
    if (/\b(matricular|inscribir)la\b/.test(n)) return 'f';
    if (/\b(matricular|inscribir)lo\b/.test(n)) return 'm';
    return null;
}

/**
 * «La matrícula se hace después de la clase de prueba: el profe evalúa a
 * Mariana, la escuela te confirma el grupo y te escribe por aquí para
 * matricularla 🙌». Con el nombre de la clase de la escuela. Pura.
 */
export function textoDeMatricula(t: Pick<TextosClase, 'nombre'>, nombre: string | null | undefined, genero: 'f' | 'm' | null | undefined): string {
    const quien = primerNombre(nombre) || 'tu deportista';
    const para = genero === 'f' ? 'matricularla' : genero === 'm' ? 'matricularlo' : 'hacer la matrícula';
    return `La matrícula se hace después de la ${t.nombre}: el profe evalúa a ${quien}, ` +
        `la escuela te confirma el grupo y te escribe por aquí para ${para} 🙌`;
}

/** Cómo va la clase, para el aviso. */
function estadoDeLaClase(paso: PasoEmbudo, d: DatosEmbudo): string {
    if (paso === 'esperando_pago' || (paso === 'consentimiento' && d.siguiente === 'pago')) return 'cupo separado, falta el pago';
    if (paso === 'agendada' || paso === 'consentimiento') return 'agendada';
    if (paso === 'reprogramar') return 'por reprogramar';
    return 'todavía sin agendar (está en el registro)';
}

/** El aviso a la escuela: qué pidió y lo que el interesado ya contó. Pura. */
export function detalleDeMatricula(paso: PasoEmbudo, d: DatosEmbudo, texto: string): string {
    const nombre = d.nombre ?? d.respuestas?.nombre ?? null;
    return [
        `Pide la matrícula: «${recortar(texto, 160)}».`,
        nombre ? `Deportista: ${nombre}${d.anio ? ` (${d.anio})` : ''}.` : '',
        d.grupo ? `Grupo: ${d.grupo}.` : '',
        d.sedeTitulo ? `Sede: ${sinEmojis(d.sedeTitulo)}.` : '',
        `Clase de prueba: ${estadoDeLaClase(paso, d)}.`,
    ].filter(Boolean).join(' ');
}

/**
 * Contesta lo de la matrícula y sigue donde iba: con la clase ya elegida queda en
 * el mismo paso (el consentimiento pendiente se vuelve a preguntar); en el
 * registro, la respuesta va encima de la pregunta o la lista que tocaba. false =
 * un paso donde no aplica (lo atiende lo de siempre). Avisa a la escuela una vez
 * por flujo.
 */
async function responderMatricula(ctx: CtxEmbudo, aj: AjustesWhatsAppEscuela, estado: EstadoEmbudo, texto: string): Promise<boolean> {
    const paso = estado.paso;
    const botonesSede = aj.botonesSede ?? [];
    const aplica = ['esperando_pago', 'agendada', 'reprogramar', 'consentimiento', 'pregunta', 'elegir_franja'].includes(paso)
        || (paso === 'sede' && botonesSede.length > 0);
    if (!aplica) return false;
    let d = estado.datos;
    // El estado que dejan los jobs (recordatorio, confirmación de B4) no trae el nombre: el lead sí.
    if (!d.nombre && !d.respuestas?.nombre) {
        const lead = await seguro(() => ctx.leadDelContacto?.());
        if (lead?.nombre) d = { ...d, nombre: lead.nombre, leadId: d.leadId ?? lead.leadId };
    }
    const { t } = await textos(ctx);
    const respuesta = textoDeMatricula(t, d.nombre ?? d.respuestas?.nombre, d.genero ?? generoDelVerbo(texto));
    if (!d.matriculaAvisada) await seguro(() => ctx.avisarEscuela('pide_matricula', detalleDeMatricula(paso, d, texto)));
    const datos: DatosEmbudo = { ...d, matriculaAvisada: true };
    if (paso === 'consentimiento') {
        await ctx.enviar(`${respuesta}\n\n${PREGUNTA_CONSENTIMIENTO}`, PASO_EMBUDO.MATRICULA,
            { paso, datos }, BOTONES_CONSENTIMIENTO, EN_TEXTO_CONSENTIMIENTO);
        return true;
    }
    if (paso === 'pregunta') {
        const preguntas = aj.preguntasProspecto!;
        const i = Math.min(Math.max(datos.i ?? 0, 0), preguntas.length - 1);
        return preguntar(ctx, preguntas, { ...datos, i }, respuesta);
    }
    if (paso === 'elegir_franja') return ofrecerFranjas(ctx, datos, respuesta);
    if (paso === 'sede') {
        const m = mensajeDeBienvenida(null, botonesSede, [], '');
        await ctx.enviar(`${respuesta}\n\nPara empezar, elige la sede que te queda más cerca 👇`, PASO_EMBUDO.BIENVENIDA,
            { paso, datos }, m.botones, m.enTexto);
        return true;
    }
    await ctx.enviar(respuesta, PASO_EMBUDO.MATRICULA, { paso, datos });
    return true;
}

// ── Paso a una persona ──────────────────────────────────────────────────────

async function aPersona(ctx: CtxEmbudo, d: DatosEmbudo, motivo: MotivoPersona, detalle: string | null, texto?: string): Promise<boolean> {
    // Lo que haya queda en el lead: la escuela lo ve en Deportistas → Clase de prueba.
    if (!d.leadId && (d.nombre || Object.keys(d.respuestas ?? {}).length)) {
        await seguro(() => ctx.guardarLead(leadDeDatos(d, null)));
    }
    await ctx.enviar(texto ?? 'Listo, ya pasé tus datos a la escuela y alguien te responde por aquí 🙌', PASO_EMBUDO.A_PERSONA, null);
    await seguro(() => ctx.avisarEscuela(motivo, [d.nombre ? `Interesado: ${d.nombre}.` : '', detalle ?? ''].filter(Boolean).join(' ') || null));
    return true;
}

// ─── Integración con la base (defaults para el contexto) ─────────────────────

/** Salientes que se miran hacia atrás buscando el estado (dentro de la vigencia). */
const SALIENTES_PARA_ESTADO = 8;

/** Un saliente (o borrador) visto por `estadoDeSalientes`. */
export interface SalienteDeEstado {
    payload: Record<string, any> | null;
    /** Lo escribió una persona de la escuela (`ai_generated = false`). */
    humano?: boolean;
}

/**
 * El estado del embudo según los salientes, del más nuevo al más viejo. Lo decide
 * el último saliente que «sabe» de flujos: el del embudo con su paso; otro flujo,
 * un cierre del embudo (step `embudo_*` sin estado) o una persona de la escuela lo
 * cierran. Las respuestas sueltas del bot a una pregunta en medio (el modelo con
 * la ficha, el acuse, la dirección) NO lo cierran: antes el estado era solo el
 * último saliente y «¿qué debo llevar?» contestado por el modelo dejaba al
 * interesado fuera del embudo (su «quiero matricularla» o «cambiar horario»
 * siguiente ya no lo atendía nadie). Pura.
 */
export function estadoDeSalientes(salientes: SalienteDeEstado[]): EstadoEmbudo | null {
    for (const s of salientes) {
        const p = s.payload ?? {};
        if (p.flujo === FLUJO_EMBUDO && p.paso_embudo) return { paso: p.paso_embudo, datos: p.datos_embudo ?? {} };
        const step = String(p.step ?? '');
        if (s.humano || p.flujo || step.startsWith('embudo_') || step === 'escalated') return null;
        // Lo que contesta la cola a un comprobante (B4) sin estado: el paso guardado («esperando
        // el pago») ya no vale. Sin estado, lo que escriba después lo atiende el embudo con el lead
        // (`textoSinEstado`: agendada, y si fue con pago).
        if (/^(clase_prueba_|comprobante_)/.test(step) || step === 'resultado_comprobante') return null;
    }
    return null;
}

/** Estado = el de los últimos salientes del bot (y borradores pendientes) en la vigencia. Nunca lanza. */
export async function leerEstadoDeEmbudoDeSupabase(conversationId: string): Promise<EstadoEmbudo | null> {
    try {
        const desde = new Date(Date.now() - VIGENCIA_FLUJO_EMBUDO_MS).toISOString();
        const [msgs, borradores] = await Promise.all([
            supabase.from('whatsapp_messages').select('payload, created_at, ai_generated')
                .eq('conversation_id', conversationId).eq('direction', 'outbound').gte('created_at', desde)
                .order('created_at', { ascending: false }).limit(SALIENTES_PARA_ESTADO),
            supabase.from('whatsapp_message_drafts').select('tool_context, created_at')
                .eq('conversation_id', conversationId).eq('status', 'pending').gte('created_at', desde)
                .order('created_at', { ascending: false }).limit(SALIENTES_PARA_ESTADO),
        ]);
        const filas = [
            ...(((msgs as any)?.data ?? []) as any[]).map((m) => ({ payload: m.payload, humano: m.ai_generated === false, en: m.created_at })),
            ...(((borradores as any)?.data ?? []) as any[]).map((b) => ({ payload: b.tool_context, humano: false, en: b.created_at })),
        ].sort((a, b) => new Date(b.en).getTime() - new Date(a.en).getTime());
        return estadoDeSalientes(filas);
    } catch {
        return null;
    }
}

/** El payload que deja el estado en un saliente (para el `enviar` del contexto y los jobs). Pura. */
export function payloadDeEstado(estado: EstadoEmbudo | null): Record<string, unknown> {
    return estado ? { flujo: FLUJO_EMBUDO, paso_embudo: estado.paso, datos_embudo: estado.datos } : {};
}

/**
 * Para el recordatorio de la víspera (recordatorio-cortesia, plantilla
 * `recordatorio_clase_prueba`): con este `payloadExtra`, «Cambiar horario» y
 * «No puedo ir» de la plantilla los atiende el embudo. Pura.
 */
export function estadoParaRecordatorio(leadId: string, teamId: string | null, slotId: string | null): Record<string, unknown> {
    return payloadDeEstado({ paso: 'agendada', datos: { leadId, teamId, slotId } });
}

/**
 * B4 `registrarConceptoEsperado(schoolId, telefono, { motivo, monto, leadId, venceEn })`.
 * Import dinámico con especificador variable: si el módulo no existe (B4 sin
 * integrar) se sigue sin él.
 */
function conceptoEsperadoPorDefecto(ctx: CtxEmbudo) {
    return async (p: { motivo: 'clase_prueba'; monto: number | null; leadId: string; venceEn: string | null }) => {
        const ruta = './wa-concepto-esperado.service';
        const mod: any = await import(ruta).catch(() => null);
        if (typeof mod?.registrarConceptoEsperado !== 'function') return;
        await mod.registrarConceptoEsperado(ctx.schoolId, ctx.contactWaId, {
            motivo: p.motivo, ...(p.monto != null ? { monto: p.monto } : {}), leadId: p.leadId,
            ...(p.venceEn ? { venceEn: p.venceEn } : {}),
        });
    };
}

/** `wa_register_optin` del interesado: fuente `bot_prospecto`, prueba = el mensaje del «Sí, claro». Nunca lanza. */
export async function registrarOptInProspecto(p: {
    integrationId: string; schoolId: string; contactWaId: string; waMessageId: string;
}): Promise<void> {
    try {
        const { error } = await supabase.rpc('wa_register_optin', {
            p_integration_id: p.integrationId,
            p_school_id: p.schoolId,
            p_contact_wa_id: p.contactWaId,
            p_source: 'bot_prospecto',
            p_source_ref: p.waMessageId,
            p_parent_id: null,
            p_opt_out: false,
        });
        if (error) console.warn('[wa-embudo] wa_register_optin falló', { err: error.message });
    } catch { /* el consentimiento no tumba la respuesta */ }
}

/**
 * Lo que respondería `tomar_cupo_clase_prueba` en un turno simulado, con su misma
 * regla (mig. 20261030123543): agenda si la clase no tiene valor, si la escuela no
 * fijó horas para separar (`cobraClaseEnElBot`) o si el lead ya la pagó (cambio de
 * horario tras pagar); en el resto separa por esas horas. Antes separaba siempre
 * que hubiera valor y la batería veía un cobro que la RPC no hace. Pura.
 */
export function cupoSimulado(
    clase: Pick<AjustesClasePrueba, 'precio' | 'separarHoras'> | null, ahora = Date.now(), o: { pagada?: boolean } = {},
): ResultadoCupo {
    if (!clase || !cobraClaseEnElBot(clase) || o.pagada) return { estado: 'agendada', hasta: null };
    return { estado: 'separada', hasta: new Date(ahora + clase.separarHoras! * 3600_000).toISOString() };
}

/**
 * Lo que el contexto lee de la base (Integración suma `enviar`, `avisarEscuela`,
 * `guardarLead`, `registrarOptIn`, `elegirGrupo` y, si quiere, `textosDeClase` y
 * `franjas` de B3). Imports dinámicos: cargar el motor no arrastra la agenda.
 */
export function depsEmbudoDeSupabase(schoolId: string, contactWaId: string): Pick<CtxEmbudo,
    'ajustes' | 'clase' | 'sedes' | 'franjas' | 'tomarCupo' | 'soltarCupo' | 'cuentasDePago'
    | 'confirmarAgenda' | 'marcarLead' | 'leadDelContacto' | 'leerEstado' | 'lugarDeLaClase'> {
    return {
        ajustes: async () => (await import('./whatsapp-ajustes-escuela.service')).ajustesWhatsAppDeEscuela(schoolId),
        clase: async () => (await import('./whatsapp-ajustes-escuela.service')).ajustesClasePrueba(schoolId),
        sedes: async (ids) => {
            if (!ids.length) return [];
            const { data } = await supabase.from('school_branches').select('id, name, address').eq('school_id', schoolId).in('id', ids);
            return ((data ?? []) as any[]).map((s) => ({ branchId: s.id, nombre: s.name ?? null, direccion: s.address ?? null }));
        },
        franjas: (teamId) => franjasDeEquipo(schoolId, teamId),
        tomarCupo: async (leadId, slotId, o) => {
            // Número de pruebas y batería de escenarios: la RPC escribe, el cortafuegos la
            // bloquea y el motor se quedaba en «no se pudo» sin mostrar el pago.
            if (enCortafuegos()) {
                const { ajustesClasePrueba } = await import('./whatsapp-ajustes-escuela.service');
                return cupoSimulado(await ajustesClasePrueba(schoolId), Date.now(), { pagada: o?.pagada });
            }
            return (await import('./clase-prueba-agenda.service')).tomarCupo(leadId, slotId);
        },
        soltarCupo: async (leadId) => {
            if (enCortafuegos()) return;
            await (await import('./clase-prueba-agenda.service')).soltarCupo(leadId);
        },
        cuentasDePago: async () => {
            const { mediosDePago } = await import('./whatsapp-medios-de-pago.service');
            // 'clase_prueba' todavía no es categoría de payment-accounts (B4): las llaves
            // restringidas a otra cosa no se ofrecen; las generales sí.
            const m = await mediosDePago(schoolId, { categoria: 'clase_prueba' as any });
            return m.cuentas.map((c) => ({ tipo: c.tipo, numero: c.numero, titular: c.titular }));
        },
        confirmarAgenda: async (p) => (await import('./clase-prueba-agenda.service'))
            .confirmarClaseAgendada({ schoolId, leadId: p.leadId, slotId: p.slotId, evento: p.evento, contactWaId }),
        marcarLead: async (leadId, extra) => {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) return; // 'lead-simulado' (pruebas)
            await (await import('./whatsapp-prospecto-lead.service')).avanzarEtapaLead(leadId, 'respondido', extra);
        },
        leadDelContacto: async () => {
            const l = await (await import('./whatsapp-prospecto-lead.service')).leadDelEmbudo(schoolId, contactWaId);
            return l;
        },
        leerEstado: leerEstadoDeEmbudoDeSupabase,
        // La misma cancha, dirección y Maps de la confirmación de la clase (facilities por nombre).
        lugarDeLaClase: async (slotId) => (await import('./clase-prueba-agenda.service')).franjaDeAgenda(schoolId, slotId),
    };
}

/**
 * Franjas abiertas con cupo de un equipo, desde hoy, sin las sesiones que el
 * profe canceló o movió en «Mi semana» (team_schedule_exceptions; sin la tabla,
 * todas). Nunca lanza.
 */
export async function franjasDeEquipo(schoolId: string, teamId: string): Promise<FranjaEmbudo[]> {
    try {
        const hoy = ahoraBogota(new Date()).fecha;
        const { data, error } = await supabase.from('school_trial_slots')
            .select('id, team_id, slot_date, start_time, end_time, location, max_capacity, reserved_count')
            .eq('school_id', schoolId).eq('team_id', teamId).eq('is_open', true).gte('slot_date', hoy)
            .order('slot_date', { ascending: true }).order('start_time', { ascending: true }).limit(60);
        if (error || !Array.isArray(data)) return [];
        const filas = (data as any[]).filter((r) => Number(r.reserved_count ?? 0) < Number(r.max_capacity ?? 0));
        let canceladas = new Set<string>();
        if (filas.length) {
            const { data: exc, error: e2 } = await supabase.from('team_schedule_exceptions')
                .select('team_id, fecha, tipo, hora_original').eq('team_id', teamId).in('tipo', ['cancelada', 'movida'])
                .gte('fecha', hoy).limit(200);
            if (!e2 && Array.isArray(exc) && exc.length) {
                const { franjasAfectadas } = await import('./clase-prueba-agenda.service');
                canceladas = new Set(franjasAfectadas(
                    (exc as any[]).map((e) => ({ ...e, fecha: String(e.fecha).slice(0, 10) })), filas,
                ).map((a) => a.slot.id));
            }
        }
        return filas.filter((r) => !canceladas.has(r.id)).map((r) => ({
            id: r.id, fecha: String(r.slot_date).slice(0, 10), horaInicio: String(r.start_time).slice(0, 5),
            horaFin: r.end_time ? String(r.end_time).slice(0, 5) : null, lugar: r.location ?? null,
            cupos: Number(r.max_capacity) - Number(r.reserved_count ?? 0),
        }));
    } catch {
        return [];
    }
}
