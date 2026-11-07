/**
 * Soportes del deportista (lado familia) — BFF /api/v1/soportes.
 * Contrato: docs/contratos-api-oleada-1-2026-11-06.md §4. Las respuestas nunca traen URLs ni rutas.
 */
import { bffClient, BFFError } from '@/lib/api/bffClient';

export type TipoSujeto = 'child' | 'profile' | 'unregistered';

export interface EstadoSoportes {
    activo: boolean;
    completo: boolean;
    requeridos: string[];
    faltan: string[];
}

export const MAX_BYTES_SOPORTE = 4 * 1024 * 1024;
/** Fotos y firmas: solo imagen. */
export const SOLO_IMAGEN = ['athlete_photo', 'guardian_signature', 'athlete_signature'];

const tipos = (v: unknown): string[] =>
    Array.isArray(v)
        ? v.map((x) => (typeof x === 'string' ? x : (x as { tipo?: string })?.tipo ?? '')).filter(Boolean)
        : [];

export async function estadoSoportes(
    schoolId: string, tipoSujeto: TipoSujeto, sujetoId: string,
): Promise<EstadoSoportes> {
    const r = await bffClient.get<Partial<EstadoSoportes>>(
        `/api/v1/soportes/${schoolId}/deportistas/${tipoSujeto}/${sujetoId}`);
    return { activo: !!r.activo, completo: !!r.completo, requeridos: tipos(r.requeridos), faltan: tipos(r.faltan) };
}

export const subirSoporte = (
    schoolId: string, tipoSujeto: TipoSujeto, sujetoId: string, tipoDocumento: string,
    archivoBase64: string, nombre?: string,
) =>
    bffClient.post<{ id: string; tipo: string; activo: boolean; completo: boolean; faltan: unknown[] }>(
        `/api/v1/soportes/${schoolId}/deportistas/${tipoSujeto}/${sujetoId}/${tipoDocumento}`,
        { archivoBase64, nombre },
    );

/** Valida en el cliente antes de subir. Devuelve el mensaje de error o null. */
export function validarSoporte(
    file: { name: string; size: number; type?: string }, tipoDocumento: string,
): string | null {
    if (file.size > MAX_BYTES_SOPORTE) return 'El archivo pesa más de 4 MB. Sube uno más liviano.';
    const soloImagen = SOLO_IMAGEN.includes(tipoDocumento);
    const okNombre = soloImagen ? /\.(jpe?g|png|webp)$/i : /\.(pdf|jpe?g|png|webp)$/i;
    const okMime = !file.type || (soloImagen
        ? /^image\/(jpeg|png|webp)$/i.test(file.type)
        : /^(image\/(jpeg|png|webp)|application\/pdf)$/i.test(file.type));
    if (!okNombre.test(file.name) || !okMime) {
        return soloImagen ? 'Sube una foto en JPG, PNG o WEBP.' : 'Sube un PDF o una foto en JPG, PNG o WEBP.';
    }
    return null;
}

/** Archivo a base64 sin el prefijo `data:...;base64,`. */
export function archivoABase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const lector = new FileReader();
        lector.onerror = () => reject(lector.error ?? new Error('lectura'));
        lector.onload = () => resolve(String(lector.result).replace(/^data:[^;]*;base64,/, ''));
        lector.readAsDataURL(file);
    });
}

export function mensajeErrorSoportes(e: unknown): string {
    if (e instanceof BFFError) {
        const codigo = ((e.body ?? {}) as { codigo?: string }).codigo;
        if (codigo === 'solo_imagen') return 'Este soporte debe ser una foto (JPG, PNG o WEBP).';
        if (codigo === 'formato_no_permitido') return 'Ese formato no se acepta. Usa JPG, PNG, WEBP o PDF.';
        if (e.status === 413) return 'El archivo pesa demasiado. El máximo es 4 MB.';
        if (e.status === 403) return 'No tienes permiso para subir soportes de este deportista.';
    }
    return 'No pudimos subir el archivo. Inténtalo de nuevo.';
}
