/**
 * whatsapp-atribucion-texto — reconocer el anuncio o el canal por el texto del primer mensaje
 * cuando Meta no manda `referral` (Monster 2026-11-04/06: 34 de 62 chats sin marca).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    reglas: [] as any[],
    reglasError: null as any,
    entrantes: [{ id: 'm1' }] as any[],
    previa: [] as any[],
    upserts: [] as any[],
    upsertError: null as any,
    lecturasDeReglas: 0,
    lecturasDeMensajes: 0,
}));

vi.mock('../config/supabase', () => {
    const consulta = (resultado: () => { data: any; error: any }) => {
        const q: any = {};
        for (const m of ['select', 'eq', 'or', 'limit']) q[m] = () => q;
        q.then = (ok: any, ko: any) => Promise.resolve(resultado()).then(ok, ko);
        return q;
    };
    return {
        supabase: {
            from: (tabla: string) => {
                if (tabla === 'whatsapp_anuncio_regla') {
                    return consulta(() => { db.lecturasDeReglas++; return { data: db.reglasError ? null : db.reglas, error: db.reglasError }; });
                }
                if (tabla === 'whatsapp_messages') {
                    return consulta(() => { db.lecturasDeMensajes++; return { data: db.entrantes, error: null }; });
                }
                if (tabla === 'whatsapp_atribucion') {
                    const q: any = consulta(() => ({ data: db.previa, error: null }));
                    q.upsert = (fila: any) => {
                        db.upserts.push(fila);
                        return Promise.resolve({ data: null, error: db.upsertError });
                    };
                    return q;
                }
                throw new Error(`tabla inesperada: ${tabla}`);
            },
        },
    };
});

import {
    atribuirPorTexto, buscarRegla, normalizarParaRegla, slugDeEtiqueta, sourceIdDeRegla, traeReferral, vaciarCacheDeReglas,
    type ReglaAtribucion,
} from './whatsapp-atribucion-texto';

const regla = (p: Partial<ReglaAtribucion> & { patron: string; etiqueta: string }): ReglaAtribucion => ({
    id: `r-${p.patron}`, school_id: null, tipo: 'anuncio', ...p,
});

const CANAL_IG = regla({ patron: '(instagram)', etiqueta: 'Canal: Instagram', tipo: 'canal' });
const REEL = regla({ patron: 'Hola, vi el reel de la clínica', etiqueta: 'Clínica · reel 1', school_id: 'esc-1' });
const FB = regla({ patron: 'Hola, quiero información de la clínica de armadores', etiqueta: 'Clínica · Facebook', school_id: 'esc-1' });

describe('normalizarParaRegla', () => {
    it('sin tildes, mayúsculas ni signos; conserva paréntesis', () => {
        expect(normalizarParaRegla('¡Hola! Quiero INFORMACIÓN de la Clínica (Instagram)'))
            .toBe('hola quiero informacion de la clinica (instagram)');
    });
    it('vacío o nulo', () => {
        expect(normalizarParaRegla(null)).toBe('');
        expect(normalizarParaRegla('  ¿¡?  ')).toBe('');
    });
});

describe('slugDeEtiqueta / sourceIdDeRegla', () => {
    it('slug seguro y estable', () => {
        expect(slugDeEtiqueta('Canal: Código QR / volante')).toBe('canal-codigo-qr-volante');
        expect(slugDeEtiqueta('???')).toBe('sin-nombre');
        expect(sourceIdDeRegla({ etiqueta: 'Clínica · reel 1' })).toBe('texto:clinica-reel-1');
    });
    it('cabe en source_id (100)', () => {
        expect(sourceIdDeRegla({ etiqueta: 'x'.repeat(300) }).length).toBeLessThanOrEqual(100);
    });
});

describe('buscarRegla', () => {
    const reglas = [CANAL_IG, REEL, FB];

    it('reconoce la frase del anuncio aunque falten comas, tildes o mayúsculas', () => {
        expect(buscarRegla('hola vi el reel de la clinica y quiero separar mi cupo', reglas)?.etiqueta).toBe('Clínica · reel 1');
        expect(buscarRegla('HOLA, QUIERO INFORMACIÓN DE LA CLÍNICA DE ARMADORES!', reglas)?.etiqueta).toBe('Clínica · Facebook');
    });
    it('reconoce la marca de canal entre paréntesis', () => {
        expect(buscarRegla('Hola! Me interesa entrenar con ustedes (Instagram)', reglas)?.etiqueta).toBe('Canal: Instagram');
        expect(buscarRegla('Hola! Me interesa entrenar con ustedes(instagram)', reglas)?.etiqueta).toBe('Canal: Instagram');
    });
    it('una frase de anuncio manda sobre la marca de canal', () => {
        expect(buscarRegla('Hola, vi el reel de la clínica (Instagram)', reglas)?.etiqueta).toBe('Clínica · reel 1');
    });
    it('«instagram» suelto NO es la marca (hay que escribirla entre paréntesis)', () => {
        expect(buscarRegla('vi un reel en instagram sobre la clínica', reglas)).toBeNull();
    });
    it('la frase del anuncio exige palabras completas', () => {
        const r = [regla({ patron: 'reel', etiqueta: 'Reel' })];
        expect(buscarRegla('quiero ver el reel de la clínica', r)?.etiqueta).toBe('Reel');
        expect(buscarRegla('carreleras de la clínica', r)).toBeNull();
    });
    it('la frase más larga gana; a igualdad, la de la escuela sobre la de la plataforma', () => {
        const corta = regla({ patron: 'clínica', etiqueta: 'Clínica (general)' });
        const larga = regla({ patron: 'info de la clínica', etiqueta: 'Clínica (info)' });
        expect(buscarRegla('Hola, info de la clínica', [corta, larga])?.etiqueta).toBe('Clínica (info)');
        const plat = regla({ patron: 'entrenar', etiqueta: 'Plataforma', school_id: null });
        const esc = regla({ patron: 'entrenar', etiqueta: 'Escuela', school_id: 'esc-1' });
        expect(buscarRegla('quiero entrenar', [plat, esc])?.etiqueta).toBe('Escuela');
        expect(buscarRegla('quiero entrenar', [esc, plat])?.etiqueta).toBe('Escuela');
    });
    it('sin texto o sin reglas: null', () => {
        expect(buscarRegla('', reglas)).toBeNull();
        expect(buscarRegla(null, reglas)).toBeNull();
        expect(buscarRegla('hola', [])).toBeNull();
        expect(buscarRegla('hola', [regla({ patron: '', etiqueta: 'x' })])).toBeNull();
    });
});

describe('traeReferral', () => {
    it('solo si el payload trae el objeto', () => {
        expect(traeReferral({ referral: { source_id: '1' } })).toBe(true);
        expect(traeReferral({ referral: null })).toBe(false);
        expect(traeReferral({})).toBe(false);
        expect(traeReferral(null)).toBe(false);
    });
});

describe('atribuirPorTexto', () => {
    const base = {
        integrationId: 'int-1', schoolId: 'esc-1', conversationId: 'conv-1', contactWaId: '573001112222',
        type: 'text', texto: 'Hola! Me interesa entrenar con ustedes (Instagram)', raw: { type: 'text' },
        ahora: new Date('2026-11-06T15:00:00Z'),
    };

    beforeEach(() => {
        vaciarCacheDeReglas();
        db.reglas = [{ id: 'p1', school_id: null, patron: '(instagram)', etiqueta: 'Canal: Instagram', tipo: 'canal', activa: true }];
        db.reglasError = null;
        db.entrantes = [{ id: 'm1' }];
        db.previa = [];
        db.upserts = [];
        db.upsertError = null;
        db.lecturasDeReglas = 0;
        db.lecturasDeMensajes = 0;
    });

    it('guarda la atribución con source_id texto:<etiqueta> y no pisa nada', async () => {
        expect(await atribuirPorTexto(base)).toBe('atribuida');
        expect(db.upserts).toHaveLength(1);
        expect(db.upserts[0]).toMatchObject({
            conversation_id: 'conv-1', integration_id: 'int-1', school_id: 'esc-1', contact_wa_id: '573001112222',
            primer_source_id: 'texto:canal-instagram', primer_source_type: 'texto', primer_headline: 'Canal: Instagram',
            ultimo_source_id: 'texto:canal-instagram', toques: 1, primer_historial: false,
            primer_at: '2026-11-06T15:00:00.000Z',
        });
    });

    it('si el mensaje trae referral de Meta, no hace nada (manda el real)', async () => {
        expect(await atribuirPorTexto({ ...base, raw: { referral: { source_id: '123' } } })).toBe('trae_referral');
        expect(db.upserts).toHaveLength(0);
        expect(db.lecturasDeReglas).toBe(0);
    });

    it('audios, imágenes y demás: no se miran', async () => {
        expect(await atribuirPorTexto({ ...base, type: 'audio', texto: null })).toBe('no_es_texto');
        expect(await atribuirPorTexto({ ...base, texto: '' })).toBe('no_es_texto');
        expect(db.upserts).toHaveLength(0);
    });

    it('sin regla que calce: no toca la base de mensajes ni atribuciones', async () => {
        expect(await atribuirPorTexto({ ...base, texto: 'Hola, buenas noches' })).toBe('sin_regla');
        expect(db.lecturasDeMensajes).toBe(0);
        expect(db.upserts).toHaveLength(0);
    });

    it('solo el primer entrante: una conversación vieja que vuelve con la marca no cambia de origen', async () => {
        db.entrantes = [{ id: 'm1' }, { id: 'm2' }];
        expect(await atribuirPorTexto(base)).toBe('no_es_el_primero');
        expect(db.upserts).toHaveLength(0);
    });

    it('si ya tiene atribución (un referral real), no la pisa', async () => {
        db.previa = [{ conversation_id: 'conv-1' }];
        expect(await atribuirPorTexto(base)).toBe('ya_atribuida');
        expect(db.upserts).toHaveLength(0);
    });

    it('lee las reglas UNA vez por minuto, no por mensaje', async () => {
        await atribuirPorTexto(base);
        await atribuirPorTexto({ ...base, conversationId: 'conv-2' });
        await atribuirPorTexto({ ...base, conversationId: 'conv-3', texto: 'hola' });
        expect(db.lecturasDeReglas).toBe(1);
    });

    it('sin la tabla de reglas (migración sin aplicar): no hace nada ni lanza', async () => {
        db.reglasError = { code: '42P01', message: 'relation "whatsapp_anuncio_regla" does not exist' };
        expect(await atribuirPorTexto(base)).toBe('sin_regla');
        expect(db.upserts).toHaveLength(0);
    });

    it('un error al guardar devuelve error y no lanza (nunca frena el webhook)', async () => {
        db.upsertError = { code: 'XX000', message: 'boom' };
        expect(await atribuirPorTexto(base)).toBe('error');
    });
});
