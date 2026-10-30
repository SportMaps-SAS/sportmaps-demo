/**
 * Número de pruebas ampliado (B7, spec whatsapp-monster-requerimientos §4):
 * comprobantes, plantillas y /avanzar. El cliente de Supabase va ENVUELTO por
 * el cortafuegos, como en producción: lo que se prueba es que la simulación
 * lee de verdad y que ninguna escritura de la escuela (payments, cola, storage,
 * llm_usage…) llega al cliente real. Solo pasan las dos tablas del propio modo
 * pruebas: la sesión (platform_wa_sesiones_prueba) y la bitácora del canal
 * (platform_wa_mensajes).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const h = vi.hoisted(() => {
    const reales: string[] = [];
    const estado = {
        sesion: null as any,
        /** Nequi registrado de la escuela (null = sin cuentas). */
        nequi: '3194505150' as string | null,
        pendientes: [] as any[],
        franjas: [] as any[],
        upserts: [] as any[],
    };
    function respuesta(tabla: string, cols: string, una: boolean): any {
        const lista = (x: any[]) => (una ? (x[0] ?? null) : x);
        switch (tabla) {
            case 'platform_wa_sesiones_prueba':
                return una ? estado.sesion : (estado.sesion ? [estado.sesion] : []);
            case 'schools':
                return lista([{ id: 'esc-monster', name: 'Monster´s Volley Club', slug: 'monsters-volley-club', is_demo: false }]);
            case 'school_settings':
                if (cols.includes('receipt_date_window_days')) {
                    return { receipt_date_window_days: 5, bank_account_number: null, breb_key: null, nequi_number: estado.nequi };
                }
                return una ? {} : [{}];
            case 'payments':
                return lista(cols.includes('child:children') ? estado.pendientes : []);
            case 'children':
                return lista(cols === 'id' ? [{ id: 'h1' }] : []);
            case 'school_trial_slots':
                return lista(estado.franjas);
            default:
                return lista([]);
        }
    }
    function builder(tabla: string) {
        let cols = '';
        let escritura: string | null = null;
        const b: any = {};
        for (const m of ['eq', 'neq', 'in', 'is', 'not', 'or', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'order', 'limit', 'range', 'match', 'contains']) {
            b[m] = () => b;
        }
        b.select = (c?: string) => { if (!escritura) cols = String(c ?? ''); return b; };
        for (const m of ['insert', 'update', 'upsert', 'delete']) {
            b[m] = (v: any) => {
                escritura = m;
                reales.push(`${m} ${tabla}`);
                if (tabla === 'platform_wa_sesiones_prueba' && m === 'upsert') estado.upserts.push(v);
                return b;
            };
        }
        const res = (una: boolean) => (escritura ? { data: null, error: null } : { data: respuesta(tabla, cols, una), error: null });
        b.maybeSingle = () => Promise.resolve(res(true));
        b.single = () => Promise.resolve(res(true));
        b.then = (ok: any, ko: any) => Promise.resolve(res(false)).then(ok, ko);
        return b;
    }
    const real = {
        from: (t: string) => builder(t),
        rpc: (fn: string) => { reales.push(`rpc ${fn}`); return Promise.resolve({ data: null, error: null }); },
        storage: { from: () => ({ upload: () => { reales.push('storage.upload'); return Promise.resolve({ error: null }); } }) },
    };
    const enviados: { to: string; texto: string; botones?: any[] }[] = [];
    return { reales, estado, real, enviados };
});

vi.mock('../config/supabase', async () => {
    const { envolverCliente } = await import('../config/cortafuegos-simulacion');
    return { supabase: envolverCliente(h.real) };
});
vi.mock('./whatsapp.service', async (orig) => ({
    ...(await orig<typeof import('./whatsapp.service')>()),
    downloadMedia: vi.fn(async (_i: any, _id: string) => ({ ok: true, base64: Buffer.from('comprobante').toString('base64'), mimeType: 'image/jpeg' })),
    sendTextMessage: vi.fn(async (_i: any, to: string, texto: string) => { h.enviados.push({ to, texto }); return { ok: true, waMessageId: `wamid.out${h.enviados.length}` }; }),
    sendInteractiveButtons: vi.fn(async (_i: any, to: string, texto: string, botones: any[]) => { h.enviados.push({ to, texto, botones }); return { ok: true, waMessageId: `wamid.out${h.enviados.length}` }; }),
    sendCtaUrl: vi.fn(async (_i: any, to: string, texto: string) => { h.enviados.push({ to, texto }); return { ok: true, waMessageId: `wamid.out${h.enviados.length}` }; }),
}));
vi.mock('./ocr.service', () => ({ extractReceipt: vi.fn() }));
vi.mock('./whatsapp-bot.service', () => ({
    simularEnvios: async (fn: () => Promise<unknown>) => ({ resultado: await fn(), salidas: [] }),
    runBotTurn: vi.fn(async () => undefined),
    atenderDesconocido: vi.fn(async () => 'ok'),
    nombreDeEscuela: vi.fn(async () => 'Monster´s Volley Club'),
    enlaceDeInscripcion: vi.fn(async () => 'https://app.sportmaps.co/join/monster'),
}));
vi.mock('./whatsapp-prospecto-ia.service', async (orig) => ({
    ...(await orig<typeof import('./whatsapp-prospecto-ia.service')>()),
    redactarRespuestaDeProspecto: vi.fn(async () => 'texto del modelo'),
}));
vi.mock('./whatsapp-info-escuela.service', async (orig) => ({
    ...(await orig<typeof import('./whatsapp-info-escuela.service')>()),
    infoDeEscuela: vi.fn(async () => ({ grupos: [] })),
    fallbackInfoEscuela: vi.fn(() => 'grupos de la escuela'),
}));
vi.mock('./whatsapp-precios.service', async (orig) => ({
    ...(await orig<typeof import('./whatsapp-precios.service')>()),
    preciosParaProspecto: vi.fn(async () => 'precios de la escuela'),
}));

import { atenderPrueba, parsearComandoPrueba, TEXTO_AYUDA_PRUEBAS, type SesionPrueba } from './plataforma-wa-pruebas.service';
import {
    caminoSinFicha, conceptoDePlantilla, textoListaPlantillas, plantillaSimulada, trabajoDeAvanzar, avanzarSimulado,
    esAdjuntoDeComprobante, type EscenarioPrueba, type DepsSimulacion,
} from './plataforma-wa-pruebas-simular.service';
import { redactarSeguimiento20h } from './whatsapp-prospecto-seguimiento.service';
import { redactarRespuestaDeProspecto } from './whatsapp-prospecto-ia.service';
import { downloadMedia } from './whatsapp.service';
import { extractReceipt } from './ocr.service';
import { CONCEPTOS } from './whatsapp-plantillas.service';
import { FLUJO_CORTESIA } from './whatsapp-clase-cortesia.service';

const CANAL = { phone_number_id: '999', waba_id: '888', display_phone_number: '573202683539', access_token_encrypted: 'gcm:x', status: 'activo' };
const TESTER = '573128463555';
const AHORA = Date.parse('2026-10-29T15:00:00.000Z'); // jueves 10:00 a. m. en Bogotá
const PERMITIDAS = new Set(['insert platform_wa_mensajes', 'upsert platform_wa_sesiones_prueba']);

const OCR = {
    amount: 310000, currency: 'COP', date: '2026-10-28', time: '14:32', bank: 'Nequi', reference: 'M1234567',
    destination: '3194505150', destinationName: 'Monster Volley', originName: 'Juan Pérez', description: null,
    isReceipt: true, isTransactionList: false, missingFields: [], provider: 'gemini',
};

function sesion(o: Partial<SesionPrueba> = {}): SesionPrueba {
    return { contact_wa_id: TESTER, school_id: 'esc-monster', rol: 'papa', child_id: 'h1', parent_id: 'padre-1', estado: {}, ...o };
}
function adjunto(o: Record<string, unknown> = {}) {
    return {
        phoneNumberId: '999', contactWaId: TESTER, contactName: null, waMessageId: 'wamid.img1', type: 'image', textBody: null,
        waTimestamp: new Date(AHORA).toISOString(), mediaId: 'media-1', mediaMimeType: 'image/jpeg', mediaCaption: null, raw: {}, ...o,
    } as any;
}
function texto(t: string) {
    return { ...adjunto({ type: 'text', textBody: t, mediaId: null, mediaMimeType: null, waMessageId: `wamid.t${Math.random()}` }) } as any;
}
const entrante = (iso: string, t: string) => ({
    id: `m-${iso}`, conversation_id: 'conv-sim', direction: 'inbound', type: 'text', text_body: t, payload: {},
    ai_generated: false, wa_timestamp: iso, created_at: iso,
});
const escritasDeLaEscuela = () => h.reales.filter((r) => !PERMITIDAS.has(r));

// La simulación importa en diferido la cola de comprobantes y lo que arrastra
// (miles de líneas): la primera vez tarda más que el timeout de una prueba.
beforeAll(async () => {
    await import('../jobs/whatsapp-queue.job');
    await import('./whatsapp-recuperacion.service');
    await import('./recordatorio-cortesia.service');
    await import('./prospecto-ciclo-clase.service');
}, 60_000);

beforeEach(() => {
    h.reales.length = 0;
    h.enviados.length = 0;
    h.estado.sesion = null;
    h.estado.nequi = '3194505150';
    h.estado.pendientes = [];
    h.estado.franjas = [];
    h.estado.upserts = [];
    vi.mocked(extractReceipt).mockReset();
    vi.mocked(extractReceipt).mockResolvedValue({ ...OCR } as any);
    vi.mocked(downloadMedia).mockClear();
    vi.mocked(redactarRespuestaDeProspecto).mockClear();
});

// ─── Comandos ────────────────────────────────────────────────────────────────

describe('comandos nuevos', () => {
    it('parsea /plantillas, /plantilla y /avanzar', () => {
        expect(parsearComandoPrueba('/plantillas')).toEqual({ cmd: 'plantillas' });
        expect(parsearComandoPrueba('/plantilla')).toEqual({ cmd: 'plantillas' });
        expect(parsearComandoPrueba('/plantilla vence hoy')).toEqual({ cmd: 'plantilla', arg: 'vence hoy' });
        expect(parsearComandoPrueba('/avanzar recordatorio')).toEqual({ cmd: 'avanzar', arg: 'recordatorio' });
        expect(parsearComandoPrueba('/Avanzar')).toEqual({ cmd: 'avanzar', arg: '' });
    });
    it('/avanzar entiende los alias de cada job', () => {
        expect(trabajoDeAvanzar('recordatorio')).toBe('recordatorio');
        expect(trabajoDeAvanzar('víspera')).toBe('recordatorio');
        expect(trabajoDeAvanzar('mismo-dia')).toBe('mismo_dia');
        expect(trabajoDeAvanzar('recordatorio hoy')).toBe('mismo_dia');
        expect(trabajoDeAvanzar('seguimiento')).toBe('seguimiento');
        expect(trabajoDeAvanzar('1d')).toBe('seguimiento');
        expect(trabajoDeAvanzar('post-clase')).toBe('post_clase');
        expect(trabajoDeAvanzar('3d')).toBe('secuencia');
        expect(trabajoDeAvanzar('7D')).toBe('secuencia');
        expect(trabajoDeAvanzar('')).toBeNull();
        expect(trabajoDeAvanzar('cobranza')).toBeNull();
    });
    it('la ayuda nombra los comandos nuevos', () => {
        expect(TEXTO_AYUDA_PRUEBAS).toMatch(/\/plantillas/);
        expect(TEXTO_AYUDA_PRUEBAS).toMatch(/\/plantilla </);
        expect(TEXTO_AYUDA_PRUEBAS).toMatch(/\/avanzar/);
        expect(TEXTO_AYUDA_PRUEBAS).toMatch(/Foto o PDF/);
    });
    it('solo foto o documento con media van al comprobante', () => {
        expect(esAdjuntoDeComprobante({ type: 'image', mediaId: 'm' })).toBe(true);
        expect(esAdjuntoDeComprobante({ type: 'document', mediaId: 'm' })).toBe(true);
        expect(esAdjuntoDeComprobante({ type: 'audio', mediaId: 'm' })).toBe(false);
        expect(esAdjuntoDeComprobante({ type: 'image', mediaId: null })).toBe(false);
    });
});

// ─── Comprobantes ────────────────────────────────────────────────────────────

describe('comprobante en la prueba', () => {
    it('acudiente: lee, cruza el destino y dice con qué cobro lo emparejaría, sin escribir en la escuela', async () => {
        h.estado.sesion = sesion();
        h.estado.pendientes = [{
            id: 'pay-matricula', amount: 310000, concept: 'Matrícula 2026', due_date: '2026-11-05', child_id: 'h1',
            unregistered_athlete_id: null, payment_category: 'inscripcion', payment_type: null, child: { full_name: 'Sofía Prueba' },
        }];

        await atenderPrueba(CANAL as any, adjunto({ mediaCaption: 'matrícula de Sofía' }), AHORA);

        // Se baja con el token del canal de SportMaps, no de la escuela.
        const [integ, mediaId] = vi.mocked(downloadMedia).mock.calls[0];
        expect(integ).toMatchObject({ id: 'plataforma', access_token_encrypted: 'gcm:x' });
        expect(mediaId).toBe('media-1');
        expect(extractReceipt).toHaveBeenCalledTimes(1);
        expect(vi.mocked(extractReceipt).mock.calls[0][1]).toBe('image/jpeg');

        expect(h.enviados).toHaveLength(1);
        const b = h.enviados[0].texto;
        expect(b).toMatch(/^🧪 \*Comprobante — simulación\*/);
        expect(b).toContain('Monto: $310.000');
        expect(b).toContain('Fecha: 2026-10-28 · 14:32');
        expect(b).toContain('Referencia: M1234567');
        expect(b).toContain('Banco / billetera: Nequi');
        expect(b).toContain('✅ es una cuenta de la escuela');
        expect(b).toContain('Cobro: Matrícula 2026 de Sofía Prueba por $310.000');
        expect(b).toMatch(/en revisión/);
        expect(b).toMatch(/Veredicto: /);

        // Nada de la escuela: ni payments, ni cola, ni storage, ni llm_usage.
        expect(escritasDeLaEscuela()).toEqual([]);
        // Lo bloqueado queda en la sesión para /estado.
        expect(Array.isArray(h.estado.upserts.at(-1)?.estado?.bloqueadas)).toBe(true);
    });

    it('PDF: se lee con su mime', async () => {
        h.estado.sesion = sesion();
        vi.mocked(downloadMedia).mockResolvedValueOnce({ ok: true, base64: Buffer.from('%PDF').toString('base64'), mimeType: 'application/pdf' } as any);
        await atenderPrueba(CANAL as any, adjunto({ type: 'document', mediaMimeType: 'application/pdf' }), AHORA);
        expect(vi.mocked(extractReceipt).mock.calls[0][1]).toBe('application/pdf');
        expect(h.enviados[0].texto).toContain('Comprobante — simulación');
        expect(escritasDeLaEscuela()).toEqual([]);
    });

    it('prospecto sin hablar de pago y escuela sin cuentas: el bot no le contestaría, y lo dice', async () => {
        h.estado.sesion = sesion({ rol: 'prospecto', child_id: null, parent_id: null });
        h.estado.nequi = null;
        await atenderPrueba(CANAL as any, adjunto(), AHORA);
        const b = h.enviados[0].texto;
        expect(b).toContain('la escuela no tiene cuentas registradas');
        expect(b).toMatch(/→ No le contesta: el destino no cruza/);
        expect(b).toMatch(/B4/);
        expect(escritasDeLaEscuela()).toEqual([]);
    });

    it('prospecto que anuncia el pago y paga a la cuenta de la escuela: le pregunta de qué deportista es', async () => {
        h.estado.sesion = sesion({ rol: 'prospecto', child_id: null, parent_id: null });
        await atenderPrueba(CANAL as any, adjunto({ mediaCaption: 'te envío el comprobante de la clase de prueba' }), AHORA);
        const b = h.enviados[0].texto;
        expect(b).toContain('✅ es una cuenta de la escuela');
        expect(b).toMatch(/Le pregunta de qué deportista es: «Recibí tu comprobante 📄 ¿De qué deportista es este pago\?/);
        expect(escritasDeLaEscuela()).toEqual([]);
    });

    it('OCR caído: lo dice y no decide', async () => {
        h.estado.sesion = sesion();
        vi.mocked(extractReceipt).mockRejectedValueOnce(new Error('gemini: 503'));
        await atenderPrueba(CANAL as any, adjunto(), AHORA);
        expect(h.enviados[0].texto).toMatch(/El OCR no respondió: gemini: 503/);
        expect(escritasDeLaEscuela()).toEqual([]);
    });

    it('camino del worker con un número sin ficha', () => {
        expect(caminoSinFicha({ parece: false, destino: 'general', hablaDePago: true })).toBe('no_es_pago');
        expect(caminoSinFicha({ parece: true, destino: 'fuera_de_sportmaps', hablaDePago: true })).toBe('bandeja_fuera');
        expect(caminoSinFicha({ parece: true, destino: 'ajena', hablaDePago: true })).toBe('bandeja_ajena');
        expect(caminoSinFicha({ parece: true, destino: null, hablaDePago: false })).toBe('silencio');
        expect(caminoSinFicha({ parece: true, destino: null, hablaDePago: true })).toBe('sigue');
        expect(caminoSinFicha({ parece: true, destino: 'general', hablaDePago: false })).toBe('sigue');
    });
});

describe('lo que no es texto, como hoy', () => {
    it('tester SIN sesión de prueba que manda una foto: la ayuda, sin bajar nada', async () => {
        h.estado.sesion = null;
        await atenderPrueba(CANAL as any, adjunto(), AHORA);
        expect(downloadMedia).not.toHaveBeenCalled();
        expect(extractReceipt).not.toHaveBeenCalled();
        expect(h.enviados[0].texto).toMatch(/Primero elige una escuela/);
    });
    it('audio con sesión: no se procesa', async () => {
        h.estado.sesion = sesion();
        await atenderPrueba(CANAL as any, adjunto({ type: 'audio', mediaMimeType: 'audio/ogg' }), AHORA);
        expect(downloadMedia).not.toHaveBeenCalled();
        expect(h.enviados[0].texto).toMatch(/audios, videos y stickers no se procesan/);
    });
});

// ─── Plantillas ──────────────────────────────────────────────────────────────

const ESC = (o: Partial<SesionPrueba> = {}): EscenarioPrueba => ({
    sesion: sesion(o),
    integ: { id: 'sim-integ', school_id: 'esc-monster', phone_number_id: 'simulado', waba_id: null, display_phone_number: null, access_token_encrypted: null, verify_token: null, status: 'active' } as any,
    conversationId: 'conv-sim',
    ahora: AHORA,
});
const DEPS_ESCUELA: Partial<DepsSimulacion> = {
    escuela: async () => ({ nombre: 'Monster´s Volley Club', sedes: [{ name: 'Pinar', address: 'Cra 91 #145-20', is_main: true }], indicaciones: null }),
    personas: async (s) => (s.rol === 'papa'
        ? { full_name: 'SOFÍA PRUEBA', guardian_name: 'Marta Gómez' }
        : { full_name: 'Prueba SportMaps', guardian_name: null }),
    cobroPendiente: async (s) => (s.rol === 'papa'
        ? { amount: 150000, concept: 'Mensualidad 10/2026', due_date: '2026-10-29', atleta: 'Sofía Prueba' } : null),
    enlace: async () => 'https://app.sportmaps.co/join/monster',
};

describe('/plantillas y /plantilla', () => {
    it('lista todo el catálogo con su categoría', () => {
        const t = textoListaPlantillas();
        for (const def of Object.values(CONCEPTOS)) expect(t).toContain(def.plantilla);
        expect(t).toMatch(/UTILITY/);
        expect(t).not.toMatch(/¿\?/); // todas tienen su JSON en el repo
    });
    it('encuentra la plantilla por concepto, por nombre o por un pedazo único', () => {
        expect(conceptoDePlantilla('vence hoy')).toBe('vence_hoy');
        expect(conceptoDePlantilla('pago_vence_hoy_v4')).toBe('vence_hoy');
        expect(conceptoDePlantilla('cortesia')).toBe('recordatorio_clase_cortesia');
        expect(conceptoDePlantilla('recordatorio')).toBeNull(); // ambiguo: previo y clase de cortesía
        expect(conceptoDePlantilla('nada')).toBeNull();
    });
    it('acudiente: variables con los datos de la escuela y de su cobro, botón y categoría', async () => {
        const r = await plantillaSimulada(ESC(), 'vence_hoy', DEPS_ESCUELA);
        expect(r.texto).toContain('`pago_vence_hoy_v4` · UTILITY · es_CO');
        expect(r.texto).toContain('Hola Marta, este es el estado de tu cuenta en Monster´s Volley Club: la mensualidad de Sofía correspondiente a octubre 2026 vence hoy. Valor del cobro: $150.000.');
        expect(r.texto).toContain('[ Ver detalle del cobro ] → https://sportmaps.co/p/‹token del cobro›');
        expect(r.texto).not.toContain('(ejemplo)');
        expect(r.texto).toMatch(/no tiene número conectado/);
        expect(r.texto).toMatch(/Es de cobro/);
        expect(escritasDeLaEscuela()).toEqual([]);
    });
    it('prospecto: lo que no se sabe va como ejemplo, marcado', async () => {
        const r = await plantillaSimulada(ESC({ rol: 'prospecto', child_id: null, parent_id: null }), 'pago_confirmado', DEPS_ESCUELA);
        expect(r.texto).toContain('{{1}} $150.000 (ejemplo)');
        expect(r.texto).toContain('{{3}} Monster´s Volley Club');
        expect(r.texto).not.toMatch(/Es de cobro/);
    });
    it('recordatorio de la clase de cortesía con la franja de la escuela', async () => {
        const r = await plantillaSimulada(ESC({ rol: 'prospecto', child_id: null, parent_id: null }), 'recordatorio_clase_cortesia', {
            ...DEPS_ESCUELA,
            franjas: async () => [{ id: 'f1', grupo: 'Sub-15 Fem', fecha: '2026-10-31', horaInicio: '09:00', horaFin: '11:00', sede: 'Pinar', cupos: 999 }],
        });
        expect(r.texto).toContain('reservaste en Monster´s Volley Club: sábado 31 de octubre a las 9:00 a. m., en Pinar (Cra 91 #145-20).');
    });
    it('nombre desconocido: lo dice y lista el catálogo', async () => {
        const r = await plantillaSimulada(ESC(), 'recordatorio', DEPS_ESCUELA);
        expect(r.texto).toMatch(/No reconozco la plantilla «recordatorio»/);
        expect(r.texto).toContain('pago_recordatorio_previo_v3');
    });
});

// ─── /avanzar ────────────────────────────────────────────────────────────────

const FRANJA = (fecha: string, inicio = '16:00', fin = '18:00') => [{ id: 'f1', grupo: 'Sub-15 Fem', fecha, horaInicio: inicio, horaFin: fin, sede: 'Pinar', cupos: 999 }];

describe('/avanzar', () => {
    it('recordatorio con la ventana abierta: el texto del job, con «Cancelar mi clase», y queda como último saliente', async () => {
        const esc = ESC({ rol: 'prospecto', child_id: null, parent_id: null, estado: { tablas: { whatsapp_messages: [entrante('2026-10-29T14:00:00.000Z', 'hola')] } } });
        const r = await avanzarSimulado(esc, 'recordatorio', { ...DEPS_ESCUELA, franjas: async () => FRANJA('2026-10-30') });
        expect(r.texto).toMatch(/correría el jueves 29 de octubre, 6:00 p\. m\./);
        expect(r.texto).toMatch(/Saldría como TEXTO/);
        expect(r.salida?.texto).toContain('Te recuerdo tu clase de cortesía mañana en *Monster´s Volley Club*');
        expect(r.salida?.texto).toContain('📍 Pinar (Cra 91 #145-20)');
        expect(r.salida?.opciones?.[0].title).toBe('Cancelar mi clase');
        expect(r.enMemoria?.payload).toMatchObject({ flujo: FLUJO_CORTESIA, paso_cortesia: 'recordatorio', automatico: true });
        expect(escritasDeLaEscuela()).toEqual([]);
    });
    it('recordatorio con la ventana cerrada: la plantilla y que no le llegaría a un interesado', async () => {
        const esc = ESC({ rol: 'prospecto', child_id: null, parent_id: null, estado: { tablas: { whatsapp_messages: [entrante('2026-10-29T14:00:00.000Z', 'hola')] } } });
        const r = await avanzarSimulado(esc, 'recordatorio', { ...DEPS_ESCUELA, franjas: async () => FRANJA('2026-10-31', '09:00', '11:00') });
        expect(r.texto).toMatch(/iría la PLANTILLA `recordatorio_clase_cortesia`/);
        expect(r.texto).toMatch(/NO le llegaría/);
        expect(r.salida?.texto).toContain('te recordamos la clase de cortesía que reservaste en Monster´s Volley Club: sábado 31 de octubre a las 9:00 a. m., en Pinar (Cra 91 #145-20)');
        expect(r.enMemoria).toBeNull();
    });
    it('recordatorio sin franjas: lo dice en vez de inventar', async () => {
        const r = await avanzarSimulado(ESC({ rol: 'prospecto' }), 'recordatorio', { ...DEPS_ESCUELA, franjas: async () => [] });
        expect(r.texto).toMatch(/no tiene franjas abiertas/);
        expect(r.salida).toBeNull();
    });
    it('seguimiento de ~20 h: primer momento en horario, texto del modelo con la conversación de la sesión', async () => {
        const fila = entrante('2026-10-29T15:00:00.000Z', '¿cuánto vale la mensualidad?');
        const esc = ESC({ rol: 'prospecto', child_id: null, parent_id: null, estado: { tablas: { whatsapp_messages: [fila] } } });
        const redactar = vi.fn(async () => 'Hola 👋 ¿Pudiste revisar los horarios?');
        const r = await avanzarSimulado(esc, 'seguimiento', { ...DEPS_ESCUELA, redactarSeguimiento: redactar });
        // +18 h cae de madrugada: el primero en horario es a las 8:00 a. m. (+22 h).
        expect(r.texto).toMatch(/correría el viernes 30 de octubre, 8:00 a\. m\. \(~22 h/);
        expect(r.salida?.texto).toBe('Hola 👋 ¿Pudiste revisar los horarios?');
        const [integ, conv, recientes] = redactar.mock.calls[0] as any[];
        expect(integ.id).toBe('sim-integ');
        expect(conv).toBe('conv-sim');
        expect(recientes.map((m: any) => m.text_body)).toEqual(['¿cuánto vale la mensualidad?']);
        expect(r.enMemoria?.payload).toMatchObject({ step: 'prospecto_seguimiento_20h' });
    });
    it('seguimiento sin ficha de prospectos: no saldría, y por qué', async () => {
        const esc = ESC({ rol: 'prospecto', child_id: null, parent_id: null, estado: { tablas: { whatsapp_messages: [entrante('2026-10-29T15:00:00.000Z', 'info')] } } });
        const r = await avanzarSimulado(esc, 'seguimiento', { ...DEPS_ESCUELA, redactarSeguimiento: async () => null, ficha: async () => null });
        expect(r.texto).toMatch(/NO saldría: la escuela no tiene ficha de prospectos/);
        expect(r.salida).toBeNull();
    });
    it('seguimiento como acudiente: no aplica', async () => {
        const r = await avanzarSimulado(ESC(), 'seguimiento', DEPS_ESCUELA);
        expect(r.texto).toMatch(/solo para interesados/);
    });
    it('post-clase: «¿Cómo te fue?» con el enlace de inscripción, a las 8:00 p. m. del día de la clase', async () => {
        const esc = ESC({ rol: 'prospecto', child_id: null, parent_id: null, estado: { tablas: { whatsapp_messages: [entrante('2026-10-29T15:00:00.000Z', 'listo, ahí estaremos')] } } });
        const r = await avanzarSimulado(esc, 'post_clase', { ...DEPS_ESCUELA, franjas: async () => FRANJA('2026-10-29') });
        expect(r.texto).toMatch(/correría el jueves 29 de octubre, 8:00 p\. m\./);
        expect(r.texto).toMatch(/Saldría como texto/);
        expect(r.salida?.texto).toContain('¿Cómo te fue en la clase de cortesía de hoy?');
        expect(r.salida?.texto).toContain('https://app.sportmaps.co/join/monster');
    });
    it('3d / 7d: todavía no existen (B5)', async () => {
        const r = await avanzarSimulado(ESC({ rol: 'prospecto' }), 'secuencia', DEPS_ESCUELA);
        expect(r.texto).toMatch(/B5/);
        expect(r.salida).toBeNull();
    });
    it('por el comando: manda la explicación y el mensaje, y guarda el saliente en la sesión', async () => {
        h.estado.sesion = sesion({ rol: 'prospecto', child_id: null, parent_id: null, estado: { tablas: { whatsapp_messages: [entrante('2026-10-29T14:00:00.000Z', 'hola')] } } });
        h.estado.franjas = [{ id: 'slot-1', label: 'Sub-15 Fem', slot_date: '2026-10-30', start_time: '16:00', end_time: '18:00', location: 'Pinar', max_capacity: 999, reserved_count: 0, team_id: null }];
        await atenderPrueba(CANAL as any, texto('/avanzar recordatorio'), AHORA);
        expect(h.enviados[0].texto).toMatch(/\/avanzar recordatorio/);
        expect(h.enviados[1].texto).toMatch(/^🧪 Hola Prueba 👋 Te recuerdo tu clase de cortesía mañana/);
        expect(h.enviados[1].botones?.[0].title).toBe('Cancelar mi clase');
        const guardada = h.estado.upserts.at(-1);
        expect(guardada.estado.tablas.whatsapp_messages.at(-1).payload.paso_cortesia).toBe('recordatorio');
        expect(escritasDeLaEscuela()).toEqual([]);
    });
    it('sin escuela elegida, /avanzar y /plantilla piden elegirla', async () => {
        await atenderPrueba(CANAL as any, texto('/avanzar recordatorio'), AHORA);
        expect(h.enviados[0].texto).toMatch(/Primero elige una escuela/);
    });
});

// ─── Extracción sin cambio de comportamiento ────────────────────────────────

describe('redactarSeguimiento20h (sacada de DEPS.redactar)', () => {
    it('llama al modelo con la ficha de la escuela en modo seguimiento, igual que antes', async () => {
        const fila = entrante('2026-10-29T15:00:00.000Z', 'hola');
        const t = await redactarSeguimiento20h({ school_id: 'esc-monster' } as any, 'conv-1', [fila] as any);
        expect(t).toBe('texto del modelo');
        expect(redactarRespuestaDeProspecto).toHaveBeenCalledWith({
            schoolId: 'esc-monster', conversationId: 'conv-1', escuela: 'Monster´s Volley Club', nuevo: '',
            recientes: [fila], seguimiento: true, grupos: 'grupos de la escuela', precios: 'precios de la escuela',
            enlace: 'https://app.sportmaps.co/join/monster',
        });
    });
});
