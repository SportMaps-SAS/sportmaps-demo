/**
 * Rescate por plantilla del interesado sin respuesta (Monster 2026-11-12, @Andrey_0630).
 */
import { describe, expect, it, vi } from 'vitest';
import {
    primerNombre, tocaRescate, runRescateProspectosPorPlantilla, type DepsRescate, type ConversacionRescate, type LeadRescate,
} from './whatsapp-prospecto-rescate.service';

// 12:00 en Bogotá = 17:00 UTC
const AHORA = new Date('2026-11-12T17:00:00Z');
const hace = (h: number) => new Date(AHORA.getTime() - h * 3600_000).toISOString();

describe('primerNombre', () => {
    it.each([
        ['Anderson⚡ (@Andrey_0630)', 'Anderson'],
        ['Paola Aguirre 🌸', 'Paola'],
        ['  María José ', 'María'],
        [null, 'por aquí'],
        ['', 'por aquí'],
        ['🙏🏼🍃', 'por aquí'],
        ['3125806305', 'por aquí'],
    ])('%s → %s', (n, esperado) => expect(primerNombre(n as any)).toBe(esperado));
});

describe('tocaRescate', () => {
    const c = (lastInboundAt: string | null, contactKind: string | null = 'desconocido') => ({ lastInboundAt, contactKind });
    it('último mensaje de hace 30 h, sin respuesta, de día → toca', () => {
        expect(tocaRescate(c(hace(30)), false, AHORA)).toEqual({ toca: true, motivo: 'ok' });
    });
    it('menos de 20 h: todavía lo atiende el bot y el seguimiento de 20 h', () => {
        expect(tocaRescate(c(hace(10)), false, AHORA).motivo).toBe('muy_reciente');
    });
    it('más de 7 días: ya no', () => {
        expect(tocaRescate(c(hace(24 * 8)), false, AHORA).motivo).toBe('muy_viejo');
    });
    it('alguien escribió después: no', () => {
        expect(tocaRescate(c(hace(30)), true, AHORA).motivo).toBe('ya_tuvo_respuesta');
    });
    it('familia, staff o personal: nunca', () => {
        for (const k of ['familia', 'staff', 'personal', 'negocio', 'plataforma']) {
            expect(tocaRescate(c(hace(30), k), false, AHORA).motivo).toBe('no_es_interesado');
        }
    });
    it('de madrugada (3 a. m. en Colombia): no', () => {
        expect(tocaRescate(c(hace(30)), false, new Date('2026-11-12T08:00:00Z')).motivo).toBe('fuera_de_horario');
    });
    it('después de las 8 p. m.: no', () => {
        expect(tocaRescate(c(hace(30)), false, new Date('2026-11-13T01:30:00Z')).motivo).toBe('fuera_de_horario');
    });
});

function deps(over: Partial<DepsRescate> = {}): DepsRescate & { enviar: ReturnType<typeof vi.fn> } {
    const lead: LeadRescate = { id: 'l1', schoolId: 's1', conversationId: 'c1', sourceDetail: { conversation_id: 'c1' } };
    const conv: ConversacionRescate = {
        id: 'c1', integrationId: 'i1', contactWaId: 'wau-CO.-a', contactName: 'Anderson⚡ (@Andrey_0630)',
        contactKind: 'desconocido', lastInboundAt: hace(30),
    };
    const enviar = vi.fn(async () => true);
    return {
        candidatos: async () => [lead],
        conversacion: async () => conv,
        hayEscrituraPosterior: async () => false,
        puedeHablar: async () => true,
        integracion: async () => ({ id: 'i1', school_id: 's1', waba_id: 'w1' } as any),
        plantillaAprobada: async () => ({ idioma: 'es_CO', components: [] }),
        consentimiento: async () => true,
        reclamar: async () => true,
        soltar: async () => undefined,
        nombreEscuela: async () => 'Monster´s Volley Club',
        enviar,
        ...over,
    } as any;
}

describe('runRescateProspectosPorPlantilla', () => {
    it('camino feliz: manda la plantilla con nombre y escuela', async () => {
        const d = deps();
        const r = await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d });
        expect(r).toMatchObject({ candidatos: 1, enviados: 1, omitidos: 0, fallidos: 0 });
        expect(d.enviar).toHaveBeenCalledTimes(1);
        expect((d.enviar as any).mock.calls[0][3]).toEqual(['Anderson', 'Monster´s Volley Club']);
    });
    it('SIN consentimiento no se envía (regla de la plataforma)', async () => {
        const d = deps({ consentimiento: async () => false });
        const r = await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d });
        expect(r.enviados).toBe(0);
        expect(d.enviar).not.toHaveBeenCalled();
    });
    it('sin plantilla aprobada no se envía ni se reclama', async () => {
        const reclamar = vi.fn(async () => true);
        const d = deps({ plantillaAprobada: async () => null, reclamar });
        const r = await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d });
        expect(r.enviados).toBe(0);
        expect(reclamar).not.toHaveBeenCalled();
    });
    it('si alguien ya le escribió, no', async () => {
        const d = deps({ hayEscrituraPosterior: async () => true });
        expect((await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d })).enviados).toBe(0);
    });
    it('conversación tomada o bot apagado: no', async () => {
        const d = deps({ puedeHablar: async () => false });
        expect((await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d })).enviados).toBe(0);
    });
    it('otro BFF ya reclamó al interesado: no se duplica', async () => {
        const d = deps({ reclamar: async () => false });
        expect((await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d })).enviados).toBe(0);
        expect(d.enviar).not.toHaveBeenCalled();
    });
    it('si el envío falla, se cuenta, se suelta la marca y no lanza', async () => {
        const soltar = vi.fn(async () => undefined);
        const d = deps({ enviar: vi.fn(async () => { throw new Error('131047'); }), soltar });
        const r = await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d });
        expect(r).toMatchObject({ enviados: 0, fallidos: 1 });
        expect(soltar).toHaveBeenCalledTimes(1);
    });
    it('fuera del horario no hace ni la consulta', async () => {
        const candidatos = vi.fn(async () => []);
        await runRescateProspectosPorPlantilla({ ahora: new Date('2026-11-12T08:00:00Z'), deps: deps({ candidatos }) });
        expect(candidatos).not.toHaveBeenCalled();
    });
    it('tope por corrida: no manda más de 15', async () => {
        const leads = Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, schoolId: 's1', conversationId: 'c1', sourceDetail: {} }));
        const d = deps({ candidatos: async () => leads });
        const r = await runRescateProspectosPorPlantilla({ ahora: AHORA, deps: d });
        expect(r.enviados).toBe(15);
    });
});
