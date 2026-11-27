/**
 * Capas 1 y 2 sin modelo (docs/specs/mapi-consultas-sin-ia.md) con el CATÁLOGO
 * REAL: las mismas herramientas, el mismo `buscarHerramienta` y el mismo
 * alcance que usa el modelo. La base es falsa y filtra por los `eq`/`in` que
 * recibe, así una consulta con la escuela equivocada no encuentra nada.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ responder: (_c: any): any => undefined }));

vi.mock('../../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('../supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave', supabaseAnonKey: 'anon', SUPABASE_URL: 'http://supabase.local', SUPABASE_ANON_KEY: 'anon' };
});

import { responderSinModelo, opcionesDelMenu, esBotonDeConsulta, textoParaApp, TEXTOS_DIRECTO, contadoresDeCapas, _reiniciarContadores } from './enrutador';
import { CATALOGO } from '../registro';
import { parsearBotonMapi } from '../canal-whatsapp';
import { tareaUnicaDelMapa } from '../../../data/app-map';
import * as P from './plantillas';
import type { Alcance } from '../tipos';
import type { Consulta } from '../supabase-falso.test-helper';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const T1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const T2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const SAMUEL = 'cccccccc-0000-0000-0000-000000000001';
const MARIANA_L = 'cccccccc-0000-0000-0000-000000000002';
const MARIANA_R = 'cccccccc-0000-0000-0000-000000000003';
const HOY = '2026-11-26';

const fila = (id: string, nombre: string, team: string, teamName: string, school = A) => ({
    id, full_name: nombre, athlete_type: 'child', team_id: team, enrolled_team_id: team, team_name: teamName,
    is_active: true, parent_id: 'papa', user_id: null, plan_name: 'Mensual', enrollment_status: 'active', school_id: school,
});
const ATLETAS = [
    fila(SAMUEL, 'Samuel Ortiz', T1, 'Sub 12'),
    fila(MARIANA_L, 'Mariana López', T1, 'Sub 12'),
    fila(MARIANA_R, 'Mariana Ruiz', T2, 'Tiburones'),
];
const EQUIPOS = [
    { id: T1, name: 'Sub 12', sport: 'fútbol', age_group: null, schedule: [], active: true, status: 'active', school_id: A },
    { id: T2, name: 'Tiburones', sport: 'natación', age_group: null, schedule: [], active: true, status: 'active', school_id: A },
];

/** Filtra filas por los `eq` / `in` de la consulta cuyas columnas tenga la fila. */
function filtrar(filas: any[], c: Consulta): any[] {
    return filas.filter((f) => c.filtros.every(([t, col, val]) => {
        if (!(col in f)) return true;
        if (t === 'eq') return f[col] === val;
        if (t === 'in') return (val as unknown[]).includes(f[col]);
        return true;
    }));
}

let pagos: any[] = [];
function responderBase(c: Consulta): any {
    if (c.tabla === 'school_athletes') return { data: filtrar(ATLETAS, c) };
    if (c.tabla === 'teams') return { data: filtrar(EQUIPOS, c) };
    if (c.tabla === 'payments') return { data: filtrar(pagos, c) };
    return { data: [] };
}

const consultas = (): Consulta[] => (globalThis as any).__consultas;

function alcance(p: Partial<Alcance> = {}): Alcance {
    const a: Alcance = {
        schoolId: A, userId: 'duena', rol: 'admin', teamIds: [],
        ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false },
        hoy: HOY, canal: 'app', ...p,
    };
    Object.defineProperty(a, 'authorization', { value: null, enumerable: false });
    return a;
}
const admin = () => alcance();
const coach = (p: Partial<Alcance> = {}) => alcance({ userId: 'coach1', rol: 'coach', teamIds: [T1], ...p });

beforeEach(() => {
    h.responder = responderBase;
    pagos = [];
    consultas().length = 0;
    _reiniciarContadores();
    delete process.env.MAPI_SIN_MODELO;
});
afterEach(() => {
    delete process.env.MAPI_SIN_MODELO;
});

describe('deportistas: búsqueda, ambigüedad y fonética (sin modelo)', () => {
    it('«cuánto debe Samuel» responde con la cuenta, sin pasar por el modelo', async () => {
        pagos = [{ id: 'p1', child_id: SAMUEL, school_id: A, concept: 'Mensualidad noviembre', amount: 120000, amount_paid: 0, status: 'overdue', due_date: '2026-11-05', payment_type: 'monthly', payment_category: 'mensualidad', period_year: 2026, period_month: 11 }];
        const r = await responderSinModelo(admin(), { texto: 'cuánto debe Samuel?' }, 'app');
        expect(r.tipo).toBe('respuesta');
        const t = (r as any).texto as string;
        expect(t).toContain('**Samuel Ortiz**');
        expect(t).toContain('Mensualidad noviembre');
        expect(t).toMatch(/Debe \*\*\$120[.,]000\*\*/);
    });
    it('al día', async () => {
        const r = await responderSinModelo(admin(), { texto: 'samuel cuanto debe' }, 'whatsapp');
        expect((r as any).texto).toContain('*Samuel Ortiz*');
        expect((r as any).texto).toContain('Está al día');
    });
    it('dos «Mariana»: elegir con botones (máx. 3 + Otro), ids de consulta', async () => {
        const r = await responderSinModelo(admin(), { texto: 'cuánto debe Mariana' }, 'whatsapp');
        expect(r.tipo).toBe('elegir');
        const ops = (r as any).opciones as { id: string; titulo: string }[];
        expect(ops.map((o) => o.titulo)).toEqual(['Mariana López', 'Mariana Ruiz', 'Otro']);
        expect(ops[0].id).toBe(`mapi:q:d:child:${MARIANA_L}`);
        for (const o of ops) {
            expect(esBotonDeConsulta(o.id)).toBe(true);
            expect(parsearBotonMapi(o.id)).toBeNull(); // nunca un Confirmar/Cancelar
        }
    });
    it('el botón elegido responde con ESE deportista', async () => {
        const r = await responderSinModelo(admin(), { boton: `mapi:q:d:child:${MARIANA_R}` }, 'whatsapp');
        expect((r as any).texto).toContain('*Mariana Ruiz*');
        expect((r as any).capa).toBe(1);
    });
    it('en la app, elegir se escribe: la frase de cada opción', async () => {
        const r = await responderSinModelo(admin(), { texto: 'cómo va Mariana' }, 'app');
        const t = textoParaApp(r as any);
        expect(t).toContain('escribe «cómo va Mariana López»');
        expect(t).toContain('escribe «cómo va Mariana Ruiz»');
    });
    it('error de tecleo: sugerencia fonética para confirmar (no adivina)', async () => {
        const r = await responderSinModelo(admin(), { texto: 'cuánto debe Samuell Ortis' }, 'whatsapp');
        expect(r.tipo).toBe('elegir');
        expect((r as any).opciones[0].titulo).toBe('Samuel Ortiz');
    });
    it('sin resultados: «No encontré a…», sin modelo', async () => {
        const r = await responderSinModelo(admin(), { texto: 'cuánto debe Pedro Picapiedra' }, 'app');
        expect(r.tipo).toBe('respuesta');
        expect((r as any).texto).toBe('No encontré a «pedro picapiedra» en la escuela. Escríbeme nombre y apellido.');
    });
    it('«Otro» pide el nombre completo', async () => {
        const r = await responderSinModelo(admin(), { boton: 'mapi:q:o' }, 'whatsapp');
        expect((r as any).texto).toBe(TEXTOS_DIRECTO.otro);
    });
});

describe('permisos: el alcance manda', () => {
    it('el coach no ve cartera ni lo que debe alguien (ni por palabra ni por botón)', async () => {
        for (const texto of ['quién debe', 'cartera', 'cuánto debe Samuel', 'por validar', 'auditar', 'aprobación automática', 'por qué no se aprobó el de Samuel']) {
            const r = await responderSinModelo(coach(), { texto }, 'app');
            expect((r as any).texto, texto).toBe(TEXTOS_DIRECTO.soloAdminPlata);
        }
        for (const boton of ['mapi:m:cartera', 'mapi:m:validar', `mapi:q:d:child:${SAMUEL}`, 'mapi:q:p:dddddddd-0000-0000-0000-000000000001']) {
            const r = await responderSinModelo(coach(), { boton }, 'whatsapp');
            expect((r as any).texto, boton).toBe(TEXTOS_DIRECTO.soloAdminPlata);
        }
        expect(consultas().some((c) => c.tabla === 'payments')).toBe(false);
    });
    it('con coach_hide_financial_info: el resumen del coach no trae plata', async () => {
        pagos = [{ id: 'p1', child_id: SAMUEL, school_id: A, concept: 'Mensualidad', amount: 120000, amount_paid: 0, status: 'overdue', due_date: '2026-11-05' }];
        const r = await responderSinModelo(coach({ ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: true } }), { texto: 'cómo va Samuel' }, 'app');
        const t = (r as any).texto as string;
        expect(t).toContain('Samuel Ortiz');
        expect(t).not.toMatch(/\$|debe|Cuenta/i);
        expect(consultas().some((c) => c.tabla === 'payments')).toBe(false);
    });
    it('el coach solo ve a los de sus equipos', async () => {
        // Mariana Ruiz es de otro equipo: ni la encuentra ni se la sugiere (solo la de su equipo).
        const r = await responderSinModelo(coach(), { texto: 'cómo va Mariana Ruiz' }, 'whatsapp');
        expect(r.tipo).toBe('elegir');
        expect((r as any).texto).toBe('No encontré a «mariana ruiz» en tus equipos. ¿Es alguno de estos?');
        expect(((r as any).opciones as any[]).map((o) => o.titulo)).toEqual(['Mariana López', 'Otro']);
        // Las dos «Mariana»: solo la de su equipo, sin preguntar.
        const r2 = await responderSinModelo(coach(), { texto: 'cómo va Mariana' }, 'app');
        expect(r2.tipo).toBe('respuesta');
        expect((r2 as any).texto).toContain('Mariana López');
        // Por botón con el id de alguien de otro equipo: el rechazo de la herramienta.
        const r3 = await responderSinModelo(coach(), { boton: `mapi:q:r:child:${MARIANA_R}` }, 'whatsapp');
        expect((r3 as any).texto).toBe('Ese deportista no está en los equipos que entrenas.');
    });
    it('admin de la escuela B no ve a un deportista de A, ni con su id en un botón', async () => {
        const r = await responderSinModelo(alcance({ schoolId: B }), { boton: `mapi:q:d:child:${SAMUEL}` }, 'whatsapp');
        expect((r as any).texto).toBe('No encontré ese deportista en esta escuela.');
        const r2 = await responderSinModelo(alcance({ schoolId: B }), { texto: 'cuánto debe Samuel' }, 'app');
        expect((r2 as any).texto).toContain('No encontré a «samuel»');
        const deAtletas = consultas().filter((c) => c.tabla === 'school_athletes');
        expect(deAtletas.length).toBeGreaterThan(0);
        for (const c of deAtletas) expect(c.filtros).toContainEqual(['eq', 'school_id', B]);
    });
    it('herramienta apagada por flag: no se ofrece en el menú ni responde por palabra o botón', async () => {
        const t = CATALOGO.find((x) => x.nombre === 'torneos')!;
        const antes = t.habilitada;
        t.habilitada = () => false;
        try {
            expect(opcionesDelMenu(admin()).map((m) => m.clave)).not.toContain('torneos');
            const menu = await responderSinModelo(admin(), { texto: 'menú' }, 'whatsapp');
            expect(((menu as any).botones as any[]).map((b) => b.id)).not.toContain('mapi:m:torneos');
            expect((await responderSinModelo(admin(), { texto: 'torneos' }, 'app') as any).texto).toBe(TEXTOS_DIRECTO.noDisponible);
            expect((await responderSinModelo(admin(), { boton: 'mapi:m:torneos' }, 'whatsapp') as any).texto).toBe(TEXTOS_DIRECTO.noDisponible);
            expect(consultas().some((c) => c.tabla === 'events')).toBe(false);
        } finally {
            t.habilitada = antes;
        }
    });
    it('menú por rol: la administración primero lo de plata; el coach sin plata', () => {
        const adm = opcionesDelMenu(admin()).map((m) => m.clave);
        expect(adm.slice(0, 3)).toEqual(['cartera', 'validar', 'auditar']);
        const co = opcionesDelMenu(coach()).map((m) => m.clave);
        expect(co).toEqual(['asistencia', 'horarios', 'semana', 'prueba']);
    });
    it('menú de WhatsApp: ≤ 10 filas, ids `mapi:m:` que no confirman nada', async () => {
        const r = await responderSinModelo(admin(), { texto: 'hola' }, 'whatsapp');
        const b = (r as any).botones as { id: string }[];
        expect(b.length).toBeLessThanOrEqual(10);
        for (const x of b) {
            expect(x.id).toMatch(/^mapi:m:[a-z_]+$/);
            expect(parsearBotonMapi(x.id)).toBeNull();
        }
    });
});

describe('botones: solo consultas', () => {
    it('un id de confirmar o de una acción no ejecuta nada', async () => {
        for (const boton of ['mapi:c:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:ABCDEFGH', 'mapi:m:excusar_ausencia', 'mapi:m:dar_de_baja', 'mapi:q:x:algo', `mapi:q:d:child:no-es-uuid`]) {
            const r = await responderSinModelo(admin(), { boton }, 'whatsapp');
            expect((r as any).texto, boton).toBe(TEXTOS_DIRECTO.opcionVencida);
        }
        expect(consultas()).toHaveLength(0);
    });
});

describe('lo que no reconoce va al modelo', () => {
    it('acciones, compuestas y fuera de la escuela', async () => {
        for (const texto of ['excusa a Samuel mañana', 'quién debe y quién faltó', 'capital de Francia', 'aprueba los verdes']) {
            expect((await responderSinModelo(admin(), { texto }, 'app')).tipo, texto).toBe('al_modelo');
        }
        expect(consultas()).toHaveLength(0);
    });
    it('un «equipo» que no existe no se contesta a medias: va al modelo', async () => {
        expect((await responderSinModelo(admin(), { texto: 'horario del Real Madrid' }, 'app')).tipo).toBe('al_modelo');
        expect((await responderSinModelo(admin(), { texto: 'asistencia de hoy de Samuel' }, 'app')).tipo).toBe('al_modelo');
    });
    it('«cómo hago…» solo con una tarea clara del mapa', async () => {
        expect((await responderSinModelo(admin(), { texto: 'cómo hago una pizza' }, 'app')).tipo).toBe('al_modelo');
        expect((await responderSinModelo(admin(), { texto: 'dónde queda el estadio el campín' }, 'app')).tipo).toBe('al_modelo');
        expect(tareaUnicaDelMapa('school', 'como hago una pizza')).toBeNull();
        const r = await responderSinModelo(admin(), { texto: 'cómo hago para crear un equipo' }, 'app');
        expect(r.tipo).toBe('respuesta');
        expect((r as any).texto).toContain('**Crear un equipo**');
        expect((r as any).texto).toContain('Nuevo Equipo');
        // Dos tareas posibles («invitar a un entrenador» no es una sola): al modelo.
        expect((await responderSinModelo(admin(), { texto: 'cómo invito a un entrenador' }, 'app')).tipo).toBe('al_modelo');
    });
    it('MAPI_SIN_MODELO=false apaga todo', async () => {
        process.env.MAPI_SIN_MODELO = 'false';
        expect((await responderSinModelo(admin(), { texto: 'cuánto debe Samuel' }, 'app')).tipo).toBe('al_modelo');
        expect((await responderSinModelo(admin(), { boton: 'mapi:m:cartera' }, 'whatsapp')).tipo).toBe('al_modelo');
        expect(consultas()).toHaveLength(0);
    });
});

describe('equipos', () => {
    it('asistencia sin equipo: el coach con un solo equipo va directo', async () => {
        const r = await responderSinModelo(coach(), { texto: 'asistencia de hoy' }, 'app');
        expect(r.tipo).toBe('respuesta');
        expect((r as any).texto).toContain('Asistencia · Sub 12');
    });
    it('asistencia sin equipo para la administración: elegir el equipo', async () => {
        const r = await responderSinModelo(admin(), { texto: 'quién faltó ayer' }, 'whatsapp');
        expect(r.tipo).toBe('elegir');
        const ops = (r as any).opciones as { id: string; titulo: string }[];
        expect(ops.map((o) => o.titulo)).toEqual(['Sub 12', 'Tiburones', 'Otro']);
        expect(ops[0].id).toBe(`mapi:q:a:${T1}:2026-11-25`);
    });
    it('el coach no pide la asistencia de un equipo ajeno por botón', async () => {
        const r = await responderSinModelo(coach(), { boton: `mapi:q:a:${T2}:${HOY}` }, 'whatsapp');
        expect((r as any).texto).toBe('Ese equipo no está entre los que entrenas.');
    });
});

describe('contadores por capa (sin PII)', () => {
    it('cuenta capa 1, 2 y 3', async () => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await responderSinModelo(admin(), { texto: 'hola' }, 'whatsapp');
        await responderSinModelo(admin(), { boton: 'mapi:q:o' }, 'whatsapp');
        await responderSinModelo(admin(), { texto: 'escríbele a la mamá de Samuel' }, 'app');
        const c = contadoresDeCapas();
        expect(c['whatsapp|2|menu']).toBe(1);
        expect(c['whatsapp|1|otro']).toBe(1);
        expect(c['app|3|-']).toBe(1);
        const logs = JSON.stringify(log.mock.calls);
        expect(logs).not.toMatch(/Samuel|mam/);
        log.mockRestore();
    });
});

describe('plantillas: nada sensible', () => {
    it('tapa teléfonos, correos y marcas de dato no confiable', () => {
        expect(P.limpio('<dato_no_confiable campo="x">Llamar al 300 123 4567 o a pepe@correo.com</dato_no_confiable>'))
            .toBe('Llamar al [número] o a [correo]');
        expect(P.limpio('**negrita** inyectada')).toBe('negrita inyectada');
        expect(P.limpio('$1.200.000')).toBe('$1.200.000');
    });
    it('asistencia: quién avisó, nunca el motivo', () => {
        const t = P.plantillaAsistencia({
            equipo: 'Sub 12', fecha: 'jueves 26 de noviembre de 2026', lista: 'abierta',
            resumen: { vinieron: 1, tarde: 0, faltaron: 1, con_excusa: 0, sin_marca: 0, en_la_lista: 2 },
            deportistas: [{ nombre: 'Ana', estado: 'Vino' }, { nombre: 'Luis', estado: 'Faltó', aviso: 'avisó la familia: cita médica por asma' }],
        }, 'whatsapp');
        expect(t).toContain('Luis (la familia)');
        expect(t).not.toMatch(/asma|médica/);
    });
    it('reservas: sin las notas de quien reservó', () => {
        const t = P.plantillaReservas({ fecha: 'hoy', instalaciones: [{ nombre: 'Cancha 1', libre: ['08:00–10:00'], reservas: [{ hora: '10:00–11:00', a_nombre_de: '<dato_no_confiable campo="a_nombre_de">Carlos</dato_no_confiable>', estado: 'confirmada', notas: 'mi cel 3001234567' }] }] }, 'app');
        expect(t).toContain('Carlos');
        expect(t).not.toContain('3001234567');
        expect(t).not.toContain('dato_no_confiable');
    });
    it('WhatsApp: negrita con un asterisco y sin tablas; app: doble', () => {
        const d = { vencido: { total: '$100', familias: 1, deportistas: 1, cobros: 1 }, familias_que_mas_deben: [{ familia: 'Pérez', total: '$100', meses: ['nov'], dias_de_mora: 3 }], por_vencer: { total: '$0', familias: 0 }, comprobantes_en_revision: { cobros: 0 } };
        const wa = P.plantillaCartera(d, 'whatsapp', null);
        expect(wa).toContain('*Cartera*');
        expect(wa).not.toContain('**');
        expect(wa).not.toContain('|');
        expect(P.plantillaCartera(d, 'app', null)).toContain('**Cartera**');
    });
    it('no se cuelan nombres internos de herramientas', () => {
        expect(P.sinNombresInternos('Revísalos con auditar_pendientes.')).toBe('Revísalos con «auditar comprobantes».');
    });
});
