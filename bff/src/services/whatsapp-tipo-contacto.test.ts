/**
 * Marcas manuales de no-familia (2026-10-13): personal, negocio, otro club y
 * plataforma valen lo mismo para el bot; «también es familia» deja pasar el
 * contenido. Puras, salvo `leerConMarca`, que recibe la consulta.
 */
import { describe, expect, it } from 'vitest';
import {
    ETIQUETA_DE_MARCA, FILTRO_SIN_MARCA_MANUAL, TIPOS_MARCADOS, esContactoSinContenido, esMarcaNoFamilia, leerConMarca, marcaPorNombre,
} from './whatsapp-tipo-contacto';

describe('esMarcaNoFamilia', () => {
    it('las cuatro marcas manuales sí; lo automático no', () => {
        for (const t of TIPOS_MARCADOS) expect(esMarcaNoFamilia(t)).toBe(true);
        for (const t of ['familia', 'familia_sin_cuenta', 'ambiguo', 'staff', 'desconocido', null, undefined, '']) {
            expect(esMarcaNoFamilia(t as any)).toBe(false);
        }
    });
});

describe('esContactoSinContenido', () => {
    it('marca sin bandera: no se guarda contenido', () => {
        expect(esContactoSinContenido('negocio', false)).toBe(true);
        expect(esContactoSinContenido('personal', null)).toBe(true);
    });
    it('con «también es familia» sí se guarda (sus comprobantes se aplican)', () => {
        expect(esContactoSinContenido('personal', true)).toBe(false);
    });
    it('sin marca manual la bandera no cambia nada', () => {
        expect(esContactoSinContenido('familia', true)).toBe(false);
        expect(esContactoSinContenido('desconocido', false)).toBe(false);
    });
});

describe('marca «Staff» (equipo)', () => {
    it('es marca manual distinta del staff automático', () => {
        expect(esMarcaNoFamilia('equipo')).toBe(true);
        expect(esMarcaNoFamilia('staff')).toBe(false);
        expect(ETIQUETA_DE_MARCA.equipo).toBe('staff');
    });
    it('sin bandera no se guarda contenido; con «también es familia» sí', () => {
        expect(esContactoSinContenido('equipo', false)).toBe(true);
        expect(esContactoSinContenido('equipo', true)).toBe(false);
    });
});

describe('FILTRO_SIN_MARCA_MANUAL', () => {
    it('excluye las cuatro marcas', () => {
        expect(FILTRO_SIN_MARCA_MANUAL).toBe('contact_kind.is.null,contact_kind.not.in.(personal,negocio,otro_club,plataforma,equipo)');
    });
});

describe('marcaPorNombre', () => {
    it('negocio, club y plataforma por el nombre o el pie', () => {
        expect(marcaPorNombre('Distribuidora El Sol S.A.S')).toBe('negocio');
        expect(marcaPorNombre('Pedro', 'Para clientes mayoristas')).toBe('negocio');
        expect(marcaPorNombre('Terraza Gastrobar')).toBe('negocio');
        expect(marcaPorNombre('Club Deportivo Estrella')).toBe('otro_club');
        expect(marcaPorNombre('SportMaps')).toBe('plataforma');
    });
    it('un nombre de persona no', () => {
        expect(marcaPorNombre('Ana María Pérez')).toBeNull();
        expect(marcaPorNombre('Bárbara')).toBeNull();
        expect(marcaPorNombre(null, undefined, '')).toBeNull();
    });
});

describe('leerConMarca', () => {
    it('con la columna nueva devuelve la bandera', async () => {
        const r = await leerConMarca(async (cols) => {
            expect(cols).toBe('id, contact_kind, tambien_familia');
            return { data: { id: 'c', contact_kind: 'personal', tambien_familia: true }, error: null };
        }, 'id');
        expect(r.data).toEqual({ id: 'c', contact_kind: 'personal', tambien_familia: true });
    });

    it('sin la columna (migración sin aplicar) reintenta y la bandera queda false', async () => {
        const pedidas: string[] = [];
        const r = await leerConMarca(async (cols) => {
            pedidas.push(cols);
            if (cols.includes('tambien_familia')) return { data: null, error: { code: '42703' } };
            return { data: [{ id: 'c', contact_kind: 'negocio' }], error: null };
        }, 'id');
        expect(pedidas).toEqual(['id, contact_kind, tambien_familia', 'id, contact_kind']);
        expect(r.data).toEqual([{ id: 'c', contact_kind: 'negocio', tambien_familia: false }]);
    });

    it('si todo falla, error y data null; nunca lanza', async () => {
        const r = await leerConMarca(async () => { throw new Error('red'); }, '');
        expect(r.data).toBeNull();
        expect(r.error).toBeTruthy();
    });
});
