import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  BFF_URL: 'https://bff.test',
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => null }));

import type { PublicLiveDto, MatchDto } from '@/lib/tournamentTypes';
import { SCORING_PRESETS, resolveConfig } from '@/lib/tournamentScoring';
import { acceptPush, isLivePushPayload, liveTopic, mergeOverrides, pollIntervalMs, refetchDelayMs, type LivePushPayload, type Overrides } from './liveTransport';
import { CARD_H, CARD_W, buildShareCardModel, drawShareCard, fitText, initialsOf, shareFileName, shareText, type Ctx } from './shareCard';
import { scorerScopeFromUrl, setEventText } from './scorerErgonomics';
import { lineaPartido, quienJuega } from './HoyJuegaCard';
import { SeguirTorneoButton } from './SeguirTorneoButton';
import { LiveScorer } from '../LiveScorer';

const pubMatch = (p: Record<string, unknown> = {}) => ({
  id: 'm1', category_id: 'c1', stage: 'group', group_label: 'A', round: 1, slot: 1, home_team_id: 't1', away_team_id: 't2',
  home_name: 'Monsters', away_name: 'Orange', home_label: null, away_label: null, home_score: 0, away_score: 0, status: 'live',
  scheduled_at: '2026-10-27T15:30:00Z', court: 'Cancha 3', sets: [{ home: 10, away: 8, closed: false, deciding: false }],
  started_at: null, finished_at: null, model: 'sets', is_bye: false, ...p,
}) as PublicLiveDto['matches'][number];

const dto = (matches = [pubMatch()], server_time = '2026-10-27T15:40:00.000Z'): PublicLiveDto => ({
  event: { id: 'e1', title: 'Copa Monster', sport: 'voleibol', city: null, event_date: null, school_name: null, live_enabled: true, stream_url: null, format: 'grupos' },
  categories: [], matches, standings: {}, server_time,
});

const push = (p: Partial<LivePushPayload> = {}): LivePushPayload => ({
  match_id: 'm1', version: 5, status: 'live', home_score: 0, away_score: 0,
  sets: [{ home: 11, away: 8, closed: false, deciding: false }], started_at: null, finished_at: null, sent_at: '2026-10-27T15:40:02.000Z', ...p,
});

describe('transporte en vivo (push + polling de respaldo)', () => {
  it('canal y validación del mensaje', () => {
    expect(liveTopic('copa-monster')).toBe('tlive:copa-monster');
    expect(isLivePushPayload(push())).toBe(true);
    expect(isLivePushPayload({ match_id: 'm1' })).toBe(false);
    expect(isLivePushPayload(null)).toBe(false);
  });

  it('el punto empujado se ve al instante sobre lo del polling', () => {
    const o: Overrides = new Map();
    const d = dto();
    expect(acceptPush(o, d, push())).toBe('applied');
    expect(mergeOverrides(d, o).matches[0].sets[0].home).toBe(11);
  });

  it('descarta mensajes viejos o repetidos (versión)', () => {
    const o: Overrides = new Map();
    acceptPush(o, dto(), push({ version: 6, sets: [{ home: 12, away: 8, closed: false, deciding: false }] }));
    expect(acceptPush(o, dto(), push({ version: 5 }))).toBe('stale');
    expect(acceptPush(o, dto(), push({ version: 6 }))).toBe('stale');
    expect(mergeOverrides(dto(), o).matches[0].sets[0].home).toBe(12);
  });

  it('un polling más nuevo que el mensaje gana (y la caché vieja no lo revierte)', () => {
    const o: Overrides = new Map();
    acceptPush(o, dto(), push({ sent_at: '2026-10-27T15:40:02.000Z' }));
    // polling armado ANTES del punto (caché de 5 s): se queda el push
    expect(mergeOverrides(dto(undefined, '2026-10-27T15:40:00.000Z'), o).matches[0].sets[0].home).toBe(11);
    // polling armado DESPUÉS: manda el polling y se limpia el push
    const fresh = dto([pubMatch({ sets: [{ home: 14, away: 9, closed: false, deciding: false }] })], '2026-10-27T15:40:10.000Z');
    expect(mergeOverrides(fresh, o).matches[0].sets[0].home).toBe(14);
    expect(o.size).toBe(0);
  });

  it('partido desconocido o terminado: refresca completo, tarde y con espera aleatoria', () => {
    const o: Overrides = new Map();
    expect(acceptPush(o, dto(), push({ match_id: 'otro' }))).toBe('unknown_match');
    expect(refetchDelayMs('unknown_match', null, () => 0)).toBe(6000);
    expect(refetchDelayMs('applied', push({ status: 'played' }), () => 0.999)).toBe(9996);
    expect(refetchDelayMs('applied', push(), () => 0)).toBeNull();
    expect(refetchDelayMs('stale', push({ status: 'played' }))).toBeNull();
  });

  it('con push conectado el polling se vuelve lento', () => {
    const live = [{ status: 'live' as const }];
    expect(pollIntervalMs(live, false)).toBe(10_000);
    expect(pollIntervalMs(live, true)).toBe(30_000);
    expect(pollIntervalMs([{ status: 'scheduled' as const }], true)).toBe(180_000);
  });
});

/** Contexto falso de canvas que registra lo que se escribe. */
function fakeCtx() {
  const texts: string[] = [];
  const images: unknown[] = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
    fillRect: vi.fn(), fillText: (t: string) => { texts.push(t); }, beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    save: vi.fn(), restore: vi.fn(), clip: vi.fn(), drawImage: (i: unknown) => { images.push(i); }, moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    measureText: (t: string) => ({ width: t.length * 20 }) as TextMetrics,
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
  };
  return { ctx: ctx as unknown as Ctx, texts, images };
}

describe('tarjeta de resultado para compartir', () => {
  const finished = pubMatch({
    status: 'played', home_score: 2, away_score: 0, finished_at: '2026-10-27T16:20:00Z', cup_label: 'Copa oro', stage: 'knockout',
    sets: [{ home: 25, away: 22, closed: true, deciding: false }, { home: 25, away: 20, closed: true, deciding: false }],
  });

  it('arma el modelo: marcador por sets, fase con copa, ganador', () => {
    const m = buildShareCardModel(finished as never, { tournament: 'Copa Monster', category: 'Sub-14 Femenino', mvp: 'Sofía' });
    expect(m).toMatchObject({
      tournament: 'Copa Monster', phase: 'Copa oro · Fase final', category: 'Sub-14 Femenino', homeScore: '2', awayScore: '0',
      setsLine: '25-22 · 25-20', status: 'Final', winner: 'home', mvp: 'Sofía',
    });
    expect(m.home.initials).toBe('MON');
    expect(m.meta).toMatch(/^Cancha 3 · /);
  });

  it('dibuja torneo, fase, equipos, sets y «Powered by SportMaps» (sin logos: iniciales)', () => {
    const { ctx, texts, images } = fakeCtx();
    drawShareCard(ctx, buildShareCardModel(finished as never, { tournament: 'Copa Monster' }));
    expect(texts).toEqual(expect.arrayContaining(['COPA MONSTER', 'Copa oro · Fase final', 'FINAL', 'Monsters', 'Orange', '2', '0', '25-22 · 25-20', 'MON', 'ORA', 'Powered by SportMaps · sportmaps.co']));
    expect(images).toHaveLength(0);
    expect([CARD_W, CARD_H]).toEqual([1080, 1350]);
  });

  it('con logos los dibuja en vez de las iniciales', () => {
    const { ctx, texts, images } = fakeCtx();
    drawShareCard(ctx, buildShareCardModel(finished as never, { tournament: 'Copa' }), { home: {} as CanvasImageSource, away: {} as CanvasImageSource });
    expect(images).toHaveLength(2);
    expect(texts).not.toContain('MON');
  });

  it('textos largos se cortan con «…»', () => {
    const { ctx } = fakeCtx();
    expect(fitText(ctx, 'Club Deportivo Internacional de Voleibol', 200)).toBe('Club Depo…');
    expect(initialsOf('Club Deportivo Monster')).toBe('CD');
  });

  it('nombre de archivo y texto para WhatsApp', () => {
    const m = buildShareCardModel(finished as never, { tournament: 'Copa Monster' });
    expect(shareFileName(m)).toBe('monsters-vs-orange.png');
    expect(shareText(m, 'https://app.sportmaps.co/torneo/copa/en-vivo')).toBe('Final: Monsters 2-0 Orange (25-22, 25-20) · Copa Monster\nhttps://app.sportmaps.co/torneo/copa/en-vivo');
  });
});

describe('anotador en celular', () => {
  it('saca el alcance del URL de acciones', () => {
    expect(scorerScopeFromUrl('/api/v1/tournament-live/school/e1/matches/m1/actions')).toEqual({ kind: 'school', eventId: 'e1' });
    expect(scorerScopeFromUrl('/api/v1/tournament-live/scorer/tok%2Fx/matches/m1/actions')).toEqual({ kind: 'scorer', token: 'tok/x' });
    expect(scorerScopeFromUrl('/a/m1')).toBeNull();
  });
  it('aviso de set y de partido ganado', () => {
    const sets = [{ home: 25, away: 22, closed: true, deciding: false }, { home: 20, away: 25, closed: true, deciding: false }, { home: 15, away: 9, closed: true, deciding: true }];
    expect(setEventText(sets, 0, 'Monsters', 'Orange', false)).toBe('Set 1 para Monsters · 25-22');
    expect(setEventText(sets, 1, 'Monsters', 'Orange', false)).toBe('Set 2 para Orange · 25-20');
    expect(setEventText(sets, 2, 'Monsters', 'Orange', true)).toBe('¡Partido para Monsters! 2-1 · toca «Terminar partido»');
  });
});

describe('«Hoy juega…» en el Inicio', () => {
  const base = { match_id: 'm1', event_title: 'Copa', slug: 'copa', live_enabled: true, home_name: 'Monsters', away_name: 'Orange', court: 'Cancha 3', scheduled_at: '2026-10-27T15:30:00Z', status: 'scheduled', home_score: null, away_score: null };
  it('arma la frase según quién juega', () => {
    expect(quienJuega([{ first_name: 'Sofía', relation: 'hija' }])).toBe('Hoy juega tu hija Sofía');
    expect(quienJuega([{ first_name: 'Tomás', relation: 'hijo' }])).toBe('Hoy juega tu hijo Tomás');
    expect(quienJuega([{ first_name: 'Ana', relation: 'self' }])).toBe('Hoy juegas');
    expect(quienJuega([{ first_name: 'Sofía', relation: 'hija' }, { first_name: 'Tomás', relation: 'hijo' }])).toBe('Hoy juegan Sofía y Tomás');
  });
  it('«Monsters vs Orange · Cancha 3 · 10:30»', () => {
    expect(lineaPartido({ ...base, who: [] })).toMatch(/^Monsters vs Orange · Cancha 3 · .*10:30/);
    expect(lineaPartido({ ...base, status: 'live', who: [] })).toBe('Monsters vs Orange · Cancha 3 · En juego');
  });
});

describe('<SeguirTorneoButton /> sin cuenta', () => {
  it('ofrece «Agregar al calendario» (.ics) e invita a iniciar sesión', async () => {
    render(<MemoryRouter><SeguirTorneoButton slug="copa-monster" teams={[{ id: 't1', name: 'Monsters' }]} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('seguir-torneo'));
    await waitFor(() => expect(screen.getByText('Todo el torneo')).toBeTruthy());
    expect(screen.getByText('Todo el torneo').closest('a')!.getAttribute('href')).toBe('https://bff.test/api/v1/tournament-live/public/copa-monster/calendar.ics');
    expect(screen.getByText('Monsters').closest('a')!.getAttribute('href')).toContain('calendar.ics?team=t1');
    expect(screen.getByText('Inicia sesión')).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('<LiveScorer /> ergonomía', () => {
  const volley = resolveConfig(SCORING_PRESETS.voleibol_3.config);
  const match = (p: Partial<MatchDto> = {}): MatchDto => ({
    id: 'm9', category_id: 'c1', stage: 'league', group_label: null, round: 1, slot: 1,
    home_team_id: 'a', away_team_id: 'b', home_name: 'Monsters', away_name: 'Orange', home_label: null, away_label: null,
    home_score: 0, away_score: 0, status: 'live', scheduled_at: null, court: 'Cancha 3', version: 3,
    live_state: { status: 'live', points: 'h'.repeat(24) + 'a'.repeat(10), walkover: null }, sets: [], scorer_label: null,
    started_at: null, finished_at: null, model: 'sets', config: volley, is_bye: false, ...p,
  });
  const endpoints = { actionsUrl: (id: string) => `/api/v1/tournament-live/school/e1/matches/${id}/actions`, takeUrl: (id: string) => `/t/${id}` };
  beforeEach(() => { get.mockReset(); post.mockReset(); localStorage.clear(); });

  it('cambio de lado: invierte los botones y lo recuerda', () => {
    post.mockResolvedValue({ ok: true });
    get.mockResolvedValue({ roster: [] });
    const { unmount } = render(<LiveScorer match={match()} endpoints={endpoints} queueKey="qa" onClose={() => {}} />);
    const order = () => screen.getAllByRole('button', { name: /Sumar un punto a/ }).map((b) => b.getAttribute('aria-label'));
    expect(order()).toEqual(['Sumar un punto a Monsters', 'Sumar un punto a Orange']);
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar de lado' }));
    expect(order()).toEqual(['Sumar un punto a Orange', 'Sumar un punto a Monsters']);
    unmount();
    render(<LiveScorer match={match()} endpoints={endpoints} queueKey="qa" onClose={() => {}} />);
    expect(order()).toEqual(['Sumar un punto a Orange', 'Sumar un punto a Monsters']);
  });

  it('el punto que cierra el set muestra el aviso grande y el set actual', async () => {
    post.mockImplementation(() => new Promise(() => {})); // sin respuesta: la cola guarda el punto
    get.mockResolvedValue({ roster: [] });
    render(<LiveScorer match={match()} endpoints={endpoints} queueKey="qb" onClose={() => {}} />);
    expect(screen.getByTestId('current-set').textContent).toContain('Set 1');
    fireEvent.click(screen.getByRole('button', { name: 'Sumar un punto a Monsters' }));
    await waitFor(() => expect(screen.getByTestId('set-banner').textContent).toContain('Set 1 para Monsters · 25-10'));
    expect(screen.getByTestId('current-set').textContent).toContain('Set 2');
  });

  it('con planilla ofrece etiquetar el punto (opcional) y lo manda DESPUÉS de que el punto llega al servidor (B11)', async () => {
    let confirmAction: (v: unknown) => void = () => {};
    post.mockImplementation((url: string) => {
      if (String(url).endsWith('/stats')) return Promise.resolve({ ok: true });
      if (String(url).endsWith('/actions')) return new Promise((r) => { confirmAction = r; });
      return Promise.resolve({ ok: true });
    });
    get.mockResolvedValue({ roster: [{ id: 'p1', team_id: 'a', side: 'home', name: 'Sofía' }, { id: 'p2', team_id: 'b', side: 'away', name: 'Ana' }] });
    render(<LiveScorer match={match({ id: 'm10', live_state: { status: 'live', points: 'ha', walkover: null } })} endpoints={endpoints} queueKey="qc" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sumar un punto a Monsters' }));
    await waitFor(() => expect(screen.getByTestId('point-tagger')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Ana' })).toBeNull(); // solo las del equipo que hizo el punto
    fireEvent.click(screen.getByRole('button', { name: 'Sofía' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ataque' }));
    // El punto sigue en cola: la etiqueta espera (antes salía y el BFF respondía 422 punto_invalido).
    await waitFor(() => expect(screen.getByText(/se guarda apenas el punto se sincronice/)).toBeTruthy());
    expect(post.mock.calls.some((c) => String(c[0]).endsWith('/stats'))).toBe(false);
    await waitFor(() => expect(post.mock.calls.some((c) => String(c[0]).endsWith('/actions'))).toBe(true));
    confirmAction({ duplicate: false, match: match({ id: 'm10', version: 4, live_state: { status: 'live', points: 'hah', walkover: null } }) });
    await waitFor(() => expect(post.mock.calls.some((c) => String(c[0]).endsWith('/stats'))).toBe(true));
    const call = post.mock.calls.find((c) => String(c[0]).endsWith('/stats'))!;
    expect(call[0]).toBe('/api/v1/tournament-live/school/e1/matches/m10/stats');
    expect(call[1]).toEqual({ member_id: 'p1', stat: 'attack', point_index: 2 });
  });
});

describe('<HoyJuegaCard />', () => {
  it('lleva a la página en vivo y no muestra nada si no hay partido', async () => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { HoyJuegaCard } = await import('./HoyJuegaCard');
    get.mockReset();
    get.mockResolvedValueOnce({ matches: [{ match_id: 'm1', event_title: 'Copa Monster', slug: 'copa-monster', live_enabled: true, home_name: 'Monsters', away_name: 'Orange', court: 'Cancha 3', scheduled_at: '2026-10-27T15:30:00Z', status: 'scheduled', home_score: null, away_score: null, who: [{ first_name: 'Sofía', relation: 'hija' }] }] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><HoyJuegaCard userId="u1" /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Hoy juega tu hija Sofía')).toBeTruthy());
    expect(screen.getByRole('link').getAttribute('href')).toBe('/torneo/copa-monster/en-vivo');
    expect(get.mock.calls[0][0]).toBe('/api/v1/tournament-live/me/today');

    get.mockResolvedValueOnce({ matches: [] });
    const qc2 = new QueryClient();
    const { container } = render(<QueryClientProvider client={qc2}><MemoryRouter><HoyJuegaCard userId="u2" /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[data-testid="hoy-juega"]')).toBeNull();
  });
});
