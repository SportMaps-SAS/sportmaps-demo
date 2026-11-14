/**
 * Arreglos de las pruebas del Entrenador V2 (2026-10-27): B3, B6, B8 y la lista
 * del usuario (pizarra, día libre, horario).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUTAS_COACH_V2, equiposSinHorario, mensajeErrorEvaluar, resumenSemana } from './coachV2Logic';
import { ColaDeshacer, DESHACER_MS } from './useAccionConDeshacer';
import { rutaPlanear } from './sesionesModel';
import { AVISO_SIN_PERMISO_HORARIO, agregarFranjas, errorHorario, esSinPermiso } from './horarioModel';

describe('Evaluar al equipo: errores de verdad (B3)', () => {
  it('sin red dice que no se guardó por la conexión', () => {
    expect(mensajeErrorEvaluar({ message: 'TypeError: Failed to fetch' })).toMatch(/Sin conexión/);
    expect(mensajeErrorEvaluar(null)).toMatch(/Sin conexión/);
  });

  it('una regla de la base se muestra tal cual (no «revisa tu conexión»)', () => {
    const m = mensajeErrorEvaluar({ code: '55000', message: 'La escuela no tiene configurada la métrica de rating del coach.' });
    expect(m).toBe('No se guardó: La escuela no tiene configurada la métrica de rating del coach.');
    expect(m).not.toMatch(/conexión/);
    expect(mensajeErrorEvaluar({ code: '55000', message: 'El informe de este periodo ya fue publicado para x' })).toMatch(/publicado para x\.$/);
  });

  it('sin permiso y errores del servidor', () => {
    expect(mensajeErrorEvaluar({ code: '42501', message: 'No autorizado' })).toMatch(/no figuras como entrenador/);
    expect(mensajeErrorEvaluar({ code: 'XX000', message: 'boom' })).toMatch(/error del servidor/);
  });
});

describe('Deshacer no se pierde al cerrar la app (B8)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('corre sola a los 8 s', async () => {
    const cola = new ColaDeshacer();
    const run = vi.fn(async () => {});
    cola.programar('a', run);
    await vi.advanceTimersByTimeAsync(DESHACER_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cola.tamano).toBe(0);
  });

  it('Deshacer cancela sin escribir; después ya no aplica', async () => {
    const cola = new ColaDeshacer();
    const run = vi.fn(async () => {});
    cola.programar('a', run);
    expect(cola.deshacer('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(DESHACER_MS * 2);
    expect(run).not.toHaveBeenCalled();
    expect(cola.deshacer('a')).toBe(false);
  });

  it('vaciar (pagehide / app a segundo plano / salir de la pantalla) ejecuta todo YA, una sola vez', async () => {
    const cola = new ColaDeshacer();
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    cola.programar('a', a);
    cola.programar('b', b);
    cola.vaciar();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DESHACER_MS * 2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('programar el mismo id reemplaza la acción anterior', async () => {
    const cola = new ColaDeshacer();
    const vieja = vi.fn(async () => {});
    const nueva = vi.fn(async () => {});
    cola.programar('a', vieja);
    cola.programar('a', nueva);
    await vi.advanceTimersByTimeAsync(DESHACER_MS);
    expect(vieja).not.toHaveBeenCalled();
    expect(nueva).toHaveBeenCalledTimes(1);
  });
});

describe('«Planear» lleva al equipo y al día (B6)', () => {
  it('arma la query', () => {
    expect(rutaPlanear('/training-plans/planificar', { equipo: 't1', fecha: '2026-10-27' })).toBe('/training-plans/planificar?equipo=t1&fecha=2026-10-27');
    expect(rutaPlanear('/training-plans/planificar', { equipo: 't1' })).toBe('/training-plans/planificar?equipo=t1');
    expect(rutaPlanear('/training-plans/planificar')).toBe('/training-plans/planificar');
    expect(rutaPlanear('/x?a=1', { fecha: '2026-10-27' })).toBe('/x?a=1&fecha=2026-10-27');
  });
});

describe('Hoy: pizarra y día libre (ítems 3 y 30)', () => {
  it('la pizarra libre es /pizarra', () => {
    expect(RUTAS_COACH_V2.pizarra).toBe('/pizarra');
  });

  it('resumen de la semana: de lunes a hoy', () => {
    // Martes 27-oct-2026: la semana arranca el lunes 26.
    const ahora = new Date(2026, 9, 27, 10, 0);
    const r = resumenSemana([
      { fecha: '2026-10-25', cerrada: true, evaluada: false }, // domingo anterior: fuera
      { fecha: '2026-10-26', cerrada: true, evaluada: false },
      { fecha: '2026-10-27', cerrada: true, evaluada: true },
      { fecha: '2026-10-27', cerrada: false, evaluada: false },
    ], ahora);
    expect(r).toEqual({ entrenos: 3, conLista: 2, sinEvaluar: 1 });
  });

  it('equipos sin horario fijo', () => {
    const e = [{ id: 'a', franjas: [] }, { id: 'b', franjas: [{ day: 1, time: '16:00' }] }];
    expect(equiposSinHorario(e).map((x) => x.id)).toEqual(['a']);
  });
});

describe('Agregar horario (ítem 31)', () => {
  it('valida días y horas', () => {
    expect(errorHorario({ dias: [], inicio: '16:00', fin: '', lugar: '' })).toMatch(/día/);
    expect(errorHorario({ dias: [2], inicio: '', fin: '', lugar: '' })).toMatch(/inicio/);
    expect(errorHorario({ dias: [2], inicio: '16:00', fin: '15:00', lugar: '' })).toMatch(/después/);
    expect(errorHorario({ dias: [2], inicio: '16:00', fin: '18:00', lugar: '' })).toBeNull();
    expect(errorHorario({ dias: [2], inicio: '16:00', fin: '', lugar: '' })).toBeNull();
  });

  it('suma franjas en el formato de teams.schedule, lunes primero y sin duplicar', () => {
    const r = agregarFranjas(
      [{ day: 2, time: '16:00', end: '17:00' }, { day: 0, time: '08:00' }],
      { dias: [4, 2], inicio: '16:00', fin: '18:00', lugar: '  Cancha 2 ' },
    );
    expect(r).toEqual([
      { day: 2, time: '16:00', end: '18:00', place: 'Cancha 2' },
      { day: 4, time: '16:00', end: '18:00', place: 'Cancha 2' },
      { day: 0, time: '08:00' },
    ]);
  });

  it('sin permiso = 42501 o 0 filas actualizadas; el aviso pide a la administración', () => {
    expect(esSinPermiso({ code: '42501' }, 0)).toBe(true);
    expect(esSinPermiso(null, 0)).toBe(true);
    expect(esSinPermiso(null, 1)).toBe(false);
    expect(esSinPermiso({ code: '08006' }, 0)).toBe(false);
    expect(AVISO_SIN_PERMISO_HORARIO).toBe('Pídele al administrador que configure el horario.');
  });
});
