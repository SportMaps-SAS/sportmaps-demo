/**
 * whatsapp-optin.service — baja de PROMOCIONES (2026-11-15) frente a la baja total.
 *
 * `sinPromociones` es la pregunta que hace la campaña antes de escribirle a
 * alguien: ¿esta fila de `whatsapp_optins` lo saca de las promociones? Sí con
 * la baja de promociones (botón «No recibir más») y sí con la baja total
 * vigente (escribió BAJA / STOP); no si volvió a aceptar después de la baja.
 *
 * Las dos funciones que escriben van contra una RPC simulada: nada sale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    llamadas: [] as { fn: string; args: any }[],
    respuesta: null as null | ((fn: string) => { data: any; error: any }),
    lanza: false,
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        rpc: (fn: string, args: any) => {
            db.llamadas.push({ fn, args });
            if (db.lanza) return Promise.reject(new Error('sin red'));
            return Promise.resolve(db.respuesta?.(fn) ?? { data: null, error: null });
        },
    },
}));

import { levantarBajaDePromos, registrarBajaDePromos, sinPromociones } from './whatsapp-optin.service';

const AYER = '2026-11-14T15:00:00Z';
const HOY = '2026-11-15T15:00:00Z';

beforeEach(() => {
    db.llamadas = []; db.respuesta = null; db.lanza = false;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('sinPromociones (pura)', () => {
    it('sin fila de opt-in: no está fuera', () => {
        expect(sinPromociones(null)).toBe(false);
        expect(sinPromociones(undefined)).toBe(false);
        expect(sinPromociones({})).toBe(false);
    });

    it('con opt-in y sin ninguna baja: recibe', () => {
        expect(sinPromociones({ opted_in_at: AYER, opted_out_at: null, promos_out_at: null })).toBe(false);
        expect(sinPromociones({ opted_in_at: AYER })).toBe(false);
    });

    it('baja de promociones: fuera, aunque tenga opt-in vigente y ninguna baja total', () => {
        expect(sinPromociones({ opted_in_at: AYER, opted_out_at: null, promos_out_at: HOY })).toBe(true);
        expect(sinPromociones({ promos_out_at: HOY })).toBe(true);
    });

    it('baja de promociones ANTERIOR al opt-in: sigue fuera (un opt-in no la levanta; solo ACTIVAR)', () => {
        expect(sinPromociones({ opted_in_at: HOY, opted_out_at: null, promos_out_at: AYER })).toBe(true);
    });

    it('baja total sin opt-in: fuera', () => {
        expect(sinPromociones({ opted_in_at: null, opted_out_at: AYER, promos_out_at: null })).toBe(true);
        expect(sinPromociones({ opted_out_at: AYER })).toBe(true);
    });

    it('baja total posterior (o simultánea) al opt-in: fuera', () => {
        expect(sinPromociones({ opted_in_at: AYER, opted_out_at: HOY })).toBe(true);
        expect(sinPromociones({ opted_in_at: HOY, opted_out_at: HOY })).toBe(true);
    });

    it('baja total ANTERIOR al opt-in (volvió a aceptar): recibe', () => {
        expect(sinPromociones({ opted_in_at: HOY, opted_out_at: AYER, promos_out_at: null })).toBe(false);
    });

    it('volvió a aceptar tras la baja total pero tiene baja de promociones: fuera', () => {
        expect(sinPromociones({ opted_in_at: HOY, opted_out_at: AYER, promos_out_at: AYER })).toBe(true);
    });
});

describe('registrarBajaDePromos', () => {
    const INTEG = { id: 'integ-1', school_id: 'escuela-1' };

    it('llama wa_registrar_baja_promos con la integración, la escuela, el contacto y la referencia', async () => {
        expect(await registrarBajaDePromos(INTEG, '573001112233', 'wamid.abc')).toBe(true);
        expect(db.llamadas).toEqual([{
            fn: 'wa_registrar_baja_promos',
            args: { p_integration_id: 'integ-1', p_school_id: 'escuela-1', p_contact_wa_id: '573001112233', p_ref: 'wamid.abc' },
        }]);
    });

    it('error de la RPC o red caída: false, sin lanzar', async () => {
        db.respuesta = () => ({ data: null, error: { message: 'function does not exist' } });
        expect(await registrarBajaDePromos(INTEG, '573001112233', null)).toBe(false);
        db.lanza = true;
        expect(await registrarBajaDePromos(INTEG, '573001112233', null)).toBe(false);
    });
});

describe('levantarBajaDePromos', () => {
    it('true solo si la RPC dice que había una baja y la levantó', async () => {
        db.respuesta = () => ({ data: true, error: null });
        expect(await levantarBajaDePromos('integ-1', '573001112233')).toBe(true);
        expect(db.llamadas).toEqual([{ fn: 'wa_reactivar_promos', args: { p_integration_id: 'integ-1', p_contact_wa_id: '573001112233' } }]);
        db.respuesta = () => ({ data: false, error: null });
        expect(await levantarBajaDePromos('integ-1', '573001112233')).toBe(false);
    });

    it('error de la RPC o red caída: false, sin lanzar', async () => {
        db.respuesta = () => ({ data: true, error: { message: 'boom' } });
        expect(await levantarBajaDePromos('integ-1', '573001112233')).toBe(false);
        db.lanza = true;
        expect(await levantarBajaDePromos('integ-1', '573001112233')).toBe(false);
    });
});
