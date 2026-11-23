import { describe, it, expect } from 'vitest';
import { tocaAvisarBloqueoPac, mensajeBloqueoPac, FRENO_AVISO_BLOQUEO_PAC_MS } from './bloqueo-pac-aviso';

describe('aviso de bloqueo del PAC', () => {
    const t0 = 1_800_000_000_000;
    it('la primera vez siempre toca avisar', () => {
        expect(tocaAvisarBloqueoPac(undefined, t0)).toBe(true);
    });
    it('dentro de las 6 h no repite; pasadas las 6 h sí', () => {
        expect(tocaAvisarBloqueoPac(t0, t0 + FRENO_AVISO_BLOQUEO_PAC_MS - 1)).toBe(false);
        expect(tocaAvisarBloqueoPac(t0, t0 + FRENO_AVISO_BLOQUEO_PAC_MS)).toBe(true);
    });
    it('el mensaje nombra la escuela y dice qué hacer', () => {
        const m = mensajeBloqueoPac('esc-1');
        expect(m).toContain('esc-1');
        expect(m).toMatch(/panel del PAC/);
        expect(m).toMatch(/backfillInvoices/);
    });
});
