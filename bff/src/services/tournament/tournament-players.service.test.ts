import { describe, it, expect, vi, beforeEach } from 'vitest';
// validateImageUrl compara contra el host de SUPABASE_URL; el CI lo fija en mock.supabase.co.
// Estas pruebas usan x.supabase.co, así que lo fijamos aquí (cada archivo corre aislado).
process.env.SUPABASE_URL = 'https://x.supabase.co';

vi.mock('../../config/supabase', async () => {
  const kit = await import('./fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});

import { db, resetDb, seedEvent, seedCategory, seedExternalTeam, seedTeams } from './fakeDb.testkit';
import { loadEvent, _clearPublicCache, publicLive, type LiveEvent } from './tournament-live.service';
import {
  addPlayers, listPlayers, updatePlayer, deletePlayer, savePlayerForm, validateForm, playerRow, DEFAULT_FORM,
  cardToken, parseCardToken, validateCardPublic, cardsFor, reissueCard, saveCardConfig, validateCardConfig, ageEligibility, ageOn,
  addFromSchool, schoolAthletes, rosterFromSheet, playerEligibility, matchSheetRoster, sheetFlag,
} from './tournament-players.service';
import { matchRoster } from './tournament-social.service';
import {
  createInvite, authInvite, inviteHome, inviteAddPlayers, inviteSubmit, inviteUpdateTeam, inviteUploadUrl, listInvites,
  inviteStage, markInvitePaid, revokeInvite, whatsappLink, CONSENT_VERSION, signupPrefill,
} from './tournament-invites.service';

let ev: LiveEvent;
let cat: string;
beforeEach(async () => {
  resetDb(); _clearPublicCache();
  const e = seedEvent({ status: 'active', event_date: '2026-11-07', live_enabled: true });
  cat = seedCategory(e.id);
  Object.assign(db.tables.event_categories_config[0], { age_min: 12, age_max: 14 });
  ev = (await loadEvent(e.id))!;
});

describe('formulario de jugador', () => {
  it('valida campos propios y obligatorios; el nombre siempre es obligatorio', () => {
    const f = validateForm({ required: ['shirt_number'], custom: [{ label: 'EPS', type: 'text', required: true }, { label: 'Talla', type: 'select', options: ['S', 'M', 'L'] }] });
    expect(f.required).toEqual(['full_name', 'shirt_number']);
    expect(f.custom.map((c) => c.key)).toEqual(['eps', 'talla']);
    expect(() => validateForm({ custom: [{ label: 'X', type: 'raro' }] })).toThrow(/Tipo inválido/);
    expect(() => validateForm({ custom: [{ label: 'Lista', type: 'select', options: ['a'] }] })).toThrow(/entre 2 y 30/);
    expect(() => validateForm({ custom: [{ label: 'EPS', type: 'text' }, { label: 'eps', type: 'text' }] })).toThrow(/repetido/);
    expect(() => playerRow({ full_name: 'Ana', extra: {} }, f)).toThrow(/número es obligatorio|Falta «EPS»/);
    expect(playerRow({ full_name: ' Ana  Ruiz ', shirt_number: '7', birth_date: '2013-05-01', extra: { eps: 'Sura', talla: 'M' } }, f))
      .toMatchObject({ full_name: 'Ana Ruiz', shirt_number: 7, birth_date: '2013-05-01', birth_year: 2013, extra: { eps: 'Sura', talla: 'M' } });
    expect(() => playerRow({ full_name: 'A', extra: { eps: 'x', talla: 'XL' }, shirt_number: 1 }, f)).toThrow(/no es una opción/);
    expect(() => playerRow({ full_name: 'A', birth_date: '01/05/2013' }, DEFAULT_FORM)).toThrow(/AAAA-MM-DD/);
  });
});

describe('jugadores en equipos externos', () => {
  it('se agregan (uno o planilla), se editan, se suspenden y se borran', async () => {
    const t = seedExternalTeam(ev.id, cat, 'Rival');
    await savePlayerForm(ev, { required: ['shirt_number'] });
    await expect(addPlayers(ev, t.id, [{ full_name: 'Ana', shirt_number: 1 }, { full_name: 'Bea' }])).rejects.toThrow(/Fila 2: El número es obligatorio/);
    expect(db.tables.event_team_members).toHaveLength(0); // si una fila falla no se guarda ninguna
    const added = await addPlayers(ev, t.id, [{ full_name: 'Ana', shirt_number: 1, phone: '3001234567' }, { full_name: 'Bea', shirt_number: 2 }]);
    expect(added).toHaveLength(2);
    expect(db.tables.event_team_members[0]).toMatchObject({ is_external: true, delegation_id: null, team_id: t.id });
    const upd = await updatePlayer(ev, added[0].id, { suspended: true, suspended_reason: 'Tarjeta roja' });
    expect(upd).toMatchObject({ suspended: true, suspended_reason: 'Tarjeta roja' });
    expect((await listPlayers(ev, t.id)).map((p) => p.full_name)).toEqual(['Ana', 'Bea']);
    await deletePlayer(ev, added[1].id);
    expect(await listPlayers(ev, t.id)).toHaveLength(1);
  });
  it('un equipo de otro torneo no se toca', async () => {
    const other = seedEvent({ slug: 'otro-torneo' });
    const t = seedExternalTeam(other.id, seedCategory(other.id), 'Ajeno');
    await expect(addPlayers(ev, t.id, [{ full_name: 'X' }])).rejects.toMatchObject({ status: 404 });
  });
  it('trae deportistas de la escuela a un equipo interno, sin duplicar', async () => {
    const [own] = seedTeams(ev.id, cat, 1);
    own.delegation_id = 'del-1';
    db.tables.children.push(
      { id: 'k1', school_id: 'school-1', is_active: true, full_name: 'Sofía Gómez', date_of_birth: '2013-02-02', doc_number: '123' },
      { id: 'k2', school_id: 'otra', is_active: true, full_name: 'Ajena', date_of_birth: null },
    );
    expect((await schoolAthletes(ev, 'sof')).map((k) => k.id)).toEqual(['k1']);
    expect(await addFromSchool(ev, own.id, ['k1', 'k2'])).toEqual({ added: 1 });
    expect(await addFromSchool(ev, own.id, ['k1'])).toEqual({ added: 0 });
    expect(db.tables.event_team_members[0]).toMatchObject({ child_id: 'k1', delegation_id: 'del-1', is_external: false, birth_year: 2013 });
    const ext = seedExternalTeam(ev.id, cat, 'Rival');
    await expect(addFromSchool(ev, ext.id, ['k1'])).rejects.toMatchObject({ code: 'equipo_externo' });
  });
  it('lee los nombres de la foto de la planilla quitando tachados y repetidos', () => {
    expect(rosterFromSheet([{ name: 'GÓMEZ Ana' }, { name: ' ' }, { name: 'Ruiz Bea', struck: true }, { name: 'gómez ana' }])).toEqual([{ full_name: 'GÓMEZ Ana' }]);
  });
});

describe('carné y validación en cancha', () => {
  it('el token va firmado: no se puede inventar ni alterar', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const tok = cardToken(id, 1, 'k');
    expect(parseCardToken(tok, 'k')).toEqual({ memberId: id, version: 1 });
    expect(parseCardToken(tok, 'otra-clave')).toBeNull();
    expect(parseCardToken(tok.replace('.1.', '.2.'), 'k')).toBeNull();
    expect(parseCardToken('basura', 'k')).toBeNull();
  });
  it('edad de la categoría con fecha o año de nacimiento', () => {
    expect(ageOn('2013-11-08', '2026-11-07')).toBe(12);
    expect(ageOn('2013-11-07', '2026-11-07')).toBe(13);
    const cat = { age_min: 12, age_max: 14 };
    expect(ageEligibility({ birth_date: '2013-01-01' }, cat, '2026-11-07')).toBeNull();
    expect(ageEligibility({ birth_date: '2010-01-01' }, cat, '2026-11-07')).toMatch(/Mayor/);
    expect(ageEligibility({ birth_date: '2016-01-01' }, cat, '2026-11-07')).toMatch(/Menor/);
    expect(ageEligibility({}, cat, '2026-11-07')).toMatch(/Sin fecha/);
    expect(ageEligibility({}, null, '2026-11-07')).toBeNull();
    expect(ageEligibility({ birth_year: 2012 }, { birth_year_min: 2013 }, '2026-11-07')).toMatch(/año/);
  });
  it('la vista pública muestra lo mínimo y dice Habilitado / No habilitado', async () => {
    const t = seedExternalTeam(ev.id, cat, 'Rival');
    const [ok, old] = await addPlayers(ev, t.id, [
      { full_name: 'Ana María Ruiz', birth_date: '2013-03-03', document_number: '1020304050', phone: '3001112233', shirt_number: 9 },
      { full_name: 'Bea López', birth_date: '2009-01-01' },
    ]);
    const cards = await cardsFor(ev, 'https://app.sportmaps.co');
    expect(cards.cards).toHaveLength(2);
    const c1 = cards.cards.find((c) => c.player.id === ok.id)!;
    expect(c1.validate_url).toBe(`https://app.sportmaps.co/torneo/${ev.slug}/validar/${c1.token}`);
    const v1 = (await validateCardPublic(ev.slug!, c1.token))!;
    expect(v1).toMatchObject({ status: 'habilitado', player: { first_name: 'Ana', shirt_number: 9 }, team: { name: 'Rival' } });
    const text = JSON.stringify(v1);
    for (const secret of ['1020304050', '3001112233', '2013-03-03', 'Ruiz']) expect(text).not.toContain(secret);

    const v2 = (await validateCardPublic(ev.slug!, cards.cards.find((c) => c.player.id === old.id)!.token))!;
    expect(v2.status).toBe('no_habilitado');
    expect(v2.reasons[0]).toMatch(/Mayor/);

    await updatePlayer(ev, ok.id, { suspended: true, suspended_reason: 'Doble amarilla' });
    expect((await validateCardPublic(ev.slug!, c1.token))!.reasons).toContain('Suspendido: Doble amarilla');
    await reissueCard(ev, ok.id);
    expect((await validateCardPublic(ev.slug!, c1.token))!.reasons).toContain('Este carné fue reemplazado por uno nuevo');
    expect(await validateCardPublic('otro-slug', c1.token)).toBeNull();
    expect(await validateCardPublic(ev.slug!, 'x.1.y')).toBeNull();
  });
  it('sin permiso del organizador la validación no muestra la foto', async () => {
    const t = seedExternalTeam(ev.id, cat, 'Rival');
    const [p] = await addPlayers(ev, t.id, [{ full_name: 'Ana', birth_date: '2013-01-01', photo_url: 'https://x.supabase.co/a.png' }]);
    const tok = cardToken(p.id, 1);
    expect((await validateCardPublic(ev.slug!, tok))!.player.photo_url).toBe('https://x.supabase.co/a.png');
    await saveCardConfig(ev, { public_photo: false, fields: ['shirt_number'] });
    expect((await validateCardPublic(ev.slug!, tok))!.player.photo_url).toBeNull();
    expect(() => validateCardConfig({ fields: ['a', 'b'] })).toThrow(/hasta 3/);
    expect(() => validateCardConfig({ color: 'rojo' })).toThrow(/color/);
  });
  it('el payload público nunca trae documento ni teléfono de jugadores', async () => {
    const t = seedExternalTeam(ev.id, cat, 'Rival');
    await addPlayers(ev, t.id, [{ full_name: 'Ana', document_number: '99887766', phone: '3159998877' }]);
    const out = JSON.stringify((await publicLive(ev.slug!))!.payload);
    expect(out).not.toContain('99887766');
    expect(out).not.toContain('3159998877');
  });
});

describe('link de inscripción del equipo', () => {
  const origin = 'https://app.sportmaps.co';
  it('flujo completo del delegado sin cuenta y avance para el organizador', async () => {
    const t = seedExternalTeam(ev.id, cat, 'Halcones');
    await expect(createInvite(ev, 'u1', t.id, {}, origin)).rejects.toMatchObject({ code: 'contacto_requerido' });
    const inv = await createInvite(ev, 'u1', t.id, { delegate_name: 'Carlos', delegate_phone: '300 123 4567', payment_amount: 150000, roster_target: 12 }, origin);
    expect(inv.url).toBe(`${origin}/torneo/${ev.slug}/equipo/${inv.token}`);
    expect(inv.whatsapp_url).toMatch(/^https:\/\/wa\.me\/573001234567\?text=/);
    expect(db.tables.tournament_team_invites[0].token_hash).not.toBe(inv.token);
    expect((await listInvites(ev))[0]).toMatchObject({ stage: 'enviado', payment_status: 'pending', players: 0 });

    const ctx = await authInvite(inv.token, loadEvent);
    const home = await inviteHome(ctx);
    expect(home).toMatchObject({ team: { name: 'Halcones' }, category: { age_min: 12 }, consent: { version: CONSENT_VERSION } });
    expect((await listInvites(ev))[0].stage).toBe('abierto');

    await inviteUpdateTeam(ctx, { colors: { primary: '#112233' }, short_name: 'hal' });
    await expect(inviteUpdateTeam(ctx, { colors: { primary: 'azul' } })).rejects.toMatchObject({ code: 'color_invalido' });
    await inviteAddPlayers(ctx, [{ full_name: 'Uno' }, { full_name: 'Dos' }]);
    expect((await listInvites(ev))[0]).toMatchObject({ stage: 'pago', players: 2 });

    await expect(inviteSubmit(ctx, { rules_accepted: true, consent: false })).rejects.toMatchObject({ code: 'consentimiento' });
    await expect(inviteSubmit(ctx, { rules_accepted: false, consent: true, consent_version: CONSENT_VERSION })).rejects.toMatchObject({ code: 'reglamento' });
    const up = await inviteUploadUrl(ctx, 'proof', 'application/pdf');
    expect(up.path.startsWith(`torneos/${ev.id}/`)).toBe(true);
    await expect(inviteSubmit(ctx, { rules_accepted: true, consent: true, consent_version: CONSENT_VERSION, payment_proof_path: 'otra/ruta.pdf' })).rejects.toMatchObject({ code: 'comprobante_invalido' });
    const done = await inviteSubmit(ctx, { rules_accepted: true, consent: true, consent_version: CONSENT_VERSION, payment_proof_path: up.path, wants_sportmaps: true });
    expect(done.stage).toBe('pago');
    const fresh = await authInvite(inv.token, loadEvent);
    expect(signupPrefill(fresh)).toMatchObject({ club_name: 'Halcones', contact_name: 'Carlos', origin: 'torneo' });
    expect(db.tables.tournament_team_invites[0]).toMatchObject({ consent_version: CONSENT_VERSION, payment_status: 'proof_sent' });

    await markInvitePaid(ev, fresh.invite.id, true);
    expect((await listInvites(ev))[0]).toMatchObject({ stage: 'listo', has_payment_proof: true, wants_sportmaps: true });
    await revokeInvite(ev, fresh.invite.id);
    await expect(authInvite(inv.token, loadEvent)).rejects.toMatchObject({ code: 'link_revocado' });
  });
  it('solo para externos, el link viejo deja de servir al regenerar y vence', async () => {
    const [own] = seedTeams(ev.id, cat, 1);
    await expect(createInvite(ev, 'u1', own.id, { delegate_phone: '3001234567' }, origin)).rejects.toMatchObject({ code: 'equipo_interno' });
    const t = seedExternalTeam(ev.id, cat, 'Halcones');
    const a = await createInvite(ev, 'u1', t.id, { delegate_email: 'd@x.co' }, origin);
    const b = await createInvite(ev, 'u1', t.id, { delegate_email: 'd@x.co' }, origin);
    expect(db.tables.tournament_team_invites).toHaveLength(1);
    await expect(authInvite(a.token, loadEvent)).rejects.toMatchObject({ code: 'link_invalido' });
    expect((await authInvite(b.token, loadEvent)).team.id).toBe(t.id);
    db.tables.tournament_team_invites[0].expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(authInvite(b.token, loadEvent)).rejects.toMatchObject({ code: 'link_vencido' });
  });
  it('etapas y WhatsApp', () => {
    const base = { revoked_at: null, expires_at: null, opened_at: null, roster_submitted_at: null, completed_at: null, payment_status: 'not_required' as const };
    expect(inviteStage(base)).toBe('enviado');
    expect(inviteStage({ ...base, opened_at: 'x' })).toBe('abierto');
    expect(inviteStage({ ...base, roster_submitted_at: 'x' })).toBe('nomina');
    expect(inviteStage({ ...base, roster_submitted_at: 'x', completed_at: 'x' })).toBe('listo');
    expect(whatsappLink(null, 'x')).toBeNull();
    expect(whatsappLink('+57 300 123 4567', 'hola')).toBe('https://wa.me/573001234567?text=hola');
  });
});

describe('habilitación: una sola regla para QR, etiquetador, MVP y planilla (E2E B13)', () => {
  const seedMatch = (home: string, away: string) => {
    const id = '11111111-1111-4111-8111-111111111111';
    db.tables.tournament_matches.push({ id, event_id: ev.id, home_team_id: home, away_team_id: away, status: 'live', version: 0 });
    return id;
  };
  it('playerEligibility: suspensión, edad y equipo rechazado', () => {
    const lim = { age_max: 14 };
    expect(playerEligibility({ birth_date: '2013-01-01' }, lim, '2026-11-07')).toEqual([]);
    expect(playerEligibility({ birth_date: '2010-01-01' }, lim, '2026-11-07').map((i) => i.code)).toEqual(['edad']);
    expect(playerEligibility({ suspended: true, birth_date: '2013-01-01' }, lim, '2026-11-07').map((i) => i.code)).toEqual(['suspendido']);
    expect(playerEligibility({ birth_date: '2013-01-01' }, lim, '2026-11-07', 'rejected').map((i) => i.code)).toEqual(['equipo_rechazado']);
    expect(sheetFlag(playerEligibility({ suspended: true, birth_date: '2010-01-01' }, lim, '2026-11-07'))).toBe('Suspensión');
    expect(sheetFlag(playerEligibility({ birth_date: '2010-01-01' }, lim, '2026-11-07'))).toBe('Fuera de edad');
    expect(sheetFlag(playerEligibility({}, lim, '2026-11-07'))).toBe('Sin fecha de nacimiento');
  });
  it('etiquetador / MVP sin suspendidas ni fuera de edad; la planilla las marca con dorsal y categoría', async () => {
    const [a, b] = seedTeams(ev.id, cat, 2);
    const [ok, susp, old] = await addPlayers(ev, a.id, [
      { full_name: 'Ana Ruiz', shirt_number: '9', birth_date: '2013-03-03' },
      { full_name: 'Bea Gómez', shirt_number: '4', birth_date: '2013-05-05' },
      { full_name: 'Carla Díaz', shirt_number: '12', birth_date: '2010-01-01' },
    ]);
    await updatePlayer(ev, susp.id, { suspended: true, suspended_reason: 'Doble amarilla' });
    await addPlayers(ev, b.id, [{ full_name: 'Zoe Paz', birth_date: '2012-12-12' }]);
    const matchId = seedMatch(a.id, b.id);

    const roster = await matchRoster({ home_team_id: a.id, away_team_id: b.id });
    const ids = roster.map((r) => r.id);
    expect(ids).toContain(ok.id);
    expect(ids).not.toContain(susp.id);
    expect(ids).not.toContain(old.id);
    expect(roster).toHaveLength(2);

    const sheet = await matchSheetRoster(ev, matchId);
    expect(sheet.category).toBe('Infantil · A · Sub 14 · Femenina');
    expect(sheet.home).toEqual([
      { id: susp.id, name: 'Bea Gómez', shirt_number: 4, flag: 'Suspensión' },
      { id: ok.id, name: 'Ana Ruiz', shirt_number: 9, flag: null },
      { id: old.id, name: 'Carla Díaz', shirt_number: 12, flag: 'Fuera de edad' },
    ]);
    expect(sheet.away).toHaveLength(1);
    await expect(matchSheetRoster(ev, '22222222-2222-4222-8222-222222222222')).rejects.toMatchObject({ code: 'partido_no_encontrado' });
  });
});

describe('foto de la nómina (E2E B4)', () => {
  it('rosterFromSheet conserva dorsal, documento, nacimiento y posición', () => {
    expect(rosterFromSheet([
      { name: 'Laura Pérez', shirt_number: '7', document_number: '1011111111', birth_date: '2012-03-04', position: null },
      { name: 'Sofía Gómez', shirt_number: null, document_number: null, birth_date: null, position: 'Líbero' },
    ])).toEqual([
      { full_name: 'Laura Pérez', shirt_number: '7', document_number: '1011111111', birth_date: '2012-03-04' },
      { full_name: 'Sofía Gómez', position: 'Líbero' },
    ]);
  });
});
