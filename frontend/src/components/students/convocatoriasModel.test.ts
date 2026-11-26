import { describe, expect, it } from 'vitest';
import {
  FILTROS_INICIALES, agruparConvocatorias, fechaInscripcion, fechaInscripcionLarga, filaExcel, hojasExcel,
  nombreArchivoExcel, nombreHoja, porcentajeDescuento, resumenPorConvocatoria, tieneDescuento,
  type InscripcionConvocatoria,
} from './convocatoriasModel';

let seq = 0;
function ins(p: Partial<InscripcionConvocatoria>): InscripcionConvocatoria {
  seq += 1;
  return {
    id: `id-${String(seq).padStart(3, '0')}`,
    created_at: '2026-11-26T15:00:00Z',
    status: 'new',
    estado_inscripcion: 'pendiente',
    convocatoria: 'Mayores Superliga',
    oferta_id: null,
    sede: null,
    deportista: `Deportista ${seq}`,
    telefono: null,
    contacto: null,
    acudiente: null,
    anio_nacimiento: null,
    genero: null,
    trayectoria: null,
    detalle: null,
    fechas: [],
    valor: null,
    valor_con_descuento: null,
    promo_pct: null,
    conversation_id: null,
    notas: null,
    nota_escuela: null,
    ...p,
  };
}

const lista = [
  ins({ id: 'c', convocatoria: 'Sede Suba 2012', created_at: '2026-11-25T10:00:00Z', deportista: 'Carla' }),
  ins({ id: 'a', convocatoria: 'Mayores Superliga', created_at: '2026-11-24T09:00:00Z', deportista: 'Andrés', fechas: ['2026-11-29'] }),
  ins({ id: 'b', convocatoria: 'Mayores Superliga', created_at: '2026-11-26T09:00:00Z', deportista: 'Bruno', estado_inscripcion: 'descartada', fechas: ['2026-11-29'] }),
  ins({ id: 'd', convocatoria: 'Mayores Superliga', created_at: '2026-11-25T08:00:00Z', deportista: 'Diana', telefono: '300 123 4567', estado_inscripcion: 'pagada', fechas: ['2026-11-29'] }),
  ins({ id: 'e', convocatoria: 'Mayores Superliga', created_at: '2026-11-27T08:00:00Z', deportista: 'Émilio', estado_inscripcion: 'confirmada', fechas: ['2026-11-29'] }),
];

describe('agruparConvocatorias', () => {
  it('agrupa por convocatoria (la de la primera inscripción primero), ordena por llegada y numera sin descartadas', () => {
    const g = agruparConvocatorias(lista, FILTROS_INICIALES);
    expect(g.map((x) => x.convocatoria)).toEqual(['Mayores Superliga', 'Sede Suba 2012']);
    expect(g[0].filas.map((f) => [f.numero, f.inscripcion.id])).toEqual([[1, 'a'], [2, 'd'], [3, 'e']]);
    expect(g[1].filas.map((f) => f.numero)).toEqual([1]);
  });

  it('con «todas» incluye las descartadas en su lugar de llegada', () => {
    const g = agruparConvocatorias(lista, { ...FILTROS_INICIALES, estado: 'todas' });
    expect(g[0].filas.map((f) => [f.numero, f.inscripcion.id])).toEqual([[1, 'a'], [2, 'd'], [3, 'b'], [4, 'e']]);
  });

  it('la búsqueda conserva el número de la lista (no renumera) e ignora tildes', () => {
    const g = agruparConvocatorias(lista, { ...FILTROS_INICIALES, busqueda: 'emilio' });
    expect(g).toHaveLength(1);
    expect(g[0].filas).toEqual([expect.objectContaining({ numero: 3 })]);
  });

  it('busca por teléfono ignorando espacios', () => {
    const g = agruparConvocatorias(lista, { ...FILTROS_INICIALES, busqueda: '3001234' });
    expect(g[0].filas.map((f) => f.inscripcion.id)).toEqual(['d']);
  });

  it('filtra por convocatoria y por estado', () => {
    expect(agruparConvocatorias(lista, { ...FILTROS_INICIALES, convocatoria: 'Sede Suba 2012' }).map((x) => x.convocatoria))
      .toEqual(['Sede Suba 2012']);
    const pagadas = agruparConvocatorias(lista, { ...FILTROS_INICIALES, estado: 'pagada' });
    expect(pagadas).toHaveLength(1);
    expect(pagadas[0].filas).toEqual([expect.objectContaining({ numero: 1, inscripcion: expect.objectContaining({ id: 'd' }) })]);
  });

  it('fechas comunes del grupo solo si todas las filas traen las mismas', () => {
    const g = agruparConvocatorias(lista, FILTROS_INICIALES);
    expect(g[0].fechasComunes).toEqual(['2026-11-29']);
    expect(g[1].fechasComunes).toBeNull(); // sin fechas
    const mezcla = agruparConvocatorias([
      ins({ fechas: ['2026-12-01'] }), ins({ fechas: ['2026-12-02'] }),
    ], FILTROS_INICIALES);
    expect(mezcla[0].fechasComunes).toBeNull();
  });
});

describe('resumenPorConvocatoria', () => {
  it('cuenta por estado, descartadas aparte', () => {
    const r = resumenPorConvocatoria(lista);
    expect(r[0]).toEqual({ convocatoria: 'Mayores Superliga', pendiente: 1, confirmada: 1, pagada: 1, descartada: 1, total: 4 });
    expect(r[1]).toMatchObject({ convocatoria: 'Sede Suba 2012', pendiente: 1, total: 1 });
  });
});

describe('formatos', () => {
  it('fecha de inscripción en hora de Bogotá (UTC−5)', () => {
    expect(fechaInscripcion('2026-11-26T03:07:00Z')).toBe('25/11 22:07');
    expect(fechaInscripcionLarga('2027-01-01T02:00:00Z')).toBe('31/12/2026 21:00');
  });

  it('descuento: tachado solo si baja el valor; % de la promo o calculado', () => {
    expect(tieneDescuento({ valor: 100000, valor_con_descuento: 90000 })).toBe(true);
    expect(tieneDescuento({ valor: 100000, valor_con_descuento: 100000 })).toBe(false);
    expect(tieneDescuento({ valor: 100000, valor_con_descuento: null })).toBe(false);
    expect(porcentajeDescuento({ valor: 100000, valor_con_descuento: 90000, promo_pct: null })).toBe(10);
    expect(porcentajeDescuento({ valor: 100000, valor_con_descuento: 85000, promo_pct: 15 })).toBe(15);
  });
});

describe('Excel', () => {
  it('una hoja por convocatoria con el mismo orden y numeración que la pantalla', () => {
    const hojas = hojasExcel(agruparConvocatorias(lista, FILTROS_INICIALES));
    expect(hojas.map((h) => h.name)).toEqual(['Mayores Superliga', 'Sede Suba 2012']);
    expect(hojas[0].rows.map((r) => [r.numero, r.deportista])).toEqual([[1, 'Andrés'], [2, 'Diana'], [3, 'Émilio']]);
  });

  it('arma la fila con todas las columnas', () => {
    const fila = filaExcel({
      numero: 4,
      inscripcion: ins({
        created_at: '2026-11-26T15:30:00Z', convocatoria: 'Sede Norte', sede: 'Norte', deportista: 'Luis',
        contacto: 'Marta', telefono: '3001112233', anio_nacimiento: 2011, genero: 'Masculino', trayectoria: true,
        detalle: 'Club X 2 años', valor: 100000, valor_con_descuento: 90000, estado_inscripcion: 'confirmada',
        nota_escuela: 'Trae uniforme', fechas: ['Sábado 29 nov 8 am'],
      }),
    });
    expect(fila).toEqual({
      numero: 4, fecha: '26/11/2026 10:30', convocatoria: 'Sede Norte', sede: 'Norte', deportista: 'Luis',
      acudiente: 'Marta', telefono: '3001112233', anio: 2011, genero: 'Masculino', trayectoria: 'Sí',
      detalle: 'Club X 2 años', valor: 100000, valor_desc: 90000, estado: 'Confirmada', nota: 'Trae uniforme',
      fechas: 'Sábado 29 nov 8 am',
    });
  });

  it('nombres de hoja válidos, cortos y únicos', () => {
    const usados = new Set<string>();
    expect(nombreHoja('Sede Suba / 2012: [A]', usados)).toBe('Sede Suba 2012 A');
    const largo = 'Convocatoria con un nombre larguísimo de verdad';
    const h1 = nombreHoja(largo, usados);
    const h2 = nombreHoja(largo, usados);
    expect(h1).toHaveLength(31);
    expect(h2.endsWith(' (2)')).toBe(true);
    expect(h2.length).toBeLessThanOrEqual(31);
  });

  it('nombre de archivo con la fecha de Bogotá', () => {
    expect(nombreArchivoExcel(new Date('2026-11-27T03:00:00Z'))).toBe('inscripciones-convocatorias-2026-11-26');
  });
});
