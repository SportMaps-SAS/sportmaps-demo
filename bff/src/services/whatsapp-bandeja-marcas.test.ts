/**
 * Bandeja y marcas de contacto (2026-10-13). Datos inventados.
 *
 *  - Las filas de un contacto marcado no-familia no cuentan.
 *  - «También es familia»: lo que habla de un cobro conserva su grupo; sus
 *    fotos personales son informativas y se cierran al marcar.
 *  - Sugerencias: ráfaga de más de 5 adjuntos en 24 h o nombre de negocio,
 *    nunca para quien ya es familia o ya está marcado.
 */
import { describe, expect, it } from 'vitest';
import {
    UMBRAL_RAFAGA, candidatosASugerir, clasificarFila, filaConPagoDeFamilia, filaCuentaEnBandeja,
    filasParaCierrePorMarca, marcaDeCierre, maximoEn24h, motivoDeCierrePorMarca,
    type ConversacionParaSugerir,
} from './whatsapp-bandeja.service';

const fila = (id: string, error_message: string | null, extra: Record<string, any> = {}) =>
    ({ id, status: 'ignored', error_message, ...extra });

describe('filaCuentaEnBandeja', () => {
    it('marcado sin bandera: no cuenta; con bandera o sin marca: sí', () => {
        for (const t of ['personal', 'negocio', 'otro_club', 'plataforma', 'equipo']) {
            expect(filaCuentaEnBandeja(t, false)).toBe(false);
            expect(filaCuentaEnBandeja(t, true)).toBe(true);
        }
        expect(filaCuentaEnBandeja('familia', false)).toBe(true);
        expect(filaCuentaEnBandeja(null, false)).toBe(true);
        expect(filaCuentaEnBandeja('staff')).toBe(true);
    });

    it('un pago real de un contacto no atendido (sin_familia: contacto_no_atendido…) SÍ entra, de cualquier marca', () => {
        const pago = 'sin_familia: contacto_no_atendido (personal): comprobante de $150.000 a una cuenta de la escuela';
        for (const t of ['personal', 'negocio', 'otro_club', 'plataforma', 'equipo', 'desconocido']) {
            expect(filaCuentaEnBandeja(t, false, pago)).toBe(true);
        }
    });
    it('la foto sin pago (contacto_no_atendido a secas) o cualquier otro motivo sigue escondida', () => {
        expect(filaCuentaEnBandeja('personal', false, 'contacto_no_atendido')).toBe(false);
        expect(filaCuentaEnBandeja('negocio', false, 'no es un comprobante')).toBe(false);
        expect(filaCuentaEnBandeja('personal', false, null)).toBe(false);
    });
});

describe('clasificarFila con «también es familia»', () => {
    it('lo que habla de un cobro conserva su grupo', () => {
        const c = clasificarFila(fila('a', 'recuperado: varios_cobros — 2 cobros'), 'personal', true);
        expect(c.grupo).toBe('accion');
        expect(clasificarFila(fila('b', 'monto_no_cuadra: 150000 vs 180000'), 'personal', true).grupo).toBe('accion');
    });
    it('sus fotos personales son informativas, nunca «revisar»', () => {
        expect(clasificarFila(fila('c', 'contacto_no_atendido'), 'personal', true).grupo).toBe('informativo');
        expect(clasificarFila(fila('d', 'sin pagos pendientes'), 'personal', true).grupo).toBe('informativo');
        expect(clasificarFila(fila('e', 'no es un comprobante'), 'personal', true).grupo).toBe('informativo');
    });
    it('una fila enlazada a un atleta se queda aunque el motivo no sea de cobro', () => {
        expect(clasificarFila(fila('f', 'bot_apagado', { matched_child_id: 'child-x' }), 'personal', true).grupo).toBe('revisar');
    });
    it('sin bandera, negocio baja un escalón como personal', () => {
        expect(clasificarFila(fila('g', 'recuperado: varios_cobros — x'), 'negocio', false).grupo).toBe('revisar');
        expect(clasificarFila(fila('h', 'contacto_no_atendido'), 'otro_club').grupo).toBe('informativo');
    });
});

describe('filasParaCierrePorMarca', () => {
    const filas = [
        fila('foto', 'contacto_no_atendido'),
        fila('cobro', 'recuperado: monto_distinto — 1 cobro', { matched_child_id: 'child-x' }),
        fila('esperando', null, { status: 'waiting_user' }),
        fila('ya-cerrada', 'cerrado_escuela: descartado — x | no es un comprobante'),
        fila('hecha', null, { status: 'done' }),
    ];
    it('sin bandera cierra todas las abiertas', () => {
        expect(filasParaCierrePorMarca(filas, false).map((f) => f.id)).toEqual(['foto', 'cobro', 'esperando']);
    });
    it('con «también es familia» deja las que pueden ser el pago del hijo', () => {
        expect(filasParaCierrePorMarca(filas, true).map((f) => f.id)).toEqual(['foto']);
        expect(filaConPagoDeFamilia(filas[2])).toBe(true);
    });
    it('el motivo usa el formato de cierre de siempre', () => {
        expect(motivoDeCierrePorMarca('otro_club')).toBe('contacto marcado como otro club');
        expect(marcaDeCierre('descartado', motivoDeCierrePorMarca('negocio'), 'usuario-1234567890', 'contacto_no_atendido'))
            .toBe('cerrado_escuela: descartado — contacto marcado como negocio (por usuario-) | contacto_no_atendido');
    });
});

describe('maximoEn24h', () => {
    it('ventana deslizante', () => {
        const base = Date.parse('2026-10-09T19:00:00Z');
        const h = (n: number) => new Date(base + n * 3_600_000).toISOString();
        expect(maximoEn24h([h(0), h(1), h(2), h(30), h(31)])).toBe(3);
        expect(maximoEn24h([h(0), h(23), h(24), h(25)])).toBe(3); // 0..24 h inclusive
        expect(maximoEn24h([null, 'x'])).toBe(0);
    });
});

describe('candidatosASugerir', () => {
    const base = Date.parse('2026-10-09T19:00:00Z');
    const rafaga = (numero: string, n: number, cada = 10) =>
        Array.from({ length: n }, (_, i) => ({ wa_phone_number: numero, created_at: new Date(base + i * cada * 60_000).toISOString() }));
    const conv = (id: string, contact_name: string | null, contact_kind: string | null, extra: Partial<ConversacionParaSugerir> = {}) =>
        ({ id, contact_name, contact_kind, ...extra });

    it(`más de ${UMBRAL_RAFAGA} adjuntos en 24 h de un desconocido → sugerir negocio`, () => {
        const convs = new Map([['573000000010', conv('c10', 'Proveedor X', 'desconocido')]]);
        const r = candidatosASugerir(rafaga('573000000010', 6), convs);
        expect(r).toEqual([{ wa_phone_number: '573000000010', conversacion_id: 'c10', contacto: 'Proveedor X',
            motivo: 'rafaga', adjuntos_24h: 6, filas: 6, tipo_sugerido: 'negocio' }]);
    });

    it(`exactamente ${UMBRAL_RAFAGA} no es ráfaga`, () => {
        expect(candidatosASugerir(rafaga('573000000011', 5), new Map())).toEqual([]);
    });

    it('6 adjuntos repartidos en tres días no son ráfaga', () => {
        expect(candidatosASugerir(rafaga('573000000012', 6, 12 * 60), new Map())).toEqual([]);
    });

    it('nombre de negocio con una sola foto → sugerir con su tipo', () => {
        const convs = new Map([['573000000013', conv('c13', 'Club Deportivo Prueba', null)]]);
        const r = candidatosASugerir(rafaga('573000000013', 1), convs);
        expect(r[0]).toMatchObject({ motivo: 'nombre', tipo_sugerido: 'otro_club' });
    });

    it('nunca a familias, staff, ya marcados o identificados por OTP', () => {
        const convs = new Map<string, ConversacionParaSugerir>([
            ['573000000020', conv('a', 'Tienda', 'familia')],
            ['573000000021', conv('b', 'Tienda', 'staff')],
            ['573000000022', conv('c', 'Tienda', 'negocio')],
            ['573000000023', conv('d', 'Tienda', 'desconocido', { identified: true, parent_id: 'p-1' })],
        ]);
        const filas = ['573000000020', '573000000021', '573000000022', '573000000023'].flatMap((n) => rafaga(n, 8));
        expect(candidatosASugerir(filas, convs)).toEqual([]);
    });
});
