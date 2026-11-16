/**
 * whatsapp-precios-escuela.service — el objeto del GET, los avisos, la ficha
 * contra lo cargado (función pura) y las escrituras: toda consulta y toda
 * escritura va filtrada por la escuela; lo inválido no llega a la base.
 * Supabase va fingido: cada operación queda anotada con su tabla y sus filtros.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Op {
    tabla: string;
    accion: 'select' | 'update' | 'insert' | 'upsert';
    valores?: any;
    cols?: string;
    filtros: Record<string, unknown>;
}

const est = vi.hoisted(() => ({
    ops: [] as any[],
    responder: (_op: any): { data?: any; error?: any } => ({ data: null }),
}));

vi.mock('../config/supabase', () => {
    const from = (tabla: string) => {
        const op: any = { tabla, accion: 'select', filtros: {} };
        const api: any = {
            select: (cols: string) => { if (op.accion === 'select') op.cols = cols; return api; },
            update: (v: any) => { op.accion = 'update'; op.valores = v; return api; },
            insert: (v: any) => { op.accion = 'insert'; op.valores = v; return api; },
            upsert: (v: any) => { op.accion = 'upsert'; op.valores = v; return api; },
            eq: (c: string, v: unknown) => { op.filtros[c] = v; return api; },
            is: (c: string, v: unknown) => { op.filtros[c] = v; return api; },
            in: (c: string, v: unknown) => { op.filtros[c] = v; return api; },
            order: () => api,
            limit: () => api,
            maybeSingle: () => api,
            then: (ok: any, ko: any) => {
                est.ops.push(op);
                const r = est.responder(op);
                return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(ok, ko);
            },
        };
        return api;
    };
    return { supabase: { from } };
});
// offerings.ts (de donde sale la regla compartida de la matrícula) importa el middleware real.
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
}));

import {
    actualizarArticulo, avisosDePrecios, crearArticulo, guardarClasePrueba, guardarInterruptores, guardarMatricula,
    leerPreciosDeEscuela, montoOpcional, montoValido, montosDeFichaSinCargar, nombreValido, pesos,
} from './whatsapp-precios-escuela.service';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const ART = '11111111-1111-4111-8111-111111111111';

/** La base de una escuela de ejemplo; cada prueba pisa lo que necesita. */
function base(o: Partial<Record<string, any>> = {}) {
    const d: Record<string, any> = {
        school_settings: {
            wa_responder_precios: true, wa_cobro_desde_comprobante: false, wa_ficha_prospectos: null,
            wa_ventas_habilitadas: true, tournament_charges_enabled: true,
        },
        offering_plans: [
            { id: 'p1', name: 'Mensual 2 días', price: 150000, registration_fee: 100000 },
            { id: 'p2', name: 'Mensual 3 días', price: '180000', registration_fee: null },
        ],
        school_trial_class_settings: { school_id: ESCUELA, enabled: true, trial_price: 20000 },
        school_merchandise_items: [
            { id: 'a1', name: 'Uniforme', price: '85000.00', price_by_size: { XL: 95000 }, active: true },
            { id: 'a2', name: 'Camiseta vieja', price: 40000, price_by_size: null, active: false },
        ],
        school_tournament_items: [
            {
                id: 's1', name: 'Vacacional', kind: 'vacacional', price: 300000, active: true, event_id: null,
                precio_afiliado: 250000, opciones: [{ clave: '1s', etiqueta: '1 semana', precio: 120000 }, { sin: 'clave' }],
            },
        ],
        ...o,
    };
    est.responder = (op: Op) => (op.accion === 'select' ? { data: d[op.tabla] } : { data: [{ id: 'x', school_id: ESCUELA }] });
    return d;
}

beforeEach(() => { est.ops = []; base(); });

const leer = async () => {
    const r = await leerPreciosDeEscuela(ESCUELA);
    if (!r.ok) throw new Error(`esperaba ok: ${r.error}`);
    return r.precios;
};
const escrituras = () => (est.ops as Op[]).filter((o) => o.accion !== 'select');

describe('validación', () => {
    it('montos: enteros, 0 < valor ≤ 50.000.000; ni texto ni decimales', () => {
        expect(montoValido(1)).toBe(1);
        expect(montoValido(50_000_000)).toBe(50_000_000);
        for (const malo of [0, -5, 50_000_001, 100.5, '100000', null, undefined, NaN, Infinity, true, {}]) expect(montoValido(malo)).toBeNull();
        expect(montoOpcional(null)).toEqual({ ok: true, valor: null });
        expect(montoOpcional(0)).toEqual({ ok: true, valor: null });
        expect(montoOpcional(310000)).toEqual({ ok: true, valor: 310000 });
        expect(montoOpcional(undefined)).toEqual({ ok: false });
        expect(montoOpcional('310000')).toEqual({ ok: false });
        expect(montoOpcional(-1)).toEqual({ ok: false });
    });

    it('nombres: recortados, de 2 a 80 caracteres', () => {
        expect(nombreValido('  Uniforme   de   gala ')).toBe('Uniforme de gala');
        expect(nombreValido('ab')).toBe('ab');
        expect(nombreValido('x'.repeat(80))).toHaveLength(80);
        for (const malo of ['a', '   a   ', 'x'.repeat(81), '', 7, null, undefined]) expect(nombreValido(malo)).toBeNull();
    });

    it('pesos con punto de miles', () => {
        expect(pesos(310000)).toBe('$310.000');
        expect(pesos(1200000)).toBe('$1.200.000');
        expect(pesos(900)).toBe('$900');
    });
});

describe('montosDeFichaSinCargar', () => {
    it('reconoce $310.000, 310000 y 310 mil junto a la palabra', () => {
        expect(montosDeFichaSinCargar('La matrícula vale $310.000 y se paga una vez.', [])).toEqual([{ concepto: 'matricula', monto: 310000 }]);
        expect(montosDeFichaSinCargar('Inscripción: 310000', [])).toEqual([{ concepto: 'inscripcion', monto: 310000 }]);
        expect(montosDeFichaSinCargar('El uniforme cuesta 310 mil', [])).toEqual([{ concepto: 'uniforme', monto: 310000 }]);
        expect(montosDeFichaSinCargar('CAMISETA $ 45,000', [])).toEqual([{ concepto: 'camiseta', monto: 45000 }]);
        expect(montosDeFichaSinCargar('Matricula anual: $1.200.000,00', [])).toEqual([{ concepto: 'matricula', monto: 1200000 }]);
    });

    it('el monto puede ir antes de la palabra, en la misma frase', () => {
        expect(montosDeFichaSinCargar('Son $310.000 de matrícula.', [])).toEqual([{ concepto: 'matricula', monto: 310000 }]);
        // Otra frase: ese monto no es de la matrícula.
        expect(montosDeFichaSinCargar('La mensualidad vale $150.000. Matrícula gratis este mes.', [])).toEqual([]);
    });

    it('lo que ya está cargado no se reporta', () => {
        expect(montosDeFichaSinCargar('Matrícula $310.000. Uniforme $85.000.', [310000])).toEqual([{ concepto: 'uniforme', monto: 85000 }]);
        expect(montosDeFichaSinCargar('Matrícula $310.000. Uniforme $85.000.', [310000, 85000])).toEqual([]);
        // «Uniforme incluido en la mensualidad de $150.000»: 150.000 es un valor cargado (la mensualidad).
        expect(montosDeFichaSinCargar('Uniforme incluido en la mensualidad de $150.000', [150000])).toEqual([]);
    });

    it('cada palabra se queda con SU monto, sin repetir', () => {
        expect(montosDeFichaSinCargar('Matrícula $100.000, uniforme $85.000 y camiseta 40 mil.\nLa matrícula es de $100.000.', [])).toEqual([
            { concepto: 'matricula', monto: 100000 },
            { concepto: 'uniforme', monto: 85000 },
            { concepto: 'camiseta', monto: 40000 },
        ]);
    });

    it('no confunde años, teléfonos ni cantidades con montos', () => {
        expect(montosDeFichaSinCargar('Inscripciones abiertas 2026. Escríbenos al 3202683539.', [])).toEqual([]);
        expect(montosDeFichaSinCargar('El uniforme trae 2 camisetas y se entrega en 15 días', [])).toEqual([]);
        expect(montosDeFichaSinCargar('Matrícula en otra línea\n$310.000 la mensualidad', [])).toEqual([]);
    });

    it('sin ficha o sin palabras clave: nada', () => {
        expect(montosDeFichaSinCargar(null, [])).toEqual([]);
        expect(montosDeFichaSinCargar('   ', [])).toEqual([]);
        expect(montosDeFichaSinCargar('La mensualidad vale $150.000', [])).toEqual([]);
    });
});

describe('avisosDePrecios', () => {
    const limpio = { respondePrecios: true, matriculasDistintas: [100000], articulosActivos: 1, fichaSinCargar: [] };

    it('todo en orden: sin avisos', () => {
        expect(avisosDePrecios(limpio)).toEqual([]);
    });

    it('matrícula distinta por plan (y entonces no dice «sin matrícula»)', () => {
        const a = avisosDePrecios({ ...limpio, matriculasDistintas: [100000, 120000] });
        expect(a.map((x) => x.clave)).toEqual(['matricula_distinta_por_plan']);
        expect(a[0].texto).toContain('$100.000 y $120.000');
    });

    it('sin matrícula, sin artículos y precios apagados', () => {
        const a = avisosDePrecios({ respondePrecios: false, matriculasDistintas: [], articulosActivos: 0, fichaSinCargar: [] });
        expect(a.map((x) => x.clave)).toEqual(['sin_matricula', 'sin_articulos', 'responde_precios_apagado']);
    });

    it('la ficha: dice cuál monto y para qué; un solo aviso aunque sean varios', () => {
        const uno = avisosDePrecios({ ...limpio, fichaSinCargar: [{ concepto: 'matricula', monto: 310000 }] });
        expect(uno).toHaveLength(1);
        expect(uno[0].clave).toBe('ficha_menciona_valor_sin_cargar');
        expect(uno[0].texto).toContain('$310.000 para la matrícula');
        const dos = avisosDePrecios({ ...limpio, fichaSinCargar: [{ concepto: 'matricula', monto: 310000 }, { concepto: 'uniforme', monto: 85000 }] });
        expect(dos).toHaveLength(1);
        expect(dos[0].texto).toContain('$310.000 para la matrícula y $85.000 para el uniforme');
    });

    it('tutea y no usa jerga técnica', () => {
        const a = avisosDePrecios({
            respondePrecios: false, matriculasDistintas: [1, 2], articulosActivos: 0, fichaSinCargar: [{ concepto: 'camiseta', monto: 40000 }],
        });
        for (const x of a) expect(x.texto).not.toMatch(/\b(vos|ten[eé]s|pod[eé]s|registration_fee|school_|RPC|null|plan_id)\b/i);
    });
});

describe('leerPreciosDeEscuela', () => {
    it('arma el contrato completo', async () => {
        const p = await leer();
        expect(p.interruptores).toEqual({ responde_precios: true, cobra_desde_comprobante: false });
        expect(p.mensualidades).toEqual([
            { plan_id: 'p1', nombre: 'Mensual 2 días', precio: 150000 },
            { plan_id: 'p2', nombre: 'Mensual 3 días', precio: 180000 },
        ]);
        expect(p.matricula).toEqual({ valor: 100000, valores_distintos: [100000], planes: 2 });
        expect(p.clase_prueba).toEqual({ valor: 20000, habilitada: true });
        expect(p.articulos).toEqual([
            { id: 'a1', nombre: 'Uniforme', precio: 85000, activo: true },
            { id: 'a2', nombre: 'Camiseta vieja', precio: 40000, activo: false },
        ]);
        expect(p.servicios).toEqual([{
            id: 's1', nombre: 'Vacacional', tipo: 'vacacional', precio: 300000, precio_afiliado: 250000,
            opciones: [{ clave: '1s', etiqueta: '1 semana', precio: 120000, precio_afiliado: null }],
            activo: true, vende_por_whatsapp: true,
        }]);
        expect(p.servicios[0]).not.toHaveProperty('event_id');
        expect(p.avisos).toEqual([]);
    });

    it('una lectura por fuente, todas filtradas por la escuela, y ninguna escritura', async () => {
        await leer();
        const ops = est.ops as Op[];
        expect(ops.map((o) => o.tabla).sort()).toEqual([
            'offering_plans', 'school_merchandise_items', 'school_settings', 'school_tournament_items', 'school_trial_class_settings',
        ]);
        for (const o of ops) expect(o.filtros.school_id).toBe(ESCUELA);
        expect(ops.find((o) => o.tabla === 'offering_plans')!.filtros.is_active).toBe(true);
        expect(escrituras()).toHaveLength(0);
    });

    it('matrículas distintas: valor null y aviso; sin ninguna: valor null y «sin matrícula»', async () => {
        base({ offering_plans: [{ id: 'p1', name: 'A', price: 1, registration_fee: 120000 }, { id: 'p2', name: 'B', price: 1, registration_fee: '100000' }] });
        let p = await leer();
        expect(p.matricula).toEqual({ valor: null, valores_distintos: [100000, 120000], planes: 2 });
        expect(p.avisos.map((a) => a.clave)).toEqual(['matricula_distinta_por_plan']);

        base({ offering_plans: [{ id: 'p1', name: 'A', price: 1, registration_fee: 0 }] });
        p = await leer();
        expect(p.matricula).toEqual({ valor: null, valores_distintos: [], planes: 1 });
        expect(p.avisos.map((a) => a.clave)).toEqual(['sin_matricula']);
    });

    it('escuela sin nada: todo vacío, clase de prueba prendida por defecto y sus avisos', async () => {
        base({ school_settings: null, offering_plans: [], school_trial_class_settings: null, school_merchandise_items: [], school_tournament_items: [] });
        const p = await leer();
        expect(p).toMatchObject({
            interruptores: { responde_precios: false, cobra_desde_comprobante: false },
            mensualidades: [], matricula: { valor: null, valores_distintos: [], planes: 0 },
            clase_prueba: { valor: null, habilitada: true }, articulos: [], servicios: [],
        });
        expect(p.avisos.map((a) => a.clave)).toEqual(['sin_matricula', 'sin_articulos', 'responde_precios_apagado']);
    });

    it('solo artículos inactivos cuenta como «sin artículos»; la clase apagada se ve apagada', async () => {
        base({
            school_merchandise_items: [{ id: 'a2', name: 'Vieja', price: 40000, active: false }],
            school_trial_class_settings: { enabled: false, trial_price: 0 },
        });
        const p = await leer();
        expect(p.clase_prueba).toEqual({ valor: null, habilitada: false });
        expect(p.avisos.map((a) => a.clave)).toEqual(['sin_articulos']);
    });

    it('la ficha contra TODO lo cargado (también tallas, opciones y precio de afiliado)', async () => {
        const d = base();
        d.school_settings.wa_ficha_prospectos = 'Matrícula $310.000. Uniforme talla XL $95.000. Camiseta 120 mil. Inscripción $250.000';
        const p = await leer();
        expect(p.avisos).toHaveLength(1);
        expect(p.avisos[0].clave).toBe('ficha_menciona_valor_sin_cargar');
        // 95.000 es la talla XL del uniforme, 120.000 una opción del vacacional y 250.000 su precio de afiliado: cargados.
        expect(p.avisos[0].texto).toContain('$310.000 para la matrícula');
        expect(p.avisos[0].texto).not.toMatch(/95\.000|120\.000|250\.000/);
    });

    it('servicios: sin ventas por WhatsApp habilitadas, vende_por_whatsapp = false', async () => {
        const d = base();
        d.school_settings.wa_ventas_habilitadas = false;
        expect((await leer()).servicios[0].vende_por_whatsapp).toBe(false);
    });

    it('tolera columnas y tablas que falten', async () => {
        const d = base();
        est.responder = (op: Op) => {
            if (op.tabla === 'school_settings' && op.cols !== '*') return { error: { code: '42703', message: 'column school_settings.wa_cobro_desde_comprobante does not exist' } };
            if (op.tabla === 'school_settings') return { data: { wa_responder_precios: true } };
            if (op.tabla === 'school_merchandise_items') return { error: { code: 'PGRST205', message: 'Could not find the table' } };
            if (op.tabla === 'school_trial_class_settings') return { error: { code: '42P01', message: 'relation does not exist' } };
            return { data: d[op.tabla] };
        };
        const p = await leer();
        expect(p.interruptores).toEqual({ responde_precios: true, cobra_desde_comprobante: false });
        expect(p.articulos).toEqual([]);
        expect(p.clase_prueba).toEqual({ valor: null, habilitada: true });
        expect(p.servicios[0].vende_por_whatsapp).toBe(false);
    });

    it('un error de base no lanza: 500 con clave', async () => {
        est.responder = (op: Op) => (op.tabla === 'offering_plans' ? { error: { code: '57014', message: 'timeout' } } : { data: null });
        expect(await leerPreciosDeEscuela(ESCUELA)).toEqual({ ok: false, status: 500, error: 'error_leyendo_precios' });
        est.responder = () => { throw new Error('se cayó'); };
        expect(await leerPreciosDeEscuela(ESCUELA)).toEqual({ ok: false, status: 500, error: 'error_leyendo_precios' });
    });
});

describe('interruptores', () => {
    it('solo booleanos; al menos uno; lo demás 400 sin tocar la base', async () => {
        for (const malo of [null, [], {}, { responde_precios: 'true' }, { cobra_desde_comprobante: 1 }, { responde_precios: true, cobra_desde_comprobante: null }, { otro: true }]) {
            expect(await guardarInterruptores(ESCUELA, malo)).toEqual({ ok: false, status: 400, error: 'interruptores_invalidos' });
        }
        expect(est.ops).toHaveLength(0);
    });

    it('escribe solo lo que llegó, en la fila de ESA escuela, y devuelve el GET', async () => {
        const r = await guardarInterruptores(ESCUELA, { responde_precios: false, school_id: 'otra', wa_ventas_habilitadas: true });
        expect(r.ok).toBe(true);
        expect(escrituras()).toEqual([expect.objectContaining({
            tabla: 'school_settings', accion: 'update', valores: { wa_responder_precios: false }, filtros: { school_id: ESCUELA },
        })]);
        expect(r.ok && r.precios.mensualidades).toHaveLength(2);
    });

    it('sin fila de ajustes la crea; sin la columna: 503', async () => {
        const d = base();
        est.responder = (op: Op) => (op.accion === 'update' ? { data: [] } : op.accion === 'insert' ? {} : { data: d[op.tabla] });
        expect((await guardarInterruptores(ESCUELA, { cobra_desde_comprobante: true })).ok).toBe(true);
        expect(escrituras().map((o) => [o.accion, o.valores])).toEqual([
            ['update', { wa_cobro_desde_comprobante: true }],
            ['insert', { school_id: ESCUELA, wa_cobro_desde_comprobante: true }],
        ]);

        est.responder = (op: Op) => (op.accion === 'update' ? { error: { code: 'PGRST204', message: 'column not found' } } : { data: null });
        expect(await guardarInterruptores(ESCUELA, { cobra_desde_comprobante: true })).toEqual({ ok: false, status: 503, error: 'migracion_pendiente' });
    });

    it('error de base: 500 con clave', async () => {
        est.responder = (op: Op) => (op.accion === 'update' ? { error: { code: '57014', message: 'timeout' } } : { data: null });
        expect(await guardarInterruptores(ESCUELA, { responde_precios: true })).toEqual({ ok: false, status: 500, error: 'error_guardando' });
    });
});

describe('matrícula', () => {
    it('rechaza lo inválido sin tocar la base', async () => {
        for (const malo of [undefined, {}, { valor: '310000' }, { valor: -1 }, { valor: 100.5 }, { valor: 50_000_001 }, { valor: true }]) {
            expect(await guardarMatricula(ESCUELA, malo)).toEqual({ ok: false, status: 400, error: 'valor_invalido' });
        }
        expect(est.ops).toHaveLength(0);
    });

    it('la pone igual en TODOS los planes activos de la escuela, en un solo UPDATE', async () => {
        const r = await guardarMatricula(ESCUELA, { valor: 310000 });
        expect(r.ok).toBe(true);
        const ops = est.ops as Op[];
        expect(ops[0]).toMatchObject({ tabla: 'offering_plans', accion: 'select', filtros: { school_id: ESCUELA, is_active: true } });
        expect(escrituras()).toEqual([expect.objectContaining({
            tabla: 'offering_plans', accion: 'update', valores: { registration_fee: 310000 },
            filtros: { id: ['p1', 'p2'], school_id: ESCUELA },
        })]);
    });

    it('null y 0 = sin matrícula (se guarda NULL); el seguro no se toca', async () => {
        await guardarMatricula(ESCUELA, { valor: 0 });
        await guardarMatricula(ESCUELA, { valor: null });
        expect(escrituras().map((o) => o.valores)).toEqual([{ registration_fee: null }, { registration_fee: null }]);
    });

    it('sin planes activos: 409 y no escribe', async () => {
        base({ offering_plans: [] });
        expect(await guardarMatricula(ESCUELA, { valor: 310000 })).toEqual({ ok: false, status: 409, error: 'sin_planes_activos' });
        expect(escrituras()).toHaveLength(0);
    });

    it('error de base: 500 con clave', async () => {
        const d = base();
        est.responder = (op: Op) => (op.accion === 'update' ? { error: { code: '57014', message: 'timeout' } } : { data: d[op.tabla] });
        expect(await guardarMatricula(ESCUELA, { valor: 310000 })).toEqual({ ok: false, status: 500, error: 'error_guardando' });
    });
});

describe('clase de prueba', () => {
    it('0 se guarda como NULL, igual que guardar_valor_clase_prueba; siempre en la fila de la escuela', async () => {
        await guardarClasePrueba(ESCUELA, { valor: 0 });
        await guardarClasePrueba(ESCUELA, { valor: 25000 });
        const w = escrituras();
        expect(w.map((o) => [o.tabla, o.accion, o.valores.school_id, o.valores.trial_price])).toEqual([
            ['school_trial_class_settings', 'upsert', ESCUELA, null],
            ['school_trial_class_settings', 'upsert', ESCUELA, 25000],
        ]);
        // Solo el valor (y la fecha): no pisa `enabled` ni el resto de la configuración.
        expect(Object.keys(w[0].valores).sort()).toEqual(['school_id', 'trial_price', 'updated_at']);
    });

    it('rechaza lo inválido sin tocar la base', async () => {
        for (const malo of [null, {}, { valor: '25000' }, { valor: -3 }, { valor: 1.5 }, { valor: 60_000_000 }]) {
            expect(await guardarClasePrueba(ESCUELA, malo)).toEqual({ ok: false, status: 400, error: 'valor_invalido' });
        }
        expect(est.ops).toHaveLength(0);
    });
});

describe('artículos', () => {
    it('crear: nombre recortado y precio entero, con la escuela de la ruta (nunca la del cuerpo)', async () => {
        const r = await crearArticulo(ESCUELA, { nombre: '  Uniforme  completo ', precio: 85000, school_id: 'otra', active: false });
        expect(r.ok).toBe(true);
        expect(escrituras()).toEqual([expect.objectContaining({
            tabla: 'school_merchandise_items', accion: 'insert', valores: { school_id: ESCUELA, name: 'Uniforme completo', price: 85000 },
        })]);
    });

    it('crear: rechaza nombre o precio inválidos sin tocar la base', async () => {
        expect(await crearArticulo(ESCUELA, { nombre: 'a', precio: 1000 })).toMatchObject({ status: 400, error: 'nombre_invalido' });
        expect(await crearArticulo(ESCUELA, { nombre: 'x'.repeat(81), precio: 1000 })).toMatchObject({ status: 400, error: 'nombre_invalido' });
        for (const precio of [0, -1, 1000.5, '1000', null, undefined, 50_000_001]) {
            expect(await crearArticulo(ESCUELA, { nombre: 'Uniforme', precio })).toMatchObject({ status: 400, error: 'precio_invalido' });
        }
        expect(await crearArticulo(ESCUELA, 'x')).toMatchObject({ status: 400, error: 'articulo_invalido' });
        expect(est.ops).toHaveLength(0);
    });

    it('actualizar: solo lo que llegó, y SIEMPRE con el id y la escuela en el filtro', async () => {
        const r = await actualizarArticulo(ESCUELA, ART, { activo: false, school_id: 'otra', id: 'otro' });
        expect(r.ok).toBe(true);
        expect(escrituras()).toEqual([expect.objectContaining({
            tabla: 'school_merchandise_items', accion: 'update', valores: { active: false }, filtros: { id: ART, school_id: ESCUELA },
        })]);
        est.ops = [];
        await actualizarArticulo(ESCUELA, ART, { nombre: ' Camiseta ', precio: 45000 });
        expect(escrituras()[0].valores).toEqual({ name: 'Camiseta', price: 45000 });
    });

    it('actualizar: el artículo de otra escuela no existe para esta (404)', async () => {
        const d = base();
        est.responder = (op: Op) => (op.accion === 'update' ? { data: [] } : { data: d[op.tabla] });
        expect(await actualizarArticulo(ESCUELA, ART, { precio: 1000 })).toEqual({ ok: false, status: 404, error: 'articulo_no_encontrado' });
    });

    it('actualizar: rechaza lo inválido y el cuerpo vacío sin tocar la base', async () => {
        expect(await actualizarArticulo(ESCUELA, ART, {})).toMatchObject({ status: 400, error: 'sin_cambios' });
        expect(await actualizarArticulo(ESCUELA, ART, { nombre: ' ' })).toMatchObject({ status: 400, error: 'nombre_invalido' });
        expect(await actualizarArticulo(ESCUELA, ART, { precio: 0 })).toMatchObject({ status: 400, error: 'precio_invalido' });
        expect(await actualizarArticulo(ESCUELA, ART, { activo: 'no' })).toMatchObject({ status: 400, error: 'activo_invalido' });
        expect(est.ops).toHaveLength(0);
    });

    it('nunca se borra: no hay ninguna operación de borrado', async () => {
        await actualizarArticulo(ESCUELA, ART, { activo: false });
        expect((est.ops as Op[]).every((o) => ['select', 'update'].includes(o.accion))).toBe(true);
    });
});
