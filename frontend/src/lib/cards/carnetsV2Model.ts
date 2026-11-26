/**
 * Pantalla V2 del dueño «Carnets, constancias y QR» (spec docs/specs/carnet-3d-club.md §12).
 * Lógica pura, sin React ni Supabase: textos, cuentas y armado de parámetros que
 * antes vivían sueltos dentro de SchoolCardsAdminPage / SchoolCertificatesAdminPage.
 */
import type { ModuleKey } from '@/config/module-catalog';
import type { ClubIdentidad } from './clubIdentity';
import type { Carnet3DDatos } from './contratos';

// ─── Deportistas y carnets ────────────────────────────────────────────────

export type TipoDeportista = 'child' | 'profile' | 'unregistered';

/** Fila de list_school_athletes_for_card_issue_v2 (lo que usa esta pantalla). */
export interface DeportistaCarnet {
  kind: TipoDeportista;
  athlete_id: string;
  full_name: string;
  avatar_url: string | null;
  team_id: string | null;
  team_name: string | null;
  branch_name: string | null;
  issuable: boolean;
  card_status: string | null;
  has_active_card: boolean;
}

/** Fila de list_athlete_id_cards + `codigo` (se lee aparte de athlete_id_cards). */
export interface CarnetEmitido {
  id: string;
  qr_token: string;
  status: string;
  issued_at: string;
  valid_until: string;
  athlete_name: string;
  team_name: string | null;
  child_id: string | null;
  profile_id: string | null;
  unregistered_athlete_id?: string | null;
  codigo?: string | null;
}

export interface Cobertura {
  conCarnet: number;
  total: number;
  sinCarnet: number;
  noEmitibles: number;
}

export function resumenCobertura(c: Cobertura): { titulo: string; pct: number; detalle: string } {
  const total = Math.max(0, c.total);
  const con = Math.min(Math.max(0, c.conCarnet), total);
  const pct = total ? Math.round((con / total) * 100) : 0;
  if (total === 0) {
    return { titulo: 'Todavía no hay deportistas inscritos', pct: 0, detalle: 'Cuando inscribas deportistas, aquí les generas el carnet.' };
  }
  const titulo = `${con} de ${total} ${total === 1 ? 'deportista tiene' : 'deportistas tienen'} carnet`;
  const partes: string[] = [];
  if (c.sinCarnet > 0) partes.push(`${c.sinCarnet} sin carnet`);
  if (c.noEmitibles > 0) partes.push(`${c.noEmitibles} sin cuenta (primero hay que invitar a la familia)`);
  const base = partes.length ? `${partes.join(' · ')}. ` : 'Todos tienen carnet. ';
  return { titulo, pct, detalle: `${base}A cada familia le llega un aviso apenas sale el carnet.` };
}

/** Separa a quién se le puede generar el carnet ahora. */
export function objetivosEmision(lista: DeportistaCarnet[]): {
  listos: DeportistaCarnet[];
  sinFoto: DeportistaCarnet[];
  yaTienen: number;
  sinCuenta: number;
} {
  const listos = lista.filter((a) => a.issuable && !a.has_active_card);
  return {
    listos,
    sinFoto: listos.filter((a) => !a.avatar_url),
    yaTienen: lista.filter((a) => a.has_active_card).length,
    sinCuenta: lista.filter((a) => !a.issuable).length,
  };
}

/** Parámetros de issue_athlete_id_card (mismo contrato que la emisión de V1). */
export function parametrosEmision(
  schoolId: string,
  a: Pick<DeportistaCarnet, 'kind' | 'athlete_id'>,
  templateId: string | null,
  validUntil: string,
) {
  return {
    p_school_id: schoolId,
    p_child_id: a.kind === 'child' ? a.athlete_id : null,
    p_profile_id: a.kind === 'profile' ? a.athlete_id : null,
    p_unregistered_athlete_id: a.kind === 'unregistered' ? a.athlete_id : null,
    p_template_id: templateId,
    p_valid_until: validUntil,
    p_photo_url: null,
  };
}

export const ERROR_FALTA_FOTO = 'No se puede generar el carnet: falta la foto del deportista';

/** Error de la emisión en palabras de la escuela (nunca el mensaje técnico). */
export function mensajeErrorEmision(err: { message?: string | null; code?: string | null } | null | undefined): string {
  const m = String(err?.message ?? '').toLowerCase();
  if (/(photo|foto)/.test(m)) return ERROR_FALTA_FOTO;
  if (err?.code === '42501' || m.includes('forbidden')) return 'No tienes permiso para generar carnets en esta escuela.';
  return 'No se pudo generar el carnet. Inténtalo de nuevo.';
}

/** Vigencia por defecto: un año desde hoy (yyyy-mm-dd). */
export function vigenciaPorDefecto(hoy: Date = new Date()): string {
  const d = new Date(hoy.getTime());
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/** 'default' → plantilla predeterminada de la escuela (o null = diseño base). */
export function resolverPlantilla(
  eleccion: string,
  plantillas: { id: string; is_default: boolean }[],
): string | null {
  if (eleccion !== 'default') return eleccion;
  return plantillas.find((t) => t.is_default)?.id ?? null;
}

const ESTADO_CARNET: Record<string, string> = { active: 'Vigente', revoked: 'Anulado', expired: 'Vencido' };
export function etiquetaEstadoCarnet(status: string | null | undefined): string {
  return (status && ESTADO_CARNET[status]) || 'Sin carnet';
}

/** ¿El carnet pertenece a alguno de estos deportistas? (para el PDF por equipo). */
export function carnetsDelEquipo(carnets: CarnetEmitido[], idsDeportistas: Iterable<string>): CarnetEmitido[] {
  const ids = new Set(idsDeportistas);
  return carnets.filter((c) =>
    ids.has(c.child_id || '') || ids.has(c.profile_id || '') || ids.has(c.unregistered_athlete_id || ''));
}

// ─── Datos que salen en el carnet (show_fields de la plantilla, D8) ─────────

/** Valores por defecto de las plantillas clásicas (CardTemplatesManager.DEFAULT_SHOW). */
export const SHOW_FIELDS_DEFECTO: Record<string, boolean> = {
  photo: true, doc_number: true, team: true, branch: true, plan: true,
  valid_until: true, fee_status: true, blood_type: false,
  emergency_contact: false, eps: false, tshirt_size: false,
};

export const CAMPOS_CARNET: Array<{ clave: string; etiqueta: string; detalle: string }> = [
  { clave: 'doc_number', etiqueta: 'Documento', detalle: 'Tipo y número; al verificar se muestra en parte' },
  { clave: 'branch', etiqueta: 'Sede', detalle: '' },
  { clave: 'valid_until', etiqueta: 'Vigencia del carnet', detalle: 'Hasta cuándo vale' },
  { clave: 'blood_type', etiqueta: 'RH (tipo de sangre)', detalle: 'Dato de salud' },
  { clave: 'eps', etiqueta: 'EPS', detalle: 'Dato de salud' },
  { clave: 'tshirt_size', etiqueta: 'Talla de uniforme', detalle: '' },
  { clave: 'emergency_contact', etiqueta: 'Contacto de emergencia', detalle: 'Nombre y teléfono del acudiente' },
];

/** Campos efectivos: los guardados encima de los valores por defecto. */
export function camposVisibles(guardados: Record<string, unknown> | null | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = { ...SHOW_FIELDS_DEFECTO };
  for (const [k, v] of Object.entries(guardados ?? {})) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Cambia un solo campo sin tocar los demás (incluidos los que esta pantalla no muestra). */
export function alternarCampo(actual: Record<string, boolean>, clave: string, valor: boolean): Record<string, boolean> {
  return { ...actual, [clave]: valor };
}

export function resumenCamposEncendidos(campos: Record<string, boolean>): string {
  const on = CAMPOS_CARNET.filter((c) => campos[c.clave]).map((c) => c.etiqueta.replace(/ \(.*\)$/, ''));
  if (on.length === 0) return 'Ningún dato adicional';
  if (on.length <= 3) return on.join(', ');
  return `${on.slice(0, 3).join(', ')}…`;
}

// ─── Constancias ───────────────────────────────────────────────────────────

export function esConstanciaPendiente(status: string): boolean {
  return status === 'pending_review' || status === 'pending_payment';
}

export function tituloPorAprobar(n: number): string {
  if (n <= 0) return 'Nada por aprobar';
  return n === 1 ? '1 por aprobar' : `${n} por aprobar`;
}

/** Quién la pidió, en una línea («la pidió Mauricio Herrera» / «la emitió la escuela»). */
export function quienPidio(r: { requested_by_name: string | null; created_by_school: boolean }): string {
  if (r.created_by_school) return 'la emitió la escuela';
  return r.requested_by_name ? `la pidió ${r.requested_by_name}` : 'la pidió la familia';
}

// ─── Secciones según módulos ───────────────────────────────────────────────

export const MODULOS_PANTALLA = {
  carnets: 'documentos_carnets',
  constancias: 'documentos_constancias',
  qr: 'documentos_qr_inscripcion',
} as const satisfies Record<string, ModuleKey>;

/** Roles a los que se les aplica el apagado por módulo (espejo de ModuleGate). */
const ROLES_CON_MODULOS = ['school', 'school_admin'];

export function seccionesVisibles(
  rol: string | null | undefined,
  moduloActivo: (k: ModuleKey) => boolean,
): { carnets: boolean; constancias: boolean; qr: boolean; ninguna: boolean } {
  const aplica = !!rol && ROLES_CON_MODULOS.includes(rol);
  const ver = (k: ModuleKey) => !aplica || moduloActivo(k);
  const carnets = ver(MODULOS_PANTALLA.carnets);
  const constancias = ver(MODULOS_PANTALLA.constancias);
  const qr = ver(MODULOS_PANTALLA.qr);
  return { carnets, constancias, qr, ninguna: !carnets && !constancias && !qr };
}

// ─── Vista previa ──────────────────────────────────────────────────────────

/** Deportista de ejemplo para la vista previa del carnet 3D (sin datos reales). */
export function deportistaDeEjemplo(identidad: ClubIdentidad, hoy: Date = new Date()): Carnet3DDatos {
  return {
    nombre: 'Sofía Ramírez',
    fotoUrl: null,
    numero: 10,
    posicion: 'Delantera',
    categoria: 'Sub-12',
    codigo: `SM-${hoy.getFullYear()}-00001`,
    qrToken: null,
    identidad,
    reverso: null,
  };
}

// ─── QR de inscripción ─────────────────────────────────────────────────────

/** El QR que se muestra en la pantalla: el general (abierto) activo, si no el primero activo. */
export function qrPrincipal<T extends { active: boolean; target_type: string }>(qrs: T[]): T | null {
  const activos = qrs.filter((q) => q.active);
  return activos.find((q) => q.target_type === 'open') ?? activos[0] ?? null;
}
