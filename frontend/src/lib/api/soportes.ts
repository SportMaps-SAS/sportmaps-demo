/**
 * Soportes del deportista (documentos de la ficha) — cliente de `/api/v1/soportes`.
 * Contratos: docs/contratos-api-oleada-1-2026-11-06.md §4. Se ve solo si `activo`.
 * Las respuestas nunca traen URLs ni rutas de storage.
 *
 * Lo que no es `soportesApi` es lógica pura, probada en `src/test/soportes.test.ts`.
 */
import { bffClient } from '@/lib/api/bffClient';

export type TipoSujetoSoporte = 'child' | 'profile' | 'unregistered';

export type TipoSoporte =
  | 'athlete_photo' | 'eps_certificate' | 'guardian_id_front' | 'athlete_id_front'
  | 'guardian_signature' | 'athlete_signature' | 'good_standing_certificate';

export const TIPOS_SOPORTE: TipoSoporte[] = [
  'athlete_photo', 'eps_certificate', 'guardian_id_front', 'athlete_id_front',
  'guardian_signature', 'athlete_signature', 'good_standing_certificate',
];

export const ETIQUETAS_SOPORTE: Record<TipoSoporte, string> = {
  athlete_photo: 'Foto del deportista',
  eps_certificate: 'Certificado de la EPS',
  guardian_id_front: 'Documento del acudiente (frente)',
  athlete_id_front: 'Documento del deportista (frente)',
  guardian_signature: 'Firma del acudiente',
  athlete_signature: 'Firma del deportista',
  good_standing_certificate: 'Paz y salvo',
};

/** Fotos y firmas: solo imagen. El resto admite también PDF. */
export const SOLO_IMAGEN: ReadonlySet<string> = new Set([
  'athlete_photo', 'guardian_signature', 'athlete_signature',
]);

export const MAX_BYTES_SOPORTE = 4 * 1024 * 1024;

const MIME_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'];
const MIME_PDF = 'application/pdf';

export interface DeportistaSoportes {
  subject_type: TipoSujetoSoporte;
  subject_id: string;
  full_name: string;
  notify_profile_id: string | null;
  has_account: boolean;
  required_total: number;
  present_total: number;
  missing: string[];
  complete: boolean;
}

export interface EstadoSoportes {
  activo: boolean;
  requeridos: string[];
  resumen: { total: number; completos: number; incompletos: number; sin_cuenta_incompletos: number };
  deportistas: DeportistaSoportes[];
}

export interface SoportesDeportista {
  activo: boolean;
  completo: boolean;
  requeridos: string[];
  faltan: string[];
}

export interface SubidaSoporteResultado {
  id: string;
  tipo: string;
  activo: boolean;
  completo: boolean;
  faltan: string[];
}

export const etiquetaSoporte = (tipo: string): string =>
  (ETIQUETAS_SOPORTE as Record<string, string>)[tipo] ?? tipo;

/** «Soportes 5/7». */
export const textoInsignia = (d: Pick<DeportistaSoportes, 'present_total' | 'required_total'>) =>
  `Soportes ${d.present_total}/${d.required_total}`;

/** El tipo de sujeto de soportes según el tipo de atleta de la pantalla (adulto con cuenta = profile). */
export function tipoSujetoDeAtleta(athleteType: 'child' | 'adult' | 'unregistered'): TipoSujetoSoporte {
  return athleteType === 'adult' ? 'profile' : athleteType;
}

export const llaveSujeto = (tipo: string, id: string) => `${tipo}:${id}`;

/** Índice por sujeto para la tabla de Atletas. */
export function indexarEstado(e: EstadoSoportes | null | undefined): Map<string, DeportistaSoportes> {
  const m = new Map<string, DeportistaSoportes>();
  if (!e?.activo) return m;
  for (const d of e.deportistas) m.set(llaveSujeto(d.subject_type, d.subject_id), d);
  return m;
}

/** null si el archivo sirve; si no, el mensaje en español para mostrar. */
export function validarArchivoSoporte(
  tipo: string,
  file: { type: string; size: number; name?: string },
): string | null {
  if (file.size <= 0) return 'El archivo está vacío.';
  if (file.size > MAX_BYTES_SOPORTE) return 'El archivo pesa más de 4 MB. Sube uno más liviano.';
  const esImagen = MIME_IMAGEN.includes(file.type);
  const esPdf = file.type === MIME_PDF;
  if (SOLO_IMAGEN.has(tipo)) {
    return esImagen ? null : 'Este soporte solo admite imagen (JPG, PNG o WEBP).';
  }
  return esImagen || esPdf ? null : 'Formato no permitido. Usa JPG, PNG, WEBP o PDF.';
}

/** Atributo `accept` del input de archivo según el tipo. */
export const aceptaArchivo = (tipo: string) =>
  SOLO_IMAGEN.has(tipo) ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,application/pdf';

/** Base64 sin el prefijo `data:...;base64,`. */
export function leerBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    r.onload = () => {
      const s = String(r.result ?? '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.readAsDataURL(file);
  });
}

interface ErrorConCodigo {
  status?: number;
  message?: string;
  code?: string;
  details?: string;
  body?: { codigo?: string; code?: string; error?: string; faltan?: string[] } | null;
}

const MENSAJES_SUBIDA: Record<string, string> = {
  tipo_invalido: 'Ese tipo de soporte no existe.',
  formato_no_permitido: 'Formato no permitido. Usa JPG, PNG, WEBP o PDF.',
  solo_imagen: 'Este soporte solo admite imagen (JPG, PNG o WEBP).',
};

export function mensajeErrorSoporte(e: unknown): string {
  const x = e as ErrorConCodigo | null;
  const cod = x?.body?.codigo;
  if (cod && MENSAJES_SUBIDA[cod]) return MENSAJES_SUBIDA[cod];
  if (x?.status === 413) return 'El archivo pesa más de 4 MB. Sube uno más liviano.';
  if (x?.status === 403) return 'No tienes permiso para subir soportes de este deportista.';
  if (x?.status === 404) return 'No encontramos a este deportista en la escuela.';
  return x?.body?.error || x?.message || 'No se pudo subir el soporte. Intenta de nuevo.';
}

/**
 * ¿Es el bloqueo de soportes? SQLSTATE `SP001` (RPC de confirmar en «Por asignar»)
 * o el texto `SOPORTES_INCOMPLETOS` (también lo trae el 409 de register-athlete).
 */
export function esSoportesIncompletos(e: unknown): boolean {
  const x = e as ErrorConCodigo | null;
  if (!x) return false;
  if (x.code === 'SP001' || x.body?.code === 'SP001') return true;
  if (x.body?.codigo === 'SOPORTES_INCOMPLETOS') return true;
  const texto = `${x.message ?? ''} ${x.body?.error ?? ''} ${x.details ?? ''}`;
  return /SOPORTES_INCOMPLETOS/.test(texto);
}

/**
 * Tipos que faltan, desde `faltan[]` del 409, o desde el mensaje de la RPC:
 * `SOPORTES_INCOMPLETOS: faltan 3 soporte(s): a, b, c` (o el DETAIL en JSON).
 */
export function tiposFaltantesDeError(e: unknown): string[] {
  const x = e as ErrorConCodigo | null;
  if (Array.isArray(x?.body?.faltan)) return x!.body!.faltan!.map(String);
  if (x?.details) {
    try {
      const j = JSON.parse(x.details);
      if (Array.isArray(j)) return j.map(String);
      if (Array.isArray(j?.faltan)) return j.faltan.map(String);
    } catch { /* el DETAIL no era JSON */ }
  }
  const m = /soporte\(s\):\s*([^\n]+)/i.exec(x?.message ?? '');
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Llamadas ────────────────────────────────────────────────────────────────

const base = '/api/v1/soportes';
const conEscuela = (schoolId: string) => ({ 'x-school-id': schoolId });

export const soportesApi = {
  estado: (schoolId: string, soloFaltan = false) =>
    bffClient.get<EstadoSoportes>(
      `${base}/${schoolId}/estado${soloFaltan ? '?solo_faltan=true' : ''}`,
      conEscuela(schoolId),
    ),

  deportista: (schoolId: string, tipoSujeto: TipoSujetoSoporte, sujetoId: string) =>
    bffClient.get<SoportesDeportista>(
      `${base}/${schoolId}/deportistas/${tipoSujeto}/${sujetoId}`,
      conEscuela(schoolId),
    ),

  subir: (
    schoolId: string,
    tipoSujeto: TipoSujetoSoporte,
    sujetoId: string,
    tipoDocumento: string,
    archivoBase64: string,
    nombre?: string,
  ) =>
    bffClient.post<SubidaSoporteResultado>(
      `${base}/${schoolId}/deportistas/${tipoSujeto}/${sujetoId}/${tipoDocumento}`,
      { archivoBase64, nombre },
      conEscuela(schoolId),
    ),
};
