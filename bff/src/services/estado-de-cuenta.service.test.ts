/**
 * Estado de cuenta mensual por familia (services/estado-de-cuenta.service).
 *
 * Lo que se vigila:
 *   · agrupación por familia (dos perfiles con el mismo correo = una familia;
 *     familia solo con WhatsApp; cobros sin contacto se cuentan aparte);
 *   · filtro de llaves restringidas (only_for) para mensualidades;
 *   · idempotencia mensual: dos corridas del mismo mes no mandan dos veces;
 *     el reenvío tiene su propia clave;
 *   · horario/festivo: noviembre 2026 sale el martes 3 a las 8:00 COT;
 *   · convivencia con el aviso por cobro (posposición y 1 contacto/día);
 *   · elección WhatsApp vs correo;
 *   · ningún enlace a familias sale con localhost (incidente 2026-10-05).
 *
 * Cero red: Supabase en memoria, correo y WhatsApp moqueados.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, any>;

const estado = vi.hoisted(() => ({
    tablas: {} as Record<string, Fila[]>,
    correos: [] as { to: string; subject: string; html: string }[],
    whatsapp: [] as any[],
    waResultado: { enviado: false, motivo: 'sin_optin' } as any,
    plantillaOk: false,
    columnaFlagExiste: true,
    /** created_at de lo que se inserta (la base pone now(); acá, la hora simulada). */
    reloj: null as string | null,
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas: Fila[] = [...(estado.tablas[tabla] ?? [])];
        let modo: 'select' | 'update' = 'select';
        let cambios: Fila = {};
        let head = false;
        let error: any = null;
        const res = () => {
            if (modo === 'update') {
                const ids = new Set(filas.map((f) => f));
                for (const f of estado.tablas[tabla] ?? []) if (ids.has(f)) Object.assign(f, cambios);
                return { data: filas, error: null };
            }
            if (head) return { data: null, count: filas.length, error: null };
            return { data: error ? null : filas, error };
        };
        const api: any = {
            select: (_c?: string, o?: any) => { if (o?.head) head = true; return api; },
            eq: (c: string, v: any) => {
                if (tabla === 'school_settings' && c === 'monthly_statement_enabled' && !estado.columnaFlagExiste) {
                    error = { message: 'column does not exist' };
                }
                filas = filas.filter((f) => f[c] === v); return api;
            },
            in: (c: string, vs: any[]) => { filas = filas.filter((f) => vs.includes(f[c])); return api; },
            is: (c: string, v: any) => { filas = filas.filter((f) => (f[c] ?? null) === v); return api; },
            gte: (c: string, v: any) => { filas = filas.filter((f) => f[c] >= v); return api; },
            order: () => api,
            limit: () => api,
            range: () => api,
            maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
            update: (c: Fila) => { modo = 'update'; cambios = c; return api; },
            insert: async (fila: Fila) => {
                const t = (estado.tablas[tabla] ??= []);
                if (fila.id && t.some((f) => f.id === fila.id)) return { data: null, error: { code: '23505', message: 'duplicate' } };
                t.push({ created_at: estado.reloj ?? new Date().toISOString(), ...fila });
                return { data: null, error: null };
            },
            then: (ok: any, ko: any) => Promise.resolve(res()).then(ok, ko),
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) } };
});

vi.mock('../utils/emailClient', () => ({
    emailClient: { send: vi.fn(async (m: any) => { estado.correos.push(m); return { success: true }; }) },
}));
vi.mock('../utils/schoolBrandingResolver', () => ({
    resolveSchoolBranding: vi.fn(async () => ({ schoolName: 'Club Prueba', primaryColor: '#248223', logoUrl: null })),
}));
vi.mock('../utils/emailLayout', () => ({
    buildBrandedEmail: (p: any) => `<html>${p.bodyHtml}<a href="${p.cta?.url}">${p.cta?.label}</a></html>`,
}));
vi.mock('./duplicatePayerGuard.service', () => ({ findDuplicatePaymentIds: vi.fn(async () => new Set()) }));
vi.mock('./cobro-enlace-publico.service', () => ({
    emitirTokenCobro: vi.fn(async (id: string) => `Tk${id.replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'x').slice(0, 22)}`),
    enlaceWhatsApp: (tel: string | null, t: string) => (tel ? `https://wa.me/${tel}?text=${encodeURIComponent(t)}` : null),
    nombreCorto: (s: string | null) => (s ? s.split(' ')[0] : null),
    whatsappDeLaEscuela: vi.fn(async () => '573001112233'),
}));
vi.mock('./whatsapp-plantillas.service', async (orig) => {
    const real: any = await orig();
    return {
        ...real,
        plantillaAprobada: vi.fn(async () => (estado.plantillaOk
            ? { aprobada: true, nombre: 'pago_recordatorio_previo_v3', idioma: 'es_CO', components: [] }
            : { aprobada: false, motivo: 'plantilla_no_aprobada' })),
        enviarCobroPorPlantilla: vi.fn(async (p: any) => { estado.whatsapp.push(p); return estado.waResultado; }),
    };
});

import {
    agruparPorFamilia, claveEstadoDeCuenta, cobrosDeAtletaInactivo, cuerpoCorreoEstado, datosWhatsAppDeFamilia, elegirCanal, enviarEstadoDeCuenta,
    duenoDeSaldo, escuelasConEstadoPendiente, esDiaHabil, esHoraDelEnvioMensual, primerDiaHabilDesde, runEstadoDeCuentaMensual,
    type Familia, type PagoEstado,
} from './estado-de-cuenta.service';
import { mediosDePago } from './whatsapp-medios-de-pago.service';
import { uuidDeClave } from './avisos-correo.service';
import { appPublica, bffPublico, urlPublicaSegura } from '../utils/url-publica-familias';
import { creaFiltroEstadoDeCuenta } from '../jobs/payment-lifecycle-emails.job';

const ESCUELA = 'sch-1';
// Bogotá = UTC-5.
const MAR_3_NOV_0800 = new Date('2026-11-03T13:00:00Z');
const MAR_3_NOV_0759 = new Date('2026-11-03T12:59:00Z');
const LUN_2_NOV_0900 = new Date('2026-11-02T14:00:00Z'); // festivo (Todos los Santos trasladado)
const DOM_1_NOV_0900 = new Date('2026-11-01T14:00:00Z');
const MIE_4_NOV_0900 = new Date('2026-11-04T14:00:00Z');
const LUN_16_NOV_0900 = new Date('2026-11-16T14:00:00Z');
const MAR_6_OCT_0700 = new Date('2026-10-06T12:00:00Z');

function pago(id: string, extra: Partial<PagoEstado> = {}): PagoEstado {
    return {
        id, school_id: ESCUELA, parent_id: 'p1', user_id: null, child_id: 'c1', unregistered_athlete_id: null,
        concept: 'Mensualidad', amount: 150000, amount_paid: 0, status: 'pending', due_date: '2026-11-10',
        payment_type: 'subscription', period_year: 2026, period_month: 11,
        charge_notice_sent_at: null, overdue_notice_sent_at: null, ...extra,
    };
}

function sembrarEscuela() {
    estado.tablas = {
        payments: [
            pago('pay-a'),
            pago('pay-b', { child_id: 'c2', amount: 120000 }),
            pago('pay-old', { status: 'overdue', due_date: '2026-10-10', period_month: 10 }),
            pago('pay-c', { parent_id: 'p2', child_id: 'c3' }),
            pago('pay-sin', { parent_id: 'p-sin', child_id: 'c4' }),
        ],
        profiles: [
            { id: 'p1', full_name: 'Carolina Pérez', email: 'caro@x.co', phone: '3001234567' },
            { id: 'p2', full_name: 'Jorge Ruiz', email: 'jorge@x.co', phone: null },
            { id: 'p-sin', full_name: 'Sin Contacto', email: null, phone: null },
        ],
        children: [
            { id: 'c1', full_name: 'Samuel Pérez' }, { id: 'c2', full_name: 'Sara Pérez' },
            { id: 'c3', full_name: 'Luis Ruiz' }, { id: 'c4', full_name: 'Ana Nadie' },
        ],
        unregistered_athletes: [],
        school_settings: [{
            school_id: ESCUELA, charge_notifications_enabled: true, monthly_statement_enabled: true,
            payment_qr_url: 'https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/public/school-assets/qr/x.jpg',
            payment_accounts: [
                { id: 'a1', type: 'breb', label: 'Bre-B', value: '0089455111', active: true },
                { id: 'a2', type: 'nequi', label: 'Nequi inscripciones', value: '3204298969', active: true, only_for: ['inscripcion'] },
            ],
            bank_account_number: '80600003578', bank_name: 'bancolombia', breb_key: '0089455111',
        }],
        school_whatsapp_integrations: [],
        email_sends: [],
    };
}

beforeEach(() => {
    sembrarEscuela();
    estado.correos = [];
    estado.whatsapp = [];
    estado.waResultado = { enviado: false, motivo: 'sin_optin' };
    estado.plantillaOk = false;
    estado.columnaFlagExiste = true;
    estado.reloj = MAR_3_NOV_0800.toISOString();
    delete process.env.FAMILIAS_APP_URL;
    delete process.env.FAMILIAS_BFF_URL;
    delete process.env.DISABLE_ESTADO_CUENTA_MENSUAL;
    delete process.env.ESTADO_CUENTA_DESDE;
});

describe('agrupación por familia', () => {
    const datos = () => ({
        perfiles: new Map<string, any>([
            ['p1', { id: 'p1', full_name: 'Carolina', email: 'Caro@X.co', phone: null }],
            ['p1b', { id: 'p1b', full_name: 'Carolina (otra cuenta)', email: 'caro@x.co ', phone: '3001234567' }],
            ['p3', { id: 'p3', full_name: 'Solo WhatsApp', email: null, phone: '300 765 4321' }],
        ]),
        hijos: new Map<string, any>([['c1', { full_name: 'Samuel' }], ['c2', { full_name: 'Sara' }]]),
        noRegistrados: new Map<string, any>(),
    });

    it('dos perfiles con el mismo correo son una familia; sin contacto se cuenta aparte', () => {
        const { familias, sinContacto } = agruparPorFamilia([
            pago('a', { parent_id: 'p1' }),
            pago('b', { parent_id: 'p1b', child_id: 'c2' }),
            pago('c', { parent_id: 'p3' }),
            pago('d', { parent_id: 'nadie' }),
        ], datos(), MAR_3_NOV_0800, '2026-11');
        expect(sinContacto).toBe(1);
        expect(familias).toHaveLength(2);
        const caro = familias.find((f) => f.clave === 'caro@x.co')!;
        expect(caro.filas.map((r) => r.paymentId).sort()).toEqual(['a', 'b']);
        expect(caro.waId).toBe('573001234567'); // lo toma de la segunda cuenta
        const wa = familias.find((f) => f.clave.startsWith('wa:'))!;
        expect(wa.email).toBeNull();
        expect(wa.clave).toBe('wa:573007654321');
    });

    it('ordena lo más viejo primero, marca vencidos, cobros del mes y abonos', () => {
        const { familias } = agruparPorFamilia([
            pago('nov', { parent_id: 'p1' }),
            pago('oct', { parent_id: 'p1', status: 'overdue', due_date: '2026-10-10', period_month: 10 }),
            pago('abono', { parent_id: 'p1', status: 'partial', amount: 100000, amount_paid: 40000, period_month: 10, due_date: '2026-10-05' }),
            pago('pagado-entero', { parent_id: 'p1', status: 'partial', amount: 100000, amount_paid: 100000 }),
        ], datos(), MAR_3_NOV_0800, '2026-11');
        const f = familias[0];
        expect(f.filas.map((r) => r.paymentId)).toEqual(['abono', 'oct', 'nov']);
        expect(f.filas.find((r) => r.paymentId === 'abono')!.saldo).toBe(60000);
        expect(f.filas.find((r) => r.paymentId === 'oct')!.vencido).toBe(true);
        expect(f.filas.filter((r) => r.delMes).map((r) => r.paymentId)).toEqual(['nov']);
    });

    it('avisadaHoy si algún cobro tuvo aviso hoy (hora Colombia)', () => {
        const { familias } = agruparPorFamilia([
            pago('a', { parent_id: 'p1', charge_notice_sent_at: '2026-11-03T12:05:00.000Z' }),
        ], datos(), MAR_3_NOV_0800, '2026-11');
        expect(familias[0].avisadaHoy).toBe(true);
    });

    // Alta con cobros únicos (Dreamers 2026-10-10): mensualidad + inscripción +
    // seguro, los tres con period_year/period_month del mes. Inscripción y seguro
    // van en el estado de cuenta (tabla del correo) pero NO son «la mensualidad
    // del mes» que nombra la plantilla de WhatsApp ni suman a su monto.
    it('cobros únicos: van en las filas, pero no cuentan como mensualidad del mes', () => {
        const { familias } = agruparPorFamilia([
            pago('mens', { amount: 245000, concept: null, payment_category: null }),
            pago('insc', { amount: 120000, concept: 'Inscripción — Plan X — Samuel', payment_type: 'one_time', payment_category: 'inscripcion' }),
            pago('seg', { amount: 150000, concept: null, payment_type: 'one_time', payment_category: 'seguro' }),
            pago('viaje', { amount: 90000, concept: 'Viaje a Cali', payment_type: 'one_time', payment_category: 'viaje' }),
        ], datos(), MAR_3_NOV_0800, '2026-11');
        const f = familias[0];
        expect(f.filas.map((r) => r.paymentId).sort()).toEqual(['insc', 'mens', 'seg', 'viaje']);
        expect(f.filas.filter((r) => r.delMes).map((r) => r.paymentId)).toEqual(['mens']);
        // Sin concepto: la etiqueta de la categoría, no «Cobro».
        expect(f.filas.find((r) => r.paymentId === 'seg')!.concepto).toBe('Seguro de accidentes');
        expect(f.filas.find((r) => r.paymentId === 'mens')!.concepto).toBe('Mensualidad');
        const wa = datosWhatsAppDeFamilia(f, 'Escuela', '2026-11');
        expect(wa.monto.replace(/\D/g, '')).toBe('245000'); // solo la mensualidad, sin inscripción ni seguro
        expect(wa.paymentIdBoton).toBe('mens');
    });

    it('solo cobros únicos: ninguna fila del mes (la plantilla «mensualidad» no aplica)', () => {
        const { familias } = agruparPorFamilia([
            pago('seg', { payment_type: 'one_time', payment_category: 'seguro', concept: 'Seguro de accidentes' }),
        ], datos(), MAR_3_NOV_0800, '2026-11');
        expect(familias[0].filas.filter((r) => r.delMes)).toHaveLength(0);
        expect(elegirCanal({ pedido: 'auto', whatsappEscuela: true, waId: '573001234567', email: 'caro@x.co', filasDelMes: 0 })).toBe('correo');
    });
});

describe('llaves restringidas (only_for)', () => {
    it('para mensualidades no sale el Nequi de inscripciones, ni por la columna suelta', async () => {
        const m = await mediosDePago(ESCUELA, { categoria: 'mensualidad' });
        const numeros = m.cuentas.map((c) => c.numero);
        expect(numeros).toContain('0089455111');
        expect(numeros).toContain('80600003578');
        expect(numeros).not.toContain('3204298969');
    });
});

// Link de pago de Wompi de Dynasty (2026-10-06): sale como enlace/botón, nunca como cuenta.
describe('link de pago (payment_link)', () => {
    const LINK = 'https://checkout.wompi.co/l/Hj5s7R';
    const conLink = (extra: Record<string, unknown> = {}) => {
        estado.tablas.school_settings[0].payment_accounts.push({
            id: 'w1', type: 'payment_link', label: 'Pagar con tarjeta, PSE o Nequi (Wompi)', value: LINK, active: true, ...extra,
        });
    };

    it('mediosDePago lo usa como enlace_para_pagar y no lo mete en cuentas', async () => {
        conLink();
        const m = await mediosDePago(ESCUELA, { categoria: 'mensualidad' });
        expect(m.enlace_para_pagar).toBe(LINK);
        expect(m.link_de_pago).toBe(LINK);
        expect(m.instrucciones_del_enlace).toContain('manda el comprobante');
        expect(m.cuentas.map((c) => c.numero)).not.toContain(LINK);
    });

    it('sin link (o apagado) no hay enlace general: nunca /my-payments (pide sesión)', async () => {
        conLink({ active: false });
        const m = await mediosDePago(ESCUELA);
        expect(m.enlace_para_pagar).toBeNull();
        expect(m.link_de_pago).toBeNull();
        expect(m.instrucciones_del_enlace).toBeNull();
    });

    it('el correo muestra el botón con el aviso de mandar el comprobante', () => {
        const f: Familia = {
            clave: 'x@x.co', email: 'x@x.co', waId: null, nombre: 'X', perfilId: null, avisadaHoy: false,
            filas: [{ paymentId: 'p', atleta: 'Ana', concepto: 'Mensualidad', vence: '2026-11-10', saldo: 1, vencido: false, delMes: true, status: 'pending', token: 'Tok' }],
        };
        const base = { escuela: 'E', familia: f, appBase: 'https://app.sportmaps.co', bffBase: 'https://bffprod.sportmaps.co', medios: [], qrEscuelaUrl: null, whatsappComprobante: null };
        const html = cuerpoCorreoEstado({ ...base, linkDePago: LINK });
        expect(html).toContain(`href="${LINK}"`);
        expect(html).toContain('Pagar con tarjeta, PSE o Nequi (Wompi)');
        expect(html).toContain('súbelo en la app para que la escuela lo aplique');
        expect(cuerpoCorreoEstado(base)).not.toContain('Wompi');
    });

    it('si la familia tiene saldo a favor lo dice; sin saldo no menciona nada', () => {
        const f: Familia = {
            clave: 'a@b.co', email: 'a@b.co', waId: null, nombre: 'Ana', perfilId: null, avisadaHoy: false, saldoAFavor: 40000,
            filas: [{ paymentId: 'p', atleta: 'Ana', concepto: 'Mensualidad', vence: '2026-11-10', saldo: 1, vencido: false, delMes: true, status: 'pending', token: 'Tok' }],
        };
        const base = { escuela: 'E', familia: f, appBase: 'https://app.sportmaps.co', bffBase: 'https://bffprod.sportmaps.co', medios: [], qrEscuelaUrl: null, whatsappComprobante: null };
        expect(cuerpoCorreoEstado(base)).toContain('saldo a favor de');
        expect(cuerpoCorreoEstado({ ...base, familia: { ...f, saldoAFavor: undefined } })).not.toContain('saldo a favor');
        expect(duenoDeSaldo({ child_id: 'c1', user_id: 'u1' })).toBe('c:c1');
        expect(duenoDeSaldo({ user_id: null, parent_id: 'p1' })).toBe('p:p1');
    });
});

describe('horario y festivos', () => {
    it('noviembre 2026: domingo 1 y lunes 2 (festivo) no; martes 3 sí', () => {
        expect(esDiaHabil(DOM_1_NOV_0900)).toBe(false);
        expect(esDiaHabil(LUN_2_NOV_0900)).toBe(false);
        expect(esDiaHabil(MAR_3_NOV_0800)).toBe(true);
        expect(primerDiaHabilDesde('2026-11-01')).toBe('2026-11-03');
        expect(primerDiaHabilDesde('2026-12-01')).toBe('2026-12-01');
        expect(primerDiaHabilDesde('2027-01-01')).toBe('2027-01-04'); // vie 1 festivo, sáb, dom; Reyes 2027 se corre al lun 11
    });

    it('la hora del envío mensual es desde las 8:00 COT', () => {
        expect(esHoraDelEnvioMensual(MAR_3_NOV_0759)).toBe(false);
        expect(esHoraDelEnvioMensual(MAR_3_NOV_0800)).toBe(true);
        expect(esHoraDelEnvioMensual(LUN_2_NOV_0900)).toBe(false);
    });

    it('el job no hace nada antes de las 8 ni en festivo', async () => {
        expect(await runEstadoDeCuentaMensual(MAR_3_NOV_0759)).toEqual({});
        expect(await runEstadoDeCuentaMensual(LUN_2_NOV_0900)).toEqual({});
        expect(estado.correos).toHaveLength(0);
    });
});

describe('idempotencia', () => {
    it('la clave mensual es la misma todo el mes y distinta entre meses; el reenvío tiene la suya', () => {
        const k = (modo: any, ahora: Date) => claveEstadoDeCuenta({ modo, schoolId: ESCUELA, familia: 'caro@x.co', ahora });
        expect(k('mensual', MAR_3_NOV_0800)).toBe(k('mensual', MIE_4_NOV_0900));
        expect(k('mensual', MAR_3_NOV_0800)).not.toBe(k('mensual', new Date('2026-12-01T14:00:00Z')));
        expect(k('manual', MAR_3_NOV_0800)).not.toBe(k('manual', MIE_4_NOV_0900));
        expect(k('reenvio', MAR_6_OCT_0700)).not.toBe(k('manual', MAR_6_OCT_0700));
        expect(k('reenvio', MAR_6_OCT_0700)).toBe(`estado_de_cuenta_reenvio:${ESCUELA}:caro@x.co:2026-10-06`);
        // el script viejo usaba exactamente esta forma: correrlo de nuevo el mismo día no duplica
        expect(k('manual', MAR_6_OCT_0700)).toBe(`estado_de_cuenta:${ESCUELA}:caro@x.co:2026-10-06`);
    });

    it('dos corridas del mes (otro día, otro BFF) no mandan dos veces; escribe la marca', async () => {
        const r1 = await runEstadoDeCuentaMensual(MAR_3_NOV_0800);
        const res1 = r1[ESCUELA] as any;
        expect(res1.por_correo).toBe(2);           // Carolina y Jorge; "Sin Contacto" no
        expect(res1.cobros_sin_contacto).toBe(1);
        expect(estado.correos).toHaveLength(2);
        expect(estado.tablas.email_sends.some((f) => f.id === uuidDeClave(`estado_de_cuenta_corrida:${ESCUELA}:2026-11`))).toBe(true);

        // Marca escrita → el job ni entra.
        expect(await runEstadoDeCuentaMensual(MIE_4_NOV_0900)).toEqual({});
        // Aun sin la marca, la reserva por familia y mes frena el duplicado.
        estado.tablas.email_sends = estado.tablas.email_sends.filter((f) => f.email_type !== 'estado_de_cuenta_corrida');
        for (const p of estado.tablas.payments) { p.charge_notice_sent_at = null; p.overdue_notice_sent_at = null; }
        const r2 = await runEstadoDeCuentaMensual(MIE_4_NOV_0900);
        expect((r2[ESCUELA] as any).ya_enviados_antes).toBe(2);
        expect(estado.correos).toHaveLength(2);
    });

    it('estampa los avisos de los cobros que incluye (el job por cobro ya no los toca)', async () => {
        await runEstadoDeCuentaMensual(MAR_3_NOV_0800);
        const p = (id: string) => estado.tablas.payments.find((x) => x.id === id)!;
        expect(p('pay-a').charge_notice_sent_at).toBeTruthy();
        expect(p('pay-old').overdue_notice_sent_at).toBeTruthy();
        expect(p('pay-sin').charge_notice_sent_at).toBeNull();
    });

    it('sin la columna monthly_statement_enabled (migración sin aplicar) está apagado', async () => {
        estado.columnaFlagExiste = false;
        expect(await runEstadoDeCuentaMensual(MAR_3_NOV_0800)).toEqual({});
        expect(estado.correos).toHaveLength(0);
    });

    it('octubre no: arranca en ESTADO_CUENTA_DESDE (2026-11)', async () => {
        expect(await runEstadoDeCuentaMensual(new Date('2026-10-06T14:00:00Z'))).toEqual({});
    });

    it('sin cobros de mensualidad del mes no manda (espera a open_month)', async () => {
        estado.tablas.payments = estado.tablas.payments.filter((p) => p.period_month !== 11);
        const r = await runEstadoDeCuentaMensual(MAR_3_NOV_0800);
        expect(r[ESCUELA]).toBe('sin cobros del mes todavía');
        expect(estado.correos).toHaveLength(0);
    });
});

describe('contenido del correo', () => {
    it('botón /p/:token por cobro, QR de la escuela y del enlace, llaves filtradas, nota; sin data: ni localhost', async () => {
        await enviarEstadoDeCuenta(ESCUELA, {
            modo: 'reenvio', aplicar: true, canal: 'correo', ahora: MAR_6_OCT_0700, pausaMs: 0,
            nota: 'Corregimos el enlace del correo de ayer: ahora el botón te lleva directo a pagar.',
        });
        const caro = estado.correos.find((c) => c.to === 'caro@x.co')!;
        expect(caro.html).toContain('https://app.sportmaps.co/p/Tkpaya');
        expect(caro.html).toContain('https://app.sportmaps.co/p/Tkpayold');
        expect(caro.html).toContain('https://bffprod.sportmaps.co/api/v1/public/cobro/Tkpayold');
        expect(caro.html).toContain('/qr.png');
        expect(caro.html).toContain('school-assets/qr/x.jpg');
        expect(caro.html).toContain('0089455111');
        expect(caro.html).not.toContain('3204298969');
        expect(caro.html).toContain('Corregimos el enlace');
        expect(caro.html).toContain('https://wa.me/573001112233');
        expect(caro.html).not.toMatch(/data:image/);
        expect(caro.html).not.toMatch(/localhost|127\.0\.0\.1/);
    });

    it('cuerpoCorreoEstado escapa HTML del nombre y del concepto', () => {
        const f: Familia = {
            clave: 'x@x.co', email: 'x@x.co', waId: null, nombre: 'X', perfilId: null, avisadaHoy: false,
            filas: [{ paymentId: 'p', atleta: '<b>Ana</b>', concepto: 'Mensualidad <script>', vence: '2026-11-10', saldo: 1, vencido: false, delMes: true, status: 'pending', token: 'Tok' }],
        };
        const html = cuerpoCorreoEstado({ escuela: 'E', familia: f, appBase: 'https://app.sportmaps.co', bffBase: 'https://bffprod.sportmaps.co', medios: [], qrEscuelaUrl: null, whatsappComprobante: null });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;b&gt;Ana');
    });

    it('ofrece completar los datos de factura (al mismo /p/<token>#factura) solo si la escuela factura', () => {
        const f: Familia = {
            clave: 'x@x.co', email: 'x@x.co', waId: null, nombre: 'X', perfilId: null, avisadaHoy: false,
            filas: [{ paymentId: 'p', atleta: 'Ana', concepto: 'Mensualidad', vence: '2026-11-10', saldo: 1, vencido: false, delMes: true, status: 'pending', token: 'TokenAAAAAAAAAAAAAAAAAAA' }],
        };
        const base = { escuela: 'E', familia: f, appBase: 'https://app.sportmaps.co', bffBase: 'https://bffprod.sportmaps.co', medios: [], qrEscuelaUrl: null, whatsappComprobante: null };
        expect(cuerpoCorreoEstado({ ...base, ofrecerFactura: true }))
            .toContain('https://app.sportmaps.co/p/TokenAAAAAAAAAAAAAAAAAAA#factura');
        expect(cuerpoCorreoEstado({ ...base, ofrecerFactura: false })).not.toContain('factura electrónica');
        expect(cuerpoCorreoEstado(base)).not.toContain('#factura');
    });
});

describe('ningún enlace a familias con localhost', () => {
    it('urlPublicaSegura rechaza localhost, 127.0.0.1, .local, IP privada y http', () => {
        for (const u of ['http://localhost:5173', 'https://localhost', 'https://127.0.0.1:3000', 'https://mi-pc.local',
            'https://192.168.1.10', 'http://app.sportmaps.co', '', 'no-es-url']) {
            expect(() => urlPublicaSegura(u)).toThrow();
        }
        expect(urlPublicaSegura('https://app.sportmaps.co/')).toBe('https://app.sportmaps.co');
    });

    it('FRONTEND_URL del .env NO se usa; un FAMILIAS_*_URL a localhost lanza', () => {
        process.env.FRONTEND_URL = 'http://localhost:8080';
        expect(appPublica()).toBe('https://app.sportmaps.co');
        expect(bffPublico()).toBe('https://bffprod.sportmaps.co');
        process.env.FAMILIAS_APP_URL = 'http://localhost:8080';
        expect(() => appPublica()).toThrow(/familias reales/);
        process.env.FAMILIAS_BFF_URL = 'https://127.0.0.1:3000';
        expect(() => bffPublico()).toThrow();
    });

    it('el envío con --frontend/--bff a localhost corta ANTES de reservar o mandar', async () => {
        await expect(enviarEstadoDeCuenta(ESCUELA, { modo: 'manual', aplicar: true, appUrl: 'http://localhost:5173', ahora: MAR_3_NOV_0800 }))
            .rejects.toThrow();
        await expect(enviarEstadoDeCuenta(ESCUELA, { modo: 'manual', aplicar: true, bffUrl: 'http://localhost:3000', ahora: MAR_3_NOV_0800 }))
            .rejects.toThrow();
        expect(estado.correos).toHaveLength(0);
        expect(estado.tablas.email_sends).toHaveLength(0);
    });

    it('el job con FAMILIAS_APP_URL a localhost no manda nada y lo registra como error', async () => {
        process.env.FAMILIAS_APP_URL = 'http://localhost:5173';
        const r = await runEstadoDeCuentaMensual(MAR_3_NOV_0800);
        expect(String(r[ESCUELA])).toMatch(/^error:/);
        expect(estado.correos).toHaveLength(0);
    });
});

describe('WhatsApp o correo (uno solo)', () => {
    it('matriz de elegirCanal', () => {
        const base = { pedido: 'auto' as const, whatsappEscuela: true, waId: '573001234567', email: 'a@b.co', filasDelMes: 1 };
        expect(elegirCanal(base)).toBe('whatsapp_o_correo');
        expect(elegirCanal({ ...base, email: null })).toBe('whatsapp');
        expect(elegirCanal({ ...base, whatsappEscuela: false })).toBe('correo');
        expect(elegirCanal({ ...base, waId: null })).toBe('correo');
        expect(elegirCanal({ ...base, filasDelMes: 0 })).toBe('correo');
        expect(elegirCanal({ ...base, pedido: 'correo' })).toBe('correo');
        expect(elegirCanal({ ...base, waId: null, email: null })).toBe('ninguno');
    });

    function conWhatsApp() {
        estado.plantillaOk = true;
        estado.tablas.school_whatsapp_integrations = [{ id: 'int-1', school_id: ESCUELA, status: 'active', waba_id: 'w', access_token_encrypted: 'x' }];
    }

    it('con opt-in y plantilla aprobada sale por WhatsApp y NO por correo', async () => {
        conWhatsApp();
        estado.waResultado = { enviado: true, waMessageId: 'wamid.1', plantilla: 'pago_recordatorio_previo_v3' };
        const r = await enviarEstadoDeCuenta(ESCUELA, { modo: 'mensual', aplicar: true, canal: 'auto', ahora: MAR_3_NOV_0800, pausaMs: 0 });
        expect(r.por_whatsapp).toBe(1);                       // Carolina tiene teléfono
        expect(estado.correos.map((c) => c.to)).toEqual(['jorge@x.co']); // Jorge no
        const wa = estado.whatsapp[0];
        expect(wa.concepto).toBe('recordatorio_previo');
        expect(wa.datos.nombreAtleta).toBe('Samuel y Sara');
        expect(wa.datos.periodo).toBe('noviembre 2026');
        expect(wa.datos.monto).toBe('$270.000');              // solo los del mes, no el vencido de octubre
        expect(wa.tokenBoton).toMatch(/^Tk/);
    });

    it('si WhatsApp no sale (sin opt-in) cae al correo en la misma corrida', async () => {
        conWhatsApp();
        estado.waResultado = { enviado: false, motivo: 'sin_optin' };
        const r = await enviarEstadoDeCuenta(ESCUELA, { modo: 'mensual', aplicar: true, canal: 'auto', ahora: MAR_3_NOV_0800, pausaMs: 0 });
        expect(r.por_whatsapp).toBe(0);
        expect(r.motivos_whatsapp).toEqual({ sin_optin: 1 });
        expect(estado.correos.map((c) => c.to).sort()).toEqual(['caro@x.co', 'jorge@x.co']);
    });

    it('sin plantilla aprobada ni siquiera intenta WhatsApp', async () => {
        await enviarEstadoDeCuenta(ESCUELA, { modo: 'mensual', aplicar: true, canal: 'auto', ahora: MAR_3_NOV_0800, pausaMs: 0 });
        expect(estado.whatsapp).toHaveLength(0);
        expect(estado.correos).toHaveLength(2);
    });

    it('la simulación no reserva, no emite tokens y no manda', async () => {
        const r = await enviarEstadoDeCuenta(ESCUELA, { modo: 'mensual', aplicar: false, ahora: MAR_3_NOV_0800 });
        expect(r.por_correo).toBe(2);
        expect(estado.correos).toHaveLength(0);
        expect(estado.tablas.email_sends).toHaveLength(0);
    });
});

describe('convivencia con el aviso por cobro', () => {
    it('pendiente → los avisos esperan; con la marca, o pasado el día 15, o sin cobros del mes, no', async () => {
        expect([...await escuelasConEstadoPendiente([ESCUELA], MAR_3_NOV_0800)]).toEqual([ESCUELA]);
        expect([...await escuelasConEstadoPendiente([ESCUELA], LUN_16_NOV_0900)]).toEqual([]);
        expect([...await escuelasConEstadoPendiente([ESCUELA], new Date('2026-10-06T14:00:00Z'))]).toEqual([]);
        await runEstadoDeCuentaMensual(MAR_3_NOV_0800);
        expect([...await escuelasConEstadoPendiente([ESCUELA], MIE_4_NOV_0900)]).toEqual([]);
    });

    it('sin la columna (migración sin aplicar) nada se pospone', async () => {
        estado.columnaFlagExiste = false;
        expect([...await escuelasConEstadoPendiente([ESCUELA], MAR_3_NOV_0800)]).toEqual([]);
    });

    it('el filtro del job por cobro: espera si está pendiente; salta a quien recibió el estado HOY', async () => {
        const f1 = creaFiltroEstadoDeCuenta(MAR_3_NOV_0800);
        await f1.inicializar([ESCUELA]);
        expect(await f1.debeEsperar({ school_id: ESCUELA }, undefined)).toBe('estado_pendiente');

        await runEstadoDeCuentaMensual(MAR_3_NOV_0800);
        const contacto = (email: string | null, tel: string | null) => ({
            contactName: 'X', contactEmail: email, athleteName: 'Y', contactPhone: tel, contactProfileId: null,
        });
        const f2 = creaFiltroEstadoDeCuenta(new Date('2026-11-03T20:00:00Z')); // 15:00 COT del mismo día
        await f2.inicializar([ESCUELA]);
        expect(await f2.debeEsperar({ school_id: ESCUELA }, contacto('CARO@x.co', null))).toBe('estado_hoy');
        expect(await f2.debeEsperar({ school_id: ESCUELA }, contacto(null, '300 123 4567'))).toBe('estado_hoy');
        expect(await f2.debeEsperar({ school_id: ESCUELA }, contacto('otra@x.co', null))).toBeNull();

        const f3 = creaFiltroEstadoDeCuenta(MIE_4_NOV_0900); // al día siguiente ya puede
        await f3.inicializar([ESCUELA]);
        expect(await f3.debeEsperar({ school_id: ESCUELA }, contacto('caro@x.co', null))).toBeNull();
    });
});

// Caso Dynasty 2026-10-06: la familia de un atleta dado de baja no recibe estado de cuenta.
describe('atleta dado de baja', () => {
    it('matriz de cobrosDeAtletaInactivo (child, ficha, adulto por membresía; NULL = activo)', () => {
        const pagos = [
            pago('hijo-inactivo', { child_id: 'c1' }),
            pago('hijo-activo', { child_id: 'c2' }),
            pago('hijo-null', { child_id: 'c3' }),
            pago('ficha-inactiva', { child_id: null, unregistered_athlete_id: 'u1' }),
            pago('ficha-activa', { child_id: null, unregistered_athlete_id: 'u2' }),
            pago('adulto-inactivo', { child_id: null, parent_id: null, user_id: 'a1' }),
            pago('adulto-reactivado', { child_id: null, parent_id: null, user_id: 'a2' }),
            pago('adulto-sin-membresia', { child_id: null, parent_id: null, user_id: 'a3' }),
        ];
        const r = cobrosDeAtletaInactivo(pagos, {
            hijos: new Map<string, any>([['c1', { is_active: false }], ['c2', { is_active: true }], ['c3', { is_active: null }]]),
            noRegistrados: new Map<string, any>([['u1', { is_active: false }], ['u2', { is_active: true }]]),
            membresiasAtleta: new Map([['a1', ['inactive']], ['a2', ['inactive', 'active']]]),
        });
        expect([...r].sort()).toEqual(['adulto-inactivo', 'ficha-inactiva', 'hijo-inactivo']);
    });

    it('el envío salta los cobros del atleta inactivo y lo cuenta en el resumen', async () => {
        estado.tablas.children.find((c) => c.id === 'c2')!.is_active = false;      // Sara, hermana de Samuel
        estado.tablas.children.find((c) => c.id === 'c3')!.is_active = false;      // Luis: Jorge queda sin nada
        estado.tablas.payments.push(
            pago('pay-ficha', { parent_id: 'p2', child_id: null, unregistered_athlete_id: 'u1' }),
            pago('pay-adulto', { parent_id: null, child_id: null, user_id: 'p-adulto' }),
        );
        estado.tablas.unregistered_athletes = [{ id: 'u1', full_name: 'Ficha Baja', is_active: false }];
        estado.tablas.profiles.push({ id: 'p-adulto', full_name: 'Adulto Baja', email: 'adulto@x.co', phone: null });
        estado.tablas.school_members = [{ school_id: ESCUELA, profile_id: 'p-adulto', role: 'athlete', status: 'inactive' }];

        const r = await enviarEstadoDeCuenta(ESCUELA, { modo: 'manual', aplicar: true, canal: 'correo', ahora: MAR_3_NOV_0800, pausaMs: 0 });
        expect(r.cobros_atleta_inactivo).toBe(4);   // pay-b, pay-c, pay-ficha, pay-adulto
        expect(estado.correos.map((c) => c.to)).toEqual(['caro@x.co']);
        const caro = estado.correos[0].html;
        expect(caro).toContain('Samuel');
        expect(caro).not.toContain('Sara');
        // Ningún cobro excluido queda estampado como avisado.
        const p = (id: string) => estado.tablas.payments.find((x) => x.id === id)!;
        expect(p('pay-b').charge_notice_sent_at).toBeNull();
        expect(p('pay-adulto').charge_notice_sent_at).toBeNull();
    });

    it('la membresía athlete inactiva de OTRA escuela no excluye', async () => {
        estado.tablas.payments = [pago('pay-adulto', { parent_id: null, child_id: null, user_id: 'p-adulto' })];
        estado.tablas.profiles.push({ id: 'p-adulto', full_name: 'Adulto', email: 'adulto@x.co', phone: null });
        estado.tablas.school_members = [{ school_id: 'otra', profile_id: 'p-adulto', role: 'athlete', status: 'inactive' }];
        const r = await enviarEstadoDeCuenta(ESCUELA, { modo: 'manual', aplicar: false, canal: 'correo', ahora: MAR_3_NOV_0800 });
        expect(r.cobros_atleta_inactivo).toBe(0);
        expect(r.por_correo).toBe(1);
    });
});

// ─── Mora (2026-10-14): apply_late_fees la suma DENTRO de amount ─────────────

describe('estado de cuenta con mora', () => {
    const datos = () => ({
        perfiles: new Map<string, any>([['p1', { id: 'p1', full_name: 'Carolina', email: 'caro@x.co', phone: null }]]),
        hijos: new Map<string, any>([['c1', { full_name: 'Samuel' }], ['c2', { full_name: 'Sara' }]]),
        noRegistrados: new Map<string, any>(),
    });

    it('la fila lleva su mora; WhatsApp dice el total con mora y el correo el desglose', () => {
        const { familias } = agruparPorFamilia([
            pago('mens', { amount: 165000, late_fee_amount: 15000, status: 'overdue', due_date: '2026-11-01' }),
            pago('mens2', { child_id: 'c2', amount: 150000 }),
        ], datos(), MAR_3_NOV_0800, '2026-11');
        const f = familias[0];
        expect(f.filas.find((r) => r.paymentId === 'mens')!.mora).toBe(15000);
        expect(f.filas.find((r) => r.paymentId === 'mens2')!.mora).toBe(0);

        const wa = datosWhatsAppDeFamilia(f, 'Escuela', '2026-11');
        expect(wa.monto).toBe('$315.000, que incluye $15.000 de recargo por mora');

        const html = cuerpoCorreoEstado({ escuela: 'E', familia: f, appBase: 'https://app.sportmaps.co', bffBase: 'https://bffprod.sportmaps.co', medios: [], qrEscuelaUrl: null, whatsappComprobante: null });
        expect(html).toContain('Mensualidad $150.000 · Recargo por mora $15.000 · Total $165.000');
        // Una sola vez: el cobro sin mora no lleva desglose.
        expect(html.match(/Recargo por mora/g)).toHaveLength(1);
    });

    it('sin mora: el monto de WhatsApp como siempre', () => {
        const { familias } = agruparPorFamilia([pago('mens', { late_fee_amount: null })], datos(), MAR_3_NOV_0800, '2026-11');
        expect(datosWhatsAppDeFamilia(familias[0], 'Escuela', '2026-11').monto).toBe('$150.000');
    });
});

describe('saldo del estado de cuenta = saldo del enlace /p/:token', () => {
    const datos = () => ({
        perfiles: new Map<string, any>([['p1', { id: 'p1', full_name: 'Carolina', email: 'caro@x.co', phone: null }]]),
        hijos: new Map<string, any>([['c1', { full_name: 'Samuel' }], ['c2', { full_name: 'Sara' }]]),
        noRegistrados: new Map<string, any>(),
    });

    it('resta lo abonado y el pronto pago en cualquier estado; sin saldo no sale la fila', () => {
        const { familias } = agruparPorFamilia([
            pago('abono', { status: 'partial', amount: 150000, amount_paid: 50000 }),
            pago('pronto', { child_id: 'c2', amount: 150000, early_payment_discount_applied: 15000 }),
            pago('cubierto', { amount: 150000, amount_paid: 140000, early_payment_discount_applied: 10000 }),
        ], datos(), MAR_3_NOV_0800, '2026-11');
        const saldo = (id: string) => familias[0].filas.find((r) => r.paymentId === id)?.saldo;
        expect(saldo('abono')).toBe(100000);
        expect(saldo('pronto')).toBe(135000);
        expect(saldo('cubierto')).toBeUndefined();
    });
});
