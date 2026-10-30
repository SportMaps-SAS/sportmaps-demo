/**
 * plataforma-wa-pruebas — «modo escuela» para el desarrollador (F2).
 *
 * Spec canal-whatsapp-plataforma §3.4 y D13. El tester (PLATFORM_WA_TESTERS)
 * le escribe al número de SportMaps, elige una escuela y habla con el bot como
 * papá de un atleta DE PRUEBA o como prospecto. El bot corre su pipeline real
 * (`debeAtender` → `runBotTurn` / `atenderDesconocido`) con la configuración
 * real de esa escuela, pero dentro de `conCortafuegos`:
 *
 *   - la conversación (whatsapp_conversations/messages/flows/…) vive en una
 *     memoria virtual, persistida en platform_wa_sesiones_prueba.estado;
 *   - toda escritura a una tabla real devuelve error SIM00 y se anota;
 *   - no sale push, correo, ni nada por Graph (tampoco por el número de la
 *     escuela); `deliver` del bot anota lo que habría enviado (`simularEnvios`).
 *
 * Las respuestas se mandan al tester DESPUÉS del turno y FUERA del cortafuegos,
 * por el número de SportMaps, con el prefijo 🧪.
 *
 * El contacto dentro de la simulación NO es el número del tester sino uno
 * sintético (57399 + últimos 7 dígitos): el número real del desarrollador
 * puede estar en perfiles o fichas y cambiaría quién cree el bot que escribe.
 */

import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase';
import { conCortafuegos, type ContextoCortafuegos, type Fila } from '../config/cortafuegos-simulacion';
import {
    sendInteractiveButtons, sendTextMessage, sendCtaUrl, type ParsedInboundMessage, type WhatsAppIntegration,
} from './whatsapp.service';
import { integracionDePlataforma, registrarMensaje, soloDigitos, type CanalPlataforma } from './plataforma-wa.service';
import { uuidDeClave } from './avisos-correo.service';
import { debeAtender } from './whatsapp-atencion.service';
import { runBotTurn, atenderDesconocido, simularEnvios, type SalidaSimulada } from './whatsapp-bot.service';
import {
    esAdjuntoDeComprobante, bajarAdjuntoDePrueba, comprobanteSimulado, plantillaSimulada, textoListaPlantillas,
    avanzarSimulado, trabajoDeAvanzar, TEXTO_AYUDA_AVANZAR, type EscenarioPrueba,
} from './plataforma-wa-pruebas-simular.service';

// ─── Comandos (puros) ────────────────────────────────────────────────────────

export type ComandoPrueba =
    | { cmd: 'escuela'; arg: string }
    | { cmd: 'como_papa'; arg: string }
    | { cmd: 'como_prospecto' }
    | { cmd: 'reiniciar' }
    | { cmd: 'estado' }
    | { cmd: 'salir' }
    | { cmd: 'ayuda' }
    | { cmd: 'plantillas' }
    | { cmd: 'plantilla'; arg: string }
    | { cmd: 'avanzar'; arg: string }
    | { cmd: 'desconocido'; texto: string };

export function parsearComandoPrueba(texto: string | null | undefined): ComandoPrueba | null {
    const t = String(texto ?? '').trim();
    if (!t.startsWith('/')) return null;
    const [cabeza, ...resto] = t.slice(1).split(/\s+/);
    const c = cabeza.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const arg = resto.join(' ').trim();
    if (c === 'escuela') return arg ? { cmd: 'escuela', arg } : { cmd: 'ayuda' };
    if (c === 'como') {
        const [quien, ...mas] = resto;
        const q = String(quien ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
        if (q === 'papa' || q === 'mama' || q === 'acudiente') {
            const a = mas.join(' ').trim();
            return a ? { cmd: 'como_papa', arg: a } : { cmd: 'ayuda' };
        }
        if (q === 'prospecto') return { cmd: 'como_prospecto' };
        return { cmd: 'ayuda' };
    }
    if (c === 'reiniciar') return { cmd: 'reiniciar' };
    if (c === 'estado') return { cmd: 'estado' };
    if (c === 'salir') return { cmd: 'salir' };
    if (c === 'ayuda' || c === 'help') return { cmd: 'ayuda' };
    if (c === 'plantillas') return { cmd: 'plantillas' };
    if (c === 'plantilla') return arg ? { cmd: 'plantilla', arg } : { cmd: 'plantillas' };
    if (c === 'avanzar') return { cmd: 'avanzar', arg };
    return { cmd: 'desconocido', texto: t };
}

export const TEXTO_AYUDA_PRUEBAS = [
    '🧪 *Modo escuela (pruebas)*',
    'Nada se escribe en la escuela: ni pagos, ni cupos, ni leads, ni avisos.',
    '',
    '/escuela <slug o nombre> — elegir escuela',
    '/como papa <id o nombre de atleta de prueba>',
    '/como prospecto',
    '/reiniciar — borrar la memoria de la conversación',
    '/estado — escuela, rol y lo que se bloqueó',
    '/salir',
    '',
    '📎 Foto o PDF de un comprobante — qué haría el bot (OCR real; no se guarda ni se registra nada)',
    '/plantillas — catálogo de plantillas · /plantilla <nombre> — cómo se vería con datos de la escuela',
    '/avanzar <recordatorio | mismo-dia | seguimiento | post-clase> — lo que mandaría ese job (3d / 7d todavía no existen: B5)',
].join('\n');

/** El contacto sintético con que el bot ve al tester. Puro. */
export function contactoSintetico(tester: string): string {
    return `57399${soloDigitos(tester).slice(-7).padStart(7, '0')}`;
}

/** La conversación simulada de la sesión (la misma en todos los turnos con esa escuela). */
export function conversacionDePrueba(sesion: Pick<SesionPrueba, 'contact_wa_id' | 'school_id' | 'estado'>): string {
    return sesion.estado.conversationId ?? uuidDeClave(`sim-conversacion:${sesion.contact_wa_id}:${sesion.school_id}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MENSAJES_MEMORIA = 40;

// ─── Sesión ──────────────────────────────────────────────────────────────────

export interface EstadoSimulado {
    conversationId?: string;
    tablas?: Record<string, Fila[]>;
    bloqueadas?: string[];
}

export interface SesionPrueba {
    contact_wa_id: string;
    school_id: string | null;
    rol: 'papa' | 'prospecto';
    child_id: string | null;
    parent_id: string | null;
    estado: EstadoSimulado;
}

export async function haySesionDePrueba(numero: string): Promise<boolean> {
    const { data, error } = await supabase.from('platform_wa_sesiones_prueba')
        .select('contact_wa_id').eq('contact_wa_id', numero).maybeSingle();
    return !error && Boolean(data);
}

async function leerSesion(numero: string): Promise<SesionPrueba | null> {
    const { data, error } = await supabase.from('platform_wa_sesiones_prueba')
        .select('contact_wa_id, school_id, rol, child_id, parent_id, estado').eq('contact_wa_id', numero).maybeSingle();
    if (error || !data) return null;
    return { ...(data as any), estado: ((data as any).estado ?? {}) as EstadoSimulado };
}

async function guardarSesion(s: SesionPrueba): Promise<void> {
    const { error } = await supabase.from('platform_wa_sesiones_prueba').upsert({
        contact_wa_id: s.contact_wa_id, school_id: s.school_id, rol: s.rol,
        child_id: s.child_id, parent_id: s.parent_id, estado: s.estado,
    }, { onConflict: 'contact_wa_id' });
    if (error) console.warn('[plataforma-wa-pruebas] no se pudo guardar la sesión', { err: error.message });
}

// ─── Envío al tester (fuera del cortafuegos) ────────────────────────────────

async function decir(canal: CanalPlataforma, to: string, texto: string, paso = 'prueba'): Promise<void> {
    const r = await sendTextMessage(integracionDePlataforma(canal), to, texto.slice(0, 4096));
    if (r.ok && r.waMessageId) {
        await registrarMensaje({ waMessageId: r.waMessageId, direccion: 'saliente', contactWaId: to, clase: 'tester', tipo: 'text', texto, paso });
    }
}

/** Lo que el bot habría enviado, ahora sí, al tester. */
export async function mandarSalidas(canal: CanalPlataforma, to: string, salidas: SalidaSimulada[]): Promise<void> {
    const integ = integracionDePlataforma(canal);
    for (const s of salidas) {
        const cuerpo = `🧪 ${s.texto}${s.imagen ? '\n\n[con foto]' : ''}`;
        let r = { ok: false } as { ok: boolean; waMessageId?: string };
        if (s.opciones?.length) {
            r = await sendInteractiveButtons(integ, to, cuerpo, s.opciones);
            if (!r.ok) {
                const lista = s.opciones.map((o, i) => `${i + 1}. ${o.title}`).join('\n');
                r = await sendTextMessage(integ, to, `${cuerpo}\n\n${lista}`.slice(0, 4096));
            }
        } else if (s.cta) {
            r = await sendCtaUrl(integ, to, cuerpo, s.cta.texto, s.cta.url);
            if (!r.ok) r = await sendTextMessage(integ, to, `${cuerpo}\n\n${s.cta.texto}: ${s.cta.url}`.slice(0, 4096));
        } else {
            r = await sendTextMessage(integ, to, cuerpo.slice(0, 4096));
        }
        if (r.ok && r.waMessageId) {
            await registrarMensaje({ waMessageId: r.waMessageId, direccion: 'saliente', contactWaId: to, clase: 'tester', tipo: 'text', texto: s.texto, paso: s.step ?? 'prueba' });
        }
    }
}

// ─── La escuela y la integración a simular ──────────────────────────────────

async function buscarEscuela(arg: string): Promise<{ unica: any | null; opciones: any[] }> {
    const a = arg.trim();
    const { data: porSlug } = await supabase.from('schools').select('id, name, slug, is_demo').eq('slug', a.toLowerCase()).limit(1);
    if ((porSlug ?? []).length) return { unica: (porSlug as any[])[0], opciones: [] };
    if (UUID.test(a)) {
        const { data } = await supabase.from('schools').select('id, name, slug, is_demo').eq('id', a).limit(1);
        if ((data ?? []).length) return { unica: (data as any[])[0], opciones: [] };
    }
    const patron = `%${a.replace(/[%_]/g, '')}%`;
    const { data } = await supabase.from('schools').select('id, name, slug, is_demo').ilike('name', patron).limit(6);
    const lista = (data ?? []) as any[];
    return lista.length === 1 ? { unica: lista[0], opciones: [] } : { unica: null, opciones: lista };
}

/** La integración real de la escuela (solo para leer) o una virtual. */
export async function integracionParaSimular(schoolId: string): Promise<WhatsAppIntegration> {
    const { data } = await supabase.from('school_whatsapp_integrations')
        .select('id, school_id, phone_number_id, waba_id, display_phone_number, status')
        .eq('school_id', schoolId).eq('status', 'active').limit(1);
    const real = ((data ?? []) as any[])[0];
    return {
        id: real?.id ?? uuidDeClave(`sim-integracion:${schoolId}`),
        school_id: schoolId,
        phone_number_id: real?.phone_number_id ?? 'simulado',
        waba_id: real?.waba_id ?? null,
        display_phone_number: real?.display_phone_number ?? null,
        // Sin token A PROPÓSITO: aunque algo escapara al cortafuegos, no hay con qué enviar.
        access_token_encrypted: null,
        verify_token: null,
        status: 'active',
    };
}

const AJUSTES_POR_DEFECTO = {
    mode: 'auto', assisted_until: null, ai_enabled: true, responder_desconocidos: false,
    transcribir_audios: false, responder_prospectos: true, default_locale: 'es',
};

/** Ajustes reales del bot de esa escuela, con el bot prendido y en automático. */
async function ajustesParaSimular(integ: WhatsAppIntegration): Promise<Fila> {
    const { data } = await supabase.from('whatsapp_settings').select('*').eq('integration_id', integ.id).maybeSingle();
    return {
        ...AJUSTES_POR_DEFECTO,
        ...((data as any) ?? {}),
        integration_id: integ.id,
        // En simulación el bot siempre contesta (eso es lo que se prueba) y sin borradores.
        ai_enabled: true, mode: 'auto', assisted_until: null,
    };
}

// ─── El turno ────────────────────────────────────────────────────────────────

export interface ResultadoTurnoSimulado { salidas: SalidaSimulada[]; bloqueadas: string[]; nota: string | null }

/**
 * Corre UN turno del bot en simulación. Exportada para las pruebas (con
 * `runBotTurn` y compañía simulados por vi.mock).
 */
export async function turnoSimulado(
    sesion: SesionPrueba,
    msg: Pick<ParsedInboundMessage, 'waMessageId' | 'textBody' | 'botonId'>,
    ahora = Date.now(),
): Promise<ResultadoTurnoSimulado> {
    const schoolId = sesion.school_id!;
    const integ = await integracionParaSimular(schoolId);
    const ajustes = await ajustesParaSimular(integ);
    const contacto = contactoSintetico(sesion.contact_wa_id);
    const conversationId = conversacionDePrueba(sesion);
    const ahoraIso = new Date(ahora).toISOString();
    const texto = msg.textBody ?? '';

    const tablas: Record<string, Fila[]> = { ...(sesion.estado.tablas ?? {}) };
    const conv: Fila = (tablas.whatsapp_conversations ?? [])[0] ?? {
        id: conversationId, integration_id: integ.id, school_id: schoolId, contact_wa_id: contacto,
        contact_name: 'Prueba SportMaps', parent_id: null, identified: false, status: 'open', contact_kind: null,
        unread_count: 0, tomada_por: null, tomada_hasta: null, bot_turno_hasta: null, created_at: ahoraIso,
    };
    // El rol manda sobre lo que quedó en memoria.
    conv.parent_id = sesion.rol === 'papa' ? sesion.parent_id : null;
    conv.identified = sesion.rol === 'papa' && Boolean(sesion.parent_id);
    conv.last_inbound_at = ahoraIso;
    conv.last_message_at = ahoraIso;
    conv.updated_at = ahoraIso;
    tablas.whatsapp_conversations = [conv];
    tablas.whatsapp_settings = [ajustes];
    tablas.whatsapp_messages = [...(tablas.whatsapp_messages ?? []), {
        id: randomUUID(), conversation_id: conversationId, integration_id: integ.id, direction: 'inbound',
        type: msg.botonId ? 'interactive' : 'text', text_body: texto, payload: msg.botonId ? { boton_id: msg.botonId } : {},
        ai_generated: false, wa_message_id: msg.waMessageId, from_wa_id: contacto, to_wa_id: null,
        wa_timestamp: ahoraIso, created_at: ahoraIso, status: null,
    }];

    const identificacion = () => {
        if (sesion.rol !== 'papa') return { estado: 'desconocido' };
        if (!sesion.parent_id) return { estado: 'debe_registrarse' };
        // La RPC real deja la conversación vinculada: aquí, en memoria.
        conv.parent_id = sesion.parent_id;
        conv.identified = true;
        return { estado: 'identificado', parent_id: sesion.parent_id };
    };
    const ctx: ContextoCortafuegos = {
        memoria: tablas,
        bloqueadas: [],
        rpc: {
            wa_identify_by_phone: identificacion,
            wa_identify_staff_admin_by_phone: () => ({ estado: 'desconocido' }),
            wa_es_familia_sin_registrar: () => sesion.rol === 'papa' && !sesion.parent_id,
            wa_invitacion_pendiente_por_telefono: () => null,
            wa_can_send_template: () => false,
            wa_is_blocked: () => false,
        },
    };

    let nota: string | null = null;
    const { salidas } = await conCortafuegos(ctx, () => simularEnvios(async () => {
        const d = await debeAtender(integ, conversationId, contacto);
        if (d.atender) {
            nota = `runBotTurn (contacto: ${d.tipo})`;
            await runBotTurn(integ, conversationId, contacto, texto, msg.waMessageId, false, msg.botonId ?? null, { origen: 'texto' });
            return;
        }
        if (d.botEncendido && !d.tomada && d.tipo === 'desconocido') {
            const resultado = await atenderDesconocido(integ, conversationId, contacto, texto, msg.botonId ?? null);
            // Si no sale nada, el porqué (p. ej. el freno de 30 días del tema escolar).
            nota = `atenderDesconocido → ${String(resultado)}`;
            return;
        }
        nota = `el asistente no atendería este contacto (tipo: ${d.tipo})`;
    }));

    // Lo que «salió» queda en la memoria, como lo habría dejado `deliver`.
    const enMemoria = ctx.memoria;
    for (const s of salidas) {
        (enMemoria.whatsapp_messages ??= []).push({
            id: randomUUID(), conversation_id: conversationId, integration_id: integ.id, direction: 'outbound',
            type: s.opciones?.length ? 'interactive' : 'text', text_body: s.texto,
            payload: { ...(s.payload ?? {}), step: s.step, ...(s.opciones?.length ? { botones: s.opciones.map((o) => o.id) } : {}) },
            ai_generated: true, wa_message_id: `sim-${randomUUID()}`, from_wa_id: null, to_wa_id: contacto,
            wa_timestamp: new Date().toISOString(), created_at: new Date().toISOString(), status: 'sent',
        });
    }
    enMemoria.whatsapp_messages = (enMemoria.whatsapp_messages ?? []).slice(-MAX_MENSAJES_MEMORIA);
    delete enMemoria.whatsapp_settings; // se relee de la escuela en cada turno
    sesion.estado = { conversationId, tablas: enMemoria, bloqueadas: ctx.bloqueadas.slice(0, 50) };
    return { salidas, bloqueadas: ctx.bloqueadas, nota };
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

export async function atenderPrueba(canal: CanalPlataforma, msg: ParsedInboundMessage, ahora = Date.now()): Promise<void> {
    const numero = soloDigitos(msg.contactWaId);
    const comando = msg.type === 'text' ? parsearComandoPrueba(msg.textBody) : null;
    const sesion = await leerSesion(numero);

    try {
        if (comando) {
            await ejecutarComando(canal, numero, sesion, comando, ahora);
            return;
        }
        if (!sesion?.school_id) {
            await decir(canal, numero, `${TEXTO_AYUDA_PRUEBAS}\n\nPrimero elige una escuela: /escuela <slug>`, 'prueba_ayuda');
            return;
        }
        // B7: foto o PDF → la lectura y la decisión de la cola de comprobantes,
        // sin escribir (plataforma-wa-pruebas-simular). El archivo se baja con el
        // token del canal de SportMaps, que es a donde lo mandó el tester.
        if (esAdjuntoDeComprobante(msg)) {
            const bajada = await bajarAdjuntoDePrueba(canal, msg.mediaId as string);
            if (!bajada.ok) {
                await decir(canal, numero, `🧪 No pude bajar el archivo de Meta: ${bajada.error}`, 'prueba_comprobante');
                return;
            }
            const r = await comprobanteSimulado(await escenarioDe(sesion, ahora), bajada,
                msg.mediaCaption ?? null, msg.waTimestamp || new Date(ahora).toISOString());
            sesion.estado = { ...sesion.estado, bloqueadas: r.bloqueadas.slice(0, 50) };
            await guardarSesion(sesion);
            await decir(canal, numero, r.texto, 'prueba_comprobante');
            return;
        }
        if (!['text', 'interactive', 'button'].includes(msg.type)) {
            await decir(canal, numero, '🧪 En pruebas: texto, botones, fotos y PDF. Los audios, videos y stickers no se procesan.', 'prueba_tipo');
            return;
        }
        const r = await turnoSimulado(sesion, msg, ahora);
        await guardarSesion(sesion);
        if (r.salidas.length) await mandarSalidas(canal, numero, r.salidas);
        else await decir(canal, numero, `🧪 (el bot no respondió nada${r.nota ? `: ${r.nota}` : ''})`, 'prueba_silencio');
    } catch (e: any) {
        console.error('[plataforma-wa-pruebas] el turno simulado falló', { err: e?.message || String(e) });
        await decir(canal, numero, `🧪 El turno simulado falló: ${String(e?.message || e).slice(0, 300)}`, 'prueba_error');
    }
}

/** La sesión con lo que necesitan las simulaciones de B7 (integración sin token y conversación). */
async function escenarioDe(sesion: SesionPrueba, ahora: number): Promise<EscenarioPrueba> {
    return {
        sesion, integ: await integracionParaSimular(sesion.school_id as string),
        conversationId: conversacionDePrueba(sesion), ahora,
    };
}

async function ejecutarComando(
    canal: CanalPlataforma, numero: string, sesion: SesionPrueba | null, c: ComandoPrueba, ahora = Date.now(),
): Promise<void> {
    switch (c.cmd) {
        case 'ayuda':
        case 'desconocido':
            await decir(canal, numero, TEXTO_AYUDA_PRUEBAS, 'prueba_ayuda');
            return;
        case 'plantillas':
            await decir(canal, numero, textoListaPlantillas(), 'prueba_plantillas');
            return;
        case 'salir':
            await supabase.from('platform_wa_sesiones_prueba').delete().eq('contact_wa_id', numero);
            await decir(canal, numero, '🧪 Sesión de pruebas cerrada.', 'prueba_salir');
            return;
        case 'escuela': {
            const { unica, opciones } = await buscarEscuela(c.arg);
            if (!unica) {
                await decir(canal, numero, opciones.length
                    ? `🧪 Hay varias. Usa el slug:\n${opciones.slice(0, 5).map((o) => `• ${o.name} — /escuela ${o.slug}`).join('\n')}`
                    : `🧪 No encontré «${c.arg}».`, 'prueba_escuela');
                return;
            }
            await guardarSesion({ contact_wa_id: numero, school_id: unica.id, rol: 'prospecto', child_id: null, parent_id: null, estado: {} });
            const integ = await integracionParaSimular(unica.id);
            await decir(canal, numero, `🧪 Escuela: *${unica.name}* (${unica.slug}). Eres un *prospecto*.`
                + (integ.phone_number_id === 'simulado' ? '\n(La escuela no tiene WhatsApp conectado: se usan los ajustes por defecto del bot.)' : '')
                + '\nEscribe como lo haría una familia. /como papa <atleta de prueba> para cambiar de rol.', 'prueba_escuela');
            return;
        }
        case 'como_prospecto':
        case 'como_papa':
        case 'reiniciar':
        case 'estado':
        case 'plantilla':
        case 'avanzar':
            if (!sesion?.school_id) {
                await decir(canal, numero, '🧪 Primero elige una escuela: /escuela <slug>', 'prueba_ayuda');
                return;
            }
    }
    const s = sesion!;
    if (c.cmd === 'plantilla') {
        const r = await plantillaSimulada(await escenarioDe(s, ahora), c.arg);
        await decir(canal, numero, r.texto, 'prueba_plantilla');
        return;
    }
    if (c.cmd === 'avanzar') {
        const trabajo = trabajoDeAvanzar(c.arg);
        if (!trabajo) {
            await decir(canal, numero, TEXTO_AYUDA_AVANZAR, 'prueba_avanzar');
            return;
        }
        const r = await avanzarSimulado(await escenarioDe(s, ahora), trabajo);
        // Lo que el job deja en la conversación (p. ej. el recordatorio, para
        // que «CANCELAR» se lea contra él) queda en la memoria de la sesión.
        const tablas = { ...(s.estado.tablas ?? {}) };
        if (r.enMemoria) {
            tablas.whatsapp_messages = [...(tablas.whatsapp_messages ?? []), r.enMemoria].slice(-MAX_MENSAJES_MEMORIA);
        }
        s.estado = { ...s.estado, conversationId: conversacionDePrueba(s), tablas, bloqueadas: r.bloqueadas.slice(0, 50) };
        await guardarSesion(s);
        await decir(canal, numero, r.texto, 'prueba_avanzar');
        if (r.salida) await mandarSalidas(canal, numero, [r.salida]);
        return;
    }
    if (c.cmd === 'como_prospecto') {
        await guardarSesion({ ...s, rol: 'prospecto', child_id: null, parent_id: null, estado: {} });
        await decir(canal, numero, '🧪 Ahora eres un *prospecto* (número desconocido para la escuela). Memoria reiniciada.', 'prueba_rol');
        return;
    }
    if (c.cmd === 'reiniciar') {
        await guardarSesion({ ...s, estado: {} });
        await decir(canal, numero, '🧪 Memoria de la conversación borrada.', 'prueba_reiniciar');
        return;
    }
    if (c.cmd === 'estado') {
        const { data: escuela } = await supabase.from('schools').select('name, slug').eq('id', s.school_id!).maybeSingle();
        const mensajes = (s.estado.tablas?.whatsapp_messages ?? []).length;
        const bloqueadas = s.estado.bloqueadas ?? [];
        const resumen = new Map<string, number>();
        for (const b of bloqueadas) resumen.set(b, (resumen.get(b) ?? 0) + 1);
        await decir(canal, numero, [
            `🧪 Escuela: ${(escuela as any)?.name ?? s.school_id} (${(escuela as any)?.slug ?? '—'})`,
            `Rol: ${s.rol}${s.child_id ? ` (atleta ${s.child_id})` : ''}${s.rol === 'papa' && !s.parent_id ? ' — sin cuenta de acudiente' : ''}`,
            `Mensajes en memoria: ${mensajes}`,
            bloqueadas.length
                ? `Bloqueado en el último turno:\n${[...resumen].map(([k, n]) => `• ${k}${n > 1 ? ` ×${n}` : ''}`).join('\n')}`
                : 'Nada bloqueado en el último turno.',
        ].join('\n'), 'prueba_estado');
        return;
    }
    // como_papa
    const arg = (c as { arg: string }).arg;
    const { data: escuela } = await supabase.from('schools').select('is_demo').eq('id', s.school_id!).maybeSingle();
    const escuelaDemo = (escuela as any)?.is_demo === true;
    let q = supabase.from('children').select('id, full_name, parent_id, is_demo').eq('school_id', s.school_id!);
    q = UUID.test(arg) ? q.eq('id', arg) : q.ilike('full_name', `%${arg.replace(/[%_]/g, '')}%`);
    const { data: hijos } = await q.limit(6);
    // D14: solo atletas de prueba (o de una escuela de prueba).
    const deprueba = ((hijos ?? []) as any[]).filter((h) => escuelaDemo || h.is_demo === true);
    if (deprueba.length !== 1) {
        await decir(canal, numero, deprueba.length
            ? `🧪 Hay varios:\n${deprueba.slice(0, 5).map((h) => `• ${h.full_name} — /como papa ${h.id}`).join('\n')}`
            : '🧪 No encontré un atleta DE PRUEBA con ese nombre o id en esta escuela (solo children.is_demo = true o escuelas de prueba).', 'prueba_rol');
        return;
    }
    const h = deprueba[0];
    await guardarSesion({ ...s, rol: 'papa', child_id: h.id, parent_id: h.parent_id ?? null, estado: {} });
    await decir(canal, numero, `🧪 Ahora eres el acudiente de *${h.full_name}*${h.parent_id ? '' : ' (sin cuenta: el bot te verá como familia sin registrar)'}. Memoria reiniciada.`, 'prueba_rol');
}
