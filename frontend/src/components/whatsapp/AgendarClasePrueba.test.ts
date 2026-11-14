import { describe, expect, it } from 'vitest';
import { cuposAgendables, fechaLegible, horaLegible, mensajeDeConfirmacion } from './AgendarClasePruebaDialog';

const cupo = (o: Partial<Parameters<typeof cuposAgendables>[0][number]> = {}) => ({
    id: 'a', team_id: null, label: 'U15 FEMENINO', slot_date: '2026-11-14', start_time: '09:00:00', end_time: '11:00:00',
    location: 'Parque Pinar de Suba 2', max_capacity: 20, reserved_count: 0, is_open: true, ...o,
});

describe('Agendar clase de prueba desde el buzón', () => {
    it('escribe la fecha y la hora como las diría una persona', () => {
        expect(fechaLegible('2026-11-14')).toBe('sábado 14 de noviembre');
        expect(horaLegible('09:00:00')).toBe('9:00 a. m.');
        expect(horaLegible('13:30:00')).toBe('1:30 p. m.');
    });
    it('solo ofrece cupos abiertos, futuros y con espacio, del más próximo al más lejano', () => {
        const r = cuposAgendables([
            cupo({ id: 'pasado', slot_date: '2026-11-01' }),
            cupo({ id: 'cerrado', is_open: false }),
            cupo({ id: 'lleno', reserved_count: 20 }),
            cupo({ id: 'lejos', slot_date: '2026-11-29' }),
            cupo({ id: 'cerca', slot_date: '2026-11-14', start_time: '07:00:00' }),
            cupo({ id: 'hoy', slot_date: '2026-11-12' }),
        ], '2026-11-12');
        expect(r.map((c) => c.id)).toEqual(['hoy', 'cerca', 'lejos']);
    });
    it('el mensaje de confirmación lleva día, hora, lugar y pide el teléfono', () => {
        const m = mensajeDeConfirmacion({ acudiente: 'Carolina Vega', nombre: 'Alisson Junco', cupo: cupo(), pagado: true });
        expect(m).toContain('Hola Carolina');
        expect(m).toContain('clase de prueba de Alisson');
        expect(m).toContain('sábado 14 de noviembre');
        expect(m).toContain('9:00 a. m. a 11:00 a. m.');
        expect(m).toContain('Parque Pinar de Suba 2');
        expect(m).toContain('El pago ya está registrado');
        expect(m).toContain('número de celular');
    });
    it('sin pago no afirma que hay un pago', () => {
        const m = mensajeDeConfirmacion({ acudiente: '', nombre: 'Ana', cupo: cupo(), pagado: false });
        expect(m).not.toContain('pago');
        expect(m.startsWith('Hola 👋')).toBe(true);
    });
});
