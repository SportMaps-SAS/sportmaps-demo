/**
 * Turnos que no se pierden en un reinicio (auditoría 2026-10-28, A-01).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    decidirPendiente, barrerTurnosPendientes, seguirTarea, esperarTareasEnCurso, tareasEnCurso,
    GRACIA_MS, VENCE_MS, type FilaPendiente, type DepsBarrido,
} from './whatsapp-turnos-pendientes.service';

const AHORA = Date.parse('2026-10-29T15:00:00Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

function fila(p: Partial<FilaPendiente> = {}): FilaPendiente {
    return {
        wa_message_id: 'wamid.1', conversation_id: 'c1', integration_id: 'i1', contact_wa_id: '573001112233',
        texto: 'Para mañana miércoles', opted_out: false, boton_id: null, origen: 'texto', intentos: 0,
        created_at: hace(5 * 60_000), ...p,
    };
}

function deps(filas: FilaPendiente[], p: Partial<DepsBarrido> = {}) {
    const llamadas = { relanzados: [] as string[], soltados: [] as string[], intentos: [] as number[] };
    const d: Partial<DepsBarrido> = {
        pendientes: async () => filas,
        yaRespondido: async () => false,
        integracion: async () => ({ id: 'i1', school_id: 's1' } as any),
        marcarIntento: async (_id, n) => { llamadas.intentos.push(n); },
        soltar: async (id) => { llamadas.soltados.push(id); },
        relanzar: async (_i, f) => { llamadas.relanzados.push(f.wa_message_id); },
        ...p,
    };
    return { d, llamadas };
}

describe('decidirPendiente', () => {
    it('recién anotado: puede seguir corriendo en otro proceso → esperar', () =>
        expect(decidirPendiente({ created_at: hace(GRACIA_MS - 1000), intentos: 0 }, AHORA)).toBe('esperar'));
    it('pasó la gracia → relanzar', () =>
        expect(decidirPendiente({ created_at: hace(GRACIA_MS + 1000), intentos: 0 }, AHORA)).toBe('relanzar'));
    it('más de 2 h → descartar (la respuesta llegaría fuera de lugar)', () =>
        expect(decidirPendiente({ created_at: hace(VENCE_MS + 1000), intentos: 0 }, AHORA)).toBe('descartar'));
    it('ya se intentó dos veces → descartar', () =>
        expect(decidirPendiente({ created_at: hace(GRACIA_MS + 1000), intentos: 2 }, AHORA)).toBe('descartar'));
});

describe('barrerTurnosPendientes', () => {
    it('relanza el turno perdido, anota el intento ANTES y lo suelta después', async () => {
        const { d, llamadas } = deps([fila()]);
        const r = await barrerTurnosPendientes({ ahora: AHORA, deps: d });
        expect(r.relanzados).toBe(1);
        expect(llamadas.intentos).toEqual([1]);
        expect(llamadas.relanzados).toEqual(['wamid.1']);
        expect(llamadas.soltados).toEqual(['wamid.1']);
    });

    it('si alguien ya contestó en la conversación, no se relanza', async () => {
        const { d, llamadas } = deps([fila()], { yaRespondido: async () => true });
        const r = await barrerTurnosPendientes({ ahora: AHORA, deps: d });
        expect(r.yaRespondidos).toBe(1);
        expect(llamadas.relanzados).toEqual([]);
        expect(llamadas.soltados).toEqual(['wamid.1']);
    });

    it('integración apagada: se descarta sin relanzar', async () => {
        const { d, llamadas } = deps([fila()], { integracion: async () => null });
        await barrerTurnosPendientes({ ahora: AHORA, deps: d });
        expect(llamadas.relanzados).toEqual([]);
    });

    it('un relanzamiento que falla deja la fila (con el intento sumado) para la próxima', async () => {
        const { d, llamadas } = deps([fila()], { relanzar: async () => { throw new Error('modelo caído'); } });
        const r = await barrerTurnosPendientes({ ahora: AHORA, deps: d });
        expect(r.relanzados).toBe(0);
        expect(llamadas.intentos).toEqual([1]);
        expect(llamadas.soltados).toEqual([]);
    });

    it('si la lectura falla, no lanza', async () => {
        const { d } = deps([], { pendientes: async () => { throw new Error('sin tabla'); } });
        await expect(barrerTurnosPendientes({ ahora: AHORA, deps: d })).resolves.toMatchObject({ revisados: 0 });
    });
});

describe('apagado ordenado', () => {
    it('espera las tareas en curso', async () => {
        let fin!: () => void;
        seguirTarea(new Promise<void>((r) => { fin = r; }));
        expect(tareasEnCurso()).toBe(1);
        setTimeout(() => fin(), 20);
        expect(await esperarTareasEnCurso(1000)).toBe(true);
        expect(tareasEnCurso()).toBe(0);
    });

    it('no espera para siempre', async () => {
        seguirTarea(new Promise<void>(() => {}));
        expect(await esperarTareasEnCurso(30)).toBe(false);
    });
});
