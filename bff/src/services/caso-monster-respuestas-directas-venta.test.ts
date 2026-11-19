/**
 * Monster 14–16 nov 2026 (reporte del bot): respuestas claras y concretas en la venta de un servicio (clínica,
 * vacacional). Cada prueba usa la frase real que falló. Sin base ni Meta.
 *
 *   a. El bloque de pago completo sale UNA vez; después, una línea con lo que pidió (plazo, llave, Nequi, valor).
 *   b. Un solo mensaje por turno: «Ya le pasé tu pregunta» + «Anotado…» juntos ya no salen; «Profe una pregunta» → «dime».
 *   c. «3 semanas» (texto libre) devuelve la opción y su valor.
 *   d. «¿los entrenos serían normales?» no se contesta con el horario del vacacional.
 *   e. «Y para NO afiliados» → la tarifa de no afiliados aunque el número sea de una familia.
 *   f. `hablaDelServicio`: lo que la cola usa para no tomar por de la clínica un pago que no la nombra.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
vi.mock('./llm.service', () => ({ chatWithTools: vi.fn() }));

import {
    atenderVentaDeServicio, hablaDelServicio, intencionEnVenta, pideTarifaDeNoAfiliado, preguntaPorEntrenosRegulares,
    CIERRE_DE_PAGO, PASO_VENTA, TEXTO_A_LA_ESCUELA, TEXTO_DIME, TEXTO_ENTRENOS_SIN_DATO,
    type CtxVentaServicio,
} from './whatsapp-venta-servicio';
import { MARCA_VENTA, type VentaActiva } from './whatsapp-venta-contexto';
import type { ItemConFicha } from './whatsapp-anuncio-destino';
import type { CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import type { FilaReciente } from './whatsapp-reglas-turno';

const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional' as any,
    price: null as any, active: true, event_id: null,
    starts_at: '2026-11-17 08:00:00-05', ends_at: '2026-12-10 11:00:00-05',
    precio_afiliado: null as any,
    opciones: [
        { clave: '1_semana', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2_semanas', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3_semanas', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
        { clave: '4_semanas', etiqueta: '4 semanas', precio: 200000, precio_afiliado: 170000 },
    ],
    description: 'Vacacional de voleibol en la sede Suba. Martes a jueves de 8:00 a 11:00 a. m.',
};
const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 350000, active: true, event_id: null, starts_at: '2026-11-21 00:00:00-05', ends_at: '2026-11-22 23:59:00-05',
    allow_installments: true, precio_afiliado: null as any,
    precios_por_fecha: [{ desde: '2026-11-18', precio: 380000 }], abono_minimo_pct: 50, opciones: null,
    description: '🏐 Clínica de armadores y atacantes.',
};
const NEQUI: CuentaDePagoEmbudo[] = [
    { tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' },
    { tipo: 'Daviplata', numero: '3194505150', titular: 'Iván Sossa' },
];

// Lunes 16-nov-2026, 10:00 a. m. en Bogotá.
const AHORA = new Date('2026-11-16T15:00:00Z');
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
const ent = (min: number, texto: string | null, extra: Partial<FilaReciente> = {}): FilaReciente =>
    ({ direction: 'inbound', type: 'text', text_body: texto, created_at: hace(min), wa_timestamp: hace(min), ...extra });
const sal = (min: number, texto: string, item: ItemConFicha, payload: Record<string, unknown> = {}): FilaReciente => ({
    direction: 'outbound', type: 'text', text_body: texto, created_at: hace(min), wa_timestamp: hace(min), ai_generated: true,
    payload: { [MARCA_VENTA]: item.id, ...payload },
});
const BLOQUE = (item: ItemConFicha, min = 5) => sal(min, `Para separar tu cupo en el ${item.name}: … ${CIERRE_DE_PAGO}`, item, { step: PASO_VENTA.PAGO });
const venta = (item: ItemConFicha): VentaActiva => ({ item, origen: 'marca', desde: hace(120) });

interface Registro { enviados: { texto: string; contexto: Record<string, unknown> }[]; avisos: string[]; preguntas: string[]; pagos: number }

function ctxDe(o: { recientes?: FilaReciente[]; cuentas?: CuentaDePagoEmbudo[]; afiliado?: boolean } = {}): { ctx: CtxVentaServicio; reg: Registro } {
    const reg: Registro = { enviados: [], avisos: [], preguntas: [], pagos: 0 };
    const ctx: CtxVentaServicio = {
        schoolId: 'school-monster', conversationId: 'conv-1', recientes: o.recientes ?? [],
        afiliado: async () => o.afiliado ?? false,
        cuentas: async () => o.cuentas ?? NEQUI,
        guardarLead: async () => 'lead-1',
        registrarEsperado: async () => true,
        responderPregunta: async (p) => { reg.preguntas.push(p.pregunta); return { tipo: 'no_se', motivo: 'sin_dato' }; },
        enviar: async (texto, contexto) => { reg.enviados.push({ texto, contexto }); if (contexto.step === PASO_VENTA.PAGO) reg.pagos++; },
        avisarEscuela: async (d) => { reg.avisos.push(d); },
        comprobanteEnCurso: async () => false,
        ahora: () => AHORA,
    };
    return { ctx, reg };
}

const BLOQUE_COMPLETO = /Para separar tu cupo/;

// ─── a. El bloque de pago completo, una sola vez ────────────────────────────

describe('a · el bloque de pago completo sale UNA vez', () => {
    it('«¿Puedo pagar hasta mañana?» (Danna, 2 veces): sin dato del plazo, la escuela lo confirma y no se repite el bloque', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE(VACACIONAL, 4)] });
        expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'Puedo pagar hasta mañana?')).toBe('venta_respuesta');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).not.toMatch(BLOQUE_COMPLETO);
        expect(reg.enviados[0].texto).toContain('plazo');
        expect(reg.pagos).toBe(0);
        expect(reg.avisos).toHaveLength(1);
        // …la misma pregunta un minuto después: silencio.
        const otra = ctxDe({ recientes: [sal(1, reg.enviados[0].texto, VACACIONAL, reg.enviados[0].contexto), BLOQUE(VACACIONAL, 5)] });
        expect(await atenderVentaDeServicio(otra.ctx, venta(VACACIONAL), 'Puedo pagar hasta mañana?')).toBe('venta_silencio');
        expect(otra.reg.enviados).toEqual([]);
    });

    it('«Ehh puedo pagar mañana?» con un tramo de precio: dice el valor de hoy y cuándo cambia (dato real, sin inventar plazo)', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE(CLINICA, 4)] });
        await atenderVentaDeServicio(ctx, venta(CLINICA), 'Ehh puedo pagar mañana?');
        expect(reg.enviados[0].texto).toContain('$350.000');
        expect(reg.enviados[0].texto).toContain('18 de noviembre');
        expect(reg.enviados[0].texto).toContain('$380.000');
        expect(reg.enviados[0].texto).not.toMatch(BLOQUE_COMPLETO);
        expect(reg.avisos).toEqual([]);
    });

    it('«pásame el número de Nequi» (Isaac): una línea con la cuenta', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE(CLINICA, 60)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'Hola por favor me puedes pasar el número para pagar por Nequi')).toBe('venta_respuesta');
        expect(reg.enviados[0].texto).toBe('Claro 🙌 Transfiere por Nequi o Daviplata al 319 450 5150, a nombre de Iván Sossa. Cuando pagues, envíame aquí el comprobante.');
        expect(reg.pagos).toBe(0);
    });

    it('«Disculpa ese tiene llave ?» al DÍA SIGUIENTE (Carlos Clavijo, el bloque salió hace 24 h): respuesta corta, no el bloque', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE(CLINICA, 24 * 60)] });
        expect(await atenderVentaDeServicio(ctx, venta(CLINICA), 'Disculpa ese tiene llave ?')).toBe('venta_respuesta');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).not.toMatch(BLOQUE_COMPLETO);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.LLAVE });
        expect(reg.pagos).toBe(0);
    });

    it('«Para transferir por bre b» ×3 seguidos: una sola respuesta', async () => {
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE(CLINICA, 24 * 60)] });
        await atenderVentaDeServicio(ctx, venta(CLINICA), 'Para transferir por bre b');
        const previo = reg.enviados[0];
        const otra = ctxDe({ recientes: [sal(1, previo.texto, CLINICA, previo.contexto), BLOQUE(CLINICA, 24 * 60)] });
        expect(await atenderVentaDeServicio(otra.ctx, venta(CLINICA), 'Para transferir por bre b')).toBe('venta_silencio');
        expect(otra.reg.enviados).toEqual([]);
    });

    it('«Sí» / «separar mi cupo» con el bloque ya enviado: «ya te los envié», no otra vez el bloque', async () => {
        for (const t of ['Sí', 'Separar mi cupo', 'Dale']) {
            const { ctx, reg } = ctxDe({ recientes: [BLOQUE(VACACIONAL, 30)] });
            expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), t)).toBe('venta_respuesta');
            expect(reg.enviados[0].texto).toMatch(/^Ya te envié los datos de pago arriba/);
            expect(reg.pagos).toBe(0);
        }
    });

    it('sin bloque previo (o de hace más de 48 h) el bloque completo sale; con un comprobante ya enviado también (puede ser otro cupo)', async () => {
        for (const recientes of [[], [BLOQUE(VACACIONAL, 49 * 60)], [BLOQUE(VACACIONAL, 30), ent(10, null, { type: 'image' })]]) {
            const { ctx, reg } = ctxDe({ recientes });
            expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'Separar mi cupo')).toBe('venta_pago');
            expect(reg.pagos).toBe(1);
        }
    });
});

// ─── b. Un solo mensaje por turno ───────────────────────────────────────────

describe('b · un solo mensaje por turno', () => {
    it('«Profe una pregunta» (Manu) no se deriva: «Claro, dime»', async () => {
        expect(intencionEnVenta('Profe una pregunta')).toBe('anuncio');
        const { ctx, reg } = ctxDe();
        await atenderVentaDeServicio(ctx, venta(CLINICA), 'Profe una pregunta');
        expect(reg.enviados.map((e) => e.texto)).toEqual([TEXTO_DIME]);
        expect(reg.avisos).toEqual([]);
    });

    it('«Ya le pasé tu pregunta» y, 30 s después, otra pregunta: NO sale el «Anotado 🙌 También se lo paso…»; la escuela sí se entera', async () => {
        const primera = ctxDe();
        expect(await atenderVentaDeServicio(primera.ctx, venta(CLINICA), '¿hay parqueadero en la universidad?')).toBe('venta_a_la_escuela');
        expect(primera.reg.enviados.map((e) => e.texto)).toEqual([TEXTO_A_LA_ESCUELA]);
        const segunda = ctxDe({ recientes: [sal(0.5, TEXTO_A_LA_ESCUELA, CLINICA, { step: PASO_VENTA.A_LA_ESCUELA })] });
        expect(await atenderVentaDeServicio(segunda.ctx, venta(CLINICA), '¿y llevan hidratación?')).toBe('venta_a_la_escuela');
        expect(segunda.reg.enviados).toEqual([]);
        expect(segunda.reg.avisos).toHaveLength(1);
    });
});

// ─── c. «3 semanas» ─────────────────────────────────────────────────────────

describe('c · «N semanas» en texto libre devuelve la opción y su valor', () => {
    it.each([
        ['3 semanas', '3 semanas', '$170.000'],
        ['Listo para asistir tres semanas', '3 semanas', '$170.000'],
        ['Pago 2 semanas', '2 semanas', '$140.000'],
        ['Dos semanas la inscribiré', '2 semanas', '$140.000'],
    ])('«%s»', async (texto, etiqueta, valor) => {
        const { ctx, reg } = ctxDe();
        const r = await atenderVentaDeServicio(ctx, venta(VACACIONAL), texto);
        expect(['venta_respuesta', 'venta_pago']).toContain(r);
        expect(reg.enviados[0].texto).toContain(etiqueta);
        expect(reg.enviados[0].texto).toContain(valor);
        expect(reg.enviados[0].texto).not.toMatch(/Ya le pasé tu pregunta/);
        expect(reg.preguntas).toEqual([]);
    });
});

// ─── d. Los entrenos de siempre ─────────────────────────────────────────────

describe('d · «¿los entrenos serían normales?» no recibe el horario del vacacional', () => {
    it.each([
        'Hola Sebas del vacacional de noviembre los entrenos serían normales?',
        'Si pero digamos los entrenos son normales?',
        'Osea uno va al vacacional y todo y los entrenos convencionales son normales osea en el mismo horario?',
    ])('«%s»', async (texto) => {
        expect(preguntaPorEntrenosRegulares(texto)).toBe(true);
        const { ctx, reg } = ctxDe({ recientes: [BLOQUE(VACACIONAL, 20)] });
        expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), texto)).toBe('venta_a_la_escuela');
        expect(reg.enviados[0].texto).toBe(TEXTO_ENTRENOS_SIN_DATO);
        expect(reg.preguntas).toEqual([]);            // la IA del servicio ni se consulta
        expect(reg.avisos).toHaveLength(1);
        expect(reg.avisos[0]).toContain('entrenos');
    });

    it('lo que NO es esa pregunta sigue yendo a la IA del servicio', () => {
        for (const t of ['¿a qué hora son las jornadas?', '¿Tienen entrenamiento el sábado?', 'Ese horario es normal para niños de 8 años?']) {
            expect(preguntaPorEntrenosRegulares(t), t).toBe(false);
        }
    });
});

// ─── e. No afiliados ────────────────────────────────────────────────────────

describe('e · «para NO afiliados»', () => {
    it('Isa F (familia del club) pregunta «Y el vacacional para no afiliados, ¿Qué precio tiene?»: la tabla de no afiliados', async () => {
        expect(pideTarifaDeNoAfiliado('Y el vacacional para no afiliados, ¿Qué precio tiene?')).toBe(true);
        expect(pideTarifaDeNoAfiliado('Y para NO afiliados')).toBe(true);
        expect(pideTarifaDeNoAfiliado('cuánto vale para afiliados')).toBe(false);
        const { ctx, reg } = ctxDe({ afiliado: true });
        await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'Y el vacacional para no afiliados, ¿Qué precio tiene?');
        expect(reg.enviados[0].texto).toContain('$100.000');
        expect(reg.enviados[0].texto).toContain('$200.000');
        expect(reg.enviados[0].texto).not.toMatch(/afiliado|\$80\.000/);
    });

    it('«Y para NO afiliados» sola, con la tabla de afiliados ya enviada: solo las líneas de no afiliados (intención pago, no a la escuela)', async () => {
        expect(intencionEnVenta('Y para NO afiliados')).toBe('pago');
        const { ctx, reg } = ctxDe({ afiliado: true, recientes: [BLOQUE(VACACIONAL, 3)] });
        expect(await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'Y para NO afiliados')).toBe('venta_respuesta');
        expect(reg.enviados[0].texto).toContain('Valores:');
        expect(reg.enviados[0].texto).toContain('$100.000');
        expect(reg.enviados[0].texto).not.toMatch(BLOQUE_COMPLETO);
        expect(reg.avisos).toEqual([]);
    });

    it('decir «soy afiliado» NO cambia el cobro (lo decide el número), pero la cotización dice los dos valores (2026-11-18)', async () => {
        const { ctx, reg } = ctxDe({ afiliado: false });
        await atenderVentaDeServicio(ctx, venta(VACACIONAL), 'soy afiliado, ¿cuánto cuesta?');
        expect(reg.enviados[0].texto).toContain('• 1 semana: *$100.000* (afiliados *$80.000*)');
    });
});

// ─── f. Un pago que no nombra el servicio ───────────────────────────────────

describe('f · hablaDelServicio (para la cola de comprobantes)', () => {
    it('Marco (…9564): su pregunta sobre el correo se derivó («Ya le pasé tu pregunta») pero nunca habló de la clínica → false', () => {
        const recientes = [
            ent(1500, 'Hola yo ya les respondí el mensaje por correo y en ese mismo mensaje dejó claro que yo solo debo 10mil de este mes'),
            sal(1499, TEXTO_A_LA_ESCUELA, CLINICA, { step: PASO_VENTA.A_LA_ESCUELA }),
            ent(60, 'Ya hice el pago de los 10mil pendientes'),
        ];
        expect(hablaDelServicio(recientes, CLINICA, AHORA.getTime())).toBe(false);
    });

    it('nombrar la clínica, o recibir el bloque de pago porque lo pidió, sí cuenta', () => {
        expect(hablaDelServicio([ent(30, 'Quiero separar mi cupo en la clínica de armadores')], CLINICA, AHORA.getTime())).toBe(true);
        expect(hablaDelServicio([BLOQUE(CLINICA, 90)], CLINICA, AHORA.getTime())).toBe(true);
        expect(hablaDelServicio([BLOQUE(CLINICA, 80 * 60)], CLINICA, AHORA.getTime())).toBe(false);   // hace 80 h
        expect(hablaDelServicio([BLOQUE(VACACIONAL, 10)], CLINICA, AHORA.getTime())).toBe(false);     // de otro servicio
    });
});
