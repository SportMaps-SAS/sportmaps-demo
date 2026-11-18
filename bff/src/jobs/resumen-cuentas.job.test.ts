import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: vi.fn() } }));

import {
    cuentaDe, sumarPorCuenta, esDiaDeInforme, inicioDelInforme, armarResumen, debeEnviar, asuntoDe, htmlDelResumen,
    resumenCuentasActivo, claveDeCorte, horaCO,
} from './resumen-cuentas.job';
import { idsConResumenDeCuentas } from '../services/resumen-cuentas.config';

// Fechas en Colombia (UTC−5): lunes 2026-11-16, miércoles 11-18, viernes 11-20, domingo 11-22.
const col = (iso: string) => Date.parse(`${iso}-05:00`);

describe('cuentaDe — la cuenta sale del banco del comprobante, no del destino', () => {
    it('reconoce Nequi, Daviplata y los bancos comunes', () => {
        expect(cuentaDe('Nequi')).toBe('Nequi');
        expect(cuentaDe('NEQUI ')).toBe('Nequi');
        expect(cuentaDe('Daviplata')).toBe('Daviplata');
        expect(cuentaDe('DaviPlata')).toBe('Daviplata');
        expect(cuentaDe('Bancolombia')).toBe('Bancolombia');
        expect(cuentaDe('BBVA')).toBe('BBVA');
        expect(cuentaDe('BreB')).toBe('Bre-B');
        expect(cuentaDe('Otro')).toBe('Otro / sin banco');
    });
    it('sin banco usa el método del pago; sin nada, «Otro / sin banco»', () => {
        expect(cuentaDe(null, 'cash')).toBe('Efectivo');
        expect(cuentaDe('', 'pse')).toBe('En línea (PSE / tarjeta)');
        expect(cuentaDe(null, 'card')).toBe('En línea (PSE / tarjeta)');
        expect(cuentaDe(null, null)).toBe('Otro / sin banco');
        expect(cuentaDe(undefined, 'transfer')).toBe('Otro / sin banco');
    });
    it('un banco desconocido se muestra tal cual, acortado', () => {
        expect(cuentaDe('Banco Pichincha')).toBe('Banco Pichincha');
    });
});

describe('sumarPorCuenta', () => {
    it('agrupa y ordena de mayor a menor valor', () => {
        const l = sumarPorCuenta([
            { banco: 'Nequi', monto: 150000 }, { banco: 'Daviplata', monto: 300000 }, { banco: 'nequi', monto: 175000 }, { banco: null, metodo: 'cash', monto: 50000 },
        ]);
        expect(l.map((x) => [x.cuenta, x.cantidad, x.monto])).toEqual([
            ['Nequi', 2, 325000], ['Daviplata', 1, 300000], ['Efectivo', 1, 50000],
        ]);
    });
});

describe('calendario (Colombia)', () => {
    it('lunes, miércoles y viernes son de informe; los demás no', () => {
        expect(esDiaDeInforme(col('2026-11-16T07:00:00'))).toBe(true);
        expect(esDiaDeInforme(col('2026-11-17T07:00:00'))).toBe(false);
        expect(esDiaDeInforme(col('2026-11-18T07:00:00'))).toBe(true);
        expect(esDiaDeInforme(col('2026-11-20T07:00:00'))).toBe(true);
        expect(esDiaDeInforme(col('2026-11-22T07:00:00'))).toBe(false);
    });
    it('usa la hora de Colombia aunque sea otro día en UTC (7 p. m. COT = 00:00 UTC del día siguiente)', () => {
        expect(horaCO(col('2026-11-18T19:00:00'))).toBe(19);
        expect(esDiaDeInforme(col('2026-11-18T19:00:00'))).toBe(true); // sigue siendo miércoles en Colombia
    });
    it('el informe cuenta desde la revisión anterior, a las 7 a. m.', () => {
        const iso = (ms: number | null) => (ms === null ? null : new Date(ms - 5 * 3600_000).toISOString().slice(0, 16));
        expect(iso(inicioDelInforme(col('2026-11-16T07:00:00')))).toBe('2026-11-13T07:00'); // lunes ← viernes
        expect(iso(inicioDelInforme(col('2026-11-18T07:00:00')))).toBe('2026-11-16T07:00'); // miércoles ← lunes
        expect(iso(inicioDelInforme(col('2026-11-20T07:00:00')))).toBe('2026-11-18T07:00'); // viernes ← miércoles
        expect(inicioDelInforme(col('2026-11-17T07:00:00'))).toBeNull();
    });
});

describe('armarResumen / debeEnviar', () => {
    const ahora = col('2026-11-18T11:00:00');
    const item = (banco: string, monto: number, horasAtras: number) => ({ banco, metodo: null, monto, desde: new Date(ahora - horasAtras * 3600_000).toISOString() });

    it('suma por cuenta, cuenta los de más de 4 h y toma el más antiguo', () => {
        const r = armarResumen({ ahora, porValidar: [item('Nequi', 150000, 5), item('Daviplata', 100000, 1)], porClasificar: [item('Nequi', 30000, 30)] });
        expect(r.porValidar.cantidad).toBe(2);
        expect(r.porValidar.monto).toBe(250000);
        expect(r.porClasificar.monto).toBe(30000);
        expect(r.sinDecidir4h).toBe(2);
        expect(r.masAntiguoMs).toBe(ahora - 30 * 3600_000);
    });
    it('el resumen de 4 h solo sale si hay algo pendiente; el informe, siempre', () => {
        const vacio = armarResumen({ ahora, porValidar: [], porClasificar: [] });
        expect(debeEnviar(vacio, false)).toBe(false);
        expect(debeEnviar(vacio, true)).toBe(true);
        expect(debeEnviar(armarResumen({ ahora, porValidar: [item('Nequi', 1000, 1)], porClasificar: [] }), false)).toBe(true);
    });
});

describe('correo', () => {
    const ahora = col('2026-11-18T07:00:00');
    const r = armarResumen({
        ahora, desde: col('2026-11-16T07:00:00'),
        porValidar: [{ banco: 'Nequi', metodo: null, monto: 150000, desde: new Date(ahora - 6 * 3600_000).toISOString() }],
        porClasificar: [{ banco: 'Daviplata', metodo: null, monto: 30000, desde: new Date(ahora - 1 * 3600_000).toISOString() }],
        aprobados: [{ banco: 'Nequi', metodo: null, monto: 600000 }, { banco: 'Daviplata', metodo: null, monto: 200000 }],
    });

    it('el asunto dice el valor pendiente; el del informe, lo que ingresó', () => {
        expect(asuntoDe(r, 'Monster', false, col('2026-11-18T11:00:00'))).toContain('por revisar (corte 11 a. m.)');
        expect(asuntoDe(r, 'Monster', true, ahora)).toContain('informe de revisión');
        expect(asuntoDe(r, 'Monster', true, ahora)).toContain('800.000');
    });
    it('el HTML trae el valor por cuenta y escapa el nombre de la escuela', () => {
        const html = htmlDelResumen(r, 'Monster <b>x</b>', true, ahora);
        expect(html).toContain('Nequi');
        expect(html).toContain('Daviplata');
        expect(html).toContain('Ingresó desde la revisión anterior');
        expect(html).toContain('más de 4 horas');
        expect(html).not.toContain('<b>x</b>');
        expect(html).toContain('&lt;b&gt;');
    });
    it('el resumen de 4 h no trae la sección de lo aprobado', () => {
        const sin = armarResumen({ ahora, porValidar: [], porClasificar: [{ banco: 'Nequi', metodo: null, monto: 1000, desde: new Date(ahora).toISOString() }] });
        expect(htmlDelResumen(sin, 'Monster', false, ahora)).not.toContain('Ingresó desde la revisión anterior');
    });
});

describe('quién lo recibe y cuándo corre', () => {
    const MONSTER = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
    const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
    it('sin la lista, nadie; con la lista y producción, sí', () => {
        expect(resumenCuentasActivo(env({ NODE_ENV: 'production' }))).toBe(false);
        expect(resumenCuentasActivo(env({ NODE_ENV: 'production', RESUMEN_CUENTAS_ESCUELAS: MONSTER }))).toBe(true);
        expect(resumenCuentasActivo(env({ NODE_ENV: 'development', RESUMEN_CUENTAS_ESCUELAS: MONSTER }))).toBe(false);
        expect(resumenCuentasActivo(env({ NODE_ENV: 'production', RESUMEN_CUENTAS_ESCUELAS: MONSTER, DISABLE_RESUMEN_CUENTAS: 'true' }))).toBe(false);
    });
    it('la lista se lee sin importar mayúsculas ni espacios', () => {
        expect([...idsConResumenDeCuentas(env({ RESUMEN_CUENTAS_ESCUELAS: ` ${MONSTER.toUpperCase()} , x ` }))]).toEqual([MONSTER, 'x']);
    });
    it('la clave de reserva es por escuela, día y hora (4 correos al día no se pisan)', () => {
        expect(claveDeCorte('s1', '2026-11-18', 7)).toBe('resumen_cuentas:s1:2026-11-18:07');
        expect(claveDeCorte('s1', '2026-11-18', 11)).not.toBe(claveDeCorte('s1', '2026-11-18', 15));
    });
});
