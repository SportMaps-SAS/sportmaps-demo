/**
 * Link de inscripción del equipo: el organizador crea un rival externo con su delegado y le manda un
 * enlace; el delegado (sin cuenta) pone logo y colores, sube la nómina (formulario, lista, planilla
 * CSV/Excel o foto de la planilla en papel con revisión), acepta el reglamento, da el consentimiento
 * de datos y, si el torneo cobra, sube el comprobante de la transferencia.
 *
 * El token es aleatorio (32 bytes) y solo se guarda su hash, como los anotadores sin cuenta.
 * Privacidad: lo que ve el delegado es SOLO su equipo; nada de esto sale en el payload público.
 */
import { randomBytes, randomUUID } from 'crypto';
import { supabase } from '../../config/supabase';
import { LiveError, cleanText, hashToken, validateImageUrl, type LiveEvent, invalidatePublicLive } from './tournament-live.service';
import { addPlayers, getPlayerForm, listPlayers } from './tournament-players.service';

export const CONSENT_VERSION = 'torneos-2026-10-27';
export const CONSENT_TEXT =
  'Autorizo a SportMaps y al organizador del torneo a tratar mis datos y los de los jugadores que inscribo '
  + '(incluidos menores de edad, con autorización de sus padres o acudientes) para organizar el torneo, emitir carnés '
  + 'y contactarme sobre SportMaps, según la Ley 1581 de 2012. Puedo consultar, corregir o pedir que se borren en cualquier momento.';

const INVITE_COLS = 'id, event_id, team_id, delegate_name, delegate_phone, delegate_email, expires_at, revoked_at, opened_at, team_colors, '
  + 'roster_target, roster_submitted_at, rules_accepted_at, consent_at, payment_status, payment_amount, payment_proof_path, completed_at, wants_sportmaps_at, created_at';

export interface InviteRow {
  id: string; event_id: string; team_id: string; delegate_name: string | null; delegate_phone: string | null; delegate_email: string | null;
  expires_at: string | null; revoked_at: string | null; opened_at: string | null; team_colors: { primary?: string; secondary?: string } | null;
  roster_target: number | null; roster_submitted_at: string | null; rules_accepted_at: string | null; consent_at: string | null;
  payment_status: 'not_required' | 'pending' | 'proof_sent' | 'paid'; payment_amount: number | null; payment_proof_path: string | null;
  completed_at: string | null; wants_sportmaps_at: string | null; created_at: string;
}

export type InviteStage = 'enviado' | 'abierto' | 'nomina' | 'pago' | 'listo' | 'revocado' | 'vencido';

/** Paso en el que va el equipo (lo que ve el organizador en Inscritos). */
export function inviteStage(i: Pick<InviteRow, 'revoked_at' | 'expires_at' | 'opened_at' | 'roster_submitted_at' | 'completed_at' | 'payment_status'>, now = Date.now()): InviteStage {
  if (i.revoked_at) return 'revocado';
  if (i.completed_at && (i.payment_status === 'not_required' || i.payment_status === 'paid')) return 'listo';
  if (i.expires_at && Date.parse(i.expires_at) < now) return 'vencido';
  if (i.roster_submitted_at && (i.payment_status === 'pending' || i.payment_status === 'proof_sent')) return 'pago';
  if (i.roster_submitted_at) return 'nomina';
  if (i.opened_at) return 'abierto';
  return 'enviado';
}

const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function inviteUrl(origin: string, slug: string | null, token: string) {
  return `${origin.replace(/\/$/, '')}/torneo/${slug}/equipo/${token}`;
}

/** WhatsApp: el número colombiano de 10 dígitos se completa con 57. */
export function whatsappLink(phone: string | null, text: string): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('3')) d = `57${d}`;
  if (d.length < 8) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/** Crea (o vuelve a generar) el link de un equipo EXTERNO. El token se muestra una sola vez. */
export async function createInvite(ev: LiveEvent, userId: string, teamId: string, body: Record<string, unknown>, origin: string) {
  const { data: team } = await supabase.from('event_teams').select('id, team_name, is_external, status').eq('id', teamId).eq('event_id', ev.id).maybeSingle();
  const t = team as any;
  if (!t || t.status === 'rejected') throw new LiveError(404, 'equipo_no_encontrado', 'Equipo no encontrado');
  if (!t.is_external) throw new LiveError(400, 'equipo_interno', 'El link de inscripción es para equipos externos');
  const phone = cleanText(body.delegate_phone, 30, 'El celular');
  const email = cleanText(body.delegate_email, 160, 'El correo');
  if (!phone && !email) throw new LiveError(400, 'contacto_requerido', 'Escribe el celular o el correo del delegado');
  if (phone && !PHONE.test(phone)) throw new LiveError(400, 'celular_invalido', 'El celular no es válido');
  if (email && !EMAIL.test(email)) throw new LiveError(400, 'correo_invalido', 'El correo no es válido');
  let expires: string | null = null;
  if (body.expires_at) {
    const tms = Date.parse(String(body.expires_at));
    if (!Number.isFinite(tms) || tms < Date.now()) throw new LiveError(400, 'vencimiento_invalido', 'La fecha de vencimiento debe ser futura');
    expires = new Date(tms).toISOString();
  }
  const target = body.roster_target == null || body.roster_target === '' ? null : Number(body.roster_target);
  if (target != null && (!Number.isInteger(target) || target < 1 || target > 200)) throw new LiveError(400, 'nomina_invalida', 'La nómina esperada debe estar entre 1 y 200');
  const amount = body.payment_amount == null || body.payment_amount === '' ? null : Number(body.payment_amount);
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) throw new LiveError(400, 'monto_invalido', 'El valor de la inscripción no es válido');

  const token = randomBytes(32).toString('base64url');
  const row = {
    event_id: ev.id, team_id: teamId, token_hash: hashToken(token), delegate_name: cleanText(body.delegate_name, 120, 'El nombre del delegado'),
    delegate_phone: phone, delegate_email: email, expires_at: expires, revoked_at: null, roster_target: target,
    payment_amount: amount, payment_status: amount && amount > 0 ? 'pending' : 'not_required', created_by: userId, updated_at: new Date().toISOString(),
  };
  const { data: prev } = await supabase.from('tournament_team_invites').select('id').eq('team_id', teamId).maybeSingle();
  const q = prev
    ? supabase.from('tournament_team_invites').update(row).eq('id', (prev as any).id).select(INVITE_COLS).single()
    : supabase.from('tournament_team_invites').insert(row).select(INVITE_COLS).single();
  const { data, error } = await q;
  if (error || !data) throw new LiveError(500, 'error_guardando', 'No se pudo crear el link');
  const url = inviteUrl(origin, ev.slug, token);
  const msg = `Hola${row.delegate_name ? ` ${row.delegate_name}` : ''}: inscribe a ${t.team_name} en «${ev.title}». Sube el logo y la nómina aquí: ${url}`;
  return { invite: toInviteDto(data as unknown as InviteRow), url, token, whatsapp_url: whatsappLink(phone, msg) };
}

export function toInviteDto(i: InviteRow, players?: number) {
  return {
    id: i.id, team_id: i.team_id, delegate_name: i.delegate_name, delegate_phone: i.delegate_phone, delegate_email: i.delegate_email,
    expires_at: i.expires_at, opened_at: i.opened_at, roster_target: i.roster_target, roster_submitted_at: i.roster_submitted_at,
    rules_accepted_at: i.rules_accepted_at, consent_at: i.consent_at, payment_status: i.payment_status, payment_amount: i.payment_amount,
    has_payment_proof: !!i.payment_proof_path, completed_at: i.completed_at, wants_sportmaps: !!i.wants_sportmaps_at,
    stage: inviteStage(i), players: players ?? null,
  };
}

/** Avance de cada equipo invitado (organizador). */
export async function listInvites(ev: LiveEvent) {
  const { data, error } = await supabase.from('tournament_team_invites').select(INVITE_COLS).eq('event_id', ev.id);
  if (error) return [];
  const rows = (data ?? []) as unknown as InviteRow[];
  if (rows.length === 0) return [];
  const { data: members } = await supabase.from('event_team_members').select('team_id').in('team_id', rows.map((r) => r.team_id));
  const count = new Map<string, number>();
  for (const m of (members ?? []) as any[]) count.set(m.team_id, (count.get(m.team_id) ?? 0) + 1);
  return rows.map((r) => toInviteDto(r, count.get(r.team_id) ?? 0));
}

export async function revokeInvite(ev: LiveEvent, inviteId: string) {
  await supabase.from('tournament_team_invites').update({ revoked_at: new Date().toISOString() }).eq('id', inviteId).eq('event_id', ev.id);
  return { success: true };
}

/** El organizador confirma la transferencia. */
export async function markInvitePaid(ev: LiveEvent, inviteId: string, paid: boolean) {
  await supabase.from('tournament_team_invites').update({ payment_status: paid ? 'paid' : 'pending', updated_at: new Date().toISOString() }).eq('id', inviteId).eq('event_id', ev.id);
  return { success: true };
}

export async function invitePaymentProofUrl(ev: LiveEvent, inviteId: string) {
  const { data } = await supabase.from('tournament_team_invites').select('payment_proof_path').eq('id', inviteId).eq('event_id', ev.id).maybeSingle();
  const path = (data as any)?.payment_proof_path;
  if (!path) throw new LiveError(404, 'sin_comprobante', 'Este equipo aún no sube el comprobante');
  const { data: signed } = await supabase.storage.from(PROOF_BUCKET).createSignedUrl(path, 600);
  return { url: (signed as any)?.signedUrl ?? null };
}

// ── Lado del delegado (token) ────────────────────────────────────────────────

const PROOF_BUCKET = 'payment-receipts';
const ASSET_BUCKET = 'school-assets';

export interface InviteCtx { invite: InviteRow; ev: LiveEvent & { attachments?: any; rules_url?: string | null }; team: { id: string; team_name: string; logo_url: string | null; short_name: string | null; category_id: string | null } }

export async function authInvite(token: string, loadEvent: (id: string) => Promise<LiveEvent | null>): Promise<InviteCtx> {
  if (!token || token.length < 20 || token.length > 100) throw new LiveError(401, 'link_invalido', 'Este link no es válido');
  const { data } = await supabase.from('tournament_team_invites').select(INVITE_COLS).eq('token_hash', hashToken(token)).maybeSingle();
  const invite = data as unknown as InviteRow | null;
  if (!invite) throw new LiveError(401, 'link_invalido', 'Este link no es válido');
  if (invite.revoked_at) throw new LiveError(403, 'link_revocado', 'El organizador desactivó este link. Pídele uno nuevo.');
  if (invite.expires_at && Date.parse(invite.expires_at) < Date.now()) throw new LiveError(403, 'link_vencido', 'Este link venció. Pídele uno nuevo al organizador.');
  const ev = await loadEvent(invite.event_id);
  if (!ev) throw new LiveError(404, 'torneo_no_encontrado', 'Torneo no encontrado');
  const { data: t } = await supabase.from('event_teams').select('id, team_name, logo_url, short_name, category_id').eq('id', invite.team_id).maybeSingle();
  if (!t) throw new LiveError(404, 'equipo_no_encontrado', 'Equipo no encontrado');
  return { invite, ev, team: t as any };
}

/** Lo que ve el delegado: su equipo, el formulario, su nómina, el reglamento y el estado del pago. */
export async function inviteHome(ctx: InviteCtx) {
  if (!ctx.invite.opened_at) {
    await supabase.from('tournament_team_invites').update({ opened_at: new Date().toISOString() }).eq('id', ctx.invite.id);
  }
  const [form, players, cat, attachments] = await Promise.all([
    getPlayerForm(ctx.ev),
    listPlayers(ctx.ev, ctx.team.id),
    ctx.team.category_id ? supabase.from('event_categories_config').select('division, level, category, rama, age_min, age_max').eq('id', ctx.team.category_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('events').select('attachments, rules_url, logo_url').eq('id', ctx.ev.id).maybeSingle(),
  ]);
  const c = (cat as any).data;
  const e = (attachments as any).data ?? {};
  return {
    tournament: { title: ctx.ev.title, sport: ctx.ev.sport, slug: ctx.ev.slug, event_date: ctx.ev.event_date, logo_url: e.logo_url ?? null, rules_url: e.rules_url ?? null, attachments: Array.isArray(e.attachments) ? e.attachments : [] },
    team: { id: ctx.team.id, name: ctx.team.team_name, logo_url: ctx.team.logo_url, short_name: ctx.team.short_name, colors: ctx.invite.team_colors ?? null },
    category: c ? { name: [c.division, c.level, c.category, c.rama].filter(Boolean).join(' · '), age_min: c.age_min ?? null, age_max: c.age_max ?? null } : null,
    form, players,
    invite: toInviteDto(ctx.invite, players.length),
    consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

export async function inviteUpdateTeam(ctx: InviteCtx, body: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if ('logo_url' in body) patch.logo_url = validateImageUrl(body.logo_url, 'El logo');
  if ('short_name' in body) { const s = cleanText(body.short_name, 4, 'La sigla'); patch.short_name = s ? s.toUpperCase() : null; }
  if (Object.keys(patch).length) {
    await supabase.from('event_teams').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', ctx.team.id);
    invalidatePublicLive();
  }
  if ('colors' in body) {
    const c = (body.colors ?? {}) as Record<string, unknown>;
    const colors: Record<string, string> = {};
    for (const k of ['primary', 'secondary']) {
      if (c[k] == null || c[k] === '') continue;
      if (!HEX.test(String(c[k]))) throw new LiveError(400, 'color_invalido', 'Los colores deben ser como #1E40AF');
      colors[k] = String(c[k]);
    }
    await supabase.from('tournament_team_invites').update({ team_colors: colors, updated_at: new Date().toISOString() }).eq('id', ctx.invite.id);
  }
  return { success: true };
}

export async function inviteAddPlayers(ctx: InviteCtx, rows: unknown) {
  const out = await addPlayers(ctx.ev, ctx.team.id, rows);
  await supabase.from('tournament_team_invites').update({ roster_submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', ctx.invite.id);
  return out;
}

export async function inviteRemovePlayer(ctx: InviteCtx, playerId: string) {
  const { data } = await supabase.from('event_team_members').select('id, team_id').eq('id', playerId).maybeSingle();
  if (!data || (data as any).team_id !== ctx.team.id) throw new LiveError(404, 'jugador_no_encontrado', 'Jugador no encontrado');
  await supabase.from('event_team_members').delete().eq('id', playerId);
  return { success: true };
}

const IMG_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PROOF_EXT: Record<string, string> = { ...IMG_EXT, 'application/pdf': 'pdf' };

/** URL firmada para subir el logo / fotos (bucket público) o el comprobante (bucket privado). */
export async function inviteUploadUrl(ctx: InviteCtx, kind: unknown, mime: unknown) {
  const k = String(kind);
  if (k === 'proof') {
    const ext = PROOF_EXT[String(mime)];
    if (!ext) throw new LiveError(400, 'formato_invalido', 'Sube el comprobante en JPG, PNG, WEBP o PDF');
    const path = `torneos/${ctx.ev.id}/${ctx.invite.id}/${randomUUID()}.${ext}`;
    const { data, error } = await supabase.storage.from(PROOF_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new LiveError(500, 'error_subida', 'No se pudo preparar la subida');
    return { bucket: PROOF_BUCKET, path, token: (data as any).token, signedUrl: (data as any).signedUrl, public_url: null };
  }
  if (k !== 'logo' && k !== 'photo') throw new LiveError(400, 'tipo_invalido', 'Tipo de archivo inválido');
  const ext = IMG_EXT[String(mime)];
  if (!ext) throw new LiveError(400, 'formato_invalido', 'Sube una imagen JPG, PNG o WEBP');
  if (!ctx.ev.school_id) throw new LiveError(400, 'sin_escuela', 'Este torneo no tiene carpeta de imágenes');
  // logos/<school_id>/… : la misma carpeta donde escribe el organizador (lectura pública del bucket).
  const path = `logos/${ctx.ev.school_id}/torneos/${ctx.ev.id}/equipos/${ctx.team.id}/${randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage.from(ASSET_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new LiveError(500, 'error_subida', 'No se pudo preparar la subida');
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return { bucket: ASSET_BUCKET, path, token: (data as any).token, signedUrl: (data as any).signedUrl, public_url: `${base}/storage/v1/object/public/${ASSET_BUCKET}/${path}` };
}

/** Cierre: reglamento + consentimiento (obligatorios), comprobante si hay cobro. */
export async function inviteSubmit(ctx: InviteCtx, body: Record<string, unknown>) {
  if (body.rules_accepted !== true) throw new LiveError(400, 'reglamento', 'Debes aceptar el reglamento del torneo');
  if (body.consent !== true || body.consent_version !== CONSENT_VERSION) throw new LiveError(400, 'consentimiento', 'Debes autorizar el tratamiento de datos para inscribir al equipo');
  const players = await listPlayers(ctx.ev, ctx.team.id);
  if (players.length === 0) throw new LiveError(400, 'sin_nomina', 'Sube al menos un jugador');
  const patch: Record<string, unknown> = {
    rules_accepted_at: new Date().toISOString(), consent_at: new Date().toISOString(), consent_version: CONSENT_VERSION,
    completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (ctx.invite.payment_status === 'pending' || ctx.invite.payment_status === 'proof_sent') {
    const proof = body.payment_proof_path ? String(body.payment_proof_path) : null;
    if (proof) {
      if (!proof.startsWith(`torneos/${ctx.ev.id}/${ctx.invite.id}/`)) throw new LiveError(400, 'comprobante_invalido', 'El comprobante no es válido');
      patch.payment_proof_path = proof;
      patch.payment_status = 'proof_sent';
    }
  }
  if (body.wants_sportmaps === true) patch.wants_sportmaps_at = new Date().toISOString();
  await supabase.from('tournament_team_invites').update(patch).eq('id', ctx.invite.id);
  return { success: true, stage: inviteStage({ ...ctx.invite, ...patch } as InviteRow) };
}

/** Datos para precargar el registro «Prueba gratis» (solo si dio el consentimiento). */
export function signupPrefill(ctx: InviteCtx) {
  if (!ctx.invite.consent_at) return null;
  return { club_name: ctx.team.team_name, contact_name: ctx.invite.delegate_name, phone: ctx.invite.delegate_phone, email: ctx.invite.delegate_email, sport: ctx.ev.sport, origin: 'torneo' };
}

