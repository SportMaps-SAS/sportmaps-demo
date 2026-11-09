import { describe, it, expect } from 'vitest';
import { conceptoDePlan } from './enrollmentBilling';

describe('conceptoDePlan', () => {
    it('antepone «Plan» cuando el plan no lo trae', () => {
        expect(conceptoDePlan('Mayores mixto')).toBe('Plan Mayores mixto');
    });
    it('no repite «Plan» si el plan ya se llama «Plan …»', () => {
        expect(conceptoDePlan('Plan Mayores mixto')).toBe('Plan Mayores mixto');
        expect(conceptoDePlan('plan básico')).toBe('plan básico');
    });
    it('no lo toma como prefijo si solo empieza con las mismas letras', () => {
        expect(conceptoDePlan('Planeta 7')).toBe('Plan Planeta 7');
    });
    it('sin nombre, queda «Plan»', () => {
        expect(conceptoDePlan(null)).toBe('Plan');
        expect(conceptoDePlan('  ')).toBe('Plan');
    });
});
