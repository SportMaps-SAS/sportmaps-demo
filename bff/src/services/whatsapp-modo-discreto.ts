/**
 * Modo discreto del bot de WhatsApp (análisis de las 604 conversaciones de
 * Dynasty, 02–29 oct 2026; aprobado por el dueño del producto el 2026-10-29).
 *
 * El número de la escuela suele ser el celular de quien la dirige (Coexistence):
 * la mitad de la gente le escribe a ELLA, no a «la escuela», y ella ve cada
 * mensaje en su celular. Medido en el mes: el bot habló con Milena ya en la
 * charla en 79 conversaciones, pidió correo o registro sin hacer falta en 132,
 * le dejó «Dejo tu mensaje para Milena» a mensajes que ya eran para ella y le
 * mandó ~23 push al día. Milena, por escrito: «Esa IA me va a volver loca».
 *
 * La regla: el bot hace TRES cosas —comprobantes de familias, interesados
 * nuevos e información pública (horario de hoy, sedes, cómo pagar)— y en todo
 * lo demás calla. Y si una persona de la escuela escribió en la conversación en
 * las últimas HORAS_SILENCIO_ESCUELA, no sale NADA automático.
 *
 * `WHATSAPP_MODO_DISCRETO=false` vuelve al bot completo de antes (rollback sin
 * tocar código). Los tests del bot completo corren con el modo apagado.
 */
import { supabase } from '../config/supabase';
import {
    esCierreSuelto, slaVencido, SLA_ESCALAMIENTO_MIN_HABILES,
    type FilaReciente, type HorarioDeAtencion,
} from './whatsapp-reglas-turno';
import { intencionDeProspecto } from './whatsapp-atencion.service';
import { esMarcaNoFamilia } from './whatsapp-tipo-contacto';
import { avisarEscalacionAlEquipo } from './whatsapp-escalaciones.service';

/** ¿Está activo? Por defecto sí. */
export function modoDiscreto(): boolean {
    return process.env.WHATSAPP_MODO_DISCRETO !== 'false';
}

/** Horas que calla el bot después de que una persona de la escuela escribe en la conversación. */
export const HORAS_SILENCIO_ESCUELA = Number(process.env.WHATSAPP_HORAS_SILENCIO_ESCUELA) || 12;

/**
 * Un eco marcado `automatico` que sale a menos de esto de un entrante es el
 * saludo de WhatsApp Business («Gracias por comunicarte con Dynasty…», mediana
 * 2 s). Las respuestas rápidas que Milena manda a mano («Bienvenidos a
 * Dynasty», «Proceso de inscripción») también quedan `automatico` (mismo texto
 * a varios contactos), pero salen minutos u horas después: esas SÍ son ella.
 */
const SALUDO_DE_APP_MS = 30_000;

const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();

/**
 * ¿Este saliente lo escribió una persona de la escuela? Pura. `filas` son las de
 * la misma conversación (para reconocer el saludo de la app por su demora).
 *
 * - buzón o plantilla manual (`payload.manual`): sí;
 * - plantillas y recordatorios de los jobs (llevan `step`): no;
 * - eco del celular: sí, salvo el saludo automático de la app.
 */
export function escritoPorLaEscuela(f: FilaReciente, filas: readonly FilaReciente[]): boolean {
    if (f.direction !== 'outbound' || f.ai_generated !== false) return false;
    const p = f.payload ?? {};
    if (p.manual === true) return true;
    if (p.step) return false;
    if (p.automatico !== true && p.automatico !== 'true') return true;
    const t = momento(f);
    return !filas.some((x) => x.direction === 'inbound' && momento(x) <= t && t - momento(x) <= SALUDO_DE_APP_MS);
}

/** ¿Escribió una persona de la escuela en las últimas `horas`? Pura. */
export function escuelaActivaEn(
    filas: readonly FilaReciente[],
    ahora = Date.now(),
    horas = HORAS_SILENCIO_ESCUELA,
): boolean {
    const desde = ahora - horas * 3600_000;
    return filas.some((f) => momento(f) >= desde && escritoPorLaEscuela(f, filas));
}

/**
 * Lo mismo leyendo la base. Lo usa `deliver` JUSTO antes de enviar: el turno
 * revisa al empezar, pero el modelo tarda segundos y Milena puede escribir en
 * el medio (30 casos en el mes; «¿Qué edad tiene Soy?» salió 3 s después de su
 * «Holaaaaa Karol»). Nunca lanza: ante un error de lectura, false (como antes).
 */
export async function escuelaActiva(conversationId: string, ahora = Date.now()): Promise<boolean> {
    try {
        const { data, error } = await supabase.from('whatsapp_messages')
            .select('direction, type, ai_generated, payload, wa_timestamp, created_at')
            .eq('conversation_id', conversationId)
            .gte('created_at', new Date(ahora - HORAS_SILENCIO_ESCUELA * 3600_000 - 60_000).toISOString())
            .order('created_at', { ascending: false })
            .limit(200);
        if (error || !Array.isArray(data)) return false;
        return escuelaActivaEn(data as FilaReciente[], ahora);
    } catch {
        return false;
    }
}

// ─── Aviso único de lo que quedó sin contestar ──────────────────────────────
//
// Reemplaza, en modo discreto, la cadena de cada escalación (push al abrirse +
// reaviso a los 30 min + SLA a las 2 h hábiles con correo, y «Todavía nadie de
// la escuela…» a la familia). Un solo push por conversación y por día, cuando
// una familia o un interesado lleva SLA_ESCALAMIENTO_MIN_HABILES (horas hábiles
// de la escuela) sin que nadie le conteste. A la familia no se le dice nada.

/** Mensajes del bot que dejan a la persona esperando a la escuela (no cuentan como respuesta). */
const PASOS_QUE_ESPERAN = new Set([
    'escalated', 'identificacion_ambigua', 'puerta_club_recibido', 'puerta_otro_tema',
    'cortesia_sin_grupo_para_edad',
]);
/** Tipos de entrante que no piden nada. */
const TIPOS_SIN_PEDIDO = new Set(['sticker', 'reaction', 'unsupported']);
/** Contactos que son de la escuela: familias e interesados. Lo demás es de la vida de quien atiende. */
const TIPOS_DE_CLIENTE = new Set(['familia', 'familia_sin_cuenta']);
/** Hasta dónde se mira atrás. */
const VENTANA_PENDIENTES_HORAS = 72;
/** Cada cuánto se revisa (lo dispara el webhook). */
const CADA_MS = 10 * 60_000;

export interface EntranteParaPendiente {
    conversation_id: string;
    type?: string | null;
    text_body?: string | null;
    wa_timestamp?: string | null;
    created_at?: string | null;
}
export interface SalienteParaPendiente extends FilaReciente {
    conversation_id: string;
}
export interface ConversacionParaPendiente {
    id: string;
    integration_id: string;
    contact_wa_id: string;
    contact_name: string | null;
    contact_kind: string | null;
    status: string | null;
    tomada_por: string | null;
    tomada_hasta: string | null;
}
export interface Pendiente {
    conversacion: ConversacionParaPendiente;
    /** El entrante que espera respuesta. */
    desde: string;
}

/** ¿El entrante pide algo? (no un sticker, un «gracias» ni un «ok»). Pura. */
export function entrantePideAlgo(e: EntranteParaPendiente): boolean {
    if (TIPOS_SIN_PEDIDO.has(String(e.type ?? ''))) return false;
    const t = (e.text_body || '').trim();
    if (!t) return ['image', 'document', 'audio', 'video'].includes(String(e.type ?? ''));
    return !esCierreSuelto(t);
}

/**
 * Las conversaciones que quedaron sin contestar. Pura.
 * `entrantes` y `salientes` vienen del más nuevo al más viejo o en cualquier orden.
 */
export function decidirPendientes(
    entrantes: readonly EntranteParaPendiente[],
    salientes: readonly SalienteParaPendiente[],
    conversaciones: ReadonlyMap<string, ConversacionParaPendiente>,
    horarios: ReadonlyMap<string, HorarioDeAtencion | null>,
    ahora = Date.now(),
    /** «¿Tiene intención?»: el bot pasa uno más ancho (inyectado para no crear un ciclo de imports). */
    esInteres: (t: string | null | undefined) => boolean = intencionDeProspecto,
): Pendiente[] {
    const t = (f: { wa_timestamp?: string | null; created_at?: string | null }) =>
        new Date(f.wa_timestamp || f.created_at || 0).getTime();
    const porConv = new Map<string, EntranteParaPendiente[]>();
    for (const e of entrantes) {
        const l = porConv.get(e.conversation_id) ?? [];
        l.push(e);
        porConv.set(e.conversation_id, l);
    }
    const salidasDe = new Map<string, SalienteParaPendiente[]>();
    for (const s of salientes) {
        const l = salidasDe.get(s.conversation_id) ?? [];
        l.push(s);
        salidasDe.set(s.conversation_id, l);
    }
    const out: Pendiente[] = [];
    for (const [cid, lista] of porConv) {
        const c = conversaciones.get(cid);
        if (!c || c.status === 'closed') continue;
        // Personal, negocio, otro club, plataforma o staff marcados a mano: nunca son pendientes de la escuela.
        if (esMarcaNoFamilia(c.contact_kind)) continue;
        if (c.tomada_por && (!c.tomada_hasta || new Date(c.tomada_hasta).getTime() > ahora)) continue;
        const ordenados = [...lista].sort((a, b) => t(b) - t(a));
        const esCliente = TIPOS_DE_CLIENTE.has(String(c.contact_kind ?? ''))
            || ordenados.some((e) => esInteres(e.text_body));
        if (!esCliente) continue;
        const ultimo = ordenados.find(entrantePideAlgo);
        if (!ultimo) continue;
        const desde = t(ultimo);
        // ¿Alguien le contestó después? Una persona siempre cuenta; el bot cuenta si
        // no fue un «te paso con la escuela».
        const despues = (salidasDe.get(cid) ?? []).filter((s) => t(s) > desde);
        const contestado = despues.some((s) => s.ai_generated === false
            || !PASOS_QUE_ESPERAN.has(String(s.payload?.step ?? '')));
        if (contestado) continue;
        if (!slaVencido(desde, ahora, horarios.get(c.integration_id) ?? null)) continue;
        out.push({ conversacion: c, desde: new Date(desde).toISOString() });
    }
    return out;
}

/** Fecha local de Bogotá (YYYY-MM-DD): un aviso por conversación y por día. */
function diaLocal(ms: number): string {
    return new Date(ms - 5 * 3600_000).toISOString().slice(0, 10);
}

let ultimaRevision = 0;

export type ResultadoPendientes = { revisadas: number; avisadas: number };

/**
 * Lee las últimas VENTANA_PENDIENTES_HORAS y avisa (push + campana) lo que quedó
 * sin contestar. Idempotente entre los BFF: el aviso lleva id determinístico por
 * conversación y día. Como mucho una vuelta cada CADA_MS. Nunca lanza.
 */
export async function revisarPendientesSinRespuesta(
    ahora = Date.now(), forzar = false,
    esInteres: (t: string | null | undefined) => boolean = intencionDeProspecto,
): Promise<ResultadoPendientes> {
    const r: ResultadoPendientes = { revisadas: 0, avisadas: 0 };
    if (!forzar && ahora - ultimaRevision < CADA_MS) return r;
    ultimaRevision = ahora;
    try {
        const desde = new Date(ahora - VENTANA_PENDIENTES_HORAS * 3600_000).toISOString();
        const { data: ent, error } = await supabase.from('whatsapp_messages')
            .select('conversation_id, type, text_body, wa_timestamp, created_at')
            .eq('direction', 'inbound')
            .gte('created_at', desde)
            .order('created_at', { ascending: false })
            .limit(2000);
        if (error || !Array.isArray(ent) || !ent.length) return r;
        const ids = [...new Set((ent as any[]).map((e) => e.conversation_id).filter(Boolean))] as string[];
        const [{ data: sal }, { data: convs }] = await Promise.all([
            supabase.from('whatsapp_messages')
                .select('conversation_id, direction, ai_generated, payload, wa_timestamp, created_at')
                .eq('direction', 'outbound').in('conversation_id', ids).gte('created_at', desde)
                .limit(5000),
            supabase.from('whatsapp_conversations')
                .select('id, integration_id, contact_wa_id, contact_name, contact_kind, status, tomada_por, tomada_hasta')
                .in('id', ids),
        ]);
        const conversaciones = new Map<string, ConversacionParaPendiente>(
            ((convs ?? []) as any[]).map((c) => [c.id as string, c as ConversacionParaPendiente]));
        const integraciones = [...new Set([...conversaciones.values()].map((c) => c.integration_id))];
        const { data: ajustes } = await supabase.from('whatsapp_settings')
            .select('integration_id, business_hours').in('integration_id', integraciones);
        const horarios = new Map<string, HorarioDeAtencion | null>(
            ((ajustes ?? []) as any[]).map((a) => [a.integration_id as string, (a.business_hours ?? null) as HorarioDeAtencion | null]));
        // Sin horario de atención cargado, el reloj corre de noche: que no suene de 9 p. m. a 7 a. m.
        const hora = new Date(ahora - 5 * 3600_000).getUTCHours();
        const deNoche = hora < 7 || hora >= 21;

        const pendientes = decidirPendientes(ent as EntranteParaPendiente[], (sal ?? []) as SalienteParaPendiente[],
            conversaciones, horarios, ahora, esInteres);
        r.revisadas = pendientes.length;
        const { data: escuelas } = pendientes.length
            ? await supabase.from('school_whatsapp_integrations').select('id, school_id')
                .in('id', [...new Set(pendientes.map((p) => p.conversacion.integration_id))])
            : { data: [] as any[] };
        const escuelaDe = new Map(((escuelas ?? []) as any[]).map((e) => [e.id as string, e.school_id as string]));
        for (const p of pendientes) {
            const c = p.conversacion;
            const schoolId = escuelaDe.get(c.integration_id);
            if (!schoolId) continue;
            if (deNoche && !horarios.get(c.integration_id)?.dias) continue;
            const n = await avisarEscalacionAlEquipo({
                schoolId, conversationId: c.id, contactWaId: c.contact_wa_id, contactName: c.contact_name,
                urgencia: 'normal', categoria: null, etapa: 'reaviso', push: true,
                ancla: `pendiente:${c.id}:${diaLocal(ahora)}`,
                minSinRespuesta: SLA_ESCALAMIENTO_MIN_HABILES,
            }).catch(() => 0);
            if (n > 0) r.avisadas++;
        }
    } catch (err: any) {
        console.warn('[wa-discreto] no se pudo revisar lo pendiente', { err: err?.message });
    }
    return r;
}

/** Solo tests. */
export function _reiniciarRevisionDePendientes(): void { ultimaRevision = 0; }
