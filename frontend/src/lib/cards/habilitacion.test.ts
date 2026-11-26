import { describe, expect, it } from 'vitest';
import {
  fechaCorta, filasEmergencia, hoyBogota, normalizarDiasAviso, peorEstado, REGLAS_POR_DEFECTO,
  reglasDeFila, validarVigencia, vistaDeEstado, type EstadoHabilitacionRpc,
} from './habilitacion';

const CRITERIOS = [
  { clave: 'pagos', etiqueta: 'Pagos al día', estado: 'rojo' as const, detalle: '4 cobros vencidos desde el 10/08/2026', fecha: '2026-08-10' },
  { clave: 'seguro', etiqueta: 'Seguro deportivo', estado: 'amarillo' as const, detalle: 'Vence el 29/11/2026', fecha: '2026-11-29' },
  { clave: 'autorizacion_evento', etiqueta: 'Autorización', estado: 'no_aplica' as const, detalle: null, fecha: null },
];

describe('vistaDeEstado', () => {
  it('sin acceso: found false, sin nivel o respuesta vacía', () => {
    expect(vistaDeEstado({ found: false })).toEqual({ tipo: 'sin_acceso' });
    expect(vistaDeEstado({ found: true })).toEqual({ tipo: 'sin_acceso' });
    expect(vistaDeEstado(null)).toEqual({ tipo: 'sin_acceso' });
  });

  it('evento que no es de la escuela', () => {
    expect(vistaDeEstado({ found: true, nivel: 'admin', error: 'evento_no_valido' })).toEqual({ tipo: 'evento_no_valido' });
  });

  it('coach: semáforo y motivo; el detalle se descarta aunque viniera', () => {
    const raw: EstadoHabilitacionRpc = {
      found: true, nivel: 'coach', semaforo: 'rojo', motivo: 'Tiene cobros vencidos (+2 más)',
      criterios: CRITERIOS, sujeto: { school_id: 's', tipo: 'child', id: 'c' },
      emergencia: { emergency_contact: 'Marcela 321', blood_type: 'O+', eps_name: null },
    };
    const v = vistaDeEstado(raw);
    expect(v).toMatchObject({ tipo: 'ok', nivel: 'coach', semaforo: 'rojo', titulo: 'No habilitado', conDetalle: false, criterios: [], sujeto: null });
    if (v.tipo !== 'ok') throw new Error('tipo');
    expect(v.motivo).toBe('Tiene cobros vencidos (+2 más)');
    expect(v.emergencia).toEqual([{ etiqueta: 'RH', valor: 'O+' }, { etiqueta: 'Contacto de emergencia', valor: 'Marcela 321' }]);
  });

  it('admin / acudiente: detalle completo', () => {
    const v = vistaDeEstado({ found: true, nivel: 'acudiente', semaforo: 'amarillo', motivo: 'El seguro vence el 29/11', criterios: CRITERIOS, eventos: [] });
    expect(v).toMatchObject({ tipo: 'ok', conDetalle: true, titulo: 'Habilitado, revisar pronto' });
    if (v.tipo !== 'ok') throw new Error('tipo');
    expect(v.criterios).toHaveLength(3);
  });

  it('sin semáforo válido lo deduce del peor criterio; sin motivo usa el título', () => {
    const v = vistaDeEstado({ found: true, nivel: 'admin', criterios: CRITERIOS });
    expect(v).toMatchObject({ tipo: 'ok', semaforo: 'rojo', motivo: 'No habilitado' });
  });
});

describe('peorEstado', () => {
  it('gana el peor; no_aplica no pesa', () => {
    expect(peorEstado(['verde', 'amarillo', 'no_aplica'])).toBe('amarillo');
    expect(peorEstado(['verde', 'rojo', 'amarillo'])).toBe('rojo');
    expect(peorEstado(['no_aplica'])).toBe('verde');
    expect(peorEstado([])).toBe('verde');
  });
});

describe('filasEmergencia', () => {
  it('solo lo que tiene valor, en orden RH, EPS, contacto', () => {
    expect(filasEmergencia({ eps_name: 'Sura', emergency_contact: '  ' })).toEqual([{ etiqueta: 'EPS', valor: 'Sura' }]);
    expect(filasEmergencia(undefined)).toEqual([]);
  });
});

describe('reglas para entrar', () => {
  it('sin fila: pagos + inscripción, 7 días', () => {
    expect(reglasDeFila(null)).toEqual(REGLAS_POR_DEFECTO);
    expect(REGLAS_POR_DEFECTO).toMatchObject({ pagos: true, inscripcion: true, seguro: false, dias_aviso: 7 });
  });
  it('con fila: respeta lo guardado', () => {
    expect(reglasDeFila({ pagos: false, seguro: true, dias_aviso: 15 })).toMatchObject({ pagos: false, seguro: true, inscripcion: true, dias_aviso: 15 });
  });
  it('días de aviso entre 0 y 60', () => {
    expect(normalizarDiasAviso(90)).toBe(60);
    expect(normalizarDiasAviso(-3)).toBe(0);
    expect(normalizarDiasAviso('10')).toBe(10);
    expect(normalizarDiasAviso('')).toBe(7);
    expect(normalizarDiasAviso(undefined)).toBe(7);
  });
});

describe('vigencia de documentos', () => {
  const HOY = '2026-11-26';
  it('seguro y certificado exigen fecha real y no pasada', () => {
    expect(validarVigencia('sports_insurance', '', null, HOY)).toBe('Pon la fecha en que vence.');
    expect(validarVigencia('medical_certificate', '2026-02-30', null, HOY)).toBe('La fecha de vencimiento no es válida.');
    expect(validarVigencia('sports_insurance', '2026-11-25', null, HOY)).toBe('Esa fecha ya pasó: el documento está vencido.');
    expect(validarVigencia('sports_insurance', '2026-11-26', null, HOY)).toBeNull();
  });
  it('la autorización exige evento; fecha opcional', () => {
    expect(validarVigencia('event_authorization', '', null, HOY)).toBe('Elige el evento.');
    expect(validarVigencia('event_authorization', '', 'ev-1', HOY)).toBeNull();
  });
  it('hoy en Bogotá y fecha corta', () => {
    expect(hoyBogota(new Date('2026-11-27T03:00:00Z'))).toBe('2026-11-26');
    expect(fechaCorta('2026-11-29')).toBe('29/11/2026');
    expect(fechaCorta(null)).toBe('');
  });
});
