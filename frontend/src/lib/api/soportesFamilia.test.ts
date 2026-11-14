import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/bffClient', () => ({ bffClient: {}, BFFError: class extends Error {} }));
import { MAX_BYTES_SOPORTE, archivoABase64, validarSoporte } from './soportesFamilia';

describe('validarSoporte', () => {
    it('acepta PDF y fotos en soportes que permiten ambos', () => {
        expect(validarSoporte({ name: 'eps.pdf', size: 1000, type: 'application/pdf' }, 'eps_certificate')).toBeNull();
        expect(validarSoporte({ name: 'eps.JPG', size: 1000, type: 'image/jpeg' }, 'eps_certificate')).toBeNull();
        expect(validarSoporte({ name: 'doc.webp', size: 1000, type: 'image/webp' }, 'athlete_id_front')).toBeNull();
    });
    it('fotos y firmas solo aceptan imagen', () => {
        for (const t of ['athlete_photo', 'guardian_signature', 'athlete_signature']) {
            expect(validarSoporte({ name: 'x.pdf', size: 10, type: 'application/pdf' }, t)).toMatch(/foto/i);
            expect(validarSoporte({ name: 'x.png', size: 10, type: 'image/png' }, t)).toBeNull();
        }
    });
    it('rechaza más de 4 MB y formatos no permitidos', () => {
        expect(validarSoporte({ name: 'a.pdf', size: MAX_BYTES_SOPORTE + 1, type: 'application/pdf' }, 'eps_certificate')).toMatch(/4 MB/);
        expect(validarSoporte({ name: 'a.pdf', size: MAX_BYTES_SOPORTE, type: 'application/pdf' }, 'eps_certificate')).toBeNull();
        expect(validarSoporte({ name: 'a.docx', size: 10, type: 'application/msword' }, 'eps_certificate')).toMatch(/PDF o una foto/);
        expect(validarSoporte({ name: 'a.gif', size: 10, type: 'image/gif' }, 'athlete_photo')).toMatch(/foto/i);
    });
});

describe('archivoABase64', () => {
    it('devuelve el base64 sin el prefijo data:', async () => {
        const b64 = await archivoABase64(new Blob(['hola'], { type: 'text/plain' }));
        expect(b64).toBe(btoa('hola'));
    });
});
