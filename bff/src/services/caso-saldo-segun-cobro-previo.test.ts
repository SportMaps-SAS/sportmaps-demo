/**
 * Monster 2026-11-19: el saldo y el abono mínimo salen del COBRO que la persona ya tiene, no del precio de hoy.
 * Una familia abonó $150.000 el 10-nov (preventa $300.000, cobro por $300.000); el 19-nov el bot dijo «el saldo
 * pendiente es $166.250, igual que el abono mínimo» (mitad de $332.500, el precio de ese día). Correcto: $150.000.
 * Nombres inventados.
 */
import { describe, it, expect } from 'vitest';
import { fichaDeServicioParaIa } from './whatsapp-catalogo-para-ia';
import { permitidosDeServicio, promptDeServicio } from './whatsapp-servicio-ia';
import { verificarSalida } from './whatsapp-verificador-montos';
import { crearCobroPrevioDelTurno, enviarPagoDeServicio, textoDePagoDeServicio, type CtxVentaServicio } from './whatsapp-venta-servicio';
import type { ItemConFicha } from './whatsapp-anuncio-destino';

const CLINICA: ItemConFicha = {
    id: '00000000-0000-4000-8000-000000000001', name: 'Clínica de ejemplo', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00+00:00', ends_at: '2026-11-23T04:59:00+00:00',
    allow_installments: true, precio_afiliado: null, precios_por_fecha: [{ desde: '2026-11-11', precio: 332500 }],
    abono_minimo_pct: 50, opciones: null, description: 'Dos jornadas de aprendizaje.',
};
const CUENTAS = [{ tipo: 'Nequi', numero: '3001234567', titular: 'Persona Inventada' }];
const HOY = '2026-11-19';
const base = { item: CLINICA, afiliado: false, cuentas: CUENTAS, hoy: HOY };
const COBRO_ABONADO = { amount: 300000, amountPaid: 150000 };

describe('quien ya abonó: el saldo es el de SU cobro', () => {
    it('la ficha para la IA da el saldo $150.000 y no el precio de hoy ni la mitad de $332.500', () => {
        const f = fichaDeServicioParaIa(CLINICA, { ...base, cobroPrevio: COBRO_ABONADO });
        expect(f).toContain('$150.000');
        expect(f).toContain('saldo pendiente $150.000');
        expect(f).not.toContain('166.250');
        expect(f).not.toContain('332.500');
        expect(f).not.toMatch(/Abono mínimo para separar/);
        expect(promptDeServicio({ ...base, cobroPrevio: COBRO_ABONADO })).toContain('SALDO');
    });

    it('el verificador acepta el saldo real y rechaza el recalculado', () => {
        const p = permitidosDeServicio({ ...base, cobroPrevio: COBRO_ABONADO });
        expect(verificarSalida('Te quedan *$150.000* por pagar de tu cobro de $300.000.', p, { hoy: HOY }).ok).toBe(true);
        const mal = verificarSalida('El saldo pendiente es $166.250, igual que el abono mínimo (50 %).', p, { hoy: HOY });
        expect(mal.ok).toBe(false);
        // Abono de $150.000 junto al precio de otra fecha ($332.500): también se rechaza.
        expect(verificarSalida('Con tu abono de $150.000 el valor es $332.500.', p, { hoy: HOY }).ok).toBe(false);
    });

    it('otro caso: abonó $125.000 sobre una tarifa de $300.000, queda $175.000 (no «$125.000 de $300.000»)', () => {
        const cobro = { amount: 300000, amountPaid: 125000 };
        const f = fichaDeServicioParaIa(CLINICA, { ...base, cobroPrevio: cobro });
        expect(f).toContain('saldo pendiente $175.000');
        const p = permitidosDeServicio({ ...base, cobroPrevio: cobro });
        expect(verificarSalida('Te faltan $175.000.', p, { hoy: HOY }).ok).toBe(true);
        expect(verificarSalida('Te faltan $166.250.', p, { hoy: HOY }).ok).toBe(false);
    });

    it('el mensaje de pago dice el saldo, nunca «abono» con el precio de otra fecha', () => {
        const t = textoDePagoDeServicio(CLINICA, null, CUENTAS, { hoy: HOY, cobroPrevio: COBRO_ABONADO });
        expect(t).toContain('saldo pendiente es *$150.000*');
        expect(t).not.toContain('332.500');
        expect(t).not.toContain('166.250');
        expect(t).not.toMatch(/abono mínimo/i);
    });

    it('enviarPagoDeServicio usa el cobro de la persona (ctx.cobroPrevio)', async () => {
        const enviados: string[] = [];
        const ctx = {
            schoolId: 's', conversationId: 'c', recientes: [],
            afiliado: async () => false, cuentas: async () => CUENTAS,
            guardarLead: async () => null, registrarEsperado: async () => true,
            responderPregunta: async () => ({ tipo: 'no_se', motivo: 'x' }),
            enviar: async (t: string) => { enviados.push(t); },
            avisarEscuela: async () => {},
            ahora: () => new Date('2026-11-19T15:00:00Z'),
            cobroPrevio: async () => COBRO_ABONADO,
        } as unknown as CtxVentaServicio;
        await enviarPagoDeServicio(ctx, CLINICA);
        expect(enviados[0]).toContain('$150.000');
        expect(enviados[0]).not.toContain('166.250');
    });
});

describe('quien NO tiene cobro previo sigue viendo el precio vigente', () => {
    it('sin cobro (o con cobro sin abono) la ficha trae el valor de hoy y el abono del catálogo', () => {
        for (const cobroPrevio of [undefined, null, { amount: 300000, amountPaid: 0 }]) {
            const f = fichaDeServicioParaIa(CLINICA, { ...base, cobroPrevio });
            expect(f).toContain('Valor hoy');
            expect(f).toContain('$332.500');
            expect(f).toContain('Abono mínimo para separar el cupo: $166.250');
        }
    });

    it('el verificador sigue aceptando el catálogo de hoy', () => {
        const p = permitidosDeServicio(base);
        expect(verificarSalida('Hoy vale $332.500; separas con $166.250.', p, { hoy: HOY }).ok).toBe(true);
    });

    it('el mensaje de pago trae el precio de hoy y el abono mínimo', () => {
        const t = textoDePagoDeServicio(CLINICA, null, CUENTAS, { hoy: HOY });
        expect(t).toContain('$332.500');
        expect(t).toContain('$166.250');
    });
});

describe('conexión: el hook del turno entrega el cobro del prospecto a la IA', () => {
    it('con un cobro de $300.000 y $150.000 abonados, la IA recibe saldo $150.000 (una lectura por ítem)', async () => {
        let lecturas = 0;
        const hook = crearCobroPrevioDelTurno({
            omitir: false,
            leadId: async () => 'lead-inventado',
            cobro: async (dueno) => { lecturas++; expect(dueno).toEqual({ leadId: 'lead-inventado' }); return COBRO_ABONADO; },
        });
        const recibido: unknown[] = [];
        const ctx = {
            schoolId: 's', conversationId: 'c', recientes: [],
            afiliado: async () => false, cuentas: async () => CUENTAS,
            guardarLead: async () => null, registrarEsperado: async () => true,
            responderPregunta: async (p: any) => { recibido.push(p.cobroPrevio); return { tipo: 'no_se', motivo: 'x' }; },
            enviar: async () => {}, avisarEscuela: async () => {},
            ahora: () => new Date('2026-11-19T15:00:00Z'), cobroPrevio: hook,
        } as unknown as CtxVentaServicio;
        await ctx.responderPregunta({ ...base, schoolId: 's', conversationId: 'c', pregunta: '¿cuánto falta?', recientes: [], cobroPrevio: await ctx.cobroPrevio!(CLINICA) } as any);
        await ctx.cobroPrevio!(CLINICA);
        const c = recibido[0] as { amount: number; amountPaid: number };
        expect(c.amount - c.amountPaid).toBe(150000);
        expect(lecturas).toBe(1);
    });

    it('familia/simulación o cualquier falla: null (sigue el precio vigente)', async () => {
        expect(await crearCobroPrevioDelTurno({ omitir: true, leadId: async () => 'x', cobro: async () => COBRO_ABONADO })(CLINICA)).toBeNull();
        expect(await crearCobroPrevioDelTurno({ omitir: false, leadId: async () => { throw new Error('db'); }, cobro: async () => COBRO_ABONADO })(CLINICA)).toBeNull();
        expect(await crearCobroPrevioDelTurno({ omitir: false, leadId: async () => null, cobro: async () => COBRO_ABONADO })(CLINICA)).toBeNull();
    });
});
