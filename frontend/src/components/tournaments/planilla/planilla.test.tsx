import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const download = vi.fn().mockResolvedValue(undefined);
vi.mock('./planillaPdf', async (orig) => ({
  ...(await orig<typeof import('./planillaPdf')>()),
  downloadPlanilla: (...a: unknown[]) => download(...a),
}));

import { buildPlanilla, planillaFileName } from './planillaModel';
import { PlanillaPartidoButton, planillaInfoFor } from './PlanillaPartidoButton';
import { renderPlanilla } from './planillaPdf';
import { SCORING_PRESETS, resolveConfig } from '@/lib/tournamentScoring';

beforeEach(() => { get.mockReset(); post.mockReset(); download.mockClear(); });

const match = {
  home_name: 'Monster', away_name: 'Titanes', home_label: null, away_label: null, stage: 'group' as const, group_label: 'A', round: 2,
  court: 'Cancha 3', scheduled_at: '2026-11-07T13:00:00Z', config: resolveConfig(SCORING_PRESETS.voleibol_3.config),
};

describe('modelo de planilla por deporte', () => {
  it('voleibol: nómina precargada, sets según best_of y rotaciones I-VI', () => {
    const info = planillaInfoFor({ match, tournamentTitle: 'Copa', sport: 'Voleibol' }, { home: ['Ana', 'Bea'], away: [] });
    const m = buildPlanilla('volleyball', info);
    expect(m.header).toContainEqual(['Fase', 'Grupo A · Fecha 2']);
    expect(m.header).toContainEqual(['Cancha / mesa', 'Cancha 3']);
    const nomina = m.blocks[0];
    expect(nomina.prefill?.map((r) => r[1])).toEqual(['Ana', 'Bea']);
    expect(m.blocks.find((b) => b.title === 'Sets')?.rows).toBe(3);
    expect(m.blocks.find((b) => b.title.startsWith('Rotaciones'))?.columns).toEqual(['Set · equipo', 'I', 'II', 'III', 'IV', 'V', 'VI']);
  });
  it('fútbol: goles, tarjetas y cambios', () => {
    const titles = buildPlanilla('football', { tournament: 'X' }).blocks.map((b) => b.title);
    expect(titles.some((t) => t === 'Goles')).toBe(true);
    expect(titles.some((t) => t.startsWith('Tarjetas'))).toBe(true);
    expect(titles).toContain('Cambios');
  });
  it('baloncesto: puntos por cuarto y faltas', () => {
    const m = buildPlanilla('basketball', { tournament: 'X' });
    expect(m.blocks.find((b) => b.title === 'Puntos por cuarto')?.columns).toContain('Q4');
    expect(m.blocks[0].columns).toContain('F5');
  });
  it('raqueta: sets con tie-break; ajedrez: planilla de jugadas numeradas', () => {
    expect(buildPlanilla('racket', { tournament: 'X', bestOf: 3 }).blocks.find((b) => b.title.startsWith('Sets'))?.columns).toContain('Tie-break');
    const chess = buildPlanilla('chess', { tournament: 'X', home: 'Ana', away: 'Luis' });
    const jug = chess.blocks[0];
    expect(jug.columns).toEqual(['N.º', 'Blancas', 'Negras', 'N.º', 'Blancas', 'Negras']);
    expect(jug.prefill?.[0]).toEqual(['1', '', '', '41']);
    expect(chess.signatures[0]).toContain('Ana');
  });
  it('en blanco: sin equipos ni datos precargados', () => {
    const m = buildPlanilla('football', planillaInfoFor({ tournamentTitle: 'Copa', sport: 'Fútbol' }));
    expect(m.header.find(([k]) => k === 'Local')?.[1]).toBe('');
    expect(m.blocks[0].prefill).toEqual([]);
    expect(planillaFileName({ tournament: 'Copa Ñ', home: null, away: null })).toBe('planilla-copa-n-en-blanco.pdf');
  });
  it('el PDF se dibuja sin errores (jsPDF de verdad, todos los deportes)', async () => {
    const { jsPDF } = await import('jspdf');
    for (const k of ['volleyball', 'football', 'basketball', 'racket', 'chess', 'cricket', 'generic', 'marks'] as const) {
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      renderPlanilla(doc, buildPlanilla(k, { tournament: 'Copa', home: 'A', away: 'B', homeRoster: Array.from({ length: 20 }, (_, i) => `J${i}`) }));
      expect(doc.getNumberOfPages(), k).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('<PlanillaPartidoButton />', () => {
  it('carga la nómina y descarga la planilla del deporte', async () => {
    const loadRoster = vi.fn().mockResolvedValue({ home: ['Ana'], away: ['Zoe'] });
    render(<PlanillaPartidoButton match={match} tournamentTitle="Copa" loadRoster={loadRoster} />);
    fireEvent.click(screen.getByTestId('planilla-btn'));
    await waitFor(() => expect(download).toHaveBeenCalled());
    const [model, file] = download.mock.calls[0];
    expect(model.title).toContain('Voleibol');
    expect(model.blocks[0].prefill[0][1]).toBe('Ana');
    expect(file).toBe('planilla-copa-monster-vs-titanes.pdf');
  });
});
