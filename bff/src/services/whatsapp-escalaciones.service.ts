/**
 * whatsapp-escalaciones — Escalar es atender: urgencia, aviso y plazo.
 *
 * Dynasty, 2026-10-06 (calidad-bot-whatsapp-dynasty-2026-10-06-tarde.md): tres
 * pedidos de «hablar con una persona» de la tarde quedaron sin respuesta humana
 * en todo el día, uno urgente (`62db6756`: «Estamos varios en Colibrí y no han
 * llegado a dar la clase»). El bot decía «en breve te contactan» y ahí terminaba
 * todo: un push en la transición a 'open' y nada más.
 *
 * Ahora:
 *   1. Cada escalación se CLASIFICA (`clasificarUrgencia`): incidencia en la
 *      sede o la clase, lesión o seguridad = urgente. Pura y con reglas.
 *   2. Se avisa al owner y a los admins con notificación in-app SIEMPRE y push
 *      inmediato si es urgente (el push normal ya sale en la transición a
 *      abierta, `avisarQueEsperan`).
 *   3. El saliente «escalated» lleva `plazo_min` (10 urgente / 30 normal). Si
 *      vence sin que una persona de la escuela haya escrito en el chat, se
 *      re-avisa al equipo y se le dice a la familia algo honesto
 *      (`revisarEscalacionesVencidas`, en whatsapp-bot.service).
 *
 * Idempotencia entre los tres BFF (comparten la base): las notificaciones
 * llevan id DETERMINÍSTICO (`uuidDeClave`), y el 23505 del segundo BFF corta
 * también su push; el re-aviso se reserva con un UPDATE condicional sobre el
 * mismo saliente (`payload->>reaviso_at IS NULL`). Nada en memoria.
 */

import { supabase } from '../config/supabase';
import { sendToUser } from './push.service';
import { avisarCasoPorPlataforma } from './plataforma-wa-avisos.service';
import { uuidDeClave, etiquetaDeContacto } from './avisos-correo.service';
import { esSoloAdjunto, esHumanoDeLaEscuela, type FilaReciente } from './whatsapp-reglas-turno';

export type Urgencia = 'urgente' | 'normal';
export type CategoriaUrgente = 'clase' | 'lesion' | 'seguridad' | 'urgente_declarado';

/** Minutos que tiene la escuela para responder antes del re-aviso. */
export const PLAZO_ESCALACION_MIN: Record<Urgencia, number> = {
    urgente: Number(process.env.WHATSAPP_PLAZO_URGENTE_MIN) || 10,
    normal: Number(process.env.WHATSAPP_PLAZO_NORMAL_MIN) || 30,
};

/** Hasta cuándo se miran escalaciones viejas (las de más atrás ya no tienen sentido). */
export const VENTANA_REVISION_HORAS = 6;

function normalizar(t: string | null | undefined): string {
    return String(t ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Algo de la clase o de la sede: sin esto «no han llegado» son los uniformes. */
const CONTEXTO_CLASE = /\b(clases?|entreno|entrenos|entrenamientos?|practicas?|profes?|profesor[a]?|profesores|entrenador[a]?|entrenadores|cancha|coliseo|sede|polideportivo|colibri|nido)\b/;
const INCIDENCIA_CLASE: RegExp[] = [
    /\bno (ha|han|a|an) (llegado|venido|abierto|aparecido)\b/,
    /\bno (llego|vino|aparecio|abrio|abrieron|llegaron|vinieron)\b/,
    /\bnadie (ha llegado|llego|vino|esta|aparece|abre)\b/,
    /\bno hay (nadie|profe|profesor[a]?|entrenador[a]?)\b/,
    /\bestamos esperando (al|a la|el|la|a los|que)\b/,
    /\b(esta|estan) cerrad[oa]s?\b/,
    /\bno (nos )?(abren|abrieron|dejan entrar)\b/,
];
const LESION: RegExp[] = [
    /\b(se lesiono|lesionad[oa]|se golpeo|se pego|golpe en la cabeza|se desmayo|desmay\w*|convulsi\w*|fractur\w*|sangr\w*|no puede respirar|se ahoga\w*|ambulancia|urgencias|accidente|herid[oa]s?)\b/,
];
const SEGURIDAD: RegExp[] = [
    // Con la persona de por medio: «no aparece mi pago» o «la clase perdida» no son esto.
    /\b(se perdio|perdid[oa]|extraviad[oa]|no aparece|no (lo|la) encuentro|no (lo|la) encontramos)\b(\s+\w+){0,3}\s+(mi|el|la|nuestr[oa])?\s*(hij[oa]s?|nin[oa]s?|nen[ea]s?|sobrin[oa]s?|atleta|jugador[a]?)\b/,
    /\b(mi|el|la|nuestr[oa]) (hij[oa]|nin[oa]|nen[ea]|atleta)\b(\s+\w+){0,3}\s+(se perdio|no aparece|no (lo|la) encuentro|esta perdid[oa])\b/,
    /\b(no (lo|la) han recogido|nadie (lo|la) recogio|se (lo|la) llevaron|acoso|acosando|abuso|abusando|amenaz\w*|en peligro)\b/,
];
const URGENTE_DECLARADO = /\b(urgente|urgencia|emergencia)\b/;

/**
 * Incidencia que no puede esperar: la clase que no se da con la gente en la
 * sede, una lesión, algo de seguridad. Es lo que el turno escala DE UNA, sin
 * pasar por el modelo. «Es urgente» a secas no alcanza para eso (puede ser un
 * paz y salvo), pero sí sube la urgencia de una escalación (`clasificarUrgencia`).
 */
export function incidenciaUrgente(texto: string | null | undefined): CategoriaUrgente | null {
    const t = normalizar(texto);
    if (!t) return null;
    if (LESION.some((re) => re.test(t))) return 'lesion';
    if (SEGURIDAD.some((re) => re.test(t))) return 'seguridad';
    if (CONTEXTO_CLASE.test(t) && INCIDENCIA_CLASE.some((re) => re.test(t))) return 'clase';
    return null;
}

/** Urgencia de una escalación, sobre el texto de la familia y el motivo. Pura. */
export function clasificarUrgencia(...textos: (string | null | undefined)[]): { urgencia: Urgencia; categoria: CategoriaUrgente | null } {
    const todo = textos.filter(Boolean).join('\n');
    const categoria = incidenciaUrgente(todo) ?? (URGENTE_DECLARADO.test(normalizar(todo)) ? 'urgente_declarado' : null);
    return { urgencia: categoria ? 'urgente' : 'normal', categoria };
}

// ─── Solicitud de retiro (Dynasty 2026-10-08) ───────────────────────────────
//
// «Mi hijo … ya no va a seguir en el club» + «que no me sigan cobrando»:
// es un RETIRO, y la escuela tiene que registrarlo antes
// del próximo cobro. Escala con prioridad (push inmediato) y el aviso lo dice
// explícito («Solicitud de retiro: …»). Ojo: «cancelar la mensualidad» en
// Colombia es PAGARLA; no cuenta.

const RETIRO: RegExp[] = [
    /\b(ya )?no (va|van|vamos|voy) a (seguir|continuar|volver|regresar|asistir mas|ir mas|entrenar mas)\b/,
    /\bya no (sigue|seguira|continua|continuara|vuelve|volvera|asiste|asistira|entrena|entrenara|va mas|quiere seguir|quiere continuar)\b/,
    /\bno (seguira|continuara|volvera|regresara)\b/,
    /\b(retirar|retirarla|retirarlo|retirarlos|retirarlas|retiramos|retirarse|retiro|retirada|retirado)\b/,
    /\bdar(la|lo|los|las)? de baja\b/,
    /\b(la|lo|los|las|nos|me) (dan|den|damos) de baja\b/,
    /\bbaja (de|del) (club|escuela|academia|grupo|equipo)\b/,
    /\bno (me|nos) (siga|sigan|sigue|siguen|vuelva|vuelvan) (cobrando|llegando el cobro|generando|facturando|apareciendo el cobro)\b/,
    /\bno (me|nos) (siga|sigan|sigue|siguen) (el|los) cobros?\b/,
    /\b(dejen|dejar|deje) de cobrar(me|nos|le)?\b/,
    /\bno (me|nos) (cobren|generen|facturen) mas\b/,
    /\b(desvincul|desafili)\w*/,
    /\bsal(ir|irse|e|en) del (club|grupo|equipo|academia|escuela)\b/,
];
/** Lo que se «retira» y no es un atleta. */
const RETIRO_NO_ES: RegExp[] = [
    /\bretir\w* (el|los|la|las|un|una|mi|mis) (uniformes?|camisetas?|kits?|dotacion|paquetes?|pedidos?|dinero|plata|carnet|documentos?|certificados?)\b/,
    /\b(punto|lugar|hora) de retiro\b/,
];

/** ¿Pide retirar a un atleta o dejar de recibir cobros? Pura. */
export function esSolicitudDeRetiro(...textos: (string | null | undefined)[]): boolean {
    const t = normalizar(textos.filter(Boolean).join(' '));
    if (!t) return false;
    if (RETIRO_NO_ES.some((re) => re.test(t))) return false;
    return RETIRO.some((re) => re.test(t));
}

/** Tema especial de una escalación (por ahora, solo el retiro). */
export type TemaEscalacion = 'retiro' | null;

/** Lo que se le dice a la familia al escalar un retiro. */
export const MENSAJE_ESCALACION_RETIRO =
    'Le paso tu solicitud de *retiro* a la escuela para que la registren 🙏 ' +
    'Una persona del equipo te confirma por aquí.';

// ─── Una sola escalación por conversación (Dynasty 2026-10-08) ──────────────
//
// Una familia escribió en ráfaga un saludo, «mi hijo … ya no va a seguir» y, 46 s
// después de la escalación, «y que no me sigan cobrando». Cada turno escaló por su cuenta: dos «Voy a pasar tu caso…»
// idénticos y, al vencer el plazo, dos «Todavía nadie…» idénticos.
//
// La reserva es la base: el saliente «escalated» ya guardado. Mientras esté
// ABIERTO (sin respuesta de una persona de la escuela y la conversación sin
// cerrar) no sale otro; lo nuevo solo se le suma al equipo si sube de nivel
// (urgente, o retiro).

export interface EstadoDeEscalacion {
    /** Hay un «escalated» de las últimas 24 h que nadie de la escuela contestó. */
    abierta: boolean;
    urgencia: Urgencia | null;
    tema: TemaEscalacion;
    /** El bot ya dijo «Dejo tu mensaje para …» después del último entrante (mismo turno). */
    mensajeParaPersonaEnTurno: boolean;
}

const momentoDe = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();

/** Estado de la escalación de la conversación, sobre sus mensajes recientes. Pura. */
export function estadoDeEscalacion(recientes: FilaReciente[], conversacionCerrada = false): EstadoDeEscalacion {
    const filas = recientes.slice().sort((a, b) => momentoDe(b) - momentoDe(a));
    const ultimaEsc = filas.find((f) => f.direction === 'outbound' && f.payload?.step === 'escalated');
    const ultimoEntrante = filas.find((f) => f.direction === 'inbound');
    const mensajeParaPersonaEnTurno = filas.some((f) => f.direction === 'outbound'
        && f.payload?.step === 'mensaje_para_persona'
        && (!ultimoEntrante || momentoDe(f) >= momentoDe(ultimoEntrante)));
    if (!ultimaEsc || conversacionCerrada) {
        return { abierta: false, urgencia: null, tema: null, mensajeParaPersonaEnTurno };
    }
    const desde = momentoDe(ultimaEsc);
    const contestada = filas.some((f) => momentoDe(f) > desde && esHumanoDeLaEscuela(f) && !esSoloAdjunto(f));
    return {
        abierta: !contestada,
        urgencia: ultimaEsc.payload?.urgencia === 'urgente' ? 'urgente' : 'normal',
        tema: ultimaEsc.payload?.tema === 'retiro' ? 'retiro' : null,
        mensajeParaPersonaEnTurno,
    };
}

/**
 * Qué hace una escalación nueva. Pura.
 *  - 'nueva'       → mensaje a la familia + saliente «escalated» (con plazo).
 *  - 'solo_equipo' → sin mensaje a la familia; el equipo recibe el aviso
 *                    (sube de nivel a retiro, o el bot ya dijo «Dejo tu
 *                    mensaje…» en este mismo turno).
 *  - 'nada'        → ya hay una escalación abierta por lo mismo.
 */
export function decidirEscalacion(
    estado: EstadoDeEscalacion,
    nueva: { urgencia: Urgencia; tema: TemaEscalacion },
): 'nueva' | 'solo_equipo' | 'nada' {
    if (estado.abierta) {
        if (nueva.urgencia === 'urgente' && estado.urgencia !== 'urgente') return 'nueva';
        if (nueva.tema === 'retiro' && estado.tema !== 'retiro') return 'solo_equipo';
        return 'nada';
    }
    if (estado.mensajeParaPersonaEnTurno && nueva.urgencia !== 'urgente') return 'solo_equipo';
    return 'nueva';
}

/**
 * Un solo re-aviso por conversación en cada revisión: si quedaron dos
 * escalaciones pendientes de la misma conversación (las de antes de este
 * arreglo), se re-avisa por la más vieja y las demás se marcan sin re-avisar.
 * Pura.
 */
export function unaPorConversacion<T extends { conversationId: string; createdAt: string }>(
    lista: T[],
): { revisar: T[]; duplicadas: T[] } {
    const orden = lista.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const vistas = new Set<string>();
    const revisar: T[] = [];
    const duplicadas: T[] = [];
    for (const e of orden) {
        if (vistas.has(e.conversationId)) { duplicadas.push(e); continue; }
        vistas.add(e.conversationId);
        revisar.push(e);
    }
    return { revisar, duplicadas };
}

/** ¿Venció el plazo de esta escalación? Pura. */
export function plazoVencido(creadaAt: string | number | Date, plazoMin: number, ahora = Date.now()): boolean {
    const t = new Date(creadaAt).getTime();
    if (!Number.isFinite(t)) return false;
    return ahora - t >= plazoMin * 60_000;
}

/**
 * Lo que se le dice a la familia cuando el plazo venció sin respuesta, o null
 * = no se le dice nada. Pura.
 *
 * Conversación v2 (Dynasty 2026-10-24): «Todavía nadie de la escuela ha podido
 * contestarte… Ya les volví a avisar» era un no-respuesta (a la gente le llegaba
 * una hora después y no decía nada nuevo). Lo normal ahora es una HORA CONCRETA
 * (fuera de horario, cuándo atienden) o callarse: el aviso al equipo (in-app,
 * push y el SLA por correo) sale igual. Lo urgente sí se le dice siempre.
 */
export function textoSinRespuesta(p: {
    urgencia: Urgencia;
    categoria: CategoriaUrgente | null;
    fueraDeHorario: boolean;
    proximaAtencion?: string | null;
}): string | null {
    if (p.urgencia === 'urgente') {
        const emergencia = p.categoria === 'lesion' || p.categoria === 'seguridad'
            ? '\n\nSi alguien está lastimado o en peligro, no esperes este chat: llama ya a la línea de emergencias *123*.'
            : '';
        return 'Todavía nadie de la escuela ha podido contestarte 🙏 Ya les volví a avisar como *urgente*. ' +
            'Apenas alguien lo vea, te escribe por aquí.' + emergencia;
    }
    // Con una hora concreta: «Tu mensaje quedó con la escuela… te responden mañana a las 16:00».
    if (p.fueraDeHorario && p.proximaAtencion) {
        return `Tu mensaje quedó con la escuela 🙏 Ahora están fuera del horario de atención, así que te responden ${p.proximaAtencion}.`;
    }
    // Sin hora que decir, no hay nada nuevo que contarle: se calla.
    return null;
}

/** owner + owner/admin/school_admin activos de la escuela, sin repetir. */
export async function destinatariosDeLaEscuela(schoolId: string): Promise<string[]> {
    const [{ data: escuela }, { data: miembros }] = await Promise.all([
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('profile_id')
            .eq('school_id', schoolId).eq('status', 'active')
            .in('role', ['owner', 'admin', 'school_admin']),
    ]);
    const ids = new Set<string>();
    for (const m of (miembros ?? []) as any[]) if (m.profile_id) ids.add(m.profile_id);
    if ((escuela as any)?.owner_id) ids.add((escuela as any).owner_id);
    return [...ids];
}

export interface AvisoDeEscalacion {
    schoolId: string;
    conversationId: string;
    contactWaId: string;
    contactName: string | null;
    urgencia: Urgencia;
    categoria: CategoriaUrgente | null;
    /** 'inicial' al escalar, 'reaviso' al vencer el plazo. */
    etapa: 'inicial' | 'reaviso';
    /** Identifica ESTA escalación (id del saliente o minuto); arma el id determinístico. */
    ancla: string;
    /** ¿Mandar push? (el inicial normal no: ya lo manda la transición a abierta). */
    push: boolean;
    /** 'retiro': el aviso lo dice explícito («Solicitud de retiro: …»). */
    tema?: TemaEscalacion;
    /**
     * Minutos (hábiles) sin respuesta humana que dice el aviso del 'reaviso'. Sin
     * esto dice el plazo corto de siempre (10/30 min); el SLA de 2 h hábiles lo pasa.
     */
    minSinRespuesta?: number;
}

/** «30 min» / «2 h» para los avisos. */
function duracionLegible(min: number): string {
    return min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}

const ETIQUETA_CATEGORIA: Record<CategoriaUrgente, string> = {
    clase: 'problema con la clase o la sede',
    lesion: 'posible lesión',
    seguridad: 'tema de seguridad',
    urgente_declarado: 'lo marcó como urgente',
};

/** Título y cuerpo del aviso al equipo. Pura. */
export function textoDelAvisoAlEquipo(
    a: Pick<AvisoDeEscalacion, 'etapa' | 'urgencia' | 'categoria' | 'tema' | 'minSinRespuesta'>,
    quien: string,
): { titulo: string; cuerpo: string } {
    const urgente = a.urgencia === 'urgente';
    const espera = duracionLegible(a.minSinRespuesta ?? PLAZO_ESCALACION_MIN[a.urgencia]);
    if (a.tema === 'retiro') {
        return a.etapa === 'reaviso'
            ? { titulo: `Solicitud de retiro sin respuesta: ${quien}`,
                cuerpo: `Pasaron ${espera} y nadie le ha respondido por WhatsApp. ` +
                    'Pide retirar a un deportista y que no le sigan cobrando.' }
            : { titulo: `Solicitud de retiro: ${quien}`,
                cuerpo: 'Pide retirar a un deportista y que no le sigan cobrando. ' +
                    'Regístralo antes del próximo cobro y respóndele en WhatsApp en SportMaps.' };
    }
    const titulo = a.etapa === 'reaviso'
        ? (urgente ? `URGENTE sin respuesta: ${quien}` : `${quien} sigue esperando respuesta`)
        : (urgente ? `URGENTE en WhatsApp: ${quien}` : `${quien} pidió hablar con la escuela`);
    const cuerpo = a.etapa === 'reaviso'
        ? `Pasaron ${espera} y nadie le ha respondido por WhatsApp.` +
          (a.categoria ? ` Motivo: ${ETIQUETA_CATEGORIA[a.categoria]}.` : '')
        : (a.categoria ? `Motivo: ${ETIQUETA_CATEGORIA[a.categoria]}. ` : '') +
          'El asistente le dijo que una persona le responde. Abre WhatsApp en SportMaps.';
    return { titulo, cuerpo };
}

/**
 * In-app (+ push si `push`) a cada admin. Idempotente: el id de la
 * notificación sale de la clave; si otro BFF ya la insertó (23505), este no
 * manda el push. Nunca lanza. Devuelve cuántas notificaciones nuevas dejó.
 */
export async function avisarEscalacionAlEquipo(a: AvisoDeEscalacion): Promise<number> {
    try {
        const ids = await destinatariosDeLaEscuela(a.schoolId);
        if (!ids.length) return 0;
        const quien = etiquetaDeContacto(a.contactName, a.contactWaId);
        const urgente = a.urgencia === 'urgente';
        const { titulo, cuerpo } = textoDelAvisoAlEquipo(a, quien);
        // Canal de plataforma: al WhatsApp personal de la dueña/admin con opt-in.
        // Idempotente por su propia reserva (misma ancla/etapa). Flag apagado = nada.
        avisarCasoPorPlataforma({
            schoolId: a.schoolId, conversationId: a.conversationId, ancla: a.ancla, etapa: a.etapa,
            urgente, retiro: a.tema === 'retiro', titulo, cuerpo,
        });
        let nuevas = 0;
        await Promise.allSettled(ids.map(async (uid) => {
            const { data: entro, error } = await supabase.from('notifications').upsert({
                id: uuidDeClave(`wa_escalacion:${a.conversationId}:${a.ancla}:${a.etapa}:${uid}`),
                user_id: uid,
                school_id: a.schoolId,
                title: titulo,
                message: cuerpo,
                type: urgente ? 'warning' : 'info',
                // El CHECK de `notifications.category` no tiene 'whatsapp'; el buzón es atención.
                category: 'support',
                link: `/whatsapp?conversacion=${a.conversationId}`,
                data: {
                    tipo: 'whatsapp_escalado', etapa: a.etapa, urgencia: a.urgencia, categoria: a.categoria,
                    tema: a.tema ?? null,
                    conversation_id: a.conversationId, school_id: a.schoolId,
                },
            }, { onConflict: 'id', ignoreDuplicates: true }).select('id');
            if (error || !(entro ?? []).length) return; // sin fila: otro BFF ya avisó a esta persona por esta escalación.
            nuevas++;
            if (a.push) {
                await sendToUser(uid, {
                    title: titulo,
                    body: cuerpo,
                    // FCM exige que todos los valores sean string.
                    data: { tipo: 'whatsapp_escalado', conversation_id: a.conversationId, school_id: a.schoolId,
                            urgencia: a.urgencia, etapa: a.etapa },
                }).catch(() => undefined);
            }
        }));
        return nuevas;
    } catch (e: any) {
        console.warn('[wa-escalaciones] no se pudo avisar al equipo', { conversationId: a.conversationId, err: e?.message });
        return 0;
    }
}

export interface EscalacionPendiente {
    id: string;
    conversationId: string;
    integrationId: string;
    createdAt: string;
    payload: Record<string, any>;
}

/**
 * Salientes «escalated» con plazo (`payload.plazo_min`), de las últimas
 * VENTANA_REVISION_HORAS, sin re-aviso todavía. Las escalaciones de antes de
 * este cambio no tienen `plazo_min` y no se tocan: re-avisar algo de hace
 * horas que nadie configuró así sería una sorpresa. Nunca lanza.
 */
export async function escalacionesSinRevisar(ahora = Date.now()): Promise<EscalacionPendiente[]> {
    try {
        const { data, error } = await supabase.from('whatsapp_messages')
            .select('id, conversation_id, integration_id, created_at, payload')
            .eq('direction', 'outbound')
            .eq('payload->>step', 'escalated')
            .not('payload->>plazo_min', 'is', null)
            .is('payload->>reaviso_at', null)
            .gte('created_at', new Date(ahora - VENTANA_REVISION_HORAS * 3600_000).toISOString())
            .lte('created_at', new Date(ahora - Math.min(...Object.values(PLAZO_ESCALACION_MIN)) * 60_000).toISOString())
            .limit(50);
        if (error || !Array.isArray(data)) return [];
        return (data as any[]).map((f) => ({
            id: f.id, conversationId: f.conversation_id, integrationId: f.integration_id,
            createdAt: f.created_at, payload: f.payload ?? {},
        }));
    } catch {
        return [];
    }
}

/**
 * ¿Una PERSONA de la escuela escribió en el chat después de la escalación?
 * Solo cuenta lo que trae TEXTO: una imagen, una ubicación o un sticker sueltos
 * no contestan la pregunta (auditoría 2026-10-07, …1042 y …6297).
 */
export async function respondioUnaPersona(conversationId: string, desde: string): Promise<boolean> {
    const { data, error } = await supabase.from('whatsapp_messages')
        .select('type, text_body')
        .eq('conversation_id', conversationId)
        .eq('direction', 'outbound')
        .eq('ai_generated', false)
        .gt('created_at', desde)
        .limit(50);
    // Sin poder leer, se da por respondida: un re-aviso de más a la familia
    // («nadie te ha contestado») cuando sí le contestaron es peor que uno de menos.
    if (error || !Array.isArray(data)) return true;
    return (data as any[]).some((f) => !esSoloAdjunto(f));
}

/**
 * Reserva el re-aviso de UNA escalación: UPDATE condicional sobre el mismo
 * saliente. Solo uno de los BFF lo logra. Devuelve true si este lo tomó.
 */
export async function reservarRevision(e: EscalacionPendiente, resultado: string, ahora = Date.now()): Promise<boolean> {
    const { data, error } = await supabase.from('whatsapp_messages')
        .update({ payload: { ...e.payload, reaviso_at: new Date(ahora).toISOString(), reaviso: resultado } })
        .eq('id', e.id)
        .is('payload->>reaviso_at', null)
        .select('id');
    return !error && Array.isArray(data) && data.length > 0;
}
