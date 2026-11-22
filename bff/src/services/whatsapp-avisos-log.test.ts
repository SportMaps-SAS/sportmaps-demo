import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    avisosLogHabilitado, recortarDetalle, registrarAviso, VENTANA_DEDUPE_HORAS, type AvisoARegistrar, type DepsAvisosLog,
} from './whatsapp-avisos-log';

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const base: AvisoARegistrar = { schoolId: ESC, concepto: 'cobro_unico_nuevo', paymentId: 'p1', resultado: 'no_enviado', motivo: 'sin_optin' };

const deps = (reciente = false) => {
    const insertar = vi.fn(async () => undefined);
    const existeReciente = vi.fn(async () => reciente);
    return { insertar, existeReciente, d: { insertar, existeReciente } as DepsAvisosLog };
};

describe('avisosLogHabilitado', () => {
    it('apagado sin variable o con otra escuela; encendido con la escuela en la lista', () => {
        expect(avisosLogHabilitado(ESC, undefined)).toBe(false);
        expect(avisosLogHabilitado(ESC, 'otra')).toBe(false);
        expect(avisosLogHabilitado(ESC, `otra, ${ESC}`)).toBe(true);
        expect(avisosLogHabilitado('', ESC)).toBe(false);
    });
});

describe('registrarAviso', () => {
    it('apagado: no consulta ni inserta', async () => {
        const { d, insertar, existeReciente } = deps();
        expect(await registrarAviso(base, d, '')).toBe(false);
        expect(insertar).not.toHaveBeenCalled();
        expect(existeReciente).not.toHaveBeenCalled();
    });

    it('encendido: un no_enviado inserta UNA fila con su motivo', async () => {
        const { d, insertar } = deps();
        expect(await registrarAviso({ ...base, destino: '573001112233', detalle: 'x' }, d, ESC)).toBe(true);
        expect(insertar).toHaveBeenCalledTimes(1);
        expect(insertar).toHaveBeenCalledWith(expect.objectContaining({
            school_id: ESC, concepto: 'cobro_unico_nuevo', resultado: 'no_enviado', motivo: 'sin_optin', payment_id: 'p1', destino: '573001112233',
        }));
    });

    it('un no_enviado repetido en la ventana no se guarda otra vez', async () => {
        const { d, insertar, existeReciente } = deps(true);
        expect(await registrarAviso(base, d, ESC)).toBe(false);
        expect(existeReciente).toHaveBeenCalledWith(base, VENTANA_DEDUPE_HORAS);
        expect(insertar).not.toHaveBeenCalled();
    });

    it('un enviado siempre se guarda, con motivo «ok» y el id de Meta, sin consultar repetidos', async () => {
        const { d, insertar, existeReciente } = deps(true);
        const a: AvisoARegistrar = { schoolId: ESC, concepto: 'cobro_unico_nuevo', resultado: 'enviado', plantilla: 'cobro_unico_nuevo', waMessageId: 'wamid.1' };
        expect(await registrarAviso(a, d, ESC)).toBe(true);
        expect(existeReciente).not.toHaveBeenCalled();
        expect(insertar).toHaveBeenCalledWith(expect.objectContaining({ resultado: 'enviado', motivo: 'ok', wa_message_id: 'wamid.1', plantilla: 'cobro_unico_nuevo' }));
    });

    it('recorta el detalle a 300 caracteres', async () => {
        const { d, insertar } = deps();
        await registrarAviso({ ...base, detalle: 'a'.repeat(500) }, d, ESC);
        const fila = (insertar.mock.calls[0] as any[])[0] as any;
        expect(fila.detalle).toHaveLength(300);
        expect(recortarDetalle(null)).toBeNull();
    });

    it('nunca lanza: un fallo de la base devuelve false', async () => {
        const d: DepsAvisosLog = { existeReciente: async () => { throw new Error('boom'); }, insertar: async () => { throw new Error('boom'); } };
        await expect(registrarAviso(base, d, ESC)).resolves.toBe(false);
        await expect(registrarAviso({ ...base, resultado: 'enviado' }, d, ESC)).resolves.toBe(false);
    });
});
