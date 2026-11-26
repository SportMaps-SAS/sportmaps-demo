import { describe, it, expect } from 'vitest';
import { pideBajaTotal } from './whatsapp-baja-texto';
import { opcionVigente, opcionesVigentes, semanasDeOpcion } from './wa-cobro-desde-comprobante.service';
import { precioDelServicio } from './whatsapp-anuncio-destino';

describe('F3-01/F3-02 — la baja reconoce frases naturales', () => {
    it.each([
        'stop', 'STOP', 'Stop por favor', 'parar', 'unsubscribe', 'baja por favor', 'darme de baja', 'Quiero darme de baja',
        'ya no quiero mensajes', 'no me escriban más', 'No me escriban más por favor, ya no me interesa nada',
        'no más mensajes', 'dejen de escribirme', 'Quítenme de la lista', 'bórrenme', 'no molesten', 'No me manden más mensajes',
        'sacarme de la lista de contactos', 'Ya no quiero recibir notificaciones',
    ])('«%s» da de baja', (t) => expect(pideBajaTotal(t)).toBe(true));

    it.each([
        'quiero cancelar la clase del sábado', 'cancelar', 'quiero dar de baja a mi hijo', 'dar de baja a mi hija de la escuela',
        'no me interesa', 'no quiero que me den de baja', 'no me quiero dar de baja', 'hola', 'cuánto cuesta',
        'me pueden mandar el comprobante', 'ya no puedo ir el sábado', '',
        'Hola buenas tardes quisiera saber si ya no quiero mensajes pero sí quiero que me llamen para pagar la inscripción de mi hija',
    ])('«%s» NO da de baja', (t) => expect(pideBajaTotal(t)).toBe(false));
});

const item = {
    id: 'i', name: 'Vacacional', kind: 'vacacional', price: 50000,
    starts_at: '2026-11-16', ends_at: '2026-12-10',
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000 },
        { clave: '3', etiqueta: '3 semanas', precio: 170000 },
        { clave: '4', etiqueta: '4 semanas', precio: 200000 },
    ],
};

describe('F1-01/F10-03 — las opciones dependen de la fecha', () => {
    it('lee las semanas de la etiqueta', () => {
        expect(semanasDeOpcion({ clave: 'x', etiqueta: 'Tres semanas' })).toBe(3);
        expect(semanasDeOpcion({ clave: '2_semanas', etiqueta: 'Plan' })).toBe(2);
        expect(semanasDeOpcion({ clave: 'x', etiqueta: 'Jornada completa' })).toBeNull();
    });

    it('el 17-nov caben las 4 semanas... salvo la que ya no cabe antes del 10-dic', () => {
        // 17-nov + 21 días = 8-dic ≤ 10-dic: caben las 4.
        expect(opcionesVigentes(item, '2026-11-17').map((o) => o.clave)).toEqual(['1', '2', '3', '4']);
    });

    it('el 26-nov ya no cabe la 4.ª; el 3-dic solo caben 1 y 2; el 10-dic solo 1', () => {
        expect(opcionesVigentes(item, '2026-11-26').map((o) => o.clave)).toEqual(['1', '2', '3']);
        expect(opcionesVigentes(item, '2026-12-03').map((o) => o.clave)).toEqual(['1', '2']);
        expect(opcionesVigentes(item, '2026-12-10').map((o) => o.clave)).toEqual(['1']);
    });

    it('la cotización y la ficha no listan lo vencido', () => {
        const p = precioDelServicio(item as any, { afiliado: false, hoy: '2026-12-03' });
        expect(p.opciones.map((o) => o.etiqueta)).toEqual(['1 semana', '2 semanas']);
    });

    it('`hasta` manda sobre la deducción', () => {
        const op = { clave: 'a', etiqueta: '1 semana', precio: 1, hasta: '2026-11-30' };
        expect(opcionVigente(item, op, '2026-11-30')).toBe(true);
        expect(opcionVigente(item, op, '2026-12-01')).toBe(false);
    });

    it('sin fecha de fin ni `hasta` no se inventa un cierre', () => {
        expect(opcionVigente({ starts_at: null, ends_at: null }, { clave: '4', etiqueta: '4 semanas', precio: 1 }, '2030-01-01')).toBe(true);
    });

    it('si el servicio aún no empieza se cuenta desde su inicio', () => {
        const futuro = { ...item, starts_at: '2026-12-01', ends_at: '2026-12-31' };
        expect(opcionesVigentes(futuro, '2026-11-20').map((o) => o.clave)).toEqual(['1', '2', '3', '4']);
    });
});
