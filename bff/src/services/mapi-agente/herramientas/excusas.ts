/**
 * Acciones de la oleada 1: excusar y quitar una excusa (plan §4, §11).
 *
 * `excusar_ausencia` escribe filas en `athlete_absence_notices` con
 * source='staff' y reported_by = quien confirma. La lista del coach ya las
 * precarga como «excusado». No toca créditos de sesión ni cobros.
 *
 * Reglas aprobadas el 2026-11-23 (plan §11.2 y §11.3):
 *   · Admin: hasta 30 días atrás y 90 adelante. Coach: 7 atrás y 31 adelante.
 *   · Máximo 31 días por excusa.
 *   · Se guardan todos los días del rango (la excusa sigue valiendo si cambia
 *     el horario del equipo).
 *   · Si la familia ya avisó un día, su aviso se respeta y la vista previa lo dice.
 *   · Se avisa a la familia por app, correo y WhatsApp (aviso-familia.ts).
 *   · quitar_excusa: el admin quita cualquier aviso; el coach solo los que puso
 *     la escuela (source='staff').
 */

import { z } from 'zod';
import { supabase } from '../../../config/supabase';
import { resolverDeportista, columnaDe, type Deportista } from '../deportistas';
import { esFechaIso, diasDelRango, diferenciaDias, rangoLegible, fechaCorta } from '../fechas';
import { avisarFamiliaExcusa, type ResultadoAvisoFamilia } from '../aviso-familia';
import { RechazoHerramienta, type Alcance, type HerramientaAccion } from '../tipos';

export const MOTIVOS = ['enfermedad', 'cita_medica', 'viaje', 'lesion', 'colegio', 'familiar', 'otro'] as const;
const MOTIVO_LEGIBLE: Record<string, string> = {
    enfermedad: 'enfermedad', cita_medica: 'cita médica', viaje: 'viaje', lesion: 'lesión',
    colegio: 'colegio', familiar: 'asunto familiar', otro: 'otro',
};

export const LIMITES = {
    admin: { atras: 30, adelante: 90 },
    coach: { atras: 7, adelante: 31 },
    maxDias: 31,
} as const;

/** Valida el rango contra las reglas del rol. Devuelve el motivo del rechazo o null. Pura. */
export function errorDeRango(a: Pick<Alcance, 'rol' | 'hoy'>, desde: string, hasta: string): string | null {
    if (!esFechaIso(desde) || !esFechaIso(hasta)) return 'Las fechas tienen que venir como AAAA-MM-DD.';
    if (hasta < desde) return 'La fecha final es anterior a la inicial.';
    const dias = diferenciaDias(desde, hasta) + 1;
    if (dias > LIMITES.maxDias) return `Una excusa puede cubrir máximo ${LIMITES.maxDias} días; esta tiene ${dias}. Divídela en partes.`;
    const lim = LIMITES[a.rol];
    if (diferenciaDias(desde, a.hoy) > lim.atras) {
        return a.rol === 'coach'
            ? `Como entrenador puedes excusar hasta ${lim.atras} días atrás. Para fechas anteriores, pídeselo a la administración.`
            : `Se puede excusar hasta ${lim.atras} días atrás.`;
    }
    if (diferenciaDias(a.hoy, hasta) > lim.adelante) return `Se puede excusar hasta ${lim.adelante} días adelante.`;
    return null;
}

function sujeto(d: Deportista) {
    if (d.tipo === 'unregistered') {
        throw new RechazoHerramienta(`${d.nombre} es una ficha sin cuenta: los avisos de ausencia necesitan una ficha con cuenta. Márcalo «excusado» en la lista del día.`);
    }
    const col = columnaDe(d.tipo) as 'child_id' | 'user_id';
    return { col, fila: { child_id: d.tipo === 'child' ? d.id : null, user_id: d.tipo === 'adult' ? d.id : null } };
}

async function avisosActivos(a: Alcance, d: Deportista, desde: string, hasta: string) {
    const { col } = sujeto(d);
    const { data, error } = await supabase.from('athlete_absence_notices')
        .select('id, absence_date, source')
        .eq('school_id', a.schoolId).eq(col, d.id).eq('status', 'active')
        .gte('absence_date', desde).lte('absence_date', hasta);
    if (error) throw new Error(error.message);
    return ((data as any[]) ?? []).map((r) => ({ id: r.id as string, dia: String(r.absence_date).slice(0, 10), source: String(r.source) }));
}

const habilitadaCoach = (a: Alcance) => a.rol === 'admin' || a.ajustes.coachMapiAttendance;

// ─── excusar_ausencia ───────────────────────────────────────────────────────

export interface ArgsExcusar {
    deportista: string;
    desde: string;
    hasta: string;
    motivo: (typeof MOTIVOS)[number];
    nota?: string;
}

const esquemaExcusar = z.object({
    deportista: z.string().min(5).max(80),
    desde: z.string(),
    hasta: z.string(),
    motivo: z.enum(MOTIVOS),
    nota: z.string().trim().max(300).optional(),
});

export const excusarAusencia: HerramientaAccion<ArgsExcusar> = {
    tipo: 'accion',
    nombre: 'excusar_ausencia',
    descripcion: 'PREPARA la excusa de un deportista por uno o varios días (no la ejecuta: la persona confirma en la tarjeta). El entrenador la verá «excusada» en la lista. No descuenta clases ni toca cobros. Para un solo día usa la misma fecha en desde y hasta.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista (ej. "child:…")' },
            desde: { type: 'string', description: 'Primer día, AAAA-MM-DD' },
            hasta: { type: 'string', description: 'Último día, AAAA-MM-DD (igual a desde si es un día)' },
            motivo: { type: 'string', enum: [...MOTIVOS] },
            nota: { type: 'string', description: 'Opcional, corta (máx. 300 caracteres)' },
        },
        required: ['deportista', 'desde', 'hasta', 'motivo'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    habilitada: habilitadaCoach,
    validar(args) {
        const r = esquemaExcusar.safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Faltan datos para la excusa: deportista, desde, hasta (AAAA-MM-DD) y motivo.');
        return { ...r.data, nota: r.data.nota || undefined };
    },
    async preparar(a, args) {
        const malRango = errorDeRango(a, args.desde, args.hasta);
        if (malRango) return { ok: false, motivo: malRango };
        const d = await resolverDeportista(a, args.deportista);
        sujeto(d);
        const dias = diasDelRango(args.desde, args.hasta);
        const ya = await avisosActivos(a, d, args.desde, args.hasta);
        const yaDias = new Set(ya.map((x) => x.dia));
        const nuevos = dias.filter((x) => !yaDias.has(x));
        if (!nuevos.length) return { ok: false, motivo: `Todos esos días ya tienen aviso de ausencia de ${d.nombre}.` };

        const deFamilia = ya.filter((x) => x.source !== 'staff').map((x) => fechaCorta(x.dia));
        // La tarjeta cuenta los días que ESTA excusa agrega: antes decía «3 días» y el
        // resultado «2 días» cuando la familia ya había avisado uno (evals 11-25).
        const cuantos = nuevos.length === dias.length
            ? `${dias.length} ${dias.length === 1 ? 'día' : 'días'}`
            : `se excusan ${nuevos.length} de ${dias.length} días`;
        const lineas = [
            `${rangoLegible(args.desde, args.hasta)[0].toUpperCase()}${rangoLegible(args.desde, args.hasta).slice(1)} · ${cuantos}`,
            `Motivo: ${MOTIVO_LEGIBLE[args.motivo]}${args.nota ? ` · «${args.nota}»` : ''}`,
            ...(deFamilia.length ? [`${deFamilia.join(', ')}: ya lo había avisado la familia. Ese aviso se respeta.`] : []),
            'El entrenador lo verá «excusado» en la lista.',
            'No descuenta clases ni toca cobros.',
            'A la familia le llega el aviso por la app, por correo y por WhatsApp (si escribió en las últimas 24 horas).',
        ];
        return {
            ok: true,
            args,
            targetKey: `deportista:${d.clave}`,
            vista: {
                titulo: `Excusar a ${d.nombre}`,
                lineas,
                aviso: 'Puedes quitar la excusa después.',
                botonConfirmar: 'Confirmar',
            },
            huella: { deportista: d.clave, nuevos, motivo: args.motivo, nota: args.nota ?? null },
        };
    },
    async ejecutar(a, args) {
        const d = await resolverDeportista(a, args.deportista);
        const { fila } = sujeto(d);
        const base = {
            school_id: a.schoolId, ...fila, reason: args.motivo, note: args.nota ?? null,
            source: 'staff', status: 'active', reported_by: a.userId,
        };
        const dias = diasDelRango(args.desde, args.hasta);
        // El índice único es parcial sobre COALESCE(child_id, user_id): upsert no
        // puede usarlo. Se leen los avisos activos, se insertan solo los días que
        // faltan y, si choca (la familia avisó en ese instante), se relee y se
        // reintenta UNA vez (plan §11.3).
        let insertados: string[] = [];
        for (let intento = 0; intento < 2; intento++) {
            const ya = new Set((await avisosActivos(a, d, args.desde, args.hasta)).map((x) => x.dia));
            const faltan = dias.filter((x) => !ya.has(x) && !insertados.includes(x));
            if (!faltan.length) break;
            const { error } = await supabase.from('athlete_absence_notices').insert(faltan.map((absence_date) => ({ ...base, absence_date })));
            if (!error) { insertados = [...insertados, ...faltan]; break; }
            if ((error as any).code !== '23505' || intento === 1) {
                return { estado: insertados.length ? 'partial' : 'failed', resultado: { error: error.message, dias_excusados: insertados.length } };
            }
        }
        if (!insertados.length) return { estado: 'failed', resultado: { motivo: 'Todos esos días ya tenían aviso.' } };

        let familia: ResultadoAvisoFamilia | { error: string };
        try {
            familia = await avisarFamiliaExcusa({ schoolId: a.schoolId, deportista: d, desde: args.desde, hasta: args.hasta, motivo: args.motivo });
        } catch (err: any) {
            familia = { error: err?.message || 'aviso a la familia falló' };
        }
        return { estado: 'executed', resultado: { nombre: d.nombre, dias_excusados: insertados.length, desde: args.desde, hasta: args.hasta, familia } };
    },
    mensajeResultado(r, args) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se pudo registrar la excusa. ${x.motivo || 'Intenta de nuevo o hazlo desde la lista del día.'}`;
        const base = `Quedó registrada la excusa de ${x.nombre} ${rangoLegible(args.desde, args.hasta)} (${x.dias_excusados} ${x.dias_excusados === 1 ? 'día' : 'días'}).`;
        if (r.estado === 'partial') return `${base} Algunos días no se pudieron guardar; revisa la lista.`;
        return `${base} ${lineaFamilia(x.familia)}`;
    },
};

const CANAL: Record<string, string> = {
    enviado: 'enviado', sin_destinatario: 'sin acudiente con cuenta', sin_dato: 'sin dato de contacto',
    ventana_cerrada: 'no salió (no ha escrito en 24 h)', sin_integracion: 'la escuela no tiene WhatsApp conectado', fallo: 'falló',
};

export function lineaFamilia(f: any): string {
    if (!f || f.error) return 'El aviso a la familia no se pudo enviar.';
    return `Aviso a la familia — app: ${CANAL[f.app] ?? f.app} · correo: ${CANAL[f.correo] ?? f.correo} · WhatsApp: ${CANAL[f.whatsapp] ?? f.whatsapp}.`;
}

// ─── quitar_excusa ──────────────────────────────────────────────────────────

export interface ArgsQuitar { deportista: string; desde: string; hasta: string }

export const quitarExcusa: HerramientaAccion<ArgsQuitar> = {
    tipo: 'accion',
    nombre: 'quitar_excusa',
    descripcion: 'PREPARA quitar avisos de ausencia de un deportista en un rango de días (la persona confirma en la tarjeta). El entrenador solo puede quitar los que puso la escuela, no los que avisó la familia.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista' },
            desde: { type: 'string', description: 'AAAA-MM-DD' },
            hasta: { type: 'string', description: 'AAAA-MM-DD' },
        },
        required: ['deportista', 'desde', 'hasta'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    habilitada: habilitadaCoach,
    validar(args) {
        const r = z.object({ deportista: z.string().min(5).max(80), desde: z.string(), hasta: z.string() }).safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Faltan datos: deportista, desde y hasta (AAAA-MM-DD).');
        return r.data;
    },
    async preparar(a, args) {
        if (!esFechaIso(args.desde) || !esFechaIso(args.hasta) || args.hasta < args.desde) {
            return { ok: false, motivo: 'Las fechas tienen que venir como AAAA-MM-DD y en orden.' };
        }
        if (diferenciaDias(args.desde, args.hasta) + 1 > 93) return { ok: false, motivo: 'El rango es muy largo; usa máximo tres meses.' };
        const d = await resolverDeportista(a, args.deportista);
        const ya = await avisosActivos(a, d, args.desde, args.hasta);
        const quitables = a.rol === 'admin' ? ya : ya.filter((x) => x.source === 'staff');
        const deFamilia = ya.filter((x) => x.source !== 'staff');
        if (!quitables.length) {
            return { ok: false, motivo: ya.length
                ? 'Esos avisos los puso la familia: solo la administración los puede quitar.'
                : `${d.nombre} no tiene avisos de ausencia en esas fechas.` };
        }
        const dias = quitables.map((x) => x.dia).sort();
        return {
            ok: true,
            args,
            targetKey: `deportista:${d.clave}`,
            vista: {
                titulo: `Quitar la excusa de ${d.nombre}`,
                lineas: [
                    `${dias.length} ${dias.length === 1 ? 'día' : 'días'}: ${dias.map(fechaCorta).join(', ')}`,
                    ...(a.rol === 'admin' && deFamilia.length
                        ? [deFamilia.length === 1 ? 'Uno de esos lo había avisado la familia.' : `${deFamilia.length} de esos los había avisado la familia.`] : []),
                    ...(a.rol === 'coach' && deFamilia.length
                        ? [deFamilia.length === 1 ? 'El aviso que puso la familia no se toca.' : `Los ${deFamilia.length} avisos que puso la familia no se tocan.`] : []),
                    'Esos días vuelven a contar como asistencia normal en la lista.',
                ],
                aviso: null,
                botonConfirmar: 'Confirmar',
            },
            huella: { deportista: d.clave, ids: quitables.map((x) => x.id).sort() },
        };
    },
    async ejecutar(a, args) {
        const d = await resolverDeportista(a, args.deportista);
        const ya = await avisosActivos(a, d, args.desde, args.hasta);
        const ids = (a.rol === 'admin' ? ya : ya.filter((x) => x.source === 'staff')).map((x) => x.id);
        if (!ids.length) return { estado: 'failed', resultado: { motivo: 'Ya no había avisos para quitar.' } };
        let q = supabase.from('athlete_absence_notices').update({ status: 'cancelled' })
            .eq('school_id', a.schoolId).eq('status', 'active').in('id', ids);
        if (a.rol === 'coach') q = q.eq('source', 'staff');
        const { data, error } = await q.select('id');
        if (error) return { estado: 'failed', resultado: { error: error.message } };
        const n = ((data as any[]) ?? []).length;
        return { estado: n === ids.length ? 'executed' : n ? 'partial' : 'failed', resultado: { nombre: d.nombre, quitados: n } };
    },
    mensajeResultado(r, args) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se quitó ninguna excusa. ${x.motivo || ''}`.trim();
        return x.quitados === 1
            ? `Se quitó 1 aviso de ausencia de ${x.nombre} ${rangoLegible(args.desde, args.hasta)}.`
            : `Se quitaron ${x.quitados} avisos de ausencia de ${x.nombre} ${rangoLegible(args.desde, args.hasta)}.`;
    },
};
