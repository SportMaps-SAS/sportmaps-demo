/**
 * Auditoría de conversaciones reales de producción (8–16 nov 2026): la clase de cortesía.
 * El motor del flujo con un contexto falso (sin red ni base), como whatsapp-clase-cortesia.test.ts.
 *
 *  1. Una pregunta tomada como nombre: «✅ ¡Listo! Quedó reservada la clase de cortesía de
 *     *Que Precios Manejas Podrías Darme Más Información*».
 *  3. «19 años / 26/07/07» → «No te entendí la edad»; y la edad ya dicha se volvía a pedir.
 *  4. «Cambiar» borraba todo y volvía a pedir nombre y acudiente.
 *  5. Una pregunta a mitad de elegir horario repetía la lista.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./avisos-correo.service', () => ({ destinatariosDeEscuela: vi.fn(), enviarConReserva: vi.fn() }));
// La clase de prueba ABIERTA, sin ofertas ni bloqueos (bot-ofertas.service): lo de siempre. Sin esto, con
// Supabase vacío el servicio falla cerrado y no se ofrecería la clase. Lo cerrado: whatsapp-clase-cortesia-ofertas.test.ts.
vi.mock('./bot-ofertas.service', async (importOriginal) => {
    const real = await importOriginal<typeof import('./bot-ofertas.service')>();
    return {
        ...real,
        estadoDeOfertas: async (schoolId: string, ahora?: number) => real.armarEstado(schoolId,
            { ofertas: [], sesiones: [], bloqueos: [], ajustesClasePrueba: null, mensajeSinOfertas: null }, ahora),
    };
});

import {
    atenderTurnoCortesia, nombreValido, pareceConsultaNoNombre, leerEdad, edadDichaAntes, recordatorioDePasoCortesia,
    BOTON_CC, type CtxCortesia, type EstadoCortesia, type FranjaCortesia, type ResultadoReserva,
} from './whatsapp-clase-cortesia.service';

// Lunes 16 de noviembre de 2026, 10:00 a. m. en Bogotá.
const AHORA = new Date('2026-11-16T15:00:00Z');

const F = (id: string, fecha: string, hora: string, grupo = 'Juvenil'): FranjaCortesia => ({
    id, grupo, fecha, horaInicio: hora, horaFin: '18:30', sede: 'Coliseo', cupos: 5,
});
const FRANJAS = [F('f1', '2026-11-18', '16:00'), F('f2', '2026-11-19', '16:00'), F('f3', '2026-11-21', '09:00')];

interface Enviado { texto: string; step: string; estado: EstadoCortesia | null; botones?: any[] }

function armar(op: { estado?: EstadoCortesia | null; previos?: string[]; rafaga?: string | null } = {}) {
    const enviados: Enviado[] = [];
    const soltados: EstadoCortesia[] = [];
    let estado: EstadoCortesia | null = op.estado ?? null;
    const reservar = vi.fn(async () => ({ ok: true, leadId: 'lead-1', duplicado: false, conCupo: true }) as ResultadoReserva);
    const ctx: CtxCortesia = {
        conversationId: 'conv-1', schoolId: 'school-1', contactWaId: '573001112233',
        rafaga: op.rafaga ?? null,
        enviar: async (texto, step, est, botones) => { enviados.push({ texto, step, estado: est, botones }); estado = est; },
        leerEstado: async () => estado,
        franjas: async () => FRANJAS,
        reservaVigente: async () => null,
        reservar,
        cancelar: vi.fn(async () => ({ ok: true as const, franja: null })),
        avisarEscuela: vi.fn(async () => {}),
        indicaciones: async () => null,
        textosPrevios: async () => op.previos ?? [],
        alSoltar: (e) => { soltados.push(e); },
        ahora: () => AHORA,
    };
    return {
        ctx, enviados, soltados, reservar,
        turno: (texto: string, botonId: string | null = null) => atenderTurnoCortesia(ctx, texto, botonId),
        ultimo: () => enviados[enviados.length - 1],
        estado: () => estado,
    };
}

const EN_NOMBRE: EstadoCortesia = { paso: 'nombre', datos: { franja: FRANJAS[0], lista: ['f1', 'f2', 'f3'], intentos: 0 } };

describe('1. una pregunta no es un nombre', () => {
    it('«Que Precios Manejas Podrías Darme Más Información» no es un nombre', () => {
        expect(nombreValido('Que Precios Manejas Podrías Darme Más Información')).toBeNull();
        for (const t of [
            'Que precios manejas podrías darme más información', 'Me equivoqué de sede', 'Cuánto cuesta la mensualidad',
            'Quiero saber los horarios', 'Podrías darme más información', 'Tienen clases los sábados', 'Manejan categoría juvenil',
            'Dónde queda la sede', 'Cómo es el pago', 'Cuál es el valor', 'Cuando empiezan', 'Quisiera inscribir a mi hija',
            'Puedes mandarme la info', 'www.plusgami.store', 'Y son principiantes',
        ]) {
            expect(pareceConsultaNoNombre(t), t).toBe(true);
            expect(nombreValido(t), t).toBeNull();
        }
    });

    it('los nombres de verdad siguen pasando', () => {
        for (const [t, esperado] of [
            ['Jeronimo Ruiz', 'Jeronimo Ruiz'], ['mercedes díaz', 'Mercedes Díaz'], ['Danna Valentina Pérez', 'Danna Valentina Pérez'],
            ['Yolanda Meneses', 'Yolanda Meneses'], ['Noelia Quintero', 'Noelia Quintero'], ['Paula Comas', 'Paula Comas'],
        ] as const) {
            expect(pareceConsultaNoNombre(t), t).toBe(false);
            expect(nombreValido(t), t).toBe(esperado);
        }
    });

    it('en la pregunta del nombre, la consulta NO reserva ni avanza: se suelta para que la conteste el bot y se recuerde el paso', async () => {
        const c = armar({ estado: EN_NOMBRE });
        const atendido = await c.turno('Que Precios Manejas Podrías Darme Más Información');
        expect(atendido).toBe(false);
        expect(c.enviados).toHaveLength(0);
        expect(c.reservar).not.toHaveBeenCalled();
        expect(c.soltados).toEqual([EN_NOMBRE]);
        // El paso sigue pendiente: el nombre que llegue después se toma.
        expect(await c.turno('Jeronimo Ruiz')).toBe(true);
        expect(c.ultimo().step).toBe('cortesia_edad');
        expect(c.ultimo().texto).toContain('Jeronimo');
    });

    it('el recordatorio del paso sale una vez por paso', () => {
        const r = recordatorioDePasoCortesia(EN_NOMBRE);
        expect(r?.texto).toBe('Cuando quieras seguimos con tu clase de cortesía 🙌 ¿Cuál es el *nombre completo* de quien va a tomar la clase?');
        expect(recordatorioDePasoCortesia({ paso: 'nombre', datos: { ...EN_NOMBRE.datos, recordado: 'nombre' } })).toBeNull();
        // En otro paso sí vuelve a salir.
        expect(recordatorioDePasoCortesia({ paso: 'edad', datos: { ...EN_NOMBRE.datos, nombre: 'Jeronimo Ruiz', recordado: 'nombre' } })?.texto)
            .toContain('¿Qué *edad* tiene Jeronimo?');
        expect(recordatorioDePasoCortesia({ paso: 'elegir_franja', datos: { lista: ['f1'] } })?.texto)
            .toContain('Elige tu horario en la lista de arriba');
    });
});

describe('3. la edad', () => {
    it('«19 años / 26/07/07»: la fecha con el año en dos dígitos', () => {
        expect(leerEdad('19 años / 26/07/07', AHORA)).toEqual({ edad: 19, fechaNacimiento: '2007-07-26' });
        expect(leerEdad('26/07/07', AHORA)).toEqual({ edad: 19, fechaNacimiento: '2007-07-26' });
    });

    it('la edad dentro de un texto', () => {
        expect(leerEdad('tiene 13 años', AHORA)?.edad).toBe(13);
        expect(leerEdad('13 años 6 meses', AHORA)?.edad).toBe(13);
        expect(leerEdad('Para mí y tengo 15 años', AHORA)?.edad).toBe(15);
        expect(leerEdad('Categoría juvenil - mayores 2007', AHORA)?.edad).toBe(19);
        expect(leerEdad('Tiene 13 años / Para la otra semana', AHORA)?.edad).toBe(13);
    });

    it('lo de siempre sigue igual, y lo que no es una edad sigue sin serlo', () => {
        expect(leerEdad('12', AHORA)).toEqual({ edad: 12, fechaNacimiento: null });
        expect(leerEdad('15/03/2014', AHORA)).toEqual({ edad: 12, fechaNacimiento: '2014-03-15' });
        expect(leerEdad('31/02/2014', AHORA)).toBeNull();
        expect(leerEdad('no sé', AHORA)).toBeNull();
        expect(leerEdad('cuánto vale', AHORA)).toBeNull();
    });

    it('en la pregunta de la edad, «19 años / 26/07/07» ya no recibe «No te entendí la edad»', async () => {
        const c = armar({ estado: { paso: 'edad', datos: { franja: FRANJAS[0], nombre: 'Laura Peña', intentos: 0 } } });
        await c.turno('19 años / 26/07/07');
        expect(c.ultimo().step).toBe('cortesia_confirmar');
        expect(c.ultimo().texto).toContain('*Laura Peña* (19 años)');
        expect(c.ultimo().texto).not.toMatch(/no te entend/i);
    });

    it('la edad que ya dijo antes en la conversación', () => {
        expect(edadDichaAntes(['Hola', 'Para mi y tengo 15 años', 'el miércoles'], AHORA)).toEqual({ edad: 15, fechaNacimiento: null });
        expect(edadDichaAntes(['Categoría juvenil - mayores 2007'], AHORA)).toEqual({ edad: 19, fechaNacimiento: null });
        // Gana lo más reciente; un número suelto («2», la opción que eligió) no es una edad.
        expect(edadDichaAntes(['mi hija tiene 12 años', 'perdón, tiene 14', '2'], AHORA)?.edad).toBe(14);
        expect(edadDichaAntes(['Hola', '2', 'el sábado'], AHORA)).toBeNull();
    });

    it('«Para mi y tengo 15 años» dicho antes → ya no pregunta «¿Qué edad tiene Jeronimo?»', async () => {
        const c = armar({ estado: EN_NOMBRE, previos: ['Hola quiero una clase de cortesía', 'Para mi y tengo 15 años'] });
        await c.turno('Jeronimo Ruiz');
        expect(c.enviados.map((e) => e.texto).join('\n')).not.toMatch(/Qué \*edad\* tiene/);
        // Menor de edad: lo que sigue es el acudiente.
        expect(c.ultimo().step).toBe('cortesia_acudiente');
        expect(c.estado()?.datos).toMatchObject({ nombre: 'Jeronimo Ruiz', edad: 15 });
    });

    it('«Categoría juvenil - mayores 2007» dicho antes → ya no pregunta «¿Qué edad tiene Danna?»', async () => {
        const c = armar({ estado: EN_NOMBRE, previos: ['Categoría juvenil - mayores 2007'] });
        await c.turno('Danna Pérez');
        expect(c.ultimo().step).toBe('cortesia_confirmar');
        expect(c.ultimo().texto).toContain('*Danna Pérez* (19 años)');
    });

    it('sin haberla dicho, se sigue preguntando', async () => {
        const c = armar({ estado: EN_NOMBRE, previos: ['Hola', 'quiero una clase'] });
        await c.turno('Danna Pérez');
        expect(c.ultimo().step).toBe('cortesia_edad');
    });
});

describe('4. «Cambiar» cambia el horario y conserva los datos', () => {
    const EN_CONFIRMAR: EstadoCortesia = {
        paso: 'confirmar',
        datos: { franja: FRANJAS[0], lista: ['f1', 'f2', 'f3'], nombre: 'Mariana Gómez', edad: 12, fechaNacimiento: '2014-03-15', acudiente: 'Carolina Ruiz', intentos: 0 },
    };

    it('el botón «Cambiar» vuelve a ofrecer los horarios sin borrar nombre, edad ni acudiente', async () => {
        const c = armar({ estado: EN_CONFIRMAR });
        await c.turno('Cambiar', BOTON_CC.CAMBIAR);
        expect(c.ultimo().step).toBe('cortesia_ofrecer');
        expect(c.ultimo().texto).toContain('Listo, cambiemos el horario 🙌 Tus datos quedan guardados. Elige el nuevo:');
        expect(c.estado()).toMatchObject({
            paso: 'elegir_franja',
            datos: { nombre: 'Mariana Gómez', edad: 12, fechaNacimiento: '2014-03-15', acudiente: 'Carolina Ruiz' },
        });
    });

    it('al elegir el horario nuevo va directo al resumen: no vuelve a pedir nombre ni acudiente', async () => {
        const c = armar({ estado: EN_CONFIRMAR });
        await c.turno('Cambiar', BOTON_CC.CAMBIAR);
        await c.turno('', `${BOTON_CC.FRANJA}f2`);
        expect(c.ultimo().step).toBe('cortesia_confirmar');
        expect(c.ultimo().texto).toContain('*Mariana Gómez* (12 años)');
        expect(c.ultimo().texto).toContain('Acudiente: *Carolina Ruiz*');
        expect(c.enviados.map((e) => e.step)).not.toContain('cortesia_nombre');
        expect(c.enviados.map((e) => e.step)).not.toContain('cortesia_acudiente');
        // Y confirma con el horario nuevo.
        await c.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(c.reservar).toHaveBeenCalledWith(expect.objectContaining({ franjaId: 'f2', nombre: 'Mariana Gómez', edad: 12, acudiente: 'Carolina Ruiz' }));
    });

    it('cuatro veces «Cambiar» seguidas (lo que le pasó a una persona): nunca vuelve a pedir el nombre', async () => {
        const c = armar({ estado: EN_CONFIRMAR });
        for (const f of ['f2', 'f3', 'f1', 'f2']) {
            await c.turno('cambiar');
            await c.turno('', `${BOTON_CC.FRANJA}${f}`);
            expect(c.ultimo().step).toBe('cortesia_confirmar');
        }
        expect(c.enviados.map((e) => e.step)).not.toContain('cortesia_nombre');
    });

    it('«corregir datos» sí vuelve a pedirlos, con el horario elegido, y pregunta la edad de nuevo', async () => {
        const c = armar({ estado: EN_CONFIRMAR, previos: ['mi hija tiene 12 años'] });
        await c.turno('corregir datos');
        expect(c.ultimo().step).toBe('cortesia_nombre');
        expect(c.estado()?.datos.franja?.id).toBe('f1');
        await c.turno('Mariana Gómez Rojas');
        expect(c.ultimo().step).toBe('cortesia_edad');
    });
});

describe('5. una pregunta a mitad de elegir horario no repite la lista', () => {
    const EN_FRANJA: EstadoCortesia = { paso: 'elegir_franja', datos: { lista: ['f1', 'f2', 'f3'], desde: 0, intentos: 0 } };

    it('«Y son principiantes», «Oye una pregunta», «Que cuesta»: se sueltan (las contesta el bot) y no sale «Elige un horario…»', async () => {
        for (const t of ['Y son principiantes', 'Oye una pregunta', 'Que cuesta']) {
            const c = armar({ estado: EN_FRANJA });
            expect(await c.turno(t), t).toBe(false);
            expect(c.enviados, t).toHaveLength(0);
            expect(c.soltados, t).toEqual([EN_FRANJA]);
        }
    });

    it('elegir sigue funcionando: el número, el botón', async () => {
        const c = armar({ estado: EN_FRANJA });
        expect(await c.turno('2')).toBe(true);
        expect(c.ultimo().step).toBe('cortesia_nombre');
        expect(c.estado()?.datos.franja?.id).toBe('f2');
    });
});
