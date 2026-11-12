/**
 * La puerta de PROSPECTO: «respóndeles a los que piden info, a los otros no».
 *
 * Los ejemplos son los mensajes reales de desconocidos que llegaron al número
 * de Dynasty (Coexistence = WhatsApp personal de la dueña) el 2026-10-05/06,
 * tal cual. Los negativos pesan tanto como los positivos: hablarle a un
 * contacto personal ya pasó dos veces y fue grave.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    intencionDeProspecto, puertaDeProspecto, soloSaludoOCortesia, buscaParaAdulto,
    interesesDeProspecto, edadMencionada, pideLlamada, pideUbicacion,
} from './whatsapp-atencion.service';
import { resumirProspecto, telefonoDeLeadWa, variantesTelefonoLead } from './whatsapp-prospecto-lead.service';

describe('intención clara de prospecto → abre la puerta', () => {
    it.each([
        'Estoy interesado en iniciar',
        'Buenos días, deseo saber horarios de esta semana para poder pasar y mirar las instalaciones',
        'Buenos días, deseo saber horarios de esta semana para poder pasar y mirar las instalaciones.',
        'Hola buenas noches cómo está, estoy interesada en inscribirme en el club',
        'Me quedaron de enviar la información por WhatsApp para agendar la clase de cortesía y no me han enviado nada',
        'Buenos días para preguntar por inscripciones al club de volleyball qué precio tiene? Horarios y a partir de qué edad?',
        'Consulta, realizan entrenamiento para niñas de 8 años (en etapa de iniciación)',
        'Consulta, realizan entrenamiento para niñas de 8 años ( en etapa de iniciación)',
        'esoty interesada',
        'Hola! Me interesa entrenar con ustedes',
        'Me interesa',
        'Nos interesa inscribir a mi hijo',
        'Necesito un lugar donde entrenar voleibol',
        'Busco dónde jugar voleibol para mi hija',
        'Quiero formar parte del equipo',
        'Me encantaría pertenecer al club',
        'Quisiera participar en sus clases',
        '¿Hay cupo para niñas de 10 años?',
        'Tienen cupos disponibles?',
        'Me llama la atención el club, ¿cómo es?',
        'Me atrae entrenar con ustedes',
        'Estoy muy motivada a entrar al club',
        'Hola buen día no dan una clase de cortesía…',
        'Hola buen día no dan una clase de cortesía quisiera llevar la niña pero ella quiere ver cómo es el entrenamiento?',
        'Disculpa para ustedes resiven menores en formación o no?',
        // Ráfaga del adulto que busca para sí mismo (2026-10-06 10:52-10:53).
        'Quiero empezar a entrenar',
        'Estoy buscando curso para adultos',
        'Estaría interesado en ingresar conmigo otra persona pero no tiene experiencia en voleibol, yo tengo algo de experiencia pero hace mucho no juego',
        'Entonces quiero saber costos y disponibilidad de días para entrenar',
        // Los que ya abrían la puerta de siempre siguen abriéndola.
        'Quisiera tener información de la academia',
        'Quiero inscribir a mi hija a volleyball',
    ])('«%s»', (texto) => {
        expect(intencionDeProspecto(texto)).toBe(true);
    });
});

describe('personal, ambiguo o de familia → NO abre la puerta', () => {
    it.each([
        'Que fastidio ese hijueputa',
        'Igual amor que ni crean que cada año van a viajar así',
        'Igual amor que ni crean que cada año van  a viajar  así',
        'Hola Aleja cómo estás',
        'Dale lo mismo',
        'Siii mi Linita',
        'Gracias don Henry',
        'Hola como estss',
        'Hola',
        'Hola buenas tardes',
        'gracias',
        'Ok gracias',
        'Stop',
        '',
        // «Mi hija tiene 14 años» SOLO no: es seguimiento (ver abajo).
        'Mi hija tiene 14 años',
        'Miércoles está bien',
        // Familias desde otro número: van por pagos, no por prospecto.
        'Mira mile mi pago de este mes',
        'Hola Mile buenas noches te envio el comprobante de octubre',
        'Buenas tardes envío comprobante de mes de isabella de 4 dias a la semana',
        // Negación y vendedores.
        'No estoy interesada, gracias',
        'No me interesa, gracias',
        'Ya no me interesa, gracias',
        'Ya no quiero entrenar',
        'No gracias',
        'Descarto la inscripción',
        'No necesito más información',
        'Desisto del cupo',
        'Me interesa saber cuánto debo de mi saldo',
        'Buenas tardes Hablas con Diana Ejecutiva Comercial del Hotel. El motivo del mensaje es ofrecer nuestros servicios de Alojamiento',
        'Colo se llamaba el restaurante',
        'Estoy más estresada',
    ])('«%s»', (texto) => {
        expect(intencionDeProspecto(texto)).toBe(false);
    });

    it('audio o imagen sin texto (null/undefined) → no', () => {
        expect(intencionDeProspecto(null)).toBe(false);
        expect(intencionDeProspecto(undefined)).toBe(false);
        expect(puertaDeProspecto(null, ['Estoy interesado en iniciar'])).toBeNull();
    });
});

describe('puertaDeProspecto: seguimiento de una conversación ya marcada', () => {
    const previos = ['.', 'Buenos días', 'Quisiera tener información de la academia'];

    it('«Mi hija tiene 14 años» después de pedir información → seguimiento', () => {
        expect(puertaDeProspecto('Mi hija tiene 14 años', previos)).toBe('seguimiento');
    });
    it('«Miércoles está bien» después de pedir la clase de cortesía → seguimiento', () => {
        expect(puertaDeProspecto('Miércoles está bien', ['Hola buen día no dan una clase de cortesía…'])).toBe('seguimiento');
    });
    it('el mismo «Mi hija tiene 14 años» SIN mensaje previo de prospecto → null', () => {
        expect(puertaDeProspecto('Mi hija tiene 14 años', ['Hola', 'Buenos días'])).toBeNull();
    });
    it('«Miércoles está bien» de una familia que recupera clase (sin prospecto previo) → null', () => {
        expect(puertaDeProspecto('Miércoles está bien, te agradezco mucho',
            ['Camí no fue a entreno el domingo, es posible q recupere la clase hoy o el miércoles?'])).toBeNull();
    });
    it.each(['Hola', 'gracias', 'Ok gracias', 'Hola buenas tardes', '👍', 'Stop'])(
        'un saludo/cierre suelto no es seguimiento: «%s»', (t) => {
            expect(puertaDeProspecto(t, previos)).toBeNull();
        });
    it('el propio mensaje con intención → prospecto', () => {
        expect(puertaDeProspecto('esoty interesada', [])).toBe('prospecto');
    });
});

describe('soloSaludoOCortesia', () => {
    it.each(['Hola', 'Hola buenas tardes', 'gracias', 'Ok gracias', 'Hola como estss', 'Stop', '🙏🏻', ''])(
        '«%s» → sí', (t) => expect(soloSaludoOCortesia(t)).toBe(true));
    it.each(['Mi hija tiene 14 años', 'Miércoles está bien', 'Hola Aleja cómo estás'])(
        '«%s» → no', (t) => expect(soloSaludoOCortesia(t)).toBe(false));
});

describe('qué pide el prospecto', () => {
    it('visita: «horarios… para pasar y mirar las instalaciones»', () => {
        const i = interesesDeProspecto('Buenos días, deseo saber horarios de esta semana para poder pasar y mirar las instalaciones.');
        expect(i).toContain('visita');
        expect(i).toContain('horarios');
    });
    it('precio, horarios, edad e inscripción en un solo mensaje', () => {
        expect(interesesDeProspecto('Buenos días para preguntar por inscripciones al club de volleyball qué precio tiene? Horarios y a partir de qué edad?'))
            .toEqual(expect.arrayContaining(['precio', 'horarios', 'edades', 'inscripcion']));
    });
    it('clase de cortesía', () => {
        expect(interesesDeProspecto('Hola buen día no dan una clase de cortesía…')).toContain('cortesia');
    });
    it('edad mencionada', () => {
        expect(edadMencionada('Mi hija tiene 14 años')).toBe(14);
        expect(edadMencionada('entrenamiento para niñas de 8 años')).toBe(8);
        expect(edadMencionada('Hola')).toBeNull();
    });
});

describe('¿busca para un adulto?', () => {
    const rafaga = [
        'Estoy interesado en iniciar',
        'Quiero empezar a entrenar',
        'Estoy buscando curso para adultos',
        'Estaría interesado en ingresar conmigo otra persona pero no tiene experiencia en voleibol, yo tengo algo de experiencia pero hace mucho no juego',
        'Entonces quiero saber costos y disponibilidad de días para entrenar',
    ];
    it('la ráfaga del adulto → sí', () => expect(buscaParaAdulto(rafaga.join('\n'))).toBe(true));
    it('«Mi hija tiene 14 años» → no', () => expect(buscaParaAdulto('Quisiera información\nMi hija tiene 14 años')).toBe(false));
    it('«para niñas de 8 años» → no', () => expect(buscaParaAdulto('realizan entrenamiento para niñas de 8 años')).toBe(false));
    // Dynasty 2026-11-08: «Para mi y tengo 15 años» es un menor, no un adulto.
    it('«Para mi y tengo 15 años» → no (un menor que pide para sí)', () => {
        expect(buscaParaAdulto('Para mi y tengo 15 años')).toBe(false);
        expect(buscaParaAdulto('Hola, quiero entrenar, tengo 16')).toBe(false);
        expect(buscaParaAdulto('yo juego y tengo 14 años')).toBe(false);
    });
    it('con edad de adulto o la palabra «adultos» sigue siendo adulto', () => {
        expect(buscaParaAdulto('Para mi, tengo 40 años')).toBe(true);
        expect(buscaParaAdulto('quiero entrenar, tengo 18 años')).toBe(true);
        expect(buscaParaAdulto('curso para adultos')).toBe(true);
        expect(buscaParaAdulto('para mi')).toBe(true);
    });
    it('pideLlamada: «regrésame la llamada», «me pueden llamar», «hablar con alguien»; no el resto', () => {
        for (const t of ['Te agradezco si me puedes regresar la llamada me gustaría hablar contigo', 'me pueden llamar?', 'Llámame por favor',
            'quiero hablar con la directora', 'necesito hablar con alguien', 'prefiero una llamada']) expect(pideLlamada(t)).toBe(true);
        for (const t of ['Hola', '¿Cuánto cuesta la mensualidad?', 'Quiero una clase de cortesía', 'Gracias', null, '']) expect(pideLlamada(t)).toBe(false);
    });
    it('pideUbicacion: «dónde queda la cancha», «la dirección», «cómo llego»; no «dónde pago»', () => {
        for (const t of ['Donde queda la cancha', '¿Dónde queda?', 'cual es la direccion', 'Me das la ubicación', 'como llego', 'donde es la clase', 'dónde entrenan'])
            expect(pideUbicacion(t)).toBe(true);
        for (const t of ['Hola', '¿Cuánto cuesta?', 'donde pago', 'donde esta mi hijo', 'quiero información', null, '']) expect(pideUbicacion(t)).toBe(false);
    });
    it('resumen del lead del adulto', () => {
        const r = resumirProspecto(rafaga);
        expect(r.adulto).toBe(true);
        expect(r.intereses).toEqual(expect.arrayContaining(['precio', 'horarios']));
    });
});

describe('teléfono del lead (mismo formato que la reserva de cortesía)', () => {
    it('celular colombiano → 10 dígitos', () => expect(telefonoDeLeadWa('573001234567')).toBe('3001234567'));
    it('extranjero → +código', () => expect(telefonoDeLeadWa('5491123456789')).toBe('+5491123456789'));
    it('extranjero cuyos últimos 10 arrancan en 3 → +código, no el celular de otro', () => {
        expect(telefonoDeLeadWa('13101234567')).toBe('+13101234567');
        expect(variantesTelefonoLead('13101234567')).toEqual(['13101234567', '+13101234567']);
    });
});
