/**
 * plataforma-wa — el número comercial de SportMaps como canal de PLATAFORMA.
 *
 * Spec: docs/specs/canal-whatsapp-plataforma.md. Este archivo es el núcleo:
 * el canal (credenciales cifradas en `platform_wa_canal`), las suscripciones
 * de dueñas/admins, el horario silencioso, la reserva idempotente y el envío
 * (texto con botón dentro de la ventana de 24 h, plantilla UTILITY fuera).
 *
 * Los avisos los arma `plataforma-wa-avisos.service` a partir de los eventos
 * que ya existen; los entrantes los atiende `plataforma-wa-entrante.service`.
 *
 * Nada de esto lanza hacia quien llama: el canal de plataforma es un destino
 * MÁS de avisos que ya salieron por push/in-app/correo, y su falla no puede
 * tumbar a los otros.
 *
 * Sin la migración 20261009115335 cada lectura falla con 42P01/PGRST205 y el
 * canal se comporta como «no configurado».
 */

import { supabase } from '../config/supabase';
import { enCortafuegos } from '../config/cortafuegos-simulacion';
import {
    sendCtaUrl, sendTextMessage, sendRawPayload, type WhatsAppIntegration, type SendTextResult,
} from './whatsapp.service';
import { armarPayloadPlantilla, limpiarParametro } from './whatsapp-plantillas.service';

// ─── Flags ───────────────────────────────────────────────────────────────────

/**
 * Interruptor por variable de entorno (compatibilidad): `PLATFORM_WA_ENABLED=true`
 * lo prende siempre. Para decidir si el canal está prendido usar
 * `canalHabilitado()`, que además lee el interruptor de la base.
 */
export function plataformaHabilitada(): boolean {
    return process.env.PLATFORM_WA_ENABLED === 'true';
}

/**
 * F1: avisos y comandos de suscripción. Prendido si la variable lo prende o si
 * el super admin lo prendió en /admin/whatsapp (`platform_wa_canal.habilitado`,
 * migración 20261029190407) con el canal activo. Cache de 1 min (`leerCanal`).
 */
export async function canalHabilitado(): Promise<boolean> {
    if (plataformaHabilitada()) return true;
    const c = await leerCanal();
    return c?.habilitado === true && c.status === 'activo';
}

export function soloDigitos(s: string | null | undefined): string {
    return String(s ?? '').replace(/\D/g, '');
}

/** F2: números con modo pruebas. `PLATFORM_WA_TESTERS=573128463555,57300…`. */
export function testersDePlataforma(valor = process.env.PLATFORM_WA_TESTERS): Set<string> {
    return new Set(String(valor ?? '').split(/[,;]+/).map(soloDigitos).filter((d) => d.length >= 10));
}

/** Celular colombiano → wa_id (57 + 3xxxxxxxxx). null si no lo es. Pura. */
export function celularCo(telefono: string | null | undefined): string | null {
    const d = soloDigitos(telefono);
    if (/^3\d{9}$/.test(d)) return `57${d}`;
    if (/^573\d{9}$/.test(d)) return d;
    return null;
}

export const esFaltaDeEsquema = (code?: string | null) =>
    code === '42703' || code === '42P01' || code === 'PGRST204' || code === 'PGRST205';

// ─── El canal ────────────────────────────────────────────────────────────────

export interface CanalPlataforma {
    phone_number_id: string;
    waba_id: string;
    display_phone_number: string | null;
    access_token_encrypted: string | null;
    status: 'inactivo' | 'activo' | 'suspendido' | string;
    /** Interruptor general desde /admin/whatsapp (sin la migración: undefined = apagado). */
    habilitado?: boolean;
}

const CANAL_TTL_MS = 60_000;
let canalCache: { valor: CanalPlataforma | null; expira: number } | null = null;

/** La fila del canal (cache 1 min). null si no hay migración o no está cargado. */
export async function leerCanal(ahora = Date.now()): Promise<CanalPlataforma | null> {
    if (canalCache && canalCache.expira > ahora) return canalCache.valor;
    let valor: CanalPlataforma | null = null;
    try {
        const { data, error } = await supabase.from('platform_wa_canal')
            .select('phone_number_id, waba_id, display_phone_number, access_token_encrypted, status, habilitado')
            .eq('id', 'sportmaps')
            .maybeSingle();
        if (!error && data) valor = data as CanalPlataforma;
    } catch { /* sin canal */ }
    canalCache = { valor, expira: ahora + CANAL_TTL_MS };
    return valor;
}

export function invalidarCanal(): void {
    canalCache = null;
}

/** ¿Este phone_number_id es el del canal de plataforma? (cualquier estado). */
export async function esNumeroDePlataforma(phoneNumberId: string | null | undefined): Promise<boolean> {
    if (!phoneNumberId) return false;
    const canal = await leerCanal();
    return Boolean(canal && canal.phone_number_id === String(phoneNumberId));
}

/**
 * El canal con la forma de `WhatsAppIntegration`, para reusar los envíos de
 * whatsapp.service. `school_id` vacío A PROPÓSITO: este objeto solo se pasa a
 * funciones de envío, nunca a las que consultan por escuela.
 */
export function integracionDePlataforma(canal: CanalPlataforma): WhatsAppIntegration {
    return {
        id: 'plataforma',
        school_id: '',
        phone_number_id: canal.phone_number_id,
        waba_id: canal.waba_id,
        display_phone_number: canal.display_phone_number,
        access_token_encrypted: canal.access_token_encrypted,
        verify_token: null,
        status: canal.status === 'activo' ? 'active' : String(canal.status),
    };
}

/** Número del canal para los enlaces wa.me (cae al comercial oficial). */
export function numeroDelCanal(canal: CanalPlataforma | null): string {
    return soloDigitos(canal?.display_phone_number) || soloDigitos(process.env.SALES_WHATSAPP) || '573202683539';
}

// ─── Horario ─────────────────────────────────────────────────────────────────

/** Hora 0-23 en Colombia (UTC-5 fijo). Pura. */
export function horaColombia(ahora: number): number {
    return (new Date(ahora).getUTCHours() + 19) % 24;
}

/** ¿`hora` cae en el silencio [desde, hasta)? Cruza la medianoche si desde > hasta. Pura. */
export function enSilencio(hora: number, desde: number, hasta: number): boolean {
    if (desde === hasta) return false;
    return desde > hasta ? (hora >= desde || hora < hasta) : (hora >= desde && hora < hasta);
}

// ─── Suscripciones ───────────────────────────────────────────────────────────

export type TipoAviso = 'comprobantes' | 'escalacion' | 'retiro' | 'cortesia' | 'resumen_diario' | 'informe_cartera';

export const PREFERENCIA_DE_TIPO: Record<TipoAviso, keyof Suscripcion> = {
    comprobantes: 'avisar_comprobantes',
    escalacion: 'avisar_escalaciones',
    retiro: 'avisar_retiros',
    cortesia: 'avisar_cortesias',
    resumen_diario: 'avisar_resumen_diario',
    informe_cartera: 'avisar_informe_cartera',
};

export const COLUMNAS_PREFERENCIAS = [
    'avisar_comprobantes', 'avisar_escalaciones', 'avisar_retiros', 'avisar_cortesias',
    'avisar_resumen_diario', 'avisar_informe_cartera',
] as const;

export interface Suscripcion {
    id: string;
    school_id: string;
    profile_id: string;
    contact_wa_id: string;
    estado: 'pendiente' | 'activa' | 'revocada';
    origen: 'app' | 'whatsapp';
    codigo: string | null;
    codigo_expira_at: string | null;
    activada_at: string | null;
    avisar_comprobantes: boolean;
    avisar_escalaciones: boolean;
    avisar_retiros: boolean;
    avisar_cortesias: boolean;
    avisar_resumen_diario: boolean;
    avisar_informe_cartera: boolean;
    silencio_desde: number;
    silencio_hasta: number;
    urgentes_en_silencio: boolean;
}

export const COLUMNAS_SUSCRIPCION = 'id, school_id, profile_id, contact_wa_id, estado, origen, codigo, codigo_expira_at, activada_at, '
    + 'avisar_comprobantes, avisar_escalaciones, avisar_retiros, avisar_cortesias, avisar_resumen_diario, avisar_informe_cartera, '
    + 'silencio_desde, silencio_hasta, urgentes_en_silencio';

/** owner + owner/admin/school_admin activos. */
export async function adminsDeEscuela(schoolId: string): Promise<Set<string>> {
    const [{ data: escuela }, { data: miembros }] = await Promise.all([
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('profile_id')
            .eq('school_id', schoolId).eq('status', 'active')
            .in('role', ['owner', 'admin', 'school_admin']),
    ]);
    const ids = new Set<string>();
    if ((escuela as any)?.owner_id) ids.add((escuela as any).owner_id);
    for (const m of (miembros ?? []) as any[]) if (m.profile_id) ids.add(m.profile_id);
    return ids;
}

export async function escuelaHabilitada(schoolId: string): Promise<boolean> {
    const { data, error } = await supabase.from('platform_wa_escuelas')
        .select('habilitado').eq('school_id', schoolId).maybeSingle();
    return !error && (data as any)?.habilitado === true;
}

export async function nombreDeEscuela(schoolId: string): Promise<string> {
    const { data } = await supabase.from('schools').select('name').eq('id', schoolId).maybeSingle();
    return String((data as any)?.name ?? 'tu escuela');
}

// ─── Mensajes del canal ──────────────────────────────────────────────────────

export const VENTANA_MS = 24 * 3600_000;

/** ¿El número escribió al canal en las últimas 24 h? */
export async function ventanaAbiertaCon(contactWaId: string, ahora = Date.now()): Promise<boolean> {
    const { data, error } = await supabase.from('platform_wa_mensajes')
        .select('created_at')
        .eq('contact_wa_id', contactWaId)
        .eq('direccion', 'entrante')
        .gte('created_at', new Date(ahora - VENTANA_MS).toISOString())
        .limit(1);
    return !error && ((data ?? []) as any[]).length > 0;
}

export type ClaseDeContacto = 'suscriptor' | 'tester' | 'desconocido';

/** Guarda un mensaje del canal. Devuelve false si ya estaba (reintento de Meta). Nunca lanza. */
export async function registrarMensaje(m: {
    waMessageId: string; direccion: 'entrante' | 'saliente'; contactWaId: string; clase: ClaseDeContacto;
    tipo: string; texto?: string | null; paso?: string | null;
}): Promise<boolean> {
    try {
        const { error } = await supabase.from('platform_wa_mensajes').insert({
            wa_message_id: m.waMessageId,
            direccion: m.direccion,
            contact_wa_id: m.contactWaId,
            clase: m.clase,
            tipo: m.tipo,
            // De un desconocido no se guarda el texto (spec D12; CHECK en la tabla).
            texto: m.clase === 'desconocido' ? null : (m.texto ?? null),
            paso: m.paso ?? null,
        });
        if (error) return (error as any).code !== '23505' ? true : false;
        return true;
    } catch {
        return true;
    }
}

/**
 * Texto (con botón URL si se puede) desde el canal. Solo dentro de la
 * ventana de 24 h. Registra el saliente. No lanza.
 */
export async function enviarTextoPlataforma(
    canal: CanalPlataforma,
    to: string,
    texto: string,
    o: { enlace?: { url: string; texto: string } | null; clase: ClaseDeContacto; paso: string },
): Promise<SendTextResult> {
    const integ = integracionDePlataforma(canal);
    let r: SendTextResult = { ok: false, error: 'sin_intento' };
    if (o.enlace) {
        r = await sendCtaUrl(integ, to, texto, o.enlace.texto, o.enlace.url);
        // No cupo como botón (cuerpo largo): el enlace va en el texto.
        if (!r.ok && r.error === 'no_cabe_como_cta_url') {
            r = await sendTextMessage(integ, to, `${texto}\n\n${o.enlace.texto}: ${o.enlace.url}`.slice(0, 4096));
        }
    } else {
        r = await sendTextMessage(integ, to, texto.slice(0, 4096));
    }
    if (r.ok) {
        await registrarMensaje({
            waMessageId: r.waMessageId || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            direccion: 'saliente', contactWaId: to, clase: o.clase, tipo: o.enlace ? 'interactive' : 'text',
            texto, paso: o.paso,
        });
    }
    return r;
}

/** Plantilla aprobada en la WABA de SportMaps. No lanza. */
export async function enviarPlantillaPlataforma(
    canal: CanalPlataforma,
    to: string,
    p: { nombre: string; variables: string[]; sufijoUrl: string | null; paso: string },
): Promise<SendTextResult> {
    const variables = p.variables.map((v) => limpiarParametro(String(v ?? '')).slice(0, 900));
    if (variables.some((v) => !v)) return { ok: false, error: 'dato_faltante' };
    const payload = armarPayloadPlantilla({
        toWaId: to, plantilla: p.nombre, idioma: 'es_CO', variables, tokenBoton: p.sufijoUrl,
    });
    const r = await sendRawPayload(integracionDePlataforma(canal), payload);
    if (r.ok) {
        await registrarMensaje({
            waMessageId: r.waMessageId || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            direccion: 'saliente', contactWaId: to, clase: 'suscriptor', tipo: 'template',
            texto: `[${p.nombre}] ${variables.join(' | ')}`, paso: p.paso,
        });
    }
    return r;
}

// ─── Avisar ──────────────────────────────────────────────────────────────────

export interface AvisoPlataforma {
    tipo: TipoAviso;
    schoolId: string;
    /** Clave determinística del EVENTO (la misma para los tres BFF). */
    clave: string;
    urgente?: boolean;
    /** Cuerpo del texto libre (ventana abierta). Sin el enlace: va en el botón. */
    texto: string;
    /** Ruta de la app, con `/` inicial: '/whatsapp?tab=cortesias'. */
    ruta: string;
    /** Fuera de la ventana. Variables sin saltos de línea. */
    plantilla: { nombre: string; variables: string[] };
}

export type MotivoOmision =
    | 'apagado' | 'simulacion' | 'sin_canal' | 'escuela_no_habilitada' | 'sin_suscripciones';

export interface ResultadoAviso {
    enviados: number;
    fallidos: number;
    duplicados: number;
    silencio: number;
    sinPermiso: number;
    omitido?: MotivoOmision;
}

export function urlDeLaApp(ruta: string): string {
    const base = (process.env.FRONTEND_URL || 'https://app.sportmaps.co').replace(/\/$/, '');
    return `${base}${ruta.startsWith('/') ? '' : '/'}${ruta}`;
}

/** El sufijo del botón URL de la plantilla (la base https://app.sportmaps.co/ es parte de lo aprobado). */
export function sufijoDeRuta(ruta: string): string {
    return ruta.replace(/^\/+/, '');
}

/** ¿Este aviso sale ahora para esta suscripción? Pura. */
export function debeSalir(s: Pick<Suscripcion, 'silencio_desde' | 'silencio_hasta' | 'urgentes_en_silencio'>,
    urgente: boolean, ahora: number): boolean {
    if (!enSilencio(horaColombia(ahora), s.silencio_desde, s.silencio_hasta)) return true;
    return urgente && s.urgentes_en_silencio;
}

export interface DepsAviso {
    leerCanal: typeof leerCanal;
    escuelaHabilitada: typeof escuelaHabilitada;
    adminsDeEscuela: typeof adminsDeEscuela;
    ventanaAbiertaCon: typeof ventanaAbiertaCon;
    enviarTexto: typeof enviarTextoPlataforma;
    enviarPlantilla: typeof enviarPlantillaPlataforma;
}

const DEPS: DepsAviso = {
    leerCanal, escuelaHabilitada, adminsDeEscuela, ventanaAbiertaCon,
    enviarTexto: enviarTextoPlataforma, enviarPlantilla: enviarPlantillaPlataforma,
};

/**
 * Manda el aviso a cada dueña/admin de la escuela con suscripción activa y la
 * preferencia del tipo. Idempotente entre BFF por `platform_wa_envios`
 * (UNIQUE suscripcion_id + clave). Nunca lanza.
 */
export async function avisarPorPlataforma(
    a: AvisoPlataforma,
    ahora = Date.now(),
    deps: Partial<DepsAviso> = {},
): Promise<ResultadoAviso> {
    const d = { ...DEPS, ...deps };
    const r: ResultadoAviso = { enviados: 0, fallidos: 0, duplicados: 0, silencio: 0, sinPermiso: 0 };
    try {
        if (!(await canalHabilitado())) return { ...r, omitido: 'apagado' };
        if (enCortafuegos()) return { ...r, omitido: 'simulacion' };
        const canal = await d.leerCanal();
        if (!canal || canal.status !== 'activo' || !canal.access_token_encrypted) return { ...r, omitido: 'sin_canal' };
        if (!(await d.escuelaHabilitada(a.schoolId))) return { ...r, omitido: 'escuela_no_habilitada' };

        const columna = PREFERENCIA_DE_TIPO[a.tipo];
        const { data: subs, error } = await supabase.from('platform_wa_suscripciones')
            .select(COLUMNAS_SUSCRIPCION)
            .eq('school_id', a.schoolId)
            .eq('estado', 'activa')
            .eq(columna as string, true);
        if (error || !subs?.length) return { ...r, omitido: 'sin_suscripciones' };

        const admins = await d.adminsDeEscuela(a.schoolId);
        for (const s of subs as unknown as Suscripcion[]) {
            // D5: dejar de ser admin corta los avisos sin tocar esta tabla.
            if (!admins.has(s.profile_id)) { r.sinPermiso++; continue; }
            // D6: en silencio no se reserva; lo de la noche lo recoge el resumen.
            if (!debeSalir(s, Boolean(a.urgente), ahora)) { r.silencio++; continue; }

            // D7: reserva. El que logra el INSERT envía.
            const { data: reserva, error: errReserva } = await supabase.from('platform_wa_envios')
                .insert({ suscripcion_id: s.id, school_id: a.schoolId, tipo: a.tipo, clave: a.clave.slice(0, 300) })
                .select('id')
                .single();
            if (errReserva || !reserva) {
                if ((errReserva as any)?.code === '23505') r.duplicados++;
                else console.warn('[plataforma-wa] no se pudo reservar', { clave: a.clave, err: errReserva?.message });
                continue;
            }

            const ventana = await d.ventanaAbiertaCon(s.contact_wa_id, ahora);
            const envio = ventana
                ? await d.enviarTexto(canal, s.contact_wa_id, a.texto, {
                    enlace: { url: urlDeLaApp(a.ruta), texto: 'Ver en la app' }, clase: 'suscriptor', paso: `aviso_${a.tipo}`,
                })
                : await d.enviarPlantilla(canal, s.contact_wa_id, {
                    nombre: a.plantilla.nombre, variables: a.plantilla.variables, sufijoUrl: sufijoDeRuta(a.ruta),
                    paso: `aviso_${a.tipo}`,
                });

            await supabase.from('platform_wa_envios').update({
                estado: envio.ok ? 'enviado' : 'fallido',
                via: ventana ? 'texto' : 'plantilla',
                plantilla: ventana ? null : a.plantilla.nombre,
                wa_message_id: envio.waMessageId ?? null,
                detalle: envio.ok ? null : String(envio.error ?? 'error').slice(0, 500),
            }).eq('id', (reserva as any).id);

            if (envio.ok) r.enviados++;
            else {
                r.fallidos++;
                console.warn('[plataforma-wa] el aviso no salió', { tipo: a.tipo, schoolId: a.schoolId, via: ventana ? 'texto' : 'plantilla', err: envio.error });
            }
        }
    } catch (e: any) {
        console.warn('[plataforma-wa] avisar falló', { tipo: a.tipo, schoolId: a.schoolId, err: e?.message || String(e) });
    }
    return r;
}

/** Estado de entrega de un saliente del canal (webhook `statuses`). Nunca lanza. */
export async function guardarEstadoPlataforma(
    waMessageId: string, status: string, timestamp: string | null, error: string | null,
): Promise<void> {
    try {
        await supabase.from('platform_wa_mensajes')
            .update({ status: error ? `${status}: ${error}`.slice(0, 300) : status, status_at: timestamp })
            .eq('wa_message_id', waMessageId);
    } catch { /* un estado perdido no importa */ }
}

/** Para los ganchos: dispara y se olvida, sin dejar promesas rechazadas. */
export function avisarEnSegundoPlano(a: AvisoPlataforma): void {
    // `avisarPorPlataforma` revisa el interruptor (variable o base) antes de mandar.
    void avisarPorPlataforma(a).catch(() => undefined);
}
