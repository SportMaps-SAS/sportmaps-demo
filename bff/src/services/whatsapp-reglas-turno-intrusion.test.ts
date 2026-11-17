/**
 * Reglas puras de «el bot no habla encima de la escuela» (Monster 14–17 nov 2026).
 */
import { describe, it, expect } from 'vitest';
import {
    correoPlausible, quitarPromesasDeSeguimiento, esQuejaContraLaEscuela, pideSuSaldoOPaga, escuelaEscribioHace,
    VENTANA_NO_INTERVENIR_MIN,
} from './whatsapp-reglas-turno';

describe('correoPlausible', () => {
    it('Gaby: «lucyalviraperez@gmail.col» no sirve para armar el enlace', () => {
        expect(correoPlausible('lucyalviraperez@gmail.col')).toBe(false);
    });
    it('errores de tecleo comunes', () => {
        for (const c of ['a@gmial.com', 'a@gmail.co', 'a@hotmail.con', 'a@gamil.com', 'a@yahoo.cm', 'sin-arroba.com', 'a@b', 'a@@b.com'])
            expect(correoPlausible(c), c).toBe(false);
    });
    it('correos normales sí', () => {
        for (const c of ['olindapico2021@gmail.com', 'ana.perez@hotmail.com', 'x@empresa.com.co', 'x@uniandes.edu.co', 'x@colegio.edu', 'x@yahoo.es'])
            expect(correoPlausible(c), c).toBe(true);
    });
    it('vacío o nulo: no', () => {
        expect(correoPlausible(null)).toBe(false);
        expect(correoPlausible('')).toBe(false);
    });
});

describe('quitarPromesasDeSeguimiento', () => {
    it('Andrea P: «quedo atento a lo que confirmen tú y tu esposo» se quita; lo demás queda', () => {
        const t = '¡Listo, quedo atento a lo que confirmen tú y tu esposo! 😊\n\nLa escuela ya dijo que está verificando lo de los uniformes.';
        const r = quitarPromesasDeSeguimiento(t);
        expect(r).not.toMatch(/quedo atento/i);
        expect(r).toContain('La escuela ya dijo que está verificando lo de los uniformes.');
    });
    it('«te aviso cuando sepa» también', () => {
        expect(quitarPromesasDeSeguimiento('Eso lo confirma la escuela. Te aviso cuando tenga novedades.')).toBe('Eso lo confirma la escuela.');
    });
    it('un texto sin promesas queda idéntico', () => {
        const t = 'La escuela te confirma el cupo por aquí 🙌';
        expect(quitarPromesasDeSeguimiento(t)).toBe(t);
    });
    it('si solo era la promesa, no queda nada', () => {
        expect(quitarPromesasDeSeguimiento('Quedo atenta.')).toBe('');
    });
});

describe('esQuejaContraLaEscuela', () => {
    it('Paola Rodríguez: «Quiero poner una queja…»', () => {
        expect(esQuejaContraLaEscuela('Quiero poner una queja como es posible que las otras compañeras de Mariana las subieron a competitivo y a Mariana no')).toBe(true);
    });
    it('«no estoy de acuerdo», «no me parece»', () => {
        expect(esQuejaContraLaEscuela('Pues Felipe, yo no estoy de acuerdo con muchas cosas')).toBe(true);
        expect(esQuejaContraLaEscuela('La verdad Felipe no me parece que si Sebastián es el profesor')).toBe(true);
    });
    it('preguntas normales no son queja', () => {
        for (const t of ['¿A qué hora es el entreno?', 'Gracias profe', 'Cuánto cuesta el vacacional', 'Hola buenas tardes'])
            expect(esQuejaContraLaEscuela(t), t).toBe(false);
    });
});

describe('pideSuSaldoOPaga', () => {
    it('sí: saldo, pago hecho o por hacer', () => {
        for (const t of ['¿cuánto debo?', 'ya pagué', 'les envío el comprobante', 'cómo pago', 'quiero pagar la mensualidad', 'estado de cuenta'])
            expect(pideSuSaldoOPaga(t), t).toBe(true);
    });
    it('Mónica Ramírez: «la mensualidad que venimos pagando» en una pregunta NO es pedir su saldo', () => {
        expect(pideSuSaldoOPaga('el vacacional es aparte de la mensualidad que venimos pagando?')).toBe(false);
    });
    it('saludo o charla: no', () => {
        for (const t of ['Hola buenas tardes', 'todavía no puedo volver esta semana', 'Es para tener información sobre diciembre'])
            expect(pideSuSaldoOPaga(t), t).toBe(false);
    });
});

describe('escuelaEscribioHace', () => {
    const ahora = Date.now();
    const fila = (min: number, extra: Record<string, unknown> = {}) =>
        ({ direction: 'outbound', ai_generated: false, text_body: 'Hola cómo estás', wa_timestamp: new Date(ahora - min * 60_000).toISOString(), ...extra }) as any;
    it('una persona escribió hace 90 min → dentro de la ventana de 2 h', () => {
        expect(VENTANA_NO_INTERVENIR_MIN).toBe(120);
        expect(escuelaEscribioHace([fila(90)], VENTANA_NO_INTERVENIR_MIN, ahora)).toBe(true);
    });
    it('hace 3 h → fuera', () => {
        expect(escuelaEscribioHace([fila(180)], VENTANA_NO_INTERVENIR_MIN, ahora)).toBe(false);
    });
    it('un mensaje del bot no cuenta', () => {
        expect(escuelaEscribioHace([fila(5, { ai_generated: true })], VENTANA_NO_INTERVENIR_MIN, ahora)).toBe(false);
    });
});
