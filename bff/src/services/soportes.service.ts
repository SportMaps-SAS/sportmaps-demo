/**
 * soportes.service — soportes obligatorios del deportista (spec
 * docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6b, F6, D11/D12).
 *
 * Los «soportes» son los 7 documentos del formulario de afiliación de Monster (athlete_photo,
 * eps_certificate, guardian_id_front, athlete_id_front, guardian_signature, athlete_signature,
 * good_standing_certificate) de `athlete_documents` / bucket `identity-documents`. Solo las escuelas con
 * `school_settings.require_athlete_documents = true` (hoy Monster) tienen algo que exigir: apagado, todo
 * este módulo responde `activo: false` y no bloquea nada.
 *
 * Dónde está el cálculo: en la base (migración 20261106160003). Este servicio es el contrato del BFF:
 *   · lecturas de la administración con el JWT del USUARIO (el candado de alcance vive en la RPC: coach u
 *     otra escuela => 42501 => 403);
 *   · lectura interna con service role (job de recordatorios y bot de WhatsApp);
 *   · `guardarSoporte()`: guarda un archivo y su fila (la usan la ruta de subida y el bot).
 *
 * Lo puro (faltantes, firma del archivo, ruta, tope de recordatorios, agrupar avisos) va arriba y está
 * probado en soportes.service.test.ts.
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/supabase';

// ─── Catálogo ────────────────────────────────────────────────────────────────

export const TIPOS_SOPORTE = [
    'athlete_photo', 'eps_certificate', 'guardian_id_front', 'guardian_id_back',
    'athlete_id_front', 'athlete_id_back', 'guardian_signature', 'athlete_signature',
    'good_standing_certificate', 'other',
] as const;
export type TipoSoporte = typeof TIPOS_SOPORTE[number];

/** Los 7 de Monster (el orden es el del formulario). */
export const SOPORTES_MONSTER: TipoSoporte[] = [
    'athlete_photo', 'eps_certificate', 'guardian_id_front', 'athlete_id_front',
    'guardian_signature', 'athlete_signature', 'good_standing_certificate',
];

export const ETIQUETAS_SOPORTE: Record<TipoSoporte, string> = {
    athlete_photo: 'Foto del deportista',
    eps_certificate: 'Certificado de la EPS',
    guardian_id_front: 'Documento del acudiente (frente)',
    guardian_id_back: 'Documento del acudiente (reverso)',
    athlete_id_front: 'Documento del deportista (frente)',
    athlete_id_back: 'Documento del deportista (reverso)',
    guardian_signature: 'Firma del acudiente',
    athlete_signature: 'Firma del deportista',
    good_standing_certificate: 'Paz y salvo',
    other: 'Otro documento',
};

/** Fotos y firmas: solo imagen (igual que `soloImagen` del frontend). */
const SOLO_IMAGEN = new Set<string>(['athlete_photo', 'guardian_signature', 'athlete_signature']);

export type TipoSujeto = 'child' | 'profile' | 'unregistered';
export const TIPOS_SUJETO: TipoSujeto[] = ['child', 'profile', 'unregistered'];
export interface Sujeto { tipo: TipoSujeto; id: string }

/** Prefijo con que el frontend nombra el archivo (`{tipo}-{fecha}-{nombre}`). */
const PREFIJO_ARCHIVO = (tipo: string) => `${tipo}-`;

export const MAX_BYTES_SOPORTE = 4 * 1024 * 1024; // el body JSON del BFF topa en 5 MB (base64 ≈ 3,7 MB reales)
export const MIMES_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MIMES_SOPORTE = [...MIMES_IMAGEN, 'application/pdf'] as const;
const BUCKET = 'identity-documents';

export const AVISO_CADA_DIAS = 4;
export const AVISO_MAXIMO = 6;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
export const esTipoSoporte = (s: unknown): s is TipoSoporte => typeof s === 'string' && (TIPOS_SOPORTE as readonly string[]).includes(s);
export const esTipoSujeto = (s: unknown): s is TipoSujeto => typeof s === 'string' && (TIPOS_SUJETO as string[]).includes(s);

// ─── Lo puro ─────────────────────────────────────────────────────────────────

/** Qué tipos de `requeridos` no están en `presentes`, en el orden de `requeridos`. Espejo del cálculo SQL. */
export function calcularFaltantes(requeridos: readonly string[], presentes: readonly string[]): string[] {
    const tiene = new Set(presentes);
    const vistos = new Set<string>();
    const faltan: string[] = [];
    for (const t of requeridos) {
        if (vistos.has(t)) continue;
        vistos.add(t);
        if (!tiene.has(t)) faltan.push(t);
    }
    return faltan;
}

export interface VerificacionSujeto { activo: boolean; completo: boolean; requeridos: string[]; faltan: string[] }

/** ¿Se bloquea la acción (confirmar inscripción, convocar a torneo)? Flag apagado nunca bloquea. */
export function debeBloquear(v: Pick<VerificacionSujeto, 'activo' | 'faltan'>): boolean {
    return v.activo === true && v.faltan.length > 0;
}

export function mensajeFaltantes(faltan: readonly string[]): string {
    const nombres = faltan.map((t) => ETIQUETAS_SOPORTE[t as TipoSoporte] ?? t);
    return `Faltan ${faltan.length} soporte(s): ${nombres.join(', ')}.`;
}

/** Firma real del archivo (no se confía en el Content-Type que declara el cliente). */
export function mimeDeFirma(buf: Buffer): (typeof MIMES_SOPORTE)[number] | null {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    return null;
}

export type ValidacionArchivo = { ok: true; mime: (typeof MIMES_SOPORTE)[number]; ext: string } | { ok: false; error: string };

export function validarArchivoSoporte(tipo: string, buffer: Buffer): ValidacionArchivo {
    if (!esTipoSoporte(tipo)) return { ok: false, error: 'tipo_invalido' };
    if (buffer.length === 0) return { ok: false, error: 'archivo_vacio' };
    if (buffer.length > MAX_BYTES_SOPORTE) return { ok: false, error: 'archivo_muy_grande' };
    const mime = mimeDeFirma(buffer);
    if (!mime) return { ok: false, error: 'formato_no_permitido' };
    if (SOLO_IMAGEN.has(tipo) && mime === 'application/pdf') return { ok: false, error: 'solo_imagen' };
    const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
    return { ok: true, mime, ext };
}

/**
 * Carpeta/archivo de storage. Misma convención que lee la escuela y que sube la familia:
 *   unregistered → unregistered_athletes/{ficha}/docs/{tipo}-{ts}-{nombre}.{ext}
 *   child        → children/{acudiente}/{hijo}/docs/…   (sin acudiente: children/{hijo}/docs/…)
 *   profile      → children/{uid}/docs/…
 */
export function rutaDeSoporte(p: { sujeto: Sujeto; tipo: string; ext: string; parentId?: string | null; ahora?: Date; nombre?: string | null }): string {
    const fecha = (p.ahora ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const base = (p.nombre ?? 'soporte').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'soporte';
    const archivo = `${PREFIJO_ARCHIVO(p.tipo)}${fecha}-${base}.${p.ext}`;
    const { tipo, id } = p.sujeto;
    if (tipo === 'unregistered') return `unregistered_athletes/${id}/docs/${archivo}`;
    if (tipo === 'child') return p.parentId ? `children/${p.parentId}/${id}/docs/${archivo}` : `children/${id}/docs/${archivo}`;
    return `children/${id}/docs/${archivo}`;
}

/** Tope de recordatorios: cada `cadaDias` días y máximo `maximo`. Espejo de soportes_reclamar_avisos. */
export function puedeAvisar(
    previo: { last_sent_at: string | Date; sent_count: number } | null | undefined,
    ahora: Date = new Date(),
    cadaDias = AVISO_CADA_DIAS,
    maximo = AVISO_MAXIMO,
): boolean {
    if (maximo <= 0) return false;
    if (!previo) return true;
    if (previo.sent_count >= maximo) return false;
    return new Date(previo.last_sent_at).getTime() <= ahora.getTime() - cadaDias * 86_400_000;
}

export interface FilaEstado {
    subject_type: TipoSujeto;
    subject_id: string;
    full_name: string;
    notify_profile_id: string | null;
    has_account: boolean;
    required_total: number;
    present_total: number;
    missing: string[];
    complete: boolean;
}

export interface AvisoFamilia {
    profileId: string;
    esHijo: boolean;
    deportistas: { nombre: string; faltan: string[] }[];
}

/** Un solo aviso por cuenta (acudiente con varios hijos = un mensaje). Solo con cuenta y con faltantes. */
export function agruparAvisos(filas: readonly FilaEstado[]): AvisoFamilia[] {
    const por = new Map<string, AvisoFamilia>();
    for (const f of filas) {
        if (f.complete || !f.notify_profile_id || f.missing.length === 0) continue;
        const a = por.get(f.notify_profile_id) ?? { profileId: f.notify_profile_id, esHijo: false, deportistas: [] };
        a.deportistas.push({ nombre: f.full_name, faltan: f.missing });
        if (f.subject_type === 'child') a.esHijo = true;
        por.set(f.notify_profile_id, a);
    }
    return [...por.values()];
}

/** Texto del recordatorio. Sin una sola palabra de cobro, mora ni pago. */
export function textoAviso(a: AvisoFamilia): { titulo: string; mensaje: string } {
    if (a.deportistas.length === 1) {
        const d = a.deportistas[0];
        const lista = d.faltan.map((t) => ETIQUETAS_SOPORTE[t as TipoSoporte] ?? t).join(', ');
        return {
            titulo: 'Faltan soportes por cargar',
            mensaje: `A la ficha de ${d.nombre} le faltan ${d.faltan.length} soporte(s): ${lista}. Puedes subirlos desde la app o enviarlos por WhatsApp.`,
        };
    }
    const nombres = a.deportistas.map((d) => `${d.nombre} (${d.faltan.length})`).join(', ');
    return {
        titulo: 'Faltan soportes por cargar',
        mensaje: `Faltan soportes en las fichas de: ${nombres}. Puedes subirlos desde la app o enviarlos por WhatsApp.`,
    };
}

// ─── Acceso a la base ────────────────────────────────────────────────────────

export type Resultado<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; faltan?: string[] };

function comoUsuario(authorization: string) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

function normalizarFila(f: any): FilaEstado {
    return {
        subject_type: f.subject_type, subject_id: String(f.subject_id), full_name: String(f.full_name ?? ''),
        notify_profile_id: f.notify_profile_id ?? null, has_account: !!f.has_account,
        required_total: Number(f.required_total ?? 0), present_total: Number(f.present_total ?? 0),
        missing: Array.isArray(f.missing) ? f.missing.map(String) : [], complete: !!f.complete,
    };
}

/** Configuración de soportes de la escuela (service role; el que llama ya autorizó). */
export async function configDeEscuela(schoolId: string): Promise<{ activo: boolean; requeridos: string[] }> {
    const { data, error } = await supabase.from('school_settings')
        .select('require_athlete_documents, required_document_types').eq('school_id', schoolId).maybeSingle();
    if (error) {
        // Columnas aún no migradas: la función no existe para esta base => apagado.
        if (error.code === '42703' || error.code === 'PGRST204') return { activo: false, requeridos: [] };
        throw new Error(`school_settings: ${error.message}`);
    }
    const req = Array.isArray((data as any)?.required_document_types) ? (data as any).required_document_types.map(String) : [];
    return { activo: (data as any)?.require_athlete_documents === true && req.length > 0, requeridos: req };
}

/** Estado en lote de toda la escuela, con el JWT del usuario: la RPC valida administración (42501 => 403). */
export async function estadoDeEscuela(authorization: string, schoolId: string): Promise<Resultado<{
    activo: boolean; requeridos: string[]; resumen: { total: number; completos: number; incompletos: number; sin_cuenta_incompletos: number };
    deportistas: FilaEstado[];
}>> {
    const cfg = await configDeEscuela(schoolId);
    const { data, error } = await comoUsuario(authorization).rpc('athlete_documents_status', { p_school_id: schoolId });
    if (error) {
        if (error.code === '42501') return { ok: false, status: 403, error: 'forbidden' };
        if (error.code === '42883' || error.code === 'PGRST202') return { ok: false, status: 503, error: 'migracion_pendiente' };
        throw new Error(`athlete_documents_status: ${error.code ?? ''} ${error.message ?? ''}`);
    }
    const deportistas = ((data as any[]) ?? []).map(normalizarFila);
    const incompletos = deportistas.filter((d) => !d.complete);
    return {
        ok: true, activo: cfg.activo, requeridos: cfg.requeridos, deportistas,
        resumen: {
            total: deportistas.length, completos: deportistas.length - incompletos.length, incompletos: incompletos.length,
            sin_cuenta_incompletos: incompletos.filter((d) => !d.has_account).length,
        },
    };
}

/** Un deportista, con el JWT del usuario (ficha, chequeo de torneos). */
export async function verificarSujeto(authorization: string, schoolId: string, s: Sujeto): Promise<Resultado<VerificacionSujeto>> {
    const { data, error } = await comoUsuario(authorization).rpc('soportes_verificar_sujeto', {
        p_school_id: schoolId, p_subject_type: s.tipo, p_subject_id: s.id,
    });
    if (error) {
        if (error.code === '42501') return { ok: false, status: 403, error: 'forbidden' };
        if (error.code === '22023') return { ok: false, status: 404, error: 'deportista_no_encontrado' };
        if (error.code === '42883' || error.code === 'PGRST202') return { ok: false, status: 503, error: 'migracion_pendiente' };
        throw new Error(`soportes_verificar_sujeto: ${error.code ?? ''} ${error.message ?? ''}`);
    }
    const d = (data ?? {}) as any;
    return {
        ok: true, activo: d.activo === true, completo: d.completo !== false,
        requeridos: Array.isArray(d.requeridos) ? d.requeridos.map(String) : [],
        faltan: Array.isArray(d.faltan) ? d.faltan.map(String) : [],
    };
}

/**
 * Un deportista, para su PROPIA familia (service role). La RPC `soportes_verificar_sujeto` solo admite a la
 * administración; la familia titular necesita ver qué le falta a su hijo (o a sí misma si es adulta). Quien
 * llama ya comprobó con `esFamiliaDelSujeto` que el sujeto es suyo.
 */
export async function verificarSujetoDeFamilia(schoolId: string, s: Sujeto): Promise<Resultado<VerificacionSujeto>> {
    const cfg = await configDeEscuela(schoolId);
    if (!cfg.activo) return { ok: true, activo: false, completo: true, requeridos: [], faltan: [] };
    const filas = await estadoInterno(schoolId, s);
    const f = filas[0];
    if (!f) return { ok: false, status: 404, error: 'deportista_no_encontrado' };
    return { ok: true, activo: true, completo: f.complete, requeridos: cfg.requeridos, faltan: f.missing };
}

/**
 * Para flujos del servidor que bloquean (convocar a torneo): { bloquear:false } si el flag está apagado o
 * si está completo; { bloquear:true, faltan } si no. La base nunca cae en silencio: si la RPC no existe
 * todavía (migración pendiente), NO bloquea (el flag tampoco existe).
 */
export async function chequearSoportesSujeto(authorization: string, schoolId: string, s: Sujeto): Promise<
    { bloquear: false } | { bloquear: true; faltan: string[] } | { error: true; status: number; mensaje: string }> {
    const r = await verificarSujeto(authorization, schoolId, s);
    if (!r.ok) {
        if (r.error === 'migracion_pendiente') return { bloquear: false };
        return { error: true, status: r.status, mensaje: r.error };
    }
    return debeBloquear(r) ? { bloquear: true, faltan: r.faltan } : { bloquear: false };
}

/** Estado interno con service role (job y bot). Sin sujeto: toda la escuela. */
export async function estadoInterno(schoolId: string, s?: Sujeto): Promise<FilaEstado[]> {
    const { data, error } = await supabase.rpc('soportes_estado_interno', {
        p_school_id: schoolId, p_subject_type: s?.tipo ?? null, p_subject_id: s?.id ?? null,
    });
    if (error) throw new Error(`soportes_estado_interno: ${error.code ?? ''} ${error.message ?? ''}`);
    return ((data as any[]) ?? []).map(normalizarFila);
}

// ─── guardarSoporte ──────────────────────────────────────────────────────────

export interface ArchivoSoporte {
    buffer: Buffer;
    /** Nombre original (solo para el nombre del archivo en storage; se sanea). */
    nombre?: string | null;
}

export interface GuardarSoporteParams {
    schoolId: string;
    sujeto: Sujeto;
    tipo: string;
    archivo: ArchivoSoporte;
    /** Quién sube (perfil). Null cuando lo sube el bot en nombre de la familia identificada. */
    subidoPor?: string | null;
}

export type GuardarSoporteResultado = Resultado<{
    id: string; storagePath: string; tipo: TipoSoporte;
    /** Lo que sigue faltando tras guardar (vacío si el flag está apagado o ya está completo). */
    faltan: string[]; completo: boolean; activo: boolean;
}>;

/** ¿El sujeto es de esta escuela? Devuelve además el acudiente (carpeta de la familia). */
async function sujetoDeLaEscuela(schoolId: string, s: Sujeto): Promise<{ ok: boolean; parentId: string | null }> {
    if (s.tipo === 'unregistered') {
        const r = await supabase.from('unregistered_athletes').select('id').eq('id', s.id).eq('school_id', schoolId).maybeSingle();
        return { ok: !!r.data, parentId: null };
    }
    if (s.tipo === 'child') {
        const c = await supabase.from('children').select('id, parent_id, school_id').eq('id', s.id).maybeSingle();
        if (!c.data) return { ok: false, parentId: null };
        let ok = (c.data as any).school_id === schoolId;
        if (!ok) {
            const e = await supabase.from('enrollments').select('id').eq('child_id', s.id).eq('school_id', schoolId).limit(1);
            ok = (e.data ?? []).length > 0;
        }
        return { ok, parentId: ok ? ((c.data as any).parent_id ?? null) : null };
    }
    const e = await supabase.from('enrollments').select('id').eq('user_id', s.id).eq('school_id', schoolId).limit(1);
    if ((e.data ?? []).length > 0) return { ok: true, parentId: null };
    const m = await supabase.from('school_members').select('profile_id').eq('profile_id', s.id).eq('school_id', schoolId).eq('status', 'active').limit(1);
    return { ok: (m.data ?? []).length > 0, parentId: null };
}

/**
 * Guarda un soporte: valida el archivo por su firma, comprueba que el deportista es de la escuela, sube al
 * bucket PRIVADO identity-documents (service role) y registra la fila en athlete_documents. No borra versiones
 * anteriores (el último por fecha es el vigente; borrar lo decide una persona).
 *
 * La usan la ruta POST de este módulo (administración o la propia familia) y el agente del bot de WhatsApp,
 * que YA identificó a quien escribe y a qué deportista se refiere. Esta función NO decide si quien llama puede
 * subir por ese deportista: ese candado es del llamador (la ruta lo hace; el bot solo pasa deportistas de la
 * persona identificada). Nunca devuelve el archivo ni una URL.
 */
export async function guardarSoporte(p: GuardarSoporteParams): Promise<GuardarSoporteResultado> {
    if (!esUuid(p.schoolId) || !esUuid(p.sujeto?.id) || !esTipoSujeto(p.sujeto?.tipo)) {
        return { ok: false, status: 400, error: 'sujeto_invalido' };
    }
    const v = validarArchivoSoporte(p.tipo, p.archivo.buffer);
    if (!v.ok) return { ok: false, status: v.error === 'archivo_muy_grande' ? 413 : 400, error: v.error };
    const tipo = p.tipo as TipoSoporte;

    const pertenece = await sujetoDeLaEscuela(p.schoolId, p.sujeto);
    if (!pertenece.ok) return { ok: false, status: 404, error: 'deportista_no_encontrado' };

    const storagePath = rutaDeSoporte({
        sujeto: p.sujeto, tipo, ext: v.ext, parentId: pertenece.parentId, nombre: p.archivo.nombre,
    });
    const up = await supabase.storage.from(BUCKET).upload(storagePath, p.archivo.buffer, {
        contentType: v.mime, cacheControl: '3600', upsert: false,
    });
    if (up.error) throw new Error(`storage identity-documents: ${up.error.message}`);

    const fila: Record<string, unknown> = {
        id: crypto.randomUUID(),
        school_id: p.schoolId,
        document_type: tipo,
        storage_path: storagePath,
        uploaded_by: p.subidoPor ?? null,
        child_id: p.sujeto.tipo === 'child' ? p.sujeto.id : null,
        user_id: p.sujeto.tipo === 'profile' ? p.sujeto.id : null,
        unregistered_athlete_id: p.sujeto.tipo === 'unregistered' ? p.sujeto.id : null,
    };
    const ins = await supabase.from('athlete_documents').insert(fila).select('id').single();
    if (ins.error || !ins.data) {
        await supabase.storage.from(BUCKET).remove([storagePath]);
        throw new Error(`athlete_documents: ${ins.error?.message ?? 'sin fila'}`);
    }

    // Qué falta ahora (el bot responde «te faltan 2: …»). Flag apagado => sin faltantes.
    let faltan: string[] = [];
    let activo = false;
    try {
        const filas = await estadoInterno(p.schoolId, p.sujeto);
        activo = filas.length > 0;
        faltan = filas[0]?.missing ?? [];
    } catch {
        // El archivo ya quedó guardado: un fallo del cálculo no lo deshace.
    }
    return { ok: true, id: String((ins.data as any).id), storagePath, tipo, faltan, completo: faltan.length === 0, activo };
}

/** ¿Este perfil puede subir soportes de este deportista? (la propia familia). La administración se valida aparte. */
export async function esFamiliaDelSujeto(userId: string, s: Sujeto): Promise<boolean> {
    if (s.tipo === 'profile') return s.id === userId;
    if (s.tipo === 'child') {
        const c = await supabase.from('children').select('parent_id').eq('id', s.id).maybeSingle();
        return (c.data as any)?.parent_id === userId;
    }
    const ua = await supabase.from('unregistered_athletes').select('linked_profile_id').eq('id', s.id).maybeSingle();
    return !!(ua.data as any)?.linked_profile_id && (ua.data as any).linked_profile_id === userId;
}
