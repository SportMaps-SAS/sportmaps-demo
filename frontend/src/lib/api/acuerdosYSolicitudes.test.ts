/** Cuentas puras: calendario, orden y filtros de acuerdos; orden, filtros y cuerpo de resolver de solicitudes. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./bffClient', () => ({ bffClient: {} }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
    calendarioDeAcuerdo, calendarioDeVistaPrevia, contarSolicitados, fechaCorta, filtrarAcuerdos, ordenarAcuerdos,
    resumenCalendario, textoMotivos, validarAjustes, type Acuerdo,
} from './acuerdosDePago';
import { contarPorResolver, cuerpoDeResolver, filtrarSolicitudes, ordenarSolicitudes, textoFechas, type Solicitud } from './planRequests';

const ac = (id: string, status: Acuerdo['status'], created_at: string): Acuerdo => ({
    id, school_id: 'S', payer_profile_id: null, requested_by: null, status, source: 'app', installments: 2, total_amount: 100,
    first_due_date: null, last_due_date: null, auto_approved: false, approved_at: null, resolution_note: null, created_at, items: [],
});
const so = (id: string, tipo: Solicitud['tipo'], estado: Solicitud['estado'], creada_at: string): Solicitud => ({
    id, tipo, enrollment_id: 'E', school_id: 'S', estado, atleta_nombre: null, desde: '2026-12-01', hasta: null, motivo: null,
    detalle_motivo: null, canal: 'app', solicitante_rol: 'parent', auto_aprobada: false, fuera_de_tope: false,
    nota_administracion: null, creada_at, resuelta_at: null,
});

describe('acuerdos de pago', () => {
    it('da formato al calendario de cuotas', () => {
        expect(fechaCorta('2026-11-05')).toBe('5 nov 2026');
        expect(fechaCorta(null)).toBe('—');
        const filas = calendarioDeVistaPrevia({ cuotas: [{ seq: 1, fecha: '2026-11-15', monto: 50000 }, { seq: 2, fecha: '2027-01-15', monto: 50001 }] });
        expect(filas.map((f) => f.fecha)).toEqual(['15 nov 2026', '15 ene 2027']);
        expect(resumenCalendario(filas)).toBe('2 cuotas · del 15 nov 2026 al 15 ene 2027');
        expect(resumenCalendario([filas[0]])).toBe('1 cuota · 15 nov 2026');
    });

    it('ordena las cuotas guardadas por seq', () => {
        const a = { items: [{ seq: 2, due_date: '2026-12-01', amount: 2, status: 'pendiente' as const }, { seq: 1, due_date: '2026-11-01', amount: 1, status: 'pagado' as const }] };
        expect(calendarioDeAcuerdo(a).map((f) => f.seq)).toEqual([1, 2]);
    });

    it('las solicitudes van primero (la más antigua arriba) y se cuentan', () => {
        const l = [ac('a', 'activo', '2026-11-03'), ac('b', 'solicitado', '2026-11-02'), ac('c', 'solicitado', '2026-11-01'), ac('d', 'cumplido', '2026-11-04')];
        expect(ordenarAcuerdos(l).map((x) => x.id)).toEqual(['c', 'b', 'd', 'a']);
        expect(contarSolicitados(l)).toBe(2);
        expect(filtrarAcuerdos(l, 'activo').map((x) => x.id)).toEqual(['a']);
        expect(filtrarAcuerdos(l, 'todos')).toHaveLength(4);
    });

    it('traduce los motivos y valida los topes', () => {
        expect(textoMotivos(['mas_cuotas_del_tope', 'otro'])).toEqual(['Pide más cuotas que el tope de la escuela', 'otro']);
        expect(validarAjustes({ habilitado: true, max_cuotas: 0, max_dias: 60, auto_aprobar: true })).toMatch(/cuotas/);
        expect(validarAjustes({ habilitado: true, max_cuotas: 3, max_dias: 400, auto_aprobar: true })).toMatch(/días/);
        expect(validarAjustes({ habilitado: true, max_cuotas: 3, max_dias: 60, auto_aprobar: true })).toBeNull();
    });
});

describe('solicitudes de plan', () => {
    it('dar_de_baja solo viaja al aprobar un retiro', () => {
        expect(cuerpoDeResolver('retiro', { decision: 'aprobar' })).toEqual({ decision: 'aprobar', dar_de_baja: false });
        expect(cuerpoDeResolver('retiro', { decision: 'aprobar', dar_de_baja: true, note: ' ok ' })).toEqual({ decision: 'aprobar', note: 'ok', dar_de_baja: true });
        expect(cuerpoDeResolver('retiro', { decision: 'rechazar', dar_de_baja: true })).toEqual({ decision: 'rechazar' });
        expect(cuerpoDeResolver('pausa', { decision: 'aprobar', dar_de_baja: true })).toEqual({ decision: 'aprobar' });
        expect(cuerpoDeResolver('reactivacion', { decision: 'aprobar', dar_de_baja: true })).not.toHaveProperty('dar_de_baja');
    });

    it('ordena, filtra y describe las fechas por tipo', () => {
        const l = [so('1', 'pausa', 'aprobado', '2026-11-03'), so('2', 'retiro', 'solicitado', '2026-11-02'), so('3', 'reactivacion', 'solicitado', '2026-11-01')];
        expect(ordenarSolicitudes(l).map((x) => x.id)).toEqual(['3', '2', '1']);
        expect(contarPorResolver(l)).toBe(2);
        expect(filtrarSolicitudes(l, { estado: 'solicitado', tipo: 'retiro' }).map((x) => x.id)).toEqual(['2']);
        expect(textoFechas({ tipo: 'pausa', desde: '2027-02-01', hasta: '2027-04-01' })).toBe('De febrero 2027 a abril 2027');
        expect(textoFechas({ tipo: 'pausa', desde: '2027-02-01', hasta: '2027-02-01' })).toBe('En febrero 2027');
        expect(textoFechas({ tipo: 'retiro', desde: '2026-11-30', hasta: null })).toBe('Sale el 30 de noviembre de 2026');
        expect(textoFechas({ tipo: 'reactivacion', desde: '2027-01-01', hasta: null })).toBe('Vuelve en enero 2027');
    });
});
