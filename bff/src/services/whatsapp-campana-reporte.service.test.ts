/**
 * whatsapp-campana-reporte.service — el reporte de campaña de la escuela (F0.5):
 * conteos, lo que falta por salir con su fecha, no enviados y fallidos por
 * motivo, el freno, «pagaron» tolerando que la RPC no exista, y el aviso único
 * al equipo de SportMaps. Base y correo moqueados: no sale nada.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    t: {} as Record<string, any[]>,
    /** Consultas cuyo `select` nombra esta columna fallan con 42703 (columna que aún no existe). */
    columnasQueFaltan: new Set<string>(),
    rpc: {} as Record<string, (args: any) => { data: any; error: any }>,
    llamadas: [] as { tabla: string; cols: string }[],
    rpcLlamadas: [] as { fn: string; args: any }[],
}));
const correo = vi.hoisted(() => ({
    enviados: [] as any[],
    reservadas: new Set<string>(),
}));

vi.mock('../config/supabase', () => {
    const campo = (r: any, c: string) => {
        if (!c.includes('->>')) return r[c];
        const [col, clave] = c.split('->>');
        return (r[col] ?? {})[clave];
    };
    function builder(tabla: string) {
        const filtros: ((r: any) => boolean)[] = [];
        let cols = '';
        let single = false;
        let head = false;
        let lim = Infinity;
        let rango: [number, number] | null = null;
        const resolver = () => {
            db.llamadas.push({ tabla, cols });
            for (const c of db.columnasQueFaltan) {
                if (cols.includes(c)) return { data: null, count: null, error: { code: '42703', message: `column ${c} does not exist` } };
            }
            const sel = (db.t[tabla] ?? []).filter((r) => filtros.every((f) => f(r)));
            if (head) return { data: null, count: sel.length, error: null };
            const pagina = rango ? sel.slice(rango[0], rango[1] + 1) : sel.slice(0, lim);
            return { data: single ? (pagina[0] ?? null) : pagina, error: null };
        };
        const api: any = {
            select: (c: string, o?: any) => { cols = c; if (o?.head) head = true; return api; },
            eq: (c: string, v: any) => { filtros.push((r) => campo(r, c) === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((r) => vs.includes(campo(r, c))); return api; },
            gte: (c: string, v: any) => { filtros.push((r) => r[c] != null && r[c] >= v); return api; },
            order: () => api,
            limit: (n: number) => { lim = n; return api; },
            range: (a: number, b: number) => { rango = [a, b]; return api; },
            maybeSingle: () => { single = true; return api; },
            then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: any) => {
                db.rpcLlamadas.push({ fn, args });
                return Promise.resolve(db.rpc[fn]?.(args) ?? { data: null, error: { code: 'PGRST202', message: `function ${fn} not found` } });
            },
        },
    };
});
vi.mock('./avisos-correo.service', () => ({
    correosDeSoporte: () => ['soporte@sportmaps.co'],
    // Igual que la real: la primera reserva de una clave envía; las demás son 'duplicado'.
    enviarConReserva: vi.fn(async (p: any) => {
        if (correo.reservadas.has(p.clave)) return 'duplicado';
        correo.reservadas.add(p.clave);
        correo.enviados.push(p);
        return 'enviado';
    }),
}));
vi.mock('./plataforma-wa.service', () => ({ nombreDeEscuela: vi.fn(async () => 'Monster´s Volley Club') }));
vi.mock('./whatsapp-campanas-cupo', () => ({ estadoDelNumero: vi.fn(), recordarTier: vi.fn() }));

import {
    agruparFallidos, agruparNoEnviados, agruparPorSalir, armarReporte, avisarSoporteDeCampanas, claveDeAviso,
    contarPagaron, fallosQueFaltanParaElFreno, fechaEnPalabras, gruposParaSoporte, gruposSinAvisar,
    leerReporteDeCampana, proximaVentanaDeEnvio, resumenDelFreno, seLeEnvio, _olvidarAvisos,
    type CampanaDelReporte, type EnvioDelReporte,
} from './whatsapp-campana-reporte.service';

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CAMP = '11111111-1111-4111-8111-111111111111';
const SERV = '22222222-2222-4222-8222-222222222222';

/** 2026-11-17 es martes; 10:00 COT = 15:00Z. El 15 es domingo y el 16 lunes festivo. */
const MARTES_10AM = new Date('2026-11-17T15:00:00Z');
const DOMINGO = new Date('2026-11-15T15:00:00Z');

const campana = (x: Partial<CampanaDelReporte> = {}): CampanaDelReporte => ({
    id: CAMP, integration_id: 'integ-1', school_id: ESC, nombre: 'Clínica de diciembre', plantilla: 'monster_clinica',
    estado: 'enviando', destinatarios: null, aprobada_at: '2026-11-17T12:00:00Z', vence_at: null, pausa_motivo: null,
    servicio_id: null, ...x,
});
let n = 0;
const envio = (estado: EnvioDelReporte['estado'], x: Partial<EnvioDelReporte> = {}): EnvioDelReporte => ({
    contact_wa_id: `57300${String(++n).padStart(7, '0')}`, estado, motivo: null, proximo_intento_at: null,
    enviado_at: ['enviado', 'respondio_si', 'respondio_luego'].includes(estado) ? '2026-11-17T13:00:00Z' : null, ...x,
});

beforeEach(() => {
    db.t = {};
    db.columnasQueFaltan = new Set();
    db.rpc = {};
    db.llamadas = [];
    db.rpcLlamadas = [];
    correo.enviados = [];
    correo.reservadas = new Set();
    _olvidarAvisos();
    vi.clearAllMocks();
});

describe('horario de envío', () => {
    it('dentro del horario: sale ya', () => {
        expect(proximaVentanaDeEnvio(MARTES_10AM)).toEqual(MARTES_10AM);
    });
    it('domingo y lunes festivo: la primera ventana es el martes 17 a las 7:00', () => {
        expect(proximaVentanaDeEnvio(DOMINGO).toISOString()).toBe('2026-11-17T12:00:00.000Z');
        expect(proximaVentanaDeEnvio(new Date('2026-11-16T15:00:00Z')).toISOString()).toBe('2026-11-17T12:00:00.000Z');
    });
    it('entre semana después de las 7 p. m.: el día siguiente a las 7:00; antes de las 7: el mismo día', () => {
        expect(proximaVentanaDeEnvio(new Date('2026-11-18T00:30:00Z')).toISOString()).toBe('2026-11-18T12:00:00.000Z'); // mar 19:30 COT
        expect(proximaVentanaDeEnvio(new Date('2026-11-18T10:00:00Z')).toISOString()).toBe('2026-11-18T12:00:00.000Z'); // mié 05:00 COT
    });
    it('viernes de noche → sábado 8:00; sábado después de las 3 p. m. → lunes 7:00', () => {
        expect(proximaVentanaDeEnvio(new Date('2026-11-21T01:00:00Z')).toISOString()).toBe('2026-11-21T13:00:00.000Z'); // vie 20:00 COT
        expect(proximaVentanaDeEnvio(new Date('2026-11-21T21:00:00Z')).toISOString()).toBe('2026-11-23T12:00:00.000Z'); // sáb 16:00 COT
    });
    it('la fecha en palabras, en hora de Colombia', () => {
        expect(fechaEnPalabras(new Date('2026-11-17T12:00:00Z'))).toBe('martes 17 de noviembre, 7:00 a. m.');
        expect(fechaEnPalabras(new Date('2026-11-21T20:05:00Z'))).toBe('sábado 21 de noviembre, 3:05 p. m.');
        expect(fechaEnPalabras(new Date('2026-11-18T17:00:00Z'))).toBe('miércoles 18 de noviembre, 12:00 p. m.');
    });
});

describe('conteos del resumen', () => {
    it('enviados = a quienes sí les salió; el fallido, el incierto y el omitido no cuentan', () => {
        expect(seLeEnvio(envio('enviado'))).toBe(true);
        expect(seLeEnvio(envio('respondio_si'))).toBe(true);
        expect(seLeEnvio(envio('baja', { enviado_at: '2026-11-17T13:00:00Z' }))).toBe(true);
        // Baja sin haber salido (Meta rechazó el envío con 131050): no se le envió.
        expect(seLeEnvio(envio('baja', { motivo: 'meta_131050' }))).toBe(false);
        expect(seLeEnvio(envio('fallido', { enviado_at: '2026-11-17T13:00:00Z' }))).toBe(false);
        expect(seLeEnvio(envio('incierto'))).toBe(false);
        expect(seLeEnvio(envio('pendiente', { enviado_at: '2026-11-17T13:00:00Z', motivo: 'meta_131049' }))).toBe(false);
    });

    it('arma el resumen completo', () => {
        const envios = [
            envio('enviado'), envio('enviado'), envio('respondio_si'), envio('respondio_luego'),
            envio('baja', { enviado_at: '2026-11-17T13:00:00Z' }),
            envio('pendiente'), envio('pendiente'),
            envio('omitido', { motivo: 'ya_compro' }),
            envio('fallido', { motivo: '(#131026) Message undeliverable' }),
            envio('incierto', { motivo: 'lease_vencido' }),
        ];
        const r = armarReporte({
            campana: campana({ destinatarios: 10 }), envios, entrega: { entregados: 4, leidos: 3 },
            compradores: null, senales: { enviados: 6, bajas: 1, fallidos: 1 }, ahora: MARTES_10AM,
        });
        expect(r.resumen).toEqual({
            destinatarios: 10, enviados: 5, entregados: 4, leidos: 3,
            respondieron: { si: 1, luego: 1, total: 2 }, bajas_promos: 1, pagaron: null,
        });
        expect(r.por_salir.total).toBe(2);
        expect(r.no_enviados.total).toBe(1);
        expect(r.fallidos.total).toBe(1);
        expect(r.inciertos).toMatchObject({ cantidad: 1, quien: 'sportmaps' });
        expect(r.lista_de_espera).toBeNull();
        expect(r.generado_at).toBe(MARTES_10AM.toISOString());
    });

    it('sin estado de entrega: entregados y leídos quedan null (sin dato), no cero', () => {
        const r = armarReporte({ campana: campana(), envios: [envio('enviado')], entrega: null, compradores: null, senales: null, ahora: MARTES_10AM });
        expect(r.resumen.entregados).toBeNull();
        expect(r.resumen.leidos).toBeNull();
        expect(r.freno).toBeNull();
        expect(r.resumen.destinatarios).toBe(1); // sin la foto, el total de filas
    });

    it('entregados nunca supera a enviados', () => {
        const r = armarReporte({ campana: campana(), envios: [envio('enviado')], entrega: { entregados: 3, leidos: 2 }, compradores: null, senales: null, ahora: MARTES_10AM });
        expect(r.resumen.entregados).toBe(1);
        expect(r.resumen.leidos).toBe(1);
    });
});

describe('pagaron o abonaron', () => {
    const a = envio('enviado', { contact_wa_id: 'a' });
    const b = envio('respondio_si', { contact_wa_id: 'b' });
    const c = envio('omitido', { contact_wa_id: 'c', motivo: 'ya_compro' });
    const d = envio('pendiente', { contact_wa_id: 'd' });
    const conServicio = campana({ servicio_id: SERV, vence_at: '2026-11-20T23:00:00Z' });

    it('cuenta solo a quienes se les envió y pagaron dentro de la vigencia', () => {
        const r = contarPagaron({
            campana: conServicio, envios: [a, b, c, d], ahora: new Date('2026-11-25T15:00:00Z'),
            compradores: [
                { contact_wa_id: 'a', primer_pago_at: '2026-11-18T15:00:00Z' }, // dentro
                { contact_wa_id: 'b', primer_pago_at: '2026-11-22T15:00:00Z' }, // después de vencer
                { contact_wa_id: 'c', primer_pago_at: '2026-11-10T15:00:00Z' }, // pagó antes: ni se le envió
                { contact_wa_id: 'd', primer_pago_at: '2026-11-18T15:00:00Z' }, // pagó sin que le llegara
                { contact_wa_id: 'z', primer_pago_at: '2026-11-18T15:00:00Z' }, // no es de la lista
            ],
        });
        expect(r).toEqual({ cantidad: 1, desde: '2026-11-17T12:00:00.000Z', hasta: '2026-11-20T23:00:00.000Z' });
    });
    it('sin fecha de cierre (o aún sin cerrar) la vigencia llega hasta ahora', () => {
        const r = contarPagaron({
            campana: campana({ servicio_id: SERV }), envios: [a, b], ahora: MARTES_10AM,
            compradores: [{ contact_wa_id: 'a', primer_pago_at: '2026-11-17T14:00:00Z' }, { contact_wa_id: 'b', primer_pago_at: '2026-11-17T16:00:00Z' }],
        });
        expect(r).toMatchObject({ cantidad: 1, hasta: MARTES_10AM.toISOString() });
    });
    it('null = sin dato: la campaña no vende un servicio, o la RPC no respondió', () => {
        expect(contarPagaron({ campana: campana(), envios: [a], compradores: [], ahora: MARTES_10AM })).toBeNull();
        expect(contarPagaron({ campana: conServicio, envios: [a], compradores: null, ahora: MARTES_10AM })).toBeNull();
    });
    it('un comprador sin fecha de pago no cuenta', () => {
        expect(contarPagaron({ campana: conServicio, envios: [a], compradores: [{ contact_wa_id: 'a', primer_pago_at: null }], ahora: MARTES_10AM }))
            .toMatchObject({ cantidad: 0 });
    });
});

describe('lo que falta por salir', () => {
    it('en fila y en horario: hoy; fuera de horario: la próxima ventana, saltando domingo y festivo', () => {
        const [hoy] = agruparPorSalir({ envios: [envio('pendiente'), envio('pendiente')], ahora: MARTES_10AM, venceAt: null });
        expect(hoy).toMatchObject({ motivo: 'en_fila', cantidad: 2, cuando: 'Hoy, de a poco y en horario de envío', despues_de_vencer: false });

        const [domingo] = agruparPorSalir({ envios: [envio('pendiente')], ahora: DOMINGO, venceAt: null });
        expect(domingo.sale_desde_at).toBe('2026-11-17T12:00:00.000Z');
        expect(domingo.cuando).toBe('En la próxima ventana de envío: martes 17 de noviembre, 7:00 a. m.');
    });

    it('pospuestos por la regla de días entre campañas: con la fecha en que salen, ajustada al horario', () => {
        const grupos = agruparPorSalir({
            envios: [
                envio('pendiente', { motivo: 'frecuencia', proximo_intento_at: '2026-11-22T15:00:00Z' }), // domingo → lunes 23, 7:00
                envio('pendiente', { motivo: 'frecuencia', proximo_intento_at: '2026-11-24T16:00:00Z' }), // martes 11:00
            ],
            ahora: MARTES_10AM, venceAt: null,
        });
        expect(grupos).toHaveLength(1);
        expect(grupos[0]).toMatchObject({
            motivo: 'frecuencia', cantidad: 2,
            sale_desde_at: '2026-11-23T12:00:00.000Z', sale_hasta_at: '2026-11-24T16:00:00.000Z',
            cuando: 'Entre el lunes 23 de noviembre, 7:00 a. m. y el martes 24 de noviembre, 11:00 a. m.',
        });
        expect(grupos[0].texto).toMatch(/otra campaña/);
    });

    it('conversación abierta, reintento de Meta y reintento por error, cada uno aparte', () => {
        const grupos = agruparPorSalir({
            envios: [
                envio('pendiente', { motivo: 'ventana_abierta', proximo_intento_at: '2026-11-18T15:00:00Z' }),
                envio('pendiente', { motivo: 'meta_131049', proximo_intento_at: '2026-11-18T15:00:00Z' }),
                envio('pendiente', { motivo: '(#131000) Something went wrong', proximo_intento_at: '2026-11-17T15:30:00Z' }),
                envio('enviando'),
            ],
            ahora: MARTES_10AM, venceAt: null,
        });
        expect(grupos.map((g) => g.motivo)).toEqual(['enviando', 'reintento', 'meta_131049', 'ventana_abierta']);
        expect(grupos[0]).toMatchObject({ sale_desde_at: null, cuando: 'Ahora' });
        expect(grupos[1].cuando).toBe('Desde el martes 17 de noviembre, 10:30 a. m.');
    });

    it('un pospuesto cuya fecha ya pasó vuelve a la fila', () => {
        const grupos = agruparPorSalir({
            envios: [envio('pendiente', { motivo: 'frecuencia', proximo_intento_at: '2026-11-17T14:00:00Z' })],
            ahora: MARTES_10AM, venceAt: null,
        });
        expect(grupos.map((g) => g.motivo)).toEqual(['en_fila']);
    });

    it('si la campaña cierra antes de la fecha, lo dice', () => {
        const r = armarReporte({
            campana: campana({ vence_at: '2026-11-20T23:00:00Z' }),
            envios: [envio('pendiente', { motivo: 'frecuencia', proximo_intento_at: '2026-11-24T16:00:00Z' })],
            entrega: null, compradores: null, senales: null, ahora: MARTES_10AM,
        });
        expect(r.por_salir.grupos[0].despues_de_vencer).toBe(true);
        expect(r.por_salir.nota).toMatch(/cierra antes/);
    });

    it('campaña en pausa: nada sale hasta reanudar', () => {
        const r = armarReporte({
            campana: campana({ estado: 'pausada' }), envios: [envio('pendiente')],
            entrega: null, compradores: null, senales: null, ahora: MARTES_10AM,
        });
        expect(r.por_salir.nota).toMatch(/en pausa/);
        expect(r.por_salir.en_horario_ahora).toBe(true);
    });
});

describe('no enviados y fallidos', () => {
    it('los omitidos, por motivo en lenguaje simple, de mayor a menor', () => {
        const grupos = agruparNoEnviados([
            envio('omitido', { motivo: 'ya_compro' }), envio('omitido', { motivo: 'baja' }), envio('omitido', { motivo: 'baja' }),
            envio('omitido', { motivo: 'campana_vencida' }), envio('omitido', { motivo: 'bloqueado' }),
            envio('omitido', { motivo: 'marca_manual' }), envio('omitido', { motivo: 'excluido' }),
            envio('omitido', { motivo: 'sin_optin' }), envio('omitido', { motivo: 'baja_promos' }),
            envio('omitido', { motivo: 'frecuencia' }), envio('enviado'),
        ]);
        expect(grupos[0]).toMatchObject({ motivo: 'baja', cantidad: 2, quien: 'escuela' });
        expect(grupos.map((g) => g.motivo).sort()).toEqual(
            ['baja', 'baja_promos', 'bloqueado', 'campana_vencida', 'excluido', 'frecuencia', 'marca_manual', 'sin_optin', 'ya_compro']);
        expect(grupos.every((g) => g.quien === 'escuela' && g.texto && g.que_hacer)).toBe(true);
        expect(grupos.find((g) => g.motivo === 'ya_compro')?.texto).toBe('Ya pagaron o abonaron lo que ofrece esta campaña');
    });
    it('un motivo que no se reconoce lo revisa SportMaps', () => {
        expect(agruparNoEnviados([envio('omitido', { motivo: 'algo_nuevo' }), envio('omitido')]))
            .toEqual([
                expect.objectContaining({ motivo: 'algo_nuevo', quien: 'sportmaps', cantidad: 1 }),
                expect.objectContaining({ motivo: 'sin_motivo', quien: 'sportmaps', cantidad: 1 }),
            ]);
    });
    it('los fallidos se agrupan por error de Meta: el formato nuevo y el viejo caen en el mismo grupo', () => {
        const grupos = agruparFallidos([
            envio('fallido', { motivo: '(#131026) Message undeliverable' }),
            envio('fallido', { motivo: 'Message Undeliverable' }), // guardado antes, sin código
            envio('fallido', { motivo: '(#190) Error validating access token' }),
            envio('fallido', { motivo: 'network_error' }),
            envio('fallido', { motivo: '(#555555) Raro' }),
            envio('incierto', { motivo: 'lease_vencido' }),
        ]);
        expect(grupos[0]).toMatchObject({ clave: 'meta_131026', codigo: 131026, cantidad: 2, quien: 'escuela' });
        expect(grupos.find((g) => g.clave === 'meta_190')).toMatchObject({ quien: 'sportmaps', cantidad: 1 });
        expect(grupos.find((g) => g.clave === 'tecnico')).toMatchObject({ codigo: null, quien: 'sportmaps' });
        expect(grupos.find((g) => g.clave === 'meta_555555')).toMatchObject({ texto: 'Error de Meta (#555555)', quien: 'sportmaps' });
        expect(grupos.reduce((s, g) => s + g.cantidad, 0)).toBe(5);
    });
});

describe('qué tan cerca del freno', () => {
    it('fallos que faltan: más del 20 % de lo enviado, con base mínima de 20', () => {
        expect(fallosQueFaltanParaElFreno(0, 0)).toBe(5);   // 5/20 = 25 %
        expect(fallosQueFaltanParaElFreno(10, 4)).toBe(1);  // 5/20
        expect(fallosQueFaltanParaElFreno(100, 0)).toBe(26); // 26/126 = 20,6 %
        expect(fallosQueFaltanParaElFreno(100, 30)).toBe(0);
    });
    it('piloto de 50 con 3 bajas: no frena; faltan 2 bajas', () => {
        const f = resumenDelFreno({ enviados: 50, bajas: 3, fallidos: 0 });
        expect(f).toMatchObject({ enviados_24h: 50, bajas_24h: 3, fallidos_24h: 0, bajas_que_faltan: 2, en_el_limite: false });
        expect(f?.texto).toMatch(/si 2 personas más piden no recibir más/);
    });
    it('ya en el límite', () => {
        expect(resumenDelFreno({ enviados: 50, bajas: 5, fallidos: 0 })).toMatchObject({ bajas_que_faltan: 0, en_el_limite: true });
        expect(resumenDelFreno({ enviados: 30, bajas: 0, fallidos: 10 })).toMatchObject({ fallos_que_faltan: 0, en_el_limite: true });
    });
    it('sin envíos en 24 h y sin dato', () => {
        expect(resumenDelFreno({ enviados: 0, bajas: 0, fallidos: 0 })?.texto).toMatch(/no ha salido ninguna campaña/);
        expect(resumenDelFreno(null)).toBeNull();
    });
});

describe('leerReporteDeCampana', () => {
    const sembrar = (c: Partial<CampanaDelReporte> = {}) => {
        db.t.whatsapp_campanas = [campana(c)];
        db.t.whatsapp_campana_envios = [
            { campana_id: CAMP, integration_id: 'integ-1', updated_at: '2026-11-17T14:00:00Z', ...envio('enviado', { contact_wa_id: 'a' }) },
            { campana_id: CAMP, integration_id: 'integ-1', updated_at: '2026-11-17T14:00:00Z', ...envio('respondio_si', { contact_wa_id: 'b' }) },
            { campana_id: CAMP, integration_id: 'integ-1', updated_at: '2026-11-17T14:00:00Z', ...envio('fallido', { contact_wa_id: 'c', motivo: '(#131026) Message undeliverable' }) },
            { campana_id: 'otra', integration_id: 'integ-1', updated_at: '2026-11-17T14:00:00Z', ...envio('baja', { contact_wa_id: 'x' }) },
        ];
        db.t.whatsapp_messages = [
            { integration_id: 'integ-1', status: 'read', created_at: '2026-11-17T13:00:00Z', payload: { campana_id: CAMP, step: 'campana' } },
            { integration_id: 'integ-1', status: 'delivered', created_at: '2026-11-17T13:00:00Z', payload: { campana_id: CAMP, step: 'campana' } },
            // La respuesta al «Sí» también lleva campana_id, pero no es el mensaje de la campaña.
            { integration_id: 'integ-1', status: 'read', created_at: '2026-11-17T13:05:00Z', payload: { campana_id: CAMP, step: 'campana_si' } },
        ];
    };

    it('arma el reporte con pocas consultas y sin la RPC si la campaña no vende un servicio', async () => {
        sembrar();
        const r = await leerReporteDeCampana(ESC, CAMP, MARTES_10AM);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.reporte.resumen).toMatchObject({ enviados: 2, entregados: 2, leidos: 1, respondieron: { si: 1, luego: 0, total: 1 }, pagaron: null });
        expect(r.reporte.fallidos.grupos[0]).toMatchObject({ codigo: 131026, cantidad: 1 });
        // El freno cuenta toda la integración (la baja es de otra campaña del mismo número).
        expect(r.reporte.freno).toMatchObject({ enviados_24h: 4, bajas_24h: 1, fallidos_24h: 1 });
        expect(db.rpcLlamadas).toHaveLength(0);
        // campaña + envíos + 2 conteos de entrega + señales de 24 h.
        expect(db.llamadas).toHaveLength(5);
    });

    it('con servicio: cruza la RPC con los enviados', async () => {
        sembrar({ servicio_id: SERV });
        db.rpc.wa_compradores_de_servicio = () => ({
            data: [{ contact_wa_id: 'a', primer_pago_at: '2026-11-17T14:30:00Z' }, { contact_wa_id: 'c', primer_pago_at: '2026-11-17T14:30:00Z' }],
            error: null,
        });
        const r = await leerReporteDeCampana(ESC, CAMP, MARTES_10AM);
        expect(r.ok && r.reporte.resumen.pagaron).toMatchObject({ cantidad: 1 });
        expect(db.rpcLlamadas).toEqual([{ fn: 'wa_compradores_de_servicio', args: { p_school_id: ESC, p_item_id: SERV } }]);
    });

    it('la RPC todavía no existe en la base: «pagaron» queda null y el resto sale', async () => {
        sembrar({ servicio_id: SERV }); // sin db.rpc: responde error
        const r = await leerReporteDeCampana(ESC, CAMP, MARTES_10AM);
        expect(r.ok).toBe(true);
        expect(r.ok && r.reporte.resumen.pagaron).toBeNull();
        expect(r.ok && r.reporte.resumen.enviados).toBe(2);
    });

    it('la columna servicio_id todavía no existe (42703): relee sin ella y no llama la RPC', async () => {
        sembrar({ servicio_id: SERV });
        db.columnasQueFaltan.add('servicio_id');
        const r = await leerReporteDeCampana(ESC, CAMP, MARTES_10AM);
        expect(r.ok).toBe(true);
        expect(r.ok && r.reporte.campana.servicio_id).toBe(SERV); // la fila de prueba la trae; lo que importa es que no falló
        expect(db.llamadas.filter((l) => l.tabla === 'whatsapp_campanas')).toHaveLength(2);
    });

    it('la campaña de OTRA escuela no existe para esta; un borrador no tiene reporte', async () => {
        sembrar();
        expect(await leerReporteDeCampana('99999999-9999-4999-8999-999999999999', CAMP, MARTES_10AM))
            .toEqual({ ok: false, status: 404, error: 'campana_no_encontrada' });
        db.t.whatsapp_campanas[0].estado = 'borrador';
        expect(await leerReporteDeCampana(ESC, CAMP, MARTES_10AM)).toEqual({ ok: false, status: 409, error: 'sin_aprobar' });
        expect(await leerReporteDeCampana(ESC, 'no-uuid', MARTES_10AM)).toMatchObject({ ok: false, status: 400 });
    });
});

describe('aviso al equipo de SportMaps', () => {
    const C = { id: CAMP, school_id: ESC, nombre: 'Clínica de diciembre' };
    const fila = (estado: string, motivo: string | null, campana_id = CAMP) => ({ campana_id, estado, motivo });

    it('solo los grupos que revisa SportMaps, más los inciertos', () => {
        const grupos = gruposParaSoporte([
            { estado: 'fallido', motivo: '(#131026) Message undeliverable' }, // lo corrige la escuela
            { estado: 'fallido', motivo: '(#190) token' }, { estado: 'fallido', motivo: '(#190) token' },
            { estado: 'incierto', motivo: 'lease_vencido' },
            { estado: 'enviado', motivo: null },
        ]);
        expect(grupos).toEqual([
            expect.objectContaining({ clave: 'meta_190', codigo: 190, cantidad: 2 }),
            expect.objectContaining({ clave: 'incierto', codigo: null, cantidad: 1 }),
        ]);
    });

    it('deduplicación pura: una clave por campaña y tipo de error', () => {
        const grupos = gruposParaSoporte([{ estado: 'fallido', motivo: '(#190) x' }, { estado: 'incierto', motivo: null }]);
        expect(claveDeAviso(CAMP, 'meta_190')).toBe(`wa_campana_soporte:${CAMP}:meta_190`);
        expect(gruposSinAvisar(CAMP, grupos, new Set([claveDeAviso(CAMP, 'meta_190')])).map((g) => g.clave)).toEqual(['incierto']);
        // Lo avisado de OTRA campaña no cuenta.
        expect(gruposSinAvisar(CAMP, grupos, new Set([claveDeAviso('otra', 'meta_190')]))).toHaveLength(2);
    });

    it('un aviso por campaña y tipo de error, no uno por mensaje; el segundo tick no repite', async () => {
        db.t.whatsapp_campana_envios = [
            fila('fallido', '(#190) Error validating access token'), fila('fallido', '(#190) Error validating access token'),
            fila('fallido', '(#190) Error validating access token'), fila('incierto', 'lease_vencido'),
            fila('fallido', '(#131026) Message undeliverable'),
        ];
        expect(await avisarSoporteDeCampanas([C])).toBe(2);
        expect(correo.enviados.map((e) => e.clave).sort()).toEqual(
            [`wa_campana_soporte:${CAMP}:incierto`, `wa_campana_soporte:${CAMP}:meta_190`]);
        const token = correo.enviados.find((e) => e.clave.endsWith('meta_190'));
        expect(token).toMatchObject({ tipo: 'wa_campana_soporte', schoolId: ESC, refId: CAMP, destinos: ['soporte@sportmaps.co'], plantilla: null });
        expect(token.respaldo.lineas.join('\n')).toMatch(/#190/);
        expect(token.respaldo.lineas.join('\n')).toMatch(/hasta ahora: 3/);
        expect(token.respaldo.lineas.join('\n')).toMatch(/Monster´s Volley Club/);
        expect(token.respaldo.enlace.url).toMatch(new RegExp(`/whatsapp\\?tab=campanas&campana=${CAMP}$`));

        // Segundo tick con más fallos del mismo tipo: nada nuevo, y ni siquiera intenta reservar.
        db.t.whatsapp_campana_envios.push(fila('fallido', '(#190) Error validating access token'));
        const { enviarConReserva } = await import('./avisos-correo.service');
        vi.mocked(enviarConReserva).mockClear();
        expect(await avisarSoporteDeCampanas([C])).toBe(0);
        expect(enviarConReserva).not.toHaveBeenCalled();
        expect(correo.enviados).toHaveLength(2);
    });

    it('tras un reinicio (memoria vacía) la reserva en email_sends evita el repetido', async () => {
        db.t.whatsapp_campana_envios = [fila('incierto', 'lease_vencido')];
        expect(await avisarSoporteDeCampanas([C])).toBe(1);
        _olvidarAvisos(); // redeploy u otro BFF
        expect(await avisarSoporteDeCampanas([C])).toBe(0);
        expect(correo.enviados).toHaveLength(1);
    });

    it('un tipo de error NUEVO en la misma campaña sí avisa', async () => {
        db.t.whatsapp_campana_envios = [fila('incierto', 'lease_vencido')];
        await avisarSoporteDeCampanas([C]);
        db.t.whatsapp_campana_envios.push(fila('fallido', '(#131000) Something went wrong'));
        expect(await avisarSoporteDeCampanas([C])).toBe(1);
        expect(correo.enviados.map((e) => e.clave)).toContain(`wa_campana_soporte:${CAMP}:meta_131000`);
    });

    it('solo fallos que corrige la escuela, o ninguna campaña: no avisa; una sola consulta para todas', async () => {
        db.t.whatsapp_campana_envios = [fila('fallido', '(#131026) Message undeliverable'), fila('fallido', 'meta_131049', 'otra')];
        expect(await avisarSoporteDeCampanas([C, { id: 'otra', school_id: ESC, nombre: 'Otra' }])).toBe(0);
        expect(db.llamadas).toHaveLength(1);
        expect(correo.enviados).toHaveLength(0);
        db.llamadas = [];
        expect(await avisarSoporteDeCampanas([])).toBe(0);
        expect(db.llamadas).toHaveLength(0);
    });
});
