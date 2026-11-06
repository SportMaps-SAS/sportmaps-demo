/**
 * Código de escuela — lógica pura (docs/specs/codigo-de-escuela-union-por-codigo.md).
 *
 * Espejo en TypeScript de `normalize_school_join_code()` (migración
 * 20261026132948): el servidor es la fuente de verdad; esto solo sirve para
 * validar y mostrar antes de llamar a la RPC.
 */

/** Sufijo sin caracteres ambiguos: sin 0/O/1/I/L. */
export const JOIN_CODE_SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const SHAPE = /^[A-Z]{3}[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/**
 * Mayúsculas, sin guiones ni espacios. En el prefijo (3 letras) un 0 es una O
 * y un 1 es una I. Mismo resultado que la función SQL.
 */
export function normalizeJoinCode(raw: string | null | undefined): string {
  const v = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 7) return v;
  return v.slice(0, 3).replace(/0/g, 'O').replace(/1/g, 'I') + v.slice(3);
}

/** ¿Tiene forma de código (3 letras + 4 del alfabeto)? No dice si existe. */
export function isJoinCodeShape(raw: string | null | undefined): boolean {
  return SHAPE.test(normalizeJoinCode(raw));
}

/** BES4K7Q → BES-4K7Q (para mostrar y dictar). */
export function formatJoinCode(raw: string | null | undefined): string {
  const v = normalizeJoinCode(raw);
  return v.length === 7 ? `${v.slice(0, 3)}-${v.slice(3)}` : v;
}

/** Enlace que abre el flujo con el código ya puesto. */
export function buildJoinUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, '')}/unirse?codigo=${encodeURIComponent(formatJoinCode(code))}`;
}

/** Texto para compartir por WhatsApp. */
export function buildJoinWhatsAppText(schoolName: string, code: string, url: string): string {
  return [
    `¡Hola! Para unirte a ${schoolName} en SportMaps:`,
    `1. Entra o crea tu cuenta.`,
    `2. Ingresa el código de la escuela: ${formatJoinCode(code)}`,
    ``,
    `O abre este enlace: ${url}`,
  ].join('\n');
}

// ─── Formulario de la familia ────────────────────────────────────────────────

export type ForWhom = 'self' | 'child';

export interface JoinRequestForm {
  forWhom: ForWhom | null;
  name: string;
  birthDate: string; // YYYY-MM-DD
  category: string;
  /** Documento del deportista (dato único con el que la escuela lo cruza con su ficha). */
  docNumber?: string;
  docType?: string;
  /** «No lo tengo a la mano»: permite enviar sin documento (la escuela lo pedirá). */
  noDoc?: boolean;
}

export type JoinRequestErrors = Partial<Record<'forWhom' | 'name' | 'birthDate' | 'category' | 'docNumber', string>>;

/** Documento sin puntos, espacios ni guiones, en mayúsculas (como normalize_doc_number). */
export function normalizeDocNumber(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Años cumplidos a `today` (YYYY-MM-DD). null si la fecha no es válida. */
export function ageOn(birthDate: string | null | undefined, today: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  let years = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  if (today.slice(5) < birthDate.slice(5)) years -= 1;
  return years;
}

/** Mismas reglas que `submit_school_join_request` (el servidor vuelve a validar). */
export function validateJoinRequestForm(form: JoinRequestForm, today: string): JoinRequestErrors {
  const errors: JoinRequestErrors = {};
  if (form.forWhom !== 'self' && form.forWhom !== 'child') {
    errors.forWhom = 'Elige si es para ti o para tu hijo(a).';
  }
  const name = form.name.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 150) {
    errors.name = 'Escribe el nombre completo del deportista.';
  } else if (!/\s/.test(name)) {
    errors.name = 'Escribe nombre y apellido.';
  }
  const age = ageOn(form.birthDate, today);
  if (age === null || form.birthDate > today || form.birthDate < '1920-01-01') {
    errors.birthDate = 'Revisa la fecha de nacimiento.';
  }
  if (form.category.trim().length > 120) {
    errors.category = 'La categoría sugerida es muy larga (máximo 120 caracteres).';
  }
  // El documento se valida solo si el formulario lo trae (docNumber definido).
  if (form.docNumber !== undefined && !form.noDoc) {
    const doc = normalizeDocNumber(form.docNumber);
    if (!doc) errors.docNumber = 'Escribe el documento del deportista, o marca que no lo tienes a la mano.';
    else if (doc.length < 5 || doc.length > 20) errors.docNumber = 'Revisa el número de documento.';
  }
  return errors;
}

/** Aviso NO bloqueante: un hijo(a) de 18 o más normalmente entra con su propia cuenta. */
export function adultChildWarning(form: JoinRequestForm, today: string): string | null {
  if (form.forWhom !== 'child') return null;
  const age = ageOn(form.birthDate, today);
  if (age !== null && age >= 18) {
    return `Tiene ${age} años. Si ya es mayor de edad, lo ideal es que cree su propia cuenta y elija «Para mí».`;
  }
  return null;
}

// ─── Bandeja «Por asignar» (D1: solo solicitudes por código) ─────────────────

export interface JoinRequestRow {
  id: string;
  for_whom: ForWhom;
  athlete_name: string;
  birth_date: string | null;
  suggested_category: string | null;
  status: 'pending' | 'assigned' | 'linked' | 'rejected' | 'cancelled';
  created_at: string;
  child_id: string | null;
  assigned_team_id: string | null;
  team_name: string | null;
  assigned_branch_id: string | null;
  enrollment_id: string | null;
  requester_profile_id: string;
  requester_name: string | null;
  requester_email: string | null;
  requester_phone: string | null;
  /** Documento que escribió quien pidió (null si no lo tenía a la mano). */
  athlete_doc_number?: string | null;
  athlete_doc_type?: string | null;
  /** Fichas que coinciden por DOCUMENTO o CORREO exactos: la única base para vincular. */
  exact_matches?: Array<{
    id: string;
    source: 'unregistered_athlete' | 'children';
    full_name: string;
    team_name: string | null;
    basis: 'documento' | 'correo';
  }>;
  needs_enrollment: boolean;
  has_enrollment: boolean;
  candidates: Array<{
    id: string;
    full_name: string;
    date_of_birth: string | null;
    team_name: string | null;
    same_birth_date: boolean | null;
  }>;
}

/**
 * Arma la bandeja: solicitudes abiertas (pendientes o con la inscripción por
 * hacer), de la más antigua a la más nueva (la que más lleva esperando, arriba).
 * Los prospectos (WhatsApp, formulario) NO entran: viven en Deportistas →
 * «Clase de prueba» (D1 revisada el 2026-10-29).
 */
export function buildPorAsignarInbox(requests: JoinRequestRow[] | null | undefined): JoinRequestRow[] {
  return (requests ?? [])
    .filter((r) => r.status === 'pending' || r.needs_enrollment)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

// ─── Inscripción por el camino de «Agregar atleta» ───────────────────────────

export interface EnrollPayloadInput {
  forWhom: ForWhom;
  childId: string | null;
  userId: string | null;
  teamId: string;
  branchId: string | null;
  startDate: string;
  plan: { id: string; offeringId: string; price: number | null } | null;
  teamPrice: number | null;
}

/**
 * Cuerpo de POST /api/v1/students/create-one para inscribir a quien ya quedó
 * con ficha (child_existing) o con membresía (adult_existing).
 *
 * Cuota, igual que el alta de un menor en «Agregar atleta»: precio del plan si
 * hay plan, si no el del equipo. `child_existing` solo genera el cobro con
 * `monthly_fee` explícito, por eso se manda; el BFF exige ≥ 10.000. En
 * `adult_existing` el BFF calcula la cuota solo (plan > equipo).
 */
export function buildEnrollPayload(input: EnrollPayloadInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    team_id: input.teamId,
    branch_id: input.branchId,
    start_date: input.startDate,
    offering_plan_id: input.plan?.id ?? null,
    offering_id: input.plan?.offeringId ?? null,
  };
  if (input.forWhom === 'self') {
    if (!input.userId) throw new Error('Falta la cuenta del deportista.');
    return { type: 'adult_existing', user_id: input.userId, ...base };
  }
  if (!input.childId) throw new Error('Falta la ficha del deportista.');
  const fee = input.plan ? input.plan.price : input.teamPrice;
  return {
    type: 'child_existing',
    child_id: input.childId,
    ...base,
    ...(fee != null && fee >= 10000 ? { monthly_fee: Number(fee) } : {}),
  };
}

// ─── Código pendiente entre registro/login y /unirse ─────────────────────────

/** Se borra al cerrar sesión (AuthContext.signOut): localStorage es del dispositivo. */
export const PENDING_JOIN_CODE_KEY = 'sportmaps_pending_join_code';
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function savePendingJoinCode(code: string, now: number = Date.now()): void {
  const v = normalizeJoinCode(code);
  if (!v) return;
  try {
    localStorage.setItem(PENDING_JOIN_CODE_KEY, JSON.stringify({ code: v, at: now }));
  } catch { /* sin storage */ }
}

export function readPendingJoinCode(now: number = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(PENDING_JOIN_CODE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code?: string; at?: number };
    if (!parsed?.code || typeof parsed.at !== 'number' || now - parsed.at > PENDING_TTL_MS) {
      localStorage.removeItem(PENDING_JOIN_CODE_KEY);
      return null;
    }
    return parsed.code;
  } catch {
    return null;
  }
}

export function clearPendingJoinCode(): void {
  try { localStorage.removeItem(PENDING_JOIN_CODE_KEY); } catch { /* sin storage */ }
}

/** Mensaje legible de un error de RPC o del BFF. */
export function joinErrorMessage(e: unknown, fallback = 'No se pudo completar. Intenta de nuevo.'): string {
  const anyE = e as { body?: { error?: string; message?: string }; message?: string } | null;
  return anyE?.body?.error || anyE?.body?.message || anyE?.message || fallback;
}
