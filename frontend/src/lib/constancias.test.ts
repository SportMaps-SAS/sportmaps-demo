import { describe, expect, it } from 'vitest';
import {
  estadoEscuela,
  etiquetaTipo,
  fraseFaltantes,
  insertarVariable,
  parametroVerificacion,
  PLANTILLAS_SUGERIDAS,
  variablesDesconocidas,
} from './constancias';

describe('etiquetaTipo', () => {
  it('nunca muestra la clave en inglés', () => {
    expect(etiquetaTipo('study')).toBe('Estudio / inscripción');
    expect(etiquetaTipo('payment')).toBe('Paz y salvo');
    expect(etiquetaTipo('raro')).toBe('Constancia');
    expect(etiquetaTipo(null)).toBe('Constancia');
  });
});

describe('variablesDesconocidas', () => {
  it('marca las mal escritas y acepta las del catálogo y las heredadas', () => {
    expect(variablesDesconocidas('{{atleta.nombres}} {{atleta.nombre}} {{ fecha_actual }} {{inscripcion.estado}}')).toEqual(['atleta.nombres']);
  });
  it('las plantillas sugeridas no tienen variables inventadas', () => {
    for (const p of PLANTILLAS_SUGERIDAS) expect(variablesDesconocidas(p.body_template)).toEqual([]);
  });
});

describe('insertarVariable', () => {
  it('inserta en el cursor y reemplaza la selección', () => {
    expect(insertarVariable('Hola !', 5, 5, 'atleta.nombre')).toEqual({ texto: 'Hola {{atleta.nombre}}!', cursor: 22 });
    expect(insertarVariable('Hola XX!', 5, 7, 'folio')).toEqual({ texto: 'Hola {{folio}}!', cursor: 14 });
  });
  it('un cursor fuera de rango va al final', () => {
    expect(insertarVariable('ab', 99, 99, 'sede').texto).toBe('ab{{sede}}');
  });
});

describe('estadoEscuela', () => {
  it('lo heredado «pendiente de pago» se ve como por aprobar (hoy no se cobra)', () => {
    expect(estadoEscuela('pending_payment').label).toBe('Por aprobar');
    expect(estadoEscuela('pending_review').label).toBe('Por aprobar');
    expect(estadoEscuela('revoked').label).toBe('Anulada');
  });
});

describe('parametroVerificacion', () => {
  it('un uuid va como token, lo demás como folio en mayúsculas', () => {
    expect(parametroVerificacion('1ea4dd0c-2488-4c68-a73a-76dd2fc9044a')).toEqual({ p_folio: null, p_qr_token: '1ea4dd0c-2488-4c68-a73a-76dd2fc9044a' });
    expect(parametroVerificacion(' ccd-2026-00002 ')).toEqual({ p_folio: 'CCD-2026-00002', p_qr_token: null });
    expect(parametroVerificacion('')).toEqual({ p_folio: null, p_qr_token: null });
  });
});

describe('fraseFaltantes', () => {
  it('arma la frase en español', () => {
    expect(fraseFaltantes([])).toBeNull();
    expect(fraseFaltantes([{ etiqueta: 'Número de documento' }])).toBe('Faltó un dato en la ficha: número de documento.');
    expect(fraseFaltantes([{ etiqueta: 'Sede' }, { etiqueta: 'Equipo' }, { etiqueta: 'Edad' }])).toBe('Faltaron datos en la ficha: sede, equipo y edad.');
  });
});
