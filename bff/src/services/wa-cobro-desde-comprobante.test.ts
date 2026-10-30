/**
 * Crear el cobro que falta a partir del comprobante (plan B4 §3 y §5). Las
 * decisiones son puras; las lecturas, contra tablas en memoria. Precios con la
 * forma de Monster (2026-10-30): clase de prueba $15.000, matrícula $310.000,
 * uniformes $60.000, cuota $180.000.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `leadPorTelefono` carga en frío el servicio de leads (import dinámico).
vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => {
    const state = {
        tablas: {} as Record<string, any[]>,
        errores: {} as Record<string, any>,
        updates: [] as { table: string; v: any }[],
        rpc: { data: null as any, error: null as any },
        rpcLlamadas: [] as any[],
    };
    function builder(table: string) {
        const filtros: ((f: any) => boolean)[] = [];
        let update: any = null;
        const b: any = {};
        b.select = () => b;
        b.eq = (c: string, v: any) => { filtros.push((f) => f[c] === v); return b; };
        b.neq = (c: string, v: any) => { filtros.push((f) => f[c] !== v); return b; };
        b.in = (c: string, vs: any[]) => { filtros.push((f) => vs.includes(f[c])); return b; };
        b.is = (c: string, v: any) => { filtros.push((f) => (f[c] ?? null) === v); return b; };
        b.order = () => b;
        b.limit = () => b;
        b.update = (v: any) => { update = v; state.updates.push({ table, v }); return b; };
        const correr = () => {
            if (state.errores[table]) return { data: null, error: state.errores[table] };
            const filas = (state.tablas[table] ?? []).filter((f) => filtros.every((p) => p(f)));
            if (update) { for (const f of filas) Object.assign(f, update); return { data: filas.map((f) => ({ id: f.id })), error: null }; }
            return { data: filas, error: null };
        };
        b.maybeSingle = () => { const r = correr(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }); };
        b.then = (res: any, rej: any) => Promise.resolve(correr()).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => builder(t),
            rpc: vi.fn(async (nombre: string, args: any) => { state.rpcLlamadas.push({ nombre, args }); return state.rpc; }),
        },
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./receipt-context.service', () => ({
    buildVerdictContext: vi.fn(async () => ({ registeredAccounts: ['3194505150'], restrictedAccounts: [{ value: '3204298969', onlyFor: ['inscripcion'] }], cuentasFueraDeSportmaps: [] })),
}));

import {
    motivoPorMonto, decidirConEsperado, opcionesDeMotivo, clasificarDestino, destinoExactoDelComprobante,
    crearCobroDesdeComprobante, anularCobroCreado, cobroDesdeComprobanteActivo, preciosDeMotivos, pendientesDelLead,
    leadPorTelefono, conceptoDelCobroCreado, esValorMotivoElegido, preciosDeServicios,
    type PrecioDeMotivo,
} from './wa-cobro-desde-comprobante.service';
import type { PagoPendiente } from './whatsapp-receipt-matching.service';

const PRUEBA: PrecioDeMotivo = { motivo: 'clase_prueba', monto: 15000, fuente: 'trial_price', fuenteId: null, etiqueta: 'Clase de prueba' };
const MATRICULA: PrecioDeMotivo = { motivo: 'inscripcion', monto: 310000, fuente: 'registration_fee', fuenteId: 'plan-1', etiqueta: 'Inscripción' };
const UNIFORMES: PrecioDeMotivo = { motivo: 'articulos', monto: 60000, fuente: 'merchandise_item', fuenteId: 'art-1', etiqueta: 'Uniformes' };
const CLINICA: PrecioDeMotivo = { motivo: 'clase_extra', monto: 300000, fuente: 'tournament_item', fuenteId: 'it-1', etiqueta: 'Clínica de armadores' };
const SEGURO_TORNEO: PrecioDeMotivo = { motivo: 'torneo', monto: 60000, fuente: 'tournament_item', fuenteId: 'it-2', etiqueta: 'Torneo relámpago' };

beforeEach(() => {
    h.state.tablas = {};
    h.state.errores = {};
    h.state.updates = [];
    h.state.rpc = { data: null, error: null };
    h.state.rpcLlamadas = [];
});

describe('motivoPorMonto (pura)', () => {
    const precios = [PRUEBA, MATRICULA, UNIFORMES, CLINICA];

    it('un solo precio con ese monto (±$1)', () => {
        expect(motivoPorMonto(310000, precios)).toEqual({ tipo: 'uno', precio: MATRICULA });
        expect(motivoPorMonto(60000.4, precios)).toEqual({ tipo: 'uno', precio: UNIFORMES });
        expect(motivoPorMonto(15001, precios)).toEqual({ tipo: 'uno', precio: PRUEBA });
    });

    it('370.000 = matrícula + uniformes (única combinación)', () => {
        const r = motivoPorMonto(370000, precios);
        expect(r.tipo).toBe('varios');
        expect((r as any).precios.map((p: PrecioDeMotivo) => p.motivo).sort()).toEqual(['articulos', 'inscripcion']);
    });

    it('hasta 3 precios; con 4 no se busca', () => {
        expect(motivoPorMonto(385000, precios)).toMatchObject({ tipo: 'varios' }); // 310 + 60 + 15
        expect(motivoPorMonto(685000, precios)).toEqual({ tipo: 'ninguno' }); // los 4
    });

    it('ambiguo: dos precios iguales, o dos sumas distintas', () => {
        expect(motivoPorMonto(60000, [...precios, SEGURO_TORNEO])).toMatchObject({ tipo: 'ambiguo' });
        expect(motivoPorMonto(75000, [PRUEBA, UNIFORMES, SEGURO_TORNEO])).toMatchObject({ tipo: 'ambiguo' });
    });

    it('nunca propone si el monto es una cuota de la familia', () => {
        expect(motivoPorMonto(180000, [...precios, { ...UNIFORMES, monto: 180000 }], { cuotas: [180000] })).toEqual({ tipo: 'es_cuota' });
    });

    it('sin monto, monto que no calza, o abonos en una suma: ninguno', () => {
        expect(motivoPorMonto(null, precios)).toEqual({ tipo: 'ninguno' });
        expect(motivoPorMonto(55000, precios)).toEqual({ tipo: 'ninguno' });
        const abono: PrecioDeMotivo = { ...CLINICA, monto: 150000, esAbono: true };
        expect(motivoPorMonto(150000, [abono])).toEqual({ tipo: 'uno', precio: abono });
        expect(motivoPorMonto(165000, [abono, PRUEBA])).toEqual({ tipo: 'ninguno' });
    });
});

describe('decidirConEsperado (pura)', () => {
    const lead = { motivo: 'clase_prueba' as const, monto: 15000, leadId: 'lead-1', childId: null };
    const PEND: PagoPendiente = { id: 'p-cp', amount: 15000, concept: 'Clase de prueba — Mariana', due_date: null, child_id: null, atleta: null, categoria: 'clase_prueba' };

    it('prospecto: monto y destino exacto → crear', () => {
        expect(decidirConEsperado(lead, 15000, 'exacta', [])).toEqual({ tipo: 'crear' });
    });

    it('prospecto: monto distinto → a la escuela, sin crear', () => {
        expect(decidirConEsperado(lead, 20000, 'exacta', [])).toEqual({ tipo: 'a_la_escuela', razon: 'monto' });
        expect(decidirConEsperado(lead, null, 'exacta', [])).toEqual({ tipo: 'a_la_escuela', razon: 'monto' });
    });

    it('prospecto: destino sin leer, sin cuentas, enmascarado, restringido o ajeno → a la escuela', () => {
        for (const d of [null, 'enmascarada', 'restringida', 'ajena', 'fuera'] as const) {
            expect(decidirConEsperado(lead, 15000, d, [])).toEqual({ tipo: 'a_la_escuela', razon: 'destino' });
        }
    });

    it('prospecto con el cobro ya creado (pendiente): se aplica a ese', () => {
        expect(decidirConEsperado(lead, 15000, 'exacta', [PEND])).toEqual({ tipo: 'aplicar_existente', pago: PEND });
        expect(decidirConEsperado(lead, 20000, 'exacta', [{ ...PEND, amount: 20000 }]))
            .toMatchObject({ tipo: 'aplicar_existente' });
        expect(decidirConEsperado(lead, 15000, 'exacta', [{ ...PEND, amount: 18000 }]))
            .toEqual({ tipo: 'a_la_escuela', razon: 'cobro_distinto' });
    });

    it('familia: si no calza, sigue (puede ser la mensualidad)', () => {
        const fam = { motivo: 'inscripcion' as const, monto: 310000, leadId: null, childId: 'c1' };
        expect(decidirConEsperado(fam, 310000, null, [])).toEqual({ tipo: 'crear' });
        expect(decidirConEsperado(fam, 180000, 'exacta', [])).toEqual({ tipo: 'seguir' });
        const insc: PagoPendiente = { id: 'p-i', amount: 310000, concept: 'Inscripción', due_date: null, child_id: 'c1', atleta: 'Laura', categoria: 'inscripcion' };
        expect(decidirConEsperado(fam, 310000, 'ajena', [insc])).toEqual({ tipo: 'aplicar_existente', pago: insc });
    });
});

describe('opcionesDeMotivo y valores (puras)', () => {
    it('los 2 motivos más cercanos al monto + «Otro»', () => {
        const o = opcionesDeMotivo([PRUEBA, MATRICULA, UNIFORMES, CLINICA], 55000);
        expect(o.map((x) => x.etiqueta)).toEqual(['Uniformes', 'Clase de prueba', 'Otro']);
        expect(o[0].valor).toMatchObject({ motivo: 'articulos', fuente: 'merchandise_item', fuenteId: 'art-1', monto: 60000 });
        expect(o[2]).toEqual({ n: 3, etiqueta: 'Otro', valor: 'otro' });
        expect(esValorMotivoElegido(o[0].valor)).toBe(true);
        expect(esValorMotivoElegido('inscripcion')).toBe(false);
        expect(opcionesDeMotivo([])).toEqual([]);
    });

    it('concepto del cobro creado', () => {
        expect(conceptoDelCobroCreado(PRUEBA, 'Mariana Ruiz')).toBe('Clase de prueba — Mariana Ruiz');
        expect(conceptoDelCobroCreado(CLINICA, null)).toBe('Clínica de armadores');
    });
});

describe('destino', () => {
    it('clasificarDestino (pura): exacta, enmascarada, restringida, ajena, sin cuentas', () => {
        const c = { generales: ['3194505150', '478170006942'], restringidas: ['3204298969'], fuera: [] };
        expect(clasificarDestino('3194505150', c)).toBe('exacta');
        expect(clasificarDestino('****6942', c)).toBe('enmascarada');
        expect(clasificarDestino('3204298969', c)).toBe('restringida');
        expect(clasificarDestino('3001112222', c)).toBe('ajena');
        expect(clasificarDestino(null, c)).toBeNull();
        expect(clasificarDestino('3194505150', { generales: [], restringidas: [], fuera: [] })).toBeNull();
    });

    it('con el contexto de la escuela, y «+57 …» cuenta como exacto', async () => {
        expect(await destinoExactoDelComprobante('school-1', { destination: '+57 319 450 5150' })).toBe('exacta');
        expect(await destinoExactoDelComprobante('school-1', { destination: null })).toBeNull();
    });
});

describe('lecturas y la RPC', () => {
    it('interruptor: true solo si la columna lo dice; sin columna, false', async () => {
        h.state.tablas.school_settings = [{ school_id: 's1', wa_cobro_desde_comprobante: true }];
        expect(await cobroDesdeComprobanteActivo('s1')).toBe(true);
        expect(await cobroDesdeComprobanteActivo('s2')).toBe(false);
        h.state.errores.school_settings = { code: '42703', message: 'column does not exist' };
        expect(await cobroDesdeComprobanteActivo('s1')).toBe(false);
    });

    it('precios: clase de prueba solo para un prospecto, inscripción del plan, artículos y servicios vigentes', async () => {
        h.state.tablas = {
            school_trial_class_settings: [{ school_id: 's1', trial_price: 15000 }],
            offering_plans: [
                { id: 'plan-1', school_id: 's1', is_active: true, registration_fee: 310000 },
                { id: 'plan-2', school_id: 's1', is_active: true, registration_fee: 310000 },
            ],
            school_merchandise_items: [{ id: 'art-1', school_id: 's1', active: true, name: 'Uniformes', price: 60000, price_by_size: { S: 55000, M: 60000 } }],
            school_tournament_items: [
                { id: 'it-1', school_id: 's1', active: true, event_id: null, name: 'Clínica de armadores', kind: 'clase_extra', price: 300000, starts_at: '2099-11-21T13:00:00Z' },
                { id: 'it-viejo', school_id: 's1', active: true, event_id: null, name: 'Torneo pasado', kind: 'torneo', price: 50000, starts_at: '2020-01-01T00:00:00Z' },
            ],
        };
        const prospecto = await preciosDeMotivos('s1', { leadId: 'lead-1' });
        expect(prospecto.map((p) => `${p.motivo}:${p.monto}`).sort()).toEqual([
            'articulos:55000', 'articulos:60000', 'clase_extra:300000', 'clase_prueba:15000', 'inscripcion:310000',
        ]);
        const familia = await preciosDeMotivos('s1', { childId: 'c1' }, { motivos: ['inscripcion', 'clase_prueba'] });
        expect(familia).toEqual([{ motivo: 'inscripcion', monto: 310000, fuente: 'registration_fee', fuenteId: 'plan-1', etiqueta: 'Inscripción' }]);
    });

    it('inscripción: si los planes tienen valores distintos y el deportista no tiene plan, no se adivina', async () => {
        h.state.tablas.offering_plans = [
            { id: 'p1', school_id: 's1', is_active: true, registration_fee: 310000 },
            { id: 'p2', school_id: 's1', is_active: true, registration_fee: 250000 },
        ];
        expect(await preciosDeMotivos('s1', { leadId: 'l' }, { motivos: ['inscripcion'] })).toEqual([]);
        h.state.tablas.enrollments = [{ school_id: 's1', status: 'active', child_id: 'c1', offering_plan_id: 'p2' }];
        expect((await preciosDeMotivos('s1', { childId: 'c1' }, { motivos: ['inscripcion'] })).map((p) => p.fuenteId)).toEqual(['p2']);
    });

    it('servicios: pasados o de un evento no se ofrecen (pura)', () => {
        const r = preciosDeServicios([
            { id: 'a', name: 'Vacacional', kind: 'vacacional', price: 100000, ends_at: '2099-12-10T00:00:00Z' },
            { id: 'b', name: 'Evento', kind: 'torneo', price: 80000, event_id: 'ev-1' },
            { id: 'c', name: 'Raro', kind: 'desconocido', price: 10000 },
        ], { ahora: Date.parse('2026-10-30T12:00:00Z') });
        expect(r.map((p) => `${p.fuenteId}:${p.motivo}`)).toEqual(['a:vacacional', 'c:otro']);
    });

    it('crear: manda el contrato exacto de la RPC y lee su respuesta', async () => {
        h.state.rpc = { data: { ok: true, payment_id: 'pay-1', precio: 15000, es_abono: false, ya_existia: false, concepto: 'Clase de prueba — Mariana' }, error: null };
        const r = await crearCobroDesdeComprobante({
            schoolId: 's1', queueId: 'q1', categoria: 'clase_prueba', monto: 15000, fuente: 'trial_price', fuenteId: null,
            leadId: 'lead-1', concepto: 'Clase de prueba — Mariana', conceptoEsperadoId: 'e1', telefono: '573194505150',
        });
        expect(r).toEqual({ ok: true, paymentId: 'pay-1', precio: 15000, esAbono: false, yaExistia: false, concepto: 'Clase de prueba — Mariana' });
        expect(h.state.rpcLlamadas[0]).toEqual({
            nombre: 'wa_crear_cobro_desde_comprobante',
            args: {
                p_school_id: 's1', p_queue_id: 'q1', p_categoria: 'clase_prueba', p_monto: 15000, p_fuente: 'trial_price',
                p_fuente_id: null, p_child_id: null, p_unregistered_id: null, p_signup_lead_id: 'lead-1',
                p_concepto: 'Clase de prueba — Mariana', p_concepto_esperado_id: 'e1', p_opcion: null, p_telefono: '573194505150',
            },
        });
    });

    it('crear: código de la base, RPC sin aplicar o dos dueños → ok:false, nunca lanza', async () => {
        h.state.rpc = { data: { ok: false, codigo: 'ya_tiene_cobro', payment_id: 'pay-0' }, error: null };
        const base = { schoolId: 's1', queueId: 'q1', categoria: 'clase_prueba' as const, monto: 15000, fuente: 'trial_price' as const, fuenteId: null, concepto: 'x' };
        expect(await crearCobroDesdeComprobante({ ...base, leadId: 'l' })).toEqual({ ok: false, codigo: 'ya_tiene_cobro', paymentId: 'pay-0' });
        h.state.rpc = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        expect(await crearCobroDesdeComprobante({ ...base, leadId: 'l' })).toEqual({ ok: false, codigo: 'migracion_pendiente' });
        expect(await crearCobroDesdeComprobante({ ...base, leadId: 'l', childId: 'c' })).toEqual({ ok: false, codigo: 'datos_invalidos' });
    });

    it('anular: solo un cobro que creó el asistente y sigue pendiente', async () => {
        h.state.tablas.wa_cobros_desde_comprobante = [{ payment_id: 'pay-1' }];
        h.state.tablas.payments = [{ id: 'pay-1', status: 'pending' }, { id: 'pay-2', status: 'pending' }];
        expect(await anularCobroCreado('pay-2')).toBe(false);
        expect(await anularCobroCreado('pay-1')).toBe(true);
        expect(h.state.tablas.payments[0].status).toBe('cancelled');
        expect(h.state.tablas.payments[1].status).toBe('pending');
    });

    it('prospecto: sus cobros pendientes y el lead por teléfono', async () => {
        h.state.tablas.payments = [
            { id: 'p1', school_id: 's1', signup_lead_id: 'lead-1', status: 'pending', amount: 15000, concept: 'Clase de prueba — Mariana', payment_category: 'clase_prueba' },
            { id: 'p2', school_id: 's1', signup_lead_id: 'lead-1', status: 'paid', amount: 15000 },
        ];
        expect(await pendientesDelLead('s1', 'lead-1')).toEqual([
            { id: 'p1', amount: 15000, concept: 'Clase de prueba — Mariana', due_date: null, child_id: null, atleta: null, categoria: 'clase_prueba' },
        ]);
        h.state.tablas.school_signup_leads = [
            { id: 'lead-x', school_id: 's1', phone: '3194505150', status: 'discarded', full_name: 'Descartada' },
            { id: 'lead-1', school_id: 's1', phone: '3194505150', status: 'contacted', full_name: 'Mariana Ruiz' },
        ];
        expect(await leadPorTelefono('s1', '573194505150')).toEqual({ id: 'lead-1', nombre: 'Mariana Ruiz', status: 'contacted' });
        expect(await leadPorTelefono('s1', '573000000000')).toBeNull();
    });
});
