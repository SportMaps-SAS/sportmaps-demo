/**
 * plataforma-wa-pruebas-simular — lo que el número de pruebas no hacía (B7 de
 * docs/specs/whatsapp-monster-requerimientos.md): comprobantes (foto o PDF),
 * plantillas y los jobs programados que le escriben a un interesado o a una
 * familia. Sirve para recorrer una escuela que todavía no conectó su número
 * (Monster´s Volley Club) antes de conectarlo.
 *
 * Misma regla que el turno simulado (plataforma-wa-pruebas.service): todo corre
 * dentro de `conCortafuegos`, con la conversación de la sesión en memoria.
 * Lecturas reales; ninguna escritura llega a la base ni a storage, y nada sale
 * por Graph. El tester recibe una burbuja 🧪 con lo que el bot HARÍA:
 *
 *   foto / PDF     → la MISMA lectura (`extractReceipt`) y el MISMO motor de
 *                    decisión de la recuperación (`procesarComprobanteRecuperado`
 *                    con `aplicar: false`, que usa `resolverPago` como el
 *                    worker): monto, fecha, referencia, banco, destino contra las
 *                    cuentas de la escuela y con qué cobro lo emparejaría. Para un
 *                    prospecto, antes, el camino del worker con un número sin
 *                    ficha (`comprobanteDeNumeroSinFicha`).
 *   /plantilla(s)  → el catálogo (`CONCEPTOS` + bff/whatsapp-templates/*.json)
 *                    con las variables llenas con datos de la escuela.
 *   /avanzar <job> → el texto que mandaría cada job, con los constructores de
 *                    esos servicios, y si de verdad saldría (ventana de 24 h,
 *                    horario, plantilla, consentimiento).
 *
 * El archivo se baja FUERA del cortafuegos (Graph está bloqueado adentro) y con
 * el token del canal de la plataforma: el número de la escuela no existe.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../config/supabase';
import { conCortafuegos, type ContextoCortafuegos, type Fila } from '../config/cortafuegos-simulacion';
import {
    downloadMedia, type BotonInteractivo, type ParsedInboundMessage, type WhatsAppIntegration,
} from './whatsapp.service';
import { integracionDePlataforma, type CanalPlataforma } from './plataforma-wa.service';
import {
    CONCEPTOS, renderizarCuerpo, ventanaAbierta, dentroDeHorarioDeCobranza,
    type ConceptoCobro, type DatosCobro,
} from './whatsapp-plantillas.service';
import type { SesionPrueba } from './plataforma-wa-pruebas.service';
import type { OcrResult } from './ocr.service';
import type { SalidaSimulada } from './whatsapp-bot.service';
import type { FilaReciente } from './whatsapp-reglas-turno';
import type { FranjaCortesia } from './whatsapp-clase-cortesia.service';
import type { DecisionRecuperacion, Familia } from './whatsapp-recuperacion.service';
import type { PagoPendiente } from './whatsapp-receipt-matching.service';

const cop = (n: number) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n)}`;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
const momento = (f: { wa_timestamp?: string | null; created_at?: string | null }) =>
    new Date(f.wa_timestamp || f.created_at || 0).getTime();

// ─── Escenario ───────────────────────────────────────────────────────────────

/** Lo que necesita cualquier simulación: la sesión, la integración (sin token) y la conversación. */
export interface EscenarioPrueba {
    sesion: SesionPrueba;
    integ: WhatsAppIntegration;
    conversationId: string;
    ahora: number;
}

/** Contexto del cortafuegos con una COPIA de la conversación en memoria. */
function contextoDeLectura(sesion: SesionPrueba): ContextoCortafuegos {
    const memoria: Record<string, Fila[]> = {};
    for (const [t, filas] of Object.entries(sesion.estado.tablas ?? {})) memoria[t] = (filas ?? []).map((f) => ({ ...f }));
    return {
        memoria,
        bloqueadas: [],
        // Igual que el turno simulado: nadie dio consentimiento y nadie está bloqueado.
        rpc: { wa_can_send_template: () => false, wa_is_blocked: () => false },
    };
}

/** Los mensajes de la conversación simulada, del más nuevo al más viejo (como `mensajesRecientes`). */
function mensajesDeMemoria(sesion: SesionPrueba): FilaReciente[] {
    return ((sesion.estado.tablas?.whatsapp_messages ?? []) as FilaReciente[])
        .slice().sort((a, b) => momento(b) - momento(a));
}

/** Lo que escribió el contacto en los últimos `min` minutos (pista de pago, como `textosDelContacto`: 15 min antes). */
function textosRecientesDelContacto(sesion: SesionPrueba, ahora: number, min = 15): string[] {
    return mensajesDeMemoria(sesion)
        .filter((m) => m.direction === 'inbound' && ahora - momento(m) <= min * 60_000)
        .map((m) => String(m.text_body ?? '').trim())
        .filter(Boolean);
}

function ultimoEntrante(sesion: SesionPrueba): string | null {
    const m = mensajesDeMemoria(sesion).find((f) => f.direction === 'inbound');
    return m ? (m.wa_timestamp || m.created_at || null) : null;
}

/** Fecha y hora en Bogotá, legible: «jueves 30 de octubre, 6:00 p. m.». */
function cuandoBogota(ms: number): string {
    const d = new Date(ms - 5 * 3600_000);
    const dia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][d.getUTCDay()];
    const hh = d.getUTCHours();
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${dia} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}, ${h12}:${mm} ${hh >= 12 ? 'p. m.' : 'a. m.'}`;
}

/** Instante (ms) de una fecha y hora de Bogotá (UTC-5 todo el año). */
function instanteBogota(fechaIso: string, hora: string): number {
    const [hh, mm] = String(hora).split(':').map(Number);
    return Date.parse(`${fechaIso}T00:00:00.000Z`) + ((hh || 0) * 60 + (mm || 0) + 5 * 60) * 60_000;
}

// ─── Comprobantes ────────────────────────────────────────────────────────────

/** ¿Es un adjunto que la cola de comprobantes leería? Foto o documento (PDF). Pura. */
export function esAdjuntoDeComprobante(msg: Pick<ParsedInboundMessage, 'type' | 'mediaId'>): boolean {
    return (msg.type === 'image' || msg.type === 'document') && Boolean(msg.mediaId);
}

/**
 * Baja el archivo con el token del canal de la plataforma (el tester le
 * escribió al número de SportMaps). FUERA del cortafuegos: adentro Graph está
 * bloqueado. No se guarda en ningún bucket.
 */
export async function bajarAdjuntoDePrueba(
    canal: CanalPlataforma, mediaId: string,
): Promise<{ ok: true; base64: string; mime: string } | { ok: false; error: string }> {
    const r = await downloadMedia(integracionDePlataforma(canal), mediaId);
    if (!r.ok || !r.base64) return { ok: false, error: r.error ?? 'no se pudo bajar' };
    return { ok: true, base64: r.base64, mime: r.mimeType ?? 'image/jpeg' };
}

export type DestinoLeido = 'general' | 'restringida' | 'fuera_de_sportmaps' | 'ajena' | null;

/** Camino del worker con un número sin ficha (`comprobanteDeNumeroSinFicha`). */
export type CaminoSinFicha = 'no_es_pago' | 'bandeja_fuera' | 'bandeja_ajena' | 'silencio' | 'sigue';

/**
 * Espejo de `comprobanteDeNumeroSinFicha` (whatsapp-queue.job): a un número sin
 * ficha solo se le escribe si el dinero fue a una cuenta general de la escuela,
 * o si habló de un pago y el destino no es ajeno. Pura.
 */
export function caminoSinFicha(e: { parece: boolean; destino: DestinoLeido; hablaDePago: boolean }): CaminoSinFicha {
    if (!e.parece) return 'no_es_pago';
    if (e.destino === 'fuera_de_sportmaps') return 'bandeja_fuera';
    if (e.destino === 'ajena') return 'bandeja_ajena';
    if (e.destino !== 'general' && !e.hablaDePago) return 'silencio';
    return 'sigue';
}

/** Qué hace el bot con cada decisión (worker: `continuarComoComprobante`). */
const QUE_HARIA: Record<DecisionRecuperacion, string> = {
    en_revision: 'Lo pone en ese cobro y queda *en revisión* de la escuela (se aprueba solo si la escuela tiene la auto-aprobación prendida y el veredicto da verde).',
    abono_en_revision: 'Lo pone en ese cobro como *abono*, en revisión de la escuela.',
    ya_registrado: 'Le dice que ese pago ya estaba registrado; no toca ningún cobro.',
    no_es_comprobante: 'No es un comprobante: si hay contexto de pago le pide la pantalla de «transferencia exitosa»; si no, no contesta.',
    es_listado: 'Es un listado de movimientos: le pide el comprobante de esa transferencia sola.',
    destino_ajeno: 'El dinero no fue a una cuenta de la escuela: no lo aplica y queda en la bandeja.',
    fuera_de_sportmaps: 'Pago a una cuenta «por fuera de SportMaps»: le dice que eso se maneja con la escuela y no lo registra.',
    sin_pendientes: 'No hay cobro pendiente donde ponerlo: «no tienes cobros pendientes» y queda en la bandeja de la escuela.',
    varios_cobros: 'Varios cobros posibles y nada desempata: le pregunta a cuál va (botones).',
    monto_distinto: 'El monto no le sirve al cobro: queda en la bandeja de la escuela.',
    otro_concepto: 'Nombra otro concepto (uniforme, torneo…) sin cobro creado: queda en la bandeja de la escuela.',
    familia_sin_cuenta: 'Familia sin cuenta ni ficha con ese número: «se lo paso a la escuela» y queda en la bandeja.',
    numero_ambiguo: 'El número está en más de una cuenta: queda en la bandeja.',
    sin_familia: 'No sabe de qué deportista es.',
    enviado_por_equipo: 'Lo mandó alguien que administra la escuela: queda en la bandeja.',
    archivo_no_disponible: 'No se pudo bajar el archivo.',
    reintentar: 'No se pudo leer: la fila se reintenta (un OCR caído nunca decide).',
};

export interface LecturaParaBurbuja {
    rol: 'papa' | 'prospecto';
    ocr: OcrResult | null;
    errorOcr?: string | null;
    destino: DestinoLeido;
    camino?: CaminoSinFicha | null;
    hablaDePago?: boolean;
    resultado?: {
        decision: DecisionRecuperacion; motivo: string;
        pago?: PagoPendiente; pagosCubiertos?: PagoPendiente[]; excedente?: number;
    } | null;
    veredicto?: { verdict: string; reasons: { code: string; message: string }[] } | null;
    /** Prospecto sin deportista: nombres que irían en los botones. */
    candidatos?: string[];
    preguntaDeportista?: string;
}

function lineaDestino(ocr: OcrResult, destino: DestinoLeido): string {
    const leido = ocr.destination ? `${ocr.destination}${ocr.destinationName ? ` (${ocr.destinationName})` : ''}` : null;
    if (!leido) return '• Destino: no se leyó → no hay con qué cruzar';
    switch (destino) {
        case 'general': return `• Destino: ${leido} → ✅ es una cuenta de la escuela`;
        case 'restringida': return `• Destino: ${leido} → 🟡 es de la escuela pero restringida a otro concepto (queda en revisión)`;
        case 'fuera_de_sportmaps': return `• Destino: ${leido} → ℹ️ cuenta que la escuela acepta «por fuera de SportMaps»`;
        case 'ajena': return `• Destino: ${leido} → ❌ NO es una cuenta de la escuela`;
        default: return `• Destino: ${leido} → ⚠️ la escuela no tiene cuentas registradas: no hay con qué cruzar`;
    }
}

const EMOJI_VEREDICTO: Record<string, string> = { verde: '🟢', amarillo: '🟡', rojo: '🔴' };

/** La burbuja 🧪 del comprobante. Pura. */
export function textoComprobanteSimulado(e: LecturaParaBurbuja): string {
    const l: string[] = ['🧪 *Comprobante — simulación*', 'No se guardó el archivo ni se tocó ningún cobro.', ''];
    if (!e.ocr) {
        l.push(`El OCR no respondió: ${String(e.errorOcr ?? 'sin detalle').slice(0, 300)}`);
        l.push('En real la fila se reintenta: un OCR caído nunca decide.');
        return l.join('\n');
    }
    const o = e.ocr;
    l.push(`*Lectura* (${o.provider}):`);
    l.push(`• Monto: ${o.amount != null ? cop(o.amount) : 'no se leyó'}`);
    l.push(`• Fecha: ${o.date ?? 'no se leyó'}${o.time ? ` · ${o.time}` : ''}`);
    l.push(`• Referencia: ${o.reference ?? 'no se leyó'}`);
    l.push(`• Banco / billetera: ${o.bank ?? 'no se leyó'}`);
    if (o.originName) l.push(`• Pagó: ${o.originName}`);
    l.push(lineaDestino(o, e.destino));
    if (o.description) l.push(`• Concepto escrito: ${o.description}`);
    if (o.isReceipt === false) l.push('• ⚠️ El OCR dice que NO es un comprobante de pago');
    if (o.isTransactionList) l.push('• ⚠️ Es un listado de movimientos');

    l.push('', `*Qué haría el bot* (como ${e.rol === 'papa' ? 'acudiente' : 'prospecto: número sin ficha'}):`);
    if (e.rol === 'prospecto' && e.camino && e.camino !== 'sigue') {
        const pista = e.hablaDePago ? '' : ' Para probar ese camino, escribe antes algo como «te envío el comprobante».';
        const textos: Record<Exclude<CaminoSinFicha, 'sigue'>, string> = {
            no_es_pago: '→ No le contesta: no parece un comprobante de pago (sin monto, o el OCR dice que no es comprobante).',
            bandeja_fuera: '→ No le contesta (número sin ficha); queda informativo en la bandeja: pago a una cuenta «por fuera de SportMaps».',
            bandeja_ajena: '→ No le contesta (número sin ficha); se guarda y queda en la bandeja como «destino ajeno», con quién pagó.',
            silencio: `→ No le contesta: el destino no cruza con una cuenta general de la escuela y el interesado no habló de un pago.${pista}`,
        };
        l.push(textos[e.camino]);
    } else if (e.resultado) {
        const r = e.resultado;
        if (e.rol === 'prospecto' && r.decision === 'sin_familia') {
            l.push(`→ Le pregunta de qué deportista es: «${e.preguntaDeportista ?? '¿De qué deportista es este pago?'}»`
                + (e.candidatos?.length ? `\nBotones: ${e.candidatos.slice(0, 3).map((c) => `[${c}]`).join(' ')}` : ''));
        } else {
            l.push(`→ ${QUE_HARIA[r.decision] ?? r.decision}`);
        }
        if (r.pago) l.push(`Cobro: ${describir(r.pago)}`);
        if (r.pagosCubiertos?.length) l.push(`También cubre: ${r.pagosCubiertos.map(describir).join(' + ')}`);
        if (r.excedente) l.push(`De más: ${cop(r.excedente)} (saldo a favor al aprobar)`);
        if (e.veredicto) {
            const motivos = e.veredicto.reasons.map((x) => x.code).join(', ');
            l.push(`Veredicto: ${EMOJI_VEREDICTO[e.veredicto.verdict] ?? ''} ${e.veredicto.verdict}${motivos ? ` (${motivos})` : ''}`);
        }
        l.push(`Motivo: ${r.motivo.slice(0, 600)}`);
    }
    if (e.rol === 'prospecto') {
        l.push('', 'Hoy un interesado sin ficha no tiene cobros: el comprobante no crea la clase de prueba ni la matrícula (eso es B4).');
    }
    return l.join('\n');
}

function describir(p: PagoPendiente): string {
    const partes = [p.concept ?? 'Cobro'];
    if (p.atleta && !String(p.concept ?? '').toLowerCase().includes(p.atleta.toLowerCase())) partes.push(`de ${p.atleta}`);
    partes.push(`por ${cop(p.amount)}`);
    if (p.due_date) partes.push(`(vence ${p.due_date})`);
    return partes.join(' ');
}

export interface ResultadoSimulado { texto: string; bloqueadas: string[] }

/**
 * Lee el archivo y decide como el worker, SIN escribir: dentro del cortafuegos,
 * con `aplicar: false` y sin `storagePath`. Nunca lanza (el error va en la burbuja).
 */
export async function comprobanteSimulado(
    esc: EscenarioPrueba,
    archivo: { base64: string; mime: string },
    pie: string | null,
    fechaMensaje: string,
): Promise<ResultadoSimulado> {
    const s = esc.sesion;
    const schoolId = s.school_id as string;
    const rol = s.rol;
    const ctx = contextoDeLectura(s);
    const texto = await conCortafuegos(ctx, async () => {
        const { extractReceipt } = await import('./ocr.service');
        let ocr: OcrResult;
        try {
            ocr = await extractReceipt(archivo.base64, archivo.mime);
        } catch (err: any) {
            return textoComprobanteSimulado({ rol, ocr: null, errorOcr: err?.message ?? String(err), destino: null });
        }
        const job = await import('../jobs/whatsapp-queue.job');
        const { procesarComprobanteRecuperado } = await import('./whatsapp-recuperacion.service');
        const sha = crypto.createHash('sha256').update(Buffer.from(archivo.base64, 'base64')).digest('hex');
        const textos = [pie, ...textosRecientesDelContacto(s, esc.ahora)];
        const hablaDePago = job.textosHablanDePago(textos);
        const destino = await job.destinoDelComprobante(schoolId, ocr);

        let camino: CaminoSinFicha | null = null;
        if (rol === 'prospecto') {
            camino = caminoSinFicha({ parece: job.pareceComprobanteDePago(ocr), destino, hablaDePago });
            if (camino !== 'sigue') return textoComprobanteSimulado({ rol, ocr, destino, camino, hablaDePago });
        }

        // Quién paga, como lo resuelve el worker: el acudiente de prueba por su
        // cuenta; sin cuenta, por la ficha del atleta; el prospecto, por el nombre.
        const familia: Familia = rol === 'papa'
            ? (s.parent_id ? { tipo: 'identificado', parentId: s.parent_id } : { tipo: 'sin_cuenta', childIds: s.child_id ? [s.child_id] : [] })
            : { tipo: 'desconocido' };
        const r = await procesarComprobanteRecuperado({
            schoolId, familia, base64: archivo.base64, mime: archivo.mime, sha, storagePath: null,
            fechaMensaje, aplicar: false, queueId: 'prueba', textos, pie,
            ocrFn: async () => ocr,
        });

        // El veredicto que estamparía el worker en ese cobro (`estamparComprobante`).
        let veredicto: LecturaParaBurbuja['veredicto'] = null;
        if (r.pago) {
            const { buildVerdictContext } = await import('./receipt-context.service');
            const { evaluateVerdict, normalizeReference } = await import('./receipt-verdict');
            const vctx = await buildVerdictContext(schoolId, {
                referenceNorm: normalizeReference(ocr.reference), imageSha256: sha,
                expectedAmount: r.esperado ?? r.pago.amount, paymentId: r.pago.id,
            });
            veredicto = evaluateVerdict(ocr, vctx);
        }
        let candidatos: string[] = [];
        let preguntaDeportista: string | undefined;
        if (rol === 'prospecto' && r.decision === 'sin_familia') {
            const guiado = await import('./whatsapp-comprobante-guiado.service');
            const { PREGUNTA_DEPORTISTA } = await import('./whatsapp-comprobante-de-ficha.service');
            candidatos = (await guiado.candidatosParaPreguntar(schoolId, [...textos, ocr.description, ocr.originName]))
                .map((c) => c.nombre);
            preguntaDeportista = candidatos.length ? guiado.textoPreguntaDeportista() : PREGUNTA_DEPORTISTA;
        }
        return textoComprobanteSimulado({
            rol, ocr, destino, camino, hablaDePago, veredicto, candidatos, preguntaDeportista,
            resultado: {
                decision: r.decision, motivo: r.motivo, pago: r.pago, pagosCubiertos: r.pagosCubiertos, excedente: r.excedente,
            },
        });
    }).catch((err: any) => `🧪 La simulación del comprobante falló: ${String(err?.message ?? err).slice(0, 300)}`);
    return { texto, bloqueadas: ctx.bloqueadas };
}

// ─── Datos de la escuela simulada ───────────────────────────────────────────

export interface DatosEscuelaSimulada {
    nombre: string;
    sedes: { name: string | null; address: string | null; is_main?: boolean | null }[];
    indicaciones: string | null;
}

/** El cobro más antiguo de la familia de prueba (para las plantillas de cobro). */
export interface CobroDePrueba { amount: number; concept: string | null; due_date: string | null; atleta: string | null }

export interface DepsSimulacion {
    escuela: (schoolId: string) => Promise<DatosEscuelaSimulada>;
    /** Nombre del atleta (`full_name`) y del acudiente (`guardian_name`) como los vería un job. */
    personas: (sesion: SesionPrueba) => Promise<{ full_name: string | null; guardian_name: string | null }>;
    cobroPendiente: (sesion: SesionPrueba) => Promise<CobroDePrueba | null>;
    franjas: (schoolId: string) => Promise<FranjaCortesia[]>;
    enlace: (schoolId: string) => Promise<string | null>;
    redactarSeguimiento: (integ: WhatsAppIntegration, conversationId: string, recientes: FilaReciente[]) => Promise<string | null>;
    ficha: (schoolId: string) => Promise<string | null>;
    /** Estado de la plantilla en la WABA de la escuela (texto para la burbuja). */
    estadoEnWaba: (integ: WhatsAppIntegration, nombre: string, idioma: string) => Promise<string>;
}

const DEPS: DepsSimulacion = {
    async escuela(schoolId) {
        const { indicacionesCortesiaDeEscuela } = await import('./whatsapp-ajustes-escuela.service');
        const [{ data: s }, { data: b }, indicaciones] = await Promise.all([
            supabase.from('schools').select('name').eq('id', schoolId).maybeSingle(),
            supabase.from('school_branches').select('name, address, is_main').eq('school_id', schoolId).limit(50),
            indicacionesCortesiaDeEscuela(schoolId).catch(() => null),
        ]);
        return { nombre: (s as any)?.name ?? 'la escuela', sedes: ((b as any[]) ?? []), indicaciones };
    },
    async personas(sesion) {
        if (sesion.rol !== 'papa') return { full_name: 'Prueba SportMaps', guardian_name: null };
        const [{ data: h }, { data: p }] = await Promise.all([
            sesion.child_id
                ? supabase.from('children').select('full_name').eq('id', sesion.child_id).maybeSingle()
                : Promise.resolve({ data: null } as any),
            sesion.parent_id
                ? supabase.from('profiles').select('full_name').eq('id', sesion.parent_id).maybeSingle()
                : Promise.resolve({ data: null } as any),
        ]);
        return { full_name: (h as any)?.full_name ?? null, guardian_name: (p as any)?.full_name ?? 'Acudiente' };
    },
    async cobroPendiente(sesion) {
        if (sesion.rol !== 'papa' || !sesion.school_id) return null;
        const partes = [
            sesion.parent_id ? `parent_id.eq.${sesion.parent_id}` : null,
            sesion.child_id ? `child_id.eq.${sesion.child_id}` : null,
        ].filter(Boolean);
        if (!partes.length) return null;
        const { data } = await supabase.from('payments')
            .select('amount, concept, due_date, child:children(full_name)')
            .eq('school_id', sesion.school_id)
            .in('status', ['pending', 'overdue'])
            .or(partes.join(','))
            .order('due_date', { ascending: true })
            .limit(1);
        const p = ((data as any[]) ?? [])[0];
        return p ? { amount: Number(p.amount), concept: p.concept ?? null, due_date: p.due_date ?? null, atleta: p.child?.full_name ?? null } : null;
    },
    async franjas(schoolId) {
        const { franjasDeSupabase } = await import('./whatsapp-clase-cortesia.service');
        return franjasDeSupabase(schoolId);
    },
    async enlace(schoolId) {
        const { enlaceDeInscripcion } = await import('./whatsapp-bot.service');
        return enlaceDeInscripcion(schoolId);
    },
    async redactarSeguimiento(integ, conversationId, recientes) {
        const { redactarSeguimiento20h } = await import('./whatsapp-prospecto-seguimiento.service');
        return redactarSeguimiento20h(integ, conversationId, recientes);
    },
    async ficha(schoolId) {
        const { fichaDeProspectos } = await import('./whatsapp-prospecto-ia.service');
        return fichaDeProspectos(schoolId);
    },
    async estadoEnWaba(integ, nombre, idioma) {
        if (integ.phone_number_id === 'simulado' || !integ.waba_id) {
            return 'La escuela no tiene número conectado: al conectarlo hay que registrar esta plantilla en su WABA (scripts/wa-copiar-plantillas.ts) y esperar APPROVED.';
        }
        const { data } = await supabase.from('whatsapp_template_status')
            .select('status, category, waba_id')
            .eq('integration_id', integ.id).eq('name', nombre).eq('language', idioma)
            .maybeSingle();
        const f = data as any;
        if (!f || f.waba_id !== integ.waba_id) return 'En la WABA de la escuela: sin sincronizar (no se mandaría).';
        return `En la WABA de la escuela: ${f.status}${f.category ? ` · ${f.category}` : ''}`
            + (f.status === 'APPROVED' ? '' : ' (no se mandaría hasta que esté APPROVED)');
    },
};

/** La franja de la clase: la que se eligió en la conversación, o la más próxima de la escuela. */
async function franjaParaSimular(
    esc: EscenarioPrueba, d: DepsSimulacion,
): Promise<{ franja: FranjaCortesia; fuente: 'conversacion' | 'escuela'; nombre: string | null } | null> {
    for (const m of mensajesDeMemoria(esc.sesion)) {
        const datos = m.direction === 'outbound' ? (m.payload?.datos_cortesia ?? null) : null;
        if (datos?.franja?.fecha && datos.franja.horaInicio) {
            return { franja: datos.franja as FranjaCortesia, fuente: 'conversacion', nombre: datos.nombre ?? null };
        }
    }
    const franjas = await d.franjas(esc.sesion.school_id as string).catch(() => [] as FranjaCortesia[]);
    const ahora = esc.ahora;
    const proxima = franjas
        .filter((f) => instanteBogota(f.fecha, f.horaInicio) > ahora)
        .sort((a, b) => instanteBogota(a.fecha, a.horaInicio) - instanteBogota(b.fecha, b.horaInicio))[0];
    return proxima ? { franja: proxima, fuente: 'escuela', nombre: null } : null;
}

// ─── Plantillas ─────────────────────────────────────────────────────────────

interface PlantillaDelRepo { name: string; language: string; category: string; components: any[] }

/** Carpeta de los JSON: igual desde src/ (dev) que desde dist/ (Render). Mismo criterio que la ruta del catálogo. */
function carpetaDePlantillas(): string | null {
    for (const dir of [path.resolve(__dirname, '../../whatsapp-templates'), path.resolve(process.cwd(), 'whatsapp-templates')]) {
        if (fs.existsSync(dir)) return dir;
    }
    return null;
}

export function leerPlantillaDelRepo(nombre: string): PlantillaDelRepo | null {
    const dir = carpetaDePlantillas();
    if (!dir || !/^[a-z0-9_]+$/.test(nombre)) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, `${nombre}.json`), 'utf8')) as PlantillaDelRepo;
    } catch {
        return null;
    }
}

/** Cuándo sale cada concepto (escalera de cobranza y eventos). */
const CUANDO_SALE: Record<ConceptoCobro, string> = {
    recordatorio_previo: 'cobranza, 5 días antes del vencimiento',
    vence_manana: 'cobranza, el día anterior al vencimiento',
    vence_hoy: 'cobranza, el día del vencimiento',
    pendiente_suave: 'cobranza, 2 días después del vencimiento',
    pendiente_directo: 'cobranza, 7 días después del vencimiento',
    aviso_final: 'cobranza, 12 días después del vencimiento',
    pago_confirmado: 'evento: la escuela aprobó un pago de mensualidad',
    abono_recibido: 'evento: la escuela aprobó un abono',
    comprobante_rechazado: 'evento: la escuela no validó el comprobante',
    pago_recibido_otro_concepto: 'evento: pago aprobado de algo que no es mensualidad',
    comprobante_en_revision: 'evento: el comprobante quedó en revisión con la ventana de 24 h cerrada',
    recordatorio_clase_cortesia: 'víspera de la clase de prueba, con la ventana de 24 h cerrada',
    recordatorio_clase_prueba: 'víspera de la clase de prueba del embudo (escuela con nombre «clase de prueba»), con la ventana cerrada',
    clase_prueba_cupo_por_vencer: 'el cupo separado de la clase de prueba vence en ~2 h y la ventana ya cerró',
    clase_prueba_reprogramada: 'la sesión de la clase de prueba se canceló (lluvia o el profe): elegir otro horario',
};

const normalizarNombre = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/^\//, '').replace(/[\s-]+/g, '_');

/** El concepto por su clave o por el nombre de la plantilla; también por un pedazo si es único. Pura. */
export function conceptoDePlantilla(nombre: string | null | undefined): ConceptoCobro | null {
    const n = normalizarNombre(String(nombre ?? ''));
    if (!n) return null;
    const claves = Object.keys(CONCEPTOS) as ConceptoCobro[];
    const exacta = claves.find((k) => k === n || CONCEPTOS[k].plantilla === n);
    if (exacta) return exacta;
    const parciales = claves.filter((k) => k.includes(n) || CONCEPTOS[k].plantilla.includes(n));
    return parciales.length === 1 ? parciales[0] : null;
}

/** Lista del catálogo. Pura salvo la lectura de los JSON del repo. */
export function textoListaPlantillas(): string {
    const claves = Object.keys(CONCEPTOS) as ConceptoCobro[];
    const lineas = claves.map((k) => {
        const p = leerPlantillaDelRepo(CONCEPTOS[k].plantilla);
        return `• ${k} — \`${CONCEPTOS[k].plantilla}\` · ${p?.category ?? '¿?'} · ${CUANDO_SALE[k]}`;
    });
    return [
        `🧪 *Plantillas del catálogo* (${claves.length})`,
        ...lineas,
        '',
        '/plantilla <concepto o nombre> para verla con datos de la escuela.',
        'Todas son UTILITY: las de marketing (seguimiento 3 y 7 días) todavía no existen (B5).',
    ].join('\n');
}

/** Ejemplos para lo que la escuela simulada no tiene (se marcan «ejemplo»). */
function datosDeEjemplo(escuela: string, ahora: number): DatosCobro {
    const d = new Date(ahora - 5 * 3600_000);
    const mes = MESES[d.getUTCMonth()];
    return {
        nombreContacto: 'Carolina', nombreAtleta: 'Samuel', nombreEscuela: escuela,
        periodo: `${mes} ${d.getUTCFullYear()}`, fechaVencimiento: `5 de ${mes}`, monto: '$150.000', diasVencido: 7,
        montoAbono: '$50.000', saldoPendiente: '$100.000', motivo: 'el valor no coincide con el cobro',
        conceptoPago: 'Uniforme de competencia', dia: 'sábado 7 de noviembre', hora: '9:00 a. m.',
        sede: 'la sede de la escuela', vence: 'hoy a las 4:45 p. m.',
    };
}

const primerNombre = (s: string | null | undefined) => {
    const p = String(s ?? '').trim().split(/\s+/)[0] ?? '';
    return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : null;
};

/**
 * La plantilla con sus variables. `reales` son los campos que salieron de la
 * escuela o de la familia de prueba; el resto se marca «ejemplo». Pura salvo la
 * lectura del JSON del repo.
 */
export function textoPlantilla(
    concepto: ConceptoCobro, datos: DatosCobro, reales: Set<keyof DatosCobro>, estadoWaba: string, ahora: number,
): string {
    const def = CONCEPTOS[concepto];
    const json = leerPlantillaDelRepo(def.plantilla);
    const valores = def.variables(datos).map((v) => (v == null || String(v).trim() === '' ? null : String(v)));
    // Qué campo va en cada {{n}}: se llama al armador con el NOMBRE de cada campo.
    const marcas = def.variables(Object.fromEntries(Object.keys(datos).map((k) => [k, `«${k}»`])) as unknown as DatosCobro)
        .map((v) => String(v ?? '').match(/^«(\w+)»$/)?.[1] as keyof DatosCobro | undefined);
    const l: string[] = [
        `🧪 *Plantilla* \`${def.plantilla}\` · ${json?.category ?? '¿categoría?'} · ${def.idioma}`,
        `Concepto: ${concepto} (${CUANDO_SALE[concepto]})`,
        '',
    ];
    if (!json) {
        l.push('⚠️ No encontré el JSON de esta plantilla en bff/whatsapp-templates.');
    } else {
        l.push(renderizarCuerpo(json.components, valores.map((v, i) => v ?? `⟨falta {{${i + 1}}}⟩`)));
        const botones = (json.components ?? []).find((c: any) => String(c?.type).toUpperCase() === 'BUTTONS')?.buttons ?? [];
        for (const b of botones as any[]) {
            const url = b?.url ? ` → ${String(b.url).replace('{{1}}', '‹token del cobro›')}` : '';
            l.push(`[ ${b?.text ?? 'Botón'} ]${url}`);
        }
    }
    l.push('', 'Variables:');
    valores.forEach((v, i) => {
        const campo = marcas[i];
        const origen = campo && reales.has(campo) ? '' : ' (ejemplo)';
        l.push(`{{${i + 1}}} ${v ?? '⚠️ vacía: Meta rechazaría el envío (dato_faltante)'}${v ? origen : ''}`);
    });
    l.push('', estadoWaba);
    if (def.esCobro) {
        l.push(`Es de cobro: solo L–V 7:00–19:00 y sáb 8:00–15:00, nunca domingos ni festivos (Ley 2300). Ahora: ${dentroDeHorarioDeCobranza(new Date(ahora)) ? 'dentro' : 'fuera'} del horario.`);
    }
    l.push('Sale solo con consentimiento del contacto (wa_can_send_template); un interesado hoy nunca lo da (B2).');
    return l.join('\n');
}

/** `/plantilla <nombre>`: arma los datos (lecturas, dentro del cortafuegos) y la burbuja. */
export async function plantillaSimulada(
    esc: EscenarioPrueba, nombre: string, deps: Partial<DepsSimulacion> = {},
): Promise<ResultadoSimulado> {
    const concepto = conceptoDePlantilla(nombre);
    if (!concepto) {
        return { texto: `🧪 No reconozco la plantilla «${nombre}» (o hay varias con ese nombre).\n\n${textoListaPlantillas()}`, bloqueadas: [] };
    }
    const d: DepsSimulacion = { ...DEPS, ...deps };
    const ctx = contextoDeLectura(esc.sesion);
    const texto = await conCortafuegos(ctx, async () => {
        const schoolId = esc.sesion.school_id as string;
        const [escuela, personas, cobro, franja] = await Promise.all([
            d.escuela(schoolId),
            d.personas(esc.sesion).catch(() => ({ full_name: null, guardian_name: null })),
            d.cobroPendiente(esc.sesion).catch(() => null),
            concepto === 'recordatorio_clase_cortesia' ? franjaParaSimular(esc, d) : Promise.resolve(null),
        ]);
        const datos = datosDeEjemplo(escuela.nombre, esc.ahora);
        const reales = new Set<keyof DatosCobro>(['nombreEscuela']);
        const poner = <K extends keyof DatosCobro>(k: K, v: DatosCobro[K] | null | undefined) => {
            if (v == null || v === '') return;
            datos[k] = v as DatosCobro[K];
            reales.add(k);
        };
        if (esc.sesion.rol === 'papa') {
            poner('nombreContacto', primerNombre(personas.guardian_name));
            poner('nombreAtleta', primerNombre(personas.full_name ?? cobro?.atleta));
        }
        if (cobro) {
            poner('monto', cop(cobro.amount));
            if (cobro.due_date && /^\d{4}-\d{2}-\d{2}/.test(cobro.due_date)) {
                const [y, m, dd] = cobro.due_date.slice(0, 10).split('-').map(Number);
                poner('periodo', `${MESES[m - 1]} ${y}`);
                poner('fechaVencimiento', `${dd} de ${MESES[m - 1]}`);
                const vencido = Math.floor((esc.ahora - Date.parse(`${cobro.due_date.slice(0, 10)}T05:00:00Z`)) / 86_400_000);
                if (vencido > 0) poner('diasVencido', vencido);
            }
            if (cobro.concept && !/mensualidad/i.test(cobro.concept)) poner('conceptoPago', cobro.concept);
        }
        if (franja) {
            const cc = await import('./whatsapp-clase-cortesia.service');
            const rc = await import('./recordatorio-cortesia.service');
            const f: FranjaCortesia = { ...franja.franja, direccion: franja.franja.direccion ?? cc.direccionDeSede(franja.franja.sede, escuela.sedes) };
            const principal = escuela.sedes.find((x) => x.is_main) ?? escuela.sedes[0] ?? null;
            poner('dia', cc.fechaLegible(f.fecha));
            poner('hora', cc.horaLegible(f.horaInicio));
            poner('sede', rc.sedeParaPlantilla(f, principal));
        }
        const def = CONCEPTOS[concepto];
        const estado = await d.estadoEnWaba(esc.integ, def.plantilla, def.idioma).catch(() => 'En la WABA de la escuela: no se pudo leer.');
        return textoPlantilla(concepto, datos, reales, estado, esc.ahora);
    }).catch((err: any) => `🧪 No se pudo armar la plantilla: ${String(err?.message ?? err).slice(0, 300)}`);
    return { texto, bloqueadas: ctx.bloqueadas };
}

// ─── /avanzar ────────────────────────────────────────────────────────────────

export type TrabajoAvanzar = 'recordatorio' | 'mismo_dia' | 'seguimiento' | 'post_clase' | 'secuencia';

const ALIAS_AVANZAR: Record<string, TrabajoAvanzar> = {
    recordatorio: 'recordatorio', vispera: 'recordatorio', recordatorio_vispera: 'recordatorio',
    mismo_dia: 'mismo_dia', hoy: 'mismo_dia', recordatorio_hoy: 'mismo_dia', recordatorio_mismo_dia: 'mismo_dia',
    seguimiento: 'seguimiento', '20h': 'seguimiento', '1d': 'seguimiento', d1: 'seguimiento',
    post_clase: 'post_clase', postclase: 'post_clase', noche: 'post_clase', como_le_fue: 'post_clase',
    '3d': 'secuencia', '7d': 'secuencia', d3: 'secuencia', d7: 'secuencia',
};

/** `/avanzar <arg>` → el job. Pura. */
export function trabajoDeAvanzar(arg: string | null | undefined): TrabajoAvanzar | null {
    return ALIAS_AVANZAR[normalizarNombre(String(arg ?? ''))] ?? null;
}

export const TEXTO_AYUDA_AVANZAR = [
    '🧪 */avanzar <job>* — lo que mandaría cada job programado (no se manda a nadie ni se marca nada):',
    '• recordatorio — víspera de la clase de prueba, 6 p. m. (texto si la ventana de 24 h sigue abierta; si no, plantilla)',
    '• mismo-dia — unas 3 h antes de la clase; solo texto y solo con la ventana abierta',
    '• seguimiento (o 1d) — ~20 h después del último mensaje del interesado; lo redacta el modelo con la ficha',
    '• post-clase — «¿Cómo le fue?» la noche de la clase, solo con la ventana abierta',
    '• 3d / 7d — todavía no existen (secuencia con plantillas de marketing, B5)',
    '',
    'No se simulan porque solo escriben en la base: el cruce de inscripciones (marca el lead «inscrito») y el freno por calidad.',
    'La cobranza (vence hoy, pendiente…) se ve con /plantilla.',
].join('\n');

export interface ResultadoAvanzar extends ResultadoSimulado {
    /** Lo que le llegaría a la familia (null = no hay con qué armarlo). */
    salida: SalidaSimulada | null;
    /** El saliente que el job deja en la conversación: se agrega a la memoria de la sesión. */
    enMemoria: Fila | null;
}

/** Fila de memoria con la forma que deja `deliver` / `wa_record_outbound_message`. */
function salienteEnMemoria(esc: EscenarioPrueba, texto: string, payload: Record<string, unknown>, ai: boolean): Fila {
    const iso = new Date(esc.ahora).toISOString();
    return {
        id: crypto.randomUUID(), conversation_id: esc.conversationId, integration_id: esc.integ.id, direction: 'outbound',
        type: 'text', text_body: texto, payload, ai_generated: ai, wa_message_id: `sim-${crypto.randomUUID()}`,
        from_wa_id: null, to_wa_id: null, wa_timestamp: iso, created_at: iso, status: 'sent',
    };
}

/**
 * `/avanzar <job>`: el texto que mandaría ese job, armado con SUS constructores,
 * y si saldría en el momento en que correría. Nunca lanza.
 */
export async function avanzarSimulado(
    esc: EscenarioPrueba, trabajo: TrabajoAvanzar, deps: Partial<DepsSimulacion> = {},
): Promise<ResultadoAvanzar> {
    const d: DepsSimulacion = { ...DEPS, ...deps };
    const ctx = contextoDeLectura(esc.sesion);
    const vacio = (texto: string): Omit<ResultadoAvanzar, 'bloqueadas'> => ({ texto, salida: null, enMemoria: null });
    let r: Omit<ResultadoAvanzar, 'bloqueadas'>;
    try {
        r = await conCortafuegos(ctx, async () => {
            if (trabajo === 'secuencia') {
                return vacio('🧪 El seguimiento de 3 y 7 días todavía no existe: necesita plantillas de MARKETING por escuela '
                    + 'y el consentimiento del interesado (B5). Hoy el único es el de ~20 h: /avanzar seguimiento.');
            }
            if (trabajo === 'seguimiento') return avanzarSeguimiento(esc, d);
            return avanzarClase(esc, d, trabajo);
        });
    } catch (err: any) {
        r = vacio(`🧪 /avanzar falló: ${String(err?.message ?? err).slice(0, 300)}`);
    }
    return { ...r, bloqueadas: ctx.bloqueadas };
}

/** Recordatorio (víspera / mismo día) y «¿cómo le fue?»: los tres parten de una clase reservada. */
async function avanzarClase(
    esc: EscenarioPrueba, d: DepsSimulacion, trabajo: 'recordatorio' | 'mismo_dia' | 'post_clase',
): Promise<Omit<ResultadoAvanzar, 'bloqueadas'>> {
    const schoolId = esc.sesion.school_id as string;
    const elegida = await franjaParaSimular(esc, d);
    if (!elegida) {
        return {
            texto: '🧪 No hay clase de prueba que simular: la escuela no tiene franjas abiertas (school_trial_slots; ver B1/B3) '
                + 'y en esta conversación no se eligió ninguna.',
            salida: null, enMemoria: null,
        };
    }
    const cc = await import('./whatsapp-clase-cortesia.service');
    const rc = await import('./recordatorio-cortesia.service');
    const [escuela, personas] = await Promise.all([
        d.escuela(schoolId),
        d.personas(esc.sesion).catch(() => ({ full_name: null, guardian_name: null })),
    ]);
    const lead = { full_name: elegida.nombre ?? personas.full_name, guardian_name: personas.guardian_name };
    const { saludo, atleta } = rc.nombresDelLead(lead);
    const f: FranjaCortesia = { ...elegida.franja, direccion: elegida.franja.direccion ?? cc.direccionDeSede(elegida.franja.sede, escuela.sedes) };
    const ultimo = ultimoEntrante(esc.sesion) ?? new Date(esc.ahora).toISOString();
    const deDonde = elegida.fuente === 'conversacion'
        ? 'la franja que se eligió en la conversación'
        : 'la franja abierta más próxima de la escuela (en pruebas la reserva no se guarda)';
    const cabeza = `Clase: ${cc.fechaLegible(f.fecha)}, ${cc.horaLegible(f.horaInicio)} · ${f.grupo} — ${deDonde}.`;

    if (trabajo === 'post_clase') {
        const pc = await import('./prospecto-ciclo-clase.service');
        const inicio = rc.minutosDeHora(f.horaInicio);
        const fin = f.horaFin ? rc.minutosDeHora(f.horaFin) : inicio + 60;
        const corre = Math.max(pc.SEGUIMIENTO_DESDE_MIN, fin);
        const cuando = instanteBogota(f.fecha, `${Math.floor(corre / 60)}:${corre % 60}`);
        const enHorario = corre < pc.SEGUIMIENTO_HASTA_MIN;
        const abierta = ventanaAbierta(ultimo, cuando);
        const cancelo = textosRecientesDelContacto(esc.sesion, esc.ahora, 24 * 60).some(pc.avisaQueNoVa);
        const texto = pc.textoSeguimientoClase({
            saludo, atleta, esAcudiente: !!lead.guardian_name, enlace: await d.enlace(schoolId).catch(() => null), asistio: false,
        });
        const sale = enHorario && abierta && !cancelo;
        const porque = !enHorario ? 'la clase termina después de las 9:45 p. m. y el job corre de 8:00 a 9:45 p. m.'
            : cancelo ? 'el contacto dijo que no iba (cancelar / no me da tiempo)'
                : !abierta ? `la ventana de 24 h estaría cerrada (último mensaje: ${cuandoBogota(Date.parse(ultimo))}) y no hay plantilla para esto`
                    : '';
        return {
            texto: `🧪 */avanzar post-clase* — correría el ${cuandoBogota(cuando)}\n${cabeza}\n`
                + (sale ? 'Saldría como texto (ventana abierta).' : `NO saldría: ${porque}. Así se vería:`)
                + '\nEn real necesita la reserva guardada (school_signup_leads + franja).',
            salida: { texto, step: pc.PASO_SEGUIMIENTO_CLASE, botones: [] },
            enMemoria: sale ? salienteEnMemoria(esc, texto, { step: pc.PASO_SEGUIMIENTO_CLASE }, true) : null,
        };
    }

    const tipo = trabajo === 'recordatorio' ? 'vispera' : 'mismo_dia';
    const cuando = tipo === 'vispera'
        ? instanteBogota(rc.sumarDias(f.fecha, -1), '18:00')
        : instanteBogota(f.fecha, f.horaInicio) - 180 * 60_000;
    const abierta = ventanaAbierta(ultimo, cuando);
    const minutoDelDia = rc.ahoraBogota(new Date(cuando)).minutos;
    const texto = rc.textoRecordatorio(tipo, {
        saludo, atleta, esAcudiente: !!lead.guardian_name, escuela: escuela.nombre, franja: f, indicaciones: escuela.indicaciones,
    });
    // El estado del flujo viaja en el saliente: «CANCELAR» se lee contra él (como el job).
    const estadoFlujo = {
        step: `recordatorio_cortesia_${tipo}`, flujo: cc.FLUJO_CORTESIA, paso_cortesia: 'recordatorio',
        datos_cortesia: { franja: f, nombre: lead.full_name }, automatico: true,
    };
    const titulo = `🧪 */avanzar ${trabajo === 'recordatorio' ? 'recordatorio' : 'mismo-dia'}* — correría el ${cuandoBogota(cuando)}\n${cabeza}\n`;
    const pie = '\nEn real necesita la reserva guardada (school_signup_leads + franja) y el bot prendido.';

    if (tipo === 'mismo_dia' && (minutoDelDia < rc.MISMO_DIA_HORA_MIN || minutoDelDia >= rc.MISMO_DIA_HORA_MAX)) {
        return {
            texto: `${titulo}NO saldría: el aviso del mismo día solo corre de 7:00 a. m. a 8:00 p. m. Así se vería:${pie}`,
            salida: { texto, step: estadoFlujo.step, botones: [] }, enMemoria: null,
        };
    }
    if (abierta) {
        const opciones = cc.BOTON_CANCELAR_MI_CLASE.map((b: BotonInteractivo) => ({ id: b.id, title: b.title }));
        return {
            texto: `${titulo}Saldría como TEXTO (la ventana de 24 h sigue abierta) con el botón «Cancelar mi clase». `
                + 'Quedó como último mensaje de la conversación: si escribes CANCELAR, el flujo de cortesía lo lee contra él '
                + '(el botón busca la reserva guardada, que en pruebas no existe).' + pie,
            salida: { texto, step: estadoFlujo.step, botones: opciones.map((o) => o.title), opciones },
            enMemoria: salienteEnMemoria(esc, texto, estadoFlujo, false),
        };
    }
    if (tipo === 'mismo_dia') {
        return {
            texto: `${titulo}NO saldría: la ventana de 24 h estaría cerrada (último mensaje: ${cuandoBogota(Date.parse(ultimo))}) `
                + 'y el del mismo día no tiene plantilla a propósito. Así se vería:' + pie,
            salida: { texto, step: estadoFlujo.step, botones: [] }, enMemoria: null,
        };
    }
    // Víspera con la ventana cerrada: la plantilla UTILITY, con sus variables.
    const principal = escuela.sedes.find((x) => x.is_main) ?? escuela.sedes[0] ?? null;
    const datos: DatosCobro = {
        nombreContacto: saludo, nombreAtleta: atleta ?? '', nombreEscuela: escuela.nombre, monto: '',
        dia: cc.fechaLegible(f.fecha), hora: cc.horaLegible(f.horaInicio), sede: rc.sedeParaPlantilla(f, principal),
    };
    const def = CONCEPTOS.recordatorio_clase_cortesia;
    const json = leerPlantillaDelRepo(def.plantilla);
    const cuerpo = json
        ? renderizarCuerpo(json.components, def.variables(datos).map((v) => String(v ?? '')))
        : `(plantilla ${def.plantilla} no encontrada en el repo)`;
    const estado = await d.estadoEnWaba(esc.integ, def.plantilla, def.idioma).catch(() => '');
    return {
        texto: `${titulo}La ventana de 24 h estaría cerrada (último mensaje: ${cuandoBogota(Date.parse(ultimo))}): iría la PLANTILLA `
            + `\`${def.plantilla}\` (UTILITY). Sale solo si está APPROVED en la WABA de la escuela Y el contacto dio consentimiento: `
            + 'un interesado hoy nunca lo da (B2), así que en real NO le llegaría. Así se vería:\n' + estado + pie,
        salida: { texto: `[plantilla ${def.plantilla}]\n${cuerpo}`, step: estadoFlujo.step, botones: [] },
        enMemoria: null,
    };
}

/** Seguimiento de ~20 h al interesado (whatsapp-prospecto-seguimiento.service). */
async function avanzarSeguimiento(esc: EscenarioPrueba, d: DepsSimulacion): Promise<Omit<ResultadoAvanzar, 'bloqueadas'>> {
    const ps = await import('./whatsapp-prospecto-seguimiento.service');
    if (esc.sesion.rol !== 'prospecto') {
        return {
            texto: '🧪 El seguimiento de ~20 h es solo para interesados (leads de WhatsApp sin clase reservada). Cambia con /como prospecto.',
            salida: null, enMemoria: null,
        };
    }
    const recientes = mensajesDeMemoria(esc.sesion);
    const ultimo = ultimoEntrante(esc.sesion);
    if (!ultimo) {
        return { texto: '🧪 El interesado todavía no escribió nada en esta sesión: el seguimiento retoma lo último que preguntó.', salida: null, enMemoria: null };
    }
    const conv = { lastInboundAt: ultimo };
    // El job corre a menudo: el primer momento entre las 18 y 22 h en que toca.
    let cuando: number | null = null;
    for (let t = Date.parse(ultimo) + ps.DESDE_H * 3600_000; t <= Date.parse(ultimo) + ps.HASTA_H * 3600_000; t += 15 * 60_000) {
        if (ps.tocaSeguimiento(conv, recientes, new Date(t)).toca) { cuando = t; break; }
    }
    if (cuando === null) {
        const a20 = Date.parse(ultimo) + 20 * 3600_000;
        const motivo = ps.tocaSeguimiento(conv, recientes, new Date(a20)).motivo;
        const porque: Record<string, string> = {
            fuera_de_horario: `entre 18 y 22 h después de su último mensaje (${cuandoBogota(Date.parse(ultimo))}) no cae ningún momento de 8:00 a. m. a 8:00 p. m.`,
            escuela_atendiendo: 'una persona de la escuela escribió en la conversación',
            ya_enviado: 'ya se le mandó el seguimiento',
        };
        return { texto: `🧪 */avanzar seguimiento* — NO saldría: ${porque[motivo] ?? motivo}.`, salida: null, enMemoria: null };
    }
    const texto = await d.redactarSeguimiento(esc.integ, esc.conversationId, recientes);
    const cabeza = `🧪 */avanzar seguimiento* — correría el ${cuandoBogota(cuando)} (~${Math.round((cuando - Date.parse(ultimo)) / 3600_000)} h después de su último mensaje).`;
    if (!texto) {
        const ficha = await d.ficha(esc.sesion.school_id as string).catch(() => null);
        return {
            texto: `${cabeza}\nNO saldría: ${ficha ? 'el modelo respondió NADA (o se llegó al tope de respuestas del modelo)' : 'la escuela no tiene ficha de prospectos (wa_ficha_prospectos)'}.`,
            salida: null, enMemoria: null,
        };
    }
    return {
        texto: `${cabeza}\nLo redactó el modelo con la ficha y el tono de la escuela. En real además necesita el lead guardado (en pruebas no se guarda).`,
        salida: { texto, step: ps.PASO_SEGUIMIENTO_20H, botones: [] },
        enMemoria: salienteEnMemoria(esc, texto, { step: ps.PASO_SEGUIMIENTO_20H }, true),
    };
}
