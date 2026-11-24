/**
 * solicitudes-union-avisos.job — aviso por WhatsApp a la administración cuando hay
 * solicitudes de unión por código sin atender, y recordatorio a las 24 h.
 *
 * Por qué (auditoría de registros 19-22 nov 2026): Monster's Volley Club tenía 4
 * solicitudes sin atender (la más vieja del 5-nov). El aviso existente es solo
 * in-app y se pierde; las notificaciones internas no se leen (6 de 6 sin leer).
 *
 * Qué hace, cada pocos minutos:
 *   · Aviso inicial: solicitudes pendientes con `wa_aviso_at` nulo → UN mensaje por
 *     escuela («N familias esperan que las aceptes»), no uno por solicitud.
 *   · Recordatorio: solicitudes pendientes que ya se avisaron, llevan >= 24 h y no
 *     tienen `wa_recordatorio_at` → un segundo mensaje, UNA sola vez.
 *   Si en una corrida una escuela tiene de las dos clases, sale solo el aviso inicial
 *   (el recordatorio espera a la siguiente: nunca dos mensajes juntos a la misma escuela).
 *
 * Canal: WhatsApp de plataforma (`avisarPorPlataforma`), tipo `escalacion`, plantilla
 * UTILITY ya aprobada `sm_caso_por_atender` ({{1}} escuela · {{2}} qué pasó). Llega a
 * quienes tienen una suscripción ACTIVA de la escuela (owner/admin/school_admin) y
 * respeta el silencio nocturno, el interruptor del canal y la lista de escuelas
 * habilitadas. Nada se aprueba desde WhatsApp: el botón lleva a «Por asignar».
 *
 * Marcado honesto: `wa_aviso_at` / `wa_recordatorio_at` solo se escriben si el aviso
 * SALIÓ (o ya lo había enviado otro BFF: duplicado). Si el canal está apagado, la
 * escuela no está habilitada, no hay suscriptores o era hora de silencio, no se marca
 * y se reintenta en la siguiente corrida. Sin mensajes: el aviso in-app de siempre
 * sigue ahí.
 *
 * Disk IO: dos lecturas en lote (solicitudes por avisar; pendientes por escuela) y
 * una de nombres de escuela con `.in(...)`. Sin consultas por fila. Escrituras solo
 * cuando un aviso salió.
 *
 * Idempotencia entre los 3 BFF: la reserva (suscripcion_id + clave) de
 * `platform_wa_envios`. La clave incluye el tipo y la solicitud más reciente del
 * lote, así que un lote igual nunca se envía dos veces.
 *
 * Privacidad: el mensaje no lleva nombres de deportistas ni de acudientes, solo la
 * cantidad.
 */

import { supabase } from '../config/supabase';
import {
    avisarPorPlataforma, canalHabilitado,
    type AvisoPlataforma, type ResultadoAviso,
} from '../services/plataforma-wa.service';
import { PLANTILLAS_PLATAFORMA } from '../services/plataforma-wa-avisos.service';

/** Cuánto espera una solicitud pendiente antes del recordatorio. */
export const ESPERA_RECORDATORIO_MS = 24 * 3600_000;
/** Tope de solicitudes que se leen por corrida (más allá, las siguientes corridas las recogen). */
const LIMITE = 2000;
export const RUTA_BANDEJA = '/students?bandeja=por-asignar';

export interface SolicitudPendiente {
    id: string;
    school_id: string;
    created_at: string;
    wa_aviso_at: string | null;
    wa_recordatorio_at: string | null;
}

export type EtapaAviso = 'inicial' | 'recordatorio';

export interface AvisoDeEscuela {
    schoolId: string;
    etapa: EtapaAviso;
    /** Solicitudes que este aviso marca al salir. */
    ids: string[];
    /**
     * Solo en el aviso inicial: de `ids`, las que ya llevan >= 24 h. Se marcan también como
     * recordadas: el recordatorio no sale pegado al aviso.
     */
    idsYaVencidas: string[];
    /** Todas las pendientes de la escuela (lo que dice el mensaje). */
    totalPendientes: number;
    /** La más reciente del lote: ancla de la clave de idempotencia. */
    ancla: string;
}

/** ¿Debe este job correr en este proceso? Misma regla que los demás resúmenes. Pura. */
export function solicitudesUnionAvisosActivo(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.DISABLE_SOLICITUDES_UNION_AVISOS === 'true') return false;
    if (env.NODE_ENV === 'production') return true;
    return env.SOLICITUDES_UNION_AVISOS_FUERA_DE_PROD === 'true';
}

/**
 * Decide qué avisar a cada escuela. Pura.
 *  - inicial: hay solicitudes sin `wa_aviso_at`.
 *  - recordatorio: ya se avisaron, llevan >= 24 h y no se les recordó, y NO hay
 *    iniciales pendientes en la misma escuela.
 */
export function planearAvisos(
    solicitudes: SolicitudPendiente[],
    totalesPorEscuela: Map<string, number>,
    ahora: number,
): AvisoDeEscuela[] {
    const porEscuela = new Map<string, SolicitudPendiente[]>();
    for (const s of solicitudes) {
        const lista = porEscuela.get(s.school_id) ?? [];
        lista.push(s);
        porEscuela.set(s.school_id, lista);
    }

    const avisos: AvisoDeEscuela[] = [];
    for (const [schoolId, lista] of porEscuela) {
        const iniciales = lista.filter((s) => !s.wa_aviso_at);
        const recordables = lista.filter((s) =>
            s.wa_aviso_at && !s.wa_recordatorio_at
            && ahora - new Date(s.created_at).getTime() >= ESPERA_RECORDATORIO_MS);
        const elegidas = iniciales.length > 0 ? iniciales : recordables;
        if (elegidas.length === 0) continue;
        const etapa: EtapaAviso = iniciales.length > 0 ? 'inicial' : 'recordatorio';
        const ancla = elegidas.reduce((mx, s) => (s.created_at > mx ? s.created_at : mx), elegidas[0].created_at);
        avisos.push({
            schoolId,
            etapa,
            ids: elegidas.map((s) => s.id),
            idsYaVencidas: etapa === 'inicial'
                ? elegidas.filter((s) => ahora - new Date(s.created_at).getTime() >= ESPERA_RECORDATORIO_MS).map((s) => s.id)
                : [],
            totalPendientes: Math.max(totalesPorEscuela.get(schoolId) ?? 0, elegidas.length),
            ancla,
        });
    }
    return avisos;
}

/** «1 familia espera…» / «3 familias esperan…». Pura. */
export function textoDelAviso(etapa: EtapaAviso, total: number): { titulo: string; cuerpo: string } {
    const plural = total !== 1;
    const quien = plural ? `${total} familias esperan` : '1 familia espera';
    if (etapa === 'recordatorio') {
        return {
            titulo: `${quien} tu respuesta desde hace más de un día`,
            cuerpo: `${quien} que las aceptes. Abre Estudiantes → Por asignar y asígnales su categoría.`,
        };
    }
    return {
        titulo: `${quien} que las aceptes`,
        cuerpo: `Abre Estudiantes → Por asignar y asígnales su categoría.`,
    };
}

/** El aviso de plataforma de una escuela. Pura. */
export function avisoDePlataforma(a: AvisoDeEscuela, escuela: string): AvisoPlataforma {
    const { titulo, cuerpo } = textoDelAviso(a.etapa, a.totalPendientes);
    return {
        tipo: 'escalacion',
        schoolId: a.schoolId,
        clave: `union:${a.schoolId}:${a.etapa}:${a.ancla}`,
        urgente: false,
        texto: `*Solicitudes para unirse* — ${escuela}\n${cuerpo}`,
        ruta: RUTA_BANDEJA,
        plantilla: { nombre: PLANTILLAS_PLATAFORMA.caso, variables: [escuela, titulo] },
    };
}

/** ¿El resultado cuenta como «salió»? Un duplicado es de otro BFF que ya lo envió. Pura. */
export function avisoSalio(r: ResultadoAviso): boolean {
    return r.enviados > 0 || r.duplicados > 0;
}

export interface DepsAvisosUnion {
    canalHabilitado: () => Promise<boolean>;
    leerSolicitudes: (haceUnDiaIso: string) => Promise<SolicitudPendiente[]>;
    contarPendientes: (schoolIds: string[]) => Promise<Map<string, number>>;
    nombresDeEscuelas: (schoolIds: string[]) => Promise<Map<string, string>>;
    avisar: (a: AvisoPlataforma, ahora: number) => Promise<ResultadoAviso>;
    marcar: (etapa: EtapaAviso, ids: string[], ahoraIso: string) => Promise<void>;
}

const DEPS: DepsAvisosUnion = {
    canalHabilitado,
    async leerSolicitudes(haceUnDiaIso) {
        const { data, error } = await supabase
            .from('school_join_requests')
            .select('id, school_id, created_at, wa_aviso_at, wa_recordatorio_at')
            .eq('status', 'pending')
            .or(`wa_aviso_at.is.null,and(wa_recordatorio_at.is.null,created_at.lte.${haceUnDiaIso})`)
            .order('created_at', { ascending: true })
            .limit(LIMITE);
        if (error) {
            // Migración sin aplicar (columnas inexistentes): el job simplemente no hace nada.
            console.warn('[solicitudes-union-avisos] no se pudieron leer las solicitudes', { err: error.message });
            return [];
        }
        return (data ?? []) as SolicitudPendiente[];
    },
    async contarPendientes(schoolIds) {
        const out = new Map<string, number>();
        if (schoolIds.length === 0) return out;
        const { data } = await supabase
            .from('school_join_requests')
            .select('school_id')
            .eq('status', 'pending')
            .in('school_id', schoolIds)
            .limit(LIMITE * 2);
        for (const r of (data ?? []) as Array<{ school_id: string }>) {
            out.set(r.school_id, (out.get(r.school_id) ?? 0) + 1);
        }
        return out;
    },
    async nombresDeEscuelas(schoolIds) {
        const out = new Map<string, string>();
        if (schoolIds.length === 0) return out;
        const { data } = await supabase.from('schools').select('id, name').in('id', schoolIds);
        for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) out.set(r.id, r.name || 'tu escuela');
        return out;
    },
    avisar: (a, ahora) => avisarPorPlataforma(a, ahora),
    async marcar(etapa, ids, ahoraIso) {
        if (ids.length === 0) return;
        const cambios = etapa === 'inicial' ? { wa_aviso_at: ahoraIso } : { wa_recordatorio_at: ahoraIso };
        const { error } = await supabase.from('school_join_requests').update(cambios).in('id', ids);
        if (error) console.warn('[solicitudes-union-avisos] no se pudo marcar', { etapa, err: error.message });
    },
};

export interface ResultadoCorrida {
    escuelas: number;
    avisadas: number;
    omitidas: number;
}

export async function runSolicitudesUnionAvisos(
    opts: { ahora?: number; deps?: Partial<DepsAvisosUnion> } = {},
): Promise<ResultadoCorrida> {
    const ahora = opts.ahora ?? Date.now();
    const d = { ...DEPS, ...(opts.deps ?? {}) };
    const r: ResultadoCorrida = { escuelas: 0, avisadas: 0, omitidas: 0 };

    // Canal apagado: ni siquiera se lee la base.
    if (!(await d.canalHabilitado())) return r;

    const solicitudes = await d.leerSolicitudes(new Date(ahora - ESPERA_RECORDATORIO_MS).toISOString());
    if (solicitudes.length === 0) return r;

    const schoolIds = [...new Set(solicitudes.map((s) => s.school_id))];
    const [totales, nombres] = await Promise.all([d.contarPendientes(schoolIds), d.nombresDeEscuelas(schoolIds)]);
    const avisos = planearAvisos(solicitudes, totales, ahora);
    r.escuelas = avisos.length;

    for (const a of avisos) {
        try {
            const res = await d.avisar(avisoDePlataforma(a, nombres.get(a.schoolId) ?? 'tu escuela'), ahora);
            if (avisoSalio(res)) {
                const ahoraIso = new Date(ahora).toISOString();
                await d.marcar(a.etapa, a.ids, ahoraIso);
                // Un aviso inicial sobre solicitudes de >= 24 h ya hace de recordatorio.
                if (a.idsYaVencidas.length > 0) await d.marcar('recordatorio', a.idsYaVencidas, ahoraIso);
                r.avisadas++;
            } else {
                r.omitidas++;
            }
        } catch (e: any) {
            r.omitidas++;
            console.warn('[solicitudes-union-avisos] falló una escuela', { schoolId: a.schoolId, err: e?.message || String(e) });
        }
    }
    return r;
}
