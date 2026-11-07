/**
 * whatsapp-referidos-bot — referidos en el bot (spec docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md
 * §4.4; contrato en docs/contratos-api-oleada-1-2026-11-06.md §1, «Para el bot»).
 *
 * Dos piezas, ambas detrás de la campaña de referidos ACTIVA de la escuela (`school_discount_campaigns`, lectura
 * por `leerCampana`; en caché 60 s). Sin campaña activa el flujo es IDÉNTICO al de hoy: no se pregunta nada.
 *
 *  (a) «¿Te refirió alguien del club?» — UNA sola vez, justo después de que el interesado agenda su clase de
 *      prueba (el embudo llega a `embudo_agendada`, o la clase de cortesía a `cortesia_reservada`). Opcional,
 *      no bloquea nada: lo que conteste se guarda en `school_signup_leads.source_detail.referido_por` SIN
 *      confirmar (`referido_confirmado: false`); quien lo vincula y lo confirma es la administración. «No» y
 *      «nadie» se anotan como `referido_respondio: 'no'`. Solo se lee la respuesta que viene INMEDIATAMENTE
 *      después de la pregunta; una pregunta de otro tema sigue su camino y no se lee como nombre.
 *  (b) «¿Tienen descuento por referidos?» — se contesta SOLO con la campaña activa de ESA escuela (tramos por
 *      edad y mes siguiente). Sin campaña activa, se deriva a la escuela (salvo en modo discreto, donde el bot
 *      calla como siempre). El bot NUNCA calcula ni promete un descuento: lo aplica el cierre de mes.
 *
 * Nunca dice «gratis», «mora», «deuda», «atraso», «vencid», «multa» ni «recargo». Todo en español, tuteando.
 * Apagado de emergencia: `WA_REFERIDOS_BOT=false`.
 */
import { supabase } from '../config/supabase';
import { leerCampana, type CampanaFila, type Tramo } from './referidos.service';
import { normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';

export const PASO_REFERIDO_PREGUNTA = 'referido_pregunta';
export const PASO_REFERIDO_RESPUESTA = 'referido_respuesta';
export const PASO_REFERIDOS_INFO = 'referidos_info';
export const PASO_REFERIDOS_A_LA_ESCUELA = 'referidos_a_la_escuela';
/** Pasos que cierran la clase de prueba: ahí se hace la pregunta. */
export const PASOS_CIERRE_DE_CLASE = ['embudo_agendada', 'cortesia_reservada'] as const;

export function referidosBotActivo(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.WA_REFERIDOS_BOT !== 'false';
}

// ─── Campaña activa (lectura, caché 60 s) ────────────────────────────────────

export type LecturaCampana =
    | { estado: 'activa'; campana: CampanaFila }
    | { estado: 'sin_campana_activa' }
    | { estado: 'no_disponible' }; // tabla sin migrar o error: el bot se comporta como siempre

const cache = new Map<string, { hasta: number; lectura: LecturaCampana }>();
/** Vacía el caché (pruebas). */
export function limpiarCacheReferidos(): void { cache.clear(); }

const hoyIso = (ahora = new Date()) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);

/** ¿La campaña está vigente hoy? Pura. */
export function campanaVigente(c: Pick<CampanaFila, 'active' | 'starts_on' | 'ends_on'>, hoy = hoyIso()): boolean {
    if (!c.active) return false;
    if (c.starts_on && hoy < c.starts_on) return false;
    if (c.ends_on && hoy > c.ends_on) return false;
    return true;
}

export interface DepsReferidos {
    leer: (schoolId: string) => Promise<CampanaFila | null>;
    /** step del saliente más reciente (mensajes o borradores) de los últimos `minutos`, o null. */
    ultimoPaso: (conversationId: string, minutos: number) => Promise<string | null>;
    /** ¿Se mandó este paso en la conversación en las últimas `horas`? */
    pasoEnviado: (conversationId: string, step: string, horas: number) => Promise<boolean>;
    /** Marca el lead de la conversación. false = no hay lead. */
    guardarEnLead: (schoolId: string, conversationId: string, contactWaId: string, detalle: Record<string, unknown>) => Promise<boolean>;
}

export const DEPS_REFERIDOS: DepsReferidos = {
    leer: (schoolId) => leerCampana(schoolId),
    async pasoEnviado(conversationId, step, horas) {
        const desde = new Date(Date.now() - horas * 3600_000).toISOString();
        const { count } = await supabase.from('whatsapp_messages')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversationId).eq('direction', 'outbound')
            .eq('payload->>step', step).gte('created_at', desde);
        if ((count ?? 0) > 0) return true;
        const { count: borradores } = await supabase.from('whatsapp_message_drafts')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversationId).eq('tool_context->>step', step).gte('created_at', desde);
        return (borradores ?? 0) > 0;
    },
    async ultimoPaso(conversationId, minutos) {
        const desde = new Date(Date.now() - minutos * 60_000).toISOString();
        const { data } = await supabase.from('whatsapp_messages')
            .select('payload, created_at').eq('conversation_id', conversationId).eq('direction', 'outbound')
            .gte('created_at', desde).order('created_at', { ascending: false }).limit(1);
        const { data: dr } = await supabase.from('whatsapp_message_drafts')
            .select('tool_context, created_at').eq('conversation_id', conversationId)
            .gte('created_at', desde).order('created_at', { ascending: false }).limit(1);
        const m: any = ((data ?? []) as any[])[0];
        const d: any = ((dr ?? []) as any[])[0];
        const f = (m && d) ? (new Date(m.created_at) >= new Date(d.created_at) ? m : d) : (m ?? d);
        return f ? String((f.payload ?? f.tool_context)?.step ?? '') || null : null;
    },
    async guardarEnLead(schoolId, conversationId, contactWaId, detalle) {
        const cols = 'id, source_detail';
        let { data } = await supabase.from('school_signup_leads').select(cols)
            .eq('school_id', schoolId).eq('source_detail->>conversation_id', conversationId)
            .order('created_at', { ascending: false }).limit(1);
        let lead = ((data ?? []) as any[])[0];
        if (!lead) {
            const t = String(contactWaId).replace(/\D/g, '').slice(-10);
            if (/^3\d{9}$/.test(t)) {
                ({ data } = await supabase.from('school_signup_leads').select(cols)
                    .eq('school_id', schoolId).ilike('phone', `%${t}`)
                    .order('created_at', { ascending: false }).limit(1));
                lead = ((data ?? []) as any[])[0];
            }
        }
        if (!lead) return false;
        const { error } = await supabase.from('school_signup_leads')
            .update({ source_detail: { ...(lead.source_detail ?? {}), ...detalle }, updated_at: new Date().toISOString() })
            .eq('id', lead.id);
        return !error;
    },
};

/** Lectura de la campaña de la escuela, con caché de 60 s. Nunca lanza. */
export async function campanaDeLaEscuela(schoolId: string, deps: DepsReferidos = DEPS_REFERIDOS): Promise<LecturaCampana> {
    const c = cache.get(schoolId);
    if (c && c.hasta > Date.now()) return c.lectura;
    let lectura: LecturaCampana;
    try {
        const fila = await deps.leer(schoolId);
        lectura = fila && campanaVigente(fila) ? { estado: 'activa', campana: fila } : { estado: 'sin_campana_activa' };
    } catch {
        lectura = { estado: 'no_disponible' };
    }
    cache.set(schoolId, { hasta: Date.now() + 60_000, lectura });
    return lectura;
}

// ─── Reglas puras ────────────────────────────────────────────────────────────

/** «¿Tienen descuento por referidos?», «si traigo a un amigo hay descuento», «promoción por recomendar». */
export function preguntaPorReferidos(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t || t.length > 200) return false;
    const tema = /\b(referid[oa]s?|referir|refiero|refiere|recomiend[oa]s?|recomendar|traer a (un|una) (amig|conocid|familiar)\w*|traigo a (un|una) (amig|conocid|familiar)\w*|invito a (un|una) (amig|conocid)\w*|amigos? nuevos?)\b/;
    const beneficio = /\b(descuento|descuentos|promo|promocion|beneficio|beneficios|premio|gano|ganar|gana|rebaja|oferta|campana)\b/;
    if (!(tema.test(t) && beneficio.test(t))) return false;
    // «Ya referí a alguien, ¿cuándo me aplican el descuento?» es un trámite de la familia: lo ve la escuela.
    if (/\b(cuando me|ya (lo )?(refer|recomend)|no me (aplic|llego|salio))/.test(t)) return false;
    return true;
}

const NEGATIVAS = /^(no|nop|nope|nadie|ninguno|ninguna|no nadie|nadie me (refirio|recomendo|dijo)|no me (refirio|recomendo) nadie|no fue nadie|llegue sola?|llegue por mi (cuenta|propia cuenta)|por (instagram|facebook|google|internet|redes|el anuncio)|vi (el|un) anuncio|no gracias|ninguno gracias)$/;

/** Lo que dice la persona al «¿te refirió alguien?». 'nombre' trae el texto limpio (máx. 80). Pura. */
export function leerRespuestaDeReferido(texto: string | null | undefined):
    | { tipo: 'no' } | { tipo: 'nombre'; nombre: string } | { tipo: 'otra_cosa' } {
    const crudo = (texto ?? '').trim();
    if (!crudo) return { tipo: 'otra_cosa' };
    const t = normalizarFrase(crudo);
    if (NEGATIVAS.test(t)) return { tipo: 'no' };
    if (crudo.includes('?')) return { tipo: 'otra_cosa' };
    // «Me refirió Laura Pérez», «fue la familia de Sofía», «el papá de Juan», «Laura».
    const sinPrefijo = crudo
        .replace(/^(hola[, ]*)?(me\s+)?(refiri[oó]|recomend[oó]|invit[oó]|dijo|trajo|conoc[ií])\s+(la\s+|el\s+)?/i, '')
        .replace(/^(fue|fueron|es|son|ser[aá])\s+(la\s+familia\s+de\s+|el\s+pap[aá]\s+de\s+|la\s+mam[aá]\s+de\s+|la\s+|el\s+)?/i, '')
        .replace(/^(la\s+familia\s+de|el\s+pap[aá]\s+de|la\s+mam[aá]\s+de|el\s+acudiente\s+de)\s+/i, '')
        .replace(/[.!¡]+$/g, '')
        .trim();
    const palabras = sinPrefijo.split(/\s+/).filter(Boolean);
    if (palabras.length === 0 || palabras.length > 6 || sinPrefijo.length > 80) return { tipo: 'otra_cosa' };
    if (!/\p{L}/u.test(sinPrefijo)) return { tipo: 'otra_cosa' };
    // Cosas que no son un nombre: horarios, precios, saludos, cierres.
    if (/\b(horario|precio|valor|cuanto|donde|cuando|sede|clase|inscri|matricul|gracias|hola|buenas|buenos|ok|listo|vale|si|sii|claro|dale|bueno|perfecto|entendido)\b/.test(normalizarFrase(sinPrefijo))) return { tipo: 'otra_cosa' };
    return { tipo: 'nombre', nombre: sinPrefijo };
}

const rangoDeEdad = (t: Tramo) => (t.age_max === null ? `${t.age_min} años o más` : `de ${t.age_min} a ${t.age_max} años`);

/** Texto de la campaña activa: solo lo que la escuela configuró. Nunca calcula un descuento. Puro. */
export function textoDeCampana(c: Pick<CampanaFila, 'name' | 'tiers' | 'reward_months'>): string {
    const tramos = [...c.tiers].sort((a, b) => a.age_min - b.age_min)
        .map((t) => `• Si la persona referida tiene ${rangoDeEdad(t)}: *${t.pct} %* de descuento`);
    const meses = c.reward_months > 1 ? `${c.reward_months} mensualidades` : 'tu mensualidad';
    return `¡Sí! 🙌 La escuela tiene la campaña *${c.name}*: si refieres a un deportista nuevo, el descuento se aplica en ${meses} del *mes siguiente*, ` +
        `según la edad de quien refieres:\n\n${tramos.join('\n')}\n\n` +
        'El descuento lo aplica la escuela al cerrar el mes, cuando la persona referida paga su primera mensualidad. ' +
        'Si te refirió alguien, cuéntame quién y lo dejo anotado; la escuela lo confirma. Cualquier duda, una persona del equipo te ayuda. 😊';
}

export const TEXTO_REFERIDO_PREGUNTA = '¡Una última cosa! 😊 ¿Te refirió alguien del club? Si es así, dime su nombre y lo dejo anotado (es opcional, puedes ignorar esta pregunta).';
export const TEXTO_REFERIDO_GRACIAS = (nombre: string) => `¡Gracias! Dejé anotado que te refirió *${nombre}*. La escuela lo confirma. 🙌`;
export const TEXTO_REFERIDO_NO = 'Listo, gracias por contarme. ¡Nos vemos en la cancha! 🙌';
export const TEXTO_REFERIDOS_A_LA_ESCUELA = 'Eso lo confirma la escuela: ya le paso tu pregunta para que te responda por aquí. 🙏';

// ─── Entradas del bot ────────────────────────────────────────────────────────

export interface CtxReferidos {
    schoolId: string;
    conversationId: string;
    contactWaId: string;
    /** Modo discreto efectivo: sin campaña activa el bot calla (no deriva). */
    discreto: boolean;
    enviar: (texto: string, context: Record<string, unknown>) => Promise<void>;
    /** Deja la conversación abierta y avisa a la escuela. */
    derivar: () => Promise<void>;
}

/**
 * (b) «¿Tienen descuento por referidos?». true = contestado. Va DESPUÉS de las reglas de comprobante y de la
 * atención de la escuela (quien llama ya las pasó). Nunca lanza.
 */
export async function responderPreguntaDeReferidos(
    ctx: CtxReferidos, texto: string, deps: DepsReferidos = DEPS_REFERIDOS,
): Promise<boolean> {
    try {
        if (!referidosBotActivo() || !preguntaPorReferidos(texto)) return false;
        const l = await campanaDeLaEscuela(ctx.schoolId, deps);
        if (l.estado === 'no_disponible') return false;
        if (l.estado === 'activa') {
            await ctx.enviar(textoDeCampana(l.campana), { step: PASO_REFERIDOS_INFO });
            return true;
        }
        if (ctx.discreto) return false; // el bot discreto no contesta lo que no es información pública
        if (await deps.pasoEnviado(ctx.conversationId, PASO_REFERIDOS_A_LA_ESCUELA, 24)) return false;
        await ctx.enviar(TEXTO_REFERIDOS_A_LA_ESCUELA, { step: PASO_REFERIDOS_A_LA_ESCUELA });
        await ctx.derivar();
        return true;
    } catch (e: any) {
        console.warn('[whatsapp-referidos] no se pudo contestar la pregunta', { err: e?.message });
        return false;
    }
}

/**
 * (a, respuesta) El mensaje que sigue a «¿Te refirió alguien del club?». true = era la respuesta (atendida).
 * Solo cuenta el PRIMER entrante después de la pregunta: `recientes` (24 h) trae la pregunta y lo que llegó.
 */
export async function atenderRespuestaDeReferido(
    ctx: CtxReferidos, texto: string, recientes: readonly FilaReciente[] | (() => Promise<readonly FilaReciente[]>),
    deps: DepsReferidos = DEPS_REFERIDOS, botonId: string | null = null,
): Promise<boolean> {
    try {
        if (!referidosBotActivo() || botonId) return false;
        // Sin campaña activa no se lee nada más (flujo idéntico al de hoy).
        if ((await campanaDeLaEscuela(ctx.schoolId, deps)).estado !== 'activa') return false;
        const filas = typeof recientes === 'function' ? await recientes() : recientes;
        const m = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
        const salientes = filas.filter((f) => f.direction === 'outbound').sort((a, b) => m(b) - m(a));
        const ultimo = salientes[0];
        // Lo último que se le dijo fue la pregunta (si el bot o la escuela habló después, ya no aplica).
        if (!ultimo || ultimo.payload?.step !== PASO_REFERIDO_PREGUNTA) return false;
        const entrantesDespues = filas.filter((f) => f.direction === 'inbound' && m(f) > m(ultimo));
        if (entrantesDespues.length > 1) return false; // solo el inmediato (el actual ya está guardado)
        const l = await campanaDeLaEscuela(ctx.schoolId, deps);
        if (l.estado !== 'activa') return false;

        const r = leerRespuestaDeReferido(texto);
        if (r.tipo === 'otra_cosa') return false; // sigue su camino; la pregunta no se repite
        const detalle = r.tipo === 'no'
            ? { referido_respondio: 'no' }
            : { referido_por: r.nombre, referido_confirmado: false, referido_respondio: 'nombre' };
        const guardado = await deps.guardarEnLead(ctx.schoolId, ctx.conversationId, ctx.contactWaId,
            { ...detalle, referido_at: new Date().toISOString() });
        if (!guardado) return false; // sin lead no hay dónde anotarlo: no se promete nada
        await ctx.enviar(r.tipo === 'no' ? TEXTO_REFERIDO_NO : TEXTO_REFERIDO_GRACIAS(r.nombre), { step: PASO_REFERIDO_RESPUESTA });
        return true;
    } catch (e: any) {
        console.warn('[whatsapp-referidos] no se pudo guardar el referido', { err: e?.message });
        return false;
    }
}

/**
 * (a, pregunta) Después de un turno del interesado: si ACABA de quedar agendada su clase de prueba y la escuela
 * tiene campaña activa, UNA pregunta opcional. true = se preguntó. Nunca lanza.
 */
export async function preguntarPorReferido(ctx: CtxReferidos, deps: DepsReferidos = DEPS_REFERIDOS): Promise<boolean> {
    try {
        if (!referidosBotActivo()) return false;
        const l = await campanaDeLaEscuela(ctx.schoolId, deps);
        if (l.estado !== 'activa') return false;
        // Lo ÚLTIMO que se le dijo (3 min) fue el cierre de la clase: si va el consentimiento después, se espera.
        const ultimo = await deps.ultimoPaso(ctx.conversationId, 3);
        if (!ultimo || !(PASOS_CIERRE_DE_CLASE as readonly string[]).includes(ultimo)) return false;
        if (await deps.pasoEnviado(ctx.conversationId, PASO_REFERIDO_PREGUNTA, 24 * 90)) return false; // una sola vez
        await ctx.enviar(TEXTO_REFERIDO_PREGUNTA, { step: PASO_REFERIDO_PREGUNTA });
        return true;
    } catch (e: any) {
        console.warn('[whatsapp-referidos] no se pudo preguntar por el referido', { err: e?.message });
        return false;
    }
}
