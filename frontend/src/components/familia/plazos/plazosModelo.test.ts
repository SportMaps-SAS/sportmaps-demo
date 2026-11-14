import { describe, expect, it } from 'vitest';
import {
    ETIQUETA_ESTADO_ACUERDO, ETIQUETA_ESTADO_CUOTA, TEXTO_MOTIVO, cobrosParaPlazos, fechaLegible,
    fechasSugeridas, proximaFecha, repartirCuotas, sumarMeses, validarFechas,
} from './plazosModelo';
import { PROHIBIDAS } from '../utilsPrueba';

describe('repartirCuotas', () => {
    it('reparte en partes iguales cuando divide exacto', () => {
        expect(repartirCuotas(300000, 3)).toEqual([100000, 100000, 100000]);
    });
    it('la última cuota absorbe el redondeo y la suma siempre da el saldo', () => {
        const c = repartirCuotas(100000, 3);
        expect(c).toEqual([33333, 33333, 33334]);
        expect(c.reduce((a, b) => a + b, 0)).toBe(100000);
    });
    it('una cuota es el saldo completo; saldo negativo no rompe', () => {
        expect(repartirCuotas(50000, 1)).toEqual([50000]);
        expect(repartirCuotas(-5, 2)).toEqual([0, 0]);
    });
});

describe('fechas', () => {
    it('suma meses y respeta el fin de mes', () => {
        expect(sumarMeses('2026-01-31', 1)).toBe('2026-02-28');
        expect(sumarMeses('2026-11-15', 2)).toBe('2027-01-15');
    });
    it('sugiere una fecha por mes desde el mes siguiente', () => {
        expect(fechasSugeridas(3, '2026-11-06')).toEqual(['2026-12-06', '2027-01-06', '2027-02-06']);
    });
    it('valida vacío, pasado y orden', () => {
        expect(validarFechas(['2026-12-01', ''], '2026-11-06')).toMatch(/fecha de cada cuota/i);
        expect(validarFechas(['2026-11-01'], '2026-11-06')).toMatch(/hoy en adelante/i);
        expect(validarFechas(['2026-12-10', '2026-12-10'], '2026-11-06')).toMatch(/posterior/i);
        expect(validarFechas(['2026-12-10', '2027-01-10'], '2026-11-06')).toBeNull();
        expect(validarFechas(['2026-11-06'], '2026-11-06')).toBeNull();
    });
    it('formatea la fecha legible', () => {
        expect(fechaLegible('2026-11-20')).toBe('20/11/2026');
    });
});

describe('cobrosParaPlazos y próxima fecha', () => {
    it('toma solo cobros abiertos con escuela y saldo, usando el saldo pendiente', () => {
        const r = cobrosParaPlazos([
            { id: 'a', status: 'pending', school_id: 's1', concept: 'Mensualidad', amount: 100000 },
            { id: 'b', status: 'partial', school_id: 's1', amount: 100000, amount_paid: 40000 },
            { id: 'c', status: 'approved', school_id: 's1', amount: 100000 },
            { id: 'd', status: 'pending', amount: 100000 },
            { id: 'e', status: 'partial', school_id: 's1', amount: 100, balance_pending: 0 },
        ]);
        expect(r.map((x) => [x.id, x.saldo])).toEqual([['a', 100000], ['b', 60000]]);
        expect(r[1].concept).toBe('Cobro');
    });
    it('la próxima fecha es la cuota sin pagar más cercana', () => {
        expect(proximaFecha({ items: [
            { due_date: '2026-12-10', amount: 1, status: 'pagado' },
            { due_date: '2027-02-10', amount: 1, status: 'pendiente' },
            { due_date: '2027-01-10', amount: 1, status: 'pendiente' },
        ] })).toBe('2027-01-10');
        expect(proximaFecha({})).toBeNull();
    });
});

describe('lenguaje', () => {
    it('ningún texto de plazos habla de mora, deuda, atraso, multa ni recargo', () => {
        const textos = [
            ...Object.values(TEXTO_MOTIVO),
            ...Object.values(ETIQUETA_ESTADO_ACUERDO),
            ...Object.values(ETIQUETA_ESTADO_CUOTA),
        ];
        for (const t of textos) expect(t).not.toMatch(PROHIBIDAS);
    });
});
