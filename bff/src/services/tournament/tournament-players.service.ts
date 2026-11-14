/**
 * Jugadores del torneo (también de los equipos EXTERNOS), formulario configurable, carné con QR
 * firmado y validación en cancha. Tabla: event_team_members (la misma que usan las estadísticas
 * por jugadora y el MVP). Spec: docs/specs/torneos-en-vivo-multideporte-plan.md.
 *
 * Privacidad: documento y teléfono solo salen en las rutas del organizador. La validación pública
 * devuelve nombre de pila, foto (si el organizador lo permite), equipo, categoría y Habilitado/No.
 */
import { createHmac, createHash, timingSafeEqual } from 'crypto';
import { supabase } from '../../config/supabase';
import { LiveError, cleanText, validateImageUrl, type LiveEvent } from './tournament-live.service';

// ── Formulario de jugador ────────────────────────────────────────────────────

export const BASE_FIELDS = ['photo_url', 'full_name', 'nickname', 'position', 'shirt_number', 'document_number', 'birth_date', 'phone'] as const;
export type BaseField = typeof BASE_FIELDS[number];
export const CUSTOM_TYPES = ['text', 'date', 'bool', 'select'] as const;
export type CustomType = typeof CUSTOM_TYPES[number];

export interface CustomField { key: string; label: string; type: CustomType; options?: string[]; required?: boolean }
export interface PlayerForm { required: BaseField[]; custom: CustomField[] }

export const DEFAULT_FORM: PlayerForm = { required: ['full_name'], custom: [] };

export function normalizeForm(raw: unknown): PlayerForm {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const required = Array.isArray(r.required) ? (r.required.filter((k) => BASE_FIELDS.includes(k as BaseField)) as BaseField[]) : [];
  if (!required.includes('full_name')) required.unshift('full_name');
  const custom = Array.isArray(r.custom) ? (r.custom as CustomField[]) : [];
  return { required: [...new Set(required)], custom };
}

/** Valida lo que el organizador configura. */
export function validateForm(raw: unknown): PlayerForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LiveError(400, 'form_invalido', 'El formulario no es válido');
  const r = raw as Record<string, unknown>;
  if (r.required != null && (!Array.isArray(r.required) || r.required.some((k) => !BASE_FIELDS.includes(k as BaseField)))) {
    throw new LiveError(400, 'form_invalido', 'Hay un campo obligatorio desconocido');
  }
  const custom = r.custom == null ? [] : r.custom;
  if (!Array.isArray(custom) || custom.length > 15) throw new LiveError(400, 'form_invalido', 'Máximo 15 campos propios');
  const keys = new Set<string>();
  const out: CustomField[] = [];
  for (const c of custom as any[]) {
    const label = cleanText(c?.label, 40, 'El nombre del campo');
    if (!label) throw new LiveError(400, 'form_invalido', 'Cada campo propio necesita un nombre');
    if (!CUSTOM_TYPES.includes(c?.type)) throw new LiveError(400, 'form_invalido', `Tipo inválido en «${label}» (texto, fecha, sí/no o lista)`);
    const key = String(c?.key || label).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    if (!key || keys.has(key) || (BASE_FIELDS as readonly string[]).includes(key)) throw new LiveError(400, 'form_invalido', `El campo «${label}» está repetido`);
    keys.add(key);
    const f: CustomField = { key, label, type: c.type, required: !!c.required };
    if (c.type === 'select') {
      const opts = Array.isArray(c.options) ? c.options.map((o: unknown) => cleanText(o, 40, 'La opción')).filter(Boolean) as string[] : [];
      if (opts.length < 2 || opts.length > 30) throw new LiveError(400, 'form_invalido', `La lista «${label}» necesita entre 2 y 30 opciones`);
      f.options = [...new Set(opts)];
    }
    out.push(f);
  }
  return normalizeForm({ required: r.required ?? DEFAULT_FORM.required, custom: out });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE_LABEL: Record<BaseField, string> = {
  photo_url: 'La foto', full_name: 'El nombre', nickname: 'El apodo', position: 'La posición', shirt_number: 'El número',
  document_number: 'El documento', birth_date: 'La fecha de nacimiento', phone: 'El teléfono',
};

/** Convierte una fila (formulario o planilla) en columnas. `partial` = edición (solo lo que viene). */
export function playerRow(raw: Record<string, unknown>, form: PlayerForm, partial = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => k in raw && raw[k] !== undefined;
  const empty = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '');
  if (!partial || has('full_name')) out.full_name = cleanText(raw.full_name, 120, 'El nombre');
  if (has('nickname')) out.nickname = cleanText(raw.nickname, 40, 'El apodo');
  if (has('position')) out.position = cleanText(raw.position, 40, 'La posición');
  if (has('phone')) out.phone = cleanText(raw.phone, 30, 'El teléfono');
  if (has('document_number')) out.document_number = cleanText(raw.document_number, 30, 'El documento');
  if (has('photo_url')) out.photo_url = validateImageUrl(raw.photo_url, 'La foto');
  if (has('shirt_number')) {
    if (empty(raw.shirt_number)) out.shirt_number = null;
    else {
      const n = Number(raw.shirt_number);
      if (!Number.isInteger(n) || n < 0 || n > 999) throw new LiveError(400, 'numero_invalido', 'El número debe estar entre 0 y 999');
      out.shirt_number = n;
    }
  }
  if (has('birth_date')) {
    if (empty(raw.birth_date)) out.birth_date = null;
    else {
      const d = String(raw.birth_date).trim();
      if (!ISO_DATE.test(d) || !Number.isFinite(Date.parse(d))) throw new LiveError(400, 'fecha_invalida', 'La fecha de nacimiento debe ser AAAA-MM-DD');
      out.birth_date = d;
      out.birth_year = Number(d.slice(0, 4));
    }
  }
  // Campos propios
  const extraIn = (raw.extra && typeof raw.extra === 'object' ? raw.extra : {}) as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const f of form.custom) {
    const v = extraIn[f.key];
    if (empty(v)) { if (!partial && f.required) throw new LiveError(400, 'campo_requerido', `Falta «${f.label}»`); continue; }
    if (f.type === 'text') extra[f.key] = cleanText(v, 120, f.label);
    else if (f.type === 'date') { const d = String(v).trim(); if (!ISO_DATE.test(d)) throw new LiveError(400, 'fecha_invalida', `«${f.label}» debe ser AAAA-MM-DD`); extra[f.key] = d; }
    else if (f.type === 'bool') extra[f.key] = v === true || ['si', 'sí', 'true', '1', 'x'].includes(String(v).trim().toLowerCase());
    else { const s = String(v).trim(); if (!f.options?.includes(s)) throw new LiveError(400, 'opcion_invalida', `«${s}» no es una opción de «${f.label}»`); extra[f.key] = s; }
  }
  if (!partial || 'extra' in raw) out.extra = extra;
  if (!partial) {
    for (const k of form.required) if (empty(out[k])) throw new LiveError(400, 'campo_requerido', `${BASE_LABEL[k]} es obligatorio`);
  } else if ('full_name' in out && !out.full_name) throw new LiveError(400, 'campo_requerido', 'El nombre es obligatorio');
  return out;
}

// ── Jugadores ────────────────────────────────────────────────────────────────

const MEMBER_COLS = 'id, team_id, delegation_id, full_name, nickname, position, shirt_number, document_number, birth_date, birth_year, phone, photo_url, extra, suspended, suspended_reason, card_version, child_id, profile_id, is_external';
const MAX_BATCH = 200;

export interface MemberRow {
  id: string; team_id: string; delegation_id: string | null; full_name: string; nickname?: string | null; position?: string | null;
  shirt_number?: number | null; document_number?: string | null; birth_date?: string | null; birth_year?: number | null;
  phone?: string | null; photo_url?: string | null; extra?: Record<string, unknown> | null; suspended?: boolean | null;
  suspended_reason?: string | null; card_version?: number | null; child_id?: string | null; profile_id?: string | null; is_external?: boolean | null;
}

export const toPlayerDto = (m: MemberRow) => ({
  id: m.id, team_id: m.team_id, full_name: m.full_name, nickname: m.nickname ?? null, position: m.position ?? null,
  shirt_number: m.shirt_number ?? null, document_number: m.document_number ?? null, birth_date: m.birth_date ?? null,
  phone: m.phone ?? null, photo_url: m.photo_url ?? null, extra: m.extra ?? {}, suspended: !!m.suspended,
  suspended_reason: m.suspended_reason ?? null, from_school: !!(m.child_id || m.profile_id),
});

async function teamOf(ev: LiveEvent, teamId: string) {
  const { data } = await supabase.from('event_teams').select('id, event_id, team_name, category_id, delegation_id, is_external, status').eq('id', teamId).eq('event_id', ev.id).maybeSingle();
  const t = data as any;
  if (!t || t.status === 'rejected') throw new LiveError(404, 'equipo_no_encontrado', 'Equipo no encontrado');
  return t as { id: string; team_name: string; category_id: string | null; delegation_id: string | null; is_external: boolean | null };
}

export async function getPlayerForm(ev: LiveEvent): Promise<PlayerForm> {
  const { data } = await supabase.from('events').select('player_form').eq('id', ev.id).maybeSingle();
  return normalizeForm((data as any)?.player_form ?? DEFAULT_FORM);
}

export async function savePlayerForm(ev: LiveEvent, raw: unknown) {
  const form = validateForm(raw);
  const { error } = await supabase.from('events').update({ player_form: form, updated_at: new Date().toISOString() }).eq('id', ev.id);
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudo guardar el formulario');
  return form;
}

export async function listPlayers(ev: LiveEvent, teamId: string) {
  await teamOf(ev, teamId);
  const { data } = await supabase.from('event_team_members').select(MEMBER_COLS).eq('team_id', teamId).order('full_name');
  return ((data ?? []) as MemberRow[]).map(toPlayerDto);
}

/** Uno o varios (planilla). Si una fila falla no se guarda ninguna: el error dice cuál. */
export async function addPlayers(ev: LiveEvent, teamId: string, rows: unknown) {
  const team = await teamOf(ev, teamId);
  if (!Array.isArray(rows) || rows.length === 0) throw new LiveError(400, 'sin_jugadores', 'Escribe al menos un jugador');
  if (rows.length > MAX_BATCH) throw new LiveError(400, 'demasiados', `Máximo ${MAX_BATCH} jugadores por vez`);
  const form = await getPlayerForm(ev);
  const built = rows.map((r, i) => {
    try { return playerRow((r ?? {}) as Record<string, unknown>, form); }
    catch (e) { if (e instanceof LiveError) throw new LiveError(e.status, e.code, `Fila ${i + 1}: ${e.message}`); throw e; }
  });
  const ext = !!team.is_external;
  const insert = built.map((b) => ({ ...b, team_id: teamId, delegation_id: ext ? null : team.delegation_id, is_external: ext }));
  const { data, error } = await supabase.from('event_team_members').insert(insert).select(MEMBER_COLS);
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudieron guardar los jugadores');
  return ((data ?? []) as MemberRow[]).map(toPlayerDto);
}

async function memberOf(ev: LiveEvent, playerId: string): Promise<MemberRow> {
  const { data } = await supabase.from('event_team_members').select(MEMBER_COLS).eq('id', playerId).maybeSingle();
  const m = data as MemberRow | null;
  if (!m) throw new LiveError(404, 'jugador_no_encontrado', 'Jugador no encontrado');
  await teamOf(ev, m.team_id); // el equipo debe ser de ESTE torneo
  return m;
}

export async function updatePlayer(ev: LiveEvent, playerId: string, body: Record<string, unknown>) {
  const m = await memberOf(ev, playerId);
  const form = await getPlayerForm(ev);
  const patch = playerRow(body, form, true);
  if ('suspended' in body) {
    if (typeof body.suspended !== 'boolean') throw new LiveError(400, 'invalido', 'suspended debe ser true o false');
    patch.suspended = body.suspended;
    patch.suspended_reason = body.suspended ? cleanText(body.suspended_reason, 200, 'El motivo') : null;
  }
  if ('extra' in body) patch.extra = { ...(m.extra ?? {}), ...(patch.extra as object) };
  if (Object.keys(patch).length === 0) throw new LiveError(400, 'nada', 'No hay nada que guardar');
  const { data, error } = await supabase.from('event_team_members').update(patch).eq('id', playerId).select(MEMBER_COLS);
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudo guardar el jugador');
  return toPlayerDto(((Array.isArray(data) ? data[0] : data) ?? { ...m, ...patch }) as MemberRow);
}

export async function deletePlayer(ev: LiveEvent, playerId: string) {
  const m = await memberOf(ev, playerId);
  if (m.child_id || m.profile_id) throw new LiveError(400, 'jugador_inscrito', 'Este jugador viene de una inscripción: retíralo desde Inscritos.');
  await supabase.from('event_team_members').delete().eq('id', playerId);
  return { success: true };
}

/** Invalida el QR anterior (carné perdido o prestado). */
export async function reissueCard(ev: LiveEvent, playerId: string) {
  const m = await memberOf(ev, playerId);
  const v = (m.card_version ?? 1) + 1;
  await supabase.from('event_team_members').update({ card_version: v }).eq('id', playerId);
  return { card_version: v };
}

/** Deportistas activos de la escuela organizadora, para traerlos a un equipo interno. */
export async function schoolAthletes(ev: LiveEvent, q?: string) {
  if (!ev.school_id) return [];
  let query = supabase.from('children').select('id, full_name, date_of_birth, avatar_url').eq('school_id', ev.school_id).eq('is_active', true).order('full_name').limit(500);
  if (q && q.trim()) query = query.ilike('full_name', `%${q.trim().replace(/[%_]/g, '')}%`);
  const { data } = await query;
  return ((data ?? []) as any[]).map((c) => ({ id: c.id as string, full_name: c.full_name as string, birth_date: c.date_of_birth ?? null }));
}

export async function addFromSchool(ev: LiveEvent, teamId: string, childIds: unknown) {
  const team = await teamOf(ev, teamId);
  if (team.is_external) throw new LiveError(400, 'equipo_externo', 'Los deportistas de tu escuela van en un equipo propio, no en un rival externo');
  if (!ev.school_id) throw new LiveError(400, 'sin_escuela', 'Este torneo no es de una escuela');
  if (!Array.isArray(childIds) || childIds.length === 0 || childIds.length > MAX_BATCH) throw new LiveError(400, 'sin_jugadores', 'Elige al menos un deportista');
  const { data: kids } = await supabase.from('children').select('id, full_name, date_of_birth, avatar_url, doc_number').eq('school_id', ev.school_id).in('id', childIds as string[]);
  const { data: already } = await supabase.from('event_team_members').select('child_id').eq('team_id', teamId);
  const have = new Set(((already ?? []) as any[]).map((r) => r.child_id));
  const rows = ((kids ?? []) as any[]).filter((k) => !have.has(k.id)).map((k) => ({
    team_id: teamId, delegation_id: team.delegation_id, is_external: false, child_id: k.id, full_name: k.full_name,
    birth_date: k.date_of_birth ?? null, birth_year: k.date_of_birth ? Number(String(k.date_of_birth).slice(0, 4)) : null,
    document_number: k.doc_number ?? null, photo_url: typeof k.avatar_url === 'string' && k.avatar_url.startsWith('https://') ? k.avatar_url : null,
  }));
  if (rows.length === 0) return { added: 0 };
  const { error } = await supabase.from('event_team_members').insert(rows);
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudieron agregar los deportistas');
  return { added: rows.length };
}

// ── Carné: token firmado y validación en cancha ──────────────────────────────

const cardSecret = () => process.env.TOURNAMENT_CARD_SECRET
  || createHash('sha256').update(`carne-torneo:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'dev'}`).digest('hex');

const sign = (body: string, key = cardSecret()) => createHmac('sha256', key).update(body).digest('base64url').slice(0, 22);

/** `<id del jugador>.<versión>.<firma>`: no se puede inventar ni reusar después de reemitir. */
export function cardToken(memberId: string, version: number, key = cardSecret()): string {
  return `${memberId}.${version}.${sign(`${memberId}.${version}`, key)}`;
}

export function parseCardToken(token: string, key = cardSecret()): { memberId: string; version: number } | null {
  const m = /^([0-9a-f-]{36})\.(\d{1,6})\.([A-Za-z0-9_-]{22})$/i.exec(token);
  if (!m) return null;
  const expected = Buffer.from(sign(`${m[1]}.${m[2]}`, key));
  const got = Buffer.from(m[3]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { memberId: m[1], version: Number(m[2]) };
}

export const CARD_FIELDS = ['shirt_number', 'nickname', 'document_number', 'position', 'phone'] as const;
export type CardField = typeof CARD_FIELDS[number];
export interface CardConfig { subtitle: string | null; color: string | null; fields: CardField[]; public_photo: boolean }
export const DEFAULT_CARD: CardConfig = { subtitle: null, color: null, fields: ['shirt_number', 'position'], public_photo: true };

export function validateCardConfig(raw: unknown): CardConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const color = r.color == null || r.color === '' ? null : String(r.color);
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new LiveError(400, 'color_invalido', 'El color debe ser como #1E40AF');
  const fields = Array.isArray(r.fields) ? r.fields : DEFAULT_CARD.fields;
  if (fields.length > 3 || fields.some((f) => !CARD_FIELDS.includes(f as CardField))) throw new LiveError(400, 'campos_invalidos', 'Elige hasta 3 campos: número, apodo, documento, posición o teléfono');
  return { subtitle: cleanText(r.subtitle, 60, 'El subtítulo'), color, fields: [...new Set(fields)] as CardField[], public_photo: r.public_photo !== false };
}

export async function getCardConfig(ev: LiveEvent): Promise<CardConfig> {
  const { data } = await supabase.from('events').select('card_config').eq('id', ev.id).maybeSingle();
  const raw = (data as any)?.card_config;
  try { return raw ? validateCardConfig(raw) : { ...DEFAULT_CARD }; } catch { return { ...DEFAULT_CARD }; }
}

export async function saveCardConfig(ev: LiveEvent, raw: unknown) {
  const cfg = validateCardConfig(raw);
  const { error } = await supabase.from('events').update({ card_config: cfg, updated_at: new Date().toISOString() }).eq('id', ev.id);
  if (error) throw new LiveError(500, 'error_guardando', 'No se pudo guardar el carné');
  return cfg;
}

/** Datos para imprimir carnés (organizador): jugador + token + URL de validación. */
export async function cardsFor(ev: LiveEvent, origin: string, teamId?: string | null) {
  let tq = supabase.from('event_teams').select('id, team_name, category_id, logo_url').eq('event_id', ev.id).neq('status', 'rejected');
  if (teamId) tq = tq.eq('id', teamId);
  const { data: teams } = await tq;
  const tList = (teams ?? []) as any[];
  if (tList.length === 0) return { config: await getCardConfig(ev), cards: [] };
  const { data: members } = await supabase.from('event_team_members').select(MEMBER_COLS).in('team_id', tList.map((t) => t.id)).order('full_name');
  const byTeam = new Map(tList.map((t) => [t.id, t]));
  const base = `${origin.replace(/\/$/, '')}/torneo/${ev.slug}/validar/`;
  const cards = ((members ?? []) as MemberRow[]).map((m) => {
    const token = cardToken(m.id, m.card_version ?? 1);
    return { player: toPlayerDto(m), team_name: byTeam.get(m.team_id)?.team_name ?? null, team_logo_url: byTeam.get(m.team_id)?.logo_url ?? null, token, validate_url: base + token };
  });
  return { config: await getCardConfig(ev), cards };
}

/** Edad cumplida en una fecha (AAAA-MM-DD). */
export function ageOn(birth: string, on: string): number {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export interface CategoryLimits { age_min?: number | null; age_max?: number | null; birth_year_min?: number | null; birth_year_max?: number | null }

/** ¿Cumple la edad de la categoría? Razón legible si no. Sin límites = cumple. */
export function ageEligibility(p: { birth_date?: string | null; birth_year?: number | null }, cat: CategoryLimits | null, on: string): string | null {
  if (!cat) return null;
  const hasAge = cat.age_min != null || cat.age_max != null;
  const hasYear = cat.birth_year_min != null || cat.birth_year_max != null;
  if (!hasAge && !hasYear) return null;
  const year = p.birth_date ? Number(p.birth_date.slice(0, 4)) : p.birth_year ?? null;
  if (hasYear) {
    if (year == null) return 'Sin fecha de nacimiento registrada';
    if (cat.birth_year_min != null && year < cat.birth_year_min) return 'No cumple el año de nacimiento de la categoría';
    if (cat.birth_year_max != null && year > cat.birth_year_max) return 'No cumple el año de nacimiento de la categoría';
  }
  if (hasAge) {
    const age = p.birth_date ? ageOn(p.birth_date, on) : year != null ? Number(on.slice(0, 4)) - year : null;
    if (age == null) return 'Sin fecha de nacimiento registrada';
    if (cat.age_min != null && age < cat.age_min) return 'Menor que la edad de la categoría';
    if (cat.age_max != null && age > cat.age_max) return 'Mayor que la edad de la categoría';
  }
  return null;
}

export type EligibilityCode = 'equipo_rechazado' | 'suspendido' | 'edad';
export interface EligibilityIssue { code: EligibilityCode; reason: string }

/**
 * LA regla de habilitación de una jugadora (sin la versión del carné, que es propia del QR).
 * La usan la validación en cancha (QR), el etiquetador de puntos, las candidatas a MVP y la planilla:
 * no se duplica en ningún otro lado. Vacío = habilitada.
 */
export function playerEligibility(
  m: { suspended?: boolean | null; suspended_reason?: string | null; birth_date?: string | null; birth_year?: number | null },
  cat: CategoryLimits | null, on: string, teamStatus?: string | null,
): EligibilityIssue[] {
  const out: EligibilityIssue[] = [];
  if (teamStatus === 'rejected') out.push({ code: 'equipo_rechazado', reason: 'El equipo no está en el torneo' });
  if (m.suspended) out.push({ code: 'suspendido', reason: m.suspended_reason ? `Suspendido: ${m.suspended_reason}` : 'Suspendido' });
  const ageReason = ageEligibility(m, cat, on);
  if (ageReason) out.push({ code: 'edad', reason: ageReason });
  return out;
}

const CAT_COLS = 'id, division, level, category, rama, age_min, age_max, birth_year_min, birth_year_max';
export const categoryLabel = (c: any): string | null => (c ? [c.division, c.level, c.category, c.rama].filter(Boolean).join(' · ') || null : null);

export interface TeamEligibilityCtx { status: string | null; cat: CategoryLimits | null; category_name: string | null }

/**
 * Lo que hace falta para aplicar `playerEligibility` a varios equipos del MISMO torneo:
 * estado del equipo, límites de su categoría y la fecha del torneo. Tres consultas en lote (sin N+1).
 */
export async function eligibilityContext(teamIds: string[]): Promise<{ on: string; teams: Map<string, TeamEligibilityCtx> }> {
  const teams = new Map<string, TeamEligibilityCtx>();
  const today = new Date().toISOString().slice(0, 10);
  if (teamIds.length === 0) return { on: today, teams };
  const { data: tRaw } = await supabase.from('event_teams').select('id, event_id, category_id, status').in('id', teamIds);
  const tRows = (tRaw ?? []) as Array<{ id: string; event_id: string; category_id: string | null; status: string | null }>;
  const catIds = [...new Set(tRows.map((t) => t.category_id).filter(Boolean))] as string[];
  const eventId = tRows[0]?.event_id;
  const [{ data: cats }, { data: ev }] = await Promise.all([
    catIds.length ? supabase.from('event_categories_config').select(CAT_COLS).in('id', catIds) : Promise.resolve({ data: [] as any[] }),
    eventId ? supabase.from('events').select('event_date').eq('id', eventId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const catById = new Map(((cats ?? []) as any[]).map((c) => [c.id, c]));
  for (const t of tRows) {
    const c = t.category_id ? catById.get(t.category_id) ?? null : null;
    teams.set(t.id, { status: t.status, cat: c as CategoryLimits | null, category_name: categoryLabel(c) });
  }
  const d = (ev as any)?.event_date;
  return { on: d ? String(d).slice(0, 10) : today, teams };
}

/** Vista pública mínima del QR: nada de documento, teléfono ni fecha de nacimiento. */
export async function validateCardPublic(slug: string, token: string) {
  const parsed = parseCardToken(token);
  if (!parsed) return null;
  const { data: ev } = await supabase.from('events').select('id, title, slug, event_date, logo_url, card_config').eq('slug', slug).maybeSingle();
  if (!ev) return null;
  const { data: mRaw } = await supabase.from('event_team_members').select(MEMBER_COLS).eq('id', parsed.memberId).maybeSingle();
  const m = mRaw as MemberRow | null;
  if (!m) return null;
  const { data: tRaw } = await supabase.from('event_teams').select('id, event_id, team_name, category_id, logo_url, status').eq('id', m.team_id).maybeSingle();
  const t = tRaw as any;
  if (!t || t.event_id !== (ev as any).id) return null;
  const { data: cat } = t.category_id
    ? await supabase.from('event_categories_config').select('division, level, category, rama, age_min, age_max, birth_year_min, birth_year_max').eq('id', t.category_id).maybeSingle()
    : { data: null };
  let cfg = DEFAULT_CARD;
  try { if ((ev as any).card_config) cfg = validateCardConfig((ev as any).card_config); } catch { /* por defecto */ }

  const reasons: string[] = [];
  if ((m.card_version ?? 1) !== parsed.version) reasons.push('Este carné fue reemplazado por uno nuevo');
  const on = String((ev as any).event_date ?? new Date().toISOString()).slice(0, 10);
  reasons.push(...playerEligibility(m, cat as CategoryLimits | null, on, t.status).map((i) => i.reason));
  const c = cat as any;
  return {
    tournament: { title: (ev as any).title, logo_url: (ev as any).logo_url ?? null },
    player: {
      first_name: String(m.full_name).trim().split(/\s+/)[0] ?? '',
      photo_url: cfg.public_photo ? m.photo_url ?? null : null,
      shirt_number: m.shirt_number ?? null,
    },
    team: { name: t.team_name, logo_url: t.logo_url ?? null },
    category: c ? [c.division, c.level, c.category, c.rama].filter(Boolean).join(' · ') : null,
    status: reasons.length === 0 ? 'habilitado' : 'no_habilitado',
    reasons,
    checked_at: new Date().toISOString(),
  };
}

// ── Foto de la nómina en papel (OCR propio de nóminas: roster-sheet-ocr.service) ──

export interface SheetPlayer { full_name: string; shirt_number?: string; document_number?: string; birth_date?: string; position?: string }

/** Filas leídas → jugadores para REVISAR (no se guarda nada). Quita tachados, vacíos y repetidos. */
export function rosterFromSheet(rows: Array<{ name?: string | null; struck?: boolean; shirt_number?: string | null; document_number?: string | null; birth_date?: string | null; position?: string | null }>): SheetPlayer[] {
  const seen = new Set<string>();
  const out: SheetPlayer[] = [];
  for (const r of rows) {
    const name = String(r?.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || r?.struck || name.length > 120) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const p: SheetPlayer = { full_name: name };
    if (r.shirt_number) p.shirt_number = r.shirt_number;
    if (r.document_number) p.document_number = r.document_number;
    if (r.birth_date) p.birth_date = r.birth_date;
    if (r.position) p.position = r.position;
    out.push(p);
  }
  return out;
}

const OCR_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

export async function rosterFromPhoto(imageBase64: unknown, mime: unknown) {
  const m = String(mime ?? 'image/jpeg');
  if (!OCR_MIMES.includes(m)) throw new LiveError(400, 'formato_invalido', 'Sube una foto JPG, PNG o WEBP de la planilla');
  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) throw new LiveError(400, 'sin_foto', 'Falta la foto de la planilla');
  if (imageBase64.length > 4_500_000) throw new LiveError(413, 'foto_grande', 'La foto es muy pesada: tómala de nuevo o recórtala');
  const { extractRosterSheet } = await import('./roster-sheet-ocr.service');
  let result;
  try { result = await extractRosterSheet(imageBase64.replace(/^data:[^,]+,/, ''), m); }
  catch { throw new LiveError(502, 'ocr_no_disponible', 'No pudimos leer la foto ahora. Pega la lista o intenta en un rato.'); }
  const players = rosterFromSheet(result.rows ?? []);
  if (players.length === 0) throw new LiveError(422, 'sin_nombres', 'No encontramos nombres en la foto. Prueba con más luz o pega la lista.');
  return { players, title: result.title ?? null };
}

// ── Nómina para la planilla de juego (PDF) ───────────────────────────────────

const SHEET_FLAG: Record<EligibilityCode, string> = { equipo_rechazado: 'No habilitado', suspendido: 'Suspensión', edad: 'Fuera de edad' };

/** Marca corta para la planilla (no se esconde a nadie: el árbitro ve quién no puede jugar). */
export function sheetFlag(issues: EligibilityIssue[]): string | null {
  if (issues.length === 0) return null;
  const i = issues.find((x) => x.code === 'suspendido') ?? issues.find((x) => x.code === 'edad') ?? issues[0];
  if (i.code === 'edad' && /Sin fecha/.test(i.reason)) return 'Sin fecha de nacimiento';
  return SHEET_FLAG[i.code];
}

/** Nómina de los dos equipos de un partido con dorsal, categoría y la misma regla de habilitación del QR. */
export async function matchSheetRoster(ev: LiveEvent, matchId: string) {
  const { data: mRaw } = await supabase.from('tournament_matches').select('id, home_team_id, away_team_id').eq('id', matchId).eq('event_id', ev.id).maybeSingle();
  const match = mRaw as { home_team_id: string | null; away_team_id: string | null } | null;
  if (!match) throw new LiveError(404, 'partido_no_encontrado', 'Partido no encontrado');
  const teamIds = [match.home_team_id, match.away_team_id].filter(Boolean) as string[];
  const [{ data: members }, ctx] = await Promise.all([
    teamIds.length ? supabase.from('event_team_members').select(MEMBER_COLS).in('team_id', teamIds).order('full_name') : Promise.resolve({ data: [] as MemberRow[] }),
    eligibilityContext(teamIds),
  ]);
  const side = (tid: string | null) => ((members ?? []) as MemberRow[])
    .filter((m) => tid && m.team_id === tid)
    .map((m) => {
      const t = ctx.teams.get(m.team_id);
      return { id: m.id, name: m.full_name, shirt_number: m.shirt_number ?? null, flag: sheetFlag(playerEligibility(m, t?.cat ?? null, ctx.on, t?.status)) };
    })
    .sort((a, b) => (a.shirt_number ?? 999) - (b.shirt_number ?? 999) || a.name.localeCompare(b.name));
  const category = (match.home_team_id && ctx.teams.get(match.home_team_id)?.category_name) || (match.away_team_id && ctx.teams.get(match.away_team_id)?.category_name) || null;
  return { category, home: side(match.home_team_id), away: side(match.away_team_id) };
}
