/**
 * plataforma-wa-admin — el canal de WhatsApp de SportMaps manejado desde la
 * pantalla del super admin (/admin/whatsapp, 2026-10-29).
 *
 * Reemplaza al script `scripts/wa-plataforma.ts` para operar el canal sin
 * acceso al código: conectar el número con el diálogo de Meta (Embedded
 * Signup, el mismo de las escuelas), ver su estado en Meta, registrar las
 * plantillas `sm_*`, habilitar escuelas, ver quién se suscribió y prender o
 * apagar todo. Spec del canal: docs/specs/canal-whatsapp-plataforma.md.
 *
 * Reglas:
 *  - Solo lo llama una ruta detrás de `requirePlatformAdmin`.
 *  - El token del número nunca sale de acá: se canjea el `code` del diálogo,
 *    se valida contra Graph y se guarda cifrado. Nada lo devuelve.
 *  - Cada cambio queda en `platform_wa_auditoria` con quién lo hizo.
 *  - Los teléfonos de los suscriptores se muestran enmascarados.
 */
import fs from 'fs';
import path from 'path';
import { supabase } from '../config/supabase';
import { encryptToken, decryptToken, sendTextMessage } from './whatsapp.service';
import { canjearCodigo, resolverActivos, suscribirWebhooks, type DatosDeSesion } from './whatsapp-onboarding.service';
import {
    leerCanal, invalidarCanal, integracionDePlataforma, plataformaHabilitada, soloDigitos,
} from './plataforma-wa.service';

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`;
const DIR_PLANTILLAS = path.join(__dirname, '..', '..', 'whatsapp-templates', 'plataforma');
export const NUMERO_COMERCIAL = '573202683539';

export type AccionAuditoria =
    | 'conectar' | 'desconectar' | 'habilitar_canal' | 'deshabilitar_canal'
    | 'habilitar_escuela' | 'deshabilitar_escuela' | 'registrar_plantillas' | 'enviar_prueba';

async function auditar(actorId: string, accion: AccionAuditoria, detalle: Record<string, unknown> = {}): Promise<void> {
    try {
        await supabase.from('platform_wa_auditoria').insert({ actor_id: actorId, accion, detalle });
    } catch { /* la auditoría no tumba la acción */ }
}

/** «573001234567» → «…4567». Pura. */
export function enmascarar(numero: string | null | undefined): string {
    const d = soloDigitos(numero);
    return d ? `…${d.slice(-4)}` : '—';
}

/** Las plantillas `sm_*` del repo (las que el canal debería tener en Meta). */
export function plantillasDelRepo(): { nombre: string; categoria: string; cuerpo: string; json: any }[] {
    try {
        return fs.readdirSync(DIR_PLANTILLAS).filter((f) => f.endsWith('.json')).sort().map((f) => {
            const json = JSON.parse(fs.readFileSync(path.join(DIR_PLANTILLAS, f), 'utf8'));
            const cuerpo = (json.components ?? []).find((x: any) => x.type === 'BODY')?.text ?? '';
            return { nombre: String(json.name), categoria: String(json.category ?? ''), cuerpo, json };
        });
    } catch {
        return [];
    }
}

async function graph(ruta: string, token: string, init: RequestInit = {}): Promise<any> {
    try {
        const r = await fetch(`${GRAPH}/${ruta}`, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        });
        return await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    } catch (e: any) {
        return { error: { message: e?.message || 'Graph no respondió' } };
    }
}

// ─── Estado ──────────────────────────────────────────────────────────────────

export interface EstadoCanal {
    conectado: boolean;
    canal: null | {
        numero: string | null;
        esElComercial: boolean;
        status: string;
        habilitado: boolean;
        porVariable: boolean;
        conectadoAt: string | null;
    };
    meta: null | {
        nombreVerificado: string | null;
        estadoNombre: string | null;
        calidad: string | null;
        enAppBusiness: boolean | null;
        error: string | null;
    };
    plantillas: { nombre: string; categoria: string; cuerpo: string; estadoMeta: string | null; categoriaMeta: string | null; rechazo: string | null }[];
    escuelas: { schoolId: string; nombre: string; habilitado: boolean; suscriptoresActivos: number }[];
    suscriptores: { id: string; escuela: string; numero: string; estado: string; activadaAt: string | null }[];
    auditoria: { accion: string; actor: string | null; detalle: Record<string, unknown>; at: string }[];
}

export async function estadoDelCanal(): Promise<EstadoCanal> {
    invalidarCanal();
    const { data: fila } = await supabase.from('platform_wa_canal')
        .select('phone_number_id, waba_id, display_phone_number, access_token_encrypted, status, habilitado, conectado_at')
        .eq('id', 'sportmaps').maybeSingle();
    const c = fila as any;
    const repo = plantillasDelRepo();

    let meta: EstadoCanal['meta'] = null;
    const deMeta = new Map<string, any>();
    if (c?.access_token_encrypted) {
        let token = '';
        try { token = decryptToken(c.access_token_encrypted); } catch { /* token ilegible */ }
        if (token) {
            const [n, t] = await Promise.all([
                graph(`${c.phone_number_id}?fields=verified_name,name_status,quality_rating,is_on_biz_app`, token),
                graph(`${c.waba_id}/message_templates?fields=name,status,category,rejected_reason&limit=200`, token),
            ]);
            meta = {
                nombreVerificado: n?.verified_name ?? null,
                estadoNombre: n?.name_status ?? null,
                calidad: n?.quality_rating ?? null,
                enAppBusiness: typeof n?.is_on_biz_app === 'boolean' ? n.is_on_biz_app : null,
                error: n?.error?.message ?? t?.error?.message ?? null,
            };
            for (const x of t?.data ?? []) deMeta.set(String(x.name), x);
        } else {
            meta = { nombreVerificado: null, estadoNombre: null, calidad: null, enAppBusiness: null, error: 'No se pudo descifrar el token guardado' };
        }
    }

    const [{ data: escuelasRaw }, { data: subsRaw }, { data: audRaw }] = await Promise.all([
        supabase.from('platform_wa_escuelas').select('school_id, habilitado, schools(name)').order('updated_at', { ascending: false }).limit(200),
        supabase.from('platform_wa_suscripciones')
            .select('id, school_id, contact_wa_id, estado, activada_at, schools(name)')
            .neq('estado', 'revocada').order('created_at', { ascending: false }).limit(200),
        supabase.from('platform_wa_auditoria')
            .select('accion, detalle, created_at, actor:profiles(full_name)')
            .order('created_at', { ascending: false }).limit(30),
    ]);
    const subs = (subsRaw as any[]) ?? [];
    const activasPorEscuela = new Map<string, number>();
    for (const s of subs) if (s.estado === 'activa') activasPorEscuela.set(s.school_id, (activasPorEscuela.get(s.school_id) ?? 0) + 1);

    return {
        conectado: Boolean(c?.access_token_encrypted && c?.status === 'activo'),
        canal: c ? {
            numero: c.display_phone_number ?? null,
            esElComercial: soloDigitos(c.display_phone_number) === NUMERO_COMERCIAL,
            status: c.status,
            habilitado: c.habilitado === true,
            porVariable: plataformaHabilitada(),
            conectadoAt: c.conectado_at ?? null,
        } : null,
        meta,
        plantillas: repo.map((p) => {
            const m = deMeta.get(p.nombre);
            return {
                nombre: p.nombre, categoria: p.categoria, cuerpo: p.cuerpo,
                estadoMeta: m?.status ?? null, categoriaMeta: m?.category ?? null, rechazo: m?.rejected_reason ?? null,
            };
        }),
        escuelas: ((escuelasRaw as any[]) ?? []).map((e) => ({
            schoolId: e.school_id, nombre: e.schools?.name ?? e.school_id, habilitado: e.habilitado === true,
            suscriptoresActivos: activasPorEscuela.get(e.school_id) ?? 0,
        })),
        suscriptores: subs.map((s) => ({
            id: s.id, escuela: s.schools?.name ?? s.school_id, numero: enmascarar(s.contact_wa_id),
            estado: s.estado, activadaAt: s.activada_at ?? null,
        })),
        auditoria: ((audRaw as any[]) ?? []).map((a) => ({
            accion: a.accion, actor: a.actor?.full_name ?? null, detalle: a.detalle ?? {}, at: a.created_at,
        })),
    };
}

// ─── Conectar / desconectar ──────────────────────────────────────────────────

export type ResultadoConectar =
    | { ok: true; numero: string | null; esElComercial: boolean; webhooksSuscritos: boolean }
    | { ok: false; error: string };

/**
 * Cierra el diálogo de Meta: canjea el `code` (un solo uso), valida contra Graph
 * qué número alcanza el token y guarda el canal con el token cifrado. Queda
 * `status=activo` pero el interruptor general APAGADO: prenderlo es otro paso.
 */
export async function conectarCanal(code: string, sesion: DatosDeSesion | null, actorId: string): Promise<ResultadoConectar> {
    const canje = await canjearCodigo(code);
    if ('error' in canje) return { ok: false, error: canje.error };
    return conectarCanalConToken(canje.token, sesion, actorId);
}

/**
 * Lo mismo que `conectarCanal` pero con el token ya en la mano (usuario del sistema de Meta Business), sin pasar
 * por el asistente de registro de Meta. Valida con Graph que el token alcanza la cuenta y el número, suscribe los
 * webhooks y guarda el token CIFRADO. Lo usa `scripts/wa-conectar-canal.ts` (el token sale de una variable de
 * entorno, nunca del chat ni de un archivo). Nunca imprime el token.
 */
export async function conectarCanalConToken(token: string, sesion: DatosDeSesion | null, actorId: string): Promise<ResultadoConectar> {
    const activos = await resolverActivos(token, sesion);
    if ('error' in activos) return { ok: false, error: activos.error };

    const cifrado = encryptToken(token);
    if (decryptToken(cifrado) !== token) return { ok: false, error: 'No se pudo cifrar el token' };

    const webhooksSuscritos = await suscribirWebhooks(token, activos.wabaId);
    const numero = soloDigitos(activos.display) || null;
    const ahora = new Date().toISOString();
    const { error } = await supabase.from('platform_wa_canal').upsert({
        id: 'sportmaps', phone_number_id: activos.phoneNumberId, waba_id: activos.wabaId,
        display_phone_number: numero, access_token_encrypted: cifrado, status: 'activo',
        conectado_at: ahora, token_rotated_at: ahora, updated_at: ahora,
    }, { onConflict: 'id' });
    if (error) return { ok: false, error: `No se pudo guardar el canal: ${error.message}` };
    invalidarCanal();
    await auditar(actorId, 'conectar', { numero: enmascarar(numero), webhooks_suscritos: webhooksSuscritos });
    return { ok: true, numero, esElComercial: numero === NUMERO_COMERCIAL, webhooksSuscritos };
}

/** Apaga y borra el token. El número queda registrado (para reconectar). */
export async function desconectarCanal(actorId: string): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabase.from('platform_wa_canal')
        .update({ status: 'inactivo', habilitado: false, access_token_encrypted: null, updated_at: new Date().toISOString() })
        .eq('id', 'sportmaps');
    if (error) return { ok: false, error: error.message };
    invalidarCanal();
    await auditar(actorId, 'desconectar');
    return { ok: true };
}

// ─── Interruptores ───────────────────────────────────────────────────────────

export async function cambiarInterruptor(habilitado: boolean, actorId: string): Promise<{ ok: boolean; error?: string }> {
    const c = await leerCanal();
    if (habilitado && (!c || c.status !== 'activo' || !c.access_token_encrypted)) {
        return { ok: false, error: 'Primero conecta el número.' };
    }
    const { error } = await supabase.from('platform_wa_canal')
        .update({ habilitado, updated_at: new Date().toISOString() }).eq('id', 'sportmaps');
    if (error) return { ok: false, error: error.message };
    invalidarCanal();
    await auditar(actorId, habilitado ? 'habilitar_canal' : 'deshabilitar_canal');
    return { ok: true };
}

export async function cambiarEscuela(schoolId: string, habilitado: boolean, actorId: string): Promise<{ ok: boolean; error?: string }> {
    const { data: escuela } = await supabase.from('schools').select('id, name').eq('id', schoolId).maybeSingle();
    if (!escuela) return { ok: false, error: 'No existe esa escuela.' };
    const { error } = await supabase.from('platform_wa_escuelas').upsert(
        { school_id: schoolId, habilitado, actualizado_por: actorId, updated_at: new Date().toISOString() },
        { onConflict: 'school_id' },
    );
    if (error) return { ok: false, error: error.message };
    await auditar(actorId, habilitado ? 'habilitar_escuela' : 'deshabilitar_escuela', { school_id: schoolId, escuela: (escuela as any).name });
    return { ok: true };
}

/** Escuelas por nombre, para el buscador de «habilitar escuela». */
export async function buscarEscuelas(q: string): Promise<{ id: string; nombre: string }[]> {
    const t = q.trim().replace(/[%_,()]/g, ' ').slice(0, 60);
    if (t.length < 2) return [];
    const { data } = await supabase.from('schools').select('id, name').ilike('name', `%${t}%`).order('name').limit(10);
    return ((data as any[]) ?? []).map((s) => ({ id: s.id, nombre: s.name }));
}

// ─── Plantillas ──────────────────────────────────────────────────────────────

/** Manda a Meta las plantillas del repo que la WABA todavía no tiene. */
export async function registrarPlantillasFaltantes(actorId: string): Promise<{ ok: boolean; error?: string; resultados: { nombre: string; ok: boolean; detalle: string }[] }> {
    const c = await leerCanal();
    if (!c?.access_token_encrypted) return { ok: false, error: 'Primero conecta el número.', resultados: [] };
    const token = decryptToken(c.access_token_encrypted);
    const existentes = await graph(`${c.waba_id}/message_templates?fields=name&limit=200`, token);
    if (existentes?.error) return { ok: false, error: existentes.error.message, resultados: [] };
    const ya = new Set(((existentes.data ?? []) as any[]).map((x) => String(x.name)));
    const resultados: { nombre: string; ok: boolean; detalle: string }[] = [];
    for (const p of plantillasDelRepo()) {
        if (ya.has(p.nombre)) continue;
        const j = await graph(`${c.waba_id}/message_templates`, token, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.json),
        });
        resultados.push(j?.error
            ? { nombre: p.nombre, ok: false, detalle: j.error.error_user_msg || j.error.message }
            : { nombre: p.nombre, ok: true, detalle: `${j.status ?? 'PENDING'} · ${j.category ?? p.categoria}` });
    }
    await auditar(actorId, 'registrar_plantillas', { resultados });
    return { ok: true, resultados };
}

// ─── Prueba ──────────────────────────────────────────────────────────────────

/**
 * Texto de prueba desde el número de SportMaps. Es texto libre: solo llega si
 * ese número le escribió al de SportMaps en las últimas 24 h (regla de Meta).
 */
export async function enviarPrueba(numero: string, actorId: string): Promise<{ ok: boolean; error?: string }> {
    const d = soloDigitos(numero);
    const wa = /^3\d{9}$/.test(d) ? `57${d}` : /^573\d{9}$/.test(d) ? d : null;
    if (!wa) return { ok: false, error: 'Escribe un celular colombiano (10 dígitos).' };
    const c = await leerCanal();
    if (!c?.access_token_encrypted || c.status !== 'activo') return { ok: false, error: 'Primero conecta el número.' };
    const r = await sendTextMessage(integracionDePlataforma(c), wa,
        'Prueba del canal de WhatsApp de SportMaps ✅ Si te llegó, el número está conectado.');
    await auditar(actorId, 'enviar_prueba', { numero: enmascarar(wa), ok: r.ok, error: r.ok ? null : r.error ?? null });
    if (!r.ok) {
        const ventana = /re-?engagement|24 ?h|131047/i.test(String(r.error ?? ''));
        return { ok: false, error: ventana
            ? 'Ese número no le ha escrito al de SportMaps en las últimas 24 h. Escríbele «hola» primero y vuelve a probar.'
            : (r.error ?? 'Meta rechazó el mensaje.') };
    }
    return { ok: true };
}
