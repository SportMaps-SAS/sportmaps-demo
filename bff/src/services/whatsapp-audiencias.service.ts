/**
 * whatsapp-audiencias.service — a quién le puede llegar una campaña de la
 * escuela: las personas que le escribieron por WhatsApp pidiendo clase de
 * prueba, inscripción, una clínica o un vacacional, y que no son ya del club
 * (plan B5 T2, docs/specs/whatsapp-monster-plan-B5.md).
 *
 * POR QUÉ EXISTE
 *
 * Monster preguntó si el bot podía «retomar las conversaciones de las dos
 * sedes y escribirles del regalo a los contactos con etiqueta clase de prueba».
 * Las etiquetas de WhatsApp Business no llegan por la API; el historial sí (T1).
 * Esto lo clasifica con las MISMAS reglas deterministas que abren la puerta del
 * prospecto en el bot (`intencionDeProspecto` / `interesesDeProspecto`), más
 * «clínica | campamento | vacacional», que el bot no tenía. Sin modelo: gratis,
 * repetible y explicable («entró por este mensaje»).
 *
 * LO QUE NO ENTRA
 *
 *  - Sin intención clara (saludos, «ok gracias», charla): no entra.
 *  - Familias, staff, inscritos (`wa_audiencia_excluidos`, un barrido por lote).
 *  - Marcas manuales de la escuela (personal, negocio, otro club, plataforma).
 *  - Quien pidió la baja (`whatsapp_optins.opted_out_at`) o dijo «no me
 *    interesa» a una campaña: esa exclusión no la borra una reclasificación.
 *
 * Solo corre con `whatsapp_campanas_ajustes.habilitadas`: sin fila, UNA lectura
 * (los ajustes) y nada más; nunca se lee `whatsapp_messages`.
 */

import { supabase } from '../config/supabase';
import { intencionDeProspecto, interesesDeProspecto } from './whatsapp-atencion.service';
import { esMarcaNoFamilia } from './whatsapp-tipo-contacto';
import { enmascararNumero } from './avisos-correo.service';
import {
    leerAjustesCampanas, type InteresAudiencia, type PalabrasDeSede,
} from './whatsapp-campanas.service';

/** Sube cuando cambian las reglas: deja ver con qué versión se clasificó cada fila. */
export const VERSION_REGLAS = 1;

export type MotivoExclusion = 'familia' | 'staff' | 'marca_manual' | 'baja' | 'bloqueado' | 'no_interesa' | 'inscrito';
const MOTIVOS_EXCLUSION = new Set<MotivoExclusion>(['familia', 'staff', 'marca_manual', 'baja', 'bloqueado', 'no_interesa', 'inscrito']);
/** Exclusiones que puso la PERSONA: una reclasificación nunca las borra. */
const EXCLUSIONES_FIRMES = new Set<MotivoExclusion>(['baja', 'no_interesa']);

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Lo que el bot no reconocía: clínicas, campamentos y vacacionales. */
const EVENTO = /\b(clinicas?|campamentos?|vacacional(es)?|vacaciones recreativas)\b/;
/** «Ya pagué la clínica» es de una familia, no de un interesado. */
const YA_PAGO = /\b(ya pague|pague|transferi|consigne|comprobante|recibo)\b/;
/** Variantes de la clase de prueba que `interesesDeProspecto` no cubre. */
const CLASE_DE_PRUEBA = /\b(probar|prueben) (una )?clase\b|\bclases? (de )?(muestra|ensayo|prueba)\b/;

const A_INTERES: Record<string, InteresAudiencia> = {
    cortesia: 'clase_prueba',
    inscripcion: 'inscripcion',
    precio: 'precio',
    horarios: 'horarios',
    visita: 'informacion',
    edades: 'informacion',
    informacion: 'informacion',
};

export interface Clasificacion {
    intereses: InteresAudiencia[];
    /** La sede, si los mensajes nombran exactamente una. */
    branchId: string | null;
    /** Índice (en `entrantes`) del primer mensaje con intención: la evidencia. */
    evidencia: number;
}

/** ¿Este entrante, solo, muestra intención? Pura. */
export function entranteConIntencion(texto: string | null | undefined): boolean {
    if (!texto) return false;
    if (intencionDeProspecto(texto)) return true;
    const t = plano(texto);
    if (YA_PAGO.test(t)) return false;
    return EVENTO.test(t) || CLASE_DE_PRUEBA.test(t);
}

/** Sede nombrada por los textos: exactamente una → su id; ninguna o varias → null. Pura. */
export function sedeDeTextos(textos: (string | null | undefined)[], palabrasSede: PalabrasDeSede[]): string | null {
    if (!palabrasSede.length) return null;
    const junto = ` ${plano(textos.filter(Boolean).join(' \n '))} `;
    const encontradas = new Set<string>();
    for (const s of palabrasSede) {
        for (const p of s.palabras) {
            const w = plano(p);
            if (w && junto.includes(` ${w} `)) { encontradas.add(s.branch_id); break; }
        }
    }
    return encontradas.size === 1 ? [...encontradas][0] : null;
}

/**
 * Clasifica una conversación. Pura.
 *
 * `entrantes`: textos de la persona, del más viejo al más nuevo.
 * `salientes`: lo que escribió la ESCUELA (no el bot): sirve para la sede
 * («te esperamos en la sede Suba»).
 * Devuelve null si ningún entrante muestra intención clara.
 */
export function clasificarConversacion(
    entrantes: (string | null | undefined)[],
    salientes: (string | null | undefined)[],
    palabrasSede: PalabrasDeSede[],
): Clasificacion | null {
    const evidencia = entrantes.findIndex((t) => entranteConIntencion(t));
    if (evidencia < 0) return null;

    const intereses = new Set<InteresAudiencia>();
    for (const t of entrantes) {
        if (!t || !t.trim()) continue;
        const p = plano(t);
        if (!YA_PAGO.test(p) && EVENTO.test(p)) intereses.add('clinica');
        if (CLASE_DE_PRUEBA.test(p)) intereses.add('clase_prueba');
        // `interesesDeProspecto` pone 'informacion' cuando no encuentra nada:
        // solo se cuenta si el mensaje tenía intención propia.
        for (const i of interesesDeProspecto(t)) {
            if (i === 'informacion' && !entranteConIntencion(t)) continue;
            const m = A_INTERES[i];
            if (m) intereses.add(m);
        }
    }
    if (intereses.size > 1) intereses.delete('informacion');
    if (intereses.size === 0) intereses.add('informacion');

    return {
        intereses: [...intereses].sort(),
        branchId: sedeDeTextos([...entrantes, ...salientes], palabrasSede),
        evidencia,
    };
}

// ─── Con base ────────────────────────────────────────────────────────────────

export interface ResultadoAudiencia {
    estado: 'ok' | 'apagado' | 'sin_migracion' | 'sin_integracion' | 'integracion_ambigua' | 'error';
    detalle?: string;
    aplicado: boolean;
    /** Conversaciones con entrantes dentro de la antigüedad. */
    conversaciones: number;
    /** Las que se volvieron a leer (nuevas o con mensajes desde la última clasificación). */
    releidas: number;
    mensajes: number;
    candidatos: number;
    vigentes: number;
    porInteres: Record<string, number>;
    porSede: Record<string, number>;
    excluidos: Record<string, number>;
    guardados: number;
    muestra: { telefono: string; intereses: string[]; sede: string | null; excluido: string | null; evidencia: string | null }[];
}

function vacio(estado: ResultadoAudiencia['estado'], detalle?: string): ResultadoAudiencia {
    return {
        estado, ...(detalle ? { detalle } : {}), aplicado: false, conversaciones: 0, releidas: 0, mensajes: 0,
        candidatos: 0, vigentes: 0, porInteres: {}, porSede: {}, excluidos: {}, guardados: 0, muestra: [],
    };
}

interface ConvFila {
    id: string;
    contact_wa_id: string;
    contact_name: string | null;
    contact_kind: string | null;
    tambien_familia?: boolean | null;
    last_inbound_at: string | null;
}

interface MsgFila {
    conversation_id: string;
    direction: 'inbound' | 'outbound';
    type: string;
    text_body: string | null;
    ai_generated: boolean | null;
    wa_message_id: string | null;
    wa_timestamp: string | null;
    created_at?: string | null;
}

const PAGINA = 1000;
const LOTE = 500;
/** Con hasta tantas conversaciones por releer se lee por conversación; con más, la integración entera. */
const MAX_POR_CONVERSACION = 300;

const trozos = <T>(xs: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
    return out;
};

async function leerPaginado<T>(consulta: (desde: number, hasta: number) => PromiseLike<{ data: any; error: any }>): Promise<T[]> {
    const filas: T[] = [];
    for (let desde = 0; desde < 500_000; desde += PAGINA) {
        const { data, error } = await consulta(desde, desde + PAGINA - 1);
        if (error) throw new Error(error.message ?? 'lectura fallida');
        const lote = (data as T[]) ?? [];
        filas.push(...lote);
        if (lote.length < PAGINA) break;
    }
    return filas;
}

async function leerConversaciones(integrationId: string, desde: string): Promise<ConvFila[]> {
    const con = (cols: string) => leerPaginado<ConvFila>((a, b) => supabase.from('whatsapp_conversations')
        .select(cols).eq('integration_id', integrationId).gte('last_inbound_at', desde)
        .order('id', { ascending: true }).range(a, b));
    try {
        return await con('id, contact_wa_id, contact_name, contact_kind, tambien_familia, last_inbound_at');
    } catch {
        // `tambien_familia` llegó con otra migración: sin ella la marca sigue valiendo.
        return con('id, contact_wa_id, contact_name, contact_kind, last_inbound_at');
    }
}

const COLS_MSG = 'conversation_id, direction, type, text_body, ai_generated, wa_message_id, wa_timestamp, created_at';
const TIPOS_CON_TEXTO = ['text', 'button', 'interactive'];

async function leerMensajes(integrationId: string, convIds: string[], desde: string, todas: boolean): Promise<MsgFila[]> {
    if (todas) {
        // Por `integration_id` (idx_wa_msg_integration), de a 1000.
        return leerPaginado<MsgFila>((a, b) => supabase.from('whatsapp_messages').select(COLS_MSG)
            .eq('integration_id', integrationId).in('type', TIPOS_CON_TEXTO).gte('wa_timestamp', desde)
            .order('id', { ascending: true }).range(a, b));
    }
    const filas: MsgFila[] = [];
    for (const lote of trozos(convIds, 100)) {
        filas.push(...await leerPaginado<MsgFila>((a, b) => supabase.from('whatsapp_messages').select(COLS_MSG)
            .in('conversation_id', lote).in('type', TIPOS_CON_TEXTO).gte('wa_timestamp', desde)
            .order('id', { ascending: true }).range(a, b)));
    }
    return filas;
}

const momento = (m: MsgFila) => new Date(m.wa_timestamp || m.created_at || 0).getTime();

/**
 * Clasifica las conversaciones de la escuela y (con `aplicar`) guarda la
 * audiencia. Incremental por `last_inbound_at`: relee solo lo nuevo o lo que
 * tuvo mensajes desde su última clasificación; `completo` relee todo.
 * Nunca lanza.
 */
export async function clasificarEscuela(
    schoolId: string,
    opts: { aplicar?: boolean; completo?: boolean; ahora?: number } = {},
): Promise<ResultadoAudiencia> {
    const ahora = opts.ahora ?? Date.now();
    try {
        // 1. Interruptor. Sin fila (o sin la tabla): una lectura y nada más.
        const { disponible, ajustes } = await leerAjustesCampanas(schoolId);
        if (!disponible) return vacio('sin_migracion', 'whatsapp_campanas_ajustes no existe o no se pudo leer');
        if (!ajustes?.habilitadas) return vacio('apagado');

        // 2. La integración activa (una por escuela).
        const { data: integs } = await supabase.from('school_whatsapp_integrations')
            .select('id, school_id, status').eq('school_id', schoolId).eq('status', 'active');
        const activas = (integs as any[]) ?? [];
        if (activas.length === 0) return vacio('sin_integracion');
        if (activas.length > 1) return vacio('integracion_ambigua');
        const integrationId = String(activas[0].id);

        const desde = new Date(ahora - ajustes.antiguedadMaxDias * 24 * 3600_000).toISOString();
        const r = vacio('ok');

        // 3. Conversaciones con entrantes en la ventana + lo ya clasificado.
        const convs = await leerConversaciones(integrationId, desde);
        r.conversaciones = convs.length;
        let previas: { contact_wa_id: string; clasificado_at: string | null; excluido: string | null }[];
        try {
            previas = await leerPaginado((a, b) => supabase.from('whatsapp_audiencia')
                .select('contact_wa_id, clasificado_at, excluido').eq('integration_id', integrationId)
                .order('contact_wa_id', { ascending: true }).range(a, b));
        } catch (err: any) {
            return vacio('sin_migracion', err?.message);
        }
        const previaPorWa = new Map(previas.map((p) => [p.contact_wa_id, p]));
        // Marca de agua: la última pasada guardada leyó TODAS las conversaciones;
        // las que no quedaron en la audiencia (sin intención) y no escribieron
        // después no se vuelven a leer.
        const marca = previas.reduce((m, p) => (p.clasificado_at && p.clasificado_at > m ? p.clasificado_at : m), '');

        const aReleer = convs.filter((c) => {
            if (opts.completo) return true;
            const p = previaPorWa.get(c.contact_wa_id);
            const visto = p?.clasificado_at ?? (marca || null);
            if (!visto) return true;
            return !!c.last_inbound_at && new Date(c.last_inbound_at) > new Date(visto);
        });
        r.releidas = aReleer.length;
        if (!aReleer.length) return r;

        // 4. Mensajes: por conversación si son pocas; si no, la integración entera.
        const ids = aReleer.map((c) => c.id);
        const idsSet = new Set(ids);
        const mensajes = (await leerMensajes(integrationId, ids, desde, aReleer.length > MAX_POR_CONVERSACION))
            .filter((m) => idsSet.has(m.conversation_id));
        r.mensajes = mensajes.length;
        const porConv = new Map<string, MsgFila[]>();
        for (const m of mensajes) {
            const l = porConv.get(m.conversation_id) ?? [];
            l.push(m);
            porConv.set(m.conversation_id, l);
        }

        // 5. Reglas.
        type Candidato = { conv: ConvFila; cl: Clasificacion; entrantes: MsgFila[] };
        const candidatos: Candidato[] = [];
        for (const conv of aReleer) {
            const msgs = (porConv.get(conv.id) ?? []).sort((a, b) => momento(a) - momento(b));
            const entrantes = msgs.filter((m) => m.direction === 'inbound' && m.text_body);
            // Lo que escribió una persona de la escuela (no el bot ni las plantillas).
            const salientes = msgs.filter((m) => m.direction === 'outbound' && m.ai_generated !== true && m.type === 'text' && m.text_body);
            const cl = clasificarConversacion(entrantes.map((m) => m.text_body), salientes.map((m) => m.text_body), ajustes.palabrasSede);
            if (cl) candidatos.push({ conv, cl, entrantes });
        }
        r.candidatos = candidatos.length;
        if (!candidatos.length) return r;

        // 6. Exclusiones, por lotes de 500.
        const excluidoPorWa = new Map<string, MotivoExclusion>();
        for (const c of candidatos) {
            if (esMarcaNoFamilia(c.conv.contact_kind) && c.conv.tambien_familia !== true) {
                excluidoPorWa.set(c.conv.contact_wa_id, 'marca_manual');
            }
        }
        const waIds = candidatos.map((c) => c.conv.contact_wa_id);
        for (const lote of trozos(waIds, LOTE)) {
            const { data, error } = await supabase.rpc('wa_audiencia_excluidos', { p_school_id: schoolId, p_wa_ids: lote });
            // Sin el barrido no se sabe quién es familia: no se guarda nada.
            if (error) return { ...vacio('sin_migracion', `wa_audiencia_excluidos: ${error.message}`), conversaciones: r.conversaciones };
            for (const f of (data as { contact_wa_id: string; motivo: string }[] | null) ?? []) {
                const m = f.motivo as MotivoExclusion;
                if (MOTIVOS_EXCLUSION.has(m) && !excluidoPorWa.has(f.contact_wa_id)) excluidoPorWa.set(f.contact_wa_id, m);
            }
            const { data: optins } = await supabase.from('whatsapp_optins')
                .select('contact_wa_id, opted_in_at, opted_out_at')
                .eq('integration_id', integrationId).in('contact_wa_id', lote);
            for (const o of (optins as any[]) ?? []) {
                const baja = o.opted_out_at && (!o.opted_in_at || new Date(o.opted_out_at) >= new Date(o.opted_in_at));
                if (baja) excluidoPorWa.set(String(o.contact_wa_id), 'baja');
            }
        }
        // Lo que dijo la persona manda sobre cualquier regla.
        for (const c of candidatos) {
            const previa = previaPorWa.get(c.conv.contact_wa_id)?.excluido as MotivoExclusion | null | undefined;
            if (previa && EXCLUSIONES_FIRMES.has(previa)) excluidoPorWa.set(c.conv.contact_wa_id, previa);
        }

        // 7. Filas.
        const clasificadoAt = new Date(ahora).toISOString();
        const filas = candidatos.map(({ conv, cl, entrantes }) => ({
            integration_id: integrationId,
            school_id: schoolId,
            conversation_id: conv.id,
            contact_wa_id: conv.contact_wa_id,
            intereses: cl.intereses,
            branch_id: cl.branchId,
            excluido: excluidoPorWa.get(conv.contact_wa_id) ?? null,
            fuente: 'reglas',
            evidencia_wa_message_id: entrantes[cl.evidencia]?.wa_message_id ?? null,
            primer_entrante_at: entrantes[0] ? new Date(momento(entrantes[0])).toISOString() : null,
            ultimo_entrante_at: conv.last_inbound_at
                ?? (entrantes.length ? new Date(momento(entrantes[entrantes.length - 1])).toISOString() : null),
            version_reglas: VERSION_REGLAS,
            clasificado_at: clasificadoAt,
        }));

        for (const f of filas) {
            if (f.excluido) {
                r.excluidos[f.excluido] = (r.excluidos[f.excluido] ?? 0) + 1;
                continue;
            }
            r.vigentes++;
            for (const i of f.intereses) r.porInteres[i] = (r.porInteres[i] ?? 0) + 1;
            const s = f.branch_id ?? 'sin_sede';
            r.porSede[s] = (r.porSede[s] ?? 0) + 1;
        }
        r.muestra = candidatos.slice(0, 20).map(({ conv, cl, entrantes }) => ({
            telefono: enmascararNumero(conv.contact_wa_id),
            intereses: cl.intereses,
            sede: cl.branchId,
            excluido: excluidoPorWa.get(conv.contact_wa_id) ?? null,
            evidencia: (entrantes[cl.evidencia]?.text_body ?? '').slice(0, 80) || null,
        }));

        // 8. Guardar, de a 500.
        if (opts.aplicar) {
            for (const lote of trozos(filas, LOTE)) {
                const { error } = await supabase.from('whatsapp_audiencia')
                    .upsert(lote, { onConflict: 'integration_id,contact_wa_id' });
                if (error) return { ...r, estado: 'error', detalle: error.message };
                r.guardados += lote.length;
            }
            r.aplicado = true;
        }
        return r;
    } catch (err: any) {
        return vacio('error', err?.message || String(err));
    }
}
