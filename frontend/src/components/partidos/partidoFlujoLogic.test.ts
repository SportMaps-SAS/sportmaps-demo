import { describe, it, expect } from 'vitest';
import {
  BARRA_GUARDAR,
  PASOS,
  aColumnasMarcador,
  criteriosDePartido,
  entradasEvaluacion,
  evaluadasDe,
  eventosPorJugadora,
  kickoffIso,
  marcadorNuestroSugerido,
  marcadorPropio,
  marcadorRivalSugerido,
  pasoAnterior,
  pasoHabilitado,
  pasoInicial,
  pasoSiguiente,
  planillaDesdeFilas,
  quienesSeEvaluan,
  sumaGoles,
  ultimoEvento,
  usaEventosDeFutbol,
  type Criterio,
  type PartidoBase,
} from './partidoFlujoLogic';

const HOY = '2026-10-26';
const partido = (x: Partial<PartidoBase> = {}): PartidoBase => ({
  id: 'm1', match_date: HOY, status: 'scheduled', home_score: null, away_score: null, is_home: true, ...x,
});

describe('orden de los pasos', () => {
  it('es Programar → Convocar → Resultado → Evaluar → Reporte', () => {
    expect(PASOS.map((p) => p.id)).toEqual(['programar', 'convocar', 'cerrar', 'evaluar', 'reporte']);
    expect(pasoSiguiente('programar')).toBe('convocar');
    expect(pasoSiguiente('evaluar')).toBe('reporte');
    expect(pasoSiguiente('reporte')).toBeNull();
    expect(pasoAnterior('programar')).toBeNull();
    expect(pasoAnterior('cerrar')).toBe('convocar');
  });

  it('sin partido guardado solo se puede programar', () => {
    expect(pasoHabilitado('programar', false)).toBe(true);
    for (const p of ['convocar', 'cerrar', 'evaluar', 'reporte'] as const) expect(pasoHabilitado(p, false)).toBe(false);
    expect(pasoHabilitado('evaluar', true)).toBe(true);
  });
});

describe('paso inicial', () => {
  const ctx = { hoyIso: HOY, tieneEvaluacion: false };
  it('partido nuevo → Programar', () => expect(pasoInicial(null, ctx)).toBe('programar'));
  it('programado a futuro → Convocar', () => expect(pasoInicial(partido({ match_date: '2026-10-30' }), ctx)).toBe('convocar'));
  it('programado hoy o ya pasado → Resultado', () => {
    expect(pasoInicial(partido(), ctx)).toBe('cerrar');
    expect(pasoInicial(partido({ match_date: '2026-10-20' }), ctx)).toBe('cerrar');
  });
  it('jugado sin evaluación → Evaluar; evaluado → Reporte', () => {
    const jugado = partido({ status: 'played', home_score: 2, away_score: 1 });
    expect(pasoInicial(jugado, ctx)).toBe('evaluar');
    expect(pasoInicial(jugado, { ...ctx, tieneEvaluacion: true })).toBe('reporte');
  });
  it('con marcador cuenta como jugado aunque el estado no lo diga', () => {
    expect(pasoInicial(partido({ status: null, home_score: 0, away_score: 0 }), ctx)).toBe('evaluar');
  });
  it('cancelado → Programar (para reprogramarlo)', () => expect(pasoInicial(partido({ status: 'cancelled' }), ctx)).toBe('programar'));
});

describe('marcador y suma de goles', () => {
  const ev = [
    { id: 'e3', subject_type: 'child', subject_id: 'a', type: 'goal' },
    { id: 'e2', subject_type: 'child', subject_id: 'b', type: 'goal' },
    { id: 'e1', subject_type: 'child', subject_id: 'a', type: 'goal' },
    { id: 'e0', subject_type: 'child', subject_id: 'a', type: 'assist' },
    { id: 'ex', subject_type: 'child', subject_id: 'c', type: 'own_goal' },
    { id: 'ey', subject_type: 'child', subject_id: 'c', type: 'yellow' },
  ];

  it('los goles son nuestros y el autogol suma al rival', () => {
    expect(sumaGoles(ev)).toEqual({ nuestros: 3, autogoles: 1 });
    expect(sumaGoles([])).toEqual({ nuestros: 0, autogoles: 0 });
  });

  it('nuestro marcador se precarga con la suma de goles; sin goles, con lo guardado', () => {
    expect(marcadorNuestroSugerido(null, ev)).toBe(3);
    expect(marcadorNuestroSugerido(5, ev)).toBe(3);
    expect(marcadorNuestroSugerido(2, [])).toBe(2);
    expect(marcadorNuestroSugerido(null, [])).toBe(0);
  });

  it('el rival arranca con lo guardado y nunca por debajo de los autogoles', () => {
    expect(marcadorRivalSugerido(null, ev)).toBe(1);
    expect(marcadorRivalSugerido(4, ev)).toBe(4);
    expect(marcadorRivalSugerido(null, [])).toBe(0);
  });

  it('nosotros/ellos ↔ local/visitante', () => {
    expect(aColumnasMarcador(3, 1, true)).toEqual({ home_score: 3, away_score: 1 });
    expect(aColumnasMarcador(3, 1, false)).toEqual({ home_score: 1, away_score: 3 });
    expect(aColumnasMarcador(3, 1, null)).toEqual({ home_score: 3, away_score: 1 });
    expect(marcadorPropio({ home_score: 1, away_score: 3, is_home: false })).toEqual({ nuestros: 3, rival: 1 });
  });

  it('cuenta por jugadora y encuentra el último evento para quitarlo', () => {
    const c = eventosPorJugadora(ev);
    expect(c.get('child:a')).toEqual({ goal: 2, assist: 1 });
    expect(c.get('child:c')).toEqual({ own_goal: 1, yellow: 1 });
    expect(ultimoEvento(ev, 'child:a', 'goal')?.id).toBe('e3');
    expect(ultimoEvento(ev, 'child:b', 'red')).toBeNull();
  });

  it('goles y tarjetas solo en fútbol', () => {
    expect(usaEventosDeFutbol('Fútbol')).toBe(true);
    expect(usaEventosDeFutbol('Fútbol Sala')).toBe(true);
    expect(usaEventosDeFutbol('Microfútbol')).toBe(true);
    expect(usaEventosDeFutbol('Voleibol')).toBe(false);
    expect(usaEventosDeFutbol(null)).toBe(false);
  });
});

describe('hora del partido', () => {
  it('fecha + hora en Colombia', () => {
    expect(kickoffIso('2026-10-30', '15:30')).toBe('2026-10-30T15:30:00-05:00');
    expect(kickoffIso('2026-10-30', '')).toBeNull();
    expect(kickoffIso('2026-10-30', null)).toBeNull();
  });
});

describe('quiénes se evalúan', () => {
  it('solo las convocadas, sin repetir', () => {
    const conv = [
      { subject_type: 'child', subject_id: 'a' },
      { subject_type: 'profile', subject_id: 'u1' },
      { subject_type: 'child', subject_id: 'a' },
    ];
    expect(quienesSeEvaluan(conv).map((s) => `${s.subject_type}:${s.subject_id}`)).toEqual(['child:a', 'profile:u1']);
    expect(quienesSeEvaluan(null)).toEqual([]);
  });

  const criterios: Criterio[] = [
    { metric_key: 'comentario', display_name: 'Comentario', scale: 'text', applies_to: 'both', sort_order: 90 },
    { metric_key: 'actitud', display_name: 'Actitud', scale: 'scale_1_5', applies_to: 'both', sort_order: 10 },
    { metric_key: 'solo_entreno', display_name: 'Entreno', scale: 'scale_1_5', applies_to: 'training', sort_order: 5 },
    { metric_key: 'rol', display_name: 'Rol', scale: 'scale_1_5', applies_to: 'match', sort_order: 60 },
    { metric_key: 'apagado', display_name: 'Apagado', scale: 'scale_1_5', applies_to: 'match', sort_order: 1, is_active: false },
  ];

  it('criterios de partido: activos, de partido o ambos, en orden', () => {
    expect(criteriosDePartido(criterios).map((c) => c.metric_key)).toEqual(['actitud', 'rol', 'comentario']);
  });

  it('arma p_entries solo con valores y solo de evaluables; el texto va en notes con value 0', () => {
    const evaluables = [{ subject_type: 'child', subject_id: 'a' }];
    const planilla = {
      'child:a': { actitud: { value: 4 as const }, rol: { value: '' as const }, comentario: { notes: '  Muy bien  ' } },
      'child:zz': { actitud: { value: 5 as const } }, // no convocada
    };
    const crit = criteriosDePartido(criterios);
    expect(entradasEvaluacion(planilla, crit, evaluables)).toEqual([
      { subject_type: 'child', subject_id: 'a', metric_key: 'actitud', value: 4, notes: null },
      { subject_type: 'child', subject_id: 'a', metric_key: 'comentario', value: 0, notes: 'Muy bien' },
    ]);
    expect(evaluadasDe(planilla, crit, evaluables)).toBe(1);
  });

  it('lo guardado vuelve a la planilla', () => {
    const p = planillaDesdeFilas(
      [
        { subject_type: 'child', subject_id: 'a', metric_key: 'actitud', value: 3, notes: null },
        { subject_type: 'child', subject_id: 'a', metric_key: 'comentario', value: 0, notes: 'Bien' },
      ],
      criterios,
    );
    expect(p).toEqual({ 'child:a': { actitud: { value: 3 }, comentario: { notes: 'Bien' } } });
  });
});

describe('BARRA_GUARDAR (B1: el botón queda debajo de la barra de pestañas)', () => {
  it('en el celular se apoya encima de MobileBottomNav, no en bottom-0', () => {
    const clases = BARRA_GUARDAR.split(' ');
    expect(clases).toContain('bottom-nav-safe');
    expect(clases).not.toContain('bottom-0');
    // MobileBottomNav es z-30: la barra no puede quedar por debajo.
    expect(clases).toContain('z-30');
  });
  it('deja libre la esquina del botón de Mapi y vuelve al flujo en escritorio', () => {
    const clases = BARRA_GUARDAR.split(' ');
    expect(clases).toContain('pr-20');
    expect(clases).toContain('md:static');
  });
});
