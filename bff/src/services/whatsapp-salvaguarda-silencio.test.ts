/**
 * Salvaguarda del turno mudo (Monster 2026-11-11, @Andrey_0630).
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ avisar: vi.fn(async () => 1) }));
vi.mock('./whatsapp-escalaciones.service', () => ({ avisarEscalacionAlEquipo: h.avisar }));

import { decidirSalvaguarda, avisarSilencio, salvaguardaHabilitada } from './whatsapp-salvaguarda-silencio';

const conContenido = (t: string) => t.split(' ').length >= 2;
const conSenal = (t: string) => /entrenar|inscrib/i.test(t);
const base = { botonId: null, conContenido, conSenal };

describe('decidirSalvaguarda', () => {
    it('silencio + intención → avisar', () => {
        expect(decidirSalvaguarda({ ...base, resultado: 'silencio', texto: 'Hola! Me interesa entrenar con ustedes' })).toBe('avisar');
    });
    it('error con contenido → avisar aunque no haya señal', () => {
        expect(decidirSalvaguarda({ ...base, resultado: 'error', texto: 'tengo una duda rara' })).toBe('avisar');
    });
    it('silencio sin señal (charla personal) → nada', () => {
        expect(decidirSalvaguarda({ ...base, resultado: 'silencio', texto: 'nos vemos el sábado en tu casa' })).toBe('nada');
    });
    it('saludo suelto o cierre (sin contenido) → nada', () => {
        expect(decidirSalvaguarda({ ...base, conContenido: () => false, resultado: 'silencio', texto: 'Gracias' })).toBe('nada');
    });
    it.each(['pregunta_de_comprobante', 'frenado', 'prospecto_ia', 'bienvenida'])('turno que sí contestó (%s) → nada', (r) => {
        expect(decidirSalvaguarda({ ...base, resultado: r, texto: 'quiero entrenar' })).toBe('nada');
    });
    it('un botón o un texto vacío → nada', () => {
        expect(decidirSalvaguarda({ ...base, botonId: 'sm_cc_1', resultado: 'silencio', texto: 'quiero entrenar' })).toBe('nada');
        expect(decidirSalvaguarda({ ...base, resultado: 'error', texto: null })).toBe('nada');
    });
});

describe('avisarSilencio', () => {
    it('ancla determinística por conversación y día, con push y sin el texto del cliente', async () => {
        h.avisar.mockClear();
        const ahora = Date.parse('2026-11-11T22:00:00Z');
        await avisarSilencio({ schoolId: 's1', conversationId: 'c1', contactWaId: '573001112233', contactName: 'Ana', ahora });
        await avisarSilencio({ schoolId: 's1', conversationId: 'c1', contactWaId: '573001112233', contactName: 'Ana', ahora: ahora + 3600_000 });
        const [a, b] = h.avisar.mock.calls.map((c: any) => c[0]);
        expect(a.ancla).toBe('silencio:c1:2026-11-11');
        expect(b.ancla).toBe(a.ancla);
        expect(a).toMatchObject({ push: true, silencio: true, urgencia: 'normal' });
        expect(JSON.stringify(a)).not.toMatch(/interesa|entrenar/);
    });
});

describe('salvaguardaHabilitada', () => {
    it('apagada por defecto y solo para las escuelas listadas', () => {
        expect(salvaguardaHabilitada('s1', undefined)).toBe(false);
        expect(salvaguardaHabilitada('s1', 'a, s1')).toBe(true);
        expect(salvaguardaHabilitada('s2', 'a, s1')).toBe(false);
        expect(salvaguardaHabilitada('', 's1')).toBe(false);
    });
});
