import { describe, it, expect } from 'vitest';
import {
    normalizarEscalones, porcentajeRestante, umbralesDelPeriodo, decidirAvisos, aplicarDecision, armarMensaje,
    formatoHoras, clasesRestantes, fechaDeRenovacion, dentroDeHorarioDeCorreo,
} from './hour-bank-balance-notices.shared';

describe('normalizarEscalones', () => {
    it('ordena de mayor a menor, quita repetidos y valores fuera de 0..100', () => {
        expect(normalizarEscalones([20, 50, 0, 20, 150, -5, 'x', 12.5])).toEqual([50, 20, 0]);
    });
    it('lo que no es arreglo → sin avisos', () => {
        expect(normalizarEscalones(null)).toEqual([]);
        expect(normalizarEscalones('50,20')).toEqual([]);
        expect(normalizarEscalones([])).toEqual([]);
    });
});

describe('porcentajeRestante', () => {
    it('36 h incluidas, 29 h usadas → ~19,4 %', () => {
        expect(porcentajeRestante(2160, 29 * 60)).toBeCloseTo(19.44, 1);
    });
    it('nunca baja de 0 ni pasa de 100', () => {
        expect(porcentajeRestante(480, 600)).toBe(0);
        expect(porcentajeRestante(480, -50)).toBe(100);
    });
    it('sin horas incluidas → null', () => {
        expect(porcentajeRestante(0, 0)).toBeNull();
    });
});

describe('umbralesDelPeriodo', () => {
    it('porcentajes + «quedan 2 clases» y «queda 1 clase» con el bloque del plan', () => {
        const u = umbralesDelPeriodo([50, 20, 0], 3840, 240); // PGC16x4: 64 h, bloques de 4 h
        expect(u.map((x) => [x.clave, x.minutos])).toEqual([['50', 1920], ['20', 768], ['0', 0], ['c2', 480], ['c1', 240]]);
    });
    it('un escalón de clases que no cabe en el plan se omite', () => {
        expect(umbralesDelPeriodo([50, 0], 240, 120).map((x) => x.clave)).toEqual(['50', '0', 'c1']); // 2 clases = todo el plan
    });
    it('avisos apagados o sin horas → escalera vacía', () => {
        expect(umbralesDelPeriodo([], 3840, 240)).toEqual([]);
        expect(umbralesDelPeriodo([50], 0, 240)).toEqual([]);
    });
});

describe('decidirAvisos', () => {
    const inc = 2160; // 36 h, bloques de 2 h
    const umbrales = umbralesDelPeriodo([50, 20, 0], inc, 120); // 50 → 1080, 20 → 432, c2 → 240, c1 → 120, 0 → 0
    const restante = (pct: number) => (inc * pct) / 100;
    const claves = (d: ReturnType<typeof decidirAvisos>) => d.aEnviar?.clave ?? null;
    it('saldo alto: no avisa', () => {
        expect(decidirAvisos(umbrales, restante(80), {})).toEqual({ aEnviar: null, marcarEnSilencio: [], borrarMarcas: [] });
    });
    it('cruza el 50 %: avisa 50', () => {
        expect(claves(decidirAvisos(umbrales, restante(48), {}))).toBe('50');
    });
    it('un escalón sale UNA sola vez', () => {
        expect(decidirAvisos(umbrales, restante(48), { '50': '2026-10-05T00:00:00Z' }).aEnviar).toBeNull();
    });
    it('de 80 % a 15 % de golpe: avisa solo el 20 y deja el 50 marcado en silencio', () => {
        const d = decidirAvisos(umbrales, restante(15), {});
        expect(claves(d)).toBe('20');
        expect(d.marcarEnSilencio).toEqual(['50']);
    });
    it('quedan 2 clases justas: avisa «c2»', () => {
        const d = decidirAvisos(umbrales, 240, { '50': 'a', '20': 'b' });
        expect(claves(d)).toBe('c2');
        expect(d.aEnviar?.tipo).toBe('clases');
    });
    it('queda 1 clase: avisa «c1»', () => {
        expect(claves(decidirAvisos(umbrales, 120, { '50': 'a', '20': 'b', c2: 'c' }))).toBe('c1');
    });
    it('a igual umbral gana el de clases y el porcentaje queda en silencio', () => {
        const u = umbralesDelPeriodo([25], 960, 120); // 25 % de 16 h = 4 h = 2 clases
        const d = decidirAvisos(u, 240, {});
        expect(claves(d)).toBe('c2');
        expect(d.marcarEnSilencio).toEqual(['25']);
    });
    it('0 horas con todo lo anterior enviado: avisa el 0', () => {
        const d = decidirAvisos(umbrales, 0, { '50': 'a', '20': 'b', c2: 'c', c1: 'd' });
        expect(claves(d)).toBe('0');
        expect(d.marcarEnSilencio).toEqual([]);
    });
    it('recarga: si el saldo vuelve a subir por encima del umbral, se borra la marca', () => {
        const d = decidirAvisos(umbrales, restante(60), { '50': 'a', '20': 'b', c2: 'c' });
        expect(d.borrarMarcas.sort()).toEqual(['20', '50', 'c2']);
        expect(d.aEnviar).toBeNull();
    });
    it('tras la recarga una segunda bajada vuelve a avisar', () => {
        const marcas = aplicarDecision({ '50': 'a', '20': 'b' }, decidirAvisos(umbrales, restante(60), { '50': 'a', '20': 'b' }), 'ahora');
        expect(marcas).toEqual({});
        expect(claves(decidirAvisos(umbrales, restante(45), marcas))).toBe('50');
    });
    it('sin escalones configurados: no hace nada', () => {
        expect(decidirAvisos([], 10, {}).aEnviar).toBeNull();
    });
    it('un reintento con el mismo saldo no reenvía (marca ya aplicada)', () => {
        const d1 = decidirAvisos(umbrales, restante(18), {});
        const marcas = aplicarDecision({}, d1, 'ahora');
        const d2 = decidirAvisos(umbrales, restante(18), marcas);
        expect(d2.aEnviar).toBeNull();
        expect(d2.marcarEnSilencio).toEqual([]);
    });
});

describe('aplicarDecision', () => {
    it('no muta la entrada y marca enviado + silencio', () => {
        const entrada = { '50': 'x' };
        const aEnviar = { clave: 'c2', tipo: 'clases' as const, valor: 2, minutos: 240 };
        const out = aplicarDecision(entrada, { aEnviar, marcarEnSilencio: ['50'], borrarMarcas: [] }, 'T');
        expect(entrada).toEqual({ '50': 'x' });
        expect(out).toEqual({ '50': 'T', c2: 'T' });
    });
});

describe('formatoHoras / clasesRestantes', () => {
    it('formatea', () => {
        expect(formatoHoras(0)).toBe('0 h');
        expect(formatoHoras(45)).toBe('45 min');
        expect(formatoHoras(120)).toBe('2 h');
        expect(formatoHoras(150)).toBe('2 h 30 min');
    });
    it('clases enteras que caben', () => {
        expect(clasesRestantes(216, 120)).toBe(1);
        expect(clasesRestantes(360, 120)).toBe(3);
        expect(clasesRestantes(-10, 120)).toBe(0);
        expect(clasesRestantes(100, 0)).toBe(0);
    });
});

describe('armarMensaje', () => {
    const base = { atleta: 'Camila', incluidoMinutos: 2160, bloqueMinutos: 120, seRenueva: '1 de noviembre', momento: 'cierre' as const };
    it('50 %: dice cuánto queda y cuándo se renueva', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'pct' as const, valor: 50 }, restanteMinutos: 1080 });
        expect(m.cuerpo).toContain('18 h');
        expect(m.cuerpo).toContain('1 de noviembre');
        expect(m.cuerpo).toContain('(50 %)');
        expect(m.cuerpo).toContain('9 clases más');
        expect(m.severidad).toBe('info');
    });
    it('quedan 2 clases: dice horas, clases y porcentaje', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'clases', valor: 2 }, restanteMinutos: 240 });
        expect(m.titulo).toBe('A Camila le quedan 2 clases este mes');
        expect(m.cuerpo).toContain('4 h de las 36 h de este mes (11 %)');
        expect(m.cuerpo).toContain('2 clases más de 2 h');
        expect(m.severidad).toBe('aviso');
    });
    it('queda 1 clase: título en singular', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'clases', valor: 1 }, restanteMinutos: 150 });
        expect(m.titulo).toBe('A Camila le queda 1 clase este mes');
        expect(m.cuerpo).toContain('1 clase más');
    });
    it('20 %: cuenta las clases que alcanzan (N sale del bloque, no se escribe a mano)', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'pct' as const, valor: 20 }, restanteMinutos: 432 });
        expect(m.titulo).toContain('7 h 12 min');
        expect(m.cuerpo).toContain('3 clases más');
        expect(m.severidad).toBe('aviso');
    });
    it('20 % en la ENTRADA dice que acaba de entrar', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'pct' as const, valor: 20 }, restanteMinutos: 432, momento: 'entrada' });
        expect(m.cuerpo).toContain('acaba de entrar');
    });
    it('menos de un bloque: dice que ya no alcanza para una clase completa', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'pct' as const, valor: 10 }, restanteMinutos: 90 });
        expect(m.cuerpo).toContain('no alcanza para una clase completa');
    });
    it('0 %: crítico, y NO promete bloqueo si no está encendido', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'pct' as const, valor: 0 }, restanteMinutos: 0 });
        expect(m.severidad).toBe('critico');
        expect(m.cuerpo).toContain('usó las 36 h');
        expect(m.cuerpo).not.toContain('no abrirá');
    });
    it('0 % con bloqueo encendido lo anuncia', () => {
        const m = armarMensaje({ ...base, aviso: { tipo: 'pct' as const, valor: 0 }, restanteMinutos: 0, conBloqueo: true });
        expect(m.cuerpo).toContain('no abrirá');
    });
});

describe('fechaDeRenovacion', () => {
    it('día 1 del mes siguiente al fin del período', () => {
        expect(fechaDeRenovacion('2026-10-31', '2026-10-20')).toBe('1 de noviembre');
        expect(fechaDeRenovacion('2026-12-31', '2026-12-20')).toBe('1 de enero');
    });
    it('sin fin de período usa el mes de hoy', () => {
        expect(fechaDeRenovacion(null, '2026-10-20')).toBe('1 de noviembre');
    });
});

describe('dentroDeHorarioDeCorreo', () => {
    it('8:00–19:59 hora Colombia', () => {
        expect(dentroDeHorarioDeCorreo(new Date('2026-10-23T13:00:00Z'))).toBe(true);  // 8:00
        expect(dentroDeHorarioDeCorreo(new Date('2026-10-23T12:59:00Z'))).toBe(false); // 7:59
        expect(dentroDeHorarioDeCorreo(new Date('2026-10-24T00:59:00Z'))).toBe(true);  // 19:59
        expect(dentroDeHorarioDeCorreo(new Date('2026-10-24T01:00:00Z'))).toBe(false); // 20:00
    });
});
