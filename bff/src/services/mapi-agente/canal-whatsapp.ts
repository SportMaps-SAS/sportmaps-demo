/**
 * canal-whatsapp — Mapi agente por el número de SportMaps (plan
 * docs/specs/mapi-admin-por-whatsapp-plan.md §12, con las decisiones del
 * 2026-11-24 en §12.10).
 *
 * WhatsApp es un adaptador MÁS del mismo motor: `turnoAgente` (canal
 * 'whatsapp'), los borradores de `mapi_action_drafts` y `confirmarBorrador`.
 * Aquí solo vive lo del canal:
 *   · quién habla: el NÚMERO (Meta autentica el `from`) + suscripción activa +
 *     owner/admin vigente (D4, D5) + `alcanceDesdeIdentidad` (rol admin,
 *     mapi_agent_enabled, super admin fuera). Se revalida en CADA mensaje y en
 *     CADA clic;
 *   · la escuela: la de la suscripción; con varias, botones y se recuerda 24 h;
 *   · el historial: los últimos 12 mensajes de 24 h en platform_wa_mensajes;
 *   · la salida: texto con formato de WhatsApp, partido en ≤ 4.000 caracteres,
 *     y cada borrador como mensaje interactivo (Confirmar / Cancelar / Ver lista);
 *   · los botones: `mapi:c|x|l:<borrador>:<código>`, con un código de UN solo
 *     uso ligado al wa_id que pidió la acción (§12.10.1), guardado como hash en
 *     `mapi_action_drafts.result.whatsapp` (sin migración).
 *
 * Una conversación a la vez por número (candado en memoria: los webhooks de
 * producción llegan a un solo BFF). Nada de esto lanza hacia el webhook.
 */

import { createHash, randomInt } from 'node:crypto';
import { supabase } from '../../config/supabase';
import { conCortafuegos, fueraDelCortafuegos, type ContextoCortafuegos, type Fila } from '../../config/cortafuegos-simulacion';
import {
    sendTextMessage, sendInteractiveButtons, sendCtaUrl, downloadMedia, AUDIO_MIME_PERMITIDOS, AUDIO_MAX_BYTES,
    MAX_CUERPO_INTERACTIVO, MAX_TITULO_BOTON, type BotonInteractivo, type ParsedInboundMessage, type SendTextResult,
} from '../whatsapp.service';
import {
    integracionDePlataforma, registrarMensaje, adminsDeEscuela, nombreDeEscuela, urlDeLaApp, soloDigitos,
    type CanalPlataforma, type ClaseDeContacto, type Suscripcion,
} from '../plataforma-wa.service';
import { transcribirAudio } from '../transcripcion.service';
import { conContextoLlm } from '../llm-usage.service';
import { uuidDeClave, fechaColombia } from '../avisos-correo.service';
import { turnoAgente, type MensajeHistorial } from './agente';
import { confirmarBorrador, cancelarBorrador, pendientesDelCanal, type FilaBorrador, type TarjetaAccion } from './borradores';
import { alcanceDesdeIdentidad, agenteApagadoGlobal } from './alcance';
import { CATALOGO } from './registro';
import type { Alcance, VistaPrevia } from './tipos';
import { escuelasConMapi, esRespuestaBotonMapi, type Identidad } from './canal-whatsapp-entrada';

export { mapiWhatsAppActivo, escuelasConMapi, esRespuestaBotonMapi, type Identidad } from './canal-whatsapp-entrada';

// ─── Interruptores y topes ───────────────────────────────────────────────────

export const MAX_PARTE = 4000;
export const MAX_HISTORIAL = 12;
export const HISTORIAL_MS = 24 * 3600_000;
export const ESCUELA_MS = 24 * 3600_000;
/** Vigencia del código del botón (§12.10.1): 10 min plata, 30 min lo demás. */
export const VENCE_PLATA_MIN = 10;
export const VENCE_RESTO_MIN = 30;

const entero = (v: string | undefined, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};
/** Tope de acciones de plata confirmadas por número y hora (§12.10.1). */
export const plataPorHora = () => entero(process.env.MAPI_WA_PLATA_POR_HORA, 10);
/** Tope por pago (§21): lo que lo pase no se confirma por WhatsApp. */
export const topePorPago = () => entero(process.env.MAPI_WA_TOPE_PAGO, 400_000);
/** Turnos del modelo por número y hora (§12.6), el mismo número que la app. */
export const turnosPorHora = () => entero(process.env.MAPI_AGENT_TURNOS_HORA, 30);

/**
 * Acciones de plata (§12.10.1): la marca `plata` del catálogo manda. El patrón
 * queda de respaldo, hacia el lado seguro: un nombre que suene a plata sin la
 * marca igual vence a los 10 min y cuenta para el tope.
 */
export function esDePlata(tool: string): boolean {
    const h = CATALOGO.find((x) => x.nombre === tool);
    if (h?.tipo === 'accion' && h.plata) return true;
    return /^(aprobar|registrar_(pago|efectivo|abono)|anular|reembolsar)/.test(tool);
}

/** El monto más alto que traen los argumentos del borrador (monto, amount, valor, precio, total). Pura. */
export function montoMaximo(x: unknown, profundidad = 0): number {
    if (!x || typeof x !== 'object' || profundidad > 3) return 0;
    let max = 0;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (typeof v === 'number' && /^(monto|amount|valor|precio|total)(_|$)/i.test(k)) max = Math.max(max, v);
        else if (v && typeof v === 'object') max = Math.max(max, montoMaximo(v, profundidad + 1));
    }
    return max;
}

/** ¿Se puede ofrecer Confirmar por WhatsApp? No si pasa el tope por pago o es de nivel 3. Pura. */
export function confirmablePorWhatsApp(fila: Pick<FilaBorrador, 'tool' | 'args'>): boolean {
    if (!esDePlata(fila.tool)) return true;
    if (Number((fila.args as any)?.nivel) === 3) return false;
    return montoMaximo(fila.args) <= topePorPago();
}

// ─── Formato (puro) ──────────────────────────────────────────────────────────

/**
 * Markdown de la app → WhatsApp: `**x**` → `*x*`, títulos a negrita, enlaces
 * relativos a su texto, viñetas a «•», tablas a líneas «a · b». Pura.
 */
export function aFormatoWhatsApp(md: string): string {
    let t = String(md ?? '').replace(/\r\n/g, '\n');
    t = t.replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1').replace(/`([^`\n]+)`/g, '$1');
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, txt: string, url: string) => (/^https?:\/\//i.test(url) ? `${txt}: ${url}` : txt));
    t = t.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*');
    t = t.replace(/\*\*\*(.+?)\*\*\*/g, '*$1*').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '*$1*');
    t = t.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
    t = t.split('\n').flatMap((l) => {
        const s = l.trim();
        if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(s)) return [];
        if (/^\|.*\|$/.test(s)) return [s.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean).join(' · ')];
        return [l];
    }).join('\n');
    return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Parte un texto en mensajes de ≤ `max` caracteres, por párrafo, línea o espacio. Pura. */
export function partirMensaje(texto: string, max = MAX_PARTE): string[] {
    const out: string[] = [];
    let resto = String(texto ?? '').trim();
    while (resto.length > max) {
        let corte = resto.lastIndexOf('\n\n', max);
        if (corte < max / 2) corte = resto.lastIndexOf('\n', max);
        if (corte < max / 2) corte = resto.lastIndexOf(' ', max);
        if (corte <= 0) corte = max;
        out.push(resto.slice(0, corte).trim());
        resto = resto.slice(corte).trim();
    }
    if (resto) out.push(resto);
    return out;
}

const corto = (s: string, n: number) => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s);

/**
 * Cuerpo del mensaje interactivo de una tarjeta: título + líneas + aviso, y la
 * nota del canal. ≤ 1.024 caracteres (límite de Meta): se recortan líneas, nunca
 * el título ni la nota. Pura.
 */
export function cuerpoDeTarjeta(v: VistaPrevia, o: { venceMin: number; confirmable: boolean; prefijo?: string }): string {
    const cabeza = `${o.prefijo ?? ''}*${aFormatoWhatsApp(v.titulo).replace(/\*/g, '')}*`;
    const pie: string[] = [];
    if (v.aviso) pie.push(`⚠️ ${aFormatoWhatsApp(v.aviso)}`);
    if (v.detalle?.items?.length) pie.push(`${v.detalle.etiqueta}: ${v.detalle.items.length} — toca *Ver lista*.`);
    pie.push(o.confirmable
        ? `Toca *Confirmar* para hacerlo (vence en ${o.venceMin} min).`
        : 'Por el monto, esta acción no se confirma por WhatsApp: revísala y confírmala en la app, en la pantalla *Aprobar*.');
    const pieTxt = pie.join('\n');
    const disponible = MAX_CUERPO_INTERACTIVO - cabeza.length - pieTxt.length - 4;
    let cuerpoLineas = (v.lineas ?? []).map((l) => aFormatoWhatsApp(l)).join('\n');
    if (cuerpoLineas.length > disponible) cuerpoLineas = `${cuerpoLineas.slice(0, Math.max(0, disponible - 1)).trimEnd()}…`;
    const txt = [cabeza, cuerpoLineas, pieTxt].filter(Boolean).join('\n\n');
    return txt.slice(0, MAX_CUERPO_INTERACTIVO);
}

export type AccionBoton = 'c' | 'x' | 'l';
export const idDeBoton = (accion: AccionBoton, borrador: string, codigo: string) => `mapi:${accion}:${borrador}:${codigo}`;

export function botonesDeTarjeta(borrador: string, codigo: string, v: VistaPrevia, confirmable: boolean): BotonInteractivo[] {
    const b: BotonInteractivo[] = [];
    if (confirmable) b.push({ id: idDeBoton('c', borrador, codigo), title: 'Confirmar' });
    b.push({ id: idDeBoton('x', borrador, codigo), title: 'Cancelar' });
    if (v.detalle?.items?.length) b.push({ id: idDeBoton('l', borrador, codigo), title: 'Ver lista' });
    return b.map((x) => ({ ...x, title: corto(x.title, MAX_TITULO_BOTON) }));
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BOTON_RE = new RegExp(`^mapi:([cxl]):(${UUID_RE}):([A-Z2-9]{8})$`, 'i');
const ESCUELA_RE = new RegExp(`^mapi:e:(${UUID_RE})$`, 'i');

export type BotonMapi =
    | { tipo: 'accion'; accion: AccionBoton; borrador: string; codigo: string }
    | { tipo: 'escuela'; schoolId: string };

export function parsearBotonMapi(id: string | null | undefined): BotonMapi | null {
    const s = String(id ?? '').trim();
    const m = BOTON_RE.exec(s);
    if (m) return { tipo: 'accion', accion: m[1].toLowerCase() as AccionBoton, borrador: m[2].toLowerCase(), codigo: m[3].toUpperCase() };
    const e = ESCUELA_RE.exec(s);
    return e ? { tipo: 'escuela', schoolId: e[1].toLowerCase() } : null;
}

/** «si», «ok», «👍»… sueltos: nunca confirman (§12.3). Pura. */
export function esAsentimientoSuelto(texto: string | null | undefined): boolean {
    const t = String(texto ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    if (!t || t.length > 30) return false;
    return /^(si+|sip|ok+|okay|oki|dale|listo|va|vale|de una|hagale|confirm(o|ar|ado)?|perfecto|claro|(👍|👌|✅|🙌|🙏)+)[\s.!¡]*(👍|👌|✅)*$/u.test(t);
}

export const imitaBoton = (t: string | null | undefined) => /^\s*mapi:[a-z]:/i.test(String(t ?? ''));

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function nuevoCodigo(): string {
    let c = '';
    for (let i = 0; i < 8; i++) c += ALFABETO[randomInt(ALFABETO.length)];
    return c;
}
export const hashCodigo = (codigo: string) => createHash('sha256').update(`mapi-wa:${codigo.toUpperCase()}`).digest('hex');

// ─── Textos ──────────────────────────────────────────────────────────────────

export const TEXTOS = {
    queNecesitas: '¿Qué necesitas? Puedo contarte cómo van los pagos, buscar a un deportista, preparar una excusa o un recordatorio… Escríbemelo o mándame una nota de voz.',
    usaElBoton: 'Un «sí» escrito no ejecuta nada: para hacerlo, toca *Confirmar* en la propuesta de arriba. Si ya no la quieres, toca *Cancelar*.',
    imitaBoton: 'Para confirmar o cancelar una propuesta, toca el botón de la tarjeta.',
    noEncontre: 'No encontré esa propuesta. Pídemela de nuevo.',
    yaUsado: 'Ese botón ya se usó. Si necesitas algo más, escríbeme.',
    vencido: 'Esa propuesta venció. Pídemela de nuevo y te la preparo con los datos de ahora.',
    sinPermiso: 'Ya no puedo hacer esto desde aquí: tu usuario no tiene permiso de administración en esa escuela o el servicio está apagado.',
    topePlata: (n: number) => `Llegaste al tope de ${n} acciones con plata por hora desde WhatsApp. Espera un rato o hazlo desde la app.`,
    topeTurnos: 'Me escribiste muchas veces en la última hora. Dame un momento y vuelve a escribirme, o usa la app.',
    enviando: 'Enviando… Te aviso por aquí cuando termine.',
    cancelada: 'Cancelada. No se hizo nada.',
    cambio: 'Cambió algo desde que la preparé. Revisa la propuesta nueva:',
    sinAgente: 'Ahora no puedo consultar los datos de la escuela. Intenta en un rato o usa la app.',
    escalar: 'Esto lo tiene que ver una persona del equipo de SportMaps. Escríbele a Mapi desde la app y pide «hablar con soporte»: queda el caso con tu escuela.',
    comprobantes: 'Por ahora los comprobantes se suben y se revisan en la app.',
    otroTipo: 'Por ahora leo texto y notas de voz. Escríbeme lo que necesitas.',
    noEscuche: 'No pude escuchar el audio. ¿Me lo escribes?',
    elegirEscuela: 'Administras varias escuelas. ¿De cuál hablamos? (Lo recuerdo por 24 horas; escribe «cambiar de escuela» para cambiarla.)',
    errorTurno: 'Tuve un problema para responder. Intenta de nuevo en un momento.',
} as const;

export function mensajeDeEstado(t: Pick<TarjetaAccion, 'estado' | 'motivo'>): string {
    switch (t.estado) {
        case 'executed': return 'Esa propuesta ya se confirmó.';
        case 'cancelled': return 'Esa propuesta ya estaba cancelada.';
        case 'expired': return TEXTOS.vencido;
        case 'superseded': return 'Esa propuesta se reemplazó por una más nueva: usa la última tarjeta.';
        case 'executing': return 'Esa propuesta se está ejecutando. Te aviso cuando termine.';
        case 'failed':
        case 'partial': return `Esa propuesta ya se intentó${t.motivo ? `: ${t.motivo}` : '.'}`;
        default: return TEXTOS.noEncontre;
    }
}

// ─── Salidas ─────────────────────────────────────────────────────────────────

export type Salida =
    | { tipo: 'texto'; texto: string; paso: string }
    | { tipo: 'botones'; cuerpo: string; botones: BotonInteractivo[]; paso: string }
    | { tipo: 'enlace'; texto: string; boton: string; url: string; paso: string };

const texto = (t: string, paso = 'mapi'): Salida => ({ tipo: 'texto', texto: t, paso });

export interface EntornoEnvio {
    canal: CanalPlataforma;
    numero: string;
    clase: ClaseDeContacto;
    /** '' en producción; '🧪 ' en el modo pruebas. */
    prefijo: string;
}

async function anotar(e: EntornoEnvio, r: SendTextResult, tipo: string, contenido: string, paso: string): Promise<void> {
    if (!r.ok) return;
    await registrarMensaje({
        waMessageId: r.waMessageId || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        direccion: 'saliente', contactWaId: e.numero, clase: e.clase, tipo, texto: contenido, paso,
    });
}

/** Manda las salidas por el número de SportMaps y las registra (con `paso` mapi…). No lanza. */
export async function enviarSalidas(e: EntornoEnvio, salidas: Salida[]): Promise<void> {
    const integ = integracionDePlataforma(e.canal);
    for (const s of salidas) {
        try {
            if (s.tipo === 'texto') {
                for (const parte of partirMensaje(e.prefijo + s.texto, MAX_PARTE)) {
                    await anotar(e, await sendTextMessage(integ, e.numero, parte), 'text', parte, s.paso);
                }
            } else if (s.tipo === 'botones') {
                const cuerpo = (e.prefijo + s.cuerpo).slice(0, MAX_CUERPO_INTERACTIVO);
                const r = await sendInteractiveButtons(integ, e.numero, cuerpo, s.botones);
                if (r.ok) await anotar(e, r, 'interactive', cuerpo, s.paso);
                else {
                    const alt = `${cuerpo}\n\n(No pude mostrar los botones: revísala en la app.)`;
                    await anotar(e, await sendTextMessage(integ, e.numero, alt.slice(0, 4096)), 'text', alt, s.paso);
                }
            } else {
                const cuerpo = e.prefijo + s.texto;
                let r = await sendCtaUrl(integ, e.numero, cuerpo, s.boton, s.url);
                if (!r.ok) r = await sendTextMessage(integ, e.numero, `${cuerpo}\n\n${s.boton}: ${s.url}`);
                await anotar(e, r, 'interactive', cuerpo, s.paso);
            }
        } catch (err: any) {
            console.warn('[mapi-wa] no salió un mensaje', { paso: s.paso, err: err?.message || String(err) });
        }
    }
}

// ─── Estado en memoria (un solo BFF recibe los webhooks) ─────────────────────

const candados = new Map<string, Promise<void>>();

/** Una conversación a la vez por número: el segundo mensaje espera al primero. */
export async function conCandado<T>(clave: string, fn: () => Promise<T>): Promise<T> {
    const previo = candados.get(clave) ?? Promise.resolve();
    let soltar!: () => void;
    const mio = new Promise<void>((r) => { soltar = r; });
    const cola = previo.then(() => mio);
    candados.set(clave, cola);
    try {
        await previo;
        return await fn();
    } finally {
        soltar();
        if (candados.get(clave) === cola) candados.delete(clave);
    }
}

const ventanas = new Map<string, number[]>();
/** Ventana deslizante de 1 h por clave. Pura salvo el mapa. */
function contar(clave: string, ahora: number, anotarUno: boolean): number {
    const vivos = (ventanas.get(clave) ?? []).filter((t) => t > ahora - 3600_000);
    if (anotarUno) vivos.push(ahora);
    if (vivos.length) ventanas.set(clave, vivos); else ventanas.delete(clave);
    return vivos.length;
}

const escuelaElegida = new Map<string, { schoolId: string; hasta: number }>();
const pendienteDeEscuela = new Map<string, { msg: ParsedInboundMessage; hasta: number }>();

/** Solo pruebas: vacía el estado en memoria. */
export function _reiniciarEstadoCanal(): void {
    candados.clear(); ventanas.clear(); escuelaElegida.clear(); pendienteDeEscuela.clear();
}

// ─── Identidad ───────────────────────────────────────────────────────────────

/** D5 + núcleo del alcance: owner/admin vigente HOY, rol admin, agente prendido. */
async function alcanceReal(i: Identidad, ahora: number): Promise<Alcance | null> {
    const admins = await adminsDeEscuela(i.schoolId).catch(() => new Set<string>());
    if (!admins.has(i.profileId)) return null;
    return alcanceDesdeIdentidad({ userId: i.profileId, schoolId: i.schoolId, soloAdmin: true, canal: 'whatsapp', ahora: new Date(ahora) });
}

// ─── Historial ───────────────────────────────────────────────────────────────

/**
 * Los últimos 12 mensajes del número en 24 h: entrantes (sin comandos «/…») y
 * salientes de Mapi (`paso` mapi…). Desde `desde` si se da (modo pruebas).
 */
export async function leerHistorial(numero: string, ahora: number, desde = 0): Promise<MensajeHistorial[]> {
    const inicio = Math.max(ahora - HISTORIAL_MS, desde);
    const { data, error } = await supabase.from('platform_wa_mensajes')
        .select('direccion, tipo, texto, paso, created_at')
        .eq('contact_wa_id', numero).gte('created_at', new Date(inicio).toISOString())
        .order('created_at', { ascending: false }).limit(40);
    if (error) return [];
    const filas = ((data ?? []) as any[]).filter((m) => {
        const t = String(m.texto ?? '').trim();
        if (!t) return false;
        if (m.direccion === 'entrante') return !t.startsWith('/');
        return String(m.paso ?? '').startsWith('mapi');
    }).slice(0, MAX_HISTORIAL).reverse();
    return filas.map((m) => {
        const t = String(m.texto).replace(/^🧪\s*/u, '');
        if (m.direccion === 'saliente') return { role: 'assistant' as const, content: t };
        return { role: 'user' as const, content: m.tipo === 'interactive' ? `[Tocó el botón «${t}»]` : t };
    });
}

// ─── Tarjetas ────────────────────────────────────────────────────────────────

export interface AuditoriaWhatsApp {
    canal: 'whatsapp';
    wa_id: string;
    codigo_sha256: string;
    vence_at: string;
    plata: boolean;
    usado_at?: string;
    wa_message_id_clic?: string;
    actor?: string;
}

/**
 * Le pone a cada borrador su código de un solo uso (hash en `result.whatsapp`)
 * y arma la tarjeta. En plata el borrador mismo vence a los 10 min, así
 * `confirmarBorrador` también lo aplica.
 */
export async function tarjetasDeBorradores(ids: string[], numero: string, ahora: number, prefijo = ''): Promise<Salida[]> {
    const salidas: Salida[] = [];
    for (const id of ids) {
        const { data } = await supabase.from('mapi_action_drafts').select('*').eq('id', id).maybeSingle();
        const f = data as FilaBorrador | null;
        if (!f || f.status !== 'draft') continue;
        const plata = esDePlata(f.tool);
        const venceMin = plata ? VENCE_PLATA_MIN : VENCE_RESTO_MIN;
        const vence = Math.min(Date.parse(f.expires_at) || Infinity, ahora + venceMin * 60_000);
        const codigo = nuevoCodigo();
        const auditoria: AuditoriaWhatsApp = {
            canal: 'whatsapp', wa_id: numero, codigo_sha256: hashCodigo(codigo), vence_at: new Date(vence).toISOString(), plata,
        };
        const { error } = await supabase.from('mapi_action_drafts')
            .update({ result: { ...((f.result as any) ?? {}), whatsapp: auditoria }, expires_at: new Date(vence).toISOString() })
            .eq('id', f.id).eq('status', 'draft');
        if (error) {
            console.warn('[mapi-wa] no se pudo guardar el código del botón', { err: error.message });
            continue;
        }
        const confirmable = confirmablePorWhatsApp(f);
        salidas.push({
            tipo: 'botones',
            cuerpo: cuerpoDeTarjeta(f.preview, { venceMin, confirmable, prefijo }),
            botones: botonesDeTarjeta(f.id, codigo, f.preview, confirmable),
            paso: 'mapi_tarjeta',
        });
    }
    return salidas;
}

/** Deja la auditoría del canal en `result` aunque la ejecución lo haya reescrito. */
async function auditar(id: string, a: AuditoriaWhatsApp): Promise<void> {
    try {
        const { data } = await supabase.from('mapi_action_drafts').select('result').eq('id', id).maybeSingle();
        const actual = ((data as any)?.result ?? {}) as Record<string, unknown>;
        await supabase.from('mapi_action_drafts').update({ result: { ...actual, whatsapp: a } }).eq('id', id);
    } catch (err: any) {
        console.warn('[mapi-wa] no quedó la auditoría del canal', { err: err?.message || String(err) });
    }
}

// ─── El manejo ───────────────────────────────────────────────────────────────

export type ResultadoMapiWa =
    | 'mapi_turno' | 'mapi_boton' | 'mapi_sin_permiso' | 'mapi_elegir_escuela' | 'mapi_escuela_elegida'
    | 'mapi_asentimiento' | 'mapi_imita_boton' | 'mapi_tope' | 'mapi_media' | 'mapi_audio_fallido' | 'mapi_error';

/** Lo que cambia entre producción y el modo pruebas. */
interface Sesion {
    canal: CanalPlataforma;
    numero: string;
    ahora: number;
    prefijo: string;
    enviar: (s: Salida[]) => Promise<void>;
    identidades: Identidad[];
    alcanceDe: (i: Identidad) => Promise<Alcance | null>;
    /** Baja el audio con el token del canal (fuera del cortafuegos en pruebas). */
    bajarAudio: (mediaId: string) => ReturnType<typeof downloadMedia>;
    /** Deja la transcripción en el entrante, para el historial. */
    anotarTranscripcion: (waMessageId: string, texto: string) => Promise<void>;
    /** Historial desde (modo pruebas: desde el `/como admin`). */
    desde: number;
    /** Escuela fija (modo pruebas): sin elegir ni recordar. */
    escuelaFija: boolean;
}

/** Entrada de producción (la llama atenderEntrantePlataforma). Nunca lanza. */
export async function atenderMapiPorWhatsApp(p: {
    canal: CanalPlataforma;
    numero: string;
    msg: ParsedInboundMessage;
    suscripciones: Suscripcion[];
    ahora?: number;
}): Promise<ResultadoMapiWa> {
    const numero = soloDigitos(p.numero);
    const entorno: EntornoEnvio = { canal: p.canal, numero, clase: 'suscriptor', prefijo: '' };
    return conCandado(numero, async () => {
        const ahora = p.ahora ?? Date.now();
        const s: Sesion = {
            canal: p.canal, numero, ahora, prefijo: '',
            enviar: (x) => enviarSalidas(entorno, x),
            identidades: await escuelasConMapi(numero, p.suscripciones),
            alcanceDe: (i) => alcanceReal(i, ahora),
            bajarAudio: (mediaId) => downloadMedia(integracionDePlataforma(p.canal), mediaId, { mimes: AUDIO_MIME_PERMITIDOS, maxBytes: AUDIO_MAX_BYTES }),
            anotarTranscripcion: async (id, t) => {
                await supabase.from('platform_wa_mensajes').update({ texto: `🎤 ${t}` }).eq('wa_message_id', id);
            },
            desde: 0,
            escuelaFija: false,
        };
        try {
            return await atender(s, p.msg);
        } catch (err: any) {
            console.error('[mapi-wa] el turno falló', { err: err?.message || String(err) });
            await s.enviar([texto(TEXTOS.errorTurno, 'mapi_error')]);
            return 'mapi_error';
        }
    });
}

async function atender(s: Sesion, msg: ParsedInboundMessage): Promise<ResultadoMapiWa> {
    if (esRespuestaBotonMapi(msg)) return atenderBoton(s, msg);
    if (!s.identidades.length) return 'mapi_sin_permiso';

    // Escuela: la de la suscripción. Con varias, se elige con botones.
    const ident = await escuelaDelTurno(s, msg);
    if (!ident) return 'mapi_elegir_escuela';
    return atenderMensaje(s, ident, msg);
}

async function preguntarEscuela(s: Sesion): Promise<void> {
    const nombres = await Promise.all(s.identidades.map((i) => nombreDeEscuela(i.schoolId)));
    await s.enviar([{
        tipo: 'botones',
        cuerpo: TEXTOS.elegirEscuela,
        botones: s.identidades.slice(0, 10).map((i, k) => ({ id: `mapi:e:${i.schoolId}`, title: corto(nombres[k], 24) })),
        paso: 'mapi_elegir_escuela',
    }]);
}

async function escuelaDelTurno(s: Sesion, msg: ParsedInboundMessage): Promise<Identidad | null> {
    if (s.identidades.length === 1 || s.escuelaFija) return s.identidades[0];
    if (msg.type === 'text' && /^\s*(cambiar( de)? escuela|otra escuela)\s*[.!?]*\s*$/i.test(msg.textBody ?? '')) {
        escuelaElegida.delete(s.numero);
        await preguntarEscuela(s);
        return null;
    }
    const recordada = await escuelaRecordada(s);
    if (recordada) return recordada;
    pendienteDeEscuela.set(s.numero, { msg, hasta: s.ahora + 15 * 60_000 });
    await preguntarEscuela(s);
    return null;
}

async function escuelaRecordada(s: Sesion): Promise<Identidad | null> {
    const enMemoria = escuelaElegida.get(s.numero);
    let schoolId = enMemoria && enMemoria.hasta > s.ahora ? enMemoria.schoolId : null;
    if (!schoolId) {
        // Tras un reinicio del BFF: la última elección queda en el paso del saliente.
        const { data } = await supabase.from('platform_wa_mensajes').select('paso, created_at')
            .eq('contact_wa_id', s.numero).eq('direccion', 'saliente').like('paso', 'mapi_escuela:%')
            .gte('created_at', new Date(s.ahora - ESCUELA_MS).toISOString())
            .order('created_at', { ascending: false }).limit(1);
        const paso = String(((data ?? []) as any[])[0]?.paso ?? '');
        schoolId = paso.startsWith('mapi_escuela:') ? paso.slice('mapi_escuela:'.length) : null;
    }
    return s.identidades.find((i) => i.schoolId === schoolId) ?? null;
}

async function atenderMensaje(s: Sesion, ident: Identidad, msg: ParsedInboundMessage): Promise<ResultadoMapiWa> {
    // D5 en CADA mensaje: suscripción viva (ya filtrada), owner/admin hoy, agente prendido.
    const alcance = await s.alcanceDe(ident);
    if (!alcance) return 'mapi_sin_permiso';

    if (msg.type === 'image' || msg.type === 'document') {
        await s.enviar([{ tipo: 'enlace', texto: TEXTOS.comprobantes, boton: 'Abrir la app', url: urlDeLaApp('/payments-automation?tab=recurrent'), paso: 'mapi_media' }]);
        return 'mapi_media';
    }

    let textoUsuario = msg.textBody ?? '';
    const salidasPrevias: Salida[] = [];
    if (msg.type === 'audio') {
        const t = await transcribir(s, ident, msg);
        if (!t) {
            await s.enviar([texto(TEXTOS.noEscuche, 'mapi_audio')]);
            return 'mapi_audio_fallido';
        }
        textoUsuario = t;
        salidasPrevias.push(texto(`Entendí: «${t}»`, 'mapi_audio'));
    } else if (msg.type !== 'text') {
        await s.enviar([texto(TEXTOS.otroTipo, 'mapi_tipo')]);
        return 'mapi_media';
    }

    if (imitaBoton(textoUsuario)) {
        await s.enviar([...salidasPrevias, texto(TEXTOS.imitaBoton, 'mapi_imita_boton')]);
        return 'mapi_imita_boton';
    }
    if (esAsentimientoSuelto(textoUsuario)) {
        const vivas = await pendientesDelCanal(alcance.userId, alcance.schoolId, s.ahora).catch(() => []);
        await s.enviar([...salidasPrevias, texto(vivas.length ? TEXTOS.usaElBoton : TEXTOS.queNecesitas, 'mapi_asentimiento')]);
        return 'mapi_asentimiento';
    }
    if (contar(`turno:${s.numero}`, s.ahora, true) > turnosPorHora()) {
        await s.enviar([...salidasPrevias, texto(TEXTOS.topeTurnos, 'mapi_tope')]);
        return 'mapi_tope';
    }

    const historial = await leerHistorial(s.numero, s.ahora, s.desde);
    // El mensaje de ESTE turno va último aunque el registro no lo devuelva (audio, carrera).
    const ultimo = historial[historial.length - 1];
    if (!ultimo || ultimo.role !== 'user' || !ultimo.content.includes(textoUsuario.slice(0, 200))) {
        historial.push({ role: 'user', content: textoUsuario });
    }
    const { data: perfil } = await supabase.from('profiles').select('full_name').eq('id', ident.profileId).maybeSingle();

    const r = await turnoAgente({
        alcance,
        ticketId: null,
        historial,
        nombreUsuario: (perfil as any)?.full_name ?? null,
        canal: 'whatsapp',
        conversacionLlm: conversacionDeNumero(s.numero),
    });
    console.info('[mapi-wa] turno', {
        tipo: r.tipo, ...(r.tipo !== 'sin_agente' ? { herramientas: r.herramientas, borradores: r.borradores.length, rondas: r.rondas } : { motivo: r.motivo }),
    });
    if (r.tipo === 'sin_agente') {
        await s.enviar([...salidasPrevias, texto(TEXTOS.sinAgente, 'mapi_sin_agente')]);
        return 'mapi_turno';
    }
    const salidas: Salida[] = [...salidasPrevias];
    if (r.tipo === 'escalar') salidas.push(texto(TEXTOS.escalar, 'mapi_escalar'));
    else if (r.texto.trim()) salidas.push(texto(aFormatoWhatsApp(r.texto), 'mapi'));
    salidas.push(...await tarjetasDeBorradores(r.borradores, s.numero, s.ahora, s.prefijo));
    await s.enviar(salidas);
    return 'mapi_turno';
}

/** llm_usage.conversation_id es uuid: uno derivado del número, sin guardar el número (§12.6). */
export const conversacionDeNumero = (numero: string) => uuidDeClave(`mapi-wa:${soloDigitos(numero)}`);

async function transcribir(s: Sesion, ident: Identidad, msg: ParsedInboundMessage): Promise<string | null> {
    if (!msg.mediaId) return null;
    const bajada = await s.bajarAudio(msg.mediaId);
    if (!bajada.ok || !bajada.buffer) return null;
    const r = await conContextoLlm({ schoolId: ident.schoolId, feature: 'transcripcion', conversationId: conversacionDeNumero(s.numero) },
        () => transcribirAudio(bajada.buffer as Buffer, bajada.mimeType || msg.mediaMimeType || 'audio/ogg', { idioma: 'es' }));
    const t = r.ok ? r.texto.trim().slice(0, 1500) : '';
    if (!t) return null;
    await s.anotarTranscripcion(msg.waMessageId, t).catch(() => undefined);
    return t;
}

// ─── Botones ─────────────────────────────────────────────────────────────────

async function atenderBoton(s: Sesion, msg: ParsedInboundMessage): Promise<ResultadoMapiWa> {
    const b = parsearBotonMapi(msg.botonId);
    if (!b) {
        await s.enviar([texto(TEXTOS.noEncontre, 'mapi_boton')]);
        return 'mapi_boton';
    }
    if (b.tipo === 'escuela') {
        const ident = s.identidades.find((i) => i.schoolId === b.schoolId);
        if (!ident) {
            await s.enviar([texto('Esa escuela no está entre las que administras con este número.', 'mapi_boton')]);
            return 'mapi_sin_permiso';
        }
        escuelaElegida.set(s.numero, { schoolId: ident.schoolId, hasta: s.ahora + ESCUELA_MS });
        await s.enviar([texto(`Hablamos de *${await nombreDeEscuela(ident.schoolId)}*.`, `mapi_escuela:${ident.schoolId}`)]);
        const pendiente = pendienteDeEscuela.get(s.numero);
        pendienteDeEscuela.delete(s.numero);
        if (pendiente && pendiente.hasta > s.ahora) await atenderMensaje(s, ident, pendiente.msg);
        return 'mapi_escuela_elegida';
    }

    // El borrador tiene que ser de ESTE número: suyo (user_id = perfil de la
    // suscripción), de esa escuela, y con el código que se le mandó a este wa_id.
    const { data } = await supabase.from('mapi_action_drafts').select('*').eq('id', b.borrador).maybeSingle();
    const f = data as FilaBorrador | null;
    const ident = f ? s.identidades.find((i) => i.profileId === f.user_id && i.schoolId === f.school_id) : undefined;
    const w = (f?.result as any)?.whatsapp as AuditoriaWhatsApp | undefined;
    if (!f || !ident || !w || w.wa_id !== s.numero || w.codigo_sha256 !== hashCodigo(b.codigo)) {
        await s.enviar([texto(TEXTOS.noEncontre, 'mapi_boton')]);
        return 'mapi_boton';
    }

    if (b.accion === 'l') {
        // La lista trae nombres de familias: solo a quien SIGUE siendo admin (D5).
        if (!(await s.alcanceDe(ident))) {
            await s.enviar([texto(TEXTOS.sinPermiso, 'mapi_boton')]);
            return 'mapi_sin_permiso';
        }
        const items = f.preview?.detalle?.items ?? [];
        await s.enviar([texto(items.length
            ? `*${f.preview.detalle!.etiqueta}* (${items.length})\n${items.map((x) => `• ${x}`).join('\n')}`
            : 'Esta propuesta no trae lista.', 'mapi_lista')]);
        return 'mapi_boton';
    }
    if (b.accion === 'x') {
        const t = await cancelarBorrador(ident.profileId, f.id);
        await s.enviar([texto(t?.estado === 'cancelled' ? TEXTOS.cancelada : mensajeDeEstado(t ?? { estado: '', motivo: null }), 'mapi_cancelar')]);
        return 'mapi_boton';
    }

    // Confirmar.
    if (w.usado_at) {
        await s.enviar([texto(TEXTOS.yaUsado, 'mapi_boton')]);
        return 'mapi_boton';
    }
    if (f.status !== 'draft') {
        await s.enviar([texto(mensajeDeEstado({ estado: f.status, motivo: f.failure_reason }), 'mapi_boton')]);
        return 'mapi_boton';
    }
    if (Date.parse(w.vence_at) <= s.ahora) {
        await supabase.from('mapi_action_drafts').update({ status: 'expired' }).eq('id', f.id).eq('status', 'draft');
        await s.enviar([texto(TEXTOS.vencido, 'mapi_boton')]);
        return 'mapi_boton';
    }
    // D5 al clic: la persona sigue siendo admin, con el agente prendido.
    const alcance = await s.alcanceDe(ident);
    if (!alcance) {
        await s.enviar([texto(TEXTOS.sinPermiso, 'mapi_boton')]);
        return 'mapi_sin_permiso';
    }
    if (!confirmablePorWhatsApp(f)) {
        await s.enviar([texto('Por el monto, esta acción se confirma en la app, en la pantalla *Aprobar*.', 'mapi_boton')]);
        return 'mapi_boton';
    }
    const plata = esDePlata(f.tool);
    if (plata && contar(`plata:${s.numero}`, s.ahora, false) >= plataPorHora()) {
        await s.enviar([texto(TEXTOS.topePlata(plataPorHora()), 'mapi_tope')]);
        return 'mapi_tope';
    }

    // Código de un solo uso: lo gasta el primero que logra este UPDATE condicionado.
    const usado: AuditoriaWhatsApp = {
        ...w, usado_at: new Date(s.ahora).toISOString(), wa_message_id_clic: msg.waMessageId, actor: ident.profileId,
    };
    const { data: gastado } = await supabase.from('mapi_action_drafts')
        .update({ result: { ...((f.result as any) ?? {}), whatsapp: usado } })
        .eq('id', f.id).eq('user_id', ident.profileId).eq('status', 'draft')
        .eq('result->whatsapp->>codigo_sha256', w.codigo_sha256).is('result->whatsapp->>usado_at', null)
        .select('id').maybeSingle();
    if (!gastado) {
        await s.enviar([texto(TEXTOS.yaUsado, 'mapi_boton')]);
        return 'mapi_boton';
    }
    if (plata) contar(`plata:${s.numero}`, s.ahora, true);

    const r = await confirmarBorrador({
        userId: ident.profileId,
        id: f.id,
        alcance,
        alTerminar: async (fin) => {
            await auditar(f.id, usado);
            await s.enviar([texto(aFormatoWhatsApp(fin.mensaje), 'mapi_resultado')]);
        },
    });
    switch (r.tipo) {
        case 'no_encontrado':
        case 'otra_escuela':
            await s.enviar([texto(TEXTOS.noEncontre, 'mapi_boton')]);
            break;
        case 'sin_cambio':
            await s.enviar([texto(mensajeDeEstado(r.tarjeta), 'mapi_boton')]);
            break;
        case 'cambio':
            await s.enviar([texto(TEXTOS.cambio, 'mapi_cambio'), ...await tarjetasDeBorradores([r.nueva.id], s.numero, s.ahora, s.prefijo)]);
            break;
        case 'en_curso':
            await s.enviar([texto(TEXTOS.enviando, 'mapi_en_curso')]);
            break;
        case 'final':
            await auditar(f.id, usado);
            await s.enviar([texto(aFormatoWhatsApp(r.mensaje), 'mapi_resultado')]);
            break;
    }
    return 'mapi_boton';
}

// ─── Modo pruebas (`/como admin`, cortafuegos D13) ───────────────────────────

export interface ComoAdmin {
    /** Perfil real de administración con que corre el turno (dueño de la escuela). */
    userId: string;
    /** ms: el historial arranca aquí (no mezcla la sesión de papá/prospecto). */
    desde: number;
}

/**
 * Alcance de administración SINTÉTICO para el modo pruebas: el tester no es
 * admin de la escuela; corre con el perfil del dueño, rol admin, sin sesión
 * (las herramientas con auth.uid() no se ofrecen) y SIN exigir
 * mapi_agent_enabled, para probar antes de prender. El apagado global manda.
 */
export async function alcanceDePrueba(schoolId: string, userId: string, ahora: number): Promise<Alcance | null> {
    if (agenteApagadoGlobal()) return null;
    const { data } = await supabase.from('school_settings')
        .select('coach_mapi_attendance, coach_mapi_notices, coach_hide_financial_info').eq('school_id', schoolId).maybeSingle();
    const a = (data ?? {}) as any;
    const alcance: Alcance = {
        schoolId, userId, rol: 'admin', teamIds: [],
        ajustes: {
            coachMapiAttendance: a.coach_mapi_attendance !== false,
            coachMapiNotices: a.coach_mapi_notices !== false,
            coachHideFinancialInfo: a.coach_hide_financial_info === true,
        },
        hoy: fechaColombia(new Date(ahora)),
    };
    Object.defineProperty(alcance, 'authorization', { value: null, enumerable: false, writable: false });
    return alcance;
}

export const TABLAS_VIRTUALES_MAPI: ReadonlySet<string> = new Set(['mapi_action_drafts']);
const MAX_BORRADORES_MEMORIA = 30;

/**
 * Un mensaje del tester en modo `/como admin`: el Mapi REAL (modelo, herramientas,
 * borradores, Confirmar) dentro de `conCortafuegos`. Lee datos reales; toda
 * escritura se bloquea; `mapi_action_drafts` vive en `memoria` (la de la sesión
 * de prueba). Lo que se le manda al tester sale FUERA del cortafuegos, con 🧪.
 */
export async function atenderMapiPrueba(p: {
    canal: CanalPlataforma;
    numero: string;
    msg: ParsedInboundMessage;
    schoolId: string;
    comoAdmin: ComoAdmin;
    memoria: Record<string, Fila[]>;
    ahora?: number;
}): Promise<{ resultado: ResultadoMapiWa; bloqueadas: string[]; memoria: Record<string, Fila[]> }> {
    const numero = soloDigitos(p.numero);
    const entorno: EntornoEnvio = { canal: p.canal, numero, clase: 'tester', prefijo: '🧪 ' };
    const ctx: ContextoCortafuegos = {
        memoria: { mapi_action_drafts: [...(p.memoria.mapi_action_drafts ?? [])] },
        rpc: {},
        bloqueadas: [],
        virtuales: TABLAS_VIRTUALES_MAPI,
    };
    const ident: Identidad = { schoolId: p.schoolId, profileId: p.comoAdmin.userId };
    const resultado = await conCandado(numero, async () => {
        const ahora = p.ahora ?? Date.now();
        const s: Sesion = {
            canal: p.canal, numero, ahora, prefijo: '🧪 ',
            enviar: (x) => fueraDelCortafuegos(() => enviarSalidas(entorno, x)),
            identidades: [ident],
            alcanceDe: (i) => alcanceDePrueba(i.schoolId, i.profileId, ahora),
            bajarAudio: (mediaId) => fueraDelCortafuegos(() => downloadMedia(integracionDePlataforma(p.canal), mediaId,
                { mimes: AUDIO_MIME_PERMITIDOS, maxBytes: AUDIO_MAX_BYTES })),
            anotarTranscripcion: (id, t) => fueraDelCortafuegos(async () => {
                await supabase.from('platform_wa_mensajes').update({ texto: `🎤 ${t}` }).eq('wa_message_id', id);
            }),
            desde: p.comoAdmin.desde,
            escuelaFija: true,
        };
        try {
            return await conCortafuegos(ctx, () => atender(s, p.msg));
        } catch (err: any) {
            console.error('[mapi-wa] turno de prueba falló', { err: err?.message || String(err) });
            await s.enviar([texto(`El turno de prueba falló: ${String(err?.message || err).slice(0, 300)}`, 'mapi_prueba_error')]);
            return 'mapi_error' as const;
        }
    });
    const memoria = { mapi_action_drafts: (ctx.memoria.mapi_action_drafts ?? []).slice(-MAX_BORRADORES_MEMORIA) };
    return { resultado, bloqueadas: ctx.bloqueadas, memoria };
}
