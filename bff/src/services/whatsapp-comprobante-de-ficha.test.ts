/**
 * Comprobantes que se escalaban por no saber de quién eran (Dynasty, 28-sep →
 * 08-oct: 43 de 188) y medios de pago sin /my-payments. Casos inventados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
    fichas: [] as any[],
    sinRegistrar: [] as any[],
    updates: [] as any[],
    rpcPagos: [] as any[],
    settings: null as any,
};

function makeChain(result: any, table?: string) {
    const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, or: () => chain, is: () => chain,
        ilike: () => chain, limit: () => chain, order: () => chain, gte: () => chain,
        update: (v: any) => { if (table === 'whatsapp_inbound_queue') state.updates.push(v); return chain; },
        maybeSingle: () => Promise.resolve(result),
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    };
    return chain;
}

vi.mock('../config/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            if (table === 'children') return makeChain({ data: state.fichas, error: null }, table);
            if (table === 'unregistered_athletes') return makeChain({ data: state.sinRegistrar, error: null }, table);
            if (table === 'school_settings') return makeChain({ data: state.settings ?? { payment_accounts: [], nequi_number: '3001112222' }, error: null }, table);
            return makeChain({ data: null, error: null }, table);
        }),
        rpc: vi.fn((name: string) => Promise.resolve(name === 'wa_get_payment_status'
            ? { data: state.rpcPagos, error: null } : { data: null, error: null })),
    },
}));

const aplicarComprobanteDeFichaMock = vi.fn((..._a: any[]) => Promise.resolve());
const resolverDeportistaDeLaFilaMock = vi.fn((..._a: any[]) => Promise.resolve());
vi.mock('../jobs/whatsapp-queue.job', () => ({
    aplicarComprobanteDeFicha: (...a: any[]) => aplicarComprobanteDeFichaMock(...a),
    resolverDeportistaDeLaFila: (...a: any[]) => resolverDeportistaDeLaFilaMock(...a),
}));

const conEnlacesDePagoMock = vi.fn();
vi.mock('./whatsapp-enlaces-de-pago.service', () => ({
    conEnlacesDePago: (...a: any[]) => conEnlacesDePagoMock(...a),
}));

const {
    candidatosPorNombre, botonesDeCobros, textoDeEleccion, resolverRespuestaDeDeportista,
    fichasPorTelefono, PREGUNTA_DEPORTISTA, fichaExactaPorNombre, deportistaPorNombreSinVerificar,
} = await import('./whatsapp-comprobante-de-ficha.service');
const { mediosDePago, mediosDePagoDeFamilia } = await import('./whatsapp-medios-de-pago.service');

const FICHAS = [
    { id: 'c-ana', nombre: 'Ana Lucía Torres Vega', tipo: 'child' as const },
    { id: 'c-ana2', nombre: 'Ana María Rojas Díaz', tipo: 'child' as const },
    { id: 'u-tomas', nombre: 'Tomás Quintero Lara', tipo: 'unregistered' as const },
];

beforeEach(() => {
    vi.clearAllMocks();
    state.fichas = [];
    state.sinRegistrar = [];
    state.updates = [];
    state.rpcPagos = [];
});

describe('candidatosPorNombre — (b) el deportista por nombre', () => {
    it('nombre y apellido → UNA ficha (sin tildes ni mayúsculas)', () => {
        expect(candidatosPorNombre(['es de ana lucia torres'], FICHAS).map((f) => f.id)).toEqual(['c-ana']);
        expect(candidatosPorNombre(['TOMAS QUINTERO'], FICHAS).map((f) => f.id)).toEqual(['u-tomas']);
    });

    it('solo el primer nombre no alcanza (media escuela se llama Ana)', () => {
        expect(candidatosPorNombre(['es de Ana'], FICHAS)).toEqual([]);
    });

    it('dos fichas igual de nombradas → las dos (el llamador no aplica)', () => {
        const gemelas = [...FICHAS, { id: 'c-ana3', nombre: 'Ana Lucía Torres Pinto', tipo: 'child' as const }];
        expect(candidatosPorNombre(['Ana Lucía Torres'], gemelas)).toHaveLength(2);
    });

    it('gana la que más palabras acierta', () => {
        const parecidas = [...FICHAS, { id: 'c-ana3', nombre: 'Ana Lucía Torres Pinto', tipo: 'child' as const }];
        expect(candidatosPorNombre(['Ana Lucía Torres Vega'], parecidas).map((f) => f.id)).toEqual(['c-ana']);
    });

    it('usa también el concepto y el nombre de quien paga que lee el comprobante', () => {
        expect(candidatosPorNombre([null, 'Mensualidad Tomas Quintero', 'Pedro Gómez'], FICHAS).map((f) => f.id))
            .toEqual(['u-tomas']);
    });
});

describe('botonesDeCobros — (c) varios cobros', () => {
    const OPC = [
        { id: 'p1', amount: 150000, concept: 'Mensualidad 09/2026', due_date: '2026-09-10', child_id: 'c1', atleta: 'Laura Peña' },
        { id: 'p2', amount: 150000, concept: 'Mensualidad 10/2026', due_date: '2026-10-10', child_id: 'c1', atleta: 'Laura Peña' },
    ];

    it('concepto + monto, numerados y ≤ 20 caracteres', () => {
        const b = botonesDeCobros(OPC);
        expect(b.map((x) => x.title)).toEqual(['1. Sep $150.000', '2. Oct $150.000']);
        expect(b.map((x) => x.id)).toEqual(['sm_cobro_1', 'sm_cobro_2']);
        for (const x of b) expect(x.title.length).toBeLessThanOrEqual(20);
        expect(b[0].descripcion).toContain('Mensualidad 09/2026');
    });

    it('de varios deportistas: con el primer nombre', () => {
        const b = botonesDeCobros([OPC[0], { ...OPC[1], child_id: 'c2', atleta: 'Martín Peña' }]);
        expect(b[1].title).toBe('2. Martín $150.000');
        for (const x of b) expect(x.title.length).toBeLessThanOrEqual(20);
    });

    it('el botón tocado vale por su número, no por el monto del título', () => {
        expect(textoDeEleccion('sm_cobro_2', '2. Oct $15.000')).toBe('2');
        expect(textoDeEleccion(null, 'el de octubre')).toBe('el de octubre');
        expect(textoDeEleccion('otro_boton', 'hola')).toBe('hola');
    });
});

describe('fichasPorTelefono — (a) familia sin cuenta', () => {
    it('cruza por los últimos 10 dígitos del celular de la ficha', async () => {
        state.fichas = [{ id: 'c1', parent_phone_temp: '+57 300 555 0101' }, { id: 'c2', parent_phone_temp: '3009990000' }];
        state.sinRegistrar = [{ id: 'u1', guardian_phone: '573005550101', phone: null }];
        expect(await fichasPorTelefono('school-1', '573005550101')).toEqual({ childIds: ['c1'], unregisteredIds: ['u1'] });
    });

    it('un fijo no se cruza', async () => {
        expect(await fichasPorTelefono('school-1', '6012345678')).toEqual({ childIds: [], unregisteredIds: [] });
    });
});

describe('resolverRespuestaDeDeportista — la respuesta a la pregunta', () => {
    const responder = vi.fn((..._a: any[]) => Promise.resolve());

    it('la decide la cola (un solo lugar): botón solo de deportistas del número; nombre escrito sin verificar, solo completo', async () => {
        expect(await resolverRespuestaDeDeportista({ id: 'q1', school_id: 'school-1' }, 'Ana Lucía Torres', responder)).toBe(true);
        expect(resolverDeportistaDeLaFilaMock).toHaveBeenCalledWith('q1', 'Ana Lucía Torres', responder);
        expect(aplicarComprobanteDeFichaMock).not.toHaveBeenCalled();
        expect(responder).not.toHaveBeenCalled();
    });

    it('la pregunta es corta y pide el nombre completo', () => {
        expect(PREGUNTA_DEPORTISTA).toContain('¿De qué deportista es este pago? Escríbeme su nombre completo');
        expect(PREGUNTA_DEPORTISTA.length).toBeLessThan(120);
    });
});

describe('medios de pago — nunca /my-payments', () => {
    it('sin link de la escuela, enlace_para_pagar es null', async () => {
        const m = await mediosDePago('school-1');
        expect(m.enlace_para_pagar).toBeNull();
        expect(JSON.stringify(m)).not.toContain('my-payments');
    });

    it('familia identificada con cobros: cada uno con su /p/:token', async () => {
        state.rpcPagos = [{ concept: 'Mensualidad 10/2026', amount: 150000, due_date: '2026-10-10', debe_pagarse: true }];
        conEnlacesDePagoMock.mockImplementation(async (pagos: any[]) =>
            pagos.map((p) => ({ ...p, enlace_pago: 'https://app.sportmaps.co/p/tok-ejemplo' })));
        const m = await mediosDePagoDeFamilia('school-1', 'parent-1', { integrationId: 'int-1', waPhone: '573000000000' });
        expect(m.cobros_pendientes).toEqual([{
            concepto: 'Mensualidad 10/2026', monto: 150000, vence: '2026-10-10',
            enlace_pago: 'https://app.sportmaps.co/p/tok-ejemplo',
        }]);
        expect(conEnlacesDePagoMock).toHaveBeenCalledWith(state.rpcPagos, 'parent-1', 'school-1',
            { integrationId: 'int-1', waPhone: '573000000000' });
        expect(JSON.stringify(m)).not.toContain('my-payments');
    });

    it('sin familia identificada: solo los medios, sin cobros', async () => {
        const m = await mediosDePagoDeFamilia('school-1', null);
        expect(m.cobros_pendientes).toEqual([]);
        expect(conEnlacesDePagoMock).not.toHaveBeenCalled();
    });
});

// ─── Monster 2026-11-05 (Ethann, bd8a1532): el nombre COMPLETO manda ─────────────

describe('fichaExactaPorNombre / candidatosPorNombre — Ethann y Laura Sofía', () => {
    const LAURA = { id: 'u-laura', nombre: 'Laura Sofía Pedraza Sanchez', tipo: 'unregistered' as const };
    const ETHANN = { id: 'c-ethann', nombre: 'Ethann Matías Pedraza Pinto', tipo: 'child' as const };

    it('«DEPORTISTA :\nETHANN MATIAS PEDRAZA PINTO» (mayúsculas, sin tildes, con prefijo) = Ethann exacto', () => {
        expect(fichaExactaPorNombre(['DEPORTISTA :\nETHANN MATIAS PEDRAZA PINTO'], [LAURA, ETHANN])).toEqual(ETHANN);
        expect(candidatosPorNombre(['DEPORTISTA :\nETHANN MATIAS PEDRAZA PINTO'], [LAURA, ETHANN])).toEqual([ETHANN]);
    });

    it('«Envío el comprobante de pago de Ethann Pedraza» NO es exacto (2 de 4 palabras); y el apellido solo nunca señala a Laura', () => {
        expect(fichaExactaPorNombre(['Envío el comprobante de pago de Ethann Pedraza.'], [LAURA, ETHANN])).toBeNull();
        expect(fichaExactaPorNombre(['Envío el comprobante de pago de Ethann Pedraza.'], [LAURA])).toBeNull();
        expect(candidatosPorNombre(['Envío el comprobante de pago de Ethann Pedraza.'], [LAURA])).toEqual([]);
    });

    it('empate entre parciales: el nombre completo escrito tal cual gana sobre el que solo comparte palabras', () => {
        const corta = { id: 'c-1', nombre: 'Ana María Gómez', tipo: 'child' as const };
        const larga = { id: 'c-2', nombre: 'Ana María Gómez Ruiz', tipo: 'child' as const };
        expect(candidatosPorNombre(['pago de ana maria gomez'], [corta, larga])).toEqual([corta]);
        expect(fichaExactaPorNombre(['pago de ana maria gomez'], [corta, larga])).toEqual(corta);
        // Escrito el largo, gana el largo (contiene al corto).
        expect(fichaExactaPorNombre(['Ana María Gómez Ruiz'], [corta, larga])).toEqual(larga);
        // Las partículas no cuentan: «María de los Ángeles Ruiz» escrito sin «de los».
        expect(fichaExactaPorNombre(['maria angeles ruiz'], [{ id: 'c-3', nombre: 'María de los Ángeles Ruiz', tipo: 'child' as const }]))
            .toMatchObject({ id: 'c-3' });
    });

    it('deportistaPorNombreSinVerificar: la exacta si la hay; si no, la parecida SOLO para la propuesta', async () => {
        state.fichas = [{ id: 'c-ethann', full_name: 'Ethann Matías Pedraza Pinto' }];
        state.sinRegistrar = [{ id: 'u-laura', full_name: 'Laura Sofía Pedraza Sanchez' }];
        expect(await deportistaPorNombreSinVerificar('school-1', ['ETHANN MATIAS PEDRAZA PINTO']))
            .toEqual({ exacta: { id: 'c-ethann', nombre: 'Ethann Matías Pedraza Pinto', tipo: 'child' }, parecida: null });
        expect(await deportistaPorNombreSinVerificar('school-1', ['de Ethann Pedraza']))
            .toEqual({ exacta: null, parecida: { id: 'c-ethann', nombre: 'Ethann Matías Pedraza Pinto', tipo: 'child' } });
        expect(await deportistaPorNombreSinVerificar('school-1', ['Pedraza'])).toEqual({ exacta: null, parecida: null });
    });
});

describe('medios de pago — Nequi y Daviplata al MISMO número (Monster 2026-11-08)', () => {
    it('salen los dos medios (antes la Daviplata se perdía por tener el mismo número)', async () => {
        state.settings = {
            nequi_number: '3194505150', bank_titular_name: 'Iván Sossa',
            payment_accounts: [
                { id: 'a1', type: 'nequi', label: 'Nequi', value: '3194505150', active: true },
                { id: 'a2', type: 'daviplata', label: 'Daviplata', value: '3194505150', active: true },
            ],
        };
        const m = await mediosDePago('school-1');
        expect(m.cuentas).toEqual([
            { tipo: 'Nequi', titular: 'Iván Sossa', numero: '3194505150' },
            { tipo: 'Daviplata', titular: 'Iván Sossa', numero: '3194505150' },
        ]);
        state.settings = null;
    });

    it('la columna suelta del store viejo no repite la cuenta; una cuenta inactiva no sale', async () => {
        state.settings = {
            nequi_number: '3001112222', bank_account_number: '123-456', bank_name: 'Bancolombia',
            payment_accounts: [
                { id: 'a1', type: 'nequi', label: 'Nequi', value: '3001112222', active: true },
                { id: 'a2', type: 'bancolombia', label: 'Ahorros', value: '123-456', active: true },
                { id: 'a3', type: 'daviplata', label: 'Daviplata', value: '3001112222', active: false },
            ],
        };
        const m = await mediosDePago('school-1');
        expect(m.cuentas.map((c) => c.numero)).toEqual(['3001112222', '123-456']);
        state.settings = null;
    });
});
