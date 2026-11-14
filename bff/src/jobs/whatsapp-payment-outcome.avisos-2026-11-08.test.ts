/**
 * Huecos del aviso de desenlace (2026-11-08, aprobación automática de Monster y
 * los 19 comprobantes aprobados a mano):
 *   (a) el abono (partial) se avisa UNA vez por monto acreditado;
 *   (b) se confirma lo que la familia pagó (pronto pago), no `amount`;
 *   (c) torneo / clínica / vacacional fuera de la ventana → pago_recibido_otro_concepto,
 *       también vendidos a un prospecto sin ficha;
 *   (d) el rechazo dice el monto del COMPROBANTE, o ninguno;
 *   (e) sin opt-in, el pago o el abono se confirman por correo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { baseVacia, supabaseFalso, lecturas, type BaseFalsa } from './base-falsa.test-helpers';

const h = vi.hoisted(() => ({
    base: null as any,
    db: null as any,
    textos: [] as { to: string; texto: string }[],
    plantillas: [] as any[],
    respuestaPlantilla: { enviado: true, waMessageId: 'wamid.T', plantilla: 'x' } as any,
    correos: [] as any[],
    respuestaCorreo: 'enviado' as 'enviado' | 'duplicado' | 'fallo',
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (...a: any[]) => h.db.from(...a),
        rpc: (...a: any[]) => h.db.rpc(...a),
    },
}));
vi.mock('../services/whatsapp.service', () => ({
    sendTextMessage: vi.fn(async (_i: any, to: string, texto: string) => {
        h.textos.push({ to, texto });
        return { ok: true, waMessageId: `wamid.${h.textos.length}` };
    }),
    sendInteractiveButtons: vi.fn(async () => ({ ok: false })),
    aFormatoWhatsApp: (t: string) => t,
    decryptToken: () => 'token',
}));
vi.mock('../services/whatsapp-optin.service', () => ({ estaDadoDeBaja: async () => false, AVISO_DADO_DE_BAJA: '' }));
vi.mock('../services/whatsapp-tomada.service', () => ({ conversacionTomada: async () => false }));
vi.mock('../services/whatsapp-modo-discreto', () => ({ modoDiscreto: () => false, escuelaActiva: async () => false }));
vi.mock('../services/whatsapp-ajustes-escuela.service', () => ({ modoDiscretoEfectivo: async () => false }));
vi.mock('../services/cobro-enlace-publico.service', () => ({ emitirTokenCobro: async () => 'tok123' }));
vi.mock('../services/avisos-correo.service', () => ({
    enviarConReserva: vi.fn(async (p: any) => { h.correos.push(p); return h.respuestaCorreo; }),
}));
vi.mock('../services/whatsapp-plantillas.service', async (orig) => {
    const real = await orig<typeof import('../services/whatsapp-plantillas.service')>();
    return {
        ...real,
        enviarCobroPorPlantilla: vi.fn(async (p: any) => {
            h.plantillas.push(p);
            return h.respuestaPlantilla.enviado ? { ...h.respuestaPlantilla, plantilla: p.concepto } : h.respuestaPlantilla;
        }),
    };
});

import {
    runWhatsAppPaymentOutcome, desenlaceDelPago, montosDelAviso, textoDelDesenlace, fechaEnPalabras,
    plantillaDelDesenlace, separarAviso, conAviso, textoDelConcepto, datosCorreoRespaldo, claveCorreoRespaldo,
    debeRespaldarPorCorreo, permiteCorreoDeRespaldo, abonosAvisadosDelLote, VENTANA_ABONO_MS, datosDePlantilla,
} from './whatsapp-payment-outcome.job';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const TEL = '573001112233';
const HORA = 3600_000;
const ahora = Date.now();
const hace = (ms: number) => new Date(ahora - ms).toISOString();
const soloDigitos = (s: string) => s.replace(/[^\d]/g, '');

/** El escenario base: una fila de comprobante, su cobro, la integración y la conversación. */
function escenario(pago: Record<string, any>, opts: { ventanaAbierta?: boolean; fila?: Record<string, any> } = {}): BaseFalsa {
    const base = baseVacia({
        whatsapp_inbound_queue: [{
            id: 'q1', integration_id: 'int1', school_id: ESCUELA, wa_phone_number: TEL,
            result_type: 'payment_receipt', result_ref_id: 'pay1', message_type: 'image',
            error_message: null, outcome_notified_at: null, created_at: hace(5 * HORA), ...opts.fila,
        }],
        payments: [{
            id: 'pay1', school_id: ESCUELA, status: 'paid', amount: 145000, amount_paid: 0, concept: 'Mensualidad noviembre 2026',
            payment_category: 'mensualidad', payment_type: 'subscription', payment_channel: 'transfer', rejection_reason: null,
            parent_id: 'padre1', child_id: 'hijo1', unregistered_athlete_id: null, user_id: null, signup_lead_id: null,
            receipt_rejected_at: null, early_payment_discount_applied: null, ocr_amount: null, ocr_reference: 'M0001',
            due_date: '2026-11-05', approved_at: hace(1 * HORA), approved_by: 'admin1',
            receipt_amount_confirmed: null, receipt_amount_confirmed_at: null, ...pago,
        }],
        school_whatsapp_integrations: [{ id: 'int1', school_id: ESCUELA, status: 'active' }],
        whatsapp_conversations: [{
            id: 'conv1', integration_id: 'int1', contact_wa_id: TEL, parent_id: null,
            last_inbound_at: opts.ventanaAbierta === false ? hace(72 * HORA) : hace(2 * HORA),
        }],
        profiles: [{ id: 'padre1', full_name: 'CAROLINA GÓMEZ', email: 'Carolina@Ejemplo.co' }],
        children: [{ id: 'hijo1', full_name: 'SAMUEL GÓMEZ RUIZ' }],
        schools: [{ id: ESCUELA, name: 'Monster´s Volley Club' }],
        whatsapp_messages: [],
    });
    return base;
}

const fila = () => h.base.tablas.whatsapp_inbound_queue[0];
const pago = () => h.base.tablas.payments[0];

beforeEach(() => {
    h.textos = [];
    h.plantillas = [];
    h.correos = [];
    h.respuestaPlantilla = { enviado: true, waMessageId: 'wamid.T', plantilla: 'x' };
    h.respuestaCorreo = 'enviado';
});

function usar(base: BaseFalsa) {
    h.base = base;
    h.db = supabaseFalso(base);
}

// ─── (a) Abono ───────────────────────────────────────────────────────────────

describe('(a) abono: se avisa una sola vez por monto acreditado', () => {
    it('abono → texto con lo abonado, saldo y fecha límite; la fila sigue abierta; la vuelta siguiente no repite', async () => {
        usar(escenario({ status: 'partial', amount_paid: 50000, ocr_amount: 50000 }));

        const r1 = await runWhatsAppPaymentOutcome();
        expect(r1.avisados).toBe(1);
        expect(h.textos).toHaveLength(1);
        const t = h.textos[0].texto;
        expect(soloDigitos(t.match(/abono de \*([^*]+)\*/)![1])).toBe('50000');
        expect(soloDigitos(t.match(/Saldo pendiente: \*([^*]+)\*/)![1])).toBe('95000');
        expect(t).toContain('fecha límite: 5 de noviembre');
        expect(fila().outcome_notified_at).toBeNull();
        expect(fila().error_message).toBe('aviso_abono:50000:texto');

        // Misma plata acreditada: nada nuevo, y sin tocar la base para saberlo.
        const updatesAntes = h.base.llamadas.filter((l: any) => l.op === 'update').length;
        const r2 = await runWhatsAppPaymentOutcome();
        const r3 = await runWhatsAppPaymentOutcome();
        expect(r2.avisados + r3.avisados).toBe(0);
        expect(h.textos).toHaveLength(1);
        expect(h.base.llamadas.filter((l: any) => l.op === 'update').length).toBe(updatesAntes);
    });

    it('segundo abono → solo lo nuevo; al pagar el resto → «confirmó tu pago» de lo que faltaba y la fila se cierra', async () => {
        usar(escenario({ status: 'partial', amount_paid: 50000, ocr_amount: 50000 }));
        await runWhatsAppPaymentOutcome();

        Object.assign(pago(), { amount_paid: 80000, ocr_amount: 30000, approved_at: hace(0.5 * HORA) });
        await runWhatsAppPaymentOutcome();
        expect(h.textos).toHaveLength(2);
        expect(soloDigitos(h.textos[1].texto.match(/abono de \*([^*]+)\*/)![1])).toBe('30000');
        expect(soloDigitos(h.textos[1].texto.match(/Saldo pendiente: \*([^*]+)\*/)![1])).toBe('65000');
        expect(fila().error_message).toBe('aviso_abono:80000:texto');

        Object.assign(pago(), { status: 'paid', amount_paid: 145000, ocr_amount: 65000, approved_at: hace(0.1 * HORA) });
        await runWhatsAppPaymentOutcome();
        expect(h.textos).toHaveLength(3);
        expect(soloDigitos(h.textos[2].texto.match(/confirmó tu pago de \*([^*]+)\*/)![1])).toBe('65000');
        expect(fila().outcome_notified_at).not.toBeNull();
    });

    it('dos filas del mismo cobro: un solo aviso, y la marca queda en las dos', async () => {
        const base = escenario({ status: 'partial', amount_paid: 50000, ocr_amount: 50000 });
        base.tablas.whatsapp_inbound_queue.push({ ...base.tablas.whatsapp_inbound_queue[0], id: 'q2', created_at: hace(4 * HORA), error_message: 'recuperado: en_revision' });
        usar(base);
        await runWhatsAppPaymentOutcome();
        expect(h.textos).toHaveLength(1);
        expect(base.tablas.whatsapp_inbound_queue.map((f) => f.error_message)).toEqual([
            'aviso_abono:50000:texto', 'recuperado: en_revision | aviso_abono:50000:texto',
        ]);
    });

    it('fuera de la ventana: plantilla abono_recibido con monto, deportista, saldo y fecha en palabras', async () => {
        usar(escenario({ status: 'partial', amount_paid: 50000, ocr_amount: 50000 }, { ventanaAbierta: false }));
        await runWhatsAppPaymentOutcome();
        expect(h.textos).toHaveLength(0);
        expect(h.plantillas).toHaveLength(1);
        const p = h.plantillas[0];
        expect(p.concepto).toBe('abono_recibido');
        expect(soloDigitos(p.datos.montoAbono)).toBe('50000');
        expect(soloDigitos(p.datos.saldoPendiente)).toBe('95000');
        expect(p.datos.nombreAtleta).toBe('Samuel Gómez');
        expect(p.datos.fechaVencimiento).toBe('5 de noviembre');
        expect(fila().error_message).toBe('aviso_abono:50000:plantilla abono_recibido');
        await runWhatsAppPaymentOutcome();
        expect(h.plantillas).toHaveLength(1);
    });

    it('abono sin fecha límite o de un torneo: sin plantilla (no se le miente con «la mensualidad»)', () => {
        expect(plantillaDelDesenlace('partial', 'Mensualidad', { payment_category: 'mensualidad', due_date: null })).toHaveProperty('motivo');
        expect(plantillaDelDesenlace('partial', 'Torneo Copa', { payment_category: 'torneo', due_date: '2026-11-20' })).toHaveProperty('motivo');
        expect(plantillaDelDesenlace('partial', 'Mensualidad', { payment_category: 'mensualidad', due_date: '2026-11-05' }))
            .toEqual({ concepto: 'abono_recibido' });
    });

    it('desenlace partial: solo si se aprobó DESPUÉS de la fila y hace menos de 72 h', () => {
        const llego = hace(10 * HORA);
        expect(desenlaceDelPago({ status: 'partial', amount_paid: 1, approved_at: hace(1 * HORA) }, llego, ahora)).toBe('partial');
        // Abono anterior al comprobante (efectivo de antes): no es de esta fila.
        expect(desenlaceDelPago({ status: 'partial', amount_paid: 1, approved_at: hace(20 * HORA) }, llego, ahora)).toBeNull();
        // Abono viejo: al desplegar no salen de golpe los de semanas atrás.
        expect(desenlaceDelPago({ status: 'partial', amount_paid: 1, approved_at: hace(VENTANA_ABONO_MS + HORA) }, hace(VENTANA_ABONO_MS * 2), ahora)).toBeNull();
        // Rechazo posterior gana sobre el abono.
        expect(desenlaceDelPago({ status: 'partial', amount_paid: 1, approved_at: hace(1 * HORA), receipt_rejected_at: hace(0.5 * HORA) }, llego, ahora)).toBe('rejected');
        expect(desenlaceDelPago({ status: 'partial', amount_paid: 0, approved_at: hace(1 * HORA) }, llego, ahora)).toBeNull();
    });

    it('marca del abono: ida y vuelta, y el mayor monto avisado por cobro', () => {
        const em = conAviso('recuperado: x', { tipo: 'abono', pagado: 80000, detalle: 'plantilla abono_recibido' });
        expect(em).toBe('recuperado: x | aviso_abono:80000:plantilla abono_recibido');
        expect(separarAviso(em)).toEqual({ base: 'recuperado: x', aviso: { tipo: 'abono', pagado: 80000, detalle: 'plantilla abono_recibido' } });
        expect(separarAviso('aviso_por_correo: sin_optin')).toEqual({ base: null, aviso: { tipo: 'por_correo', detalle: 'sin_optin' } });
        expect(abonosAvisadosDelLote([
            { result_ref_id: 'p', error_message: 'aviso_abono:50000:texto' },
            { result_ref_id: 'p', error_message: 'x | aviso_abono:80000:texto' },
            { result_ref_id: 'o', error_message: null },
        ])).toEqual(new Map([['p', 80000]]));
    });
});

// ─── (b) Pronto pago ─────────────────────────────────────────────────────────

describe('(b) el pago confirmado dice lo que la familia pagó', () => {
    const PRONTO = { status: 'paid', amount: 145000, early_payment_discount_applied: 7250, ocr_amount: 137750 };

    it.each([
        ['amount_paid nuevo (amount − pronto pago)', 137750],
        ['amount_paid viejo (= amount, los 19 de hoy)', 145000],
    ])('pronto pago con %s → «$137.750», no «$145.000»', async (_n, amountPaid) => {
        usar(escenario({ ...PRONTO, amount_paid: amountPaid }));
        await runWhatsAppPaymentOutcome();
        const t = h.textos[0].texto;
        expect(soloDigitos(t.match(/confirmó tu pago de \*([^*]+)\*/)![1])).toBe('137750');
        expect(t).not.toMatch(/145\.000/);
    });

    it('fuera de la ventana: pago_confirmado con el monto pagado', async () => {
        usar(escenario({ ...PRONTO, amount_paid: 137750 }, { ventanaAbierta: false }));
        await runWhatsAppPaymentOutcome();
        expect(h.plantillas[0].concepto).toBe('pago_confirmado');
        expect(soloDigitos(h.plantillas[0].datos.monto)).toBe('137750');
        expect(fila().error_message).toBe('aviso_por_plantilla:pago_confirmado');
    });

    it('link pagado en línea sin amount_paid (Wompi exacto) → amount − pronto pago', () => {
        const m = montosDelAviso({ status: 'paid', amount: 145000, amount_paid: null, early_payment_discount_applied: 7250, ocr_amount: 999 }, { esComprobante: false });
        expect(m.pagado).toBe(137750);
    });

    it('el valor que confirmó la escuela en ESTA aprobación manda; uno de una aprobación anterior no', () => {
        const aprobado = '2026-11-08T15:00:00.000Z';
        expect(montosDelAviso({
            status: 'paid', amount: 145000, amount_paid: 145000, ocr_amount: 140000,
            approved_at: aprobado, receipt_amount_confirmed: 145000, receipt_amount_confirmed_at: aprobado,
        }, { esComprobante: true }).pagado).toBe(145000);
        expect(montosDelAviso({
            status: 'paid', amount: 145000, amount_paid: 145000, ocr_amount: 95000,
            approved_at: aprobado, receipt_amount_confirmed: 50000, receipt_amount_confirmed_at: '2026-11-01T10:00:00.000Z',
        }, { esComprobante: true, abonoAvisado: 50000 }).pagado).toBe(95000);
    });

    it('un comprobante de varios meses (ocr mayor a lo del cobro) no se le atribuye entero', () => {
        expect(montosDelAviso({ status: 'paid', amount: 150000, amount_paid: 150000, ocr_amount: 450000 }, { esComprobante: true }).pagado).toBe(150000);
    });
});

// ─── (c) Otro concepto ───────────────────────────────────────────────────────

describe('(c) torneo, clínica o vacacional fuera de la ventana', () => {
    it.each([
        ['clase_extra', 'Clínica de saque — Juan Pérez'],
        ['vacacional', 'Vacacional diciembre'],
        ['torneo', 'Torneo Copa Bogotá'],
        [null, 'Clínica de armadores'],
        [null, 'Vacacional de fin de año'],
        [null, 'Inscripción torneo regional'],
    ])('categoría %s «%s» → pago_recibido_otro_concepto', (cat, concepto) => {
        expect(plantillaDelDesenlace('paid', concepto, { payment_category: cat })).toEqual({ concepto: 'pago_recibido_otro_concepto' });
    });

    it('clínica vendida a un prospecto (sin ficha): el deportista sale del prospecto y no falla por dato_faltante', async () => {
        const base = escenario({
            status: 'paid', amount: 120000, amount_paid: 120000, ocr_amount: 120000, payment_category: 'clase_extra',
            concept: 'Clínica de saque — Juan Pérez', parent_id: null, child_id: null, signup_lead_id: 'lead1',
        }, { ventanaAbierta: false });
        base.tablas.school_signup_leads = [{ id: 'lead1', full_name: 'JUAN PÉREZ', guardian_name: 'Marta Pérez' }];
        usar(base);
        await runWhatsAppPaymentOutcome();
        const p = h.plantillas[0];
        expect(p.concepto).toBe('pago_recibido_otro_concepto');
        expect(p.datos.nombreAtleta).toBe('Juan Pérez');
        expect(p.datos.conceptoPago).toBe('Clínica de saque');
        expect(p.datos.nombreEscuela).toBe('Monster´s Volley Club');
        expect(soloDigitos(p.datos.monto)).toBe('120000');
    });

    it('textoDelConcepto quita el nombre que va detrás de « — »', () => {
        expect(textoDelConcepto('Inscripción — PLAN RM MENSUAL — Atleta')).toBe('Inscripción');
        expect(textoDelConcepto('Uniforme talla M')).toBe('Uniforme talla M');
    });
});

// ─── (d) Rechazo ─────────────────────────────────────────────────────────────

describe('(d) el rechazo dice el monto del comprobante', () => {
    const RECHAZO = {
        status: 'pending', amount: 155000, amount_paid: 0, ocr_amount: 117750,
        receipt_rejected_at: hace(1 * HORA), rejection_reason: 'El valor del comprobante no coincide con el cobro.',
    };

    it('caso real: comprobante de $117.750 sobre un cobro de $155.000', async () => {
        usar(escenario(RECHAZO));
        await runWhatsAppPaymentOutcome();
        const t = h.textos[0].texto;
        expect(soloDigitos(t.match(/comprobante de \*([^*]+)\*/)![1])).toBe('117750');
        expect(t).not.toMatch(/155\.000/);
        expect(t).toContain('*Motivo:* El valor del comprobante no coincide');
    });

    it('sin monto leído no dice monto; la plantilla usa «el pago»', async () => {
        usar(escenario({ ...RECHAZO, ocr_amount: null }, { ventanaAbierta: false }));
        await runWhatsAppPaymentOutcome();
        expect(h.plantillas[0].concepto).toBe('comprobante_rechazado');
        expect(h.plantillas[0].datos.monto).toBe('el pago');
        const t = textoDelDesenlace('rejected', { concept: 'Mensualidad', rejection_reason: null },
            montosDelAviso({ status: 'pending', amount: 155000 }, { esComprobante: true }));
        expect(t).toMatch(/^La escuela revisó tu comprobante por \*Mensualidad\*/);
    });

    it('fuera de la ventana: comprobante_rechazado con el monto del comprobante', async () => {
        usar(escenario(RECHAZO, { ventanaAbierta: false }));
        await runWhatsAppPaymentOutcome();
        expect(soloDigitos(h.plantillas[0].datos.monto)).toBe('117750');
    });
});

// ─── (e) Respaldo por correo ─────────────────────────────────────────────────

describe('(e) sin opt-in, respaldo por correo', () => {
    it('pago con pronto pago, plantilla sin opt-in → payment_confirmation al acudiente con lo pagado', async () => {
        h.respuestaPlantilla = { enviado: false, motivo: 'sin_optin' };
        usar(escenario({ status: 'paid', amount: 145000, early_payment_discount_applied: 7250, amount_paid: 137750, ocr_amount: 137750 }, { ventanaAbierta: false }));
        const r = await runWhatsAppPaymentOutcome();
        expect(r.avisados).toBe(1);
        expect(h.correos).toHaveLength(1);
        const c = h.correos[0];
        expect(c.plantilla).toBe('payment_confirmation');
        expect(c.destinos).toEqual(['carolina@ejemplo.co']);
        expect(c.clave).toBe(claveCorreoRespaldo('pay1', 'paid', 137750));
        expect(c.data).toMatchObject({ userName: 'CAROLINA GÓMEZ', schoolName: 'Monster´s Volley Club', concept: 'Mensualidad noviembre 2026', reference: 'M0001' });
        expect(soloDigitos(c.data.amount)).toBe('137750');
        expect(fila().error_message).toBe('aviso_por_correo: sin_optin');
        expect(fila().outcome_notified_at).not.toBeNull();
    });

    it('abono sin opt-in → correo que dice que es un abono y el saldo, una sola vez', async () => {
        h.respuestaPlantilla = { enviado: false, motivo: 'sin_optin' };
        usar(escenario({ status: 'partial', amount_paid: 50000, ocr_amount: 50000 }, { ventanaAbierta: false }));
        await runWhatsAppPaymentOutcome();
        await runWhatsAppPaymentOutcome();
        expect(h.correos).toHaveLength(1);
        expect(h.correos[0].data.concept).toMatch(/^Abono a Mensualidad noviembre 2026 · saldo pendiente \$\s?95\.000$/);
        expect(soloDigitos(h.correos[0].data.amount)).toBe('50000');
        expect(fila().error_message).toBe('aviso_abono:50000:correo (sin_optin)');
    });

    it('aprobado por la aprobación automática (approved_by NULL): no se duplica el correo que ya mandó', async () => {
        h.respuestaPlantilla = { enviado: false, motivo: 'sin_optin' };
        usar(escenario({ status: 'paid', amount_paid: 145000, ocr_amount: 145000, approved_by: null }, { ventanaAbierta: false }));
        await runWhatsAppPaymentOutcome();
        expect(h.correos).toHaveLength(0);
        expect(fila().error_message).toMatch(/^aviso_no_entregado: ventana cerrada; plantilla: sin_optin/);
    });

    it('otros motivos (plantilla no aprobada) y el rechazo no se respaldan por correo; sin correo del acudiente queda anotado', async () => {
        expect(debeRespaldarPorCorreo('paid', 'plantilla_no_aprobada')).toBe(false);
        expect(debeRespaldarPorCorreo('rejected', 'sin_optin')).toBe(false);
        expect(debeRespaldarPorCorreo('partial', 'sin_optin')).toBe(true);
        expect(permiteCorreoDeRespaldo({ approved_by: 'a' }, 'paid', true)).toBe(false);

        h.respuestaPlantilla = { enviado: false, motivo: 'sin_optin' };
        const base = escenario({ status: 'paid', amount_paid: 145000 }, { ventanaAbierta: false });
        base.tablas.profiles[0].email = null;
        usar(base);
        await runWhatsAppPaymentOutcome();
        expect(h.correos).toHaveLength(0);
        expect(fila().error_message).toContain('sin correo del acudiente');
    });

    it('datosCorreoRespaldo quita < y > (send-email no escapa)', () => {
        const d = datosCorreoRespaldo({
            desenlace: 'paid', acudiente: '<b>Ana</b>', escuela: 'Club', concepto: 'Mensualidad <script>',
            montos: { pagado: 100, comprobante: null, saldo: 0, pagadoTotal: 100 }, referencia: 'R1',
        });
        expect(d.userName).toBe('bAna/b');
        expect(d.concept).not.toMatch(/[<>]/);
    });
});

describe('utilidades', () => {
    it('fechaEnPalabras: en palabras, con el año solo si no es el de hoy', () => {
        const nov2026 = Date.parse('2026-11-08T15:00:00Z');
        expect(fechaEnPalabras('2026-11-05', nov2026)).toBe('5 de noviembre');
        expect(fechaEnPalabras('2027-01-05', nov2026)).toBe('5 de enero de 2027');
        expect(fechaEnPalabras(null, nov2026)).toBeNull();
        expect(fechaEnPalabras('basura', nov2026)).toBeNull();
    });

    it('datosDePlantilla: pagado → lo pagado; rechazo → el comprobante', () => {
        const m = { pagado: 137750, comprobante: 117750, saldo: 0, pagadoTotal: 137750 };
        const n = { atleta: 'Samuel', contacto: 'Carolina', escuela: 'Monster' };
        expect(soloDigitos(datosDePlantilla({ concept: 'X' }, 'paid', m, n).monto)).toBe('137750');
        expect(soloDigitos(datosDePlantilla({ concept: 'X' }, 'rejected', m, n).monto)).toBe('117750');
    });

    it('una vuelta lee los pagos del lote en UNA consulta', async () => {
        usar(escenario({ status: 'awaiting_approval' }));
        await runWhatsAppPaymentOutcome();
        expect(lecturas(h.base, 'payments')).toBe(1);
        expect(h.textos).toHaveLength(0);
    });
});
