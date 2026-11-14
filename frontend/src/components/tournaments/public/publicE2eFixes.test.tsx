/**
 * Arreglos del E2E de Torneos 2026-10-28 sobre la página pública, con los payloads REALES de dev
 * (GET /api/v1/tournament-live/public/<slug>/live, guardados en __fixtures__/e2e-*.json):
 *   B1   Ranking rompía la página (contrato de player_stats).
 *   B8   Ajedrez: marcador en medios puntos y tabla con puntos ½ / Buchholz / S-B.
 *   B14c Tenis: PF/PC son games.
 *   B14d Ficha de borrador: «Por definir, Por definir · Cómo llegar».
 *   +    Waze en «Cómo llegar», chips de categoría cortos, una sola barra de pestañas en el partido.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import voley from './__fixtures__/e2e-voley.json';
import ajedrez from './__fixtures__/e2e-ajedrez.json';
import tenis from './__fixtures__/e2e-tenis.json';
import {
  normalizePlayerStats, playerRanking, publicScore, publicScoreKind, publicStandingColumns, realVenue, shortCategoryName,
  teamIndex, venueDirections, type PublicLiveV2,
} from './publicModel';

const get = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
  BFF_URL: 'http://bff.test',
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => null }));

import TournamentLivePage from '@/pages/events/TournamentLivePage';
import TournamentMatchPage from '@/pages/events/TournamentMatchPage';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const serve = (payload: unknown) => (url: string) => (url.endsWith('/live') ? Promise.resolve(payload) : Promise.reject(Object.assign(new Error('x'), { status: 404 })));
const open = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/torneo/:slug/en-vivo" element={<TournamentLivePage />} />
      <Route path="/torneo/:slug/partido/:matchId" element={<TournamentMatchPage />} />
    </Routes>
  </MemoryRouter>,
);
beforeEach(() => { get.mockReset(); localStorage.clear(); });

const TITANES = '426e8e8c-10df-4be2-be90-78994139e022';
const SUB14F = 'cf0ffcc9-329c-4891-8fd0-39a8061cd474';
/** Las líneas que mandaba el BFF en dev antes del arreglo (forma de «vivo»). */
const OLD_LINES = [
  { member_id: '12736835-b585-4c89-9047-95c5e2585fc3', name: 'Isabella', team_id: TITANES, ace: 0, attack: 1, block: 0, points: 1 },
  { member_id: '32639250-fba4-4e9f-b8e9-2a7941ea4947', name: 'Camila R.', team_id: TITANES, ace: 1, attack: 0, block: 0, points: 1 },
  { member_id: '28a2a274-784e-47ee-b5d6-635795c44d75', name: 'Laura', team_id: TITANES, ace: 0, attack: 0, block: 1, points: 1 },
];

describe('B1 — ranking de jugadoras', () => {
  const teams = teamIndex(voley as unknown as PublicLiveV2);

  it('normaliza las líneas viejas de «vivo» y completa equipo y categoría', () => {
    const rows = normalizePlayerStats(OLD_LINES, teams);
    expect(rows[1]).toMatchObject({ id: OLD_LINES[1].member_id, player_label: 'Camila R.', team_name: 'Titanes', category_id: SUB14F, aces: 1, attack_points: 0, blocks: 0, points: 1 });
    expect(rows.map((r) => [r.attack_points, r.blocks])).toEqual([[1, 0], [0, 0], [0, 1]]);
  });

  it('acepta el contrato nuevo tal cual', () => {
    const [r] = normalizePlayerStats([{ id: 'x', player_label: 'Laura', team_id: TITANES, team_name: 'Titanes', category_id: SUB14F, aces: 2, attack_points: 3, blocks: 1, points: 6 }], teams);
    expect(r).toMatchObject({ player_label: 'Laura', aces: 2, attack_points: 3, blocks: 1, points: 6 });
  });

  it('empate de valores sin player_label no revienta (antes: TypeError en localeCompare)', () => {
    const rows = [{ points: 1 }, { points: 1, player_label: null }, { points: 1, player_label: 'Ana' }] as never;
    expect(() => playerRanking(rows, 'points', null)).not.toThrow();
    expect(playerRanking(rows, 'points', null).map((r) => r.rank)).toEqual([1, 1, 1]);
  });

  it('la página pública abre la pestaña Ranking con el payload real de dev (forma vieja) y filtra por categoría', async () => {
    const payload = clone(voley) as any;
    payload.player_stats = OLD_LINES;
    get.mockImplementation(serve(payload));
    open('/torneo/copa-demo-voley-e2e/en-vivo');
    await waitFor(() => screen.getByRole('tab', { name: 'Ranking' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Ranking' }));
    expect(screen.getAllByTestId('ranking-row')).toHaveLength(3);
    expect(screen.getByText('Camila R.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Aces' }));
    expect(screen.getAllByTestId('ranking-row')).toHaveLength(1);
    // Otra categoría (Mayores M): las de Sub 14 F no salen.
    fireEvent.click(screen.getByRole('radio', { name: 'Mayores M' }));
    expect(screen.queryAllByTestId('ranking-row')).toHaveLength(0);
  });
});

describe('B8 — ajedrez', () => {
  const m = (ajedrez as any).matches.find((x: any) => x.status === 'played');

  it('el deporte se lee igual que en el anotador', () => {
    expect(publicScoreKind('Ajedrez')).toBe('chess');
    expect(publicScoreKind('Tenis')).toBe('tennis');
    expect(publicScoreKind('Pádel')).toBe('tennis');
    expect(publicScoreKind('Voleibol')).toBe('default');
    expect(publicScoreKind(null)).toBe('default');
  });

  it('tablas reales (1-1 en medios puntos) = ½ – ½; 2-0 = 1 – 0', () => {
    expect(publicScore(m, 'chess')).toEqual({ home: '½', away: '½' });
    expect(publicScore({ ...m, home_score: 2, away_score: 0 }, 'chess')).toEqual({ home: '1', away: '0' });
    expect(publicScore(m, 'default')).toEqual({ home: '1', away: '1' });
  });

  it('tabla con puntos ½ y desempates, sin goles', () => {
    const cols = publicStandingColumns('goals', 'chess');
    expect(cols.map((c) => c.label)).toEqual(['PJ', 'PG', 'PT', 'PP', 'PTS', 'BH', 'SB']);
    const row = Object.values((ajedrez as any).standings as Record<string, any>)[0].standings[0];
    expect(cols.map((c) => c.value(row))).toEqual([1, 0, 1, 0, '½', '½', '0,25']);
  });

  it('la página del partido muestra ½ – ½, Blancas / Negras, y una sola barra de pestañas', async () => {
    get.mockImplementation(serve(clone(ajedrez)));
    open(`/torneo/copa-demo-ajedrez-e2e-0faxkw/partido/${m.id}`);
    await waitFor(() => screen.getByTestId('match-detail'));
    expect(screen.getByLabelText('Marcador ½ a ½')).toBeTruthy();
    expect(screen.getByText('· Blancas')).toBeTruthy();
    expect(screen.getByText('· Negras')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Secciones del partido' })).toBeNull();
  });

  it('la tarjeta y la tabla de la página del torneo', async () => {
    get.mockImplementation(serve(clone(ajedrez)));
    open('/torneo/copa-demo-ajedrez-e2e-0faxkw/en-vivo');
    await waitFor(() => screen.getAllByTestId('standing-row'));
    expect(screen.getByRole('columnheader', { name: 'BH' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'GF' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Partidos' }));
    const card = screen.getAllByTestId('public-match')[0];
    expect(within(card).getAllByText('½')).toHaveLength(2);
    expect(within(card).getByText('Blancas')).toBeTruthy();
  });
});

describe('B14c — tenis en games', () => {
  it('PF/PC → GF/GC «games»; vóley sigue en puntos', () => {
    const t = publicStandingColumns('sets', 'tennis');
    expect(t.map((c) => c.label)).toEqual(['PJ', 'PG', 'PP', 'PTS', 'SG', 'SP', 'DS', 'GF', 'GC', 'DG']);
    expect(t.find((c) => c.key === 'PF')!.title).toBe('Games a favor');
    const row = Object.values((tenis as any).standings as Record<string, any>)[0].standings[0];
    expect(t.find((c) => c.key === 'PF')!.value(row)).toBe(13);
    expect(publicStandingColumns('sets').find((c) => c.key === 'PF')!.title).toBe('Puntos a favor');
  });
});

describe('B14d — sede de borrador', () => {
  it('«Por definir, Por definir» no es sede', () => {
    expect(realVenue((tenis as any).event.venue)).toBeNull();
    expect(venueDirections(realVenue((tenis as any).event.venue), (tenis as any).event.city)).toBeNull();
    expect(realVenue({ name: null, address: 'Calle 10 #5-20, Por definir', maps_url: 'https://x' })).toEqual({ name: null, address: 'Calle 10 #5-20', maps_url: null });
  });

  it('la página no muestra sede, «Cómo llegar» ni «Por definir»', async () => {
    get.mockImplementation(serve(clone(tenis)));
    open('/torneo/copa-demo-tenis-e2e-cppsu6/en-vivo');
    await waitFor(() => screen.getByTestId('powered-by'));
    expect(screen.queryByRole('region', { name: 'Sede' })).toBeNull();
    expect(screen.queryByText(/Por definir/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Cómo llegar' })).toBeNull();
  });
});

describe('Cómo llegar: Google Maps y Waze', () => {
  it('con dirección real: dos enlaces', () => {
    const d = venueDirections((voley as any).event.venue, (voley as any).event.city)!;
    expect(d.google).toBe((voley as any).event.venue.maps_url);
    expect(d.waze).toBe('https://waze.com/ul?q=Coliseo%20Club%20Campestre%20Demo%2C%20Km%205%20v%C3%ADa%20La%20Calera%2C%20Bogot%C3%A1%2C%20Bogot%C3%A1&navigate=yes');
  });
  it('con coordenadas: Waze va al punto exacto', () => {
    const d = venueDirections({ name: 'Coliseo', address: null, maps_url: 'https://www.google.com/maps/search/?api=1&query=6.25,-75.59' }, null)!;
    expect(d.waze).toBe('https://waze.com/ul?ll=6.25%2C-75.59&navigate=yes');
  });
  it('en la página', async () => {
    get.mockImplementation(serve(clone(voley)));
    open('/torneo/copa-demo-voley-e2e/en-vivo');
    const g = await screen.findByRole('group', { name: 'Cómo llegar' });
    expect(within(g).getByRole('link', { name: 'Cómo llegar con Waze' }).getAttribute('href')).toMatch(/^https:\/\/waze\.com\/ul\?/);
    expect(within(g).getByRole('link', { name: 'Cómo llegar con Google Maps' })).toBeTruthy();
  });
});

describe('chips de categoría cortos', () => {
  it('sin «General · 1» ni la rama repetida', () => {
    expect(shortCategoryName('General · 1 · Sub 14 Femenino · Femenino')).toBe('Sub 14 F');
    expect(shortCategoryName('General · 1 · Mayores Masculino · Masculino')).toBe('Mayores M');
    expect(shortCategoryName('Infantil · A · Sub 14 · Femenina')).toBe('Infantil · A · Sub 14 · Femenina');
    expect(shortCategoryName('Libre')).toBe('Libre');
    expect(shortCategoryName('General')).toBe('General');
  });
  it('en la página: chips cortos con el nombre completo en el title', async () => {
    get.mockImplementation(serve(clone(voley)));
    open('/torneo/copa-demo-voley-e2e/en-vivo');
    const chip = await screen.findByRole('radio', { name: 'Sub 14 F' });
    expect(chip.getAttribute('title')).toBe('General · 1 · Sub 14 Femenino · Femenino');
    expect(screen.getByRole('radio', { name: 'Mayores M' })).toBeTruthy();
  });
});
