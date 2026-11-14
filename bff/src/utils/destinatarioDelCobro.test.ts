import { describe, expect, it } from 'vitest';
import { destinatarioDelCobro } from './destinatarioDelCobro';

describe('destinatarioDelCobro', () => {
    it('con acudiente, el acudiente (aunque haya user_id)', () => {
        expect(destinatarioDelCobro({ parent_id: 'padre', user_id: 'hijo' })).toBe('padre');
    });
    it('sin acudiente, el adulto dueño del cobro', () => {
        expect(destinatarioDelCobro({ parent_id: null, user_id: 'adulto' })).toBe('adulto');
        expect(destinatarioDelCobro({ user_id: 'adulto' })).toBe('adulto');
    });
    it('sin ninguno, null', () => {
        expect(destinatarioDelCobro({ parent_id: null, user_id: null })).toBeNull();
        expect(destinatarioDelCobro(null)).toBeNull();
    });
});
