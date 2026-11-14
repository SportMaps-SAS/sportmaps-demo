/**
 * Arreglos de la prueba E2E de torneos del 2026-10-28 (anotador, planilla y carné):
 * B11 etiqueta encolada detrás del punto, B12/B13 planilla con dorsal / categoría / marca de no habilitadas,
 * B14e campos propios de la ficha en el reverso del carné.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { sortTags, type PendingTag } from './live/tagQueue';
import { buildPlanilla, lineName, lineNumber } from './planilla/planillaModel';
import { customValue, toCardData, type TournamentCard } from '@/lib/tournamentPrint';

const get = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({ bffClient: { get: (...a: unknown[]) => get(...a) } }));

const tag = (point_index: number, side: 'home' | 'away' = 'home'): PendingTag => ({ member_id: 'm1', stat: 'attack', point_index, side });

describe('B11 · etiqueta de punto encolada detrás de la acción', () => {
  it('espera mientras el punto no llega al servidor y hay acciones en cola', () => {
    expect(sortTags([tag(2)], 'ha', 1)).toEqual({ ready: [], keep: [tag(2)], drop: [] });
  });
  it('se envía cuando el punto ya está confirmado y lo ganó ese lado', () => {
    expect(sortTags([tag(2)], 'hah', 0).ready).toEqual([tag(2)]);
    expect(sortTags([tag(2)], 'hah', 3).ready).toEqual([tag(2)]);
  });
  it('se descarta si el punto se deshizo / rechazó o lo ganó el otro lado', () => {
    expect(sortTags([tag(2)], 'ha', 0).drop).toEqual([tag(2)]);
    expect(sortTags([tag(1)], 'ha', 0).drop).toEqual([tag(1)]);
    expect(sortTags([tag(1, 'away')], 'ha', 0).ready).toEqual([tag(1, 'away')]);
  });
});

describe('B12/B13 · planilla con dorsal, categoría y marca de no habilitadas', () => {
  it('rosterBlock pone el dorsal en «N.º» y marca a quien no puede jugar (sin esconderla)', () => {
    const m = buildPlanilla('volleyball', {
      tournament: 'Copa', home: 'Titanes', away: 'Halcones', category: 'Sub 14 F',
      homeRoster: [{ name: 'Ana Ruiz', number: 9, flag: null }, { name: 'Bea Gómez', number: 4, flag: 'Suspensión' }, { name: 'Carla Díaz', number: null, flag: 'Fuera de edad' }],
      awayRoster: ['Zoe'],
    });
    expect(m.header.find(([k]) => k === 'Categoría')?.[1]).toBe('Sub 14 F');
    const home = m.blocks.find((b) => b.title === 'Nómina Titanes')!;
    expect(home.prefill).toEqual([['9', 'Ana Ruiz'], ['4', 'Bea Gómez (SUSPENSIÓN)'], ['', 'Carla Díaz (FUERA DE EDAD)']]);
    expect(m.blocks.find((b) => b.title === 'Nómina Halcones')!.prefill).toEqual([['', 'Zoe']]);
    expect(lineName('Ana')).toBe('Ana');
    expect(lineNumber({ name: 'Ana', number: 7 })).toBe('7');
  });

  beforeEach(() => { get.mockReset(); });
  it('loadMatchRoster lee la nómina del partido con dorsal, marca y categoría', async () => {
    const { loadMatchRoster, PlanillaPartidoButton } = await import('./planilla/PlanillaPartidoButton');
    get.mockResolvedValue({ category: 'Infantil · Sub 14', home: [{ name: 'Ana', shirt_number: 9, flag: null }], away: [{ name: 'Zoe', shirt_number: null, flag: 'Suspensión' }] });
    const r = await loadMatchRoster('ev1', 'm1');
    expect(get.mock.calls[0][0]).toBe('/api/v1/tournament-live/school/ev1/matches/m1/sheet-roster');
    expect(r).toEqual({ category: 'Infantil · Sub 14', home: [{ name: 'Ana', number: 9, flag: null }], away: [{ name: 'Zoe', number: null, flag: 'Suspensión' }] });
    get.mockRejectedValue(new Error('x'));
    expect(await loadMatchRoster('ev1', 'm1')).toBeNull();
    expect(PlanillaPartidoButton).toBeTypeOf('function');
  });
});

describe('B14e · reverso del carné con los campos propios de la ficha', () => {
  const card: TournamentCard = {
    player: { id: 'p', team_id: 't', full_name: 'Ana Ruiz', nickname: null, position: null, shirt_number: 9, document_number: '123', birth_date: null, phone: null, photo_url: null, extra: { eps: 'Sura', alergias: false, vence: '2027-01-31' }, suspended: false, suspended_reason: null, from_school: false },
    team_name: 'Titanes', team_logo_url: null, token: 'tok', validate_url: 'https://x/validar/tok',
  };
  const cfg = { subtitle: null, color: null, fields: ['shirt_number' as const], public_photo: true };
  it('toCardData lleva los campos propios al reverso, legibles', () => {
    const d = toCardData(card, cfg, { id: 'e', title: 'Copa', logo_url: null }, [
      { key: 'eps', label: 'EPS', type: 'text' }, { key: 'alergias', label: '¿Alergias?', type: 'bool' },
      { key: 'vence', label: 'Póliza vence', type: 'date' }, { key: 'talla', label: 'Talla', type: 'select', options: ['S', 'M'] },
    ]);
    expect(d.back_rows).toEqual([{ label: 'EPS', value: 'Sura' }, { label: '¿Alergias?', value: 'No' }, { label: 'Póliza vence', value: '31/01/2027' }]);
    expect(toCardData(card, cfg, { id: 'e', title: 'Copa', logo_url: null }).back_rows).toEqual([]);
    expect(customValue({ type: 'bool' }, true)).toBe('Sí');
  });
  it('el reverso del carné imprime la EPS', async () => {
    const { AthleteIdCard } = await import('@/components/cards/AthleteIdCard');
    const d = toCardData(card, cfg, { id: 'e', title: 'Copa', logo_url: null }, [{ key: 'eps', label: 'EPS', type: 'text' }]);
    render(<AthleteIdCard data={d} publicUrl="https://x/validar/tok" face="back" />);
    expect(screen.getByText('Sura')).toBeTruthy();
    expect(screen.queryByText(/Sin datos médicos/)).toBeNull();
  });
});

