import { describe, it, expect, vi } from 'vitest';

// El job importa el cliente de Supabase, que exige variables de entorno: las pruebas usan
// dependencias inyectadas y no tocan la base.
vi.mock('../config/supabase', () => ({ supabase: {} }));
import {
    ESPERA_RECORDATORIO_MS, planearAvisos, textoDelAviso, avisoDePlataforma, avisoSalio,
    runSolicitudesUnionAvisos, solicitudesUnionAvisosActivo, RUTA_BANDEJA,
    type SolicitudPendiente, type DepsAvisosUnion,
} from './solicitudes-union-avisos.job';

const AHORA = Date.parse('2026-11-23T15:00:00.000Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();
const H = 3600_000;

const sol = (id: string, school: string, creadaHace: number, aviso: number | null = null, recuerdo: number | null = null): SolicitudPendiente => ({
    id, school_id: school, created_at: hace(creadaHace),
    wa_aviso_at: aviso === null ? null : hace(aviso),
    wa_recordatorio_at: recuerdo === null ? null : hace(recuerdo),
});

describe('planearAvisos', () => {
    it('una solicitud nueva sin avisar da un aviso inicial', () => {
        const [a] = planearAvisos([sol('r1', 'e1', 1 * H)], new Map([['e1', 1]]), AHORA);
        expect(a.etapa).toBe('inicial');
        expect(a.ids).toEqual(['r1']);
        expect(a.idsYaVencidas).toEqual([]);
    });

    it('agrupa por escuela: varias solicitudes, UN aviso, y el total es el de pendientes', () => {
        const avisos = planearAvisos(
            [sol('r1', 'e1', 1 * H), sol('r2', 'e1', 2 * H), sol('r3', 'e2', 1 * H)],
            new Map([['e1', 4], ['e2', 1]]),
            AHORA,
        );
        expect(avisos).toHaveLength(2);
        const e1 = avisos.find((a) => a.schoolId === 'e1')!;
        expect(e1.ids.sort()).toEqual(['r1', 'r2']);
        expect(e1.totalPendientes).toBe(4);
    });

    it('el total nunca es menor que lo que se está avisando', () => {
        const [a] = planearAvisos([sol('r1', 'e1', H), sol('r2', 'e1', H)], new Map(), AHORA);
        expect(a.totalPendientes).toBe(2);
    });

    it('el recordatorio sale solo si ya se avisó, lleva >= 24 h y no se recordó', () => {
        expect(planearAvisos([sol('r1', 'e1', 30 * H, 29 * H)], new Map([['e1', 1]]), AHORA)[0].etapa).toBe('recordatorio');
        // Avisada pero aún no cumple 24 h desde su creación:
        expect(planearAvisos([sol('r1', 'e1', 10 * H, 9 * H)], new Map([['e1', 1]]), AHORA)).toEqual([]);
        // Ya se le recordó: no hay un segundo recordatorio.
        expect(planearAvisos([sol('r1', 'e1', 60 * H, 59 * H, 35 * H)], new Map([['e1', 1]]), AHORA)).toEqual([]);
    });

    it('justo en el límite de 24 h cuenta', () => {
        expect(planearAvisos([sol('r1', 'e1', ESPERA_RECORDATORIO_MS, 23 * H)], new Map(), AHORA)).toHaveLength(1);
    });

    it('si la escuela tiene iniciales y recordables a la vez, sale solo el inicial (nunca dos juntos)', () => {
        const avisos = planearAvisos(
            [sol('nueva', 'e1', 1 * H), sol('vieja', 'e1', 30 * H, 29 * H)],
            new Map([['e1', 2]]),
            AHORA,
        );
        expect(avisos).toHaveLength(1);
        expect(avisos[0].etapa).toBe('inicial');
        expect(avisos[0].ids).toEqual(['nueva']);
    });

    it('un aviso inicial sobre una solicitud de >= 24 h la marca también como recordada', () => {
        const [a] = planearAvisos([sol('r1', 'e1', 50 * H), sol('r2', 'e1', 1 * H)], new Map([['e1', 2]]), AHORA);
        expect(a.etapa).toBe('inicial');
        expect(a.idsYaVencidas).toEqual(['r1']);
    });

    it('la ancla de la clave es la solicitud más reciente del lote', () => {
        const [a] = planearAvisos([sol('r1', 'e1', 5 * H), sol('r2', 'e1', 2 * H)], new Map(), AHORA);
        expect(a.ancla).toBe(hace(2 * H));
    });
});

describe('textos y aviso de plataforma', () => {
    it('singular y plural, sin nombres de personas', () => {
        expect(textoDelAviso('inicial', 1).titulo).toBe('1 familia espera que las aceptes');
        expect(textoDelAviso('inicial', 3).titulo).toBe('3 familias esperan que las aceptes');
        expect(textoDelAviso('recordatorio', 2).titulo).toContain('desde hace más de un día');
    });

    it('usa la plantilla ya aprobada, el tipo escalación y lleva a «Por asignar»', () => {
        const [a] = planearAvisos([sol('r1', 'e1', H)], new Map([['e1', 3]]), AHORA);
        const aviso = avisoDePlataforma(a, 'Academia X');
        expect(aviso.tipo).toBe('escalacion');
        expect(aviso.plantilla.nombre).toBe('sm_caso_por_atender');
        expect(aviso.plantilla.variables[0]).toBe('Academia X');
        expect(aviso.ruta).toBe(RUTA_BANDEJA);
        expect(aviso.urgente).toBe(false);
        // Las variables de plantilla no admiten saltos de línea.
        expect(aviso.plantilla.variables.every((v) => !v.includes('\n'))).toBe(true);
    });

    it('la clave distingue el aviso inicial del recordatorio y es estable para el mismo lote', () => {
        const [i1] = planearAvisos([sol('r1', 'e1', H)], new Map(), AHORA);
        const [i2] = planearAvisos([sol('r1', 'e1', H)], new Map(), AHORA + 60_000);
        const [rec] = planearAvisos([sol('r1', 'e1', 30 * H, 29 * H)], new Map(), AHORA);
        expect(avisoDePlataforma(i1, 'X').clave).toBe(avisoDePlataforma(i2, 'X').clave);
        expect(avisoDePlataforma(rec, 'X').clave).not.toBe(avisoDePlataforma(i1, 'X').clave);
    });
});

describe('avisoSalio', () => {
    const base = { enviados: 0, fallidos: 0, duplicados: 0, silencio: 0, sinPermiso: 0 };
    it('enviado o duplicado (ya lo mandó otro BFF) cuentan; lo demás no', () => {
        expect(avisoSalio({ ...base, enviados: 1 })).toBe(true);
        expect(avisoSalio({ ...base, duplicados: 1 })).toBe(true);
        expect(avisoSalio({ ...base, fallidos: 1 })).toBe(false);
        expect(avisoSalio({ ...base, silencio: 1 })).toBe(false);
        expect(avisoSalio({ ...base, omitido: 'sin_suscripciones' })).toBe(false);
        expect(avisoSalio(base)).toBe(false);
    });
});

describe('solicitudesUnionAvisosActivo', () => {
    it('solo producción, con interruptor y permiso explícito fuera de producción', () => {
        expect(solicitudesUnionAvisosActivo({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
        expect(solicitudesUnionAvisosActivo({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
        expect(solicitudesUnionAvisosActivo({ NODE_ENV: 'production', DISABLE_SOLICITUDES_UNION_AVISOS: 'true' } as NodeJS.ProcessEnv)).toBe(false);
        expect(solicitudesUnionAvisosActivo({ NODE_ENV: 'staging', SOLICITUDES_UNION_AVISOS_FUERA_DE_PROD: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    });
});

describe('runSolicitudesUnionAvisos', () => {
    const resultado = (o: Partial<{ enviados: number; fallidos: number; duplicados: number; silencio: number; sinPermiso: number; omitido: any }> = {}) =>
        ({ enviados: 0, fallidos: 0, duplicados: 0, silencio: 0, sinPermiso: 0, ...o });

    function armar(solicitudes: SolicitudPendiente[], avisar: DepsAvisosUnion['avisar'], extra: Partial<DepsAvisosUnion> = {}) {
        const marcar = vi.fn(async () => undefined);
        const leerSolicitudes = vi.fn(async () => solicitudes);
        const contarPendientes = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, 2])));
        const nombresDeEscuelas = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, `Escuela ${i}`])));
        const deps: Partial<DepsAvisosUnion> = {
            canalHabilitado: async () => true, leerSolicitudes, contarPendientes, nombresDeEscuelas, avisar, marcar, ...extra,
        };
        return { deps, marcar, leerSolicitudes, contarPendientes, nombresDeEscuelas };
    }

    it('con el canal apagado no lee la base ni avisa', async () => {
        const avisar = vi.fn(async () => resultado({ enviados: 1 }));
        const { deps, leerSolicitudes } = armar([sol('r1', 'e1', H)], avisar, { canalHabilitado: async () => false });
        const r = await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        expect(r).toEqual({ escuelas: 0, avisadas: 0, omitidas: 0 });
        expect(leerSolicitudes).not.toHaveBeenCalled();
        expect(avisar).not.toHaveBeenCalled();
    });

    it('sin solicitudes por avisar no hace nada más (sin consultas extra)', async () => {
        const avisar = vi.fn(async () => resultado());
        const { deps, contarPendientes, nombresDeEscuelas } = armar([], avisar);
        await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        expect(contarPendientes).not.toHaveBeenCalled();
        expect(nombresDeEscuelas).not.toHaveBeenCalled();
    });

    it('un mensaje por escuela y marca solo las solicitudes avisadas', async () => {
        const avisar = vi.fn(async () => resultado({ enviados: 2 }));
        const { deps, marcar } = armar([sol('r1', 'e1', H), sol('r2', 'e1', 2 * H), sol('r3', 'e2', H)], avisar);
        const r = await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        expect(avisar).toHaveBeenCalledTimes(2);
        expect(r).toEqual({ escuelas: 2, avisadas: 2, omitidas: 0 });
        const llamadas = marcar.mock.calls as unknown as Array<[string, string[], string]>;
        expect(llamadas.map((c) => c[0])).toEqual(['inicial', 'inicial']);
        expect(llamadas.flatMap((c) => c[1]).sort()).toEqual(['r1', 'r2', 'r3']);
    });

    it('lee en lote: una consulta de totales y una de nombres para todas las escuelas', async () => {
        const avisar = vi.fn(async () => resultado({ enviados: 1 }));
        const { deps, contarPendientes, nombresDeEscuelas } = armar(
            [sol('r1', 'e1', H), sol('r2', 'e2', H), sol('r3', 'e3', H)], avisar);
        await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        expect(contarPendientes).toHaveBeenCalledTimes(1);
        expect(nombresDeEscuelas).toHaveBeenCalledTimes(1);
    });

    it('si no salió (silencio, sin suscriptores, canal) NO marca: se reintenta luego', async () => {
        for (const res of [resultado({ silencio: 1 }), resultado({ omitido: 'sin_suscripciones' }), resultado({ fallidos: 1 })]) {
            const { deps, marcar } = armar([sol('r1', 'e1', H)], vi.fn(async () => res));
            const r = await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
            expect(marcar).not.toHaveBeenCalled();
            expect(r.omitidas).toBe(1);
            expect(r.avisadas).toBe(0);
        }
    });

    it('un duplicado (otro BFF ya lo envió) sí marca, para no insistir', async () => {
        const { deps, marcar } = armar([sol('r1', 'e1', H)], vi.fn(async () => resultado({ duplicados: 1 })));
        await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        expect(marcar).toHaveBeenCalledTimes(1);
    });

    it('un aviso inicial sobre solicitudes de más de un día marca también el recordatorio', async () => {
        const { deps, marcar } = armar([sol('vieja', 'e1', 50 * H), sol('nueva', 'e1', H)], vi.fn(async () => resultado({ enviados: 1 })));
        await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        const llamadas = marcar.mock.calls as unknown as Array<[string, string[], string]>;
        expect(llamadas.map((c) => c[0])).toEqual(['inicial', 'recordatorio']);
        expect(llamadas[1][1]).toEqual(['vieja']);
    });

    it('el recordatorio marca wa_recordatorio_at, no el aviso', async () => {
        const { deps, marcar } = armar([sol('r1', 'e1', 30 * H, 29 * H)], vi.fn(async () => resultado({ enviados: 1 })));
        await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        const llamadas = marcar.mock.calls as unknown as Array<[string, string[], string]>;
        expect(llamadas.map((c) => c[0])).toEqual(['recordatorio']);
    });

    it('si una escuela falla, las demás siguen y nada lanza', async () => {
        const avisar = vi.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(resultado({ enviados: 1 }));
        const { deps } = armar([sol('r1', 'e1', 2 * H), sol('r2', 'e2', H)], avisar);
        const r = await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        expect(r).toEqual({ escuelas: 2, avisadas: 1, omitidas: 1 });
    });

    it('el mensaje lleva el nombre de la escuela, no el de ningún deportista', async () => {
        const avisar = vi.fn(async () => resultado({ enviados: 1 }));
        const { deps } = armar([sol('r1', 'e1', H)], avisar);
        await runSolicitudesUnionAvisos({ ahora: AHORA, deps });
        const enviado = (avisar.mock.calls[0] as unknown as [{ texto: string; plantilla: { variables: string[] } }])[0];
        expect(enviado.texto).toContain('Escuela e1');
        expect(enviado.plantilla.variables[0]).toBe('Escuela e1');
    });
});
