/**
 * Frases reales de prospectos que quedaron 26 h (o para siempre) sin respuesta (auditoría WhatsApp, noviembre 2026):
 * pedir información SIEMPRE abre la puerta; los negativos de siempre siguen callados.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import { intencionDeProspecto, temaEscolar } from './whatsapp-atencion.service';

describe('pide información con frases reales → el bot responde', () => {
    it.each([
        'Horarios, costos',
        'si me puedes ayudar con horarios, valores y pagos.',
        'Entre semana, como manejas los horarios? / O el sábado',
        'Quiero saber si tienes cursos de vacaciones niña de 10 años por favor',
        'Hola buenas tardes hoy tienen juego?',
    ])('sí: %s', (t) => expect(intencionDeProspecto(t)).toBe(true));
});

describe('temaEscolar reconoce los pedidos de horarios, costos y cursos', () => {
    it.each([
        'Horarios, costos',
        'si me puedes ayudar con horarios, valores y pagos.',
        'Quiero saber si tienes cursos de vacaciones niña de 10 años por favor',
    ])('inscripcion: %s', (t) => expect(temaEscolar(t, { sinFamiliaImplicita: true })).toBe('inscripcion'));
});

describe('lo que NO es pedido de información sigue callado', () => {
    it.each([
        'Pásame la info del restaurante y el precio',
        'Gracias por la información',
        'Los horarios del trabajo y los costos del viaje de fin de año los hablamos mañana en la oficina con todo el equipo',
        'Dame un minuto',
        // «Dame información» a secas NO abre la puerta: de un número sin la bienvenida del bot puede ser un contacto
        // personal (lo ve whatsapp-auditoria-2026-11-16-bot.test.ts: con la bienvenida sí recibe respuesta).
        'Dame información',
        'Hola buenas tardes',
        'No me interesa, gracias',
    ])('no: %s', (t) => expect(intencionDeProspecto(t)).toBe(false));
});
