/**
 * Oleada 2 — pagar por plazos y pausar/retirar/reactivar el plan por WhatsApp.
 * Conversaciones completas contra puertos falsos (sin base ni Meta): lo que se
 * verifica es QUÉ dice el bot, QUÉ crea, y que nunca cree sin un «Sí» explícito.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {}, SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./plataforma-wa-avisos.service', () => ({ avisarCasoPorPlataforma: vi.fn() }));
vi.mock('./avisos-correo.service', () => ({ uuidDeClave: (k: string) => k, etiquetaDeContacto: () => 'x' }));

import { atenderPlanYPlazos, type Puertos } from './whatsapp-plan-y-plazos';
import { pideAcuerdoDePago, leerPlazos } from './whatsapp-plazos';
import { intencionDePlan, nombrados } from './whatsapp-plan-pausa-retiro';
import { PALABRAS_PROHIBIDAS, rangoDeMeses, fechaDeSalida, esSiExplicito, pesos } from './whatsapp-plan-comun';
import { esSolicitudDeRetiro } from './whatsapp-escalaciones.service';
import type { FilaReciente } from './whatsapp-reglas-turno';

const HOY = '2026-11-06';
const T0 = new Date('2026-11-06T15:00:00-05:00').getTime();
const PERFIL = 'perfil-1';
const ESCUELA = 'escuela-1';
const MIN = 60_000;

// ─── Detección pura ──────────────────────────────────────────────────────────

describe('pideAcuerdoDePago', () => {
    it.each([
        'quiero pagar por plazos',
        'Hola, ¿puedo pagar en cuotas la mensualidad?',
        'quisiera pagar la mensualidad en dos pagos',
        'puedo pagar el 15 y el 30?',
        'quiero pagar el 15 y el 30 de este mes',
        'necesito dividir el pago en tres cuotas',
        'se puede pagar después en partes?',
        'hay forma de hacer un acuerdo de pago',
        'Podemos pagar la mitad ahora y la otra mitad a fin de mes',
        'quiero pagar a plazos el torneo',
    ])('«%s» pide plazos', (t) => expect(pideAcuerdoDePago(t)).toBe(true));

    it.each([
        'cuánto debo',
        'cuánto vale la mensualidad',
        'ya pagué en dos cuotas, ahí va el comprobante',
        'pagué el 15 y el 30',
        'consigné la mitad ayer',
        'quiero pagar la mensualidad',
        'a qué número consigno',
        'hay clase hoy',
        'cuál es el valor de la cuota de inscripción',
    ])('«%s» NO pide plazos', (t) => expect(pideAcuerdoDePago(t)).toBe(false));
});

describe('leerPlazos', () => {
    it('cantidad', () => {
        expect(leerPlazos('en 3 cuotas', HOY)).toEqual({ cuotas: 3 });
        expect(leerPlazos('dos pagos', HOY)).toEqual({ cuotas: 2 });
        expect(leerPlazos('2', HOY)).toEqual({ cuotas: 2 });
        expect(leerPlazos('en quincenas', HOY)).toEqual({ cuotas: 2 });
    });
    it('«el 15 y el 30» son las próximas fechas, en orden', () => {
        expect(leerPlazos('el 15 y el 30', HOY)).toEqual({ cuotas: 2, fechas: ['2026-11-15', '2026-11-30'] });
        // el 5 de este mes ya pasó: sale el del mes siguiente, y el 20 después
        expect(leerPlazos('el 5 y el 20', HOY).fechas).toEqual(['2026-12-05', '2026-12-20']);
    });
    it('día 30 en febrero cae al último día', () => {
        expect(leerPlazos('el 30', '2027-02-10').fechas).toEqual(['2027-02-28']);
    });
    it('fechas con mes', () => {
        expect(leerPlazos('el 15 de diciembre y el 15 de enero', HOY)).toEqual({ cuotas: 2, fechas: ['2026-12-15', '2027-01-15'] });
    });
    it('nada reconocible', () => expect(leerPlazos('no sé', HOY)).toEqual({}));
});

describe('intencionDePlan', () => {
    it.each([
        ['quiero congelar el plan', 'pausa'],
        ['quiero congelar a mi hija en enero', 'pausa'],
        ['voy a estar de viaje en diciembre', 'pausa'],
        ['pausar a mi hijo en enero', 'pausa'],
        ['vamos a estar de vacaciones en diciembre y enero', 'pausa'],
        ['quiero suspender la mensualidad por un par de meses', 'pausa'],
        ['quiero retirarlo del club', 'retiro'],
        ['ya no vamos a continuar', 'retiro'],
        ['mi hijo ya no va a seguir', 'retiro'],
        ['quiero volver a entrenar', 'reactivacion'],
        ['queremos reactivar el plan de mi hija', 'reactivacion'],
        ['cómo va mi solicitud de pausa', 'mis_solicitudes'],
        ['ya aprobaron la pausa?', 'mis_solicitudes'],
        ['cancela mi solicitud de retiro', 'cancelar_solicitud'],
        ['ya no quiero retirarlo', 'cancelar_solicitud'],
        ['quiero congelar el plan o retirarlo, no sé', 'ambigua'],
    ])('«%s» → %s', (t, esperado) => expect(intencionDePlan(t, HOY)).toBe(esperado));

    it.each([
        'ya no puedo ir esta semana',
        'mi hija no puede ir hoy',
        'no va a ir mañana, está enferma',
        'cuánto debo',
        'cuánto vale la mensualidad de diciembre',
        'cuánto vale pausar un entrenamiento',
        'a qué hora es el entreno',
        'viaje a Cartagena, ¿cuánto cuesta el torneo de diciembre?',
        'ya pagué la mensualidad de diciembre',
        'retirar el uniforme',
        'hola buenas tardes',
    ])('«%s» NO activa nada', (t) => expect(intencionDePlan(t, HOY)).toBeNull());
});

describe('fechas y meses', () => {
    it('rango de meses', () => {
        expect(rangoDeMeses('diciembre y enero', HOY)).toEqual({ ok: true, desde: '2026-12-01', hasta: '2027-01-01', meses: 2 });
        expect(rangoDeMeses('de diciembre a febrero', HOY)).toEqual({ ok: true, desde: '2026-12-01', hasta: '2027-02-01', meses: 3 });
        expect(rangoDeMeses('enero', HOY)).toEqual({ ok: true, desde: '2027-01-01', hasta: '2027-01-01', meses: 1 });
        expect(rangoDeMeses('noviembre', HOY)).toMatchObject({ ok: true, desde: '2026-11-01' });
    });
    it('meses salteados no se adivinan', () => {
        expect(rangoDeMeses('diciembre y febrero', HOY)).toEqual({ ok: false, motivo: 'no_contiguos' });
        expect(rangoDeMeses('un tiempo', HOY)).toEqual({ ok: false, motivo: 'sin_meses' });
    });
    it('fecha de salida', () => {
        expect(fechaDeSalida('30 de noviembre', HOY)).toEqual({ ok: true, fecha: '2026-11-30' });
        expect(fechaDeSalida('fin de mes', HOY)).toEqual({ ok: true, fecha: '2026-11-30' });
        expect(fechaDeSalida('desde diciembre', HOY)).toEqual({ ok: true, fecha: '2026-12-01' });
        expect(fechaDeSalida('1 de noviembre', HOY)).toEqual({ ok: false, motivo: 'pasada' });
        expect(fechaDeSalida('no sé', HOY)).toEqual({ ok: false, motivo: 'sin_fecha' });
    });
    it('«sí» explícito: solo el mensaje completo', () => {
        for (const t of ['Sí', 'si', 'sí, confirmo', 'dale', 'Confirmo', 'ok', 'Listo']) expect(esSiExplicito(t)).toBe(true);
        for (const t of ['sí pero en 3 cuotas', 'no sé', 'bueno pues', 'sí, y además quiero otra cosa', 'tal vez sí', '']) expect(esSiExplicito(t)).toBe(false);
        expect(esSiExplicito('lo que sea', 'plan_si')).toBe(true);
        expect(esSiExplicito('sí', 'otro_boton')).toBe(false);
    });
    it('dinero con puntos', () => expect(pesos(1234567)).toBe('$1.234.567'));
});

// ─── Conversaciones con puertos falsos ───────────────────────────────────────

interface Cfg {
    topes?: { habilitado: boolean; maxCuotas: number; maxDias: number; autoAprobar: boolean };
    cobros?: { id: string; concept: string | null; due_date: string; saldo: number; status: string }[];
    pausaHabilitada?: boolean;
    inscripciones?: { id: string; nombre: string; equipo: string | null; estado: 'activa' | 'en_pausa' | 'retirada' }[];
    mias?: any[];
    acuerdoStatus?: 'activo' | 'solicitado';
    solicitarFalla?: boolean;
    pausaRespuesta?: any;
    crearFalla?: boolean;
}

const COBRO_1 = { id: 'pay-1', concept: 'Mensualidad noviembre', due_date: '2026-11-05', saldo: 150000, status: 'pending' };
const COBRO_2 = { id: 'pay-2', concept: 'Torneo diciembre', due_date: '2026-11-20', saldo: 80000, status: 'pending' };
const SARA = { id: 'enr-sara', nombre: 'Sara Gómez', equipo: 'Sub-15', estado: 'activa' as const };
const LUCAS = { id: 'enr-lucas', nombre: 'Lucas Gómez', equipo: 'Sub-13', estado: 'activa' as const };

function armar(cfg: Cfg = {}) {
    let reloj = T0;
    const recientes: FilaReciente[] = [];
    const salidas: { texto: string; paso: string; botones?: string[] }[] = [];
    const escaladas: { motivo: string; mensaje: string }[] = [];
    const calls = {
        solicitar: [] as any[], pausa: [] as any[], retiro: [] as any[], reactivacion: [] as any[], cancelar: [] as any[],
        cobrosAbiertos: 0, inscripciones: 0, topes: 0,
    };
    const topes = cfg.topes ?? { habilitado: true, maxCuotas: 3, maxDias: 60, autoAprobar: true };

    const puerto: Puertos = {
        async topes() { calls.topes++; return topes; },
        async cobrosAbiertos() { calls.cobrosAbiertos++; return cfg.cobros ?? [COBRO_1]; },
        async proponer({ paymentIds, cuotas, fechas }) {
            const todos = [COBRO_1, COBRO_2].filter((c) => paymentIds.includes(c.id));
            const total = todos.reduce((a, c) => a + c.saldo, 0);
            const n = cuotas ?? fechas?.length ?? 0;
            if (n < 1 || n > 12) return { ok: false, status: 400, error: 'cuotas_fuera_de_rango' };
            const fs = fechas ?? Array.from({ length: n }, (_, i) => `2026-${i < 2 ? '12' : '12'}-${String(5 + i * 10).padStart(2, '0')}`);
            if (fs[0] < HOY) return { ok: false, status: 400, error: 'fecha_pasada' };
            const base = Math.floor(total / n);
            const montos = Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base));
            const dias = Math.round((Date.parse(`${fs[n - 1]}T00:00:00Z`) - Date.parse(`${HOY}T00:00:00Z`)) / 86_400_000);
            const motivos: any[] = [];
            if (n > topes.maxCuotas) motivos.push('mas_cuotas_del_tope');
            if (dias > topes.maxDias) motivos.push('mas_dias_del_tope');
            return {
                ok: true, cobros: todos.map((c) => ({ ...c })), topes,
                calendario: {
                    cuotas: fs.map((f, i) => ({ seq: i + 1, fecha: f, monto: montos[i] })), saldoTotal: total,
                    primeraFecha: fs[0], ultimaFecha: fs[n - 1], dias, requiereAprobacion: motivos.length > 0 || !topes.autoAprobar, motivos,
                },
            };
        },
        async solicitar(p) {
            calls.solicitar.push(p);
            if (cfg.solicitarFalla) return { ok: false, status: 409, error: 'cobro_ya_en_acuerdo' };
            const status = cfg.acuerdoStatus ?? 'activo';
            return { ok: true, acuerdo: { agreement_id: 'acu-1', status, auto_approved: status === 'activo', total_amount: 0, installments: p.items.length } };
        },
        async habilitada() { return cfg.pausaHabilitada ?? true; },
        async inscripciones() { calls.inscripciones++; return cfg.inscripciones ?? [SARA]; },
        async pedirPausa(parentId, i) {
            calls.pausa.push({ parentId, ...i });
            if (cfg.crearFalla) return { ok: false, status: 422, error: 'regla', code: 'regla' };
            return { ok: true, data: cfg.pausaRespuesta ?? { request_id: 'r1', status: 'approved', auto_aprobada: true, fuera_de_tope: false } };
        },
        async pedirRetiro(parentId, i) {
            calls.retiro.push({ parentId, ...i });
            if (cfg.crearFalla) return { ok: false, status: 500, error: 'interno', code: 'interno' };
            return { ok: true, data: { request_id: 'r2', status: 'solicitado', kind: 'retiro' } };
        },
        async pedirReactivacion(parentId, i) {
            calls.reactivacion.push({ parentId, ...i });
            return { ok: true, data: { request_id: 'r3' } };
        },
        async cancelar(parentId, tipo, id) { calls.cancelar.push({ parentId, tipo, id }); return { ok: true, data: { status: 'cancelado' } }; },
        async mias() { return cfg.mias ?? []; },
        hoy: () => HOY,
        ahora: () => reloj,
    };

    const enviar = async (texto: string, paso: string, estado: any, botones?: any[]) => {
        salidas.push({ texto, paso, botones: botones?.map((b) => b.title) });
        recientes.unshift({
            direction: 'outbound', text_body: texto, created_at: new Date(reloj).toISOString(),
            payload: estado ? { step: paso, flujo: 'plan_whatsapp', paso_plan: estado.paso, datos_plan: estado.datos } : { step: paso },
        });
    };
    const escalar = async (motivo: string, mensaje: string) => {
        escaladas.push({ motivo, mensaje });
        recientes.unshift({ direction: 'outbound', text_body: mensaje, created_at: new Date(reloj).toISOString(), payload: { step: 'escalated' } });
    };

    async function di(texto: string, op: { botonId?: string | null; parentId?: string | null; discreto?: boolean; minutos?: number } = {}) {
        reloj += (op.minutos ?? 1) * MIN;
        const antes = salidas.length;
        const manejado = await atenderPlanYPlazos(
            { schoolId: ESCUELA, parentId: op.parentId === undefined ? PERFIL : op.parentId, texto, botonId: op.botonId ?? null, recientes, discreto: op.discreto },
            enviar, escalar, puerto);
        recientes.unshift({ direction: 'inbound', text_body: texto, created_at: new Date(reloj).toISOString() });
        return { manejado, salidas: salidas.slice(antes) };
    }
    const ultimo = () => salidas[salidas.length - 1]?.texto ?? '';
    return { di, ultimo, salidas, escaladas, calls, recientes };
}

// Ningún texto del bot en estos flujos puede hablar de mora, deuda, atraso, multa, recargo ni «gratis».
let todos: ReturnType<typeof armar>[] = [];
const armarYGuardar = (cfg?: Cfg) => { const c = armar(cfg); todos.push(c); return c; };
beforeEach(() => { todos = []; });
afterEach(() => {
    for (const c of todos) {
        for (const s of c.salidas) expect(s.texto, `texto del bot: ${s.texto}`).not.toMatch(PALABRAS_PROHIBIDAS);
        for (const e of c.escaladas) expect(e.mensaje).not.toMatch(PALABRAS_PROHIBIDAS);
    }
});

describe('Pagar por plazos', () => {
    it('un cobro: pregunta cuántas cuotas, propone el calendario, pide un sí explícito y crea', async () => {
        const c = armarYGuardar();
        const a = await c.di('quiero pagar por plazos');
        expect(a.manejado).toBe(true);
        expect(c.ultimo()).toContain('$150.000');
        expect(c.ultimo()).toMatch(/cuántas cuotas/i);
        expect(c.ultimo()).toContain('hasta 3 cuotas y 60 días');

        await c.di('2');
        expect(c.ultimo()).toMatch(/1\. 5 de diciembre — \$75\.000/);
        expect(c.ultimo()).toMatch(/2\. 15 de diciembre — \$75\.000/);
        expect(c.ultimo()).toMatch(/¿Confirmas/);
        expect(c.salidas.at(-1)!.botones).toEqual(['Sí, confirmo', 'No']);
        expect(c.calls.solicitar).toHaveLength(0);               // todavía NO se creó nada

        const fin = await c.di('sí');
        expect(fin.manejado).toBe(true);
        expect(c.calls.solicitar).toHaveLength(1);
        expect(c.calls.solicitar[0]).toMatchObject({
            schoolId: ESCUELA, paymentIds: ['pay-1'], payerProfileId: PERFIL,
            items: [{ due_date: '2026-12-05', amount: 75000 }, { due_date: '2026-12-15', amount: 75000 }],
        });
        expect(c.ultimo()).toMatch(/Quedó activo/);
        expect(c.ultimo()).toMatch(/comprobante/);
    });

    it('con cuotas y fechas en el mismo mensaje salta directo al resumen', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar la mensualidad el 15 y el 30');
        expect(c.ultimo()).toMatch(/15 de noviembre — \$75\.000/);
        expect(c.ultimo()).toMatch(/30 de noviembre — \$75\.000/);
        expect(c.ultimo()).toMatch(/¿Confirmas/);
        expect(c.calls.solicitar).toHaveLength(0);
    });

    it('fuera de los topes no se bloquea: queda «lo revisa la escuela y te avisa por aquí»', async () => {
        const c = armarYGuardar({ acuerdoStatus: 'solicitado' });
        await c.di('quiero pagar en cuotas');
        await c.di('4');
        expect(c.ultimo()).toMatch(/fuera de lo que la escuela aprueba directo/);
        await c.di('sí, confirmo');
        expect(c.calls.solicitar).toHaveLength(1);
        expect(c.ultimo()).toMatch(/la revisa y te avisa por aquí|ella la revisa y te avisa por aquí/);
        expect(c.ultimo()).not.toMatch(/Quedó activo/);
    });

    it('la escuela que revisa todo lo dice desde el principio', async () => {
        const c = armarYGuardar({ topes: { habilitado: true, maxCuotas: 3, maxDias: 60, autoAprobar: false } });
        await c.di('quiero pagar por plazos');
        expect(c.ultimo()).toMatch(/revisa cada solicitud/);
    });

    it('sin un «sí» explícito NO crea: «bueno pues», «sí pero en 3» y silencio no cuentan', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar por plazos');
        await c.di('2');
        await c.di('bueno pues');
        expect(c.calls.solicitar).toHaveLength(0);
        expect(c.ultimo()).toMatch(/necesito un \*Sí\* claro/);
        await c.di('sí pero en 3');
        expect(c.calls.solicitar).toHaveLength(0);
        // tercer intento sin entender: pasa a la escuela, no crea
        const f = await c.di('mmm no sé');
        expect(f.manejado).toBe(true);
        expect(c.calls.solicitar).toHaveLength(0);
        expect(c.escaladas.at(-1)?.motivo).toBe('plazos_no_entendido');
    });

    it('«no» cancela y no crea nada', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar por plazos');
        await c.di('3');
        await c.di('no');
        expect(c.calls.solicitar).toHaveLength(0);
        expect(c.ultimo()).toMatch(/no hice nada/);
        // y un «sí» posterior ya no tiene a qué responder
        const luego = await c.di('sí');
        expect(luego.manejado).toBe(false);
    });

    it('la confirmación vence a los 30 minutos', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar por plazos');
        await c.di('2');
        const tarde = await c.di('sí', { minutos: 31 });
        expect(tarde.manejado).toBe(true);
        expect(c.calls.solicitar).toHaveLength(0);
        expect(c.ultimo()).toMatch(/venció/);
    });

    it('varios cobros: lista y deja elegir (todos o por número)', async () => {
        const c = armarYGuardar({ cobros: [COBRO_1, COBRO_2] });
        await c.di('quiero pagar en cuotas');
        expect(c.ultimo()).toMatch(/1\. Mensualidad noviembre — \$150\.000/);
        expect(c.ultimo()).toMatch(/2\. Torneo diciembre — \$80\.000/);
        await c.di('2');   // solo el torneo
        expect(c.ultimo()).toContain('$80.000');
        await c.di('2');
        await c.di('sí');
        expect(c.calls.solicitar[0].paymentIds).toEqual(['pay-2']);
    });

    it('«todos» suma los cobros listados', async () => {
        const c = armarYGuardar({ cobros: [COBRO_1, COBRO_2] });
        await c.di('quiero pagar por plazos');
        await c.di('todos');
        expect(c.ultimo()).toContain('$230.000');
    });

    it('sin cobros abiertos: se lo dice y no crea', async () => {
        const c = armarYGuardar({ cobros: [] });
        const r = await c.di('quiero pagar por plazos');
        expect(r.manejado).toBe(true);
        expect(c.ultimo()).toMatch(/No veo cobros abiertos/);
        expect(c.calls.solicitar).toHaveLength(0);
    });

    it('fecha pasada: lo explica y vuelve a preguntar', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar por plazos');
        await c.di('el 15 de octubre y el 30 de octubre');
        expect(c.ultimo()).toMatch(/ya pasó/);
        expect(c.calls.solicitar).toHaveLength(0);
    });

    it('error del servicio al crear: lo revisará la escuela y queda en el buzón', async () => {
        const c = armarYGuardar({ solicitarFalla: true });
        await c.di('quiero pagar por plazos');
        await c.di('2');
        await c.di('sí');
        expect(c.escaladas).toHaveLength(1);
        expect(c.escaladas[0].mensaje).toMatch(/lo va a revisar la escuela/);
        expect(c.escaladas[0].motivo).toContain('plazos_error');
    });

    it('función apagada: no responde ni consulta cobros (comportamiento idéntico al actual)', async () => {
        const c = armarYGuardar({ topes: { habilitado: false, maxCuotas: 3, maxDias: 60, autoAprobar: true } });
        const r = await c.di('quiero pagar por plazos');
        expect(r.manejado).toBe(false);
        expect(c.salidas).toHaveLength(0);
        expect(c.calls.cobrosAbiertos).toBe(0);
    });

    it('persona NO identificada: no actúa', async () => {
        const c = armarYGuardar();
        const r = await c.di('quiero pagar por plazos', { parentId: null });
        expect(r.manejado).toBe(false);
        expect(c.salidas).toHaveLength(0);
        expect(c.calls.cobrosAbiertos).toBe(0);
        expect(c.calls.topes).toBe(0);
    });

    it('modo discreto: no actúa', async () => {
        const c = armarYGuardar();
        expect((await c.di('quiero pagar por plazos', { discreto: true })).manejado).toBe(false);
    });

    it('una pregunta suelta de precio o saldo no activa nada', async () => {
        const c = armarYGuardar();
        for (const t of ['cuánto debo', 'cuánto vale la mensualidad', 'ya pagué en dos cuotas']) {
            expect((await c.di(t)).manejado).toBe(false);
        }
        expect(c.salidas).toHaveLength(0);
    });

    it('en pleno flujo, una pregunta distinta lo suelta sin crear nada', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar por plazos');
        await c.di('2');
        const r = await c.di('¿a qué hora es el entreno de mañana?');
        expect(r.manejado).toBe(false);
        expect(c.calls.solicitar).toHaveLength(0);
    });

    it('un botón de otra cosa en pleno flujo no se toca', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar por plazos');
        await c.di('2');
        expect((await c.di('Ver mis pagos', { botonId: 'btn_pagos' })).manejado).toBe(false);
    });

    it('el botón «Sí, confirmo» confirma', async () => {
        const c = armarYGuardar();
        await c.di('quiero pagar por plazos');
        await c.di('2');
        await c.di('Sí, confirmo', { botonId: 'plan_si' });
        expect(c.calls.solicitar).toHaveLength(1);
    });

    it('un concepto con una palabra prohibida no se repite en el texto', async () => {
        const c = armarYGuardar({ cobros: [{ ...COBRO_1, concept: 'Mensualidad con recargo' }] });
        await c.di('quiero pagar por plazos');
        expect(c.ultimo()).not.toMatch(/recargo/i);
    });
});

describe('Pausar, retirar y reactivar el plan', () => {
    it('pausa: un hijo, meses en el mensaje → resumen → «sí» → crea con canal whatsapp', async () => {
        const c = armarYGuardar();
        await c.di('quiero congelar el plan de mi hija en diciembre y enero');
        expect(c.ultimo()).toMatch(/pausa.*Sara Gómez \(Sub-15\).*diciembre de 2026 a enero de 2027 \(2 meses completos\)/s);
        expect(c.ultimo()).toMatch(/¿Confirmas/);
        expect(c.calls.pausa).toHaveLength(0);
        await c.di('sí');
        expect(c.calls.pausa).toEqual([{ parentId: PERFIL, enrollment_id: 'enr-sara', reason: 'other', month_from: '2026-12-01', month_to: '2027-01-01' }]);
        expect(c.ultimo()).toMatch(/quedó \*aprobada\*/);
    });

    it('«voy a estar de viaje en diciembre» → pausa por vacaciones', async () => {
        const c = armarYGuardar();
        await c.di('voy a estar de viaje en diciembre');
        expect(c.ultimo()).toMatch(/pausa/);
        await c.di('sí');
        expect(c.calls.pausa[0]).toMatchObject({ reason: 'vacation', month_from: '2026-12-01', month_to: '2026-12-01' });
    });

    it('sin meses los pregunta; meses salteados no los adivina', async () => {
        const c = armarYGuardar();
        await c.di('quiero congelar el plan');
        expect(c.ultimo()).toMatch(/cuántos meses/i);
        await c.di('diciembre y febrero');
        expect(c.ultimo()).toMatch(/no van seguidos|seguidos/);
        expect(c.calls.pausa).toHaveLength(0);
        await c.di('de diciembre a febrero');
        expect(c.ultimo()).toMatch(/3 meses completos/);
    });

    it('pausa fuera del tope: queda en revisión y lo explica', async () => {
        const c = armarYGuardar({ pausaRespuesta: { request_id: 'r1', status: 'pending', auto_aprobada: false, fuera_de_tope: true } });
        await c.di('quiero pausar el plan en enero');
        await c.di('sí');
        expect(c.ultimo()).toMatch(/en revisión/);
        expect(c.ultimo()).toMatch(/supera los meses de pausa que la escuela aprueba directo/);
    });

    it('varios hijos: pregunta de cuál; no crea hasta confirmar; valida contra sus inscripciones', async () => {
        const c = armarYGuardar({ inscripciones: [SARA, LUCAS] });
        await c.di('quiero congelar el plan en enero');
        expect(c.ultimo()).toMatch(/1\. Sara Gómez \(Sub-15\)/);
        expect(c.ultimo()).toMatch(/2\. Lucas Gómez \(Sub-13\)/);
        expect(c.calls.pausa).toHaveLength(0);
        await c.di('2');
        expect(c.ultimo()).toMatch(/Lucas Gómez/);
        await c.di('sí');
        expect(c.calls.pausa[0]).toMatchObject({ enrollment_id: 'enr-lucas' });
    });

    it('si nombra a un hijo, lo toma; si nombra a los dos, va de a uno', async () => {
        const c = armarYGuardar({ inscripciones: [SARA, LUCAS] });
        await c.di('quiero pausar a Lucas en enero');
        expect(c.ultimo()).toMatch(/Lucas Gómez/);
        const d = armarYGuardar({ inscripciones: [SARA, LUCAS] });
        await d.di('quiero pausar a Sara y a Lucas en enero');
        expect(d.ultimo()).toMatch(/uno a la vez/i);
        expect(d.calls.pausa).toHaveLength(0);
    });

    it('un número que no es de la lista no elige nada', async () => {
        const c = armarYGuardar({ inscripciones: [SARA, LUCAS] });
        await c.di('quiero congelar el plan en enero');
        await c.di('5');
        expect(c.ultimo()).toMatch(/número o el nombre/);
        expect(c.calls.pausa).toHaveLength(0);
    });

    it('si entre la pregunta y el «sí» la inscripción deja de ser suya, no crea', async () => {
        const cfg: Cfg = { inscripciones: [SARA] };
        const c = armarYGuardar(cfg);
        await c.di('quiero congelar el plan en enero');
        cfg.inscripciones = []; // ya no figura a su nombre
        const r = await c.di('sí');
        expect(r.manejado).toBe(true);
        expect(c.calls.pausa).toHaveLength(0);
        expect(c.ultimo()).toMatch(/cambió|ya no aparece/);
    });

    it('retiro: pide la fecha, resume con claridad que es solo una solicitud y que no cancela nada', async () => {
        const c = armarYGuardar();
        await c.di('quiero retirarla del club');
        expect(c.ultimo()).toMatch(/Desde qué fecha/i);
        await c.di('30 de noviembre');
        expect(c.ultimo()).toMatch(/solo una \*solicitud\*/);
        expect(c.ultimo()).toMatch(/no se cancela nada hasta que la aprueben/);
        expect(c.ultimo()).toMatch(/yo no doy de baja a nadie/);
        expect(c.calls.retiro).toHaveLength(0);
        await c.di('sí');
        expect(c.calls.retiro).toEqual([{ parentId: PERFIL, enrollment_id: 'enr-sara', exit_date: '2026-11-30' }]);
        expect(Object.keys(c.calls.retiro[0])).not.toContain('dar_de_baja');
        expect(c.ultimo()).toMatch(/solicitud\* de retiro/);
        expect(c.ultimo()).toMatch(/No se cancela nada hasta que la aprueben/);
    });

    it('«ya no vamos a continuar» (frase real del club) también entra al retiro', async () => {
        const c = armarYGuardar();
        await c.di('buenas, ya no vamos a continuar este año, para el 30 de noviembre');
        expect(c.ultimo()).toMatch(/\*solicitado\* el retiro/);
        expect(c.ultimo()).toContain('30 de noviembre');
    });

    it('retiro con función apagada: no responde (sigue el camino de siempre: buzón)', async () => {
        const c = armarYGuardar({ pausaHabilitada: false });
        const t = 'mi hijo ya no va a seguir';
        expect(esSolicitudDeRetiro(t)).toBe(true);        // lo que hoy lo manda al buzón
        const r = await c.di(t);
        expect(r.manejado).toBe(false);
        expect(c.salidas).toHaveLength(0);
        expect(c.calls.inscripciones).toBe(0);
    });

    it('retiro sin identificación: no actúa', async () => {
        const c = armarYGuardar();
        expect((await c.di('quiero retirarla', { parentId: null })).manejado).toBe(false);
        expect(c.calls.inscripciones).toBe(0);
    });

    it('retiro sin inscripción activa a su nombre: cae al camino de siempre', async () => {
        const c = armarYGuardar({ inscripciones: [] });
        expect((await c.di('quiero retirarla del club')).manejado).toBe(false);
    });

    it('error del servicio al crear: lo revisará la escuela y queda en el buzón', async () => {
        const c = armarYGuardar({ crearFalla: true });
        await c.di('quiero retirarla, a fin de mes');
        await c.di('sí');
        expect(c.escaladas).toHaveLength(1);
        expect(c.escaladas[0].mensaje).toMatch(/lo va a revisar la escuela/);
    });

    it('«sí, pero…» no confirma un retiro', async () => {
        const c = armarYGuardar();
        await c.di('quiero retirarla a fin de mes');
        await c.di('sí pero antes quiero hablar con alguien');
        expect(c.calls.retiro).toHaveLength(0);
    });

    it('ambiguo (congelar o retirar): pregunta antes de crear nada', async () => {
        const c = armarYGuardar();
        await c.di('no sé si congelar el plan o retirarla');
        expect(c.ultimo()).toMatch(/congelar.*retirar/s);
        expect(c.calls.pausa.length + c.calls.retiro.length).toBe(0);
        await c.di('congelar');
        expect(c.ultimo()).toMatch(/cuántos meses/i);
    });

    it('la ausencia de una semana NO es un retiro ni una pausa', async () => {
        const c = armarYGuardar();
        for (const t of ['ya no puedo ir esta semana', 'mi hija no puede ir hoy', 'mañana no va a poder ir, está enferma']) {
            expect((await c.di(t)).manejado).toBe(false);
        }
        expect(c.salidas).toHaveLength(0);
    });

    it('reactivar: con una inscripción retirada pregunta el mes y crea tras el sí', async () => {
        const c = armarYGuardar({ inscripciones: [{ ...SARA, estado: 'retirada' }] });
        await c.di('quiero volver a entrenar');
        expect(c.ultimo()).toMatch(/Desde qué mes/i);
        await c.di('enero');
        expect(c.ultimo()).toMatch(/reactivación.*enero de 2027/s);
        await c.di('sí');
        expect(c.calls.reactivacion).toEqual([{ parentId: PERFIL, enrollment_id: 'enr-sara', from_month: '2027-01-01' }]);
    });

    it('reactivar sin inscripción retirada: no responde', async () => {
        const c = armarYGuardar({ inscripciones: [SARA] });
        expect((await c.di('quiero volver a entrenar')).manejado).toBe(false);
    });

    it('«mis solicitudes»: dice en qué estado van', async () => {
        const c = armarYGuardar({
            mias: [
                { id: 'a', tipo: 'pausa', school_id: ESCUELA, estado: 'solicitado', atleta_nombre: 'Sara Gómez', desde: '2026-12-01', hasta: '2027-01-01', creada_at: null },
                { id: 'b', tipo: 'retiro', school_id: ESCUELA, estado: 'aprobado', atleta_nombre: 'Lucas Gómez', desde: '2026-11-30', hasta: null, creada_at: null },
                { id: 'c', tipo: 'pausa', school_id: 'otra-escuela', estado: 'solicitado', atleta_nombre: 'Otra', desde: '2026-12-01', hasta: '2026-12-01', creada_at: null },
            ],
        });
        await c.di('cómo va mi solicitud de pausa');
        expect(c.ultimo()).toMatch(/Pausa de Sara Gómez \(de diciembre de 2026 a enero de 2027\): en revisión de la escuela/);
        expect(c.ultimo()).toMatch(/Retiro de Lucas Gómez \(salida el 30 de noviembre\): aprobada/);
        expect(c.ultimo()).not.toContain('Otra');   // solo las de esta escuela
    });

    it('cancelar una solicitud propia abierta: confirma y cancela con su id', async () => {
        const c = armarYGuardar({
            mias: [{ id: 'sol-9', tipo: 'retiro', school_id: ESCUELA, estado: 'solicitado', atleta_nombre: 'Sara Gómez', desde: '2026-11-30', hasta: null, creada_at: null }],
        });
        await c.di('cancela mi solicitud de retiro');
        expect(c.ultimo()).toMatch(/¿Cancelo tu solicitud de Retiro de Sara Gómez/);
        expect(c.calls.cancelar).toHaveLength(0);
        await c.di('sí');
        expect(c.calls.cancelar).toEqual([{ parentId: PERFIL, tipo: 'retiro', id: 'sol-9' }]);
    });

    it('cancelar sin solicitudes abiertas: se lo dice y no llama al servicio', async () => {
        const c = armarYGuardar({ mias: [] });
        await c.di('cancela mi solicitud de retiro');
        expect(c.ultimo()).toMatch(/No veo solicitudes abiertas/);
        expect(c.calls.cancelar).toHaveLength(0);
    });

    it('nombrados: coincide por nombre o apellido', () => {
        expect(nombrados('quiero pausar a lucas', [SARA, LUCAS])).toEqual([LUCAS]);
        expect(nombrados('quiero pausar a los gomez', [SARA, LUCAS])).toHaveLength(2);
        expect(nombrados('quiero pausar', [SARA, LUCAS])).toEqual([]);
    });
});
