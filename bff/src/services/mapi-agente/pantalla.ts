/**
 * Contexto de pantalla (plan §3.3): «dame el reporte de ESTA niña» con la
 * ficha abierta. El front manda `{ ruta, entidad? }` con cada mensaje y el BFF
 * valida que la entidad sea de la escuela de la sesión (y de los equipos del
 * coach) ANTES de dársela al modelo. Lo que no valida se descarta en silencio:
 * el turno sigue sin entidad.
 */

import { supabase } from '../../config/supabase';
import { resolverDeportista } from './deportistas';
import { fechaLarga } from './fechas';
import type { Alcance } from './tipos';

export interface PantallaValidada {
    ruta: string | null;
    entidad: { tipo: 'deportista'; clave: string; nombre: string } | { tipo: 'equipo'; id: string; nombre: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function validarPantalla(a: Alcance, cruda: unknown): Promise<PantallaValidada | null> {
    if (!cruda || typeof cruda !== 'object') return null;
    const c = cruda as Record<string, any>;
    const ruta = typeof c.ruta === 'string' && c.ruta.startsWith('/') && c.ruta.length <= 200
        ? c.ruta.replace(/[^\w\-/.:]/g, '') : null;
    let entidad: PantallaValidada['entidad'] = null;
    const e = c.entidad;
    try {
        if (e?.tipo === 'deportista' && typeof e.id === 'string') {
            const d = await resolverDeportista(a, e.id);
            entidad = { tipo: 'deportista', clave: d.clave, nombre: d.nombre };
        } else if (e?.tipo === 'equipo' && typeof e.id === 'string' && UUID.test(e.id)) {
            if (a.rol === 'admin' || a.teamIds.includes(e.id)) {
                const { data } = await supabase.from('teams').select('id, name').eq('school_id', a.schoolId).eq('id', e.id).maybeSingle();
                if (data) entidad = { tipo: 'equipo', id: (data as any).id, nombre: (data as any).name };
            }
        }
    } catch {
        entidad = null; // de otra escuela, de otro equipo o inválida: no se pasa
    }
    return ruta || entidad ? { ruta, entidad } : null;
}

/** Bloque que va en el mensaje del turno (después del corte de caché). */
export async function contextoDelTurno(a: Alcance, pantalla: PantallaValidada | null, nombre: string | null): Promise<string> {
    const lineas = [
        `Hoy: ${fechaLarga(a.hoy)} (${a.hoy}), hora de Colombia.`,
        `Quién escribe: ${nombre || 'usuario'} · ${a.rol === 'admin' ? 'administración de la escuela' : 'entrenador'}`,
    ];
    if (a.rol === 'coach') {
        if (!a.teamIds.length) lineas.push('Equipos que entrena: ninguno asignado todavía.');
        else {
            const { data } = await supabase.from('teams').select('name').eq('school_id', a.schoolId).in('id', a.teamIds);
            const nombres = ((data as any[]) ?? []).map((t) => t.name).filter(Boolean);
            lineas.push(`Equipos que entrena: ${nombres.join(', ') || '(sin nombre)'}`);
        }
        // Evals 2026-11-24: sin la segunda mitad, Mapi le ofrecía al coach decirle
        // «si está al día», un dato que no tiene y que podría inventar.
        lineas.push('El entrenador no ve montos ni cobros, ni si alguien está al día o debe: no le ofrezcas ese dato.');
    }
    if (pantalla?.ruta) lineas.push(`Pantalla abierta: ${pantalla.ruta}`);
    if (pantalla?.entidad?.tipo === 'deportista') lineas.push(`En pantalla: deportista ${pantalla.entidad.nombre} (id ${pantalla.entidad.clave})`);
    if (pantalla?.entidad?.tipo === 'equipo') lineas.push(`En pantalla: equipo ${pantalla.entidad.nombre} (id ${pantalla.entidad.id})`);
    return `<contexto_del_turno>\n${lineas.join('\n')}\n</contexto_del_turno>`;
}
