import { describe, it, expect } from 'vitest';
import { APP_MAP, appMapParaRol } from './app-map';
import { helpArticles } from './help-articles';

describe('app-map', () => {
    it('cada rol del mapa se renderiza no vacío', () => {
        for (const key of Object.keys(APP_MAP)) {
            const txt = appMapParaRol([key]);
            expect(txt.length, key).toBeGreaterThan(100);
            expect(txt).toContain(APP_MAP[key].rol);
        }
    });

    it('el coach sabe cómo editar un equipo', () => {
        const txt = appMapParaRol(['coach']);
        expect(txt).toContain('Editar Equipo');
        expect(txt).toContain('Guardar Cambios');
    });

    it('todo slug de articulo existe en helpArticles', () => {
        const slugs = new Set(helpArticles.map((a) => a.slug));
        for (const r of Object.values(APP_MAP)) {
            for (const t of r.tareas) {
                if (t.articulo) expect(slugs.has(t.articulo), t.articulo).toBe(true);
            }
        }
    });

    it('ignora roles desconocidos y devuelve vacío si no hay ninguno', () => {
        expect(appMapParaRol(['nadie'])).toBe('');
        expect(appMapParaRol([])).toBe('');
        expect(appMapParaRol(['nadie', 'parent'])).toContain('Acudiente');
    });

    it('deduplica roles y alias', () => {
        const txt = appMapParaRol(['school', 'school_admin', 'owner', 'school']);
        expect(txt.split('### ').length - 1).toBe(1);
        const vendor = appMapParaRol(['external_vendor', 'store_owner']);
        expect(vendor.split('### ').length - 1).toBe(1);
    });

    it('al coach no se le ofrece eliminar equipos ni Invitaciones', () => {
        const coach = APP_MAP.coach;
        const tareas = coach.tareas.map((t) => `${t.tarea} ${t.pasos}`).join('\n');
        expect(tareas).not.toMatch(/Eliminar permanente|Archivar|Invitaciones/);
    });

    it('se mantiene compacto (~4 chars/token)', () => {
        for (const key of Object.keys(APP_MAP)) {
            const limite = key === 'school' ? 4500 * 4 : 2500 * 4;
            expect(appMapParaRol([key]).length, key).toBeLessThan(limite);
        }
    });
});

describe('app-map con la pregunta del usuario', () => {
    it('detalla la tarea que viene al caso y resume el resto', () => {
        const txt = appMapParaRol(['school'], 'ASISTENCIAS');
        expect(txt).toMatch(/asistencia/i);
        expect(txt).toContain('Otras tareas que también puede hacer');
        expect(txt.length).toBeLessThan(appMapParaRol(['school']).length);
    });

    it('el mapa de escuela con pregunta cabe holgado en el tope de Groq (~2.000 tokens)', () => {
        expect(appMapParaRol(['school'], 'crear pagos').length).toBeLessThan(2000 * 4);
    });

    it('editar el nombre del equipo sigue llegando con sus pasos', () => {
        expect(appMapParaRol(['coach'], 'quiero editar el nombre de mi equipo')).toContain('Guardar Cambios');
    });
});

describe('app-map V2 (entrenador, acudiente, deportista)', () => {
    // 2026-10-27: Mapi respondía «Asistencias > Supervisión», «Equipos Regulares»
    // y «menú lateral, sección Seguimiento» con la V2 prendida.
    const sinVistaAnterior = (rol: string, consulta?: string) =>
        appMapParaRol([rol], consulta).split('VISTA ANTERIOR')[0];

    it('la asistencia del coach va por la pestaña Asistencia, no por Supervisión', () => {
        const txt = sinVistaAnterior('coach', 'cómo tomo asistencia');
        expect(txt).toContain('Tomar lista');
        expect(txt).toContain('Guardar lista');
        expect(txt).not.toMatch(/Supervisión|Equipos Regulares|Gestión >/);
    });

    it('el pago del acudiente va por la pestaña Pagos, sin secciones del menú viejo', () => {
        const txt = sinVistaAnterior('parent', 'cómo pago la mensualidad');
        expect(txt).toContain('Pestaña Pagos');
        expect(txt).not.toMatch(/Seguimiento|Mi Actividad|Calendario Familiar|"Pendientes"/);
    });

    it('describe las pestañas V2 de cada rol', () => {
        expect(appMapParaRol(['coach'])).toContain('Hoy · Equipos · Sesiones · Asistencia · Más');
        expect(appMapParaRol(['parent'])).toContain('Inicio · Calendario · Hijos · Pagos · Más');
        expect(appMapParaRol(['athlete'])).toContain('Hoy · Entrenos · Progreso · Carnet · Más');
    });

    it('Más del coach ya trae Pizarra en Entrenamiento y el grupo Comunicación', () => {
        const txt = appMapParaRol(['coach']);
        expect(txt).toContain('Entrenamiento (Pizarra,');
        expect(txt).toContain('Comunicación (Mensajes, Anuncios, Encuestas)');
        expect(txt).not.toContain('Se usan poco');
    });

    it('la vista anterior viaja aparte y marcada como plan B', () => {
        for (const rol of ['coach', 'parent', 'athlete']) {
            expect(appMapParaRol([rol])).toContain('VISTA ANTERIOR (úsala SOLO si el usuario dice que no ve esas pestañas)');
        }
        expect(appMapParaRol(['school'])).not.toContain('VISTA ANTERIOR');
    });

    it('la configuración personal apunta a la entrada de Más de cada rol', () => {
        expect(appMapParaRol(['parent'], 'cambiar contraseña')).toContain('Más > "Mi cuenta" > pestaña "Seguridad"');
        expect(appMapParaRol(['coach'], 'cambiar contraseña')).toContain('Más > "Mis datos y configuración" > pestaña "Seguridad"');
    });
});
