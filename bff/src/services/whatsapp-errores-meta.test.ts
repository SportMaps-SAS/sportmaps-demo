/**
 * whatsapp-errores-meta — el motivo guardado con código, y su traducción a
 * lenguaje simple con «quién lo corrige». Todo puro.
 */
import { describe, expect, it } from 'vitest';
import { ERRORES_DE_META, codigoDeMotivo, motivoConCodigo, traducirErrorDeMeta } from './whatsapp-errores-meta';

describe('motivoConCodigo', () => {
    it('antepone el código al título', () => {
        expect(motivoConCodigo(131026, 'Message undeliverable')).toBe('(#131026) Message undeliverable');
        expect(motivoConCodigo('132015', 'Template is Paused')).toBe('(#132015) Template is Paused');
    });
    it('no repite el prefijo si Graph ya lo trae', () => {
        expect(motivoConCodigo(131030, '(#131030) Recipient phone number not in allowed list'))
            .toBe('(#131030) Recipient phone number not in allowed list');
    });
    it('sin código deja el título como antes; sin título deja solo el código', () => {
        expect(motivoConCodigo(null, 'network_error')).toBe('network_error');
        expect(motivoConCodigo(undefined, 'graph_500')).toBe('graph_500');
        expect(motivoConCodigo(0, 'x')).toBe('x');
        expect(motivoConCodigo('abc', 'x')).toBe('x');
        expect(motivoConCodigo(190, null)).toBe('(#190)');
        expect(motivoConCodigo(null, null)).toBe('');
    });
    it('recorta al largo pedido (la columna admite 500; el tick guarda 300)', () => {
        const largo = motivoConCodigo(131000, 'x'.repeat(600));
        expect(largo).toHaveLength(300);
        expect(largo.startsWith('(#131000) x')).toBe(true);
        expect(motivoConCodigo(131000, 'abcdefghij', 12)).toBe('(#131000) ab');
    });
});

describe('codigoDeMotivo', () => {
    it('lee el formato nuevo', () => {
        expect(codigoDeMotivo('(#131026) Message undeliverable')).toBe(131026);
        expect(codigoDeMotivo('(#190) Error validating access token')).toBe(190);
        expect(codigoDeMotivo('(#999999) Algo nuevo')).toBe(999999);
    });
    it('lee los motivos viejos: meta_<código>, el título en inglés y un código conocido suelto', () => {
        expect(codigoDeMotivo('meta_131049')).toBe(131049);
        expect(codigoDeMotivo('Message Undeliverable')).toBe(131026);
        expect(codigoDeMotivo('Re-engagement message')).toBe(131047);
        expect(codigoDeMotivo('This message was not delivered to maintain healthy ecosystem engagement.')).toBe(131049);
        expect(codigoDeMotivo('Template is Paused')).toBe(132015);
        expect(codigoDeMotivo('Spam rate limit hit')).toBe(131048);
        expect(codigoDeMotivo('Rate limit hit')).toBe(130429);
        expect(codigoDeMotivo('131048')).toBe(131048);
    });
    it('no confunde un teléfono, un HTTP 500 ni un texto cualquiera con un código', () => {
        expect(codigoDeMotivo('graph_500')).toBeNull();
        expect(codigoDeMotivo('no se pudo enviar a 573001112233')).toBeNull();
        expect(codigoDeMotivo('network_error')).toBeNull();
        expect(codigoDeMotivo('')).toBeNull();
        expect(codigoDeMotivo(null)).toBeNull();
    });
});

describe('traducirErrorDeMeta', () => {
    it('lo que la escuela puede corregir: número del contacto y plantilla', () => {
        expect(traducirErrorDeMeta('(#131026) Message undeliverable')).toMatchObject({ clave: 'meta_131026', codigo: 131026, quien: 'escuela' });
        for (const c of [132001, 132005, 132007, 132015, 132016]) {
            expect(traducirErrorDeMeta(`(#${c}) x`).quien).toBe('escuela');
        }
    });
    it('lo que revisa SportMaps: técnicos, token, cuenta y límites de Meta', () => {
        for (const c of [131000, 131005, 131008, 131009, 131047, 131048, 131056, 130429, 80007, 190, 368, 131031, 131042, 133010, 132000, 132012]) {
            expect(traducirErrorDeMeta(`(#${c}) x`)).toMatchObject({ clave: `meta_${c}`, codigo: c, quien: 'sportmaps' });
        }
    });
    it('Meta decidió no entregar (131049, 130472): no es una falla técnica, no se manda a soporte', () => {
        expect(traducirErrorDeMeta('meta_131049').quien).toBe('escuela');
        expect(traducirErrorDeMeta('(#130472) User\'s number is part of an experiment').quien).toBe('escuela');
    });
    it('código desconocido: «Error de Meta (#código)» y lo revisa SportMaps', () => {
        expect(traducirErrorDeMeta('(#777777) Algo que Meta inventó ayer')).toEqual({
            clave: 'meta_777777', codigo: 777777, texto: 'Error de Meta (#777777)',
            que_hacer: expect.stringContaining('SportMaps'), quien: 'sportmaps', requiere_accion: false,
        });
    });
    it('requiere_accion: solo cuando la escuela de verdad tiene algo que corregir', () => {
        expect(traducirErrorDeMeta('(#131026) x').requiere_accion).toBe(true);
        expect(traducirErrorDeMeta('(#132015) x').requiere_accion).toBe(true);
        expect(traducirErrorDeMeta('meta_131049').requiere_accion).toBe(false); // de la escuela, pero sin arreglo
        expect(traducirErrorDeMeta('(#190) x').requiere_accion).toBe(false);    // lo revisa SportMaps
    });
    it('motivos sin código: integración, técnico y desconocido, todos de SportMaps', () => {
        expect(traducirErrorDeMeta('integration_without_token')).toMatchObject({ clave: 'integracion', codigo: null, quien: 'sportmaps' });
        expect(traducirErrorDeMeta('token_decrypt_failed').clave).toBe('integracion');
        expect(traducirErrorDeMeta('network_error').clave).toBe('tecnico');
        expect(traducirErrorDeMeta('graph_500').clave).toBe('tecnico');
        expect(traducirErrorDeMeta('fetch failed').clave).toBe('tecnico');
        expect(traducirErrorDeMeta('failed').clave).toBe('tecnico');
        expect(traducirErrorDeMeta('un texto raro')).toMatchObject({ clave: 'desconocido', quien: 'sportmaps' });
        expect(traducirErrorDeMeta(null)).toMatchObject({ clave: 'desconocido', quien: 'sportmaps' });
    });
    it('toda entrada de la tabla trae texto, qué hacer y quién', () => {
        for (const [codigo, e] of Object.entries(ERRORES_DE_META)) {
            expect(e.texto.length, codigo).toBeGreaterThan(10);
            expect(e.que_hacer.length, codigo).toBeGreaterThan(10);
            expect(['escuela', 'sportmaps'], codigo).toContain(e.quien);
        }
    });
});
