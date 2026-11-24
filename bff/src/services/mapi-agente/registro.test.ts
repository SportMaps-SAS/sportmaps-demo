/**
 * Catálogo completo del agente: nombres únicos, esquemas que la API acepta
 * (sin enum con type en arreglo) y ninguna herramienta con parámetro de escuela.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/supabase', () => ({ supabase: {}, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' }));

import { CATALOGO, definicionesApi, normalizarEsquema } from './registro';

function recorrer(nodo: any, visitar: (n: any, ruta: string) => void, ruta = '$'): void {
    if (!nodo || typeof nodo !== 'object') return;
    visitar(nodo, ruta);
    for (const [k, v] of Object.entries(nodo)) recorrer(v, visitar, `${ruta}.${k}`);
}

describe('normalizarEsquema', () => {
    it('enum que admite null → anyOf (la API rechaza enum con type en arreglo)', () => {
        expect(normalizarEsquema({ type: ['string', 'null'], enum: ['a', 'b', null], description: 'd' }))
            .toEqual({ description: 'd', anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] });
    });
    it('lo demás queda igual', () => {
        const s = { type: 'object', properties: { x: { type: ['string', 'null'] }, y: { type: 'string', enum: ['a'] } }, required: ['x', 'y'], additionalProperties: false };
        expect(normalizarEsquema(s)).toEqual(s);
    });
});

describe('CATALOGO', () => {
    it('nombres únicos', () => {
        const nombres = CATALOGO.map((h) => h.nombre);
        expect(new Set(nombres).size).toBe(nombres.length);
    });

    it('ningún esquema enviado a la API trae enum con type en arreglo', () => {
        const malos: string[] = [];
        for (const d of definicionesApi(CATALOGO)) {
            recorrer(d.input_schema, (n, ruta) => {
                if (Array.isArray(n.enum) && Array.isArray(n.type)) malos.push(`${d.name} ${ruta}`);
            });
        }
        expect(malos).toEqual([]);
    });

    // strict admite opcionales (resumen_deportista.mes lo es y la API lo acepta):
    // lo que no puede pasar es un required que no exista en properties.
    it('strict: objeto, additionalProperties false y required ⊆ properties', () => {
        for (const h of CATALOGO) {
            expect(h.esquema.type, h.nombre).toBe('object');
            expect(h.esquema.additionalProperties, h.nombre).toBe(false);
            const props = Object.keys(h.esquema.properties);
            expect(h.esquema.required.filter((r) => !props.includes(r)), h.nombre).toEqual([]);
        }
    });

    it('ninguna herramienta recibe la escuela del modelo', () => {
        for (const h of CATALOGO) {
            const props = Object.keys(h.esquema.properties).map((p) => p.toLowerCase());
            expect(props.filter((p) => /school|escuela/.test(p)), h.nombre).toEqual([]);
        }
    });
});
