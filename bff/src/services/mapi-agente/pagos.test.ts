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
}));

vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultasPagos = falso.consultas;
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
    h.responder = responderBase;
});

afterEach(() => { delete process.env.MAPI_PAGOS_ACCIONES; });

// ─── Permisos y esquemas ────────────────────────────────────────────────────

describe('permisos', () => {
    it('todas son solo de administración y el coach se rechaza adentro', async () => {
        expect(HERRAMIENTAS_PAGOS).toHaveLength(7);
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
