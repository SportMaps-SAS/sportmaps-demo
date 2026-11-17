/**
 * Datos de registro de quien asiste a un servicio vendido por WhatsApp.
 * Los casos numerados son mensajes reales (Monster's Volley, noviembre de 2026).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    datosFaltantes, edadEn, leerDatosDeRegistro, resumenParaLaEscuela, textoPidiendoDatos, unirDatosDeRegistro,
    type DatosDeRegistro,
} from './whatsapp-datos-de-registro';

const HOY = '2026-11-16';
const chat = (t: string | null | undefined) => leerDatosDeRegistro(t, { hoy: HOY, fuente: 'chat' });
const nota = (t: string | null | undefined) => leerDatosDeRegistro(t, { hoy: HOY, fuente: 'nota' });
const faltan = (d: DatosDeRegistro) => datosFaltantes(d, { hoy: HOY });
const NADA: DatosDeRegistro = { nombre: null, fechaNacimiento: null, edad: null, soloEdad: false, acudiente: null, posicion: null };

const NOTA_JESUS = 'Jesús Giovanni Solarte Chala Posición: Armador Año de nacimiento: 22/06/2007 Pago: apartar el cupo con el 5% de descuento. Evento 21 y22 noviem';

describe('casos reales', () => {
    it('1. nota del comprobante con nombre, posición y fecha', () => {
        const d = nota(NOTA_JESUS);
        expect(d).toEqual({
            nombre: 'Jesús Giovanni Solarte Chala', fechaNacimiento: '2007-06-22', edad: 19, soloEdad: false,
            acudiente: null, posicion: 'armador',
        });
        expect(faltan(d)).toEqual([]);
    });

    it('2. los mismos datos en tres líneas del chat', () => {
        const d = chat('Jesús Giovanni Solarte Chala \nPosición: Armador\nAño de nacimiento: 22/06/2007');
        expect(d).toEqual({
            nombre: 'Jesús Giovanni Solarte Chala', fechaNacimiento: '2007-06-22', edad: 19, soloEdad: false,
            acudiente: null, posicion: 'armador',
        });
        expect(faltan(d)).toEqual([]);
    });

    it('3. el nombre en la segunda línea y solo la edad; las fechas del evento no son nacimiento', () => {
        const d = chat('Comparto soporte pago vacacional 2 semanas (23 de noviembre al 4 de diembre).\nGabriela Covaleda García\n13 años 6 meses');
        expect(d).toEqual({
            nombre: 'Gabriela Covaleda García', fechaNacimiento: null, edad: 13, soloEdad: true, acudiente: null, posicion: null,
        });
        expect(faltan(d)).toEqual(['fecha_nacimiento', 'acudiente']);
    });

    it('4. «La niña Gabriela Reina Fonseca»', () => {
        const d = chat('La niña Gabriela Reina Fonseca');
        expect(d).toEqual({ ...NADA, nombre: 'Gabriela Reina Fonseca' });
        expect(faltan(d)).toEqual(['fecha_nacimiento']);
    });

    it('5. nombre / fecha en letras / posición', () => {
        const d = chat('Nicolás Cubides Ávila / 18 de Diciembre del 2006 / Opuesto');
        expect(d).toEqual({
            nombre: 'Nicolás Cubides Ávila', fechaNacimiento: '2006-12-18', edad: 19, soloEdad: false,
            acudiente: null, posicion: 'opuesto',
        });
        expect(faltan(d)).toEqual([]);
    });

    it.each([
        'Ya pagué', 'Buenas tardes', 'Pago 2 semanas',
        '2 semanas: del 23al 27 de noviembre y del 30 de noviembre al 04 de diciembre',
        'Sede Suba', 'Separar mi cupo', 'Hola cómo estás',
        'Por favor los datos puestos en el comprobante deben ser escritos por acá muchas gracias',
    ])('6. no son datos: «%s»', (t) => {
        expect(chat(t)).toEqual(NADA);
        expect(nota(t)).toEqual(NADA);
    });

    it('7. «Soy Brady Luz, la mamá de Gabriela…»: quien escribe es el acudiente', () => {
        const d = chat('Soy Brady Luz, la mamá de Gabriela Covaleda García, tiene 13 años');
        expect(d).toEqual({
            nombre: 'Gabriela Covaleda García', fechaNacimiento: null, edad: 13, soloEdad: true,
            acudiente: 'Brady Luz', posicion: null,
        });
        expect(faltan(d)).toEqual(['fecha_nacimiento']);
    });

    it('8. dos nombres sin marca: no decide', () => {
        expect(chat('Juan Pérez Gómez\nMaría López Ruiz').nombre).toBeNull();
        expect(chat('Juan Pérez Gómez, María López Ruiz').nombre).toBeNull();
        expect(chat('Juan Pérez Gómez / María López Ruiz').nombre).toBeNull();
    });

    it('9. unir: la nota con un chat vacío; y el nombre de un mensaje con la fecha de otro', () => {
        const a = unirDatosDeRegistro(nota(NOTA_JESUS), chat(''));
        expect(a.nombre).toBe('Jesús Giovanni Solarte Chala');
        expect(faltan(a)).toEqual([]);

        const b = unirDatosDeRegistro(chat('La niña Gabriela Reina Fonseca'), chat('3 de mayo de 2014'));
        expect(b).toEqual({
            nombre: 'Gabriela Reina Fonseca', fechaNacimiento: '2014-05-03', edad: 12, soloEdad: false,
            acudiente: null, posicion: null,
        });
        expect(faltan(b)).toEqual(['acudiente']);
    });
});

describe('nombre', () => {
    it('mayúsculas sostenidas, emojis y negrita de WhatsApp', () => {
        expect(chat('GABRIELA COVALEDA GARCÍA').nombre).toBe('Gabriela Covaleda García');
        expect(chat('🙌 Gabriela Covaleda García 🏐').nombre).toBe('Gabriela Covaleda García');
        expect(chat('*Gabriela Covaleda García*\n13 años').nombre).toBe('Gabriela Covaleda García');
        expect(chat('María de los Ángeles Peña').nombre).toBe('María de los Ángeles Peña');
    });

    it('con marca en cualquier parte del texto', () => {
        expect(chat('Buenas tardes, envío el pago a nombre de Laura Gómez Ruiz').nombre).toBe('Laura Gómez Ruiz');
        expect(chat('Listo ya pagué\nNombre: Laura Gómez Ruiz').nombre).toBe('Laura Gómez Ruiz');
        expect(chat('Es para mi hijo Samuel Torres Díaz').nombre).toBe('Samuel Torres Díaz');
        expect(chat('Participante: Samuel Torres Díaz').nombre).toBe('Samuel Torres Díaz');
        expect(chat('el niño se llama Samuel Torres').nombre).toBe('Samuel Torres');
    });

    it('la marca gana sobre un nombre suelto', () => {
        const d = chat('Carlos Torres Mejía\nLa niña Sara Torres Díaz');
        expect(d.nombre).toBe('Sara Torres Díaz');
    });

    it('dos marcas con nombres distintos: no decide', () => {
        expect(chat('mi hijo Samuel Torres Díaz\nmi hija Sara Torres Díaz').nombre).toBeNull();
    });

    it('el mismo nombre repetido, o uno más corto, es un solo candidato', () => {
        expect(chat('Gabriela Covaleda\nGabriela Covaleda García').nombre).toBe('Gabriela Covaleda García');
    });

    it('«Soy …» en una línea y quien asiste en otra', () => {
        const d = chat('Soy Brady Luz\nGabriela Covaleda García\n13 años');
        expect(d.nombre).toBe('Gabriela Covaleda García');
        expect(d.acudiente).toBe('Brady Luz');
    });

    it('«Soy …» solo: es quien asiste', () => {
        const d = chat('Soy Nicolás Cubides Ávila, tengo 19 años');
        expect(d.nombre).toBe('Nicolás Cubides Ávila');
        expect(d.acudiente).toBeNull();
        expect(d.edad).toBe(19);
    });

    it('nombre seguido de un dato en una línea que no es la primera', () => {
        const d = chat('Buenas tardes\nGabriela Covaleda García 13 años');
        expect(d.nombre).toBe('Gabriela Covaleda García');
        expect(d.edad).toBe(13);
    });

    it('una frase en una línea que no es la primera no es un nombre', () => {
        expect(chat('Buenas tardes\nQuedamos atentos entonces').nombre).toBeNull();
        expect(chat('Mucho gusto').nombre).toBeNull();
        expect(chat('Dios los bendiga').nombre).toBeNull();
        expect(chat('¿Gabriela Covaleda García ya quedó inscrita?').nombre).toBeNull();
    });

    it('el documento no es parte del nombre; dos personas unidas con «y» no se deciden', () => {
        expect(chat('Sara Torres Díaz cc 1012345678').nombre).toBe('Sara Torres Díaz');
        expect(chat('Sara Torres Díaz T.I. 1012345678').nombre).toBe('Sara Torres Díaz');
        expect(chat('Daniela y Sara Torres Díaz').nombre).toBeNull();
    });

    it('tras un saludo o un «listo» con coma', () => {
        expect(chat('Listo, Sara Torres Díaz').nombre).toBe('Sara Torres Díaz');
        expect(chat('Buenas tardes, Sara Torres Díaz').nombre).toBe('Sara Torres Díaz');
        expect(chat('Hola, mucho gusto').nombre).toBeNull();
    });

    it('lista numerada: el número de la lista no se mezcla con la fecha', () => {
        const d = chat('1. Sara Torres Díaz\n2. 03/05/2014\n3. Luz Díaz Mora');
        expect(d.fechaNacimiento).toBe('2014-05-03');
        expect(d.nombre).toBeNull(); // dos nombres sin marca: no se decide cuál es el acudiente
        const e = chat('1. Sara Torres Díaz\n2. 03/05/2014\n3. Mamá: Luz Díaz Mora');
        expect(e).toEqual({
            nombre: 'Sara Torres Díaz', fechaNacimiento: '2014-05-03', edad: 12, soloEdad: false,
            acudiente: 'Luz Díaz Mora', posicion: null,
        });
    });

    it('una sola palabra no es el nombre completo', () => {
        expect(chat('Gabriela').nombre).toBeNull();
        expect(chat('La niña Gabriela').nombre).toBeNull();
    });

    it('en la nota: un nombre entre otras palabras solo vale con otro dato o con marca', () => {
        expect(nota('Gabriela Covaleda García').nombre).toBe('Gabriela Covaleda García');
        expect(nota('Pago vacacional Gabriela Covaleda García').nombre).toBe('Gabriela Covaleda García');
        expect(nota('Ivan Felipe Sossa Benitez\nNequi 3194505150').nombre).toBeNull();
        expect(nota('Ivan Felipe Sossa gracias por todo').nombre).toBeNull();
        expect(nota('Gabriela Covaleda García\n13 años').nombre).toBe('Gabriela Covaleda García');
        expect(nota('Transferencia exitosa\nA nombre de Gabriela Covaleda García').nombre).toBe('Gabriela Covaleda García');
    });

    it('texto de 500 caracteres: encuentra la línea del nombre y no revienta', () => {
        const relleno = 'Buenas tardes, les escribo porque ya hice el pago del vacacional y quería confirmar que todo quedó bien. '.repeat(4);
        const t = `${relleno}\nGabriela Covaleda García\n13 anos`;
        expect(t.length).toBeGreaterThan(400);
        const d = chat(t);
        expect(d.nombre).toBe('Gabriela Covaleda García');
        expect(d.edad).toBe(13);
        expect(chat('x'.repeat(500))).toEqual(NADA);
    });

    it('vacío, null y hoy inválido', () => {
        expect(chat(null)).toEqual(NADA);
        expect(chat('   ')).toEqual(NADA);
        expect(leerDatosDeRegistro('Gabriela Covaleda García', { hoy: 'ayer', fuente: 'chat' })).toEqual(NADA);
    });
});

describe('fecha de nacimiento', () => {
    it.each([
        ['22/06/2007', '2007-06-22'],
        ['22-06-2007', '2007-06-22'],
        ['22.06.2007', '2007-06-22'],
        ['22 de junio de 2007', '2007-06-22'],
        ['22 junio 2007', '2007-06-22'],
        ['22 de JUNIO del 2007', '2007-06-22'],
        ['2007-06-22', '2007-06-22'],
        ['Año de nacimiento: 22/06/2007', '2007-06-22'],
        ['nació el 3 de mayo del 2012', '2012-05-03'],
        ['Fecha de nacimiento 3/5/2012', '2012-05-03'],
        ['junio 22 de 2007', '2007-06-22'],
        ['22/06/07', '2007-06-22'],
        ['22/06/85', '1985-06-22'],
        ['22 06 2007', '2007-06-22'],
    ])('«%s» → %s', (t, iso) => {
        const d = chat(t);
        expect(d.fechaNacimiento).toBe(iso);
        expect(d.soloEdad).toBe(false);
        expect(d.edad).toBe(edadEn(iso, HOY));
    });

    it.each([
        '31/02/2007', '22/13/2007', '00/06/2007',     // imposibles
        '22/06/2030', '17/11/2026',                    // futuras
        '22/06/1930',                                  // más de 90 años
        '15/11/2026', 'Pago del 10 de noviembre de 2026', // la fecha del pago
        'del 23 al 27 de noviembre', '21 y 22 de noviembre', '21 y 22 de noviembre de 2026', // el evento
        '23 de noviembre 04 de diciembre',
    ])('no es fecha de nacimiento: «%s»', (t) => {
        expect(chat(t).fechaNacimiento).toBeNull();
    });

    it('con marca de nacimiento vale aunque sea un bebé; sin marca, no', () => {
        expect(chat('nació el 02/03/2025').fechaNacimiento).toBe('2025-03-02');
        expect(chat('02/03/2025').fechaNacimiento).toBeNull();
    });

    it('la fecha del evento no tapa la de nacimiento', () => {
        const d = chat('Vacacional del 23 de noviembre de 2026\nSara Torres Díaz\nnació el 3 de mayo de 2014');
        expect(d.fechaNacimiento).toBe('2014-05-03');
        expect(d.nombre).toBe('Sara Torres Díaz');
    });

    it('un año suelto no es fecha: edad aproximada y solo edad', () => {
        for (const t of ['2007', 'año 2007', 'Año de nacimiento: 2007', 'categoría 2007', 'es del 2007']) {
            expect(chat(t)).toEqual({ ...NADA, edad: 19, soloEdad: true });
        }
        expect(chat('año 2026')).toEqual(NADA);
        expect(chat('Referencia 2007 del pago')).toEqual(NADA);
    });

    it('cumple años después de hoy: todavía no los tiene', () => {
        expect(chat('18/12/2006').edad).toBe(19);
        expect(chat('16/11/2008').edad).toBe(18);
        expect(chat('17/11/2008').edad).toBe(17);
        expect(edadEn('2008-11-17', HOY)).toBe(17);
        expect(edadEn('no', HOY)).toBeNull();
    });
});

describe('edad', () => {
    it.each([
        ['13 años', 13], ['13 años 6 meses', 13], ['tiene 13', 13], ['de 13 añitos', 13], ['13 anos', 13],
        ['13años', 13], ['Edad: 9', 9], ['tengo 25 AÑOS', 25],
    ])('«%s» → %i', (t, n) => {
        expect(chat(t)).toEqual({ ...NADA, edad: n, soloEdad: true });
    });

    it.each(['2 años', '95 años', 'tiene 2 semanas', 'tiene 3 hijos', 'lleva 5 años jugando', '4 años de experiencia', 'hace 3 años', 'son 140 mil'])(
        'no es la edad: «%s»', (t) => {
            expect(chat(t).edad).toBeNull();
        });

    it('con fecha y edad dicha, manda la fecha', () => {
        const d = chat('Sara Torres Díaz, 11 años, 3 de mayo de 2014');
        expect(d.edad).toBe(12);
        expect(d.soloEdad).toBe(false);
    });
});

describe('acudiente', () => {
    it.each([
        ['Acudiente: Brady Luz', 'Brady Luz'],
        ['mamá: Brady Luz Covaleda', 'Brady Luz Covaleda'],
        ['Papá: Carlos Torres', 'Carlos Torres'],
        ['Responsable: Carlos Torres', 'Carlos Torres'],
        ['Nombre del acudiente: Carlos Torres', 'Carlos Torres'],
        ['La mamá se llama Brady Luz', 'Brady Luz'],
        ['Soy su mamá, Brady Luz', 'Brady Luz'],
    ])('«%s»', (t, quien) => {
        const d = chat(t);
        expect(d.acudiente).toBe(quien);
        expect(d.nombre).toBeNull();
    });

    it('acudiente y asistente en el mismo mensaje', () => {
        const d = chat('Gabriela Covaleda García\n10/05/2013\nAcudiente: Brady Luz');
        expect(d).toEqual({
            nombre: 'Gabriela Covaleda García', fechaNacimiento: '2013-05-10', edad: 13, soloEdad: false,
            acudiente: 'Brady Luz', posicion: null,
        });
        expect(faltan(d)).toEqual([]);
        expect(chat('Gabriela Covaleda García, acudiente: Brady Luz').nombre).toBe('Gabriela Covaleda García');
    });

    it('«soy la mamá de …» da el nombre de quien asiste, no el del acudiente', () => {
        const d = chat('Hola, soy la mamá de Gabriela Covaleda García');
        expect(d.nombre).toBe('Gabriela Covaleda García');
        expect(d.acudiente).toBeNull();
    });

    it('una frase con «responsable» no es un acudiente', () => {
        expect(chat('La persona responsable debe firmar').acudiente).toBeNull();
    });
});

describe('posición', () => {
    it.each([
        ['Posición: Armadora', 'armador'], ['juega de opuesta', 'opuesto'], ['LÍBERO', 'libero'], ['Central', 'central'],
        ['punta', 'punta'], ['Receptora', 'receptor'], ['atacante', 'atacante'], ['levantadora', 'levantador'],
    ])('«%s» → %s', (t, pos) => {
        expect(chat(t).posicion).toBe(pos);
    });

    it('el nombre del servicio y la sede no son la posición', () => {
        expect(chat('Clínica de armadores y atacantes').posicion).toBeNull();
        expect(chat('Sede Central').posicion).toBeNull();
    });
});

describe('unirDatosDeRegistro', () => {
    it('la primera que trae cada dato gana', () => {
        const u = unirDatosDeRegistro(
            null, { nombre: 'Ana Ruiz Díaz' }, { nombre: 'Otra Persona', posicion: 'punta' }, undefined, { posicion: 'central' },
        );
        expect(u).toEqual({ ...NADA, nombre: 'Ana Ruiz Díaz', posicion: 'punta' });
    });

    it('la edad sale de la lectura que trae la fecha, aunque otra haya dicho la edad antes', () => {
        const u = unirDatosDeRegistro(chat('Sara Torres Díaz 11 años'), chat('3 de mayo de 2014'));
        expect(u).toEqual({ ...NADA, nombre: 'Sara Torres Díaz', fechaNacimiento: '2014-05-03', edad: 12 });
    });

    it('sin fecha en ninguna: solo edad', () => {
        expect(unirDatosDeRegistro(chat('Hola'), chat('tiene 13'))).toEqual({ ...NADA, edad: 13, soloEdad: true });
        expect(unirDatosDeRegistro()).toEqual(NADA);
    });
});

describe('datosFaltantes', () => {
    it('sin nada: nombre y fecha; el acudiente todavía no', () => {
        expect(faltan(NADA)).toEqual(['nombre', 'fecha_nacimiento']);
    });

    it('menor por fecha o por edad pide acudiente; adulto no', () => {
        expect(faltan({ ...NADA, nombre: 'Ana Ruiz', fechaNacimiento: '2014-05-03', edad: 12 })).toEqual(['acudiente']);
        expect(faltan({ ...NADA, nombre: 'Ana Ruiz', edad: 17, soloEdad: true })).toEqual(['fecha_nacimiento', 'acudiente']);
        expect(faltan({ ...NADA, nombre: 'Ana Ruiz', edad: 18, soloEdad: true })).toEqual(['fecha_nacimiento']);
        expect(faltan({ ...NADA, nombre: 'Ana Ruiz', edad: 12, soloEdad: true, acudiente: 'Luz Díaz' })).toEqual(['fecha_nacimiento']);
    });

    it('la mayoría de edad se calcula con `hoy`, no con la edad guardada', () => {
        const d = { ...NADA, nombre: 'Ana Ruiz', fechaNacimiento: '2008-11-17', edad: 17 };
        expect(datosFaltantes(d, { hoy: '2026-11-16' })).toEqual(['acudiente']);
        expect(datosFaltantes(d, { hoy: '2026-11-17' })).toEqual([]);
    });
});

describe('textoPidiendoDatos', () => {
    const SERVICIO = 'Clínica de armadores y atacantes';

    it('falta todo, con comprobante', () => {
        expect(textoPidiendoDatos(['nombre', 'fecha_nacimiento'], { servicio: SERVICIO, conComprobante: true })).toBe(
            'Recibí tu comprobante 📄 Para completar la inscripción a *Clínica de armadores y atacantes* necesito estos datos de quien asiste:\n' +
            '1. Nombre completo\n2. Fecha de nacimiento (día/mes/año)\n' +
            'Si es menor de edad, también el nombre de la persona responsable.\nPuedes escribirlos en un solo mensaje.');
    });

    it('falta todo, sin comprobante', () => {
        const t = textoPidiendoDatos(['nombre', 'fecha_nacimiento'], { servicio: SERVICIO, conComprobante: false });
        expect(t.startsWith('Para completar la inscripción a *Clínica de armadores y atacantes*')).toBe(true);
        expect(t).not.toContain('comprobante');
    });

    it('ya anotó el nombre: confirma y pide solo lo que falta', () => {
        const anotado = chat('Gabriela Covaleda García\n13 años');
        const t = textoPidiendoDatos(faltan(anotado), { servicio: SERVICIO, conComprobante: false, anotado });
        expect(t).toBe(
            'Anoté a *Gabriela Covaleda García* 🙌 Solo me falta para completar la inscripción a *Clínica de armadores y atacantes*:\n' +
            '1. Fecha de nacimiento (día/mes/año)\n2. Nombre de la persona responsable (mamá, papá o acudiente)\n' +
            'Puedes escribirlos en un solo mensaje.');
    });

    it('un solo dato: sin lista', () => {
        const anotado = chat('La niña Gabriela Reina Fonseca');
        expect(textoPidiendoDatos(faltan(anotado), { servicio: SERVICIO, conComprobante: true, anotado })).toBe(
            'Anoté a *Gabriela Reina Fonseca* y recibí tu comprobante 🙌 Solo me falta la fecha de nacimiento (día/mes/año) ' +
            'para completar la inscripción a *Clínica de armadores y atacantes*.\n' +
            'Si es menor de edad, también el nombre de la persona responsable.');
        const adulto = { ...NADA, nombre: 'Ana Ruiz', edad: 25, soloEdad: true };
        expect(textoPidiendoDatos(faltan(adulto), { servicio: SERVICIO, conComprobante: false, anotado: adulto }))
            .not.toContain('menor de edad');
        expect(textoPidiendoDatos(['acudiente'], { servicio: SERVICIO, conComprobante: false, anotado: { ...NADA, nombre: 'Ana Ruiz', edad: 12 } }))
            .toContain('Solo me falta el nombre de la persona responsable (mamá, papá o acudiente), porque es menor de edad');
        expect(textoPidiendoDatos(['nombre'], { servicio: SERVICIO, conComprobante: true }))
            .toBe('Recibí tu comprobante 📄 Para completar la inscripción a *Clínica de armadores y atacantes* solo me falta el nombre completo de quien asiste.');
    });

    it('no falta nada: cadena vacía', () => {
        expect(textoPidiendoDatos([], { servicio: SERVICIO, conComprobante: true })).toBe('');
    });

    it('nunca pasa de ~450 caracteres, no promete cupo y no pide documento', () => {
        const combos: Parameters<typeof textoPidiendoDatos>[0][] = [
            ['nombre'], ['fecha_nacimiento'], ['acudiente'], ['nombre', 'fecha_nacimiento'], ['fecha_nacimiento', 'acudiente'],
            ['nombre', 'fecha_nacimiento', 'acudiente'], ['acudiente', 'nombre'],
        ];
        const largo = 'Vacacional de voleibol de fin de año para niños, niñas y jóvenes de todas las categorías — Sede Suba y Sede Norte';
        for (const combo of combos) {
            for (const conComprobante of [true, false]) {
                for (const anotado of [null, { ...NADA, nombre: 'María de los Ángeles Covaleda García Fonseca' }]) {
                    const t = textoPidiendoDatos(combo, { servicio: largo, conComprobante, anotado });
                    expect(t.length).toBeGreaterThan(0);
                    expect(t.length).toBeLessThanOrEqual(450);
                    expect(t).not.toMatch(/cupo|documento|c[eé]dula|tarjeta de identidad/i);
                }
            }
        }
    });
});

describe('resumenParaLaEscuela', () => {
    it('con lo que falta', () => {
        const d = chat('Soy Brady Luz, la mamá de Gabriela Covaleda García, tiene 13 años');
        expect(resumenParaLaEscuela(d, faltan(d)))
            .toBe('Gabriela Covaleda García · 13 años (sin fecha) · acudiente: Brady Luz · falta: fecha de nacimiento');
    });

    it('completo, con posición', () => {
        const d = nota(NOTA_JESUS);
        expect(resumenParaLaEscuela(d, faltan(d))).toBe('Jesús Giovanni Solarte Chala · 19 años (22/06/2007) · posición: armador');
    });

    it('sin nada', () => {
        expect(resumenParaLaEscuela(NADA, faltan(NADA))).toBe('Sin nombre · falta: nombre completo, fecha de nacimiento');
    });
});
