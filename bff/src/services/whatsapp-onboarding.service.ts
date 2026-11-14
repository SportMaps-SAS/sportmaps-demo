/**
 * El alta de una escuela por Embedded Signup (F1 del spec).
 *
 * Convierte el `code` que devuelve el diálogo de Meta en una integración viva:
 * canjea el token del negocio, resuelve a qué WABA y a qué número pertenece,
 * suscribe la app a los webhooks de esa cuenta y lo guarda todo cifrado.
 *
 * El orden importa y no es casual: **primero se verifica todo contra Meta y al
 * final se escribe**. Si se escribiera primero, un fallo a mitad dejaría una
 * escuela "conectada" que no puede enviar ni recibir — y eso no se nota hasta
 * que una familia escribe y nadie responde.
 *
 * Ver `docs/specs/whatsapp-alta-de-escuelas-y-buzon.md`.
 */

import { supabase } from '../config/supabase';
import { encryptToken, decryptToken } from './whatsapp.service';
import { avisarPlataformaSobreHistorial, CAMPO_PEDIDO_HISTORIAL } from './whatsapp-coexistence.service';

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`;
const APP_ID = process.env.META_APP_ID || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

/** El `event` de la sesión del Embedded Signup cuando la escuela conectó el número de su app (Coexistence). */
export const EVENTO_COEXISTENCIA = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

export interface DatosDeSesion {
    /** `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` cuando fue Coexistence. */
    event?: string;
    waba_id?: string;
    phone_number_id?: string;
    business_id?: string;
}

export type ResultadoAlta =
    | { ok: true; integrationId: string; displayPhoneNumber: string | null; coexistence: boolean }
    | { ok: false; error: string; detalle?: string };

/** Canjea el código de un solo uso por el token del negocio. */
export async function canjearCodigo(code: string): Promise<{ token: string } | { error: string }> {
    const url = `${GRAPH}/oauth/access_token`
        + `?client_id=${encodeURIComponent(APP_ID)}`
        + `&client_secret=${encodeURIComponent(APP_SECRET)}`
        + `&code=${encodeURIComponent(code)}`;
    const r = await fetch(url);
    const j: any = await r.json();
    if (!r.ok || !j?.access_token) {
        // El código vence en minutos y es de un solo uso: el error mas comun
        // aca es que la escuela dejo el dialogo abierto un rato.
        return { error: j?.error?.message || 'No se pudo canjear el código' };
    }
    return { token: j.access_token as string };
}

/**
 * Resuelve el WABA y el número.
 *
 * La información de sesión del diálogo los trae, pero llega por `postMessage`
 * desde el navegador: es un dato que el cliente puede inventar. Se contrasta
 * SIEMPRE contra Graph con el token recién canjeado — lo que el token alcanza
 * de verdad es lo único que vale.
 */
export async function resolverActivos(
    token: string,
    sesion: DatosDeSesion | null,
): Promise<{ wabaId: string; phoneNumberId: string; display: string | null } | { error: string }> {
    const wabaId = sesion?.waba_id;
    if (!wabaId) return { error: 'La sesión no trajo el identificador de la cuenta de WhatsApp' };

    const r = await fetch(
        `${GRAPH}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    const j: any = await r.json();
    if (!r.ok) {
        return { error: j?.error?.message || 'El token no alcanza esa cuenta de WhatsApp' };
    }

    const numeros = (j.data ?? []) as any[];
    if (!numeros.length) return { error: 'Esa cuenta de WhatsApp no tiene números' };

    // Si la sesión dijo cuál, se respeta — pero solo si de verdad está en la
    // cuenta. Si no, el primero.
    const elegido = numeros.find((n) => n.id === sesion?.phone_number_id) ?? numeros[0];
    return { wabaId, phoneNumberId: elegido.id, display: elegido.display_phone_number ?? null };
}

/** Suscribe la app a los webhooks de ese WABA. Sin esto no llega un solo mensaje. */
export async function suscribirWebhooks(token: string, wabaId: string): Promise<boolean> {
    const r = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok;
}

/**
 * ¿El número quedó a la vez en la app WhatsApp Business y en la API?
 *
 * No se confía solo en el `event` de la sesión: llega por `postMessage` desde
 * el navegador, y la pantalla de la escuela mandaba únicamente `sesion.data`
 * (sin `event`), así que el BFF nunca veía la coexistencia. Graph lo dice con
 * el token recién canjeado (doc de Meta «Onboarding WhatsApp Business app
 * users»): `GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type` →
 * `is_on_biz_app: true` + `platform_type: CLOUD_API`. Ante cualquier error,
 * false: el alta sigue como siempre.
 */
export async function numeroEnCoexistencia(token: string, phoneNumberId: string): Promise<boolean> {
    try {
        const r = await fetch(`${GRAPH}/${phoneNumberId}?fields=is_on_biz_app,platform_type`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) return false;
        const j: any = await r.json().catch(() => null);
        return j?.is_on_biz_app === true;
    } catch {
        return false;
    }
}

// ─── Sincronización del historial (Coexistence) ─────────────────────────────
//
// Con Coexistence Meta NO manda el historial sola: hay que pedirlo con
// `POST /<PHONE_NUMBER_ID>/smb_app_data` dentro de las 24 h siguientes al alta
// y UNA sola vez por tipo; pasado eso, la única salida es desconectar a la
// escuela y repetir el alta. Hasta el 2026-10-30 nadie lo pedía: Dynasty
// conectó el 2026-10-02 y tiene 0 mensajes anteriores al alta.
//
// Contrato verificado contra la doc de Meta el 2026-10-30:
//   POST /<PHONE_NUMBER_ID>/smb_app_data
//   { "messaging_product": "whatsapp", "sync_type": "history" | "smb_app_state_sync" }
//   → { "messaging_product": "whatsapp", "request_id": "…" }   (guardar el request_id para soporte)

export type TipoSincronizacion = 'history' | 'smb_app_state_sync';

/** Plazo que da Meta desde el alta para pedir el historial. */
export const PLAZO_SINCRONIZACION_MS = 24 * 3600_000;

/** Pide una sincronización. Nunca lanza. */
export async function pedirSincronizacion(
    token: string,
    phoneNumberId: string,
    tipo: TipoSincronizacion,
): Promise<{ ok: true; requestId: string | null } | { ok: false; error: string }> {
    try {
        const r = await fetch(`${GRAPH}/${phoneNumberId}/smb_app_data`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: tipo }),
            signal: AbortSignal.timeout(15_000),
        });
        const j: any = await r.json().catch(() => null);
        if (!r.ok) return { ok: false, error: j?.error?.message || `HTTP ${r.status}` };
        return { ok: true, requestId: j?.request_id ? String(j.request_id) : null };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/**
 * Qué se pide. Los contactos (`smb_app_state_sync`) traen la agenda PERSONAL de
 * la dueña y hoy no se procesan (`registrarAppState`): solo con
 * `WA_SYNC_CONTACTOS=true`. Se piden primero porque así los ordena la doc
 * (paso 1 contactos, paso 2 historial); no dependen uno del otro.
 */
export function tiposDeSincronizacion(): TipoSincronizacion[] {
    return process.env.WA_SYNC_CONTACTOS === 'true' ? ['smb_app_state_sync', 'history'] : ['history'];
}

export interface PedidoDeSincronizacion {
    tipo: TipoSincronizacion;
    estado: 'pedido' | 'ya_pedido' | 'fallido';
    requestId?: string | null;
    error?: string;
}

/**
 * Pide el historial (y los contactos, si está la variable) de una integración
 * en Coexistence y lo deja en `whatsapp_account_events`
 * (`field = 'history_sync_request'`, `nuevo_estado` pedido|fallido,
 * `payload.sync_type`, `payload.request_id`, `payload.plazo_hasta`).
 *
 * Idempotente: si ya hay un 'pedido' de ese tipo para la integración, no se
 * vuelve a pedir (Meta deja una sola vez). Un 'fallido' sí se puede reintentar
 * dentro del plazo. Si falla, el alta NO se cae: queda registrado y se avisa a
 * la plataforma, porque el plazo es de 24 h. Nunca lanza.
 */
export async function pedirHistorialDeCoexistencia(p: {
    integrationId: string;
    schoolId: string;
    wabaId: string | null;
    phoneNumberId: string;
    token: string;
    /** ISO del alta: de ahí corren las 24 h. */
    conectadoAt: string;
}): Promise<PedidoDeSincronizacion[]> {
    const plazoHasta = new Date(new Date(p.conectadoAt).getTime() + PLAZO_SINCRONIZACION_MS).toISOString();
    const salida: PedidoDeSincronizacion[] = [];

    for (const tipo of tiposDeSincronizacion()) {
        try {
            // Si no se puede leer, se pide igual: un pedido de más lo rechaza
            // Meta; uno de menos pierde el historial para siempre.
            const { data: previo } = await supabase
                .from('whatsapp_account_events')
                .select('id')
                .eq('integration_id', p.integrationId)
                .eq('field', CAMPO_PEDIDO_HISTORIAL)
                .eq('nuevo_estado', 'pedido')
                .eq('payload->>sync_type', tipo)
                .limit(1);
            if (Array.isArray(previo) && previo.length > 0) {
                salida.push({ tipo, estado: 'ya_pedido' });
                continue;
            }

            const r = await pedirSincronizacion(p.token, p.phoneNumberId, tipo);
            const error = r.ok ? null : r.error.slice(0, 500);
            const requestId = r.ok ? r.requestId : null;
            const { error: eIns } = await supabase.from('whatsapp_account_events').insert({
                integration_id: p.integrationId,
                school_id: p.schoolId,
                field: CAMPO_PEDIDO_HISTORIAL,
                waba_id: p.wabaId,
                phone_number_id: p.phoneNumberId,
                nuevo_estado: r.ok ? 'pedido' : 'fallido',
                motivo: r.ok
                    ? (tipo === 'history' ? 'Historial de conversaciones pedido a Meta' : 'Contactos pedidos a Meta')
                    : error,
                payload: { sync_type: tipo, request_id: requestId, error, plazo_hasta: plazoHasta },
            });
            if (eIns) {
                console.error('[wa-onboarding] no se pudo registrar el pedido de sincronización',
                    { integrationId: p.integrationId, tipo, err: eIns.message });
            }

            if (r.ok) {
                salida.push({ tipo, estado: 'pedido', requestId });
                continue;
            }
            console.error('[wa-onboarding] Meta no aceptó el pedido de sincronización',
                { integrationId: p.integrationId, tipo, error });
            await avisarPlataformaSobreHistorial({
                motivo: 'pedido_fallido', integrationId: p.integrationId, schoolId: p.schoolId,
                phoneNumberId: p.phoneNumberId, tipo, detalle: error ?? 'error desconocido', plazoHasta,
            });
            salida.push({ tipo, estado: 'fallido', error: error ?? undefined });
        } catch (err: any) {
            console.error('[wa-onboarding] pedido de sincronización reventó',
                { integrationId: p.integrationId, tipo, err: err?.message || String(err) });
            salida.push({ tipo, estado: 'fallido', error: err?.message || String(err) });
        }
    }
    return salida;
}

export async function conectarEscuela(
    schoolId: string,
    code: string,
    sesion: DatosDeSesion | null,
    conectadoPor: string,
): Promise<ResultadoAlta> {
    if (!APP_ID || !APP_SECRET) {
        return { ok: false, error: 'configuracion_incompleta',
                 detalle: 'Faltan META_APP_ID o WHATSAPP_APP_SECRET en el servidor.' };
    }

    // 1. ¿La escuela está libre? Se comprueba ANTES de gastar el código, que es
    //    de un solo uso: fallar despues obligaria a la escuela a repetir todo
    //    el dialogo de Meta.
    const { data: yaTiene } = await supabase
        .from('school_whatsapp_integrations')
        .select('id, display_phone_number')
        .eq('school_id', schoolId)
        .maybeSingle();
    if (yaTiene) {
        return { ok: false, error: 'ya_conectada',
                 detalle: `Esta escuela ya tiene ${(yaTiene as any).display_phone_number ?? 'un número'} conectado.` };
    }

    // 2. Canjear.
    const canje = await canjearCodigo(code);
    if ('error' in canje) return { ok: false, error: 'canje_fallido', detalle: canje.error };

    // 3. Resolver contra Graph, no contra lo que dijo el navegador.
    const activos = await resolverActivos(canje.token, sesion);
    if ('error' in activos) return { ok: false, error: 'activos_no_resueltos', detalle: activos.error };

    // 4. Un número no puede atender a dos escuelas: el webhook rutea por
    //    phone_number_id y no sabria a cual entregar.
    const { data: ocupado } = await supabase
        .from('school_whatsapp_integrations')
        .select('school_id')
        .eq('phone_number_id', activos.phoneNumberId)
        .maybeSingle();
    if (ocupado) {
        return { ok: false, error: 'numero_ocupado',
                 detalle: 'Ese número ya está conectado a otra escuela en SportMaps.' };
    }

    // 5. Webhooks. Si esto falla la integracion no sirve de nada, asi que se
    //    corta antes de escribir en vez de dejar un canal mudo.
    if (!(await suscribirWebhooks(canje.token, activos.wabaId))) {
        return { ok: false, error: 'webhooks_fallidos',
                 detalle: 'No se pudo suscribir la app a los webhooks de esa cuenta.' };
    }

    // 6. Cifrar, con round-trip: si el descifrado no devuelve lo mismo, el
    //    token quedaria guardado e inservible.
    const cifrado = encryptToken(canje.token);
    if (decryptToken(cifrado) !== canje.token) {
        return { ok: false, error: 'cifrado_fallido' };
    }

    // ¿Coexistence? El evento de la sesión o, si no llegó, Graph (ver
    // `numeroEnCoexistencia`). Se pregunta antes de escribir, como lo demás.
    const coexistence = sesion?.event === EVENTO_COEXISTENCIA
        || await numeroEnCoexistencia(canje.token, activos.phoneNumberId);

    // 7. Recién ahora se escribe.
    const ahora = new Date().toISOString();
    const { data: creada, error: e1 } = await supabase
        .from('school_whatsapp_integrations')
        .insert({
            school_id: schoolId,
            phone_number_id: activos.phoneNumberId,
            waba_id: activos.wabaId,
            business_id: sesion?.business_id ?? null,
            display_phone_number: activos.display,
            access_token_encrypted: cifrado,
            status: 'active',
            connected_by: conectadoPor,
            connected_at: ahora,
            token_rotated_at: ahora,
        })
        .select('id')
        .single();
    if (e1 || !creada) {
        return { ok: false, error: 'no_se_pudo_guardar', detalle: e1?.message };
    }

    // 8. Coexistence: pedir el historial YA. Meta da 24 h y una sola vez, y el
    //    webhook `history` ya encuentra la integración porque está escrita.
    //    Va antes de los ajustes para que un fallo ahí no lo deje sin pedir. Si
    //    el pedido falla, el alta sigue: queda en whatsapp_account_events y se
    //    avisa a la plataforma (pedirHistorialDeCoexistencia nunca lanza).
    if (coexistence) {
        await pedirHistorialDeCoexistencia({
            integrationId: creada.id,
            schoolId,
            wabaId: activos.wabaId,
            phoneNumberId: activos.phoneNumberId,
            token: canje.token,
            conectadoAt: ahora,
        }).catch(() => []);
    }

    // EL ASISTENTE ARRANCA APAGADO, y esto es deliberado.
    //
    // Conectar el numero y prender el bot son dos decisiones distintas, y hasta
    // hoy eran una sola: la escuela apretaba «conectar» y en ese mismo segundo
    // un bot que nunca habia corrido empezaba a responderle a cientos de
    // familias. Si conecta al final del turno y se va —el caso real de Dynasty,
    // 2026-09-22— eso es una noche entera de respuestas automaticas sin nadie
    // mirando.
    //
    // Ademas hay una razon de calendario: la sincronizacion del historial tiene
    // 24 HORAS de plazo y se larga en el paso 8. Separar las dos cosas deja que
    // el historial corra de noche y que el bot se prenda cuando haya gente
    // despierta.
    //
    // El costo de equivocarse en este sentido es bajo: la escuela sigue
    // contestando a mano, como lo hacia ayer. Al reves, no.
    //
    // `mode` si arranca en 'auto': el modo asistido deja las respuestas como
    // borrador esperando aprobacion, y una escuela que estrena el canal no sabe
    // que tiene que entrar a aprobar.
    const { error: e2 } = await supabase.from('whatsapp_settings').insert({
        integration_id: creada.id,
        mode: 'auto',
        ai_enabled: false,
    });
    if (e2) {
        return { ok: false, error: 'sin_ajustes', detalle: e2.message };
    }

    return {
        ok: true,
        integrationId: creada.id,
        displayPhoneNumber: activos.display,
        coexistence,
    };
}
