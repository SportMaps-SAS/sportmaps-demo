/**
 * Respuesta al prospecto con el catálogo delante y el verificador a la salida
 * (blindaje de ventas de servicio, frente B, 2026-11-08). El caso: la ficha de
 * Monster decía «preventa hasta el 9 de noviembre» y la IA lo repitió a 12
 * personas; el catálogo dice «hasta el 10» (tramo desde el 11).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const FICHA_VIEJA = [
    'VALORES 2026',
    '• Matrícula 2026: $310.000 en las dos sedes.',
    '',
    '🏐 CLÍNICA DE ARMADORES Y ATACANTES (para deportistas del club y de fuera).',
    '📅 21 y 22 de noviembre (dos jornadas)',
    '• Preventa: $300.000 hasta el 9 de noviembre.',
    '• Desde el 10 de noviembre: $350.000.',
].join('\n');

const fila = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null }));
vi.mock('../config/supabase', () => ({
    supabase: {
        from: (tabla: string) => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => ({ data: tabla === 'school_settings' ? fila.settings : null, error: null }),
                }),
            }),
        }),
    },
}));
const llm = vi.hoisted(() => ({ chatWithTools: vi.fn() }));
vi.mock('./llm.service', () => llm);
const catalogo = vi.hoisted(() => ({ items: [] as any[] }));
vi.mock('./whatsapp-anuncio-destino', async (orig) => ({
    ...(await orig<typeof import('./whatsapp-anuncio-destino')>()),
    serviciosDeAnuncio: vi.fn(async () => catalogo.items),
}));
const medios = vi.hoisted(() => ({ mediosDePago: vi.fn() }));
vi.mock('./whatsapp-medios-de-pago.service', () => medios);

import { redactarRespuestaDeProspecto, catalogoParaProspecto } from './whatsapp-prospecto-ia.service';
import { verificarSalida } from './whatsapp-verificador-montos';

const CLINICA = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00+00:00', ends_at: '2026-11-23T04:59:00+00:00',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null, description: '*Hombres y mujeres de 14 años en adelante*',
};

const base = {
    schoolId: 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c', conversationId: 'c1', escuela: "MONSTER'S VOLLEY",
    nuevo: '¿Hasta cuándo es la preventa?',
    recientes: [{ direction: 'inbound', text_body: '¿Hasta cuándo es la preventa?', created_at: new Date().toISOString() }] as any[],
    grupos: null, precios: '• Mensualidad Sede Norte: *$165.000*', enlace: null,
    textos: { nombre: 'clase de prueba', gratis: false, precio: '$15.000' } as any,
};

const responde = (...textos: string[]) => {
    for (const t of textos) llm.chatWithTools.mockResolvedValueOnce({ text: t, provider: 'claude' });
};

beforeEach(() => {
    llm.chatWithTools.mockReset();
    medios.mediosDePago.mockReset();
    medios.mediosDePago.mockResolvedValue({ cuentas: [{ tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' }] });
    fila.settings = { wa_ficha_prospectos: FICHA_VIEJA };
    catalogo.items = [CLINICA];
});

describe('redactarRespuestaDeProspecto con catálogo', () => {
    it('el catálogo va en el prompt con la regla «el catálogo manda sobre la ficha»', async () => {
        responde('La preventa de $300.000 va hasta el martes 10 de noviembre; desde el miércoles 11 es $350.000.');
        const r = await redactarRespuestaDeProspecto(base);
        expect(r).toBe('La preventa de $300.000 va hasta el martes 10 de noviembre; desde el miércoles 11 es $350.000.');
        const system: string = llm.chatWithTools.mock.calls[0][0].system;
        expect(system).toContain('<catalogo>\n[Servicio 1]\nServicio: Clínica de armadores y atacantes');
        expect(system).toContain('Precio por fecha: $300.000 hasta el martes 10 de noviembre; desde el miércoles 11, $350.000');
        expect(system).toContain('los datos de <catalogo> MANDAN sobre la ficha');
        expect(system).toContain('Cuentas para pagar: por Nequi al número 3194505150 (a nombre de Iván Sossa)');
        // Las cuentas se leen por el tipo del servicio (las restringidas a otra cosa no salen).
        expect(medios.mediosDePago).toHaveBeenCalledWith(base.schoolId, { categoria: 'clase_extra' });
    });

    it('repite el «hasta el 9» de la ficha → se pide una corrección → sale la corregida', async () => {
        responde('La preventa de $300.000 es hasta el 9 de noviembre.', 'La preventa de $300.000 va hasta el martes 10 de noviembre.');
        const r = await redactarRespuestaDeProspecto(base);
        expect(r).toBe('La preventa de $300.000 va hasta el martes 10 de noviembre.');
        const segunda = llm.chatWithTools.mock.calls[1][0];
        expect(segunda.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(segunda.messages[2].content).toContain('«hasta el 9 de noviembre»');
        expect(segunda.messages[2].content).toContain('manda <catalogo>');
    });

    it('si la corrección también trae un dato que no está, no sale nada (null)', async () => {
        responde('La preventa es hasta el 9 de noviembre.', 'Te la dejo en $280.000.');
        expect(await redactarRespuestaDeProspecto(base)).toBeNull();
        expect(llm.chatWithTools).toHaveBeenCalledTimes(2);
    });

    it('lo que la ficha dice de la matrícula, los planes y la clase de prueba sigue saliendo', async () => {
        responde('La matrícula es de $310.000, la mensualidad de Norte $165.000 y la clase de prueba $15.000.');
        expect(await redactarRespuestaDeProspecto({ ...base, nuevo: '¿Cuánto cuesta entrar?' }))
            .toBe('La matrícula es de $310.000, la mensualidad de Norte $165.000 y la clase de prueba $15.000.');
        expect(llm.chatWithTools).toHaveBeenCalledTimes(1);
    });

    it('seguimiento de 20 h: también pasa por el verificador (y respeta el NADA de la corrección)', async () => {
        const conHilo = { ...base, seguimiento: true, recientes: [
            { direction: 'inbound', text_body: 'Me interesa la clínica', created_at: new Date(Date.now() - 20 * 3600_000).toISOString() },
        ] as any[] };
        responde('Recuerda que la preventa va hasta el 9 de noviembre 🙌', 'NADA');
        expect(await redactarRespuestaDeProspecto(conHilo)).toBeNull();
        responde('Recuerda que la preventa de $300.000 va hasta el martes 10 de noviembre.');
        expect(await redactarRespuestaDeProspecto(conHilo)).toBe('Recuerda que la preventa de $300.000 va hasta el martes 10 de noviembre.');
        expect(llm.chatWithTools.mock.calls[2][0].system).toContain('<catalogo>');
    });

    it('sin servicios vigentes: el prompt de siempre (sin <catalogo>) y sin leer cuentas', async () => {
        catalogo.items = [];
        responde('Hola, claro.');
        await redactarRespuestaDeProspecto(base);
        const system: string = llm.chatWithTools.mock.calls[0][0].system;
        expect(system).not.toContain('<catalogo>');
        expect(system).toContain('- Precios: solo los de <precios> o la ficha, con el nombre del plan tal cual.');
        expect(medios.mediosDePago).not.toHaveBeenCalled();
    });
});

describe('catalogoParaProspecto', () => {
    it('lo permitido: catálogo + ficha sin las líneas que lo contradicen + planes + clase de prueba; la cuenta no es monto', async () => {
        const c = await catalogoParaProspecto(base.schoolId, FICHA_VIEJA, { precios: base.precios, textos: base.textos }, '2026-11-08');
        expect(c.bloque).toContain('Valor hoy (domingo 8 de noviembre): $300.000');
        const ok = 'Nequi 3194505150 a nombre de Iván Sossa: $300.000 hasta el martes 10 de noviembre, matrícula $310.000, clase $15.000.';
        expect(verificarSalida(ok, c.permitidos, { hoy: '2026-11-08' })).toEqual({ ok: true });
        expect(verificarSalida('Preventa hasta el 9 de noviembre por $300.000', c.permitidos, { hoy: '2026-11-08' }).ok).toBe(false);
    });
});
