/**
 * plataforma-wa-entrante — lo que llega al número de SportMaps.
 *
 * Spec canal-whatsapp-plataforma §3.3. El webhook lo llama ANTES de
 * `resolveIntegration` cuando el phone_number_id es el del canal: estos
 * mensajes nunca entran a `whatsapp_conversations` de ninguna escuela.
 *
 *   tester (PLATFORM_WA_TESTERS) con «/…» o con sesión → modo pruebas (F2)
 *   PLATFORM_WA_ENABLED + ACTIVAR / DESACTIVAR / AYUDA  → suscripción (F1)
 *   número con suscripción activa                       → ayuda corta, 1 vez/24 h
 *   resto                                               → silencio (D12), o una
 *       respuesta comercial cada 30 días con PLATFORM_WA_RESPUESTA_COMERCIAL=true
 *
 * D4: el consentimiento lo da el NÚMERO escribiendo. Meta autentica el `from`;
 * un código del enlace de la app no sirve desde otro número.
 */

import { supabase } from '../config/supabase';
import type { ParsedInboundMessage } from './whatsapp.service';
import {
    leerCanal, canalHabilitado, testersDePlataforma, soloDigitos, registrarMensaje, enviarTextoPlataforma,
    adminsDeEscuela, nombreDeEscuela, escuelaHabilitada, urlDeLaApp, COLUMNAS_SUSCRIPCION,
    type CanalPlataforma, type ClaseDeContacto, type Suscripcion,
} from './plataforma-wa.service';
import { atenderPrueba, haySesionDePrueba } from './plataforma-wa-pruebas.service';

// ─── Comandos (puros) ────────────────────────────────────────────────────────

function normalizar(t: string): string {
    return t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export type ComandoSuscripcion =
    | { tipo: 'activar'; codigo: string | null }
    | { tipo: 'desactivar' }
    | { tipo: 'ayuda' };

const NEGACION = /(^| )(no|nunca|jamas)( |$)/;

/**
 * «ACTIVAR», «ACTIVAR K7P2QX», o el texto prellenado del enlace de la app que
 * TERMINA en «ACTIVAR <código>». «DESACTIVAR» no es «ACTIVAR» (límite de
 * palabra). «no quiero activar» no activa. Pura.
 */
export function comandoDeSuscripcion(texto: string | null | undefined): ComandoSuscripcion | null {
    const crudo = String(texto ?? '').trim();
    if (!crudo || crudo.length > 400) return null;
    const n = normalizar(crudo);
    if (/^(desactivar|desactivar avisos|pausar|pausar avisos|stop|baja|cancelar avisos|no mas avisos)$/.test(n)) {
        return { tipo: 'desactivar' };
    }
    if (/^(ayuda|help|menu|estado|info)$/.test(n)) return { tipo: 'ayuda' };
    const m = n.match(/(?:^| )activar(?: ([a-z0-9]{6}))?$/);
    if (!m) return null;
    const antes = n.slice(0, m.index ?? 0);
    if (NEGACION.test(antes)) return null;
    const codigo = m[1] && m[1] !== 'avisos' ? m[1].toUpperCase() : null;
    return { tipo: 'activar', codigo };
}

/** Texto prellenado del enlace de la app. Termina en el código. Puro. */
export function textoDeActivacion(escuela: string, codigo: string): string {
    return `Quiero recibir en este WhatsApp los avisos de SportMaps de ${escuela}. ACTIVAR ${codigo}`;
}

export function enlaceDeActivacion(numeroCanal: string, escuela: string, codigo: string): string {
    return `https://wa.me/${soloDigitos(numeroCanal)}?text=${encodeURIComponent(textoDeActivacion(escuela, codigo))}`;
}

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function nuevoCodigo(azar: () => number = Math.random): string {
    let c = '';
    for (let i = 0; i < 6; i++) c += ALFABETO[Math.floor(azar() * ALFABETO.length) % ALFABETO.length];
    return c;
}

export const TEXTO_AYUDA_SUSCRIPTOR =
    'Este número de SportMaps solo envía avisos de tu escuela (comprobantes, casos urgentes, clases de cortesía y resúmenes). ' +
    'Para responder a las familias o aprobar pagos, usa la app.\n\n' +
    'Escribe *PAUSAR* para dejar de recibirlos.';

export const TEXTO_COMERCIAL =
    '¡Hola! Gracias por escribir a SportMaps 👋 Una persona del equipo te responde por aquí en horario laboral. ' +
    'Mientras tanto puedes conocer la plataforma en https://sportmaps.co';

// ─── Entrada ─────────────────────────────────────────────────────────────────

export type ResultadoEntrante =
    | 'sin_canal' | 'duplicado' | 'prueba' | 'apagado' | 'activada' | 'activar_sin_escuela' | 'codigo_invalido'
    | 'codigo_de_otro_numero' | 'desactivada' | 'ayuda' | 'silencio' | 'comercial' | 'no_texto';

async function suscripcionesDelNumero(numero: string): Promise<Suscripcion[]> {
    const { data, error } = await supabase.from('platform_wa_suscripciones')
        .select(COLUMNAS_SUSCRIPCION).eq('contact_wa_id', numero);
    return error ? [] : ((data ?? []) as unknown as Suscripcion[]);
}

/** ¿Ya se le mandó este paso en la ventana? (freno de repeticiones) */
async function pasoReciente(numero: string, paso: string, ms: number, ahora: number): Promise<boolean> {
    const { data, error } = await supabase.from('platform_wa_mensajes')
        .select('id').eq('contact_wa_id', numero).eq('direccion', 'saliente').eq('paso', paso)
        .gte('created_at', new Date(ahora - ms).toISOString()).limit(1);
    if (error) return true; // sin poder leer el freno, se frena
    return ((data ?? []) as any[]).length > 0;
}

export async function atenderEntrantePlataforma(
    msg: ParsedInboundMessage,
    ahora = Date.now(),
): Promise<ResultadoEntrante> {
    const canal = await leerCanal();
    if (!canal) return 'sin_canal';
    const numero = soloDigitos(msg.contactWaId);
    const texto = msg.textBody ?? '';

    const esTester = testersDePlataforma().has(numero);
    const habilitado = await canalHabilitado();
    const suscripciones = habilitado ? await suscripcionesDelNumero(numero) : [];
    const comando = habilitado && msg.type === 'text' ? comandoDeSuscripcion(texto) : null;

    // Modo pruebas: todo lo del tester, salvo los comandos de suscripción
    // (ACTIVAR/PAUSAR/AYUDA) escritos FUERA de una sesión de prueba: así el
    // tester también puede probar el alta como si fuera una dueña.
    const vaAPrueba = esTester && (!comando || texto.trim().startsWith('/') || await haySesionDePrueba(numero));
    const clase: ClaseDeContacto = vaAPrueba
        ? 'tester'
        : (comando || suscripciones.length ? 'suscriptor' : 'desconocido');

    // Idempotencia: Meta reintenta. El primero que guarda el wa_message_id sigue.
    const nuevo = await registrarMensaje({
        waMessageId: msg.waMessageId, direccion: 'entrante', contactWaId: numero, clase,
        tipo: msg.type, texto: texto || null,
    });
    if (!nuevo) return 'duplicado';

    if (vaAPrueba) {
        await atenderPrueba(canal, msg, ahora);
        return 'prueba';
    }

    if (!habilitado) return 'apagado';

    if (comando?.tipo === 'activar') return activar(canal, numero, comando.codigo, msg.waMessageId, ahora);
    if (comando?.tipo === 'desactivar') return desactivar(canal, numero, suscripciones);
    if (comando?.tipo === 'ayuda' || suscripciones.some((s) => s.estado === 'activa')) {
        if (comando?.tipo !== 'ayuda' && await pasoReciente(numero, 'ayuda', 24 * 3600_000, ahora)) return 'silencio';
        const activas = suscripciones.filter((s) => s.estado === 'activa');
        const escuelas = await Promise.all(activas.map((s) => nombreDeEscuela(s.school_id)));
        const cabeza = escuelas.length
            ? `Recibes aquí los avisos de: ${escuelas.join(', ')}.\n\n`
            : 'Todavía no recibes avisos en este número. Actívalos en la app: WhatsApp → Configuración → «Recibir avisos de SportMaps en mi WhatsApp».\n\n';
        await enviarTextoPlataforma(canal, numero, cabeza + TEXTO_AYUDA_SUSCRIPTOR, {
            enlace: { url: urlDeLaApp('/whatsapp?tab=config'), texto: 'Abrir la app' }, clase: 'suscriptor', paso: 'ayuda',
        });
        return 'ayuda';
    }

    // D12: el número es el comercial y ventas lo atiende en el celular.
    if (process.env.PLATFORM_WA_RESPUESTA_COMERCIAL === 'true' && msg.type === 'text'
        && !(await pasoReciente(numero, 'comercial', 30 * 24 * 3600_000, ahora))) {
        await enviarTextoPlataforma(canal, numero, TEXTO_COMERCIAL, { clase: 'desconocido', paso: 'comercial' });
        return 'comercial';
    }
    return msg.type === 'text' ? 'silencio' : 'no_texto';
}

// ─── ACTIVAR ─────────────────────────────────────────────────────────────────

async function responder(canal: CanalPlataforma, numero: string, texto: string, paso: string): Promise<void> {
    await enviarTextoPlataforma(canal, numero, texto, { clase: 'suscriptor', paso });
}

const PIE_PAUSAR = '\n\nCuando quieras dejar de recibirlos, escribe *PAUSAR*. Aprobar pagos y responder a las familias sigue siendo en la app.';

/**
 * Escuelas habilitadas donde `numero` es el teléfono del perfil de un
 * owner/admin activo. Cruce por los últimos 10 dígitos (en la base conviven
 * 3001234567, +573001234567 y 573001234567) y verificación exacta en código.
 */
export async function escuelasDondeEsAdmin(numero: string): Promise<{ schoolId: string; profileId: string }[]> {
    const diez = soloDigitos(numero).slice(-10);
    if (!/^3\d{9}$/.test(diez)) return [];
    const { data: perfiles } = await supabase.from('profiles').select('id, phone').like('phone', `%${diez}`).limit(10);
    const ids = ((perfiles ?? []) as any[]).filter((p) => soloDigitos(p.phone).slice(-10) === diez).map((p) => p.id as string);
    if (!ids.length) return [];
    const [{ data: propias }, { data: miembros }] = await Promise.all([
        supabase.from('schools').select('id, owner_id').in('owner_id', ids).limit(20),
        supabase.from('school_members').select('school_id, profile_id')
            .in('profile_id', ids).eq('status', 'active').in('role', ['owner', 'admin', 'school_admin']).limit(20),
    ]);
    const pares = new Map<string, string>();
    for (const s of (propias ?? []) as any[]) pares.set(s.id, s.owner_id);
    for (const m of (miembros ?? []) as any[]) if (!pares.has(m.school_id)) pares.set(m.school_id, m.profile_id);
    if (!pares.size) return [];
    const { data: habilitadas } = await supabase.from('platform_wa_escuelas')
        .select('school_id').in('school_id', [...pares.keys()]).eq('habilitado', true);
    return ((habilitadas ?? []) as any[]).slice(0, 5).map((h) => ({ schoolId: h.school_id, profileId: pares.get(h.school_id)! }));
}

async function activar(
    canal: CanalPlataforma, numero: string, codigo: string | null, waMessageId: string, ahora: number,
): Promise<ResultadoEntrante> {
    const ahoraIso = new Date(ahora).toISOString();

    if (codigo) {
        const { data: fila } = await supabase.from('platform_wa_suscripciones')
            .select(COLUMNAS_SUSCRIPCION).eq('codigo', codigo).eq('estado', 'pendiente').maybeSingle();
        const s = fila as unknown as Suscripcion | null;
        if (!s || !s.codigo_expira_at || Date.parse(s.codigo_expira_at) < ahora) {
            await responder(canal, numero, 'Ese código no es válido o ya venció. Pide uno nuevo en la app: WhatsApp → Configuración → «Recibir avisos de SportMaps en mi WhatsApp».', 'activar_codigo_invalido');
            return 'codigo_invalido';
        }
        // El código viaja en un enlace que se puede reenviar: solo vale desde el número que se registró.
        if (s.contact_wa_id !== numero) {
            await responder(canal, numero, 'Ese código es para otro número de WhatsApp. Ábrelo desde el celular que registraste en la app.', 'activar_otro_numero');
            return 'codigo_de_otro_numero';
        }
        if (!(await escuelaHabilitada(s.school_id)) || !(await adminsDeEscuela(s.school_id)).has(s.profile_id)) {
            await responder(canal, numero, 'No pude activar los avisos: tu usuario ya no administra esa escuela o la escuela no tiene el servicio activo.', 'activar_sin_permiso');
            return 'activar_sin_escuela';
        }
        await supabase.from('platform_wa_suscripciones').update({
            estado: 'activa', consentimiento_ref: waMessageId, activada_at: ahoraIso,
            codigo: null, codigo_expira_at: null, revocada_at: null, motivo_revocacion: null,
        }).eq('id', s.id).eq('estado', 'pendiente');
        const escuela = await nombreDeEscuela(s.school_id);
        await responder(canal, numero, `✅ Listo. Vas a recibir aquí los avisos de *${escuela}*: comprobantes por revisar, casos que piden a una persona, clases de cortesía y el resumen de las 7:00 a. m. Entre las 10 p. m. y las 7 a. m. no te escribimos.${PIE_PAUSAR}`, 'activada');
        return 'activada';
    }

    const escuelas = await escuelasDondeEsAdmin(numero);
    if (!escuelas.length) {
        await responder(canal, numero, 'No encontré una escuela con este servicio donde este número sea el de un administrador. Actívalo desde la app: WhatsApp → Configuración → «Recibir avisos de SportMaps en mi WhatsApp».', 'activar_sin_escuela');
        return 'activar_sin_escuela';
    }
    for (const e of escuelas) {
        await supabase.from('platform_wa_suscripciones').upsert({
            school_id: e.schoolId, profile_id: e.profileId, contact_wa_id: numero,
            estado: 'activa', origen: 'whatsapp', consentimiento_ref: waMessageId, activada_at: ahoraIso,
            codigo: null, codigo_expira_at: null, revocada_at: null, motivo_revocacion: null,
        }, { onConflict: 'school_id,contact_wa_id' });
    }
    const nombres = await Promise.all(escuelas.map((e) => nombreDeEscuela(e.schoolId)));
    await responder(canal, numero, `✅ Listo. Vas a recibir aquí los avisos de *${nombres.join(', ')}*. Entre las 10 p. m. y las 7 a. m. no te escribimos.${PIE_PAUSAR}`, 'activada');
    return 'activada';
}

async function desactivar(canal: CanalPlataforma, numero: string, subs: Suscripcion[]): Promise<ResultadoEntrante> {
    if (subs.some((s) => s.estado !== 'revocada')) {
        await supabase.from('platform_wa_suscripciones').update({
            estado: 'revocada', revocada_at: new Date().toISOString(), motivo_revocacion: 'whatsapp',
            codigo: null, codigo_expira_at: null,
        }).eq('contact_wa_id', numero).neq('estado', 'revocada');
    }
    await responder(canal, numero, 'Listo, no te enviaremos más avisos por aquí. Si quieres volver a recibirlos, escribe *ACTIVAR*.', 'desactivada');
    return 'desactivada';
}
