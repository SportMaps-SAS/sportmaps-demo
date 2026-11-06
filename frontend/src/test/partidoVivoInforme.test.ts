import { describe, expect, it } from 'vitest';
import {
  buildInforme, fmtClock, fmtHoraBogota, informeGeneralDe, informeToWhatsApp, mapaMinutosVivo,
  type LiveLineupRow, type LiveReportData,
} from '@/components/partido-vivo/informe/informeModel';

const J = (n: number, name: string, role: 'starter' | 'bench', minutes: number, extra: Partial<LiveLineupRow> = {}): LiveLineupRow => ({
  subject_type: 'athlete', subject_id: `id-${n}`, name, jersey_number: n, role, minutes, seconds: minutes * 60, pct: Math.round((minutes / 65) * 1000) / 10, ...extra,
});
const S = (n: number, name: string) => ({ name, jersey_number: n });

// Fixture con la forma real de _live_report_data: Carmel 3-3, 9 titulares, 6 banca.
const titulares = [
  J(1, 'Ana Gómez', 'starter', 65), J(2, 'Bea Ruiz', 'starter', 50), J(3, 'Cami Soto', 'starter', 65),
  J(4, 'Dani Paz', 'starter', 40), J(5, 'Eva Rey', 'starter', 65), J(6, 'Fer Mora', 'starter', 30),
  J(7, 'Gina Vega', 'starter', 65), J(8, 'Helen Cruz', 'starter', 65), J(9, 'Isa León', 'starter', 65),
];
const banca = [
  J(10, 'Juli Pardo', 'bench', 15), J(11, 'Kata Díaz', 'bench', 25), J(12, 'Lore Ríos', 'bench', 35),
  J(13, 'Mari Peña', 'bench', 0), J(14, 'Nata Gil', 'bench', 20), J(15, 'Olga Sanz', 'bench', 10),
];
const data: LiveReportData = {
  match: { id: 'm1', date: '2026-11-05', kickoff_at: '2026-11-05T20:30:00Z', opponent: 'Rival FC', location: 'Cancha Norte', is_home: true, school_name: 'Carmel Club' },
  status: 'finished',
  lineup: [...titulares, ...banca],
  starters: titulares,
  bench: banca,
  subs_by_period: [
    { period_no: 1, items: [
      { second: 660, in_break: false, in: S(10, 'Juli Pardo'), out: S(2, 'Bea Ruiz') },
      { second: 900, in_break: false, in: S(11, 'Kata Díaz'), out: S(4, 'Dani Paz') },
    ] },
    { period_no: 2, items: [
      { second: 0, in_break: true, in: S(12, 'Lore Ríos'), out: S(6, 'Fer Mora') },
    ] },
  ],
  goals_for: [
    { period_no: 1, second: 467, scorer: S(7, 'Gina Vega'), assist: null },
    { period_no: 2, second: 600, scorer: S(9, 'Isa León'), assist: S(8, 'Helen Cruz') },
    { period_no: 3, second: 300, scorer: S(7, 'Gina Vega'), assist: null },
  ],
  goals_against: [
    { period_no: 1, second: 25 },
    { period_no: 2, second: 391 },
    { period_no: 3, second: 360 },
  ],
  cards: [],
  total_played_seconds: 3900,
  duration_label: 'casi 65 minutos',
  score: { for: 3, against: 3 },
};

describe('fmtClock', () => {
  it('minuto redondo sin segundos; con segundos mm\'ss"; solo segundos bajo el minuto', () => {
    expect(fmtClock(660)).toBe("11'");
    expect(fmtClock(467)).toBe("7'47\"");
    expect(fmtClock(25)).toBe('25"');
    expect(fmtClock(0)).toBe("0'");
    expect(fmtClock(null)).toBe("0'");
  });
  it('hora de Colombia', () => {
    expect(fmtHoraBogota('2026-11-05T20:30:00Z')).toBe('15:30');
    expect(fmtHoraBogota(null)).toBeNull();
  });
});

describe('informe de Carmel (golden)', () => {
  const i = buildInforme(data, { informeGeneral: 'Buen partido, dominamos el segundo tiempo.' });

  it('encabezado', () => {
    expect(i.fecha).toBe('5 de noviembre de 2026');
    expect(i.hora).toBe('15:30');
    expect(i.partido).toBe('Carmel Club vs Rival FC');
    expect(i.lugar).toBe('Cancha Norte');
    expect(i.resultado).toBe('3-3');
    expect(i.alineacion).toHaveLength(9);
    expect(i.banca).toHaveLength(6);
    expect(i.alineacion[0]).toBe('Ana Gómez 1');
  });

  it('texto de WhatsApp, orden y estilo fijos', () => {
    expect(informeToWhatsApp(i)).toBe([
      '*Informe del partido*',
      'Fecha: 5 de noviembre de 2026',
      'Hora: 15:30',
      'Partido: Carmel Club vs Rival FC',
      'Lugar: Cancha Norte',
      'Resultado: 3-3',
      '',
      '*Alineación*',
      'Ana Gómez 1', 'Bea Ruiz 2', 'Cami Soto 3', 'Dani Paz 4', 'Eva Rey 5', 'Fer Mora 6', 'Gina Vega 7', 'Helen Cruz 8', 'Isa León 9',
      '',
      '*Sustituciones*',
      'Juli Pardo 10', 'Kata Díaz 11', 'Lore Ríos 12', 'Mari Peña 13', 'Nata Gil 14', 'Olga Sanz 15',
      '',
      '*Cambios realizados*',
      '1.er tiempo',
      "Juli Pardo 10 ingresa al 11' (sale Bea Ruiz 2)",
      "Kata Díaz 11 ingresa al 15' (sale Dani Paz 4)",
      '2.º tiempo',
      'Lore Ríos 12 ingresa en el descanso (sale Fer Mora 6)',
      '',
      '*Anotaciones*',
      'Gina Vega 7 7\'47"',
      "Isa León 9 10' (asist. Helen Cruz 8)",
      "Gina Vega 7 5'",
      '',
      '*Goles en contra*',
      '25" 1.er tiempo',
      '6\'31" 2.º tiempo',
      "6' 3.er tiempo",
      '',
      '*Amonestaciones*',
      'Ninguna',
      '',
      '*Informe General*',
      'Buen partido, dominamos el segundo tiempo.',
      '',
      'Duración total: casi 65 minutos',
    ].join('\n'));
  });

  it('goles en contra sin autor', () => {
    expect(i.golesContra.join(' ')).not.toMatch(/[A-Za-z]{3,} [A-Z]/);
    expect(i.golesContra).toHaveLength(3);
  });

  it('informe general vacío deja el encabezado; amonestaciones con jugador', () => {
    const t = informeToWhatsApp(buildInforme({ ...data, duration_label: null, total_played_seconds: 0,
      cards: [{ type: 'yellow', period_no: 2, second: 120, subject: S(3, 'Cami Soto') }, { type: 'red', period_no: 3, second: 30, subject: S(5, 'Eva Rey') }] }));
    expect(t).toContain("Amarilla: Cami Soto 3 2' (2.º tiempo)");
    expect(t).toContain('Roja: Eva Rey 5 30" (3.er tiempo)');
    expect(t.endsWith('*Informe General*')).toBe(true);
  });

  it('minutos y %: publicados > en vivo > minutes; origen opcional', () => {
    expect(i.minutos[0]).toMatchObject({ nombre: 'Ana Gómez', minutos: 65, origen: null });
    const d2: LiveReportData = { ...data, lineup: [J(1, 'Ana Gómez', 'starter', 60, { minutes_live: 61, minutes_published: 62, minutes_source: 'manual' }), J(2, 'Bea Ruiz', 'starter', 50, { minutes_live: 48 })] };
    const m = mapaMinutosVivo(d2);
    expect(m.get('athlete:id-1')).toBe(62);
    expect(m.get('athlete:id-2')).toBe(48);
    expect(buildInforme(d2).minutos[0].origen).toBe('manual');
  });

  it('tolera campos faltantes', () => {
    const x = buildInforme({});
    expect(x.partido).toBe('Escuela vs Rival');
    expect(x.resultado).toBe('0-0');
    expect(x.cambios).toEqual([]);
    expect(informeToWhatsApp(x)).toContain('Ninguna');
  });
});

describe('informeGeneralDe', () => {
  it('toma el texto libre y descarta el borrador del servidor', () => {
    expect(informeGeneralDe('resumen', 'desarrollo libre')).toBe('desarrollo libre');
    expect(informeGeneralDe('Informe del partido\nFecha: x', 'Alineación:\nAna 1')).toBe('');
    expect(informeGeneralDe('solo resumen', '')).toBe('solo resumen');
  });
});
