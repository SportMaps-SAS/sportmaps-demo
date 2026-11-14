/**
 * Modelo puro de WhatsApp › Anuncios: % de paso, títulos, motivos de pago, el
 * selector «este anuncio va a…» y el rango de fechas de Bogotá.
 */
import { describe, expect, it } from 'vitest';
import {
    ETAPAS, FILA_VACIA, SIN_DESTINO, aplicarMapeo, avisoHistorial, enlaceSeguro, hoyBogota, mapeoDeValor,
    mapeosPorAnuncio, opcionesDeDestino, pct, rangoUltimosDias, textoMotivo, textoPct, tituloDelAnuncio,
    valorDelSelector, type MapeoDestino,
} from './anunciosModelo';

const SERV = '11111111-1111-4111-8111-111111111111';

describe('pct / textoPct', () => {
    it('redondea sobre las conversaciones y sin base no inventa', () => {
        expect(pct(1, 3)).toBe(33);
        expect(pct(2, 3)).toBe(67);
        expect(pct(0, 5)).toBe(0);
        expect(pct(3, 0)).toBeNull();
        expect(textoPct(1, 4)).toBe('25 %');
        expect(textoPct(1, 0)).toBe('—');
    });
});

describe('ETAPAS', () => {
    it('van en el orden del embudo y apuntan a columnas que manda el BFF', () => {
        expect(ETAPAS.map((e) => e.clave)).toEqual(['contestaron', 'separaron_o_agendaron', 'pagaron', 'asistieron', 'matriculados']);
        for (const e of ETAPAS) expect(e.clave in FILA_VACIA).toBe(true);
    });
});

describe('tituloDelAnuncio', () => {
    const base = { headline: null, body: null, source_id: '120251275521150783', source_type: 'ad' };
    it('el título de Meta primero', () => {
        expect(tituloDelAnuncio({ ...base, headline: '  Aparta tu cupo ya mismo ' })).toBe('Aparta tu cupo ya mismo');
    });
    it('sin título: el texto del anuncio, recortado', () => {
        expect(tituloDelAnuncio({ ...base, body: 'Clínica de vóley\n en diciembre' })).toBe('Clínica de vóley en diciembre');
        const largo = tituloDelAnuncio({ ...base, body: 'x'.repeat(80) });
        expect(largo).toHaveLength(58);
        expect(largo.endsWith('…')).toBe(true);
    });
    it('sin nada: el final del id, diciendo si es anuncio o publicación', () => {
        expect(tituloDelAnuncio(base)).toBe('Anuncio …150783');
        expect(tituloDelAnuncio({ ...base, source_type: 'post' })).toBe('Publicación …150783');
    });
});

describe('enlaceSeguro', () => {
    it('solo http(s)', () => {
        expect(enlaceSeguro('https://www.instagram.com/p/DfTBcHIs92j/')).toBe('https://www.instagram.com/p/DfTBcHIs92j/');
        expect(enlaceSeguro('javascript:alert(1)')).toBeNull();
        expect(enlaceSeguro(null)).toBeNull();
    });
});

describe('textoMotivo', () => {
    it('el servicio por su nombre; si no, la categoría en palabras', () => {
        expect(textoMotivo({ motivo: 'clase_extra', servicio: 'Clínica de diciembre' })).toBe('Clínica de diciembre');
        expect(textoMotivo({ motivo: 'clase_prueba', servicio: null })).toBe('Clase de prueba');
        expect(textoMotivo({ motivo: 'inscripcion', servicio: null })).toBe('Matrícula');
        expect(textoMotivo({ motivo: 'algo_nuevo', servicio: null })).toBe('algo nuevo');
    });
});

describe('selector «este anuncio va a…»', () => {
    const mapeo = (x: Partial<MapeoDestino>): MapeoDestino => ({
        source_id: 'AD1', destino: 'clase_prueba', servicio_id: null, nota: null, updated_at: null, ...x,
    });

    it('del mapeo al valor y de vuelta', () => {
        expect(valorDelSelector(undefined)).toBe(SIN_DESTINO);
        expect(valorDelSelector(mapeo({}))).toBe('clase_prueba');
        expect(valorDelSelector(mapeo({ destino: 'persona' }))).toBe('persona');
        expect(valorDelSelector(mapeo({ destino: 'servicio', servicio_id: SERV }))).toBe(`servicio:${SERV}`);

        expect(mapeoDeValor('clase_prueba')).toEqual({ destino: 'clase_prueba', servicio_id: null });
        expect(mapeoDeValor('persona')).toEqual({ destino: 'persona', servicio_id: null });
        expect(mapeoDeValor(`servicio:${SERV}`)).toEqual({ destino: 'servicio', servicio_id: SERV });
        expect(mapeoDeValor(SIN_DESTINO)).toBeNull();
        expect(mapeoDeValor('servicio:')).toBeNull();
    });

    it('opciones: las tres fijas + servicios activos (y el mapeado aunque esté inactivo)', () => {
        const servicios = [
            { id: 'S1', nombre: 'Clínica', tipo: 'clase_extra', activo: true },
            { id: 'S2', nombre: 'Vacacional 2025', tipo: 'vacacional', activo: false },
            { id: 'S3', nombre: 'Uniforme viejo', tipo: 'otro', activo: false },
        ];
        const sin = opcionesDeDestino(servicios);
        expect(sin.map((o) => o.valor)).toEqual([SIN_DESTINO, 'clase_prueba', 'persona', 'servicio:S1']);
        const con = opcionesDeDestino(servicios, mapeo({ destino: 'servicio', servicio_id: 'S2' }));
        expect(con.map((o) => o.texto)).toContain('Vacacional 2025 (inactivo)');
        expect(con.map((o) => o.valor)).not.toContain('servicio:S3');
    });

    it('aplicarMapeo reemplaza o quita sin tocar los demás', () => {
        const lista = [mapeo({ source_id: 'AD1' }), mapeo({ source_id: 'AD2', destino: 'persona' })];
        const nuevo = mapeo({ source_id: 'AD1', destino: 'servicio', servicio_id: SERV });
        const tras = aplicarMapeo(lista, 'AD1', nuevo);
        expect(tras).toHaveLength(2);
        expect(mapeosPorAnuncio(tras).get('AD1')?.destino).toBe('servicio');
        expect(mapeosPorAnuncio(tras).get('AD2')?.destino).toBe('persona');
        expect(aplicarMapeo(lista, 'AD2', null).map((m) => m.source_id)).toEqual(['AD1']);
    });
});

describe('fechas de Bogotá', () => {
    // 2026-11-05 03:00 UTC = 2026-11-04 22:00 en Bogotá.
    const AHORA = Date.parse('2026-11-05T03:00:00Z');
    it('hoy es el de Bogotá', () => {
        expect(hoyBogota(AHORA)).toBe('2026-11-04');
    });
    it('los últimos N días incluyen hoy', () => {
        expect(rangoUltimosDias(30, AHORA)).toEqual({ desde: '2026-10-06', hasta: '2026-11-04' });
        expect(rangoUltimosDias(7, AHORA)).toEqual({ desde: '2026-10-29', hasta: '2026-11-04' });
        expect(rangoUltimosDias(1, AHORA)).toEqual({ desde: '2026-11-04', hasta: '2026-11-04' });
    });
});

describe('avisoHistorial', () => {
    it('solo cuando hay conversaciones del historial del celular', () => {
        expect(avisoHistorial(null)).toBeNull();
        expect(avisoHistorial({ conversaciones: 5, de_historial: 0 })).toBeNull();
        expect(avisoHistorial({ conversaciones: 5, de_historial: 5 })).toMatch(/^Todas estas conversaciones llegaron antes/);
        expect(avisoHistorial({ conversaciones: 5, de_historial: 2 })).toMatch(/^2 de estas 5 conversaciones/);
    });
});
