/** «Mi semana» del profe: los ajustes de UNA fecha sobre el horario fijo (lógica pura). */
import { describe, it, expect } from 'vitest';
import { entrenosDelHorario } from '../sesionesModel';
import {
  entrenosDelDia, entrenosDelHorarioConAjustes, errorDeAccion, esFechaIso, etiquetaEstado, filaDeAccion, finCorrido,
  hhmm, horarioTexto, leerAjustes, leerClasesPruebaSemana, lineaClasePrueba, mensajeDeError, planRepetir, semanasHasta,
  textoPagoClase, type AjusteSemana, type EquipoSemana,
} from './semanaAjustesModel';

// 2026-10-26 es lunes; 31 = sábado, 1-nov = domingo.
const LUNES = '2026-10-26';
const SAB = '2026-10-31';
const DOM = '2026-11-01';

const EQUIPOS: EquipoSemana[] = [
  { id: 't-inf', name: 'Infantil F', franjas: [{ day: 6, time: '08:00', end: '10:00', place: 'Pinar 2' }, { day: 0, time: '08:00', end: '10:00', place: 'Pinar 2' }] },
  { id: 't-u17', name: 'U17 M', franjas: [{ day: 6, time: '13:00', end: '15:00', place: 'Liceo Fesan' }, { day: 6, time: '16:00', end: '17:30' }, { day: 3, time: '16:00' }] },
  { id: 't-sin', name: 'Sin horario', franjas: [] },
];

let n = 0;
const aj = (p: Partial<AjusteSemana> & Pick<AjusteSemana, 'team_id' | 'fecha' | 'tipo'>): AjusteSemana => ({
  id: `a${++n}`, hora_original: null, hora_inicio: null, hora_fin: null, lugar: null, motivo: null, ...p,
});

describe('hhmm', () => {
  it('normaliza las horas de la base y del horario', () => {
    expect(hhmm('08:00:00')).toBe('08:00');
    expect(hhmm('8:00')).toBe('08:00');
    expect(hhmm('16:30')).toBe('16:30');
    expect(hhmm('25:00')).toBeNull();
    expect(hhmm('')).toBeNull();
    expect(hhmm(null)).toBeNull();
  });
});

describe('sin ajustes la semana es la de siempre', () => {
  it('entrenosDelHorarioConAjustes da EXACTAMENTE lo de entrenosDelHorario, día por día', () => {
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(2026, 9, 26 + i)).toISOString().slice(0, 10);
      expect(entrenosDelHorarioConAjustes(d, EQUIPOS, [])).toEqual(entrenosDelHorario(d, EQUIPOS));
    }
  });

  it('ajustes de OTRA fecha no cambian nada', () => {
    const otros = [aj({ team_id: 't-inf', fecha: DOM, tipo: 'cancelada' })];
    expect(entrenosDelHorarioConAjustes(SAB, EQUIPOS, otros)).toEqual(entrenosDelHorario(SAB, EQUIPOS));
  });

  it('entrenosDelDia sin ajustes: todos los del horario, normales y en orden de hora', () => {
    const r = entrenosDelDia(SAB, EQUIPOS, []);
    expect(r.map((e) => `${e.hora} ${e.nombre} ${e.estado}`)).toEqual([
      '08:00 Infantil F normal', '13:00 U17 M normal', '16:00 U17 M normal',
    ]);
    expect(r[0]).toMatchObject({ horaFin: '10:00', lugar: 'Pinar 2', horaBase: '08:00', ajustes: [] });
  });
});

describe('aplicar los ajustes', () => {
  it('cancelada con hora: solo ese entreno, con su motivo, y deja de contar para el día', () => {
    const c = aj({ team_id: 't-u17', fecha: SAB, tipo: 'cancelada', hora_original: '13:00:00', motivo: 'lluvia' });
    const r = entrenosDelDia(SAB, EQUIPOS, [c]);
    const u17 = r.filter((e) => e.teamId === 't-u17');
    expect(u17.map((e) => e.estado)).toEqual(['cancelada', 'normal']);
    expect(u17[0]).toMatchObject({ motivo: 'lluvia', ajustes: [c] });
    expect(etiquetaEstado(u17[0])).toBe('Cancelado · lluvia');
    // El primer entreno que queda de U17 es el de las 4.
    expect(entrenosDelHorarioConAjustes(SAB, EQUIPOS, [c]).find((e) => e.teamId === 't-u17')?.hora).toBe('4:00 p. m.');
  });

  it('cancelada sin hora = todo el día (del horario fijo); el equipo no entrena ese día', () => {
    const c = aj({ team_id: 't-u17', fecha: SAB, tipo: 'cancelada' });
    const r = entrenosDelDia(SAB, EQUIPOS, [c]).filter((e) => e.teamId === 't-u17');
    expect(r.map((e) => e.estado)).toEqual(['cancelada', 'cancelada']);
    expect(entrenosDelHorarioConAjustes(SAB, EQUIPOS, [c]).map((e) => e.teamId)).toEqual(['t-inf']);
  });

  it('un extra sigue aunque se cancele todo el día (se agregó a propósito)', () => {
    const c = aj({ team_id: 't-inf', fecha: SAB, tipo: 'cancelada' });
    const x = aj({ team_id: 't-inf', fecha: SAB, tipo: 'extra', hora_inicio: '11:00', hora_fin: '12:00', lugar: 'Coliseo' });
    const r = entrenosDelDia(SAB, EQUIPOS, [c, x]).filter((e) => e.teamId === 't-inf');
    expect(r.map((e) => `${e.hora} ${e.estado}`)).toEqual(['08:00 cancelada', '11:00 extra']);
    expect(entrenosDelHorarioConAjustes(SAB, EQUIPOS, [c, x]).find((e) => e.teamId === 't-inf')?.hora).toBe('11:00 a. m.');
  });

  it('movida: va a la hora y el lugar nuevos; sin lugar nuevo, conserva el de siempre', () => {
    const m = aj({ team_id: 't-inf', fecha: SAB, tipo: 'movida', hora_original: '08:00:00', hora_inicio: '09:30:00', hora_fin: '11:30:00' });
    const [inf] = entrenosDelDia(SAB, EQUIPOS, [m]);
    expect(inf).toMatchObject({ estado: 'movida', hora: '09:30', horaFin: '11:30', lugar: 'Pinar 2', horaBase: '08:00', lugarBase: 'Pinar 2', ajustes: [m] });
    expect(horarioTexto(inf)).toBe('9:30 a. m. – 11:30 a. m. · Pinar 2');
    expect(etiquetaEstado(inf)).toBe('Cambiado');
    const conLugar = aj({ ...m, id: 'm2', lugar: 'Liceo Fesan' });
    expect(entrenosDelDia(SAB, EQUIPOS, [conLugar])[0].lugar).toBe('Liceo Fesan');
  });

  it('movida y después cancelada: gana la cancelación y «Deshacer» ve las dos', () => {
    const m = aj({ team_id: 't-inf', fecha: SAB, tipo: 'movida', hora_original: '08:00', hora_inicio: '09:00' });
    const c = aj({ team_id: 't-inf', fecha: SAB, tipo: 'cancelada', hora_original: '08:00' });
    const [inf] = entrenosDelDia(SAB, EQUIPOS, [m, c]);
    expect(inf.estado).toBe('cancelada');
    expect(inf.ajustes.map((a) => a.id)).toEqual([c.id, m.id]);
  });

  it('una movida cuya hora ya no está en el horario se muestra igual', () => {
    const m = aj({ team_id: 't-inf', fecha: SAB, tipo: 'movida', hora_original: '07:00', hora_inicio: '07:30' });
    const r = entrenosDelDia(SAB, EQUIPOS, [m]).filter((e) => e.teamId === 't-inf');
    expect(r.map((e) => `${e.hora} ${e.estado}`)).toEqual(['07:30 movida', '08:00 normal']);
  });

  it('extra en un día sin horario: aparece como entreno', () => {
    const x = aj({ team_id: 't-sin', fecha: '2026-10-28', tipo: 'extra', hora_inicio: '18:00' });
    expect(entrenosDelHorarioConAjustes('2026-10-28', EQUIPOS, [x])).toEqual([
      { teamId: 't-u17', nombre: 'U17 M', hora: '4:00 p. m.' },
      { teamId: 't-sin', nombre: 'Sin horario', hora: '6:00 p. m.' },
    ]);
  });
});

describe('leerAjustes', () => {
  it('normaliza las horas y descarta filas que no se entienden', () => {
    const r = leerAjustes([
      { id: 'a', team_id: 't', fecha: '2026-10-31', tipo: 'movida', hora_original: '08:00:00', hora_inicio: '09:00:00', hora_fin: null, lugar: '  ', motivo: null },
      { id: 'b', team_id: 't', fecha: '2026-10-31', tipo: 'otra' },
      { team_id: 't', fecha: '2026-10-31', tipo: 'extra' },
      null,
    ]);
    expect(r).toEqual([{ id: 'a', team_id: 't', fecha: '2026-10-31', tipo: 'movida', hora_original: '08:00', hora_inicio: '09:00', hora_fin: null, lugar: null, motivo: null }]);
    expect(leerAjustes(null)).toEqual([]);
  });
});

describe('repetir los ajustes de la semana pasada', () => {
  it('cuenta lo de la semana anterior, por equipo, sin lo que ya se copió ni otros equipos', () => {
    const ajustes = [
      aj({ team_id: 't-inf', fecha: '2026-10-24', tipo: 'cancelada', hora_original: '08:00' }),
      aj({ team_id: 't-inf', fecha: '2026-10-25', tipo: 'cancelada', hora_original: '08:00' }),
      aj({ team_id: 't-u17', fecha: '2026-10-24', tipo: 'extra', hora_inicio: '11:00' }),
      // Ya copiado a esta semana:
      aj({ team_id: 't-u17', fecha: SAB, tipo: 'extra', hora_inicio: '11:00' }),
      // De otro equipo (no es del profe) y de hace dos semanas:
      aj({ team_id: 't-otro', fecha: '2026-10-24', tipo: 'cancelada' }),
      aj({ team_id: 't-inf', fecha: '2026-10-17', tipo: 'cancelada' }),
    ];
    const r = planRepetir(ajustes, LUNES, ['t-inf', 't-u17']);
    expect(r.total).toBe(2);
    expect([...r.porEquipo.entries()]).toEqual([['t-inf', 2]]);
  });

  it('sin nada la semana pasada, no hay botón', () => {
    expect(planRepetir([], LUNES, ['t-inf']).total).toBe(0);
  });
});

describe('semanasHasta (el link del aviso abre la semana de ese día)', () => {
  it('cuenta semanas de lunes a domingo', () => {
    expect(semanasHasta('2026-10-28', '2026-10-26')).toBe(0);
    expect(semanasHasta('2026-10-28', DOM)).toBe(0); // el domingo es de la misma semana
    expect(semanasHasta('2026-10-28', '2026-11-02')).toBe(1);
    expect(semanasHasta('2026-10-28', '2026-10-25')).toBe(-1);
    expect(semanasHasta('2026-10-28', '2026-12-01')).toBe(5);
  });

  it('esFechaIso solo acepta YYYY-MM-DD', () => {
    expect(esFechaIso('2026-10-31')).toBe(true);
    expect(esFechaIso('31/10/2026')).toBe(false);
    expect(esFechaIso(null)).toBe(false);
  });
});

describe('lo que se guarda respeta los CHECK de la tabla', () => {
  const ctx = { schoolId: 's1', userId: 'u1' };

  it('cancelar: hora_original y nada más; el motivo solo si hay', () => {
    expect(filaDeAccion({ tipo: 'cancelar', teamId: 't', fecha: SAB, horaOriginal: '08:00', motivo: 'lluvia' }, ctx)).toEqual({
      school_id: 's1', team_id: 't', fecha: SAB, creado_por: 'u1', tipo: 'cancelada',
      hora_original: '08:00', hora_inicio: null, hora_fin: null, lugar: null, motivo: 'lluvia',
    });
    const sinMotivo = filaDeAccion({ tipo: 'cancelar', teamId: 't', fecha: SAB, horaOriginal: null, motivo: null }, ctx);
    expect(sinMotivo).not.toHaveProperty('motivo');
    expect(sinMotivo.hora_original).toBeNull();
  });

  it('mover lleva hora_original y hora_inicio; extra lleva hora_inicio y NO hora_original', () => {
    expect(filaDeAccion({ tipo: 'mover', teamId: 't', fecha: SAB, horaOriginal: '08:00', horaInicio: '09:00', horaFin: '11:00', lugar: ' Coliseo ' }, ctx))
      .toMatchObject({ tipo: 'movida', hora_original: '08:00', hora_inicio: '09:00', hora_fin: '11:00', lugar: 'Coliseo' });
    expect(filaDeAccion({ tipo: 'extra', teamId: 't', fecha: SAB, horaInicio: '11:00', horaFin: null, lugar: '' }, ctx))
      .toMatchObject({ tipo: 'extra', hora_original: null, hora_inicio: '11:00', hora_fin: null, lugar: null });
  });

  it('valida en palabras del profe', () => {
    expect(errorDeAccion({ tipo: 'extra', teamId: 't', fecha: SAB, horaInicio: '', horaFin: null, lugar: null })).toBe('Escribe la hora de inicio.');
    expect(errorDeAccion({ tipo: 'mover', teamId: 't', fecha: SAB, horaOriginal: '08:00', horaInicio: '10:00', horaFin: '09:00', lugar: null }))
      .toBe('La hora de fin tiene que ser después de la de inicio.');
    expect(errorDeAccion({ tipo: 'extra', teamId: 't', fecha: '', horaInicio: '10:00', horaFin: null, lugar: null })).toBe('Elige el día.');
    expect(errorDeAccion({ tipo: 'deshacer', teamId: 't', ajusteIds: [] })).toBe('No hay nada que deshacer.');
    expect(errorDeAccion({ tipo: 'cancelar', teamId: 't', fecha: SAB, horaOriginal: '08:00', motivo: null })).toBeNull();
  });

  it('al mover, la hora de fin corre igual que la de inicio', () => {
    expect(finCorrido('08:00', '10:00', '09:30')).toBe('11:30');
    expect(finCorrido('08:00', null, '09:30')).toBe('');
    expect(finCorrido('20:00', '23:00', '22:00')).toBe('');
  });

  it('los errores de la base salen en palabras', () => {
    expect(mensajeDeError({ code: '42501' })).toMatch(/permiso/);
    expect(mensajeDeError({ code: '23505' })).toMatch(/ya tiene ese cambio/);
    expect(mensajeDeError({ code: '23514' })).toMatch(/Revisa las horas/);
    expect(mensajeDeError({ code: 'XX', message: 'duplicate key value violates' })).not.toMatch(/duplicate/);
  });
});

describe('clases de prueba de la semana (RPC clases_prueba_semana)', () => {
  it('lee la forma de la migración 20261030123543 (franja, equipo y equipo_recomendado anidados)', () => {
    const [c] = leerClasesPruebaSemana([{
      lead_id: 'l1', nombre: 'Mariana Gómez', anio: 2011, sexo: 'female', respuestas: { posicion: 'Punta' },
      estado_cupo: 'agendada', separado_hasta: null,
      franja: { id: 's1', fecha: SAB, hora_inicio: '08:00:00', hora_fin: '10:00:00', etiqueta: 'Infantil F · Pinar 2', lugar: 'Pinar 2' },
      equipo: { id: 't-inf', nombre: 'Infantil F' },
      equipo_recomendado: { id: 't-u15', nombre: 'U15 F' },
      pago: { estado: 'awaiting_approval' }, asistencia: 'asistio', etapa: 'asistio',
    }]);
    expect(c).toEqual({
      leadId: 'l1', nombre: 'Mariana Gómez', anio: 2011, sexo: 'Mujer', respuestas: ['Punta'], fecha: SAB, hora: '08:00',
      teamId: 't-inf', equipo: 'Infantil F', estadoCupo: 'agendada', pago: 'en_revision', asistencia: 'asistio', teamRecomendado: 't-u15',
    });
    // Sin equipo en la franja (cupo cargado a mano): no es de nadie, y la vista la descarta.
    const [sinEquipo] = leerClasesPruebaSemana([{ lead_id: 'l2', nombre: 'X', equipo: null, franja: { fecha: SAB, etiqueta: 'Manual' } }]);
    expect(sinEquipo).toMatchObject({ teamId: null, equipo: 'Manual', estadoCupo: null });
  });

  it('lee las claves canónicas y las alternativas, sin teléfono', () => {
    const r = leerClasesPruebaSemana([
      { lead_id: 'l1', nombre: 'Mariana Gómez', anio: 2011, sexo: 'F', respuestas: { posicion: 'Punta', trayectoria: 'Club y torneos', trayectoria_detalle: 'Club Titanes' },
        fecha: SAB, hora: '08:00:00', team_id: 't-inf', equipo: 'Infantil F', estado_cupo: 'agendada', pago: { estado: 'paid', monto: 15000 }, asistencia: null },
      { id: 'l2', full_name: 'Samuel Ortiz', birth_date: '2009-05-02', gender: 'male', slot_date: DOM, start_time: '16:00', slot_team_id: 't-u17',
        team_name: 'U17 M', estado_cupo: 'separado', pago_estado: null, asistencia: 'no_vino', team_recomendado: 't-u19', phone: '3001234567' },
      { nombre: 'Sin id' },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      leadId: 'l1', nombre: 'Mariana Gómez', anio: 2011, sexo: 'Mujer', respuestas: ['Punta', 'Club y torneos (Club Titanes)'],
      fecha: SAB, hora: '08:00', teamId: 't-inf', equipo: 'Infantil F', estadoCupo: 'agendada', pago: 'pagado', asistencia: null, teamRecomendado: null,
    });
    expect(r[1]).toMatchObject({ leadId: 'l2', anio: 2009, sexo: 'Hombre', teamId: 't-u17', estadoCupo: 'separada', pago: null, asistencia: 'no_vino', teamRecomendado: 't-u19' });
    expect(JSON.stringify(r)).not.toContain('3001234567');
    expect(leerClasesPruebaSemana({ clases: [{ lead_id: 'x', nombre: 'X' }] })).toHaveLength(1);
    expect(leerClasesPruebaSemana(null)).toEqual([]);
  });

  it('la línea del chip y el estado del pago', () => {
    const [c] = leerClasesPruebaSemana([{ lead_id: 'l1', nombre: 'Mariana', anio: 2011, sexo: 'F', respuestas: { posicion: 'Punta' }, pago: 'awaiting_approval' }]);
    expect(lineaClasePrueba(c)).toBe('Mariana · 2011 · Punta');
    expect(textoPagoClase(c)).toBe('Pago en revisión');
    expect(textoPagoClase({ pago: 'pagado', estadoCupo: 'agendada' })).toBe('Pagó ✅');
    expect(textoPagoClase({ pago: null, estadoCupo: 'separada' })).toBe('Cupo separado · sin comprobante');
    expect(textoPagoClase({ pago: null, estadoCupo: 'agendada' })).toBeNull(); // gratis: nada que decir
    const [sinResp] = leerClasesPruebaSemana([{ lead_id: 'l2', nombre: 'Samuel', anio: 2009, sexo: 'M' }]);
    expect(lineaClasePrueba(sinResp)).toBe('Samuel · 2009 · Hombre');
  });
});
