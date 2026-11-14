import { describe, it, expect } from 'vitest';
import {
  generateFixtures, roundRobinRounds, bracketOrder, dealIntoGroups, groupQualifiers, validateFormat, assignSchedule, addMinutesISO, leagueMatchesPerTeam,
} from './fixtures.shared';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const pairsOf = (rows: any[]) => rows.map((r) => [r.home_team_id, r.away_team_id].sort().join('-'));

describe('liga', () => {
  it('todos contra todos: n(n-1)/2 partidos sin repetir', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const { rows } = generateFixtures('liga', ids(n), { seed: 1 });
      expect(rows).toHaveLength((n * (n - 1)) / 2);
      expect(new Set(pairsOf(rows)).size).toBe(rows.length);
      expect(rows.every((r) => r.stage === 'league' && r.home_team_id !== r.away_team_id)).toBe(true);
    }
  });
  it('ningún equipo juega dos veces en la misma jornada', () => {
    const { rows } = generateFixtures('liga', ids(7), { seed: 3 });
    const seen = new Set<string>();
    for (const r of rows) {
      for (const t of [r.home_team_id, r.away_team_id]) { const k = `${r.round}:${t}`; expect(seen.has(k)).toBe(false); seen.add(k); }
    }
  });
  it('ida y vuelta duplica los partidos', () => {
    expect(generateFixtures('liga', ids(4), { seed: 1, double_round: true }).rows).toHaveLength(12);
  });
  it('partidos por equipo limita las jornadas (liga parcial)', () => {
    const { rows } = generateFixtures('liga', ids(8), { seed: 1, matches_per_team: 3 });
    expect(rows.every((r) => r.round <= 3)).toBe(true);
    const per: Record<string, number> = {};
    rows.forEach((r) => { per[r.home_team_id!] = (per[r.home_team_id!] || 0) + 1; per[r.away_team_id!] = (per[r.away_team_id!] || 0) + 1; });
    expect(Object.values(per).every((v) => v === 3)).toBe(true);
    expect(leagueMatchesPerTeam(8, { matches_per_team: 3 })).toBe(3);
  });
  it('rechaza partidos por equipo fuera de rango', () => {
    expect(validateFormat('liga', 4, { matches_per_team: 9 })).toMatch(/entre 1 y 3/);
    expect(validateFormat('liga', 4, { matches_per_team: 5, double_round: true })).toBeNull();
    expect(validateFormat('liga', 1, {})).toMatch(/al menos 2/);
  });
});

describe('sorteo', () => {
  const sig = (seed: string) => generateFixtures('liga', ids(8), { seed }).rows.map((r) => r.home_team_id + r.away_team_id).join();
  it('la misma semilla da el mismo calendario; otra semilla, otro', () => {
    expect(sig('x')).toBe(sig('x'));
    expect(sig('x')).not.toBe(sig('y'));
  });
  it('devuelve la semilla usada para poder repetir el sorteo', () => {
    expect(Number.isInteger(generateFixtures('copa', ids(8), {}).seed)).toBe(true);
  });
  it('sorteo manual respeta el orden de siembra en la copa', () => {
    const order = ['t8', 't7', 't6', 't5', 't4', 't3', 't2', 't1'];
    const { rows } = generateFixtures('copa', ids(8), { draw: 'manual', team_order: order });
    const r1 = rows.filter((r) => r.round === 1);
    expect(r1.some((r) => [r.home_team_id, r.away_team_id].sort().join() === ['t1', 't8'].sort().join())).toBe(true); // siembra 1 vs 8
  });
});

describe('copa', () => {
  it('8 equipos: 4+2+1 partidos, rondas siguientes vacías', () => {
    const { rows } = generateFixtures('copa', ids(8), { seed: 1 });
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.round === 1)).toHaveLength(4);
    expect(rows.filter((r) => r.round === 2).every((r) => !r.home_team_id && !r.away_team_id)).toBe(true);
    expect(rows.every((r) => r.stage === 'knockout')).toBe(true);
  });
  it('6 equipos: cuadro de 8 con 2 byes', () => {
    const r1 = generateFixtures('copa', ids(6), { seed: 1 }).rows.filter((r) => r.round === 1);
    expect(r1).toHaveLength(4);
    expect(r1.filter((r) => !r.home_team_id || !r.away_team_id)).toHaveLength(2);
  });
  it('cuadro estándar: 1 y 2 en mitades opuestas', () => {
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(bracketOrder(4)).toEqual([1, 4, 2, 3]);
  });
  it('tercer puesto opcional con perdedores de semifinal', () => {
    const { rows } = generateFixtures('copa', ids(8), { seed: 1, third_place: true });
    const t = rows.find((r) => r.stage === 'third_place')!;
    expect(t).toMatchObject({ home_ref: 'L:2:1', away_ref: 'L:2:2', round: 3 });
    expect(rows.filter((r) => r.stage === 'knockout' && r.round === 3)).toHaveLength(1);
  });
  it('2 equipos: solo la final', () => {
    expect(generateFixtures('copa', ids(2), { seed: 1 }).rows).toHaveLength(1);
  });
});

describe('grupos + fase final', () => {
  it('8 equipos, 2 grupos, 2 clasifican: 12 de grupo + 3 de fase final', () => {
    const { rows, groups } = generateFixtures('grupos', ids(8), { seed: 1, groups: { count: 2, advance: 2 } });
    expect(rows.filter((r) => r.stage === 'group')).toHaveLength(12);
    expect(rows.filter((r) => r.stage === 'knockout')).toHaveLength(3);
    expect(Object.keys(groups!)).toEqual(['A', 'B']);
    expect(groups!.A).toHaveLength(4);
  });
  it('cruces 1.º A vs 2.º B y 1.º B vs 2.º A', () => {
    const { rows } = generateFixtures('grupos', ids(8), { seed: 1, groups: { count: 2, advance: 2 } });
    const sf = rows.filter((r) => r.stage === 'knockout' && r.round === 1).map((r) => [r.home_ref, r.away_ref].sort().join('|'));
    expect(sf.sort()).toEqual(['G1:A|G2:B', 'G1:B|G2:A'].sort());
  });
  it('nunca cruza equipos del mismo grupo en la primera ronda final', () => {
    for (const [n, g, a] of [[12, 4, 2], [12, 3, 2], [9, 3, 2], [16, 4, 2], [12, 2, 3], [10, 5, 1], [16, 4, 1], [12, 6, 2]] as const) {
      const { rows } = generateFixtures('grupos', ids(n), { seed: 2, groups: { count: g, advance: a } });
      for (const r of rows.filter((x) => x.stage === 'knockout' && x.round === 1)) {
        if (r.home_ref && r.away_ref) expect(r.home_ref.split(':')[1], `${n}/${g}/${a}`).not.toBe(r.away_ref.split(':')[1]);
      }
    }
  });
  it('los grupos reparten a todos los equipos sin repetir y parejos', () => {
    const { groups } = generateFixtures('grupos', ids(10), { seed: 5, groups: { count: 3, advance: 1 } });
    expect(new Set(Object.values(groups!).flat()).size).toBe(10);
    const sizes = Object.values(groups!).map((g) => g.length).sort();
    expect(sizes[sizes.length - 1] - sizes[0]).toBeLessThanOrEqual(1);
  });
  it('3 grupos × 2 = 6 clasificados: cuadro de 8 con 2 byes', () => {
    const r1 = generateFixtures('grupos', ids(9), { seed: 1, groups: { count: 3, advance: 2 } }).rows.filter((r) => r.stage === 'knockout' && r.round === 1);
    expect(r1).toHaveLength(4);
    expect(r1.filter((r) => !r.home_ref || !r.away_ref)).toHaveLength(2);
  });
  it('validaciones de grupos', () => {
    expect(validateFormat('grupos', 8, {})).toMatch(/cuántos grupos/);
    expect(validateFormat('grupos', 5, { groups: { count: 3, advance: 1 } })).toMatch(/al menos 6/);
    expect(validateFormat('grupos', 8, { groups: { count: 2, advance: 5 } })).toMatch(/entre 1 y 4/);
    expect(validateFormat('grupos', 8, { groups: { count: 1, advance: 1 } })).toMatch(/al menos 2 clasificados/);
    expect(validateFormat('grupos', 8, { groups: { count: 2, advance: 2 } })).toBeNull();
  });
  it('grupo único + final directa de 2 clasificados', () => {
    expect(generateFixtures('grupos', ids(4), { seed: 1, groups: { count: 1, advance: 2 } }).rows.filter((r) => r.stage === 'knockout')).toHaveLength(1);
  });
  it('dealIntoGroups serpentea y groupQualifiers ordena por posición', () => {
    expect(dealIntoGroups(ids(8), 2)).toEqual({ A: ['t1', 't4', 't5', 't8'], B: ['t2', 't3', 't6', 't7'] });
    expect(groupQualifiers(2, 2).slice(0, 2)).toEqual([{ pos: 1, group: 'A' }, { pos: 1, group: 'B' }]);
  });
});

describe('calendario con canchas y horas', () => {
  const sch = { start: '2026-11-07T08:00:00-05:00', courts: 2, slot_minutes: 50, break_minutes: 10 };
  it('suma minutos conservando la zona', () => {
    expect(addMinutesISO('2026-11-07T08:00:00-05:00', 90)).toBe('2026-11-07T09:30:00-05:00');
    expect(addMinutesISO('2026-11-07T23:30:00-05:00', 60)).toBe('2026-11-08T00:30:00-05:00');
  });
  it('reparte en canchas; un equipo nunca juega dos veces a la misma hora ni dos partidos en una cancha a la vez', () => {
    const { rows } = generateFixtures('liga', ids(6), { seed: 1, schedule: sch });
    expect(rows.every((r) => r.court && r.scheduled_at)).toBe(true);
    const slotTeams = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = slotTeams.get(r.scheduled_at!) ?? new Set<string>();
      for (const t of [r.home_team_id!, r.away_team_id!]) { expect(set.has(t)).toBe(false); set.add(t); }
      slotTeams.set(r.scheduled_at!, set);
    }
    const perCourt = new Map<string, number>();
    rows.forEach((r) => perCourt.set(`${r.scheduled_at}|${r.court}`, (perCourt.get(`${r.scheduled_at}|${r.court}`) ?? 0) + 1));
    expect([...perCourt.values()].every((v) => v === 1)).toBe(true);
  });
  it('la fase final se programa después de los grupos', () => {
    const { rows } = generateFixtures('grupos', ids(8), { seed: 1, groups: { count: 2, advance: 2 }, schedule: sch });
    const lastGroup = Math.max(...rows.filter((r) => r.stage === 'group').map((r) => Date.parse(r.scheduled_at!)));
    const firstKo = Math.min(...rows.filter((r) => r.stage === 'knockout').map((r) => Date.parse(r.scheduled_at!)));
    expect(firstKo).toBeGreaterThan(lastGroup);
  });
  it('valida el calendario', () => {
    expect(validateFormat('liga', 4, { schedule: { ...sch, courts: 0 } })).toMatch(/canchas/);
    expect(validateFormat('liga', 4, { schedule: { ...sch, start: 'mañana' } })).toMatch(/fecha/);
  });
  it('assignSchedule no muta las filas originales', () => {
    const { rows } = generateFixtures('liga', ids(4), { seed: 1 });
    const out = assignSchedule(rows, sch);
    expect(rows[0].court).toBeNull();
    expect(out[0].court).toBeTruthy();
  });
});

describe('roundRobinRounds', () => {
  it('cada equipo juega contra todos exactamente una vez', () => {
    const met = new Set<string>();
    roundRobinRounds(ids(6)).flat().forEach(([a, b]) => met.add([a, b].sort().join('-')));
    expect(met.size).toBe(15);
  });
});

describe('varias copas desde grupos (oro / plata)', () => {
  const cups = [
    { label: 'Copa oro', positions: [1, 2], third_place: true },
    { label: 'Copa plata', positions: [3, 4] },
  ];
  it('cada copa tiene su cuadro con sus posiciones y su tercer puesto opcional', () => {
    const { rows } = generateFixtures('grupos', ids(16), { seed: 4, groups: { count: 4, advance: 4 }, cups });
    const oro = rows.filter((r) => r.cup_label === 'Copa oro');
    const plata = rows.filter((r) => r.cup_label === 'Copa plata');
    // 8 clasificados por copa: 4 + 2 + 1 = 7 partidos; oro con tercer puesto
    expect(oro.filter((r) => r.stage === 'knockout')).toHaveLength(7);
    expect(oro.filter((r) => r.stage === 'third_place')).toHaveLength(1);
    expect(plata.filter((r) => r.stage === 'knockout')).toHaveLength(7);
    expect(plata.filter((r) => r.stage === 'third_place')).toHaveLength(0);
    const refsOf = (rs: typeof rows) => rs.filter((r) => r.round === 1 && r.stage === 'knockout').flatMap((r) => [r.home_ref, r.away_ref]);
    expect(refsOf(oro).every((x) => /^G[12]:/.test(String(x)))).toBe(true);
    expect(refsOf(plata).every((x) => /^G[34]:/.test(String(x)))).toBe(true);
    expect(new Set(refsOf(oro)).size).toBe(8);
    // los partidos de grupo no tienen copa
    expect(rows.filter((r) => r.stage === 'group').every((r) => r.cup_label === null)).toBe(true);
  });
  it('en la ronda 1 de cada copa no se cruzan equipos del mismo grupo', () => {
    const { rows } = generateFixtures('grupos', ids(16), { seed: 9, groups: { count: 4, advance: 4 }, cups });
    for (const r of rows.filter((x) => x.stage === 'knockout' && x.round === 1)) {
      expect(String(r.home_ref).split(':')[1]).not.toBe(String(r.away_ref).split(':')[1]);
    }
  });
  it('sin copas el resultado es el mismo de antes (cup_label null)', () => {
    const a = generateFixtures('grupos', ids(8), { seed: 7, groups: { count: 2, advance: 2 } });
    expect(a.rows.every((r) => r.cup_label === null)).toBe(true);
    expect(a.rows.filter((r) => r.stage === 'knockout')).toHaveLength(3);
  });
  it('valida nombres, posiciones repetidas y fuera de rango', () => {
    const g = { count: 2, advance: 2 };
    expect(validateFormat('grupos', 8, { groups: g, cups: [{ label: '', positions: [1] }] })).toMatch(/nombre/);
    expect(validateFormat('grupos', 8, { groups: g, cups: [{ label: 'Oro', positions: [1, 2] }, { label: 'Plata', positions: [2, 3] }] })).toMatch(/dos copas/);
    expect(validateFormat('grupos', 8, { groups: g, cups: [{ label: 'Oro', positions: [1, 5] }] })).toMatch(/entre 1 y 4/);
    expect(validateFormat('grupos', 8, { groups: g, cups: [{ label: 'Oro', positions: [1] }, { label: 'oro', positions: [2] }] })).toMatch(/repetida/);
    expect(validateFormat('copa', 8, { cups: [{ label: 'Oro', positions: [1] }] })).toMatch(/solo aplican/);
    expect(validateFormat('grupos', 8, { groups: { count: 2 } as any, cups: [{ label: 'Oro', positions: [1, 2] }, { label: 'Plata', positions: [3, 4] }] })).toBeNull();
  });
  it('el calendario pone las dos copas de la misma ronda en el mismo bloque (canchas en paralelo)', () => {
    const { rows } = generateFixtures('grupos', ids(8), {
      seed: 2, groups: { count: 2, advance: 4 }, cups: [{ label: 'Oro', positions: [1, 2] }, { label: 'Plata', positions: [3, 4] }],
      schedule: { start: '2026-11-07T08:00:00-05:00', courts: 4, slot_minutes: 60 },
    });
    const r1 = rows.filter((r) => r.stage === 'knockout' && r.round === 1);
    expect(r1).toHaveLength(4);
    expect(new Set(r1.map((r) => r.scheduled_at)).size).toBe(1);
    expect(new Set(r1.map((r) => r.court)).size).toBe(4);
  });
});
