import { describe, it, expect } from 'vitest';
import {
  camposAPedir, camposObligatorios, camposQueFaltan, campoValido, edadEn, esMayorDeEdad, estadoFicha,
  formularioInicial, listaLegible, textoEstado, tipoDocPorDefecto, TIPOS_DOC,
  type EnrollmentFormResult, type FormState, type IntakeItem,
} from './enrollmentIntakeModel';

const HOY = new Date(2026, 9, 29); // jueves 29 de octubre de 2026

/** Lo que la IA lee de una hoja completa de un menor de 12 años. */
function leido(overrides: Partial<EnrollmentFormResult> = {}): EnrollmentFormResult {
  return {
    athleteFullName: 'Sofía Ramírez Pérez',
    docType: 'TI',
    docNumber: '1023456789',
    dateOfBirth: '2014-03-15',
    dateOfBirthRaw: '15/03/2014',
    ageOnForm: null,
    category: 'Sub-13',
    guardianFullName: 'Carolina Pérez',
    guardianDocNumber: '52123456',
    guardianPhone: '300 123 4567',
    guardianEmail: 'carolina@gmail.com',
    athleteEmail: null,
    athletePhone: null,
    epsName: 'Sura',
    bloodType: 'O+',
    isEnrollmentForm: true,
    missingFields: [],
    provider: 'test',
    ...overrides,
  };
}

/** Ficha de la bandeja con `extracted` completo; `extracted` se fusiona con lo leído por defecto. */
function ficha(
  overrides: Omit<Partial<IntakeItem>, 'extracted'> & { extracted?: Partial<EnrollmentFormResult> | null } = {},
): IntakeItem {
  const { extracted, ...resto } = overrides;
  return {
    id: 'intake-1',
    source: 'whatsapp',
    status: 'pending',
    extracted: extracted === null ? null : leido(extracted),
    photoUrl: null,
    duplicateOfChildId: null,
    duplicateOfChildName: null,
    duplicateOfIntakeId: null,
    rejectionReason: null,
    createdAt: '2026-10-29T10:00:00Z',
    ...resto,
  };
}

/** Datos de un adulto (25 años) sin acudiente. */
const ADULTO: Partial<EnrollmentFormResult> = {
  docType: 'CC',
  dateOfBirth: '2001-06-10',
  guardianFullName: null,
  guardianDocNumber: null,
  guardianPhone: null,
  guardianEmail: null,
  athleteEmail: 'andres@correo.co',
  athletePhone: '3109876543',
};

describe('edadEn', () => {
  it('cumple años hoy: ya los tiene cumplidos', () => {
    expect(edadEn('2008-10-29', HOY)).toBe(18);
  });

  it('cumple años mañana: todavía le falta uno', () => {
    expect(edadEn('2008-10-30', HOY)).toBe(17);
  });

  it('cumplió años ayer', () => {
    expect(edadEn('2008-10-28', HOY)).toBe(18);
  });

  it('cumple en un mes posterior del año: no ha cumplido', () => {
    expect(edadEn('2010-11-01', HOY)).toBe(15);
  });

  it('fecha nula, vacía o en otro formato devuelve null', () => {
    expect(edadEn(null, HOY)).toBeNull();
    expect(edadEn(undefined, HOY)).toBeNull();
    expect(edadEn('', HOY)).toBeNull();
    expect(edadEn('15/03/2014', HOY)).toBeNull();
    expect(edadEn('no sé', HOY)).toBeNull();
  });

  it('fecha con hora usa solo la parte de la fecha', () => {
    expect(edadEn('2010-05-01T00:00:00Z', HOY)).toBe(16);
  });

  it('fecha futura (mal leída) devuelve null en vez de una edad negativa', () => {
    expect(edadEn('2030-01-01', HOY)).toBeNull();
  });

  it('nacido hoy tiene 0 años, no null', () => {
    expect(edadEn('2026-10-29', HOY)).toBe(0);
  });
});

describe('esMayorDeEdad', () => {
  it('la edad escrita en la hoja manda sobre la fecha de nacimiento', () => {
    expect(esMayorDeEdad(ficha({ extracted: { ageOnForm: 17, dateOfBirth: '1990-01-01' } }), HOY)).toBe(false);
    expect(esMayorDeEdad(ficha({ extracted: { ageOnForm: 18, dateOfBirth: '2014-03-15' } }), HOY)).toBe(true);
  });

  it('sin edad escrita usa la fecha de nacimiento', () => {
    expect(esMayorDeEdad(ficha({ extracted: { dateOfBirth: '2008-10-29' } }), HOY)).toBe(true);
    expect(esMayorDeEdad(ficha({ extracted: { dateOfBirth: '2008-10-30' } }), HOY)).toBe(false);
  });

  it('sin edad ni fecha se trata como menor', () => {
    expect(esMayorDeEdad(ficha({ extracted: { ageOnForm: null, dateOfBirth: null } }), HOY)).toBe(false);
  });

  it('sin nada leído (extracted null) se trata como menor', () => {
    expect(esMayorDeEdad(ficha({ extracted: null }), HOY)).toBe(false);
  });
});

describe('tipoDocPorDefecto', () => {
  it('respeta el tipo leído de la hoja y lo pasa a mayúsculas', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: 'TI' } }), HOY)).toBe('TI');
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: ' ce ' } }), HOY)).toBe('CE');
  });

  it('lo leído gana aunque no cuadre con la edad', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: 'cc', dateOfBirth: '2020-01-01' } }), HOY)).toBe('CC');
  });

  it('menor sin fecha ni edad queda en TI (antes salía CC por error)', () => {
    const item = ficha({ extracted: { docType: null, dateOfBirth: null, ageOnForm: null } });
    expect(tipoDocPorDefecto(item, HOY)).toBe('TI');
  });

  it('sin nada leído (extracted null) queda en TI', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: null }), HOY)).toBe('TI');
  });

  it('tipo leído vacío o solo espacios se trata como no leído', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: '   ', dateOfBirth: '2014-03-15' } }), HOY)).toBe('TI');
  });

  it('un menor de 7 años NO queda en RC: create-one no acepta RC y daba 400', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: null, dateOfBirth: '2022-01-10' } }), HOY)).toBe('TI');
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: null, ageOnForm: 6 } }), HOY)).toBe('TI');
  });

  it('RC leído de la hoja tampoco se manda: cae al default por edad', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: 'RC', dateOfBirth: '2022-01-10' } }), HOY)).toBe('TI');
  });

  it('pasaporte (PA, PASAPORTE) se manda como PP, y C.C. como CC', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: 'PA' } }), HOY)).toBe('PP');
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: 'Pasaporte' } }), HOY)).toBe('PP');
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: 'C.C.' } }), HOY)).toBe('CC');
  });

  it('todo tipo por defecto está entre los que acepta el BFF (TI/CC/CE/PP)', () => {
    for (const docType of [null, 'RC', 'NUIP', 'x', 'PA', 'ti']) {
      expect(TIPOS_DOC).toContain(tipoDocPorDefecto(ficha({ extracted: { docType } }), HOY));
    }
  });

  it('7 años ya es TI', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: null, ageOnForm: 7 } }), HOY)).toBe('TI');
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: null, dateOfBirth: '2019-10-29' } }), HOY)).toBe('TI');
  });

  it('17 años sigue en TI', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: null, dateOfBirth: '2008-10-30' } }), HOY)).toBe('TI');
  });

  it('adulto queda en CC', () => {
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: null, dateOfBirth: '2001-06-10' } }), HOY)).toBe('CC');
    expect(tipoDocPorDefecto(ficha({ extracted: { docType: null, ageOnForm: 30 } }), HOY)).toBe('CC');
  });
});

describe('campoValido', () => {
  it('acepta correos con forma de correo', () => {
    expect(campoValido('guardianEmail', 'carolina@gmail.com')).toBe(true);
    expect(campoValido('athleteEmail', 'a.b+c@sub.dominio.co')).toBe(true);
    expect(campoValido('guardianEmail', '  carolina@gmail.com  ')).toBe(true);
  });

  it('rechaza correos sin dominio completo, sin arroba o con espacios internos', () => {
    expect(campoValido('guardianEmail', 'a@b')).toBe(false);
    expect(campoValido('guardianEmail', 'carolina@gmail')).toBe(false);
    expect(campoValido('guardianEmail', 'sin arroba')).toBe(false);
    expect(campoValido('athleteEmail', 'carolina perez@gmail.com')).toBe(false);
    expect(campoValido('guardianEmail', 'carolina@gmail .com')).toBe(false);
  });

  it('el celular cuenta solo dígitos: espacios y +57 no estorban', () => {
    expect(campoValido('guardianPhone', '300 123 4567')).toBe(true);
    expect(campoValido('guardianPhone', '+57 300 123 4567')).toBe(true);
    expect(campoValido('athletePhone', '(601) 555-1234')).toBe(true);
    expect(campoValido('athletePhone', '1234567')).toBe(true);
  });

  it('el celular del acudiente pide 10 dígitos, como create-one (/^\\d{10,}$/)', () => {
    expect(campoValido('guardianPhone', '1234567')).toBe(false);
    expect(campoValido('guardianPhone', '300 123 456')).toBe(false);
    expect(campoValido('guardianPhone', '3001234567')).toBe(true);
  });

  it('el celular del deportista con menos de 7 dígitos no sirve', () => {
    expect(campoValido('athletePhone', '123456')).toBe(false);
    expect(campoValido('athletePhone', '+57 30')).toBe(false);
    expect(campoValido('athletePhone', 'no tiene')).toBe(false);
  });

  it('un correo opcional mal escrito impide crear; vacío no', () => {
    const base = formularioInicial(ficha({ extracted: { ageOnForm: 30, dateOfBirth: '1996-01-01' } }), HOY);
    expect(camposQueFaltan({ ...base, athleteEmail: '' }, true)).toEqual([]);
    expect(camposQueFaltan({ ...base, athleteEmail: 'juan@gmail' }, true)).toEqual(['athleteEmail']);
  });

  it('vacío, solo espacios, null o undefined nunca sirven', () => {
    for (const campo of ['guardianEmail', 'guardianPhone', 'athleteFullName', 'docNumber'] as const) {
      expect(campoValido(campo, '')).toBe(false);
      expect(campoValido(campo, '   ')).toBe(false);
      expect(campoValido(campo, null)).toBe(false);
      expect(campoValido(campo, undefined)).toBe(false);
    }
  });

  it('los campos libres sirven con cualquier texto no vacío', () => {
    expect(campoValido('athleteFullName', 'Sofía')).toBe(true);
    expect(campoValido('docNumber', 'abc')).toBe(true);
    expect(campoValido('epsName', 'Sura')).toBe(true);
    expect(campoValido('bloodType', 'X')).toBe(true);
  });
});

describe('camposObligatorios y camposQueFaltan', () => {
  it('menor exige nombre, documento, correo y celular del acudiente; adulto solo nombre y documento', () => {
    expect(camposObligatorios(false)).toEqual(['athleteFullName', 'docNumber', 'guardianEmail', 'guardianPhone']);
    expect(camposObligatorios(true)).toEqual(['athleteFullName', 'docNumber']);
  });

  it('menor completo no le falta nada', () => {
    expect(camposQueFaltan(formularioInicial(ficha(), HOY), false)).toEqual([]);
  });

  it('menor sin correo ni celular: faltan los dos, en ese orden', () => {
    const form = formularioInicial(ficha({ extracted: { guardianEmail: null, guardianPhone: null } }), HOY);
    expect(camposQueFaltan(form, false)).toEqual(['guardianEmail', 'guardianPhone']);
  });

  it('un correo mal escrito cuenta como faltante', () => {
    const form = formularioInicial(ficha({ extracted: { guardianEmail: 'carolina@gmail' } }), HOY);
    expect(camposQueFaltan(form, false)).toEqual(['guardianEmail']);
  });

  it('adulto no exige datos del acudiente', () => {
    const form = formularioInicial(ficha({ extracted: ADULTO }), HOY);
    expect(camposQueFaltan(form, true)).toEqual([]);
  });

  it('adulto sin documento: falta solo el documento', () => {
    const form = formularioInicial(ficha({ extracted: { ...ADULTO, docNumber: null } }), HOY);
    expect(camposQueFaltan(form, true)).toEqual(['docNumber']);
  });
});

describe('camposAPedir', () => {
  it('menor con la hoja completa: no se pide nada', () => {
    expect(camposAPedir(ficha(), HOY)).toEqual([]);
  });

  it('no pide lo que la hoja trajo válido, sí lo que no trajo', () => {
    const item = ficha({ extracted: { docNumber: null, guardianPhone: null } });
    expect(camposAPedir(item, HOY)).toEqual(['docNumber', 'guardianPhone']);
  });

  it('pide un correo mal leído aunque no esté vacío', () => {
    expect(camposAPedir(ficha({ extracted: { guardianEmail: 'carolina@gmail' } }), HOY)).toEqual(['guardianEmail']);
  });

  it('menor: pide fecha de nacimiento y nombre del acudiente si no vinieron', () => {
    const item = ficha({ extracted: { dateOfBirth: null, guardianFullName: null } });
    expect(camposAPedir(item, HOY)).toEqual(['dateOfBirth', 'guardianFullName']);
  });

  it('adulto pide su celular y su correo, y nunca datos del acudiente', () => {
    const item = ficha({ extracted: { ...ADULTO, athletePhone: null, athleteEmail: null } });
    const pedir = camposAPedir(item, HOY);
    expect(pedir).toEqual(['athletePhone', 'athleteEmail']);
    expect(pedir.some((c) => c.startsWith('guardian'))).toBe(false);
  });

  it('sin nada leído pide todo lo de un menor', () => {
    expect(camposAPedir(ficha({ extracted: null }), HOY)).toEqual([
      'athleteFullName', 'docNumber', 'dateOfBirth', 'guardianFullName', 'guardianPhone', 'guardianEmail',
    ]);
  });
});

describe('estadoFicha', () => {
  it('duplicada gana aunque esté completa', () => {
    const item = ficha({ duplicateOfChildId: 'child-9', duplicateOfChildName: 'Sofía Ramírez' });
    expect(estadoFicha(item, formularioInicial(item, HOY), HOY)).toBe('duplicada');
  });

  it('con obligatorios sin llenar está en «faltan»', () => {
    const item = ficha({ extracted: { guardianEmail: null } });
    expect(estadoFicha(item, formularioInicial(item, HOY), HOY)).toBe('faltan');
  });

  it('completa y no duplicada está «lista»', () => {
    const item = ficha();
    expect(estadoFicha(item, formularioInicial(item, HOY), HOY)).toBe('lista');
  });

  it('se evalúa contra lo que la escuela escribió, no solo contra lo leído', () => {
    const item = ficha({ extracted: { guardianEmail: null } });
    const form: FormState = { ...formularioInicial(item, HOY), guardianEmail: 'carolina@gmail.com' };
    expect(estadoFicha(item, form, HOY)).toBe('lista');
  });

  it('adulto sin acudiente está lista', () => {
    const item = ficha({ extracted: ADULTO });
    expect(estadoFicha(item, formularioInicial(item, HOY), HOY)).toBe('lista');
  });
});

describe('textoEstado', () => {
  it('singular, plural, lista y duplicada', () => {
    expect(textoEstado('faltan', 1)).toBe('Falta 1 dato');
    expect(textoEstado('faltan', 3)).toBe('Faltan 3 datos');
    expect(textoEstado('lista', 0)).toBe('Lista');
    expect(textoEstado('duplicada', 2)).toBe('Ya existe');
  });
});

describe('listaLegible', () => {
  it('0 elementos: cadena vacía', () => {
    expect(listaLegible([])).toBe('');
  });

  it('1 elemento: solo la etiqueta', () => {
    expect(listaLegible(['docNumber'])).toBe('documento');
  });

  it('2 elementos: unidos con «y»', () => {
    expect(listaLegible(['guardianEmail', 'guardianPhone'])).toBe('correo del acudiente y celular del acudiente');
  });

  it('3 elementos: comas y «y» al final', () => {
    expect(listaLegible(['docNumber', 'guardianEmail', 'guardianPhone']))
      .toBe('documento, correo del acudiente y celular del acudiente');
  });
});

describe('formularioInicial', () => {
  it('copia lo leído de la hoja', () => {
    const form = formularioInicial(ficha(), HOY);
    expect(form.athleteFullName).toBe('Sofía Ramírez Pérez');
    expect(form.docType).toBe('TI');
    expect(form.guardianEmail).toBe('carolina@gmail.com');
    expect(form.bloodType).toBe('O+');
  });

  it('los null quedan en cadena vacía y el tipo de documento con su valor por defecto', () => {
    const item = ficha({
      extracted: {
        athleteFullName: null, docType: null, docNumber: null, dateOfBirth: null, guardianFullName: null,
        guardianPhone: null, guardianEmail: null, athleteEmail: null, athletePhone: null, epsName: null, bloodType: null,
      },
    });
    expect(formularioInicial(item, HOY)).toEqual({
      athleteFullName: '', docType: 'TI', docNumber: '', dateOfBirth: '', guardianFullName: '',
      guardianPhone: '', guardianEmail: '', athleteEmail: '', athletePhone: '', epsName: '', bloodType: '',
    });
  });

  it('sin nada leído (extracted null) todo vacío y docType TI', () => {
    const form = formularioInicial(ficha({ extracted: null }), HOY);
    expect(form.docType).toBe('TI');
    expect(Object.entries(form).filter(([k]) => k !== 'docType').every(([, v]) => v === '')).toBe(true);
  });

  it('adulto sin tipo leído arranca en CC', () => {
    expect(formularioInicial(ficha({ extracted: { ...ADULTO, docType: null } }), HOY).docType).toBe('CC');
  });
});

describe('fecha de nacimiento y «Es otra persona»', () => {
  it('una fecha imposible no se precarga y se pide', () => {
    const item = ficha({ extracted: { dateOfBirth: '2014-02-30' } });
    expect(formularioInicial(item, HOY).dateOfBirth).toBe('');
    expect(camposAPedir(item, HOY)).toContain('dateOfBirth');
  });

  it('campoValido de la fecha: real sí, futura o imposible no', () => {
    expect(campoValido('dateOfBirth', '2014-02-28', HOY)).toBe(true);
    expect(campoValido('dateOfBirth', '2014-02-30', HOY)).toBe(false);
    expect(campoValido('dateOfBirth', '2030-01-01', HOY)).toBe(false);
  });

  it('con «Es otra persona» la duplicada se evalúa como ficha nueva', () => {
    const item = ficha({ duplicateOfChildId: 'child-1', duplicateOfChildName: 'Mathías Calderón' });
    const form = formularioInicial(item, HOY);
    expect(estadoFicha(item, form, HOY)).toBe('duplicada');
    expect(estadoFicha(item, form, HOY, { esOtraPersona: true })).toBe('lista');
    expect(estadoFicha(item, { ...form, guardianEmail: '' }, HOY, { esOtraPersona: true })).toBe('faltan');
  });
});

describe('casos raros de la lectura', () => {
  it('una fecha con forma válida pero imposible (mes 13, 30 de febrero) no da edad', () => {
    expect(edadEn('2010-13-45', HOY)).toBeNull();
    expect(edadEn('2015-02-30', HOY)).toBeNull();
  });

  it('todo campo que se puede pedir tiene etiqueta legible', () => {
    expect(listaLegible(['dateOfBirth', 'guardianFullName'])).toBe('fecha de nacimiento y nombre del acudiente');
    expect(listaLegible(['athletePhone', 'athleteEmail'])).toBe('celular del deportista y correo del deportista');
  });
});
