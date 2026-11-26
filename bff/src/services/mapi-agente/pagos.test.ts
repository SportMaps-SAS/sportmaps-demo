/**
 * Herramientas de pagos de Mapi (plan §20.3, §20.4 y §21): solo administración,
 * alcance de escuela, niveles calculados por el servidor, propuesta de la
 * auditoría, datos mínimos (sin teléfonos ni cuentas completas) y la glosa por
 * borrador → Confirmar con el mismo servicio de glosas.routes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    responder: (_c: any): any => undefined,
    ctx: {} as any,
    duplicados: new Set<string>(),
    lectores: ['gemini', 'claude'] as string[],
    createGlosa: vi.fn(),
    correoGlosa: vi.fn(),
    seguimiento: vi.fn(),
    catalogo: vi.fn(),
    notas: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultasPagos = falso.consultas;
    // Las _por de plata (rpc-por.ts) van por supabase.rpc con service_role.
    (falso.supabase as any).rpc = (nombre: string, params: unknown) => h.rpc(nombre, params);
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('../receipt-context.service', () => ({ buildVerdictContext: vi.fn(async () => h.ctx) }));
vi.mock('../duplicatePayerGuard.service', () => ({ findDuplicatePaymentIds: vi.fn(async () => h.duplicados) }));
vi.mock('../ocr.service', () => ({ listConfiguredProviders: () => h.lectores }));
vi.mock('../glosa.service', () => {
    class GlosaRpcError extends Error {
        code?: string;
        constructor(m: string, c?: string) { super(m); this.code = c; }
    }
    return { createGlosa: h.createGlosa, sendGlosaCreatedEmail: h.correoGlosa, GlosaRpcError };
});
vi.mock('../../routes/whatsapp-admin.routes', () => ({ notasDeComprobantes: h.notas }));
vi.mock('../whatsapp-seguimiento-conversaciones.service', async (orig) => ({
    ...(await orig<typeof import('../whatsapp-seguimiento-conversaciones.service')>()),
    seguimientoDeConversaciones: h.seguimiento,
}));
vi.mock('../ventas-servicios.service', async (orig) => ({
    ...(await orig<typeof import('../ventas-servicios.service')>()),
    catalogoServicios: h.catalogo,
}));

import {
    HERRAMIENTAS_PAGOS, pagosPorValidar, porQueNoSeAprobo, seguimientoWhatsapp, auditarPendientes,
    estadoAprobacionAutomatica, ventasDeServicio, pedirAclaracion, accionesDePagosPrendidas,
    proponer, destinoDe, motivoEnPalabras, textoSeguro, asistenteDelConcepto, terminaEn,
    aprobarPago, aprobarVerdes, registrarPagoEfectivo, plataPrendida, faltaNivel2, llaveDePlata,
} from './herramientas/pagos';
import { GlosaRpcError } from '../glosa.service';
import { eqDe, type Consulta } from './supabase-falso.test-helper';
import type { FilaSeguimiento } from '../whatsapp-seguimiento-conversaciones.service';
import type { Alcance, HerramientaAccion, HerramientaConsulta } from './tipos';

const consultas = () => (globalThis as any).__consultasPagos as Consulta[];

const ESCUELA = '11111111-1111-1111-1111-111111111111';
const OTRA = '99999999-9999-4999-8999-999999999999';
const B1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const B2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const ITEM = 'cccccccc-0000-4000-8000-000000000001';
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hace = (horas: number) => new Date(Date.now() - horas * 3600_000).toISOString();

const admin: Alcance = {
    schoolId: ESCUELA, userId: 'u-admin', rol: 'admin', teamIds: [],
    ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false }, hoy: '2026-11-24',
};
const coach: Alcance = { ...admin, rol: 'coach', userId: 'u-coach', teamIds: ['eq'] };

const base = {
    school_id: ESCUELA, status: 'awaiting_approval', amount: 145000, amount_paid: 0, early_payment_discount_applied: 0,
    payment_category: 'mensualidad', requires_review: false, period_year: 2026, period_month: 11, user_id: null,
    unregistered_athlete_id: null, parent_id: 'p1', due_date: '2026-11-05', branch_id: null, approved_by: null,
    // Paso 4: el lote solo toma verdes sellados por el servidor y con monto del servidor.
    receipt_image_sha256_source: 'server_verified', amount_source: 'servidor',
};
/** Verde, completo: nivel 2. */
const P1 = { ...base, id: id(1), concept: 'Mensualidad noviembre', child_id: 'c1', receipt_url: 'r1', receipt_verdict: 'verde', receipt_verdict_reasons: [], ocr_amount: 145000, ocr_destination: '300 123 4567', receipt_submitted_at: hace(50), branch_id: B1 };
/** Amarillo solo por monto, menor: abono. Sin sede. */
const P2 = { ...base, id: id(2), concept: 'Mensualidad noviembre', child_id: 'c2', receipt_url: 'r2', receipt_verdict: 'amarillo', receipt_verdict_reasons: [{ code: 'MONTO_DIFIERE', level: 'amarillo', detail: { expected: 145000, extracted: 100000 } }], ocr_amount: 100000, ocr_destination: '3001234567', receipt_submitted_at: hace(5) };
/** Rojo por referencia repetida: no aprobar. */
const P3 = { ...base, id: id(3), concept: 'Torneo regional', payment_category: 'torneo', amount: 120000, child_id: null, unregistered_athlete_id: 'u1', receipt_url: 'r3', receipt_verdict: 'rojo', receipt_verdict_reasons: [{ code: 'REFERENCIA_DUPLICADA', level: 'rojo' }], ocr_amount: 120000, ocr_destination: '3001234567', receipt_submitted_at: hace(30), branch_id: B2 };
/** Verde con abono previo: se revisa a mano. Adulto. */
const P4 = { ...base, id: id(4), concept: 'Mensualidad noviembre', child_id: null, parent_id: null, user_id: 'a1', amount_paid: 45000, receipt_url: 'r4', receipt_verdict: 'verde', receipt_verdict_reasons: [], ocr_amount: 100000, ocr_destination: '3001234567', receipt_submitted_at: hace(2), branch_id: B1 };

let pagos: any[] = [];
let glosas: any[] = [];
let ajustes: any = {};

const enLista = (c: Consulta, col: string) => c.filtros.find(([t, k]) => t === 'in' && k === col)?.[2] as any[] | undefined;

function responderBase(c: Consulta): any {
    const esc = eqDe(c, 'school_id');
    if (c.tabla === 'payments') {
        let filas = pagos.filter((p) => !esc || p.school_id === esc);
        const uno = eqDe(c, 'id');
        if (uno) filas = filas.filter((p) => p.id === uno);
        const ids = enLista(c, 'id');
        if (ids) filas = filas.filter((p) => ids.includes(p.id));
        const estado = eqDe(c, 'status');
        if (estado) filas = filas.filter((p) => p.status === estado);
        const estados = enLista(c, 'status');
        if (estados) filas = filas.filter((p) => estados.includes(p.status));
        const recibo = eqDe(c, 'receipt_url');
        if (recibo) filas = filas.filter((p) => p.receipt_url === recibo);
        return { data: filas };
    }
    if (c.tabla === 'children') return { data: [{ id: 'c1', full_name: 'Mariana López' }, { id: 'c2', full_name: 'Sofía Ruiz' }] };
    if (c.tabla === 'unregistered_athletes') return { data: [{ id: 'u1', full_name: 'Tomás Gil' }] };
    if (c.tabla === 'profiles') {
        return String(c.columnas).includes('email')
            ? { data: [{ id: 'u-owner', email: 'dueno@club.co', is_demo: false }] }
            : { data: [{ id: 'a1', full_name: 'Carlos Ruiz' }] };
    }
    if (c.tabla === 'school_settings') return { data: [ajustes] };
    if (c.tabla === 'school_branches') return { data: [{ id: B1, name: 'Sede Norte' }, { id: B2, name: 'Sede Sur' }] };
    if (c.tabla === 'payment_glosas') return { data: glosas };
    if (c.tabla === 'schools') return { data: [{ id: ESCUELA, owner_id: 'u-owner' }] };
    if (c.tabla === 'school_members') return { data: [] };
    return undefined;
}

beforeEach(() => {
    process.env.LOTE_VERDES_ACTIVO = 'true'; // reglas del lote; la pausa por defecto se prueba en pagos-por-validar.job.test.ts
    consultas().length = 0;
    pagos = [P1, P2, P3, P4];
    glosas = [];
    ajustes = { auto_approve_enabled: false, auto_approve_max_amount: 0, glosa_response_days: 5, payment_accounts: [{ type: 'nequi', label: 'Nequi del club', value: '3001234567' }] };
    h.ctx = { registeredAccounts: ['3001234567'], restrictedAccounts: [], cuentasFueraDeSportmaps: [] };
    h.duplicados = new Set();
    h.lectores = ['gemini', 'claude'];
    h.createGlosa.mockReset().mockResolvedValue('glosa-1');
    h.correoGlosa.mockReset().mockResolvedValue(undefined);
    h.notas.mockReset().mockResolvedValue({});
    h.seguimiento.mockReset();
    h.catalogo.mockReset();
    h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
    h.responder = responderBase;
});

afterEach(() => { delete process.env.MAPI_PAGOS_ACCIONES; delete process.env.MAPI_PLATA_POR; });

// ─── Permisos y esquemas ────────────────────────────────────────────────────

describe('permisos', () => {
    it('todas son solo de administración y el coach se rechaza adentro', async () => {
        expect(HERRAMIENTAS_PAGOS).toHaveLength(10);
        for (const t of HERRAMIENTAS_PAGOS) {
            expect(t.roles, t.nombre).toEqual(['admin']);
            if (t.tipo === 'consulta') {
                await expect((t as HerramientaConsulta).ejecutar(coach, t.validar({ pago: P1.id, sede: null, tipo: null, dias: null, item: null }) as any), t.nombre)
                    .rejects.toThrow(/administración/);
            } else {
                await expect((t as HerramientaAccion).preparar(coach, { pago: P2.id, motivo: 'OTRO' }), t.nombre).rejects.toThrow(/administración/);
                await expect((t as HerramientaAccion).ejecutar(coach, { pago: P2.id, motivo: 'OTRO' }), t.nombre).rejects.toThrow(/administración/);
            }
        }
        expect(h.createGlosa).not.toHaveBeenCalled();
    });

    it('la acción nace apagada: solo con MAPI_PAGOS_ACCIONES=true y nunca para el coach', () => {
        expect(pedirAclaracion.habilitada!(admin)).toBe(false);
        process.env.MAPI_PAGOS_ACCIONES = 'true';
        expect(accionesDePagosPrendidas(admin)).toBe(true);
        expect(pedirAclaracion.habilitada!(coach)).toBe(false);
        expect(HERRAMIENTAS_PAGOS.filter((t) => t.tipo === 'consulta').every((t) => !t.habilitada)).toBe(true);
    });

    it('esquemas strict: sin propiedades extra, todo en required y sin parámetro de escuela', () => {
        for (const t of HERRAMIENTAS_PAGOS) {
            expect(t.esquema.additionalProperties, t.nombre).toBe(false);
            expect([...t.esquema.required].sort(), t.nombre).toEqual(Object.keys(t.esquema.properties).sort());
            expect(Object.keys(t.esquema.properties).some((k) => /escuela|school/i.test(k)), t.nombre).toBe(false);
            expect(t.descripcion.length, t.nombre).toBeLessThan(400);
        }
    });

    it('validar acepta null en los opcionales y rechaza basura', () => {
        expect(pagosPorValidar.validar({ sede: null, tipo: null })).toEqual({});
        expect(pagosPorValidar.validar({ sede: 'Norte', tipo: 'torneo' })).toEqual({ sede: 'Norte', tipo: 'torneo' });
        expect(() => pagosPorValidar.validar({ sede: null, tipo: 'cualquiera' })).toThrow();
        expect(seguimientoWhatsapp.validar({ dias: null })).toEqual({});
        expect(() => seguimientoWhatsapp.validar({ dias: 90 })).toThrow();
        expect(() => pedirAclaracion.validar({ pago: P1.id, motivo: 'RECHAZAR' })).toThrow(/motivo/);
    });
});

// ─── Piezas puras ───────────────────────────────────────────────────────────

describe('piezas puras', () => {
    it('textoSeguro quita teléfonos y cuentas, pero no montos', () => {
        expect(textoSeguro('escríbame al 300 123 4567 ya pagué $1.200.000')).toBe('escríbame al [número] ya pagué $1.200.000');
        expect(textoSeguro('+57 319-450-5150')).toBe('[número]');
        expect(textoSeguro('a'.repeat(200), 20)).toHaveLength(20);
        expect(terminaEn('3109998877')).toBe('8877');
        expect(asistenteDelConcepto('Clínica de armadores — Juan Pérez')).toBe('Juan Pérez');
        expect(asistenteDelConcepto('Mensualidad noviembre')).toBeNull();
    });

    it('motivoEnPalabras dice lo que no cuadra sin regalar las cuentas de la escuela', () => {
        expect(motivoEnPalabras({ code: 'MONTO_DIFIERE', detail: { expected: 145000, extracted: 140000 } }))
            .toBe('El comprobante dice $140.000 y el cobro es de $145.000: puede ser un abono.');
        const destino = motivoEnPalabras({ code: 'DESTINO_NO_COINCIDE', level: 'rojo', detail: { destination: '3109998877', comparedAgainst: ['3001234567'] } });
        expect(destino).toBe('Fue a una cuenta que no está registrada por la escuela (termina en 8877).');
        expect(destino).not.toContain('3001234567');
        expect(motivoEnPalabras({ code: 'REFERENCIA_DUPLICADA' })).toMatch(/ya lo habían mandado/i);
        expect(motivoEnPalabras({ code: 'CAMPOS_ILEGIBLES', detail: { missing: ['amount', 'reference'] } })).toBe('No se lee bien el monto, la referencia.');
        expect(motivoEnPalabras({ code: 'POSIBLE_MANIPULACION', detail: { senales: ['orden_de_aprobar@raw_text'] } })).not.toMatch(/orden_de_aprobar/);
    });

    it('destinoDe usa las cuentas de hoy de la escuela', () => {
        const ctx = { registeredAccounts: ['3001234567', '478170006942'], restrictedAccounts: [{ value: '3155550000', onlyFor: ['inscripcion'] as any }], cuentasFueraDeSportmaps: ['3166660000'] };
        expect(destinoDe('300 123 4567', ctx)).toBe('exacta');
        expect(destinoDe('**** 6942', ctx)).toBe('mascara');
        expect(destinoDe('3155550000', ctx)).toBe('otro_concepto');
        expect(destinoDe('3166660000', ctx)).toBe('fuera_de_sportmaps');
        expect(destinoDe('3109998877', ctx)).toBe('ajena');
        expect(destinoDe(null, ctx)).toBe('sin_leer');
        expect(destinoDe('3001234567', {})).toBe('sin_cuentas');
    });

    it('proponer rotula lo que ya dicen el veredicto, la regla de los verdes y los duplicados', () => {
        const e = { veredicto: 'verde', motivos: [], destino: 'exacta' as const, exclusionVerde: null, duplicado: false, saldo: 145000, comprobante: 145000 };
        expect(proponer(e).propuesta).toBe('completo');
        expect(proponer({ ...e, destino: 'sin_cuentas' }).propuesta).toBe('revisar');
        expect(proponer({ ...e, duplicado: true }).propuesta).toBe('revisar');
        expect(proponer({ ...e, exclusionVerde: 'tiene abonos previos' })).toEqual({ propuesta: 'revisar', porque: ['Está en verde, pero tiene abonos previos.'] });
        const monto = [{ code: 'MONTO_DIFIERE', level: 'amarillo' }];
        expect(proponer({ ...e, veredicto: 'amarillo', motivos: monto, exclusionVerde: 'no está en verde', comprobante: 100000 }))
            .toEqual({ propuesta: 'abono', porque: ['Pagó $100.000 de $145.000: se aprueba lo pagado y queda un saldo de $45.000.'] });
        // Pagó DE MÁS: no es abono.
        expect(proponer({ ...e, veredicto: 'amarillo', motivos: monto, exclusionVerde: 'no está en verde', comprobante: 150000 }).propuesta).toBe('revisar');
        expect(proponer({ ...e, veredicto: 'rojo', motivos: [{ code: 'IMAGEN_DUPLICADA', level: 'rojo' }] }).propuesta).toBe('no aprobar');
        expect(proponer({ ...e, destino: 'ajena' }).propuesta).toBe('no aprobar');
        // Rojo por cuenta, pero la escuela ya la registró: se revisa, no se rechaza.
        expect(proponer({ ...e, veredicto: 'rojo', motivos: [{ code: 'DESTINO_NO_COINCIDE', level: 'rojo' }], destino: 'exacta' }).propuesta).toBe('revisar');
        expect(proponer({ ...e, veredicto: 'amarillo', motivos: [{ code: 'POSIBLE_MANIPULACION', level: 'amarillo' }] }).propuesta).toBe('revisar');
    });
});

// ─── pagos_por_validar ──────────────────────────────────────────────────────

describe('pagos_por_validar', () => {
    it('todas las sedes: total, suma, nivel 2 calculado por el servidor y lista ordenada como la pantalla', async () => {
        const r: any = await pagosPorValidar.ejecutar(admin, {});
        expect(r).toMatchObject({ filtro: 'todas las sedes', por_validar: 4, suman: '$510.000', nivel_2: 1, en_verde: 2, mas_de_24_horas: 2 });
        expect(r.verdes_que_se_revisan_a_mano).toEqual({ 'tiene abonos previos': 1 });
        expect(r.lista.map((x: any) => x.pago)).toEqual([P1.id, P4.id, P2.id, P3.id]);
        expect(r.lista[0]).toMatchObject({ deportista: 'Mariana López', cobro: '$145.000', comprobante: '$145.000', nivel: 2 });
        expect(r.lista[0].revisar_por).toBeUndefined();
        expect(r.lista[1]).toMatchObject({ deportista: 'Carlos Ruiz', cobro: '$100.000', nivel: 3, revisar_por: 'tiene abonos previos' });
        expect(r.lista[2]).toMatchObject({ deportista: 'Sofía Ruiz', nivel: 3, revisar_por: 'monto distinto' });
        expect(r.lista[3]).toMatchObject({ deportista: 'Tomás Gil', nivel: 3, revisar_por: 'referencia repetida' });
        expect(r.por_tipo.map((t: any) => t.tipo)).toEqual(['Mensualidad', 'Torneo']);
        // Toda lectura de pagos va filtrada por la escuela de la sesión.
        for (const c of consultas().filter((x) => x.tabla === 'payments' && !enLista(x, 'child_id'))) expect(eqDe(c, 'school_id')).toBe(ESCUELA);
        expect(consultas().some((c) => c.op !== 'select')).toBe(false);
        expect(JSON.stringify(r)).not.toMatch(/3001234567/);
    });

    it('con una sede: los de esa sede y los sin sede (como la pantalla)', async () => {
        const r: any = await pagosPorValidar.ejecutar(admin, { sede: 'sede norte' });
        expect(r.filtro).toBe('sede Sede Norte (incluye los cobros sin sede)');
        expect(r.lista.map((x: any) => x.pago).sort()).toEqual([P1.id, P2.id, P4.id].sort());
    });

    it('por tipo, y una sede que no existe se explica', async () => {
        const r: any = await pagosPorValidar.ejecutar(admin, { tipo: 'torneo' });
        expect(r.por_validar).toBe(1);
        expect(r.lista[0].pago).toBe(P3.id);
        await expect(pagosPorValidar.ejecutar(admin, { sede: 'Centro' })).rejects.toThrow(/Sede Norte, Sede Sur/);
    });

    it('una escuela sin pendientes', async () => {
        pagos = [];
        expect(await pagosPorValidar.ejecutar(admin, {})).toMatchObject({ por_validar: 0 });
    });
});

// ─── por_que_no_se_aprobo ───────────────────────────────────────────────────

describe('por_que_no_se_aprobo', () => {
    it('el motivo en palabras, el nivel y por qué no se aprobó solo', async () => {
        const r: any = await porQueNoSeAprobo.ejecutar(admin, { pago: P2.id });
        expect(r).toMatchObject({ deportista: 'Sofía Ruiz', estado: 'por validar', cobro: '$145.000', comprobante: '$100.000', veredicto: 'dudoso', nivel: 3 });
        expect(r.motivos).toEqual(['El comprobante dice $100.000 y el cobro es de $145.000: puede ser un abono.']);
        expect(r.aprobacion_automatica).toMatch(/apagada/);
    });

    it('un verde que no entra en los verdes de un clic dice por qué', async () => {
        const r: any = await porQueNoSeAprobo.ejecutar(admin, { pago: P4.id });
        expect(r.motivos).toEqual(['Está en verde, pero tiene abonos previos.']);
        expect(r.nivel).toBe(3);
    });

    it('Paso 4: lee el sello del servidor y el origen del monto, y un verde sellado no sale como «lectura no la hizo el servidor»', async () => {
        const r: any = await porQueNoSeAprobo.ejecutar(admin, { pago: P1.id });
        const leida = consultas().find((c) => c.tabla === 'payments' && eqDe(c, 'id') === P1.id);
        expect(String(leida?.columnas)).toMatch(/receipt_image_sha256_source/);
        expect(String(leida?.columnas)).toMatch(/amount_source/);
        expect(r.nivel).toBe(2);
        expect(JSON.stringify(r)).not.toMatch(/la lectura no la hizo el servidor/);
    });

    it('Paso 4: un verde sin sello del servidor, o con monto del navegador, dice por qué', async () => {
        pagos.push({ ...P1, id: id(7), receipt_url: 'r7', receipt_image_sha256_source: 'client' });
        pagos.push({ ...P1, id: id(8), receipt_url: 'r8', amount_source: 'cliente' });
        const sinSello: any = await porQueNoSeAprobo.ejecutar(admin, { pago: id(7) });
        expect(sinSello.nivel).toBe(3);
        expect(sinSello.motivos).toEqual(['Está en verde, pero la lectura no la hizo el servidor.']);
        const delNavegador: any = await porQueNoSeAprobo.ejecutar(admin, { pago: id(8) });
        expect(delNavegador.nivel).toBe(3);
        expect(delNavegador.motivos[0]).toMatch(/^Está en verde, pero /);
        expect(delNavegador.motivos[0]).not.toMatch(/lectura no la hizo el servidor/);
    });

    it('nunca devuelve la cuenta completa ni contra qué se comparó', async () => {
        pagos.push({ ...P2, id: id(6), receipt_url: 'r6', receipt_verdict: 'rojo', receipt_verdict_reasons: [{ code: 'DESTINO_NO_COINCIDE', level: 'rojo', detail: { destination: '3109998877', comparedAgainst: ['3001234567'] } }] });
        const r: any = await porQueNoSeAprobo.ejecutar(admin, { pago: id(6) });
        expect(r.motivos[0]).toContain('termina en 8877');
        expect(JSON.stringify(r)).not.toMatch(/3109998877|3001234567/);
    });

    it('un pago de otra escuela no existe para esta', async () => {
        pagos.push({ ...P1, id: id(9), school_id: OTRA });
        await expect(porQueNoSeAprobo.ejecutar(admin, { pago: id(9) })).rejects.toThrow(/No encontré ese pago/);
        await expect(porQueNoSeAprobo.ejecutar(admin, { pago: 'no-es-un-id' })).rejects.toThrow(/no es válido/);
    });
});

// ─── auditar_pendientes ─────────────────────────────────────────────────────

describe('auditar_pendientes', () => {
    it('propone completo, abono, revisar y no aprobar, con el porqué y sin teléfonos', async () => {
        h.notas.mockResolvedValue({ [P2.id]: { pie: 'abono de noviembre, el resto el 30. Cel 3001234567', recibido_at: null } });
        const r: any = await auditarPendientes.ejecutar(admin, {});
        expect(r.por_validar).toBe(4);
        expect(r.propuestas).toEqual({
            completo: { cantidad: 1, suman: '$145.000' },
            abono: { cantidad: 1, suman: '$100.000' },
            revisar: { cantidad: 1, suman: '$100.000' },
            'no aprobar': { cantidad: 1, suman: '$120.000' },
        });
        expect(r.lista.map((x: any) => [x.deportista, x.propuesta])).toEqual([
            ['Mariana López', 'completo'], ['Sofía Ruiz', 'abono'], ['Carlos Ruiz', 'revisar'], ['Tomás Gil', 'no aprobar'],
        ]);
        expect(r.lista[1].por_que[0]).toBe('Pagó $100.000 de $145.000: se aprueba lo pagado y queda un saldo de $45.000.');
        expect(r.lista[1].la_familia_escribio).toBe('abono de noviembre, el resto el 30. Cel [número]');
        expect(r.lista[3].por_que[0]).toMatch(/ya lo habían mandado/i);
        expect(h.notas).toHaveBeenCalledWith(ESCUELA, expect.arrayContaining([P1.id, P2.id]));
        expect(consultas().some((c) => c.op !== 'select')).toBe(false);
        expect(JSON.stringify(r)).not.toMatch(/3001234567/);
    });

    it('Paso 4: un verde que no selló el servidor, o con monto del navegador, no se propone completo', async () => {
        pagos = [{ ...P1, receipt_image_sha256_source: 'client_original' }, { ...P1, id: id(7), receipt_url: 'r7', child_id: 'c2', amount_source: 'cliente' }];
        const r: any = await auditarPendientes.ejecutar(admin, {});
        const de = (pid: string) => r.lista.find((x: any) => x.pago === pid);
        expect(de(P1.id)).toMatchObject({ propuesta: 'revisar', por_que: ['Está en verde, pero la lectura no la hizo el servidor.'] });
        expect(de(id(7))).toMatchObject({ propuesta: 'revisar', por_que: ['Está en verde, pero el monto lo eligió el navegador.'] });
    });

    it('un duplicado o una cuenta que hoy no es de la escuela cambian la propuesta', async () => {
        h.duplicados = new Set([P1.id]);
        h.ctx = { registeredAccounts: ['3119990000'], restrictedAccounts: [], cuentasFueraDeSportmaps: [] };
        const r: any = await auditarPendientes.ejecutar(admin, {});
        const de = (pid: string) => r.lista.find((x: any) => x.pago === pid);
        expect(de(P1.id).propuesta).toBe('no aprobar');
        expect(de(P2.id).propuesta).toBe('no aprobar');
        h.ctx = { registeredAccounts: ['3001234567'], restrictedAccounts: [], cuentasFueraDeSportmaps: [] };
        const r2: any = await auditarPendientes.ejecutar(admin, {});
        expect(r2.lista.find((x: any) => x.pago === P1.id)).toMatchObject({ propuesta: 'revisar', por_que: [expect.stringMatching(/ya figura pagado/)] });
    });

    it('si la cola de WhatsApp no se lee, la auditoría sigue', async () => {
        h.notas.mockRejectedValue(new Error('caída'));
        const r: any = await auditarPendientes.ejecutar(admin, {});
        expect(r.por_validar).toBe(4);
    });
});

// ─── seguimiento_whatsapp ───────────────────────────────────────────────────

function fila(o: Partial<FilaSeguimiento> = {}): FilaSeguimiento {
    return {
        conversacionId: 'conv', contacto: { nombre: 'Ana', telefono: '573001234567' }, tipoContacto: null,
        tema: { tipo: 'familia', servicioId: null, nombre: 'Familia' },
        primerMensaje: { fecha: hace(5), texto: 'hola' }, ultimoMensaje: { fecha: hace(3), de: 'persona', texto: 'hola' },
        mensajes: { persona: 1, escuela: 0, bot: 0 }, respondioEscuela: false, respondioBot: false,
        esperandoDesde: null, esperandoMin: null, datosDePagoEnviados: false, comprobanteRecibido: false, comprobantes: 0,
        comprobanteEstado: null, cobro: null, pendientesEscuela: [], alerta: false, tomada: false, ...o,
    };
}

describe('seguimiento_whatsapp', () => {
    it('quién escribió, quién respondió y quién espera, sin teléfonos', async () => {
        h.seguimiento.mockResolvedValue({
            filas: [
                fila({ contacto: { nombre: 'Ana', telefono: '573001234567' }, esperandoDesde: hace(3), esperandoMin: 180, alerta: true, respondioBot: true,
                    pendientesEscuela: [{ texto: '¿puedo pagar en dos cuotas? mi cel 3001234567', desde: hace(3) }] }),
                fila({ contacto: { nombre: null, telefono: '573009998877' }, respondioEscuela: true }),
            ],
            servicios: [], avisos: [],
        });
        const r: any = await seguimientoWhatsapp.ejecutar(admin, { dias: 7 });
        const [, rango] = h.seguimiento.mock.calls[0];
        expect(h.seguimiento.mock.calls[0][0]).toBe(ESCUELA);
        expect(rango).toMatchObject({ desde: '2026-11-18', hasta: '2026-11-24' });
        expect(r.resumen).toMatchObject({ escribieron: 2, respondio_la_escuela: 1, respondio_el_bot: 1, sin_responder: 1, esperando_mas_de_2_horas: 1 });
        expect(r.sin_responder).toEqual([{
            contacto: 'Ana', tema: 'Familia', respondio: 'el bot', ultimo_mensaje_de: 'Persona', esperando: '3 h',
            preguntas_para_la_escuela: ['¿puedo pagar en dos cuotas? mi cel [número]'],
        }]);
        expect(JSON.stringify(r)).not.toMatch(/300123|9998877/);
    });

    it('por defecto los últimos 14 días', async () => {
        h.seguimiento.mockResolvedValue({ filas: [], servicios: [], avisos: [] });
        await seguimientoWhatsapp.ejecutar(admin, {});
        expect(h.seguimiento.mock.calls[0][1]).toMatchObject({ desde: '2026-11-11', hasta: '2026-11-24' });
    });
});

// ─── estado_aprobacion_automatica ───────────────────────────────────────────

describe('estado_aprobacion_automatica', () => {
    it('la lista de §20.5 contra la configuración real, sin cuentas completas ni correos', async () => {
        pagos.push({ ...P1, id: id(7), status: 'paid', amount: 380000, ocr_destination: '320 987 6543', receipt_url: 'r7' });
        h.lectores = ['gemini'];
        const r: any = await estadoAprobacionAutomatica.ejecutar(admin, {});
        expect(r.aprobacion_automatica).toBe('apagada');
        expect(r.lista).toHaveLength(8);
        expect(r.lista[0]).toMatchObject({ estado: 'falta' });
        expect(r.lista[0].detalle).toContain('terminan en 6543');
        expect(r.lista[1]).toMatchObject({ estado: 'falta', detalle: 'El tope está en $0.' });
        expect(r.lista[2]).toMatchObject({ estado: 'falta' });
        expect(r.lista[3].estado).toBe('verificar a mano');
        expect(r.lista[5]).toMatchObject({ estado: 'cumple', detalle: '1 persona(s) de la administración con correo.' });
        expect(r.lista[6]).toMatchObject({ estado: 'falta' });
        expect(r.resumen).toBe('1 cumplen, 4 faltan y 3 se verifican a mano.');
        expect(JSON.stringify(r)).not.toMatch(/3209876543|dueno@club\.co/);
        expect(consultas().some((c) => c.op !== 'select')).toBe(false);
    });

    it('con todo en orden: cuentas, tope y lectores cumplen', async () => {
        pagos = [];
        ajustes = { ...ajustes, auto_approve_enabled: true, auto_approve_max_amount: 400000 };
        const r: any = await estadoAprobacionAutomatica.ejecutar(admin, {});
        expect(r.aprobacion_automatica).toBe('encendida');
        expect(r.lista.slice(0, 3).map((p: any) => p.estado)).toEqual(['cumple', 'cumple', 'cumple']);
        expect(r.lista[6].estado).toBe('cumple');
    });
});

// ─── ventas_de_servicio ─────────────────────────────────────────────────────

describe('ventas_de_servicio', () => {
    beforeEach(() => {
        h.catalogo.mockResolvedValue({ ok: true, habilitado: true, items: [{
            id: ITEM, nombre: 'Clínica de armadores', descripcion: null, tipo: 'clase_extra', precio: 150000, imagenUrl: null,
            iniciaEn: null, terminaEn: '2026-12-05T00:00:00Z', cupos: 20, cuposRestantes: 15, porAtleta: true,
        }] });
        const tema = { tipo: 'servicio' as const, servicioId: ITEM, nombre: 'Clínica de armadores' };
        h.seguimiento.mockResolvedValue({
            filas: [
                fila({ tema, respondioBot: true, datosDePagoEnviados: true, comprobanteRecibido: true, cobro: { monto: 150000, estado: 'paid', tipo: 'clase_extra', concepto: 'Clínica', fecha: hace(9), cuantos: 1 } }),
                fila({ tema, respondioBot: true, comprobanteRecibido: true, cobro: { monto: 150000, estado: 'awaiting_approval', tipo: 'clase_extra', concepto: 'Clínica', fecha: hace(9), cuantos: 1 } }),
                fila({ tema, esperandoDesde: hace(4), esperandoMin: 240, alerta: true }),
                fila(),
            ],
            servicios: [{ id: ITEM, nombre: 'Clínica de armadores' }], avisos: [],
        });
    });

    it('interesados, cobros y cupos de cada servicio', async () => {
        const r: any = await ventasDeServicio.ejecutar(admin, {});
        expect(h.catalogo).toHaveBeenCalledWith(ESCUELA, { limite: 20 });
        expect(r.servicios).toEqual([{
            servicio: 'Clínica de armadores', precio: '$150.000', cupos: '5 de 20 ocupados', termina: '5 de diciembre',
            interesados: 3, sin_responder: 1, esperando_mas_de_2_horas: 1, con_datos_de_pago: 1, con_comprobante: 2,
            cobros: { pagados: 1, por_validar: 1, pendientes: 0 },
        }]);
    });

    it('por nombre sin tildes; un servicio que no existe lista los que hay', async () => {
        const r: any = await ventasDeServicio.ejecutar(admin, { item: 'clinica' });
        expect(r.servicios).toHaveLength(1);
        await expect(ventasDeServicio.ejecutar(admin, { item: 'yoga' })).rejects.toThrow(/Clínica de armadores/);
    });
});

// ─── pedir_aclaracion ───────────────────────────────────────────────────────

describe('pedir_aclaracion', () => {
    const args = { pago: P2.id, motivo: 'MONTO_DIFIERE' as const };

    it('la vista previa sale de la base y no escribe nada', async () => {
        const p = await pedirAclaracion.preparar(admin, args);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Pedir aclaración · Sofía Ruiz');
        expect(p.vista.lineas).toEqual([
            'Mensualidad noviembre · cobro $145.000 · comprobante $100.000',
            'Motivo: el monto no coincide',
            'El pago queda «necesita aclaración» y sale de la cola de Aprobar. No se rechaza.',
            'La familia recibe el aviso en la app y por correo, y tiene hasta el domingo 29 de noviembre de 2026 para responder.',
        ]);
        expect(p.targetKey).toBe(`pago:${P2.id}`);
        expect(p.huella).toMatchObject({ pago: P2.id, estado: 'awaiting_approval', motivo: 'MONTO_DIFIERE', saldo: 145000 });
        expect(h.createGlosa).not.toHaveBeenCalled();
        expect(consultas().some((c) => c.op !== 'select')).toBe(false);
    });

    it('no se pide sobre un pago fuera de la cola, ya en aclaración o con una glosa abierta', async () => {
        pagos.push({ ...P1, id: id(8), status: 'paid' });
        expect(await pedirAclaracion.preparar(admin, { ...args, pago: id(8) })).toMatchObject({ ok: false, motivo: expect.stringMatching(/no está por validar \(está pagado\)/) });
        pagos.push({ ...P1, id: id(10), status: 'glosado' });
        expect(await pedirAclaracion.preparar(admin, { ...args, pago: id(10) })).toMatchObject({ ok: false, motivo: expect.stringMatching(/aclaración en curso/) });
        glosas = [{ id: 'g-vieja' }];
        expect(await pedirAclaracion.preparar(admin, args)).toMatchObject({ ok: false, motivo: expect.stringMatching(/aclaración en curso/) });
    });

    it('ejecutar abre la glosa a nombre de quien confirma, con el correo de la ruta', async () => {
        const r = await pedirAclaracion.ejecutar(admin, args);
        expect(h.createGlosa).toHaveBeenCalledWith('u-admin', P2.id, 'MONTO_DIFIERE');
        expect(h.correoGlosa).toHaveBeenCalledWith('glosa-1');
        expect(r).toMatchObject({ estado: 'executed', resultado: { glosa: 'glosa-1', nombre: 'Sofía Ruiz', hasta: '2026-11-29' } });
        expect(pedirAclaracion.mensajeResultado(r, args)).toBe(
            'Se le pidió a la familia de Sofía Ruiz que aclare el comprobante (Mensualidad noviembre). Tiene hasta el domingo 29 de noviembre de 2026 para responder; su respuesta llega a Gestión de Pagos.');
    });

    it('si el RPC dice que el rol no puede o que ya hay una abierta, falla con la explicación', async () => {
        h.createGlosa.mockRejectedValueOnce(new GlosaRpcError('Forbidden', '42501'));
        const r = await pedirAclaracion.ejecutar(admin, args);
        expect(r.estado).toBe('failed');
        expect(pedirAclaracion.mensajeResultado(r, args)).toBe('No se pidió la aclaración. Tu rol en la escuela no puede pedir aclaraciones: lo hace el dueño o un administrador.');
        h.createGlosa.mockRejectedValueOnce(new GlosaRpcError('dup', '23505'));
        expect((await pedirAclaracion.ejecutar(admin, args)).resultado).toEqual({ motivo: 'Ese pago ya tenía una aclaración en curso.' });
        expect(h.correoGlosa).not.toHaveBeenCalled();
    });

    it('ejecutar es seguro si la realidad cambió (ya lo aprobaron) y no toca pagos de otra escuela', async () => {
        pagos = pagos.map((p) => (p.id === P2.id ? { ...p, status: 'paid' } : p));
        expect(await pedirAclaracion.ejecutar(admin, args)).toEqual({ estado: 'failed', resultado: { motivo: 'El pago ya no está por validar.' } });
        pagos.push({ ...P2, id: id(11), school_id: OTRA });
        await expect(pedirAclaracion.preparar(admin, { ...args, pago: id(11) })).rejects.toThrow(/No encontré ese pago/);
        expect(h.createGlosa).not.toHaveBeenCalled();
    });
});

// ═══ Plata desde Mapi: aprobar_pago, aprobar_verdes, registrar_pago_efectivo ═══
// Sobre las _por de la migración 20261126101150 (plan mapi-rpc-por-actor §8.2).

describe('plata: nacen apagadas', () => {
    it('solo con MAPI_PLATA_POR=true y nunca para el coach', () => {
        for (const t of [aprobarPago, aprobarVerdes, registrarPagoEfectivo]) {
            expect(t.habilitada!(admin), t.nombre).toBe(false);
            expect(t.roles, t.nombre).toEqual(['admin']);
        }
        process.env.MAPI_PLATA_POR = 'true';
        expect(plataPrendida(admin)).toBe(true);
        expect(plataPrendida(coach)).toBe(false);
        for (const t of [aprobarPago, aprobarVerdes, registrarPagoEfectivo]) expect(t.habilitada!(admin), t.nombre).toBe(true);
    });
});

describe('faltaNivel2 (mismo criterio que _comprobante_nivel2_falta)', () => {
    const vacio = { compartidos: new Set<string>(), periodosPagados: new Set<string>() };
    const pv = (x: any) => ({ ...x, enviado_en: '' });
    it('completo: la regla del lote (verde, sellado por el servidor, sin abonos)', () => {
        expect(faltaNivel2(pv(P1), [], 145000, vacio)).toBeNull();
        expect(faltaNivel2(pv({ ...P1, receipt_image_sha256_source: 'client' }), [], 145000, vacio)).toMatch(/servidor/);
        expect(faltaNivel2(pv(P4), [], 55000, vacio)).toMatch(/abonos previos/);
    });
    it('abono: amarillo SOLO por MONTO_DIFIERE y exactamente lo que dice el comprobante', () => {
        expect(faltaNivel2(pv(P2), P2.receipt_verdict_reasons, 100000, vacio)).toBeNull();
        expect(faltaNivel2(pv(P2), P2.receipt_verdict_reasons, 90000, vacio)).toMatch(/no es lo que dice el comprobante/);
        expect(faltaNivel2(pv(P2), [...P2.receipt_verdict_reasons, { code: 'FECHA_FUERA_VENTANA' }], 100000, vacio)).toMatch(/otras dudas/);
        expect(faltaNivel2(pv({ ...P2, amount_source: 'cliente' }), P2.receipt_verdict_reasons, 100000, vacio)).toMatch(/quien paga/);
        expect(faltaNivel2(pv(P2), P2.receipt_verdict_reasons, 100000, { ...vacio, compartidos: new Set(['r2']) })).toMatch(/varios cobros/);
    });
});

describe('aprobar_pago', () => {
    beforeEach(() => { process.env.MAPI_PLATA_POR = 'true'; });

    it('nivel 2 completo: tarjeta sin escribir y la _por a nombre del admin', async () => {
        const p = await aprobarPago.preparar(admin, aprobarPago.validar({ pago: P1.id, monto: null }));
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Aprobar el pago de Mariana López');
        expect(p.vista.lineas.join(' ')).toContain('Se aprueba el pago completo: $145.000.');
        expect(h.rpc).not.toHaveBeenCalled();
        expect(consultas().some((c) => c.op !== 'select')).toBe(false);

        h.rpc.mockResolvedValue({ data: { estado: 'paid', es_abono: false, abono: 145000, saldo_pendiente: 0, ya_aplicada: false }, error: null });
        const r = await aprobarPago.ejecutar(admin, p.args);
        expect(h.rpc).toHaveBeenCalledWith('aprobar_comprobante_por', {
            p_actor: 'u-admin', p_payment_id: P1.id, p_abono: null, p_pagado_antes: 0,
            p_idempotency_key: llaveDePlata(admin, 'aprobar', P1.id, 145000, 0), p_canal: 'mapi_app', p_tope: null,
        });
        expect(h.rpc.mock.calls[0][1].p_idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(aprobarPago.mensajeResultado(r, p.args)).toMatch(/^Quedó aprobado el pago de Mariana López .* por \$145\.000\. A la familia le llegó el aviso\.$/);
    });

    it('la llave es la misma para el mismo borrador (doble clic) y por WhatsApp el canal es mapi_whatsapp', async () => {
        h.rpc.mockResolvedValue({ data: { ya_aplicada: true }, error: null });
        await aprobarPago.ejecutar(admin, { pago: P1.id, monto: null });
        await aprobarPago.ejecutar({ ...admin, canal: 'whatsapp' } as Alcance, { pago: P1.id, monto: null });
        const [a1, a2] = h.rpc.mock.calls.map((c: any[]) => c[1]);
        expect(a1.p_idempotency_key).toBe(a2.p_idempotency_key);
        expect(a2.p_canal).toBe('mapi_whatsapp');
    });

    it('abono: lo que dice el comprobante, y el saldo que queda', async () => {
        const p = await aprobarPago.preparar(admin, { pago: P2.id, monto: 100000 });
        expect(p.ok).toBe(true);
        if (p.ok) expect(p.vista.lineas.join(' ')).toContain('Se aprueba como abono de $100.000: queda un saldo de $45.000.');
        expect(await aprobarPago.preparar(admin, { pago: P2.id, monto: 90000 })).toMatchObject({ ok: false, motivo: expect.stringMatching(/no se aprueba desde el chat: el abono no es lo que dice el comprobante/) });
    });

    it('dudoso, abonado o por encima del tope de la escuela: a la pantalla', async () => {
        expect(await aprobarPago.preparar(admin, { pago: P3.id, monto: null })).toMatchObject({ ok: false, motivo: expect.stringMatching(/pantalla Aprobar/) });
        expect(await aprobarPago.preparar(admin, { pago: P4.id, monto: null })).toMatchObject({ ok: false, motivo: expect.stringMatching(/abonos previos/) });
        ajustes = { ...ajustes, mapi_tope_aprobacion: 100000 };
        expect(await aprobarPago.preparar(admin, { pago: P1.id, monto: null })).toMatchObject({ ok: false, motivo: expect.stringMatching(/tope de Mapi de la escuela es \$100\.000/) });
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('lo que responde la base, en palabras', async () => {
        const casos: [string, RegExp][] = [
            ['cobro_cambio: el cobro cambió', /cambió mientras tanto/],
            ['cobro_no_abierto: ya no', /Ya no está por validar/],
            ['nivel_3: posible_manipulacion', /ya no es de los que se aprueban desde el chat/],
            ['supera_tope: 1 supera', /Pasa el tope/],
            ['sin_permiso: no es de la administración activa de esta escuela', /tu rol aquí no lo permite/],
        ];
        for (const [msg, patron] of casos) {
            h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: msg } });
            const r = await aprobarPago.ejecutar(admin, { pago: P1.id, monto: null });
            expect(r.estado, msg).toBe('failed');
            expect(aprobarPago.mensajeResultado(r, { pago: P1.id, monto: null }), msg).toMatch(patron);
        }
    });
});

describe('aprobar_verdes', () => {
    beforeEach(() => { process.env.MAPI_PLATA_POR = 'true'; });

    it('solo los de nivel 2 dentro del tope, uno por uno con su llave', async () => {
        const p = await aprobarVerdes.preparar(admin, aprobarVerdes.validar({ sede: null }));
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Aprobar 1 pago en verde');
        expect(p.vista.detalle?.items).toEqual(['Mariana López · Mensualidad noviembre · $145.000']);
        h.rpc.mockResolvedValue({ data: { estado: 'paid' }, error: null });
        const r = await aprobarVerdes.ejecutar(admin, p.args);
        expect(h.rpc).toHaveBeenCalledTimes(1);
        expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_actor: 'u-admin', p_payment_id: P1.id, p_abono: null, p_pagado_antes: 0 });
        expect(r.estado).toBe('executed');
        expect(aprobarVerdes.mensajeResultado(r, p.args)).toBe('Quedaron aprobados 1 pago por $145.000. A cada familia le llegó el aviso.');
    });

    it('si el tope de la escuela los deja fuera, lo dice', async () => {
        ajustes = { ...ajustes, mapi_tope_aprobacion: 100000 };
        expect(await aprobarVerdes.preparar(admin, { sede: null })).toMatchObject({ ok: false, motivo: expect.stringMatching(/pasan el tope/) });
    });
});

describe('registrar_pago_efectivo', () => {
    const KID = 'dddddddd-0000-4000-8000-000000000001';
    const COBRO = id(20);
    beforeEach(() => {
        process.env.MAPI_PLATA_POR = 'true';
        pagos.push({ ...base, id: COBRO, status: 'pending', child_id: KID, concept: 'Mensualidad diciembre', receipt_url: null, receipt_verdict: null, ocr_amount: null });
        h.responder = (c) => c.tabla === 'school_athletes'
            ? { data: [{ id: KID, full_name: 'Juan Pérez', athlete_type: 'child', team_id: null, enrolled_team_id: null, is_active: true, parent_id: 'p1', user_id: null }] }
            : responderBase(c);
    });

    it('abono a un cobro, sin escribir en preparar, y la _por de efectivo a nombre del admin', async () => {
        const p = await registrarPagoEfectivo.preparar(admin, registrarPagoEfectivo.validar({ deportista: `child:${KID}`, cobro: null, monto: 100000 }));
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Registrar $100.000 en efectivo de Juan Pérez');
        expect(p.vista.lineas.join(' ')).toContain('Queda como abono: el saldo baja a $45.000.');
        expect(h.rpc).not.toHaveBeenCalled();
        h.rpc.mockResolvedValue({ data: { es_abono: true, saldo_pendiente: 45000 }, error: null });
        const r = await registrarPagoEfectivo.ejecutar(admin, p.args);
        expect(h.rpc).toHaveBeenCalledWith('register_manual_payments_por', {
            p_actor: 'u-admin', p_school_id: ESCUELA, p_payment_id: COBRO, p_monto: 100000, p_pagado_antes: 0,
            p_idempotency_key: llaveDePlata(admin, 'efectivo', COBRO, 100000, 0), p_fecha: '2026-11-24', p_canal: 'mapi_app', p_tope: null,
        });
        expect(registrarPagoEfectivo.mensajeResultado(r, p.args)).toBe('Quedó registrado el abono en efectivo de $100.000 de Juan Pérez (Mensualidad diciembre). Saldo pendiente: $45.000.');
    });

    it('nunca más que el saldo ni por encima del tope de la escuela', async () => {
        expect(await registrarPagoEfectivo.preparar(admin, { deportista: `child:${KID}`, cobro: null, monto: 200000 })).toMatchObject({ ok: false, motivo: expect.stringMatching(/saldo de ese cobro es \$145\.000/) });
        ajustes = { ...ajustes, mapi_tope_aprobacion: 50000 };
        expect(await registrarPagoEfectivo.preparar(admin, { deportista: `child:${KID}`, cobro: null, monto: 100000 })).toMatchObject({ ok: false, motivo: expect.stringMatching(/tope de Mapi de la escuela es \$50\.000/) });
    });

    it('sin la migración aplicada (PGRST202) no rompe: «todavía no está disponible»', async () => {
        h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.register_manual_payments_por' } });
        const r = await registrarPagoEfectivo.ejecutar(admin, { deportista: `child:${KID}`, cobro: null, monto: 100000 });
        expect(registrarPagoEfectivo.mensajeResultado(r, { deportista: '', cobro: null, monto: 1 })).toMatch(/todavía no está disponible/);
    });
});
