/**
 * plataforma-wa-avisos — los avisos que YA existen, también por el canal de
 * plataforma (spec canal-whatsapp-plataforma, D10).
 *
 * Cada función recibe lo que el evento original ya calculó (título, cuerpo,
 * lista, informe) y solo lo traduce a texto libre + plantilla. No recalcula
 * nada: si el aviso in-app dice «3 comprobantes», este dice lo mismo.
 *
 * Plantillas (bff/whatsapp-templates/plataforma/, UTILITY es_CO, botón URL
 * https://app.sportmaps.co/{{1}}):
 *   sm_comprobantes_por_revisar  {{1}} escuela · {{2}} cantidad · {{3}} espera
 *   sm_caso_por_atender          {{1}} escuela · {{2}} qué pasó
 *   sm_clase_cortesia_novedad    {{1}} escuela · {{2}} qué pasó
 *   sm_resumen_diario            {{1}} escuela · {{2}} resumen
 *   sm_informe_cartera_semanal   {{1}} escuela · {{2}} familias · {{3}} total · {{4}} comprobantes
 *
 * D9: nada se aprueba desde WhatsApp. Los textos nombran acciones de la app;
 * el único botón es «Ver en la app».
 */

import {
    avisarPorPlataforma, nombreDeEscuela, canalHabilitado, type AvisoPlataforma, type ResultadoAviso,
} from './plataforma-wa.service';

export const PLANTILLAS_PLATAFORMA = {
    comprobantes: 'sm_comprobantes_por_revisar',
    caso: 'sm_caso_por_atender',
    cortesia: 'sm_clase_cortesia_novedad',
    resumen: 'sm_resumen_diario',
    cartera: 'sm_informe_cartera_semanal',
} as const;

const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

/** «45 min», «3 h», «2 días». Pura (misma regla que receipt-review-alerts). */
export function espera(ms: number): string {
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h`;
    return `${Math.floor(h / 24)} días`;
}

/** Envuelve: nunca lanza y no hace nada con el flag apagado. */
async function despachar(armar: () => Promise<AvisoPlataforma | null>): Promise<ResultadoAviso | null> {
    if (!(await canalHabilitado())) return null;
    try {
        const a = await armar();
        return a ? await avisarPorPlataforma(a) : null;
    } catch (e: any) {
        console.warn('[plataforma-wa-avisos] no se pudo armar el aviso', { err: e?.message || String(e) });
        return null;
    }
}

function enSegundoPlano(armar: () => Promise<AvisoPlataforma | null>): void {
    // `despachar` revisa el interruptor (variable o base).
    void despachar(armar);
}

// ─── Comprobantes por validar (receipt-review-alerts.job) ───────────────────

export interface EntradaComprobantes {
    schoolId: string;
    /** Versión reclamada en school_receipt_review_alerts: única por aviso. */
    version: number;
    titulo: string;
    mensaje: string;
    /** Cuántos hay por validar y cuándo entró el más antiguo (ISO). */
    total: number;
    masAntiguo: string | null;
}

export function avisoDeComprobantes(e: EntradaComprobantes, escuela: string, ahora = Date.now()): AvisoPlataforma {
    const esperaTxt = e.masAntiguo ? espera(ahora - (Date.parse(e.masAntiguo) || ahora)) : '0 min';
    return {
        tipo: 'comprobantes',
        schoolId: e.schoolId,
        clave: `comprobantes:${e.schoolId}:v${e.version}`,
        texto: `*${e.titulo}* — ${escuela}\n${e.mensaje}\n\nSe aprueban en SportMaps → Gestión de pagos.`,
        ruta: '/payments-automation?tab=recurrent',
        plantilla: { nombre: PLANTILLAS_PLATAFORMA.comprobantes, variables: [escuela, String(e.total), esperaTxt] },
    };
}

export function avisarComprobantesPorPlataforma(e: EntradaComprobantes, ahora = Date.now()): void {
    enSegundoPlano(async () => avisoDeComprobantes(e, await nombreDeEscuela(e.schoolId), ahora));
}

// ─── Escalaciones y retiros (whatsapp-escalaciones.service) ─────────────────

export interface EntradaCaso {
    schoolId: string;
    conversationId: string;
    ancla: string;
    etapa: 'inicial' | 'reaviso';
    urgente: boolean;
    retiro: boolean;
    titulo: string;
    cuerpo: string;
}

export function avisoDeCaso(e: EntradaCaso, escuela: string): AvisoPlataforma {
    return {
        tipo: e.retiro ? 'retiro' : 'escalacion',
        schoolId: e.schoolId,
        clave: `caso:${e.conversationId}:${e.ancla}:${e.etapa}`,
        urgente: e.urgente,
        texto: `${e.urgente ? '🚨 ' : ''}*${e.titulo}* — ${escuela}\n${e.cuerpo}`,
        ruta: `/whatsapp?conversacion=${encodeURIComponent(e.conversationId)}`,
        plantilla: { nombre: PLANTILLAS_PLATAFORMA.caso, variables: [escuela, e.titulo] },
    };
}

export function avisarCasoPorPlataforma(e: EntradaCaso): void {
    enSegundoPlano(async () => avisoDeCaso(e, await nombreDeEscuela(e.schoolId)));
}

// ─── Clases de cortesía (cortesia-reservas.service) ──────────────────────────

export interface EntradaCortesia {
    schoolId: string;
    /** claveAviso(a) de cortesia-reservas: la misma de la notificación in-app. */
    clave: string;
    titulo: string;
    cuerpo: string;
}

export function avisoDeCortesia(e: EntradaCortesia, escuela: string): AvisoPlataforma {
    return {
        tipo: 'cortesia',
        schoolId: e.schoolId,
        clave: e.clave,
        texto: `*${e.titulo}* — ${escuela}\n${e.cuerpo}`,
        ruta: '/whatsapp?tab=cortesias',
        plantilla: { nombre: PLANTILLAS_PLATAFORMA.cortesia, variables: [escuela, `${e.titulo}: ${e.cuerpo}`] },
    };
}

export function avisarCortesiaPorPlataforma(e: EntradaCortesia): void {
    enSegundoPlano(async () => avisoDeCortesia(e, await nombreDeEscuela(e.schoolId)));
}

// ─── Resumen diario 7:00 (whatsapp-resumen-diario.job) ──────────────────────

export interface EntradaResumen {
    schoolId: string;
    escuela: string;
    fecha: string;
    /** Las mismas partes del asunto del correo: «3 familia(s) sin respuesta», … */
    partes: string[];
    /** Cortesías de HOY, ya formateadas («9:00 a. m. · Sofía — Sub 12»). */
    cortesiasDeHoy: string[];
}

export function avisoDeResumen(e: EntradaResumen): AvisoPlataforma {
    const lineas = [
        `Buenos días ☀️ Resumen de *${e.escuela}* (${e.fecha}):`,
        ...e.partes.map((p) => `• ${p}`),
        ...(e.cortesiasDeHoy.length ? ['', '*Clases de cortesía de hoy*', ...e.cortesiasDeHoy.slice(0, 8).map((c) => `• ${c}`)] : []),
    ];
    return {
        tipo: 'resumen_diario',
        schoolId: e.schoolId,
        clave: `resumen:${e.schoolId}:${e.fecha}`,
        texto: lineas.join('\n'),
        ruta: '/whatsapp?tab=conversaciones',
        plantilla: { nombre: PLANTILLAS_PLATAFORMA.resumen, variables: [e.escuela, e.partes.join(', ')] },
    };
}

export function avisarResumenPorPlataforma(e: EntradaResumen): void {
    if (!e.partes.length) return;
    enSegundoPlano(async () => avisoDeResumen(e));
}

// ─── Informe de cartera de los lunes (informe-cartera.service) ──────────────

export interface EntradaCartera {
    schoolId: string;
    escuela: string;
    lunes: string;
    familiasEnMora: number;
    totalEnMora: number;
    comprobantesEnRevision: number;
}

/** D11: solo cifras. Ni nombres ni teléfonos de familias. */
export function avisoDeCartera(e: EntradaCartera): AvisoPlataforma {
    return {
        tipo: 'informe_cartera',
        schoolId: e.schoolId,
        clave: `cartera:${e.schoolId}:${e.lunes}`,
        texto: [
            `📊 Informe de cartera de *${e.escuela}* (semana del ${e.lunes}):`,
            `• ${e.familiasEnMora} familia(s) en mora por ${cop(e.totalEnMora)}`,
            `• ${e.comprobantesEnRevision} comprobante(s) de pago en revisión`,
            '',
            'El detalle por familia está en SportMaps → Finanzas.',
        ].join('\n'),
        ruta: '/finances',
        plantilla: {
            nombre: PLANTILLAS_PLATAFORMA.cartera,
            variables: [e.escuela, String(e.familiasEnMora), cop(e.totalEnMora), String(e.comprobantesEnRevision)],
        },
    };
}

export function avisarCarteraPorPlataforma(e: EntradaCartera): void {
    enSegundoPlano(async () => avisoDeCartera(e));
}

// ─── Resumen de pagos por validar (pagos-por-validar.job) ───────────────────
//
// APAGADO a propósito (2026-11-08): el canal de plataforma no está conectado.
// Además de este flag tienen que cumplirse los gates de `avisarPorPlataforma`
// (canal habilitado y activo, escuela habilitada, suscripción activa con
// `avisar_comprobantes`). Para encenderlo: PAGOS_POR_VALIDAR_WA_ENABLED=true en
// el BFF de producción, con el canal de plataforma ya conectado (spec
// canal-whatsapp-plataforma) y la escuela suscrita a `avisar_comprobantes`.
//
// Reusa la plantilla `sm_comprobantes_por_revisar` ({{1}} escuela · {{2}}
// cantidad · {{3}} espera): no hace falta aprobar otra en Meta.

/** ¿Sale el resumen de pagos por validar por WhatsApp? Solo con PAGOS_POR_VALIDAR_WA_ENABLED=true. Pura. */
export function pagosPorValidarWaHabilitado(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.PAGOS_POR_VALIDAR_WA_ENABLED === 'true';
}

export interface EntradaPagosPorValidar {
    schoolId: string;
    escuela: string;
    /** 'YYYY-MM-DD' de Colombia. */
    fecha: string;
    tramo: 'manana' | 'tarde';
    /** Los mismos título y mensaje del aviso in-app. */
    titulo: string;
    mensaje: string;
    total: number;
    /** «4 días», «30 h». */
    esperaMasAntiguo: string;
}

export function avisoDePagosPorValidar(e: EntradaPagosPorValidar): AvisoPlataforma {
    return {
        tipo: 'comprobantes',
        schoolId: e.schoolId,
        // Misma clave que la reserva del correo: un aviso por escuela, día y tramo.
        clave: `pagos_por_validar:${e.schoolId}:${e.fecha}:${e.tramo}`,
        texto: `*${e.titulo}* — ${e.escuela}\n${e.mensaje}\n\nSe aprueban en SportMaps → Gestión de pagos.`,
        ruta: '/payments-automation?tab=recurrent',
        plantilla: {
            nombre: PLANTILLAS_PLATAFORMA.comprobantes,
            variables: [e.escuela, String(e.total), e.esperaMasAntiguo],
        },
    };
}

/** Dispara y se olvida. Devuelve si se intentó (false = flag apagado, no sale nada). */
export function avisarPagosPorValidarPorPlataforma(
    e: EntradaPagosPorValidar, env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (!pagosPorValidarWaHabilitado(env)) return false;
    enSegundoPlano(async () => avisoDePagosPorValidar(e));
    return true;
}
