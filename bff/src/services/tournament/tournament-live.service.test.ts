import { describe, it, expect, vi, beforeEach } from 'vitest';
// validateImageUrl compara contra el host de SUPABASE_URL; el CI lo fija en mock.supabase.co.
// Estas pruebas usan x.supabase.co, así que lo fijamos aquí (cada archivo corre aislado).
process.env.SUPABASE_URL = 'https://x.supabase.co';

vi.mock('../../config/supabase', async () => {
  const kit = await import('./fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});

import { db, resetDb, seedEvent, seedTeams, seedCategory, seedExternalTeam } from './fakeDb.testkit';
import {
  LiveError, loadEvent, loadMatches, performMatchAction, generateCategoryFixtures, buildCategoryStandings, patchConfig, getConfig,
  createScorekeeper, authScorekeeper, revokeScorekeeper, scorerMatches, publicLive, _clearPublicCache, takeMatch, validateStreamUrl,
  Actor, LiveEvent,
  addExternalTeams, updateTeam, deleteExternalTeam, listTeams, createSponsor, updateSponsor, deleteSponsor, listSponsors,
  rescheduleMatch, publicStatus, validateImageUrl, isMissingColumn,
} from './tournament-live.service';
import { SCORING_PRESETS } from './scoring.shared';

const admin: Actor = { type: 'user', id: 'u1', label: 'Administración' };
const volleyCfg = { ...SCORING_PRESETS.voleibol_3.config };

async function setup(opts: { live?: boolean; scoring?: any; teams?: number } = {}) {
  resetDb(); _clearPublicCache();
  const ev = seedEvent({ live_enabled: opts.live ?? true, scoring_config: opts.scoring === undefined ? volleyCfg : opts.scoring });
  const cat = seedCategory(ev.id);
  seedTeams(ev.id, cat, opts.teams ?? 4);
  const live = (await loadEvent(ev.id)) as LiveEvent;
  return { ev: live, cat };
}

const act = (ev: LiveEvent, matchId: string, action: any, extra: Record<string, any> = {}, actor: Actor = admin) =>
  performMatchAction(ev, matchId, actor, { action, ...extra });

/** Juega un partido de vóley completo: gana `winner` por 2-0 (o 2-1 si `three`). */
async function playVolley(ev: LiveEvent, matchId: string, winner: 'home' | 'away', three = false) {
  await act(ev, matchId, { type: 'start' });
  const w = winner, l = winner === 'home' ? 'away' : 'home';
  const pts = async (side: 'home' | 'away', n: number) => { for (let i = 0; i < n; i++) await act(ev, matchId, { type: 'point', side }); };
  if (three) { await pts(w, 25); await pts(l, 25); await pts(w, 15); } else { await pts(w, 25); await pts(w, 25); }
  return act(ev, matchId, { type: 'finish' });
}

describe('performMatchAction — vía única', () => {
  it('start → puntos → finish guarda estado, marcador, versión y log', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    const r = await playVolley(ev, m.id, 'home');
    expect(r.match.status).toBe('played');
    expect(r.match.home_score).toBe(2);
    expect(r.match.away_score).toBe(0);
    expect(r.match.sets).toHaveLength(2);
    const row = db.tables.tournament_matches.find((x) => x.id === m.id)!;
    expect(row.version).toBe(52); // start + 50 puntos + finish
    expect(row.finished_at).toBeTruthy();
    expect(db.tables.tournament_match_log).toHaveLength(52);
    expect(db.tables.tournament_match_log[0]).toMatchObject({ action: 'start', actor_type: 'user' });
  });

  it('un reintento con el mismo client_action_id no se aplica dos veces', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    const first = await act(ev, m.id, { type: 'point', side: 'home' }, { client_action_id: 'abc' });
    const again = await act(ev, m.id, { type: 'point', side: 'home' }, { client_action_id: 'abc' });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(db.tables.tournament_matches.find((x) => x.id === m.id)!.live_state.points).toBe('h');
    expect(db.tables.tournament_match_log.filter((l) => l.client_action_id === 'abc')).toHaveLength(1);
  });

  it('dos acciones con la misma versión: una se aplica y la otra recibe conflicto con el partido actual', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    const v = db.tables.tournament_matches.find((x) => x.id === m.id)!.version;
    await act(ev, m.id, { type: 'point', side: 'home' }, { expected_version: v });
    await expect(act(ev, m.id, { type: 'point', side: 'away' }, { expected_version: v })).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
    try { await act(ev, m.id, { type: 'point', side: 'away' }, { expected_version: v }); } catch (e: any) { expect(e.extra.match.version).toBe(v + 1); }
  });

  it('reglas del motor: terminar sin ganador → 422', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    await expect(act(ev, m.id, { type: 'finish' })).rejects.toMatchObject({ status: 422, code: 'no_decidido' });
  });

  it('con «en vivo» apagado solo se carga el resultado final; iniciar da 403', async () => {
    const { ev, cat } = await setup({ live: false, teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await expect(act(ev, m.id, { type: 'start' })).rejects.toMatchObject({ status: 403, code: 'live_disabled' });
    const r = await act(ev, m.id, { type: 'correct', sets: [[25, 23], [20, 25], [15, 12]] });
    expect(r.match).toMatchObject({ status: 'played', home_score: 2, away_score: 1 });
    // y se puede corregir un resultado ya cargado
    const fix = await act(ev, m.id, { type: 'correct', sets: [[25, 10], [25, 10]] });
    expect(fix.match.away_score).toBe(0);
  });

  it('el interruptor global apaga lo en vivo en todos los torneos', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    process.env.TOURNAMENT_LIVE_DISABLED = 'true';
    try { await expect(act(ev, m.id, { type: 'start' })).rejects.toMatchObject({ code: 'live_disabled' }); }
    finally { delete process.env.TOURNAMENT_LIVE_DISABLED; }
  });

  it('un partido sin los dos equipos no se puede anotar', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await generateCategoryFixtures(ev, cat, 'copa', { seed: 1 });
    const final = (await loadMatches(ev.id, cat)).find((x) => x.round === 2)!;
    await expect(act(ev, final.id, { type: 'start' })).rejects.toMatchObject({ code: 'equipos_sin_definir' });
  });

  it('un anotador activo por partido: otro necesita tomarlo', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    const mesa: Actor = { type: 'scorekeeper', id: 's1', label: 'Mesa cancha 1' };
    await expect(act(ev, m.id, { type: 'point', side: 'home' }, {}, mesa)).rejects.toMatchObject({ status: 409, code: 'otro_anotador' });
    await takeMatch(ev, m.id, mesa);
    const ok = await act(ev, m.id, { type: 'point', side: 'home' }, {}, mesa);
    expect(ok.match.home_score).toBe(0);
    expect(db.tables.tournament_matches.find((x) => x.id === m.id)!.scorer_label).toBe('Mesa cancha 1');
  });

  it('acción inválida → 400', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await expect(act(ev, m.id, { type: 'explotar' })).rejects.toMatchObject({ status: 400 });
  });

  it('fútbol sin configuración: «cargar resultado» como antes, y avisa a las familias', async () => {
    const { ev, cat } = await setup({ live: false, scoring: null, teams: 2 });
    const [t1] = db.tables.event_teams;
    db.tables.event_team_members.push({ team_id: t1.id, profile_id: 'p1', child_id: null });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    const r = await act(ev, m.id, { type: 'correct', home: 3, away: 1 });
    expect(r.match).toMatchObject({ status: 'played', home_score: 3, away_score: 1, model: 'goals' });
    await new Promise((res) => setTimeout(res, 10));
    expect(db.tables.notifications).toHaveLength(1);
    expect(db.tables.notifications[0].message).not.toMatch(/podés/);
  });
});

describe('copa', () => {
  it('los ganadores avanzan y el tercer puesto recibe a los perdedores', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await generateCategoryFixtures(ev, cat, 'copa', { seed: 3, third_place: true });
    let ms = await loadMatches(ev.id, cat);
    const semis = ms.filter((m) => m.stage === 'knockout' && m.round === 1);
    await playVolley(ev, semis[0].id, 'home');
    await playVolley(ev, semis[1].id, 'away');
    ms = await loadMatches(ev.id, cat);
    const final = ms.find((m) => m.stage === 'knockout' && m.round === 2)!;
    const third = ms.find((m) => m.stage === 'third_place')!;
    expect(final.home_team_id).toBe(semis[0].home_team_id);
    expect(final.away_team_id).toBe(semis[1].away_team_id);
    expect(third.home_team_id).toBe(semis[0].away_team_id);
    expect(third.away_team_id).toBe(semis[1].home_team_id);
  });

  it('en eliminatoria un empate en goles se rechaza', async () => {
    const { ev, cat } = await setup({ live: false, scoring: null, teams: 4 });
    await generateCategoryFixtures(ev, cat, 'copa', { seed: 1 });
    const m = (await loadMatches(ev.id, cat)).find((x) => x.round === 1)!;
    await expect(act(ev, m.id, { type: 'correct', home: 1, away: 1 })).rejects.toMatchObject({ code: 'empate_no_permitido' });
  });

  it('no se puede cambiar un semifinal si la final ya empezó con otro ganador', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await generateCategoryFixtures(ev, cat, 'copa', { seed: 3 });
    const semis = (await loadMatches(ev.id, cat)).filter((m) => m.round === 1);
    await playVolley(ev, semis[0].id, 'home');
    await playVolley(ev, semis[1].id, 'home');
    const final = (await loadMatches(ev.id, cat)).find((m) => m.round === 2)!;
    await act(ev, final.id, { type: 'start' });
    await expect(act(ev, semis[0].id, { type: 'reopen' })).rejects.toMatchObject({ code: 'siguiente_ronda_en_curso' });
    await expect(act(ev, semis[0].id, { type: 'correct', sets: [[10, 25], [10, 25]] })).rejects.toMatchObject({ code: 'siguiente_ronda_en_curso' });
  });

  it('corregir un semifinal con la final aún programada recalcula el finalista', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await generateCategoryFixtures(ev, cat, 'copa', { seed: 3 });
    const semis = (await loadMatches(ev.id, cat)).filter((m) => m.round === 1);
    await playVolley(ev, semis[0].id, 'home');
    await act(ev, semis[0].id, { type: 'correct', sets: [[10, 25], [10, 25]] });
    const final = (await loadMatches(ev.id, cat)).find((m) => m.round === 2)!;
    expect(final.home_team_id).toBe(semis[0].away_team_id);
  });

  it('con 3 equipos el bye pasa solo a la siguiente ronda', async () => {
    const { ev, cat } = await setup({ teams: 3 });
    await generateCategoryFixtures(ev, cat, 'copa', { seed: 1 });
    const ms = await loadMatches(ev.id, cat);
    const bye = ms.find((m) => m.round === 1 && m.status === 'walkover')!;
    expect(bye).toBeTruthy();
    const final = ms.find((m) => m.round === 2)!;
    expect(final.home_team_id || final.away_team_id).toBeTruthy();
  });
});

describe('grupos + fase final (torneo completo)', () => {
  it('8 equipos, 2 grupos: al terminar los grupos se arman los cruces y se juega hasta la final', async () => {
    const { ev, cat } = await setup({ teams: 8 });
    const gen = await generateCategoryFixtures(ev, cat, 'grupos', { seed: 7, groups: { count: 2, advance: 2 } });
    expect(gen.matches).toBe(15);

    let ms = await loadMatches(ev.id, cat);
    const groupMs = ms.filter((m) => m.stage === 'group');
    expect(groupMs).toHaveLength(12);
    // antes de terminar los grupos la fase final no tiene equipos
    expect(ms.filter((m) => m.stage === 'knockout' && m.round === 1).every((m) => !m.home_team_id && !m.away_team_id)).toBe(true);

    // gana siempre el local de cada partido de grupo, 2-0
    for (const g of groupMs) await playVolley(ev, g.id, 'home');

    ms = await loadMatches(ev.id, cat);
    const semis = ms.filter((m) => m.stage === 'knockout' && m.round === 1);
    expect(semis.every((m) => m.home_team_id && m.away_team_id)).toBe(true);
    const st = await buildCategoryStandings(ev, cat);
    expect(Object.keys(st.groups!)).toEqual(['A', 'B']);
    const firstA = st.groups!.A[0].team_id, secondA = st.groups!.A[1].team_id;
    const firstB = st.groups!.B[0].team_id, secondB = st.groups!.B[1].team_id;
    const pairs = semis.map((m) => [m.home_team_id, m.away_team_id].sort().join('|'));
    expect(pairs.sort()).toEqual([[firstA, secondB].sort().join('|'), [firstB, secondA].sort().join('|')].sort());

    await playVolley(ev, semis[0].id, 'home');
    await playVolley(ev, semis[1].id, 'away');
    const final = (await loadMatches(ev.id, cat)).find((m) => m.stage === 'knockout' && m.round === 2)!;
    expect(final.home_team_id && final.away_team_id).toBeTruthy();
    const done = await playVolley(ev, final.id, 'home', true);
    expect(done.match).toMatchObject({ status: 'played', home_score: 2, away_score: 1 });
  });

  it('corregir un partido de grupo después de armada la fase final recalcula si no empezó', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await generateCategoryFixtures(ev, cat, 'grupos', { seed: 2, groups: { count: 1, advance: 2 } });
    const groupMs = (await loadMatches(ev.id, cat)).filter((m) => m.stage === 'group');
    for (const g of groupMs) await playVolley(ev, g.id, 'home');
    let final = (await loadMatches(ev.id, cat)).find((m) => m.stage === 'knockout')!;
    expect(final.home_team_id && final.away_team_id).toBeTruthy();

    // invertimos TODOS los resultados: cambian los clasificados mientras la fase final no empezó
    for (const g of groupMs) await act(ev, g.id, { type: 'correct', sets: [[10, 25], [10, 25]] });
    final = (await loadMatches(ev.id, cat)).find((m) => m.stage === 'knockout')!;
    expect(final.home_team_id && final.away_team_id).toBeTruthy();
  });

  it('si la fase final ya empezó, corregir un grupo guarda el marcador pero avisa que no cambia los cruces', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await generateCategoryFixtures(ev, cat, 'grupos', { seed: 2, groups: { count: 1, advance: 2 } });
    const groupMs = (await loadMatches(ev.id, cat)).filter((m) => m.stage === 'group');
    for (const g of groupMs) await playVolley(ev, g.id, 'home');
    const final = (await loadMatches(ev.id, cat)).find((m) => m.stage === 'knockout')!;
    await act(ev, final.id, { type: 'start' });
    let warning: string | undefined;
    for (const g of groupMs) { const r: any = await act(ev, g.id, { type: 'correct', sets: [[10, 25], [10, 25]] }); warning = warning ?? r.warning; }
    expect(warning).toMatch(/fase final ya empezó/);
  });
});

describe('generateCategoryFixtures', () => {
  it('valida la configuración con mensaje legible', async () => {
    const { ev, cat } = await setup({ teams: 3 });
    await expect(generateCategoryFixtures(ev, cat, 'grupos', { groups: { count: 3, advance: 1 } })).rejects.toMatchObject({ status: 400, code: 'config_invalida' });
    await expect(generateCategoryFixtures(ev, cat, 'quiniela' as any, {})).rejects.toMatchObject({ code: 'formato_invalido' });
  });
  it('regenerar reemplaza lo programado; con partidos jugados se bloquea', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const a = (await loadMatches(ev.id, cat)).length;
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 2, double_round: true });
    expect((await loadMatches(ev.id, cat)).length).toBe(a * 2);
    const [m] = await loadMatches(ev.id, cat);
    await playVolley(ev, m.id, 'home');
    await expect(generateCategoryFixtures(ev, cat, 'copa', {})).rejects.toMatchObject({ status: 409, code: 'hay_partidos_jugados' });
  });
  it('guarda formato, semilla y reglas en el torneo; liga parcial y con calendario', async () => {
    const { ev, cat } = await setup({ teams: 6 });
    const r = await generateCategoryFixtures(ev, cat, 'liga', { seed: 'x', matches_per_team: 2, schedule: { start: '2026-11-07T08:00:00-05:00', courts: 2, slot_minutes: 50 } });
    expect(r.matches).toBe(6);
    const stored = db.tables.events.find((e) => e.id === ev.id)!;
    expect(stored.competition_format).toBe('liga');
    expect(stored.format_config.matches_per_team).toBe(2);
    const ms = await loadMatches(ev.id, cat);
    expect(ms.every((m) => m.court && m.scheduled_at)).toBe(true);
  });
  it('los tres formatos conviven en categorías distintas del mismo torneo', async () => {
    resetDb(); _clearPublicCache();
    const e = seedEvent({ scoring_config: volleyCfg, live_enabled: true });
    const c1 = seedCategory(e.id), c2 = seedCategory(e.id), c3 = seedCategory(e.id);
    seedTeams(e.id, c1, 4); seedTeams(e.id, c2, 4); seedTeams(e.id, c3, 8);
    const ev = (await loadEvent(e.id)) as LiveEvent;
    await generateCategoryFixtures(ev, c1, 'liga', { seed: 1 });
    await generateCategoryFixtures(ev, c2, 'copa', { seed: 1 });
    await generateCategoryFixtures(ev, c3, 'grupos', { seed: 1, groups: { count: 2, advance: 2 } });
    expect((await loadMatches(ev.id, c1)).every((m) => m.stage === 'league')).toBe(true);
    expect((await loadMatches(ev.id, c2)).every((m) => m.stage === 'knockout')).toBe(true);
    expect((await loadMatches(ev.id, c3)).some((m) => m.stage === 'group')).toBe(true);
    // jugar el primer partido de liga no toca las otras categorías
    const m = (await loadMatches(ev.id, c1))[0];
    await playVolley(ev, m.id, 'home');
    expect((await loadMatches(ev.id, c2)).every((x) => x.status === 'scheduled' || x.status === 'walkover')).toBe(true);
  });
});

describe('configuración del torneo', () => {
  it('aplica una plantilla, valida el enlace de transmisión y respeta partidos en juego', async () => {
    const { ev, cat } = await setup({ live: false, scoring: null, teams: 2 });
    await patchConfig(ev, { preset: 'voleibol_5', live_enabled: true, stream_url: 'https://www.youtube.com/live/abc' });
    const stored = db.tables.events.find((e) => e.id === ev.id)!;
    expect(stored.live_enabled).toBe(true);
    expect(stored.scoring_config.best_of).toBe(5);
    await expect(patchConfig(ev, { stream_url: 'http://youtube.com/x' })).rejects.toMatchObject({ code: 'stream_invalido' });
    await expect(patchConfig(ev, { stream_url: 'https://malicioso.com/x' })).rejects.toMatchObject({ code: 'stream_invalido' });
    await expect(patchConfig(ev, { preset: 'cricket' })).rejects.toMatchObject({ code: 'preset_invalido' });
    await expect(patchConfig(ev, {})).rejects.toMatchObject({ code: 'nada' });

    const live = (await loadEvent(ev.id)) as LiveEvent;
    await generateCategoryFixtures(live, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(live, m.id, { type: 'start' });
    await expect(patchConfig(live, { preset: 'voleibol_3' })).rejects.toMatchObject({ code: 'partidos_en_juego' });
  });
  it('getConfig sugiere plantilla por deporte y lista las disponibles', async () => {
    const { ev } = await setup({ scoring: null });
    const cfg = await getConfig(ev);
    expect(cfg.suggested_preset).toBe('voleibol_3');
    expect(cfg.presets.map((p) => p.key)).toContain('padel');
    expect(cfg.global_live_disabled).toBe(false);
  });
  it('validateStreamUrl acepta dominios permitidos y vacío', () => {
    expect(validateStreamUrl('')).toBeNull();
    expect(validateStreamUrl('https://youtu.be/abc')).toContain('youtu.be');
    expect(() => validateStreamUrl('javascript:alert(1)')).toThrow(LiveError);
  });
});

describe('anotadores sin cuenta', () => {
  it('el token se muestra una vez, solo se guarda el hash y sirve hasta que se revoca', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    const created = await createScorekeeper(ev, 'u1', { label: 'Mesa cancha 1', expires_hours: 5 }, 'https://app.sportmaps.co');
    expect(created.url).toBe(`https://app.sportmaps.co/anotador/${created.token}`);
    const stored = db.tables.tournament_scorekeepers[0];
    expect(stored.token_hash).not.toContain(created.token);
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const sk = await authScorekeeper(created.token);
    expect(sk.label).toBe('Mesa cancha 1');

    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const list = await scorerMatches(sk);
    expect(list.length).toBeGreaterThan(0);
    const m = list[0];
    const r = await performMatchAction(sk.event, m.id, { type: 'scorekeeper', id: sk.id, label: sk.label }, { action: { type: 'start' } });
    expect(r.match.status).toBe('live');

    await revokeScorekeeper(ev.id, created.id);
    await expect(authScorekeeper(created.token)).rejects.toMatchObject({ code: 'token_revocado' });
  });
  it('rechaza tokens inventados, vencidos y vacíos', async () => {
    const { ev } = await setup();
    await expect(authScorekeeper('x'.repeat(43))).rejects.toMatchObject({ status: 401, code: 'token_invalido' });
    await expect(authScorekeeper('corto')).rejects.toMatchObject({ code: 'token_invalido' });
    const c = await createScorekeeper(ev, 'u1', { label: 'Mesa', expires_hours: 1 }, 'https://x.co');
    db.tables.tournament_scorekeepers[0].expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(authScorekeeper(c.token)).rejects.toMatchObject({ code: 'token_vencido' });
  });
  it('exige nombre y limita la cancha del enlace', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    await expect(createScorekeeper(ev, 'u1', { label: '  ' }, 'https://x.co')).rejects.toMatchObject({ code: 'label_requerido' });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1, schedule: { start: '2026-11-07T08:00:00-05:00', courts: 2, slot_minutes: 50 } });
    const c = await createScorekeeper(ev, 'u1', { label: 'Mesa 2', court: 'Cancha 2', expires_hours: 5 }, 'https://x.co');
    const sk = await authScorekeeper(c.token);
    const mine = await scorerMatches(sk);
    expect(mine.every((m: any) => m.court === 'Cancha 2')).toBe(true);
  });
});

describe('lectura pública', () => {
  const FORBIDDEN = ['version', 'live_state', 'scorer_label', 'scorer_ref', 'config', 'profile_id', 'child_id', 'email', 'phone', 'document', 'payment'];

  it('muestra equipos, marcadores y tablas, sin datos internos ni de personas', async () => {
    const { ev, cat } = await setup({ teams: 4 });
    db.tables.event_team_members.push({ team_id: db.tables.event_teams[0].id, full_name: 'Niña Menor de Edad', profile_id: 'p', child_id: 'c' });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await playVolley(ev, m.id, 'home');
    const out = (await publicLive(ev.slug!))!;
    const text = JSON.stringify(out.payload);
    for (const f of FORBIDDEN) expect(text, f).not.toContain(`"${f}"`);
    expect(text).not.toContain('Menor de Edad');
    expect(out.payload.event).toMatchObject({ title: 'Copa Monster', live_enabled: true, school_name: 'Monster Volley' });
    expect(out.payload.matches).toHaveLength(6);
    expect(out.payload.matches.find((x: any) => x.id === m.id)).toMatchObject({ status: 'played', home_score: 2 });
    expect(out.payload.standings[cat].standings[0].Pts).toBe(3);
    expect(out.payload.categories[0].name).toBe('Infantil · A · Sub 14 · Femenina');
    expect(out.etag).toMatch(/^"/);
  });

  it('cachea 5 s: dos lecturas seguidas hacen una sola consulta a la base', async () => {
    const { ev } = await setup();
    const spy = vi.spyOn(db.tables.events, 'filter');
    await publicLive(ev.slug!);
    const calls = spy.mock.calls.length;
    await publicLive(ev.slug!);
    expect(spy.mock.calls.length).toBe(calls);
    spy.mockRestore();
  });

  it('slug desconocido o torneo privado sin en vivo → null', async () => {
    const { ev } = await setup({ live: false });
    expect(await publicLive('no-existe')).toBeNull();
    db.tables.events.find((e) => e.id === ev.id)!.visibility = 'school_only';
    _clearPublicCache();
    expect(await publicLive(ev.slug!)).toBeNull();
  });

  it('en vivo apagado: no muestra marcadores de partidos en juego ni el enlace de video', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    await act(ev, m.id, { type: 'point', side: 'home' });
    db.tables.events.find((e) => e.id === ev.id)!.live_enabled = false;
    db.tables.events.find((e) => e.id === ev.id)!.stream_url = 'https://youtu.be/x';
    _clearPublicCache();
    const out = (await publicLive(ev.slug!))!;
    expect(out.payload.event.live_enabled).toBe(false);
    expect(out.payload.event.stream_url).toBeNull();
    expect(out.payload.matches[0]).toMatchObject({ status: 'scheduled', home_score: null });
  });
});

describe('carga: 500 lecturas públicas con caché', () => {
  it('500 espectadores en 5 s hacen una sola ronda de consultas', async () => {
    const { ev, cat } = await setup({ teams: 8 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const spy = vi.spyOn(db.tables.tournament_matches, 'filter');
    await publicLive(ev.slug!);
    const base = spy.mock.calls.length;
    await Promise.all(Array.from({ length: 500 }, () => publicLive(ev.slug!)));
    expect(spy.mock.calls.length).toBe(base);
    spy.mockRestore();
  });
});

describe('rivales externos (solo nombre, sin cuenta ni delegación)', () => {
  it('se agregan pegando una lista; repetidos se saltan; nombre corto en mayúsculas', async () => {
    const { ev, cat } = await setup({ teams: 0 });
    const r = await addExternalTeams(ev, { category_id: cat, teams: [
      { team_name: '  Club  Águilas ', club_name: 'Águilas VC', short_name: 'agu' }, { team_name: 'Titanes' }, { team_name: 'club águilas' }, { team_name: '   ' },
    ] });
    expect(r.created.map((t) => t.name)).toEqual(['Club Águilas', 'Titanes']);
    expect(r.skipped).toEqual(['club águilas']);
    expect(r.created[0]).toMatchObject({ is_external: true, short_name: 'AGU', club_name: 'Águilas VC' });
    const row = db.tables.event_teams.find((t) => t.team_name === 'Titanes')!;
    expect(row).toMatchObject({ delegation_id: null, is_external: true, status: 'confirmed', category_id: cat });
    // segunda vez: todo repetido, no crea nada
    expect((await addExternalTeams(ev, { category_id: cat, teams: [{ team_name: 'TITANES' }] })).created).toHaveLength(0);
  });

  it('valida categoría del torneo, lista vacía, nombre corto y logo fuera de SportMaps', async () => {
    const { ev, cat } = await setup({ teams: 0 });
    await expect(addExternalTeams(ev, { category_id: 'otra', teams: [{ team_name: 'X' }] })).rejects.toMatchObject({ status: 404 });
    await expect(addExternalTeams(ev, { category_id: cat, teams: [] })).rejects.toMatchObject({ status: 400 });
    await expect(addExternalTeams(ev, { category_id: cat, teams: [{ team_name: 'X', short_name: 'LARGO' }] })).rejects.toMatchObject({ code: 'texto_largo' });
    const prev = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = 'https://abc.supabase.co';
    try {
      await expect(addExternalTeams(ev, { category_id: cat, teams: [{ team_name: 'X', logo_url: 'https://otro.com/a.png' }] })).rejects.toMatchObject({ code: 'imagen_invalida' });
      expect(validateImageUrl('https://abc.supabase.co/storage/v1/object/public/school-assets/logos/s/a.png')).toContain('school-assets');
      expect(() => validateImageUrl('http://abc.supabase.co/a.png')).toThrow(/https/);
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev;
    }
  });

  it('entran al sorteo, al calendario y a la tabla igual que los internos', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await addExternalTeams(ev, { category_id: cat, teams: [{ team_name: 'Rival A' }, { team_name: 'Rival B' }] });
    const gen = await generateCategoryFixtures(ev, cat, 'liga', { seed: 5 });
    expect(gen.matches).toBe(6);
    const ms = await loadMatches(ev.id, cat);
    const ext = db.tables.event_teams.filter((t) => t.is_external).map((t) => t.id);
    expect(ms.filter((m) => ext.includes(m.home_team_id!) || ext.includes(m.away_team_id!)).length).toBe(5);
    const extVsExt = ms.find((m) => ext.includes(m.home_team_id!) && ext.includes(m.away_team_id!))!;
    await playVolley(ev, extVsExt.id, 'home');
    const st = await buildCategoryStandings(ev, cat);
    expect(st.standings).toHaveLength(4);
    expect(st.standings[0]).toMatchObject({ team_id: extVsExt.home_team_id, Pts: 3, set_diff: 2 });
    const teams = await listTeams(ev);
    expect(teams.filter((t) => t.is_external)).toHaveLength(2);
  });

  it('editar y quitar: un interno solo cambia logo y sigla; con partidos jugados no se quita', async () => {
    const { ev, cat } = await setup({ teams: 1 });
    const internal = db.tables.event_teams[0];
    const ext = seedExternalTeam(ev.id, cat, 'Rival');
    expect(await updateTeam(ev, internal.id, { short_name: 'mon' })).toMatchObject({ short_name: 'MON', is_external: false });
    await expect(updateTeam(ev, internal.id, { team_name: 'Otro' })).rejects.toMatchObject({ code: 'equipo_interno' });
    expect(await updateTeam(ev, ext.id, { team_name: 'Rival FC', club_name: 'Club Rival' })).toMatchObject({ name: 'Rival FC', club_name: 'Club Rival' });
    await expect(deleteExternalTeam(ev, internal.id)).rejects.toMatchObject({ code: 'equipo_interno' });

    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await expect(updateTeam(ev, ext.id, { category_id: seedCategory(ev.id) })).rejects.toMatchObject({ code: 'equipo_en_calendario' });
    await playVolley(ev, m.id, 'home');
    await expect(deleteExternalTeam(ev, ext.id)).rejects.toMatchObject({ code: 'equipo_con_resultados' });
  });

  it('quitar un externo que solo estaba programado avisa que hay que regenerar', async () => {
    const { ev, cat } = await setup({ teams: 1 });
    const ext = seedExternalTeam(ev.id, cat, 'Rival');
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    expect(await deleteExternalTeam(ev, ext.id)).toEqual({ success: true, regenerate: true });
    expect(db.tables.event_teams.find((t) => t.id === ext.id)).toBeUndefined();
  });
});

describe('copas oro / plata desde grupos', () => {
  it('cada copa se arma con sus posiciones y el ganador avanza solo dentro de su copa', async () => {
    const { ev, cat } = await setup({ teams: 8 });
    const gen = await generateCategoryFixtures(ev, cat, 'grupos', {
      seed: 11, groups: { count: 2, advance: 4 },
      cups: [{ label: 'Copa oro', positions: [1, 2], third_place: true }, { label: 'Copa plata', positions: [3, 4] }],
    });
    // 12 de grupo + oro (2 semis + final + 3.º) + plata (2 semis + final)
    expect(gen.matches).toBe(19);
    let ms = await loadMatches(ev.id, cat);
    for (const g of ms.filter((m) => m.stage === 'group')) await playVolley(ev, g.id, 'home');
    const st = await buildCategoryStandings(ev, cat);
    ms = await loadMatches(ev.id, cat);
    const semis = (cup: string) => ms.filter((m) => m.cup_label === cup && m.stage === 'knockout' && m.round === 1);
    const top = new Set([st.groups!.A[0], st.groups!.A[1], st.groups!.B[0], st.groups!.B[1]].map((r) => r.team_id));
    expect(semis('Copa oro').flatMap((m) => [m.home_team_id, m.away_team_id]).every((t) => top.has(t!))).toBe(true);
    expect(semis('Copa plata').flatMap((m) => [m.home_team_id, m.away_team_id]).every((t) => t && !top.has(t))).toBe(true);

    // los ganadores de las semis de plata llegan a la final de PLATA, no a la de oro
    for (const sm of semis('Copa plata')) await playVolley(ev, sm.id, 'home');
    ms = await loadMatches(ev.id, cat);
    const finalPlata = ms.find((m) => m.cup_label === 'Copa plata' && m.round === 2 && m.stage === 'knockout')!;
    const finalOro = ms.find((m) => m.cup_label === 'Copa oro' && m.round === 2 && m.stage === 'knockout')!;
    expect(finalPlata.home_team_id && finalPlata.away_team_id).toBeTruthy();
    expect(finalOro.home_team_id ?? null).toBeNull();
    expect(finalOro.away_team_id ?? null).toBeNull();
    // el 3.º puesto de oro sigue vacío: los perdedores de plata no entran
    expect(ms.find((m) => m.cup_label === 'Copa oro' && m.stage === 'third_place')!.home_team_id ?? null).toBeNull();

    for (const sm of semis('Copa oro')) await playVolley(ev, sm.id, 'away');
    ms = await loadMatches(ev.id, cat);
    const third = ms.find((m) => m.cup_label === 'Copa oro' && m.stage === 'third_place')!;
    expect(third.home_team_id && third.away_team_id).toBeTruthy();
    _clearPublicCache();
    const pub = (await publicLive(ev.slug!))!.payload;
    expect(new Set(pub.matches.map((m: any) => m.cup_label))).toEqual(new Set([null, 'Copa oro', 'Copa plata']));
  });
});

describe('hora y cancha a mano', () => {
  it('cambia solo lo que viene, deja log «reschedule» y limpia la caché pública', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1, schedule: { start: '2026-11-07T08:00:00-05:00', courts: 1, slot_minutes: 60 } });
    const [m] = await loadMatches(ev.id, cat);
    await publicLive(ev.slug!);
    const out = await rescheduleMatch(ev, m.id, admin, { court: ' Coliseo 2 ' });
    expect(out).toMatchObject({ court: 'Coliseo 2', scheduled_at: m.scheduled_at });
    const out2 = await rescheduleMatch(ev, m.id, admin, { scheduled_at: '2026-11-07T10:30:00-05:00' });
    expect(out2.scheduled_at).toBe('2026-11-07T15:30:00.000Z');
    expect(out2.court).toBe('Coliseo 2');
    const logs = db.tables.tournament_match_log.filter((l) => l.action === 'reschedule');
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actor_type: 'user', actor_id: 'u1', before_state: { court: 'Cancha 1' }, after_state: { court: 'Coliseo 2' } });
    const pub = (await publicLive(ev.slug!))!.payload;
    expect(pub.matches.find((x: any) => x.id === m.id).court).toBe('Coliseo 2');
  });
  it('valida hora, cancha larga y cuerpo vacío', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await expect(rescheduleMatch(ev, m.id, admin, {})).rejects.toMatchObject({ status: 400 });
    await expect(rescheduleMatch(ev, m.id, admin, { scheduled_at: 'mañana' })).rejects.toMatchObject({ code: 'hora_invalida' });
    await expect(rescheduleMatch(ev, m.id, admin, { court: 'x'.repeat(41) })).rejects.toMatchObject({ code: 'texto_largo' });
    await expect(rescheduleMatch(ev, 'no-existe', admin, { court: 'A' })).rejects.toMatchObject({ status: 404 });
    expect(await rescheduleMatch(ev, m.id, admin, { scheduled_at: null, court: '' })).toMatchObject({ scheduled_at: null, court: null });
  });
});

describe('patrocinadores', () => {
  it('CRUD con orden por tier y validación de enlaces', async () => {
    const { ev } = await setup();
    const a = await createSponsor(ev, { name: 'Aliado 1' });
    const p = await createSponsor(ev, { name: 'Bebidas S.A.', tier: 'principal', url: 'https://bebidas.co' });
    expect(a).toMatchObject({ tier: 'aliado', sort_order: 0 });
    expect((await listSponsors(ev.id)).map((x) => x.name)).toEqual(['Bebidas S.A.', 'Aliado 1']);
    await expect(createSponsor(ev, { name: '' })).rejects.toMatchObject({ code: 'nombre_requerido' });
    await expect(createSponsor(ev, { name: 'X', tier: 'oro' })).rejects.toMatchObject({ code: 'tier_invalido' });
    await expect(createSponsor(ev, { name: 'X', url: 'http://inseguro.co' })).rejects.toMatchObject({ code: 'enlace_invalido' });
    expect(await updateSponsor(ev, a.id, { tier: 'oficial' })).toMatchObject({ tier: 'oficial' });
    await expect(updateSponsor(ev, 'otro', { name: 'Y' })).rejects.toMatchObject({ status: 404 });
    await deleteSponsor(ev, p.id);
    expect(await listSponsors(ev.id)).toHaveLength(1);
  });
});

describe('payload público v2', () => {
  it('trae estado, fechas, portada, logo, organizador, sede, patrocinadores, logos de equipos y cup_label', async () => {
    const { ev, cat } = await setup({ teams: 2 });
    Object.assign(db.tables.events.find((e) => e.id === ev.id)!, {
      status: 'active', end_date: '2026-11-08', banner_url: 'https://x.supabase.co/portada.jpg', logo_url: 'https://x.supabase.co/logo.png',
      organizer_name: null, rules_url: 'https://drive.google.com/reglamento', venue_name: 'Coliseo Iván de Bedout', address: 'Cra 70 #1', lat: 6.25, lng: -75.59,
    });
    db.tables.event_teams[0].logo_url = 'https://x.supabase.co/eq1.png';
    db.tables.event_teams[0].short_name = 'MON';
    seedExternalTeam(ev.id, cat, 'Rival Externo', { club_name: 'Club Rival' });
    await createSponsor(ev, { name: 'Patrocinador', tier: 'principal', logo_url: 'https://x.supabase.co/sp.png', url: 'https://sp.co' });
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    _clearPublicCache();
    const out = (await publicLive(ev.slug!))!.payload;
    expect(out.payload_version).toBe(2);
    expect(out.tournament).toBe(out.event);
    expect(out.tournament).toMatchObject({
      status: 'published', start_date: '2026-11-07', end_date: '2026-11-08', cover_url: 'https://x.supabase.co/portada.jpg',
      logo_url: 'https://x.supabase.co/logo.png', organizer_name: 'Monster Volley', rules_url: 'https://drive.google.com/reglamento',
      venue: { name: 'Coliseo Iván de Bedout', address: 'Cra 70 #1, Medellín', maps_url: 'https://www.google.com/maps/search/?api=1&query=6.25,-75.59' },
      sponsors: [{ name: 'Patrocinador', tier: 'principal', logo_url: 'https://x.supabase.co/sp.png', url: 'https://sp.co/' }],
    });
    expect(out.teams).toHaveLength(3);
    expect(out.teams.find((t: any) => t.name === 'Rival Externo')).toMatchObject({ is_external: true, club_name: 'Club Rival', logo_url: null });
    const id0 = db.tables.event_teams[0].id;
    const withLogo = out.matches.find((m: any) => m.home_team_id === id0 || m.away_team_id === id0);
    expect([withLogo.home_logo_url, withLogo.away_logo_url]).toContain('https://x.supabase.co/eq1.png');
    expect(out.matches.every((m: any) => 'cup_label' in m)).toBe(true);
    const row = out.standings[cat].standings.find((r: any) => r.team_id === id0);
    expect(row).toMatchObject({ short_name: 'MON', logo_url: 'https://x.supabase.co/eq1.png', is_external: false, set_diff: 0, point_ratio: 0 });
    expect(JSON.stringify(out)).not.toContain('"delegation"');
  });

  it('estado derivado: borrador, publicado, en curso, finalizado, cancelado', () => {
    const m = (status: string) => ({ status, stage: 'league', home_team_id: 'a', away_team_id: 'b', home_ref: null, away_ref: null }) as any;
    expect(publicStatus('draft', [])).toBe('draft');
    expect(publicStatus('cancelled', [m('played')])).toBe('cancelled');
    expect(publicStatus('active', [])).toBe('published');
    expect(publicStatus('active', [m('scheduled'), m('live')])).toBe('in_progress');
    expect(publicStatus('active', [m('played'), m('scheduled')])).toBe('in_progress');
    expect(publicStatus('closed', [m('played'), m('walkover'), m('cancelled')])).toBe('finished');
    expect(publicStatus('completed', [])).toBe('finished');
  });

  it('reconoce el error de columna inexistente (migración sin aplicar)', () => {
    expect(isMissingColumn({ code: '42703', message: 'column events.logo_url does not exist' })).toBe(true);
    expect(isMissingColumn({ code: 'PGRST204' })).toBe(true);
    expect(isMissingColumn({ code: '23505' })).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });
});

describe('reglas de marcador por categoría', () => {
  it('cada categoría puede tener su plantilla; no se cambia goles ↔ sets si esa categoría ya tiene marcador', async () => {
    const { ev, cat } = await setup({ teams: 2, scoring: null });
    const mini = seedCategory(ev.id);
    seedTeams(ev.id, mini, 2);
    const vol = { ...SCORING_PRESETS.voleibol_3.config };
    await patchConfig(ev, { scoring_config: { ...vol, by_category: { [mini]: { best_of: 1, set_points: 15, deciding_set_points: 15 } } } });
    const ev2 = (await loadEvent(ev.id))!;
    await generateCategoryFixtures(ev2, mini, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, mini);
    expect((await performMatchAction(ev2, m.id, admin, { action: { type: 'correct', sets: [[15, 10]] } })).match).toMatchObject({ status: 'played', home_score: 1 });
    await expect(patchConfig(ev2, { scoring_config: { ...vol, by_category: { [mini]: { model: 'goals' } } } })).rejects.toMatchObject({ code: 'modelo_en_uso' });
    // otra categoría sin partidos sí puede cambiar
    await patchConfig(ev2, { scoring_config: { ...vol, by_category: { [mini]: { best_of: 1, set_points: 15, deciding_set_points: 15 }, [cat]: { best_of: 5 } } } });
    expect(db.tables.events.find((e) => e.id === ev.id)!.scoring_config.by_category[cat]).toEqual({ best_of: 5 });
  });
});
