/**
 * Clase de cortesía por WhatsApp: el motor del flujo, sin red ni base.
 *
 * El estado se simula igual que en producción: lo que se "envía" con estado
 * queda como el último saliente y es lo que lee el turno siguiente; un mensaje
 * terminal (estado null) cierra el flujo.
 *
 * Caso de origen: Dynasty, 2026-10-06 — «Clase de cortesía tienen» y el bot
 * contestó que no tenía esa información.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./avisos-correo.service', () => ({ destinatariosDeEscuela: vi.fn(), enviarConReserva: vi.fn() }));

import {
    atenderTurnoCortesia, pideClaseDeCortesia, quiereCancelarClase, leerEdad, filtrarVigentes,
    tituloBoton, BOTON_CC, quiereSalirDelFlujo, leerPerfil, leerNumeroOpcion, leerDia, filtrarPorPerfil,
    direccionDeSede, QUE_LLEVAR, nombreValido, type CtxCortesia, type EstadoCortesia, type FranjaCortesia,
    type ResultadoReserva, type ResultadoCancelacion, type ReservaVigente,
} from './whatsapp-clase-cortesia.service';

// 2026-10-06 08:00 en Bogotá.
const AHORA = new Date('2026-10-06T13:00:00Z');

const F = (id: string, fecha: string, hora: string, cupos = 3, grupo = 'Sub-15'): FranjaCortesia => ({
    id, grupo, fecha, horaInicio: hora, horaFin: '18:30', sede: 'Sede principal', cupos,
});

interface Enviado { texto: string; step: string; estado: EstadoCortesia | null; botones?: any[]; enTexto?: string }

function armar(op: {
    franjas?: FranjaCortesia[];
    reserva?: ReservaVigente | null;
    reservar?: (p: any) => Promise<ResultadoReserva>;
    cancelar?: () => Promise<ResultadoCancelacion>;
    acudiente?: string | null;
} = {}) {
    const enviados: Enviado[] = [];
    let estado: EstadoCortesia | null = null;
    let franjas = op.franjas ?? [];
    const reservar = vi.fn(op.reservar ?? (async () => ({ ok: true, leadId: 'lead-1', duplicado: false, conCupo: true }) as ResultadoReserva));
    const cancelar = vi.fn(op.cancelar ?? (async () => ({ ok: true, franja: null }) as ResultadoCancelacion));
    const avisarEscuela = vi.fn(async () => {});
    const ctx: CtxCortesia = {
        conversationId: 'conv-1',
        schoolId: 'school-1',
        contactWaId: '573001112233',
        enviar: async (texto, step, est, botones, enTexto) => {
            enviados.push({ texto, step, estado: est, botones, enTexto });
            estado = est;
        },
        nombreAcudiente: op.acudiente !== undefined ? async () => op.acudiente ?? null : undefined,
        leerEstado: async () => estado,
        franjas: async () => franjas,
        reservaVigente: async () => op.reserva ?? null,
        reservar,
        cancelar,
        avisarEscuela,
        ahora: () => AHORA,
    };
    const turno = (texto: string, botonId: string | null = null, opciones = {}) =>
        atenderTurnoCortesia(ctx, texto, botonId, opciones);
    return {
        ctx, enviados, reservar, cancelar, avisarEscuela, turno,
        ultimo: () => enviados[enviados.length - 1],
        estado: () => estado,
        setFranjas: (f: FranjaCortesia[]) => { franjas = f; },
    };
}

describe('reglas (puras)', () => {
    it('reconoce las formas de pedir la clase de cortesía', () => {
        for (const t of ['Clase de cortesía tienen', '¿tienen clase de prueba?', 'clase gratis?',
            '¿Puedo ir a probar?', 'quiero agendar una clase', 'tienen cortesía para mi hija']) {
            expect(pideClaseDeCortesia(t), t).toBe(true);
        }
        for (const t of ['cuánto debo', 'hola', 'mi hija no va a la clase hoy']) {
            expect(pideClaseDeCortesia(t), t).toBe(false);
        }
    });

    it('«cancelar mi clase» sí; «cancelar» suelto no', () => {
        expect(quiereCancelarClase('quiero cancelar mi clase')).toBe(true);
        expect(quiereCancelarClase('cancelar la clase de prueba')).toBe(true);
        expect(quiereCancelarClase('cancelar')).toBe(false);
    });

    it('lee edad o fecha de nacimiento', () => {
        expect(leerEdad('12', AHORA)).toEqual({ edad: 12, fechaNacimiento: null });
        expect(leerEdad('12 años', AHORA)).toEqual({ edad: 12, fechaNacimiento: null });
        expect(leerEdad('15/03/2014', AHORA)).toEqual({ edad: 12, fechaNacimiento: '2014-03-15' });
        expect(leerEdad('2014-11-20', AHORA)).toEqual({ edad: 11, fechaNacimiento: '2014-11-20' });
        expect(leerEdad('31/02/2014', AHORA)).toBeNull();
        expect(leerEdad('mañana', AHORA)).toBeNull();
        expect(leerEdad('1', AHORA)).toBeNull();
    });

    it('descarta franjas pasadas, sin cupo o de hoy que ya empezaron', () => {
        const v = filtrarVigentes([
            F('pasada', '2026-08-28', '17:00'),
            F('hoy-temprano', '2026-10-06', '07:00'),
            F('hoy-tarde', '2026-10-06', '17:00'),
            F('llena', '2026-10-10', '17:00', 0),
            F('futura', '2026-10-08', '17:00'),
        ], AHORA);
        expect(v.map((f) => f.id)).toEqual(['hoy-tarde', 'futura']);
    });

    it('título de botón ≤ 20 caracteres y numerado', () => {
        const t = tituloBoton(F('a', '2026-10-10', '17:00'), 1);
        expect(t).toBe('1. Sáb 10/10 5:00pm');
        expect(Array.from(t).length).toBeLessThanOrEqual(20);
    });
});

describe('sin franjas cargadas', () => {
    it('lo dice y ofrece dejar los datos; con «Sí» crea el prospecto SIN cupo', async () => {
        const t = armar({ franjas: [] });
        expect(await t.turno('Clase de cortesía tienen')).toBe(true);
        expect(t.ultimo().texto).toContain('no tengo horarios de *clase de cortesía* publicados');
        expect(t.ultimo().botones?.map((b) => b.id)).toEqual([BOTON_CC.DATOS_SI, BOTON_CC.DATOS_NO]);
        expect(t.estado()?.paso).toBe('dejar_datos');

        await t.turno('Sí, dejar mis datos', BOTON_CC.DATOS_SI);
        expect(t.estado()?.paso).toBe('nombre');
        await t.turno('juan pérez');
        expect(t.estado()?.paso).toBe('edad');
        await t.turno('10');
        expect(t.estado()?.paso).toBe('acudiente');
        await t.turno('Ana Gómez');
        expect(t.estado()?.paso).toBe('confirmar');
        expect(t.ultimo().texto).toContain('la escuela te contacta para agendarla');
        expect(t.ultimo().texto).toContain('Juan Pérez');

        await t.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.reservar).toHaveBeenCalledWith(expect.objectContaining({
            franjaId: null, nombre: 'Juan Pérez', edad: 10, acudiente: 'Ana Gómez', contactWaId: '573001112233',
        }));
        expect(t.ultimo().texto).toContain('Pasé los datos de *Juan Pérez*');
        expect(t.estado()).toBeNull();
        expect(t.avisarEscuela).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'datos' }));
    });

    it('«No, gracias» cierra sin crear nada', async () => {
        const t = armar({ franjas: [] });
        await t.turno('clase de prueba?');
        await t.turno('No, gracias', BOTON_CC.DATOS_NO);
        expect(t.estado()).toBeNull();
        expect(t.reservar).not.toHaveBeenCalled();
    });
});

describe('reserva', () => {
    const FRANJAS = [F('f1', '2026-10-10', '17:00', 2), F('f2', '2026-10-11', '09:00', 5, 'Sub-17')];

    it('camino feliz: franja con botón → nombre → fecha de nacimiento → acudiente → Confirmar → reservada', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('Clase de cortesía tienen');
        const oferta = t.ultimo();
        expect(oferta.texto).toContain('*Sub-15* — sábado 10 de octubre, 5:00 p. m. a 6:30 p. m. (1 h 30 min)');
        expect(oferta.texto).toContain('2 cupos');
        expect(oferta.botones?.map((b) => b.id)).toEqual([`${BOTON_CC.FRANJA}f1`, `${BOTON_CC.FRANJA}f2`]);

        await t.turno('1. Sáb 10/10 5:00pm', `${BOTON_CC.FRANJA}f1`);
        expect(t.estado()?.paso).toBe('nombre');
        await t.turno('Sofía Ruiz');
        await t.turno('15/03/2014');
        await t.turno('Carlos Ruiz');
        expect(t.ultimo().texto).toContain('• Clase: *Sub-15*');
        expect(t.ultimo().texto).toContain('• Acudiente: *Carlos Ruiz*');
        expect(t.ultimo().botones?.map((b) => b.title)).toEqual(['Confirmar', 'Cambiar']);

        await t.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.reservar).toHaveBeenCalledWith(expect.objectContaining({
            franjaId: 'f1', nombre: 'Sofía Ruiz', edad: 12, fechaNacimiento: '2014-03-15', acudiente: 'Carlos Ruiz',
        }));
        const fin = t.ultimo();
        expect(fin.texto).toContain('Quedó reservada la clase de cortesía de *Sofía Ruiz*');
        expect(fin.texto).toContain('📍 Sede principal');
        expect(fin.texto).toContain('cancelar mi clase');
        expect(t.estado()).toBeNull();
        expect(t.avisarEscuela).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'reservada', leadId: 'lead-1' }));
    });

    it('el número escrito también elige (modo asistido, sin botones)', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba');
        await t.turno('2');
        expect(t.estado()?.datos.franja?.id).toBe('f2');
    });

    it('familia con cuenta: no le pregunta su propio nombre como acudiente', async () => {
        const t = armar({ franjas: FRANJAS, acudiente: 'Marta López' });
        await t.turno('clase de prueba');
        await t.turno('x', `${BOTON_CC.FRANJA}f1`);
        await t.turno('Pedro López');
        await t.turno('9');
        expect(t.estado()?.paso).toBe('confirmar');
        expect(t.ultimo().texto).toContain('Marta López');
    });

    it('adulto: no pide acudiente', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba');
        await t.turno('x', `${BOTON_CC.FRANJA}f2`);
        await t.turno('Laura Díaz');
        await t.turno('25 años');
        expect(t.estado()?.paso).toBe('confirmar');
    });

    it('CUPO LLENO en la carrera: ofrece lo que queda y conserva los datos', async () => {
        let intento = 0;
        const t = armar({
            franjas: FRANJAS,
            reservar: async () => (++intento === 1
                ? { ok: false, motivo: 'lleno' }
                : { ok: true, leadId: 'lead-2', duplicado: false, conCupo: true }),
        });
        await t.turno('clase de prueba');
        await t.turno('x', `${BOTON_CC.FRANJA}f1`);
        await t.turno('Sofía Ruiz');
        await t.turno('12');
        await t.turno('Carlos Ruiz');
        // Otra familia se llevó el último cupo de f1 mientras confirmaba.
        t.setFranjas([{ ...FRANJAS[0], cupos: 0 }, FRANJAS[1]]);
        await t.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.ultimo().texto).toContain('se acaba de llenar');
        expect(t.ultimo().botones?.map((b) => b.id)).toEqual([`${BOTON_CC.FRANJA}f2`]);
        expect(t.estado()?.datos.nombre).toBe('Sofía Ruiz');

        // Elige otra: ya tiene los datos, va directo al resumen.
        await t.turno('x', `${BOTON_CC.FRANJA}f2`);
        expect(t.estado()?.paso).toBe('confirmar');
        await t.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.reservar).toHaveBeenLastCalledWith(expect.objectContaining({ franjaId: 'f2' }));
        expect(t.ultimo().texto).toContain('Quedó reservada');
    });

    it('franja que se cerró entre la oferta y el toque: lo dice y re-ofrece', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba');
        t.setFranjas([FRANJAS[1]]);
        await t.turno('x', `${BOTON_CC.FRANJA}f1`);
        expect(t.ultimo().texto).toContain('esa franja ya no está disponible');
    });

    it('dedupe de 24 h de submit_school_lead: NO dice «reservada» si no tomó el cupo', async () => {
        const t = armar({ franjas: FRANJAS, reservar: async () => ({ ok: true, leadId: 'viejo', duplicado: true, conCupo: false }) });
        await t.turno('clase de prueba');
        await t.turno('x', `${BOTON_CC.FRANJA}f2`);
        await t.turno('Laura Díaz');
        await t.turno('30');
        await t.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.ultimo().texto).not.toContain('Quedó reservada');
        expect(t.ultimo().texto).toContain('te confirme el horario');
        expect(t.avisarEscuela).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'no_reservada' }));
    });

    it('más de 3 franjas: TODAS en una lista (secciones por día), sin «Ver más»', async () => {
        const t = armar({ franjas: [
            F('a', '2026-10-07', '17:00'), F('b', '2026-10-08', '17:00'),
            F('c', '2026-10-09', '17:00'), F('d', '2026-10-10', '17:00'),
        ] });
        await t.turno('clase de prueba');
        const o = t.ultimo();
        expect(o.botones?.map((b) => b.id)).toEqual(['a', 'b', 'c', 'd'].map((x) => `${BOTON_CC.FRANJA}${x}`));
        expect(o.botones?.map((b) => b.seccion)).toEqual(['Miércoles 7 oct', 'Jueves 8 oct', 'Viernes 9 oct', 'Sábado 10 oct']);
        for (const b of o.botones ?? []) expect(Array.from(b.title).length).toBeLessThanOrEqual(24);
        // Auditoría 2026-10-07: el cuerpo no repite las franjas (van en la lista) y
        // queda corto; el listado numerado va en el respaldo de texto.
        expect(o.texto).not.toContain('— *Sub-15*');
        expect(o.texto).toContain('Tengo 4 horarios entre el miércoles 7 de octubre y el sábado 10 de octubre.');
        expect(o.texto.length).toBeLessThanOrEqual(600);
        expect(o.enTexto).toContain('*Sábado 10 de octubre*\n4. 5:00 p. m. a 6:30 p. m. — *Sub-15*');
        expect(o.enTexto).toContain('Responde con el número (1, 2, 3, 4)');
    });

    it('ya tiene una clase reservada: se le recuerda, no se le reserva otra', async () => {
        const t = armar({ franjas: FRANJAS, reserva: { leadId: 'l', nombre: 'Sofía Ruiz', franja: FRANJAS[0] } });
        await t.turno('clase de prueba');
        expect(t.ultimo().texto).toContain('Ya tienes una clase de cortesía reservada');
        expect(t.ultimo().botones?.[0].id).toBe(BOTON_CC.CANCELAR);
        expect(t.estado()).toBeNull();
    });

    it('una pregunta a mitad del flujo lo suelta (la atiende el bot normal)', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba');
        await t.turno('x', `${BOTON_CC.FRANJA}f1`);
        expect(await t.turno('¿y cuánto vale la mensualidad?')).toBe(false);
    });

    it('un botón de otra cosa con el flujo abierto lo suelta', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba');
        expect(await t.turno('Ver mis pagos', 'sm_ver_pagos')).toBe(false);
    });

    it('con iniciar=false no arranca nada nuevo (puerta del desconocido)', async () => {
        const t = armar({ franjas: FRANJAS });
        expect(await t.turno('clase de prueba', null, { iniciar: false })).toBe(false);
        expect(t.enviados).toHaveLength(0);
    });
});

describe('cancelar mi clase', () => {
    const RESERVA: ReservaVigente = { leadId: 'l1', nombre: 'Sofía Ruiz', franja: F('f1', '2026-10-10', '17:00', 0) };

    it('con reserva: pregunta, y con «Sí, cancelar» libera el cupo y avisa', async () => {
        const t = armar({ reserva: RESERVA, cancelar: async () => ({ ok: true, franja: RESERVA.franja }) });
        expect(await t.turno('quiero cancelar mi clase', null, { iniciar: false })).toBe(true);
        expect(t.estado()?.paso).toBe('confirmar_cancelacion');
        expect(t.ultimo().texto).toContain('*Sofía Ruiz*');

        await t.turno('Sí, cancelar', BOTON_CC.CANCELAR_SI);
        expect(t.cancelar).toHaveBeenCalledWith('school-1', '573001112233');
        expect(t.ultimo().texto).toContain('cancelé tu clase de cortesía del sábado 10 de octubre');
        expect(t.estado()).toBeNull();
        expect(t.avisarEscuela).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'cancelada' }));
    });

    it('«No, la mantengo» no cancela', async () => {
        const t = armar({ reserva: RESERVA });
        await t.turno('cancelar mi clase');
        await t.turno('No, la mantengo', BOTON_CC.CANCELAR_NO);
        expect(t.cancelar).not.toHaveBeenCalled();
        expect(t.ultimo().texto).toContain('sigue reservada');
    });

    it('sin la RPC aplicada: se le pide a la escuela, nunca se toca el cupo', async () => {
        const t = armar({ reserva: RESERVA, cancelar: async () => ({ ok: false, motivo: 'sin_rpc' }) });
        await t.turno('cancelar mi clase');
        await t.turno('si');
        expect(t.ultimo().texto).toContain('Le pedí a la escuela que cancele tu clase');
        expect(t.avisarEscuela).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'cancelacion_pedida' }));
    });

    it('SIN reserva de ese número: no se lo toma (para una familia es «no voy a entrenar»)', async () => {
        const t = armar({ reserva: null });
        expect(await t.turno('cancelar la clase de hoy')).toBe(false);
        expect(t.enviados).toHaveLength(0);
    });
});

// ─── Auditoría Dynasty 2026-10-06: 16 prospectos, 0 reservas ────────────────
// Grupos reales de Dynasty (nombres de `teams`, sin age_min/age_max cargados).
// AHORA = martes 6 de octubre, 8:00 a. m. en Bogotá.

const D = (id: string, grupo: string, fecha: string, hora: string, fin: string, sede = 'Coliseo Dynasty DC'): FranjaCortesia => ({
    id, grupo, fecha, horaInicio: hora, horaFin: fin, sede, cupos: 999, direccion: sede === 'Coliseo Dynasty DC' ? 'Cl. 12 Bis #71g-09' : null,
});
const DYNASTY: FranjaCortesia[] = [
    D('hoy-930', 'MENORES FEMENINO · White', '2026-10-06', '09:30', '11:30'),     // en 1 h 30 → NO
    D('hoy-1000', 'MINIVOLLEY BENJAMINES', '2026-10-06', '10:00', '12:00'),         // justo 2 h → sí
    D('im-mar', 'INFANTIL MASCULINO', '2026-10-06', '18:30', '20:30'),
    D('if-mie', 'INFANTIL FEMENINO', '2026-10-07', '18:30', '20:30'),
    D('sen-jue', 'SENIORS', '2026-10-08', '20:00', '22:00'),
    D('ne-vie', 'NUEVA ERA', '2026-10-09', '16:00', '18:00'),
    D('io-vie', 'INTERMEDIO · Origen', '2026-10-09', '16:00', '18:00'),
    D('mf-sab', 'MENORES FEMENINO · White', '2026-10-10', '09:30', '11:30', 'Cancha externa Asoalsacia'),
    D('mm-sab', 'MENORES MASCULINO', '2026-10-10', '09:30', '11:30'),
    D('if-sab', 'INFANTIL FEMENINO', '2026-10-10', '11:00', '13:00'),
    D('if-dom', 'INFANTIL FEMENINO', '2026-10-11', '11:00', '13:00'),
    D('sen-lun', 'SENIORS', '2026-10-12', '20:00', '22:00'),
    D('jm-mar', 'JUVENIL MAYORES MASCULINO', '2026-10-13', '20:00', '22:00'),
];
const ids = (bs?: any[]) => (bs ?? []).filter((b) => b.id.startsWith(BOTON_CC.FRANJA)).map((b) => b.id.slice(BOTON_CC.FRANJA.length));

describe('reglas nuevas (puras)', () => {
    it('quiereSalirDelFlujo: asesor, persona, Milena, hablar con alguien', () => {
        for (const t of ['Necesito hablar con un asesor', 'quiero hablar con una persona', 'Milena?',
            'me pueden llamar', 'hablar con alguien', 'pásame con un humano', 'con la encargada por favor']) {
            expect(quiereSalirDelFlujo(t), t).toBe(true);
        }
        for (const t of ['la 2', 'el sábado', 'Sofía Ruiz', 'para mi hija de 8 años', 'soy adulto', '2', 'Confirmar']) {
            expect(quiereSalirDelFlujo(t), t).toBe(false);
        }
    });

    it('leerPerfil: solo lo que dijo', () => {
        expect(leerPerfil('para mi hija de 8 años')).toEqual({ edad: 8, genero: 'f', menor: true });
        expect(leerPerfil('soy adulto')).toEqual({ adulto: true });
        expect(leerPerfil('mi hijo tiene 12')).toEqual({ edad: 12, genero: 'm', menor: true });
        expect(leerPerfil('es para mí, tengo 35 años')).toEqual({ edad: 35, adulto: true });
        expect(leerPerfil('8', { soloNumero: true })).toEqual({ edad: 8, menor: true });
        expect(leerPerfil('8')).toBeNull();
        expect(leerPerfil('ver todos')).toEqual({ todos: true });
        expect(leerPerfil('el sábado')).toBeNull();
        expect(leerPerfil('la 2')).toBeNull();
    });

    it('leerNumeroOpcion y leerDia', () => {
        expect(leerNumeroOpcion('la 2')).toBe(2);
        expect(leerNumeroOpcion('2')).toBe(2);
        expect(leerNumeroOpcion('#3')).toBe(3);
        expect(leerNumeroOpcion('opción 4')).toBe(4);
        expect(leerNumeroOpcion('la segunda')).toBe(2);
        expect(leerNumeroOpcion('el sábado')).toBeNull();
        expect(leerNumeroOpcion('tiene 8 años')).toBeNull();
        expect(leerDia('el sábado')).toBe(6);
        expect(leerDia('mejor los martes')).toBe(2);
        expect(leerDia('la 2')).toBeNull();
    });

    it('nunca ofrece franjas que empiezan en menos de 2 h (ni las que ya empezaron)', () => {
        const v = filtrarVigentes(DYNASTY, AHORA).map((f) => f.id);
        expect(v).not.toContain('hoy-930');
        expect(v).toContain('hoy-1000');
        // 11:10 p. m.: la de las 12:30 a. m. del día siguiente está a 1 h 20 → no.
        const noche = new Date('2026-10-07T04:10:00Z');
        expect(filtrarVigentes([D('madrugada', 'SENIORS', '2026-10-07', '00:30', '02:00'),
            D('temprano', 'SENIORS', '2026-10-07', '06:00', '08:00')], noche).map((f) => f.id)).toEqual(['temprano']);
    });

    it('filtrarPorPerfil: género por el NOMBRE del grupo, adultos = SENIORS; sin edades cargadas lo dice', () => {
        const hija = filtrarPorPerfil(DYNASTY, { edad: 8, genero: 'f', menor: true });
        expect(hija.franjas.some((f) => /MASCULINO|SENIORS/.test(f.grupo))).toBe(false);
        expect(hija.franjas.some((f) => f.grupo === 'NUEVA ERA')).toBe(true); // mixto: se queda
        expect(hija.nota).toContain('no tienen edades cargadas');
        expect(filtrarPorPerfil(DYNASTY, { adulto: true }).franjas.map((f) => f.grupo)).toEqual(['SENIORS', 'SENIORS']);
        // Con rango cargado sí filtra por edad.
        const conRango = [{ ...DYNASTY[2], edadMin: 7, edadMax: 10 }, { ...DYNASTY[3], edadMin: 11, edadMax: 14 }];
        expect(filtrarPorPerfil(conRango, { edad: 12 }).franjas.map((f) => f.id)).toEqual(['if-mie']);
        // Escuela sin grupo de adultos: muestra lo que hay y lo dice.
        const sinAdultos = filtrarPorPerfil([F('x', '2026-10-08', '17:00')], { adulto: true });
        expect(sinAdultos.franjas).toHaveLength(1);
        expect(sinAdultos.nota).toContain('no tiene marcado un grupo de adultos');
    });

    it('direccionDeSede: por nombre de la sede registrada; si no coincide, null', () => {
        const sedes = [{ name: 'Coliseo Dynasty', address: 'Cl. 12 Bis #71g-09' }];
        expect(direccionDeSede('Coliseo Dynasty DC', sedes)).toBe('Cl. 12 Bis #71g-09');
        expect(direccionDeSede('Cancha externa Asoalsacia', sedes)).toBeNull();
    });
});

describe('Dynasty: perfil → lista por día → reserva', () => {
    it('«Clase de cortesía tienen» sin decir para quién: pregunta corta, no tira 13 horarios', async () => {
        const t = armar({ franjas: DYNASTY });
        await t.turno('Clase de cortesía tienen');
        expect(t.estado()?.paso).toBe('perfil');
        expect(t.ultimo().texto).toContain('¿para quién es la clase y qué edad tiene?');
    });

    it('«para mi hija de 8 años» → «el sábado» → «la 2» → nombre (sin re-preguntar edad) → acudiente → reservada', async () => {
        const t = armar({ franjas: DYNASTY });
        await t.turno('Clase de cortesía tienen');
        await t.turno('para mi hija de 8 años');
        let o = t.ultimo();
        expect(t.estado()?.paso).toBe('elegir_franja');
        const ofrecidas = ids(o.botones);
        expect(ofrecidas.length).toBeGreaterThan(3);
        expect(ofrecidas.length).toBeLessThanOrEqual(10);
        expect(ofrecidas).not.toContain('hoy-930');                               // < 2 h
        expect(ofrecidas.some((id) => /^(im|mm|sen|jm)-/.test(id))).toBe(false);   // masculinos y adultos fuera
        expect(o.botones?.every((b) => !!b.seccion)).toBe(true);                   // lista con secciones por día
        expect(o.texto).toContain('para 8 años (femenino o mixto)');
        expect(o.texto).toContain('no tienen edades cargadas');

        await t.turno('el sábado');
        o = t.ultimo();
        expect(ids(o.botones)).toEqual(['mf-sab', 'if-sab']);
        expect(o.texto).toContain('del *sábado*');

        await t.turno('la 2');
        expect(t.estado()?.datos.franja?.id).toBe('if-sab');
        expect(t.estado()?.paso).toBe('nombre');

        await t.turno('Valentina Ríos');
        expect(t.estado()?.paso).toBe('acudiente');                               // la edad ya la dijo
        await t.turno('Paula Ríos');
        expect(t.ultimo().texto).toContain('• Sede: Coliseo Dynasty DC (Cl. 12 Bis #71g-09)');
        await t.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.reservar).toHaveBeenCalledWith(expect.objectContaining({
            franjaId: 'if-sab', nombre: 'Valentina Ríos', edad: 8, acudiente: 'Paula Ríos',
        }));
        const fin = t.ultimo().texto;
        expect(fin).toContain('📅 sábado 10 de octubre');
        expect(fin).toContain('🕔 11:00 a. m. a 1:00 p. m.');
        expect(fin).toContain('📍 Coliseo Dynasty DC (Cl. 12 Bis #71g-09)');
        expect(fin).toContain(`Qué llevar: ${QUE_LLEVAR}`);
        expect(t.estado()).toBeNull();
    });

    it('«soy adulto» → solo SENIORS', async () => {
        const t = armar({ franjas: DYNASTY });
        await t.turno('Clase de cortesía tienen');
        await t.turno('soy adulto');
        expect(ids(t.ultimo().botones)).toEqual(['sen-jue', 'sen-lun']);
        expect(t.ultimo().texto).toContain('para adultos');
    });

    it('lo dice de una vez («clase de prueba para mi hijo de 10 años»): no pregunta', async () => {
        const t = armar({ franjas: DYNASTY });
        await t.turno('clase de prueba para mi hijo de 10 años');
        expect(t.estado()?.paso).toBe('elegir_franja');
        expect(ids(t.ultimo().botones).some((id) => /^(if|mf|sen)-/.test(id))).toBe(false);
    });

    it('«Necesito hablar con un asesor» suelta el flujo en cualquier paso (lo atiende el bot general)', async () => {
        const enPerfil = armar({ franjas: DYNASTY });
        await enPerfil.turno('Clase de cortesía tienen');
        expect(await enPerfil.turno('Necesito hablar con un asesor')).toBe(false);

        const eligiendo = armar({ franjas: DYNASTY });
        await eligiendo.turno('Clase de cortesía tienen');
        await eligiendo.turno('soy adulto');
        const antes = eligiendo.enviados.length;
        expect(await eligiendo.turno('Necesito hablar con un asesor')).toBe(false);
        expect(eligiendo.enviados).toHaveLength(antes);                            // NO «Toca la franja…»
        expect(await eligiendo.turno('Milena?')).toBe(false);
        expect(await eligiendo.turno('cuanto vale la mensualidad')).toBe(false);

        const enNombre = armar({ franjas: DYNASTY });
        await enNombre.turno('Clase de cortesía tienen');
        await enNombre.turno('soy adulto');
        await enNombre.turno('1');
        expect(enNombre.estado()?.paso).toBe('nombre');
        expect(await enNombre.turno('quiero hablar con alguien')).toBe(false);
    });

    it('más de 10 horarios: 9 + «Ver más horarios», y la numeración sigue en la página 2', async () => {
        const muchas = Array.from({ length: 12 }, (_, i) =>
            F(`s${i + 1}`, `2026-10-${String(7 + i).padStart(2, '0')}`, '17:00'));
        const t = armar({ franjas: muchas });
        await t.turno('clase de prueba');                    // Sub-15: nada con qué filtrar → no pregunta
        let o = t.ultimo();
        expect(o.botones).toHaveLength(10);
        expect(o.botones?.[9].id).toBe(BOTON_CC.VER_MAS);
        await t.turno('Ver más horarios', BOTON_CC.VER_MAS);
        o = t.ultimo();
        expect(ids(o.botones)).toEqual(['s10', 's11', 's12']);
        expect(o.enTexto).toContain('10. 5:00 p. m.');
        expect(o.texto.length).toBeLessThanOrEqual(600);
        await t.turno('la 11');
        expect(t.estado()?.datos.franja?.id).toBe('s11');
    });
});

describe('auditoría Dynasty 2026-10-07: respuestas repetidas y reservas tardías', () => {
    const FRANJAS = [F('f1', '2026-10-10', '17:00', 2), F('f2', '2026-10-11', '09:00', 5, 'Sub-17')];

    it('«11años» sin espacio se entiende como edad', () => {
        expect(leerEdad('11años', AHORA)?.edad).toBe(11);
        expect(leerEdad('11 años', AHORA)?.edad).toBe(11);
    });

    it('«Hola» en el paso del nombre no es un nombre: vuelve a pedir el nombre', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba');
        await t.turno('x', `${BOTON_CC.FRANJA}f1`);
        await t.turno('Hola');
        expect(t.estado()?.paso).toBe('nombre');
        expect(t.ultimo().texto).not.toContain('edad');
    });

    it('«Cambiar» conserva la edad dicha en el perfil: no la vuelve a preguntar', async () => {
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba para mi hija de 11 años');
        await t.turno('x', `${BOTON_CC.FRANJA}f1`);
        await t.turno('Ana Pérez');
        await t.turno('Luz Pérez');
        expect(t.estado()?.paso).toBe('confirmar');
        await t.turno('Cambiar', BOTON_CC.CAMBIAR);
        await t.turno('x', `${BOTON_CC.FRANJA}f2`);
        await t.turno('Ana Pérez');
        expect(t.ultimo().step).not.toBe('cortesia_edad');
    });

    it('«Persona» suelto sale del flujo; «Voy a consultar y te confirmaré» lo cierra sin repetir la lista', async () => {
        expect(quiereSalirDelFlujo('Persona')).toBe(true);
        const t = armar({ franjas: FRANJAS });
        await t.turno('clase de prueba');
        await t.turno('Voy a consultar y te confirmaré');
        expect(t.ultimo().step).toBe('cortesia_abandonada');
    });

    it('«Yo 16 y ella 12» en el perfil muestra todos los grupos', () => {
        expect(leerPerfil('Yo 16 y ella 12', { soloNumero: true })).toEqual({ todos: true });
    });

    it('la franja que ya empezó al confirmar NO se reserva: se ofrecen las vigentes', async () => {
        const t = armar({ franjas: [F('hoy', '2026-10-06', '16:00', 3), ...FRANJAS] });
        await t.turno('clase de prueba');
        await t.turno('x', `${BOTON_CC.FRANJA}hoy`);
        await t.turno('Valentina Ruiz');
        await t.turno('11');
        await t.turno('Juan Ruiz');
        expect(t.estado()?.paso).toBe('confirmar');
        // Confirma horas después: la de las 4:00 p. m. ya no está vigente.
        t.ctx.ahora = () => new Date('2026-10-06T21:53:00Z');
        await t.turno('Confirmar', BOTON_CC.CONFIRMAR);
        expect(t.reservar).not.toHaveBeenCalled();
        expect(t.ultimo().step).toBe('cortesia_franja_vencida');
        expect(t.estado()?.paso).toBe('elegir_franja');
    });
});

describe('análisis de las conversaciones de Dynasty (2026-10-29)', () => {
    it('«Soy la mamá de Josue» no es un nombre (el bot preguntó «¿Qué edad tiene Soy?»)', () => {
        expect(nombreValido('Soy la mamá de Josue')).toBeNull();
        expect(nombreValido('Es para mi hija')).toBeNull();
        expect(nombreValido('Karol Saenz')).toBe('Karol Saenz');
    });

    it('ningún grupo recibe 4 años → no se ofrecen los horarios de otros (ni los de Seniors)', () => {
        const conRango = [
            { ...DYNASTY[2], edadMin: 8, edadMax: 13 },
            { ...DYNASTY[4], edadMin: 18, edadMax: 60 },
        ];
        const r = filtrarPorPerfil(conRango, { edad: 4, menor: true });
        expect(r.franjas).toEqual([]);
        expect(r.sinGrupoParaEdad).toBe(4);
    });
});
