import { describe, it, expect } from 'vitest';
import { normBirthDate, normDocument, normShirt, parseRosterJson } from './roster-sheet-ocr.service';

describe('OCR de nómina: parseo de la respuesta (E2E B4)', () => {
  it('lee la nómina impresa de la prueba E2E (Nombre / Documento / Nacimiento)', () => {
    const r = parseRosterJson(JSON.stringify({
      is_roster: true, title: 'Planilla Titanes Vóley', team: 'Titanes',
      players: [
        { name: 'Laura Pérez', shirt_number: null, document_number: '1011111111', birth_date: '2012-03-04', position: null, struck: false },
        { name: 'Sofía Gómez', document_number: '1.011.111.112', birth_date: '19/07/2012' },
        { name: 'Valeria Ruiz', shirt_number: '#10', document_number: 'TI 1011111113', birth_date: '2013-01-22', position: 'Armadora' },
      ],
    }), 'gemini');
    expect(r.isRoster).toBe(true);
    expect(r.title).toBe('Planilla Titanes Vóley');
    expect(r.rows).toEqual([
      { name: 'Laura Pérez', shirt_number: null, document_number: '1011111111', birth_date: '2012-03-04', position: null, struck: false },
      { name: 'Sofía Gómez', shirt_number: null, document_number: '1011111112', birth_date: '2012-07-19', position: null, struck: false },
      { name: 'Valeria Ruiz', shirt_number: '10', document_number: '1011111113', birth_date: '2013-01-22', position: 'Armadora', struck: false },
    ]);
  });

  it('tolera ```json, filas sin nombre, "null" como texto y JSON roto', () => {
    const r = parseRosterJson('```json\n{"players":[{"name":"  Ana  Ruiz "},{"name":""},{"shirt_number":"3"},{"name":"Bea","birth_date":"null","struck":true}]}\n```', 'openai');
    expect(r.rows.map((x) => [x.name, x.birth_date, x.struck])).toEqual([['Ana Ruiz', null, false], ['Bea', null, true]]);
    expect(parseRosterJson('{"players":[{"name":"Ana"', 'gemini').rows).toEqual([]);
    expect(parseRosterJson('{"is_roster":false,"players":[]}', 'gemini').isRoster).toBe(false);
  });

  it('normaliza dorsal, documento y fecha (DD/MM/AAAA colombiano)', () => {
    expect(normShirt('No. 07')).toBe('7');
    expect(normShirt(12)).toBe('12');
    expect(normShirt('1234')).toBeNull();
    expect(normDocument('CC 1020304050')).toBe('1020304050');
    expect(normDocument('12')).toBeNull();
    expect(normBirthDate('4/3/2012')).toBe('2012-03-04');
    expect(normBirthDate('2012/7/9')).toBe('2012-07-09');
    expect(normBirthDate('31/02/2012')).toBeNull();
    expect(normBirthDate('marzo 2012')).toBeNull();
  });
});
