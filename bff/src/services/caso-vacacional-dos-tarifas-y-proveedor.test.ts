/**
 * Monster 2026-11-20. (1) Vacacional: con el teléfono sin identificar como afiliado la IA ve y puede decir las DOS tarifas
 * (antes solo externos y «no tengo otro valor para quien no sea afiliado»). (2) Un proveedor que COBRA a la escuela no
 * recibe datos de pago ni se toma su enlace como nombre de asistente. Nombres inventados.
 */
import { describe, it, expect } from 'vitest';
import { fichaDeServicioParaIa } from './whatsapp-catalogo-para-ia';
import { permitidosDeServicio } from './whatsapp-servicio-ia';
import { verificarSalida } from './whatsapp-verificador-montos';
import { atenderVentaDeServicio, reclamaPagoALaEscuela, textoDePagoDeServicio, type CtxVentaServicio } from './whatsapp-venta-servicio';
import { nombreDeAsistente } from './whatsapp-comprobante-de-ficha.service';
import { valorDeAfiliadoQueCoincide } from './wa-cobro-desde-comprobante.service';
import type { ItemConFicha } from './whatsapp-anuncio-destino';

const VAC = {
    id: '00000000-0000-4000-8000-000000000002', name: 'Vacacional de ejemplo', kind: 'vacacional', price: null,
    active: true, event_id: null, starts_at: null, ends_at: '2099-12-31T00:00:00Z',
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
        { clave: '4', etiqueta: '4 semanas', precio: 200000, precio_afiliado: 170000 },
    ],
} as unknown as ItemConFicha;
const HOY = '2026-11-20';
const base = { item: VAC, cuentas: [], hoy: HOY };

describe('vacacional: teléfono sin identificar → las dos tarifas', () => {
    it('la ficha trae afiliados y externos de cada opción y prohíbe asumir externos', () => {
        const f = fichaDeServicioParaIa(VAC, { ...base, afiliado: false });
        expect(f).toContain('2 semanas: afiliados $120.000 · externos $140.000');
        expect(f).toContain('NUNCA asumas que es externa');
        expect(f).not.toContain('no des la cifra');
    });
    it('el verificador acepta ambas tarifas', () => {
        const p = permitidosDeServicio({ ...base, afiliado: false });
        expect(verificarSalida('2 semanas: afiliados $120.000, externos $140.000.', p, { hoy: HOY }).ok).toBe(true);
        expect(verificarSalida('2 semanas: $130.000.', p, { hoy: HOY }).ok).toBe(false);
    });
    it('afiliado identificado: sigue como hoy (solo la suya)', () => {
        const f = fichaDeServicioParaIa(VAC, { ...base, afiliado: true });
        expect(f).toContain('2 semanas: $120.000');
        expect(f).not.toContain('externos');
    });
    it('el texto de pago da las dos y pide que diga cuál es', () => {
        const t = textoDePagoDeServicio(VAC, null, [], { hoy: HOY });
        expect(t).toContain('(afiliados *$120.000*)');
        expect(t).toContain('cuéntame cuál es tu caso');
    });
    it('quien pagó $120.000 por 2 semanas es afiliada, no «no coincide»', () => {
        expect(valorDeAfiliadoQueCoincide(VAC, 120000, Date.parse(`${HOY}T10:00:00-05:00`))).toMatchObject({ monto: 120000 });
    });
});

describe('proveedor que cobra a la escuela', () => {
    const MENSAJES = [
        'Buenas tardes, me colaboras con un pago pendiente que tenemos de $245.000, puedes pagar en este enlace https://pagos.ejemplo.io/abc123',
        'Por favor me colaboras con el pago de la factura 123',
        'Les envío la cuenta de cobro de este mes',
    ];
    it('lo detecta', () => { for (const m of MENSAJES) expect(reclamaPagoALaEscuela(m, VAC)).toBe(true); });
    it('un cliente que quiere pagar NO entra', () => {
        for (const m of ['cuánto vale el vacacional?', 'me colaboras con el pago del vacacional', 'quiero pagar el cupo', 'dónde pago?'])
            expect(reclamaPagoALaEscuela(m, VAC)).toBe(false);
    });
    it('atenderVentaDeServicio no da datos de pago: avisa a la escuela', async () => {
        const enviados: string[] = []; const avisos: string[] = [];
        const ctx = {
            schoolId: 's', conversationId: 'c', recientes: [], afiliado: async () => false,
            cuentas: async () => [{ tipo: 'Nequi', numero: '3001234567', titular: 'Persona Inventada' }],
            guardarLead: async () => 'lead', registrarEsperado: async () => true,
            responderPregunta: async () => ({ tipo: 'no_se', motivo: 'x' }),
            enviar: async (t: string) => { enviados.push(t); }, avisarEscuela: async (d: string) => { avisos.push(d); },
        } as unknown as CtxVentaServicio;
        const r = await atenderVentaDeServicio(ctx, { item: VAC, desde: null } as any, MENSAJES[0]);
        expect(r).toBe('venta_a_la_escuela');
        expect(enviados).toEqual([]);
        expect(avisos).toHaveLength(1);
    });
    it('una URL nunca es nombre de asistente', () => {
        expect(nombreDeAsistente('https://pagos.ejemplo.io/abc')).toBeNull();
        expect(nombreDeAsistente('pagos.ejemplo.io')).toBeNull();
        expect(nombreDeAsistente('puedes pagar en este enlace')).toBeNull();
        expect(nombreDeAsistente('Camila Rojas Prueba')).toBe('Camila Rojas Prueba');
    });
});
