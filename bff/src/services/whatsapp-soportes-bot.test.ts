/**
 * Soportes por WhatsApp (solo escuelas con `activo`): adjunto → ¿soporte o comprobante? → ¿de qué deportista? →
 * ¿de cuál soporte? → confirmar → `guardarSoporte`. Con la función apagada el adjunto sigue como comprobante.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('./whatsapp.service', () => ({ downloadMedia: vi.fn() }));

import {
    clasificarAdjunto, soporteDeTexto, elegirOpcion, estadoPendiente, atenderAdjuntoDeSoporte, atenderRespuestaDeSoporte,
    enviarRecordatoriosDeSoportes, textoRecordatorioSoportes, waIdDeCelular, limpiarCacheSoportes,
    TEXTOS_SOPORTE, BOTON_SOPORTE, PASO_SOPORTE, FLUJO_SOPORTE,
    type DepsSoportes, type CtxSoportes, type EstadoSoporte, type DepsRecordatorios,
} from './whatsapp-soportes-bot';
import type { FilaEstado, GuardarSoporteParams } from './soportes.service';
import type { FilaReciente } from './whatsapp-reglas-turno';

const PROHIBIDAS = /\b(mora|deuda|atraso|vencid|multa|recargo|gratis)/i;
const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const PERFIL = 'perfil-mama';
const SIETE = ['athlete_photo', 'eps_certificate', 'guardian_id_front', 'athlete_id_front', 'guardian_signature', 'athlete_signature', 'good_standing_certificate'];

const fila = (id: string, nombre: string, missing: string[], extra: Partial<FilaEstado> = {}): FilaEstado => ({
    subject_type: 'child', subject_id: id, full_name: nombre, notify_profile_id: PERFIL, has_account: true,
    required_total: 7, present_total: 7 - missing.length, missing, complete: missing.length === 0, ...extra,
});

interface Escenario {
    activo?: boolean;
    atiende?: boolean;
    parentId?: string | null;
    filas?: FilaEstado[];
    fichas?: { childIds: string[]; unregisteredIds: string[] };
    esFamilia?: (u: string, s: any) => boolean;
    guardar?: (p: GuardarSoporteParams) => any;
    descarga?: any;
}

function armar(e: Escenario = {}) {
    const enviados: { texto: string; context: any; botones?: any[] }[] = [];
    const guardados: GuardarSoporteParams[] = [];
    const encolados: any[] = [];
    const deps: DepsSoportes = {
        config: vi.fn(async () => ({ activo: e.activo ?? true, requeridos: SIETE })),
        estado: vi.fn(async () => e.filas ?? []),
        fichas: vi.fn(async () => e.fichas ?? { childIds: [], unregisteredIds: [] }),
        esFamilia: vi.fn(async (u, s) => (e.esFamilia ? e.esFamilia(u, s) : true)),
        descargar: vi.fn(async () => e.descarga ?? { ok: true, buffer: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' }),
        guardar: vi.fn(async (p) => {
            guardados.push(p);
            return e.guardar ? e.guardar(p) : { ok: true, id: 'doc-1', storagePath: 'x', tipo: p.tipo, faltan: [], completo: true, activo: true };
        }),
        contacto: vi.fn(async () => ({ atiende: e.atiende ?? true, parentId: e.parentId === undefined ? PERFIL : e.parentId })),
        encolar: vi.fn(async (_i, a) => { encolados.push(a); }),
    };
    const ctx: CtxSoportes = {
        integration: INTEGRATION, conversationId: 'conv-1', contactWaId: '573001112233',
        enviar: async (texto, context, botones) => { enviados.push({ texto, context, botones }); },
    };
    return { deps, ctx, enviados, guardados, encolados };
}

const adjunto = (caption: string | null = null, type: 'image' | 'document' = 'image', mime = 'image/jpeg') => ({
    type, waMessageId: 'wamid.in1', mediaId: 'media-1', mediaMimeType: mime, mediaCaption: caption,
});

/** El último saliente del bot, tal como `deliver` lo deja en `whatsapp_messages.payload`. */
const salienteDe = (e: { context: any }, min = 1): FilaReciente =>
    ({ direction: 'outbound', type: 'interactive', text_body: 'x', payload: e.context, ai_generated: true, created_at: new Date(Date.now() - min * 60_000).toISOString() });
const entrante = (t: string, min = 0): FilaReciente =>
    ({ direction: 'inbound', type: 'text', text_body: t, payload: {}, ai_generated: null, created_at: new Date(Date.now() - min * 60_000).toISOString() });

beforeEach(() => limpiarCacheSoportes());

describe('reglas puras', () => {
    it('clasifica el adjunto: pago, soporte o duda', () => {
        expect(clasificarAdjunto('comprobante de la mensualidad', [])).toBe('pago');
        expect(clasificarAdjunto('Aquí el pago de noviembre', [])).toBe('pago');
        expect(clasificarAdjunto('cédula del acudiente', [])).toBe('soporte');
        expect(clasificarAdjunto('foto de Sara', [])).toBe('duda');
        expect(clasificarAdjunto(null, [])).toBe('duda');
        // venía de dinero (lo dijo ella o preguntó el bot): comprobante
        expect(clasificarAdjunto(null, [entrante('ya hice la transferencia', 5)])).toBe('pago');
        expect(clasificarAdjunto(null, [{ direction: 'outbound', payload: { step: 'ask_deportista' }, created_at: new Date().toISOString() } as any])).toBe('pago');
        // charla vieja (más de una hora): no cuenta
        expect(clasificarAdjunto(null, [entrante('ya hice la transferencia', 180)])).toBe('duda');
    });

    it('lee el soporte del texto solo entre los que faltan y solo si es uno', () => {
        expect(soporteDeTexto('certificado de la EPS', SIETE)).toBe('eps_certificate');
        expect(soporteDeTexto('paz y salvo', SIETE)).toBe('good_standing_certificate');
        expect(soporteDeTexto('firma del acudiente', SIETE)).toBe('guardian_signature');
        expect(soporteDeTexto('firma del deportista', SIETE)).toBe('athlete_signature');
        expect(soporteDeTexto('foto del deportista', SIETE)).toBe('athlete_photo');
        expect(soporteDeTexto('documento del acudiente', SIETE)).toBe('guardian_id_front');
        expect(soporteDeTexto('eps', ['athlete_photo'])).toBeNull(); // ya lo tiene
        expect(soporteDeTexto('hola', SIETE)).toBeNull();
    });

    it('elige una opción por botón, número o nombre único', () => {
        const ops = [{ nombre: 'Sara Gómez' }, { nombre: 'Juan Gómez' }];
        expect(elegirOpcion('2', null, ops)).toBe(ops[1]);
        expect(elegirOpcion('x', `${BOTON_SOPORTE.OPCION}0`, ops)).toBe(ops[0]);
        expect(elegirOpcion('el de Sara', null, ops)).toBe(ops[0]);
        expect(elegirOpcion('Gómez', null, ops)).toBeNull(); // ambiguo
        expect(elegirOpcion('7', null, ops)).toBeNull();
    });

    it('ningún texto nuevo contiene palabras prohibidas', () => {
        const T = TEXTOS_SOPORTE;
        const textos: string[] = [
            T.aclarar, T.comprobanteSigue, T.deportista(['Sara', 'Juan']), T.tipo('Sara', ['athlete_photo', 'eps_certificate']),
            T.confirmar('Sara', 'athlete_photo'), T.noEntendi, T.cancelado, T.expiro, T.guardado('Sara', 'athlete_photo', []),
            T.guardado('Sara', 'athlete_photo', ['eps_certificate']), T.grande, T.formato, T.falla, T.sinArchivo, T.ya,
        ];
        textos.push(textoRecordatorioSoportes('Monster', [{ nombre: 'Sara', faltan: SIETE }]));
        for (const t of textos) expect(t, t).not.toMatch(PROHIBIDAS);
    });

    it('el estado pendiente es el último saliente de este flujo y caduca a las 3 h', () => {
        const st: EstadoSoporte = { etapa: 'tipo', adjunto: { waMessageId: 'w', mediaId: 'm', mime: 'image/jpeg', type: 'image' } };
        const fila = salienteDe({ context: { step: PASO_SOPORTE.TIPO, flujo: FLUJO_SOPORTE, soporte: st } }, 5);
        expect(estadoPendiente([fila])?.etapa).toBe('tipo');
        expect(estadoPendiente([fila, { ...salienteDe({ context: { step: 'otra_cosa' } }, 1) }])).toBeNull(); // el bot habló después
        expect(estadoPendiente([salienteDe({ context: { step: PASO_SOPORTE.TIPO, flujo: FLUJO_SOPORTE, soporte: st } }, 200)])).toBeNull();
    });
});

describe('el adjunto entrante', () => {
    it('escuela con soportes apagados: no se hace nada (sigue como comprobante) y ni se lee el estado', async () => {
        const a = armar({ activo: false, filas: [fila('h1', 'Sara', SIETE)] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('cédula del acudiente'), [], a.deps)).toBe(false);
        expect(a.enviados).toHaveLength(0);
        expect(a.deps.estado).not.toHaveBeenCalled();
        expect(a.deps.contacto).not.toHaveBeenCalled();
    });

    it('persona sin soportes por cargar: sigue como comprobante', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', [])] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto(), [], a.deps)).toBe(false);
        const b = armar({ filas: [fila('h9', 'Ajeno', SIETE, { notify_profile_id: 'otra-persona' })] });
        expect(await atenderAdjuntoDeSoporte(b.ctx, adjunto(), [], b.deps)).toBe(false);
    });

    it('un contacto que el bot no atiende (staff, bot apagado, tomada) no entra', async () => {
        const a = armar({ atiende: false, filas: [fila('h1', 'Sara', SIETE)] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps)).toBe(false);
    });

    it('palabras de pago: comprobante, el bot no dice nada', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('comprobante de pago'), [], a.deps)).toBe(false);
        expect(a.enviados).toHaveLength(0);
    });

    it('una charla reciente de dinero (el bot acaba de dar los medios de pago): comprobante', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        const rec = [{ direction: 'outbound', payload: { step: 'medios_de_pago_publicos' }, created_at: new Date().toISOString() } as any];
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto(), rec, a.deps)).toBe(false);
    });

    it('formatos que no son de soporte (audio, mime raro) no entran', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte', 'document', 'application/zip'), [], a.deps)).toBe(false);
        expect(await atenderAdjuntoDeSoporte(a.ctx, { ...adjunto('soporte'), mediaId: null }, [], a.deps)).toBe(false);
    });

    it('ante la duda pregunta «¿soporte de la ficha o comprobante de pago?» con dos botones', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto(), [], a.deps)).toBe(true);
        expect(a.enviados[0].texto).toContain('soporte de la ficha');
        expect(a.enviados[0].texto).toContain('comprobante de pago');
        expect(a.enviados[0].botones?.map((b) => b.id)).toEqual([BOTON_SOPORTE.ES_SOPORTE, BOTON_SOPORTE.ES_PAGO]);
        expect(a.enviados[0].context.flujo).toBe(FLUJO_SOPORTE);
    });

    it('con VARIOS hijos pregunta de qué deportista', async () => {
        const a = armar({ filas: [fila('h1', 'Sara Gómez', SIETE), fila('h2', 'Juan Gómez', ['eps_certificate'])] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('foto de la eps'), [], a.deps)).toBe(true);
        expect(a.enviados[0].context.step).toBe(PASO_SOPORTE.DEPORTISTA);
        expect(a.enviados[0].texto).toContain('1. Sara Gómez');
        expect(a.enviados[0].texto).toContain('2. Juan Gómez');
    });

    it('con un solo deportista y varios faltantes pregunta de cuál soporte, solo entre los que faltan', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate', 'good_standing_certificate'])] });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte de Sara'), [], a.deps)).toBe(true);
        expect(a.enviados[0].context.step).toBe(PASO_SOPORTE.TIPO);
        expect(a.enviados[0].texto).toContain('Certificado de la EPS');
        expect(a.enviados[0].texto).toContain('Paz y salvo');
        expect(a.enviados[0].texto).not.toContain('Foto del deportista');
    });

    it('si falta UNO solo, o el pie lo dice, propone directo y pide confirmar', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate'])] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
        expect(a.enviados[0].context.step).toBe(PASO_SOPORTE.CONFIRMAR);
        const b = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        await atenderAdjuntoDeSoporte(b.ctx, adjunto('certificado de la EPS de Sara'), [], b.deps);
        expect(b.enviados[0].context.step).toBe(PASO_SOPORTE.CONFIRMAR);
        expect(b.enviados[0].context.soporte.soporte).toBe('eps_certificate');
    });

    it('la ficha SIN cuenta se reconoce por el teléfono (solo sus fichas)', async () => {
        const a = armar({
            parentId: null,
            fichas: { childIds: ['h1'], unregisteredIds: [] },
            filas: [fila('h1', 'Sara', SIETE, { notify_profile_id: null, has_account: false }), fila('h2', 'Ajena', SIETE, { notify_profile_id: null, has_account: false })],
        });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps)).toBe(true);
        expect(a.enviados[0].texto).toContain('Sara');
        expect(a.enviados[0].texto).not.toContain('Ajena');
        // y sin ficha por teléfono: comprobante
        const b = armar({ parentId: null, fichas: { childIds: [], unregisteredIds: [] }, filas: [fila('h2', 'Ajena', SIETE, { notify_profile_id: null })] });
        expect(await atenderAdjuntoDeSoporte(b.ctx, adjunto('soporte'), [], b.deps)).toBe(false);
    });

    it('si el vínculo familiar no se confirma, ese deportista no es candidato', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)], esFamilia: () => false });
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps)).toBe(false);
    });

    it('cualquier error del módulo deja pasar el adjunto como comprobante', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        (a.deps.estado as any).mockRejectedValueOnce(new Error('rpc caída'));
        expect(await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps)).toBe(false);
    });
});

describe('la conversación completa', () => {
    it('foto con pie «EPS» de la única hija con faltantes → confirmar → guarda y dice qué falta', async () => {
        const filas = [fila('h1', 'Sara', ['eps_certificate', 'athlete_photo'])];
        const a = armar({
            filas,
            guardar: (p) => ({ ok: true, id: 'd', storagePath: 'x', tipo: p.tipo, faltan: ['athlete_photo'], completo: false, activo: true }),
        });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('certificado de la EPS'), [], a.deps);
        const pregunta = a.enviados[0];
        expect(pregunta.context.step).toBe(PASO_SOPORTE.CONFIRMAR);

        const r = await atenderRespuestaDeSoporte(a.ctx, 'Sí, guardar', BOTON_SOPORTE.SI, [salienteDe(pregunta)], a.deps);
        expect(r).toBe(true);
        expect(a.guardados).toHaveLength(1);
        expect(a.guardados[0]).toMatchObject({ schoolId: 'school-1', sujeto: { tipo: 'child', id: 'h1' }, tipo: 'eps_certificate', subidoPor: PERFIL });
        const fin = a.enviados[1];
        expect(fin.texto).toContain('Guardé *Certificado de la EPS*');
        expect(fin.texto).toContain('Foto del deportista');
        expect(fin.texto).toContain('Aún le faltan 1');
    });

    it('varios hijos: elige el deportista por nombre, luego el soporte por número, confirma con texto', async () => {
        const filas = [fila('h1', 'Sara Gómez', SIETE), fila('h2', 'Juan Pérez', SIETE)];
        const a = armar({ filas });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
        const q1 = a.enviados[0];
        expect(q1.context.step).toBe(PASO_SOPORTE.DEPORTISTA);

        expect(await atenderRespuestaDeSoporte(a.ctx, 'el de Juan', null, [salienteDe(q1)], a.deps)).toBe(true);
        const q2 = a.enviados[1];
        expect(q2.context.step).toBe(PASO_SOPORTE.TIPO);
        expect(q2.texto).toContain('Juan Pérez');

        expect(await atenderRespuestaDeSoporte(a.ctx, '2', null, [salienteDe(q2)], a.deps)).toBe(true);
        const q3 = a.enviados[2];
        expect(q3.context.step).toBe(PASO_SOPORTE.CONFIRMAR);
        expect(q3.context.soporte.soporte).toBe('eps_certificate');

        expect(await atenderRespuestaDeSoporte(a.ctx, 'si', null, [salienteDe(q3)], a.deps)).toBe(true);
        expect(a.guardados[0]).toMatchObject({ sujeto: { tipo: 'child', id: 'h2' }, tipo: 'eps_certificate' });
        expect(a.enviados[3].texto).toContain('Ya están completos');
    });

    it('«Es otro soporte» vuelve a preguntar de cuál', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate', 'athlete_photo'])] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('eps'), [], a.deps);
        const q = a.enviados[0];
        expect(await atenderRespuestaDeSoporte(a.ctx, 'Es otro soporte', BOTON_SOPORTE.OTRO, [salienteDe(q)], a.deps)).toBe(true);
        expect(a.enviados[1].context.step).toBe(PASO_SOPORTE.TIPO);
        expect(a.guardados).toHaveLength(0);
    });

    it('cancelar no guarda nada', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate'])] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
        expect(await atenderRespuestaDeSoporte(a.ctx, 'cancelar', null, [salienteDe(a.enviados[0])], a.deps)).toBe(true);
        expect(a.guardados).toHaveLength(0);
        expect(a.enviados[1].texto).toBe(TEXTOS_SOPORTE.cancelado);
    });

    it('«comprobante de pago» tras la duda: se encola como comprobante y el bot no agrega nada', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto(), [], a.deps);
        const q = a.enviados[0];
        expect(await atenderRespuestaDeSoporte(a.ctx, 'Comprobante de pago', BOTON_SOPORTE.ES_PAGO, [salienteDe(q)], a.deps)).toBe(true);
        expect(a.encolados).toHaveLength(1);
        expect(a.encolados[0]).toMatchObject({ mediaId: 'media-1', waMessageId: 'wamid.in1' });
        expect(a.enviados).toHaveLength(1);
        expect(a.guardados).toHaveLength(0);
    });

    it('«soporte de la ficha» tras la duda sigue el flujo', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate'])] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto(), [], a.deps);
        expect(await atenderRespuestaDeSoporte(a.ctx, 'Soporte de la ficha', BOTON_SOPORTE.ES_SOPORTE, [salienteDe(a.enviados[0])], a.deps)).toBe(true);
        expect(a.enviados[1].context.step).toBe(PASO_SOPORTE.CONFIRMAR);
    });

    it('SEGURIDAD: un deportista del payload que ya no es de esta persona NO se guarda', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate'])] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
        const q = a.enviados[0];
        // El estado dice h1, pero la base ya no lo devuelve para esta persona (o el vínculo se rompió).
        (a.deps.estado as any).mockResolvedValue([]);
        expect(await atenderRespuestaDeSoporte(a.ctx, 'si', BOTON_SOPORTE.SI, [salienteDe(q)], a.deps)).toBe(true);
        expect(a.guardados).toHaveLength(0);
        expect(a.enviados[1].texto).toBe(TEXTOS_SOPORTE.expiro);
    });

    it('SEGURIDAD: un payload manipulado hacia el deportista de OTRA familia no guarda', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate']), fila('h9', 'Ajeno', ['eps_certificate'], { notify_profile_id: 'otra-familia' })] });
        const falso: EstadoSoporte = {
            etapa: 'confirmar', adjunto: { waMessageId: 'w', mediaId: 'm', mime: 'image/jpeg', type: 'image' },
            sujeto: { tipo: 'child', id: 'h9', nombre: 'Ajeno' }, soporte: 'eps_certificate',
        };
        const fake = salienteDe({ context: { step: PASO_SOPORTE.CONFIRMAR, flujo: FLUJO_SOPORTE, soporte: falso } });
        expect(await atenderRespuestaDeSoporte(a.ctx, 'si', BOTON_SOPORTE.SI, [fake], a.deps)).toBe(true);
        expect(a.guardados).toHaveLength(0);
    });

    it('SEGURIDAD: si esFamiliaDelSujeto dice que no, no guarda', async () => {
        let ok = true;
        const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate'])], esFamilia: () => ok });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
        ok = false;
        expect(await atenderRespuestaDeSoporte(a.ctx, 'si', BOTON_SOPORTE.SI, [salienteDe(a.enviados[0])], a.deps)).toBe(true);
        expect(a.guardados).toHaveLength(0);
    });

    it('errores de guardado: archivo grande, formato y falla general, en español', async () => {
        for (const [status, esperado] of [[413, TEXTOS_SOPORTE.grande], [400, TEXTOS_SOPORTE.formato], [500, TEXTOS_SOPORTE.falla]] as const) {
            const a = armar({ filas: [fila('h1', 'Sara', ['eps_certificate'])], guardar: () => ({ ok: false, status, error: 'x' }) });
            await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
            await atenderRespuestaDeSoporte(a.ctx, 'si', BOTON_SOPORTE.SI, [salienteDe(a.enviados[0])], a.deps);
            expect(a.enviados[1].texto).toBe(esperado);
        }
        const b = armar({ filas: [fila('h1', 'Sara', ['eps_certificate'])], descarga: { ok: false, error: 'archivo_muy_grande:9000000' } });
        await atenderAdjuntoDeSoporte(b.ctx, adjunto('soporte'), [], b.deps);
        await atenderRespuestaDeSoporte(b.ctx, 'si', BOTON_SOPORTE.SI, [salienteDe(b.enviados[0])], b.deps);
        expect(b.enviados[1].texto).toBe(TEXTOS_SOPORTE.grande);
        expect(b.guardados).toHaveLength(0);
    });

    it('lo que no es respuesta: una pregunta larga o de otro tema sigue su camino (false); sin flujo abierto, false', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
        const q = a.enviados[0];
        expect(await atenderRespuestaDeSoporte(a.ctx, '¿a qué hora es el entreno de mañana?', null, [salienteDe(q)], a.deps)).toBe(false);
        expect(await atenderRespuestaDeSoporte(a.ctx, 'hola', null, [], a.deps)).toBe(false);
        // botón de otro flujo: no es suyo
        expect(await atenderRespuestaDeSoporte(a.ctx, 'x', 'sm_em_optin_si', [salienteDe(q)], a.deps)).toBe(false);
    });

    it('respuesta corta que no entiende: re-pregunta y al tercer intento cancela', async () => {
        const a = armar({ filas: [fila('h1', 'Sara', SIETE)] });
        await atenderAdjuntoDeSoporte(a.ctx, adjunto('soporte'), [], a.deps);
        let q = a.enviados[0];
        expect(await atenderRespuestaDeSoporte(a.ctx, 'mmm', null, [salienteDe(q)], a.deps)).toBe(true);
        q = a.enviados[1];
        expect(q.texto).toBe(TEXTOS_SOPORTE.noEntendi);
        expect(await atenderRespuestaDeSoporte(a.ctx, 'ehh', null, [salienteDe(q)], a.deps)).toBe(true);
        q = a.enviados[2];
        expect(await atenderRespuestaDeSoporte(a.ctx, 'no sé', null, [salienteDe(q)], a.deps)).toBe(true);
        expect(a.enviados[3].texto).toBe(TEXTOS_SOPORTE.cancelado);
        expect(a.guardados).toHaveLength(0);
    });

    it('con la función apagada o sin atención, ni responde', async () => {
        const a = armar({ activo: false, filas: [fila('h1', 'Sara', SIETE)] });
        const st: EstadoSoporte = { etapa: 'confirmar', adjunto: { waMessageId: 'w', mediaId: 'm', mime: 'image/jpeg', type: 'image' }, sujeto: { tipo: 'child', id: 'h1', nombre: 'Sara' }, soporte: 'eps_certificate' };
        const fake = salienteDe({ context: { step: PASO_SOPORTE.CONFIRMAR, flujo: FLUJO_SOPORTE, soporte: st } });
        expect(await atenderRespuestaDeSoporte(a.ctx, 'si', BOTON_SOPORTE.SI, [fake], a.deps)).toBe(false);
        expect(a.guardados).toHaveLength(0);
    });
});

describe('recordatorios por WhatsApp a las fichas sin cuenta', () => {
    const sinCuenta = (id: string, nombre: string, missing: string[], tipo: 'child' | 'unregistered' = 'child') =>
        fila(id, nombre, missing, { subject_type: tipo, notify_profile_id: null, has_account: false });

    function armarRec(op: { filas: FilaEstado[]; tels: Record<string, string>; ventanas?: Record<string, string>; baja?: string[]; reclamados?: string[] }) {
        const enviados: { wa: string; texto: string }[] = [];
        const reclamosPedidos: FilaEstado[][] = [];
        const deps: DepsRecordatorios = {
            escuelasConSoportes: vi.fn(async () => ['school-1']),
            estado: vi.fn(async () => op.filas),
            celulares: vi.fn(async () => new Map(Object.entries(op.tels))),
            integracion: vi.fn(async () => INTEGRATION),
            nombreEscuela: vi.fn(async () => 'Monsters Volley Club'),
            conVentanaAbierta: vi.fn(async () => new Map(Object.entries(op.ventanas ?? {}))),
            dadoDeBaja: vi.fn(async (_i, wa) => (op.baja ?? []).includes(wa)),
            reclamar: vi.fn(async (_s, sujetos) => {
                reclamosPedidos.push(sujetos);
                return new Set((op.reclamados ?? sujetos.map((f) => `${f.subject_type}:${f.subject_id}`)));
            }),
            enviar: vi.fn(async (_i, _c, wa, texto) => { enviados.push({ wa, texto }); }),
        };
        return { deps, enviados, reclamosPedidos };
    }

    it('un mensaje por celular aunque tenga varios hijos, solo a quien tiene la ventana abierta, sin lenguaje de cobro', async () => {
        const a = armarRec({
            filas: [sinCuenta('h1', 'Sara', ['eps_certificate']), sinCuenta('h2', 'Juan', SIETE), sinCuenta('h3', 'Lejana', SIETE), fila('h4', 'Con cuenta', SIETE)],
            tels: { 'child:h1': '3001112233', 'child:h2': '300 111 2233', 'child:h3': '3109998877' },
            ventanas: { '573001112233': 'conv-A' },
        });
        const r = await enviarRecordatoriosDeSoportes(a.deps);
        expect(r).toMatchObject({ escuelas: 1, candidatos: 3, enviados: 1, fueraDeVentana: 1, reclamados: 2 });
        expect(a.enviados).toHaveLength(1);
        expect(a.enviados[0].wa).toBe('573001112233');
        expect(a.enviados[0].texto).toContain('Sara');
        expect(a.enviados[0].texto).toContain('Juan');
        expect(a.enviados[0].texto).not.toContain('Con cuenta');
        expect(a.enviados[0].texto).not.toMatch(PROHIBIDAS);
        // solo se reclama el cupo de quien se le va a escribir (Lejana no gasta aviso)
        expect(a.reclamosPedidos[0].map((f) => f.subject_id).sort()).toEqual(['h1', 'h2']);
    });

    it('respeta el tope de la base: lo que no se reclama no se manda', async () => {
        const a = armarRec({
            filas: [sinCuenta('h1', 'Sara', SIETE)], tels: { 'child:h1': '3001112233' }, ventanas: { '573001112233': 'conv-A' }, reclamados: [],
        });
        const r = await enviarRecordatoriosDeSoportes(a.deps);
        expect(r.enviados).toBe(0);
        expect(a.enviados).toHaveLength(0);
    });

    it('no escribe a quien se dio de baja ni a fichas sin celular válido; dryRun no reclama ni envía', async () => {
        const a = armarRec({
            filas: [sinCuenta('h1', 'Sara', SIETE), sinCuenta('u1', 'Sin Tel', SIETE, 'unregistered')],
            tels: { 'child:h1': '3001112233', 'unregistered:u1': '12345' },
            ventanas: { '573001112233': 'conv-A' }, baja: ['573001112233'],
        });
        const r = await enviarRecordatoriosDeSoportes(a.deps);
        expect(r).toMatchObject({ dadosDeBaja: 1, sinTelefono: 1, enviados: 0 });
        const b = armarRec({ filas: [sinCuenta('h1', 'Sara', SIETE)], tels: { 'child:h1': '3001112233' }, ventanas: { '573001112233': 'conv-A' } });
        const d = await enviarRecordatoriosDeSoportes(b.deps, { dryRun: true });
        expect(d.reclamados).toBe(1);
        expect(b.deps.reclamar).not.toHaveBeenCalled();
        expect(b.enviados).toHaveLength(0);
    });

    it('waIdDeCelular normaliza celulares colombianos', () => {
        expect(waIdDeCelular('300 111 2233')).toBe('573001112233');
        expect(waIdDeCelular('+57 300 111 2233')).toBe('573001112233');
        expect(waIdDeCelular('6012345678')).toBeNull();
    });
});
