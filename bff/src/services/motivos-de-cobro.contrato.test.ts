/**
 * Contrato del catálogo único de motivos (plan B4 §5, 2026-10-30): las claves
 * del BFF son las del ÚLTIMO CHECK `payments_payment_category_check` de
 * supabase/migrations, los servicios son los del último CHECK
 * `school_tournament_items_kind_chk`, y el espejo del frontend
 * (frontend/src/lib/motivosDeCobro.ts, lo escribe B4-front) las tiene todas.
 * Si alguien agrega un motivo en la base y no aquí (o al revés), esto falla.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { CLAVES_MOTIVO, MOTIVOS, MOTIVO, MOTIVOS_DE_SERVICIO, esMotivo, mapaDeMotivos } from './motivos-de-cobro';
import { CATEGORIAS_COBRO, ETIQUETA_COBRO } from './payment-accounts';
import { ETIQUETA_CATEGORIA } from './tipo-de-cobro';
import { TIPOS_SERVICIO } from './ventas-servicios.service';

const RAIZ = path.resolve(__dirname, '../../..');
const MIGRACIONES = path.join(RAIZ, 'supabase/migrations');

/** Los valores del último `ADD CONSTRAINT <nombre> CHECK (... ARRAY[...] / IN (...))` de las migraciones. */
function valoresDelUltimoCheck(nombre: string): string[] {
    const archivos = readdirSync(MIGRACIONES).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
    let ultimo: string[] | null = null;
    for (const f of archivos) {
        const sql = readFileSync(path.join(MIGRACIONES, f), 'utf8')
            .split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n');
        const re = new RegExp(`ADD\\s+CONSTRAINT\\s+${nombre}\\s+CHECK\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'gi');
        for (const m of sql.matchAll(re)) {
            const valores = [...m[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1]);
            if (valores.length) ultimo = valores;
        }
    }
    if (!ultimo) throw new Error(`no encontré el CHECK ${nombre}`);
    return ultimo;
}

describe('contrato: catálogo único = base = frontend', () => {
    it('las claves son las del último CHECK de payments.payment_category', () => {
        expect([...CLAVES_MOTIVO].sort()).toEqual([...new Set(valoresDelUltimoCheck('payments_payment_category_check'))].sort());
    });

    it('los motivos de servicio son los del último CHECK de school_tournament_items.kind', () => {
        expect([...MOTIVOS_DE_SERVICIO].sort())
            .toEqual([...new Set(valoresDelUltimoCheck('school_tournament_items_kind_chk'))].sort());
        expect(MOTIVOS.filter((m) => m.seCobraPorItem).map((m) => m.clave).sort()).toEqual([...MOTIVOS_DE_SERVICIO].sort());
    });

    const espejo = path.join(RAIZ, 'frontend/src/lib/motivosDeCobro.ts');
    it.skipIf(!existsSync(espejo))('el espejo del frontend tiene todas las claves', () => {
        const ts = readFileSync(espejo, 'utf8');
        for (const c of CLAVES_MOTIVO) expect(ts).toContain(`'${c}'`);
    });

    // Integración (2026-10-30): BFF = frontend = CHECK, clave por clave y en el
    // mismo orden, con la misma etiqueta, rótulo corto y plural, y los mismos
    // tipos de servicio. El frontend no se importa (otro paquete): se lee su fuente.
    it('el espejo del frontend = el catálogo del BFF = el último CHECK (orden, etiqueta, corta, plural, servicio)', () => {
        const ts = readFileSync(espejo, 'utf8');
        const lista = ts.match(/export const CLAVES_MOTIVO = \[([\s\S]*?)\] as const;/);
        expect(lista).not.toBeNull();
        const clavesFront = [...lista![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        expect(clavesFront).toEqual([...CLAVES_MOTIVO]);
        expect([...clavesFront].sort()).toEqual([...new Set(valoresDelUltimoCheck('payments_payment_category_check'))].sort());
        const deFront = new Map<string, { etiqueta: string; corta: string; plural: string; servicio: boolean }>();
        for (const m of ts.matchAll(/\{ clave: '([a-z_]+)', etiqueta: '([^']*)', corta: '([^']*)', plural: '([^']*)'[^\n]*?servicio: (null|\{)/g)) {
            deFront.set(m[1], { etiqueta: m[2], corta: m[3], plural: m[4], servicio: m[5] !== 'null' });
        }
        expect([...deFront.keys()]).toEqual([...CLAVES_MOTIVO]);
        for (const m of MOTIVOS) {
            expect({ clave: m.clave, ...deFront.get(m.clave) }).toEqual({
                clave: m.clave, etiqueta: m.etiqueta, corta: m.corta, plural: m.plural, servicio: m.seCobraPorItem,
            });
        }
    });
});

describe('cada motivo', () => {
    it('una definición por clave, en el orden del CHECK', () => {
        expect(MOTIVOS.map((m) => m.clave)).toEqual([...CLAVES_MOTIVO]);
        for (const c of CLAVES_MOTIVO) expect(MOTIVO[c].clave).toBe(c);
    });

    it('etiqueta y plural no vacíos; corta ≤ 9 y única (los botones de WhatsApp se cortan en 20)', () => {
        const cortas = MOTIVOS.map((m) => m.corta);
        for (const m of MOTIVOS) {
            expect(m.etiqueta.trim()).not.toBe('');
            expect(m.plural.trim()).not.toBe('');
            expect(m.corta.length).toBeGreaterThan(0);
            expect(m.corta.length).toBeLessThanOrEqual(9);
        }
        expect(new Set(cortas).size).toBe(cortas.length);
        expect(MOTIVO.clase_prueba.corta).toBe('Prueba');
        expect(MOTIVO.clase_extra.corta).toBe('Clase');
    });

    it('las listas del BFF derivan del catálogo', () => {
        expect(CATEGORIAS_COBRO).toBe(CLAVES_MOTIVO);
        expect(ETIQUETA_COBRO).toEqual(mapaDeMotivos('etiqueta'));
        for (const c of CLAVES_MOTIVO) expect(ETIQUETA_CATEGORIA[c]).toBe(MOTIVO[c].etiqueta);
        expect([...TIPOS_SERVICIO]).toEqual(['torneo', 'viaje', 'clase_extra', 'vacacional', 'otro']);
    });

    it('esMotivo', () => {
        expect(esMotivo('clase_prueba')).toBe(true);
        expect(esMotivo('reserva')).toBe(true);
        expect(esMotivo('evento')).toBe(false);
        expect(esMotivo(null)).toBe(false);
    });
});
