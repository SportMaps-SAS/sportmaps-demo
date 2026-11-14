/**
 * Bienvenida a escuelas nuevas (2026-10-27): plantilla por tipo, saludo, y que
 * no se repita entre corridas ni entre los 3 BFF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Resp = { data: any; error: any };
const llamadas: { tabla: string; op: string; args: any[] }[] = [];
let respuestas: Record<string, Resp[]> = {};

function builder(tabla: string) {
    const b: any = {};
    const encadenar = (nombre: string) => (...args: any[]) => { llamadas.push({ tabla, op: nombre, args }); return b; };
    for (const m of ['select', 'eq', 'gte', 'in', 'order', 'limit']) b[m] = encadenar(m);
    b.then = (ok: any, ko: any) => {
        const cola = respuestas[tabla] ?? [];
        const r = cola.length > 0 ? cola.shift() : { data: [], error: null };
        return Promise.resolve(r).then(ok, ko);
    };
    return b;
}

vi.mock('../config/supabase', () => ({ supabase: { from: (t: string) => builder(t) } }));

const enviarConReserva = vi.fn();
vi.mock('../services/avisos-correo.service', async (orig) => ({
    ...(await orig<typeof import('../services/avisos-correo.service')>()),
    enviarConReserva: (...a: any[]) => enviarConReserva(...a),
}));

import {
    saludo, correoBienvenida, correoAvisoInterno, runBienvenidaEscuelas, claveBienvenida,
    TIPO_BIENVENIDA, TIPO_AVISO_INTERNO, type Alta,
} from './bienvenida-escuelas.job';
import { uuidDeClave } from '../services/avisos-correo.service';

const alta = (o: Partial<Alta> = {}): Alta => ({
    schoolId: 's1', escuela: 'Taekwondo Santa Lucía ', tipoEscuela: 'academy', ciudad: null,
    creada: '2026-10-26T07:06:33Z', nombreDueno: 'Tkdsantalucia', correo: 'tkd@x.co', telefono: null, ...o,
});

beforeEach(() => {
    llamadas.length = 0;
    respuestas = {};
    enviarConReserva.mockReset();
    enviarConReserva.mockResolvedValue('enviado');
});

describe('saludo', () => {
    it('usa el primer nombre cuando parece de persona', () => {
        expect(saludo('Cristian Bejarano - Entrenador personal', 'X')).toBe('Hola Cristian:');
        expect(saludo('MARÍA JOSÉ PÉREZ', 'X')).toBe('Hola María:');
    });
    it('cae al equipo de la escuela con un usuario de una palabra o vacío', () => {
        expect(saludo('Tkdsantalucia', 'Taekwondo Santa Lucía ')).toBe('Hola, equipo de Taekwondo Santa Lucía:');
        expect(saludo(null, 'Club X')).toBe('Hola, equipo de Club X:');
    });
});

describe('correoBienvenida', () => {
    it('al entrenador personal le habla de alumnos y sesiones', () => {
        const c = correoBienvenida(alta({ tipoEscuela: 'personal_trainer', nombreDueno: 'Cristian Bejarano', escuela: 'Cristian PT' }));
        expect(c.subject).toMatch(/entrenador/i);
        expect(c.html).toContain('Invite a sus alumnos');
        expect(c.html).not.toContain('familias');
    });
    it('a la escuela le habla de deportistas y cobros a las familias, y firma el equipo', () => {
        const c = correoBienvenida(alta());
        expect(c.subject).toBe('Bienvenidos a SportMaps: Taekwondo Santa Lucía ya tiene su espacio');
        expect(c.html).toContain('Cargue a sus deportistas');
        expect(c.html).toContain('Equipo SportMaps');
        expect(c.html).toContain('wa.me/573202683539');
    });
    it('escapa el nombre de la escuela', () => {
        expect(correoBienvenida(alta({ escuela: '<b>Club</b>' })).html).not.toContain('<b>Club</b>');
    });
});

describe('correoAvisoInterno', () => {
    it('marca el fallo para contactarlo a mano y enlaza el WhatsApp', () => {
        const c = correoAvisoInterno(alta({ telefono: '+573133016325' }), 'fallo');
        expect(c.html).toContain('FALLÓ');
        expect(c.html).toContain('wa.me/573133016325');
    });
});

describe('runBienvenidaEscuelas', () => {
    const escuela = { id: 's1', name: 'Club', school_type: 'academy', city: 'Cali', created_at: '2026-10-27T10:00:00Z', owner_id: 'u1' };

    it('manda bienvenida al dueño (respuestas a contacto@) y el aviso interno', async () => {
        respuestas = {
            schools: [{ data: [escuela], error: null }],
            email_sends: [{ data: [], error: null }],
            profiles: [{ data: [{ id: 'u1', full_name: 'Ana Gómez', email: 'ANA@x.co', phone: '+57300' }], error: null }],
        };
        const r = await runBienvenidaEscuelas(Date.parse('2026-10-27T12:00:00Z'));
        expect(r).toEqual({ enviadas: 1, fallos: 0 });
        expect(enviarConReserva).toHaveBeenCalledTimes(2);
        const [b, a] = enviarConReserva.mock.calls.map((c) => c[0]);
        expect(b).toMatchObject({ tipo: TIPO_BIENVENIDA, destinos: ['ana@x.co'], replyTo: 'contacto@sportmaps.co', clave: 'welcome_school:s1' });
        expect(a).toMatchObject({ tipo: TIPO_AVISO_INTERNO, destinos: ['contacto@sportmaps.co'] });
    });

    it('solo mira escuelas reales, no demo, de las últimas 72 h', async () => {
        respuestas = { schools: [{ data: [], error: null }] };
        await runBienvenidaEscuelas(Date.parse('2026-10-27T12:00:00Z'));
        const filtros = llamadas.filter((l) => l.tabla === 'schools');
        expect(filtros).toContainEqual({ tabla: 'schools', op: 'eq', args: ['account_type', 'real'] });
        expect(filtros).toContainEqual({ tabla: 'schools', op: 'eq', args: ['is_demo', false] });
        expect(filtros).toContainEqual({ tabla: 'schools', op: 'gte', args: ['created_at', '2026-10-24T12:00:00.000Z'] });
        expect(enviarConReserva).not.toHaveBeenCalled();
    });

    it('salta las que ya tienen la reserva, sin intentar enviar', async () => {
        respuestas = {
            schools: [{ data: [escuela], error: null }],
            email_sends: [{ data: [{ id: uuidDeClave(claveBienvenida('s1')) }], error: null }],
        };
        expect(await runBienvenidaEscuelas()).toEqual({ enviadas: 0, fallos: 0 });
        expect(enviarConReserva).not.toHaveBeenCalled();
    });

    it('si otro BFF ganó la reserva, tampoco manda el aviso interno', async () => {
        enviarConReserva.mockResolvedValueOnce('duplicado');
        respuestas = {
            schools: [{ data: [escuela], error: null }],
            email_sends: [{ data: [], error: null }],
            profiles: [{ data: [{ id: 'u1', full_name: 'Ana', email: 'ana@x.co' }], error: null }],
        };
        await runBienvenidaEscuelas();
        expect(enviarConReserva).toHaveBeenCalledTimes(1);
    });

    it('sin correo del dueño no hay bienvenida, pero sí el aviso interno', async () => {
        respuestas = {
            schools: [{ data: [escuela], error: null }],
            email_sends: [{ data: [], error: null }],
            profiles: [{ data: [{ id: 'u1', full_name: 'Ana', email: null }], error: null }],
        };
        await runBienvenidaEscuelas();
        expect(enviarConReserva).toHaveBeenCalledTimes(1);
        expect(enviarConReserva.mock.calls[0][0].tipo).toBe(TIPO_AVISO_INTERNO);
        expect(enviarConReserva.mock.calls[0][0].respaldo.html).toContain('Sin correo');
    });
});
