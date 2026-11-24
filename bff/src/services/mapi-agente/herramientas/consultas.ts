/**
 * Herramientas de CONSULTA de la oleada 1 (plan §4). Se ejecutan sin
 * confirmar y devuelven solo campos de una lista permitida (plan §12.1).
 */

import { z } from 'zod';
import { supabase } from '../../../config/supabase';
import { findDuplicatePaymentIds } from '../../duplicatePayerGuard.service';
import { armarInformeCartera, esVencido, saldoDe, mesDelCobro, etiquetaMes, fmtCop } from '../../informe-cartera.service';
import { searchHelpArticles } from '../../inapp-support-bot.service';
import { buscarEnEscuela, completarNombresDeEquipo, resolverDeportista, columnaDe, variantesDeApodo, type Deportista } from '../deportistas';
import { esMes, limitesDelMes, nombreDelMes, fechaCorta } from '../fechas';
import { RechazoHerramienta, type HerramientaConsulta } from '../tipos';

const validarCon = <T>(schema: z.ZodType<T>) => (args: unknown): T => {
    const r = schema.safeParse(args ?? {});
    if (!r.success) throw new RechazoHerramienta(`Datos inválidos para la herramienta: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
    return r.data;
};

const TIPO_LEGIBLE = { child: 'menor (con acudiente)', adult: 'adulto con cuenta', unregistered: 'ficha sin cuenta' } as const;

// ─── buscar_deportista ──────────────────────────────────────────────────────

export const buscarDeportista: HerramientaConsulta<{ texto: string }> = {
    tipo: 'consulta',
    nombre: 'buscar_deportista',
    descripcion: 'Busca deportistas de la escuela por nombre o apellido (sin importar tildes). Devuelve hasta 8 con su id, equipos y si están activos. El entrenador solo ve a los de sus equipos. Si hay más de uno posible, pregúntale a la persona cuál es.',
    esquema: {
        type: 'object',
        properties: { texto: { type: 'string', description: 'Nombre, apellido o parte del nombre (ej. "mariana lopez")' } },
        required: ['texto'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar: validarCon(z.object({ texto: z.string().trim().min(2).max(80) })),
    async ejecutar(a, { texto }) {
        let todos = await buscarEnEscuela(a, texto);
        // Apodo sin coincidencia literal: se busca el nombre completo probable.
        let comoApodo: string[] = [];
        if (!todos.length) {
            const variantes = variantesDeApodo(texto);
            const porClave = new Map<string, Deportista>();
            for (const v of variantes) {
                const r = await buscarEnEscuela(a, v);
                if (r.length) comoApodo.push(v);
                for (const d of r) porClave.set(d.clave, d);
            }
            todos = [...porClave.values()];
            if (!todos.length) comoApodo = [];
        }
        todos.sort((x, y) => Number(y.activo) - Number(x.activo) || x.nombre.localeCompare(y.nombre, 'es'));
        const primeros = todos.slice(0, 8);
        await completarNombresDeEquipo(a.schoolId, primeros);
        return {
            encontrados: todos.length,
            deportistas: primeros.map((d) => ({
                id: d.clave,
                nombre: d.nombre,
                tipo: TIPO_LEGIBLE[d.tipo],
                equipos: d.equipos.map((e) => e.nombre).filter(Boolean),
                activo: d.activo,
            })),
            ...(comoApodo.length ? { busqueda: `Nadie se llama «${texto}» tal cual; busqué ${comoApodo.map((v) => `«${v}»`).join(' y ')} como apodo. Si hay una sola coincidencia, es esa persona: menciónale el nombre completo en tu respuesta.` } : {}),
            ...(todos.length > 8 ? { nota: `Hay ${todos.length} coincidencias: pide nombre y apellido.` } : {}),
            ...(todos.length === 0 ? { nota: a.rol === 'coach' ? 'Nadie con ese nombre en tus equipos.' : 'Nadie con ese nombre en la escuela.' } : {}),
        };
    },
};

// ─── resumen_deportista ─────────────────────────────────────────────────────

const ESTADOS_ABIERTOS = ['pending', 'overdue', 'partial', 'awaiting_approval'];

export const resumenDeportista: HerramientaConsulta<{ deportista: string; mes?: string }> = {
    tipo: 'consulta',
    nombre: 'resumen_deportista',
    descripcion: 'Resumen de un deportista en un mes: asistencia (presente, tarde, falta, excusado), avisos de ausencia, inscripción y plan, última medición e informe mensual. Para la administración incluye además lo que debe. Usa el id que devolvió buscar_deportista o el de la pantalla.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista (ej. "child:…")' },
            mes: { type: 'string', description: 'Mes AAAA-MM. Si no se da, el mes en curso.' },
        },
        required: ['deportista'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar: validarCon(z.object({ deportista: z.string().min(5).max(80), mes: z.string().optional() })),
    async ejecutar(a, args) {
        const mes = esMes(args.mes) ? args.mes : a.hoy.slice(0, 7);
        const { desde, hasta } = limitesDelMes(mes);
        const d = await resolverDeportista(a, args.deportista);
        const col = columnaDe(d.tipo);

        let qAsis = supabase.from('attendance_records').select('attendance_date, status, team_id')
            .eq('school_id', a.schoolId).eq(col, d.id).gte('attendance_date', desde).lte('attendance_date', hasta);
        if (a.rol === 'coach') qAsis = qAsis.in('team_id', a.teamIds.length ? a.teamIds : ['00000000-0000-0000-0000-000000000000']);

        const avisosQ = d.tipo === 'unregistered'
            ? Promise.resolve({ data: [] as any[] })
            : supabase.from('athlete_absence_notices').select('absence_date, reason, source')
                .eq('school_id', a.schoolId).eq(col, d.id).eq('status', 'active')
                .gte('absence_date', desde).lte('absence_date', hasta).order('absence_date');

        const [{ data: asis }, { data: avisos }, { data: medicion }, { data: informe }] = await Promise.all([
            qAsis,
            avisosQ,
            supabase.from('performance_entries').select('recorded_at')
                .eq('school_id', a.schoolId).eq('subject_id', d.id).order('recorded_at', { ascending: false }).limit(1).maybeSingle(),
            supabase.from('athlete_reports').select('period_year, period_month, status')
                .eq('school_id', a.schoolId).eq('subject_id', d.id)
                .order('period_year', { ascending: false }).order('period_month', { ascending: false }).limit(1).maybeSingle(),
        ]);

        const conteo = { presente: 0, tarde: 0, falta: 0, excusado: 0 };
        for (const r of (asis as any[]) ?? []) {
            if (r.status === 'present') conteo.presente++;
            else if (r.status === 'late') conteo.tarde++;
            else if (r.status === 'absent') conteo.falta++;
            else if (r.status === 'excused') conteo.excusado++;
        }

        const salida: Record<string, unknown> = {
            nombre: d.nombre,
            mes: nombreDelMes(mes),
            activo: d.activo,
            equipos: d.equipos.map((e) => e.nombre).filter(Boolean),
            plan: d.plan,
            estado_inscripcion: d.estadoInscripcion,
            asistencia: { ...conteo, sesiones_registradas: ((asis as any[]) ?? []).length },
            avisos_de_ausencia: ((avisos as any[]) ?? []).map((v) => ({
                dia: fechaCorta(String(v.absence_date)), motivo: v.reason, quien: v.source === 'staff' ? 'la escuela' : 'la familia',
            })),
            ultima_medicion: (medicion as any)?.recorded_at ? String((medicion as any).recorded_at).slice(0, 10) : null,
            ultimo_informe_mensual: informe
                ? { mes: etiquetaMes(`${(informe as any).period_year}-${String((informe as any).period_month).padStart(2, '0')}`), estado: (informe as any).status }
                : null,
        };

        // El entrenador nunca ve plata (V2 del entrenador; plan §4).
        if (a.rol === 'admin') salida.cuenta = await cuentaDeDeportista(a.schoolId, a.hoy, col, d.id, d.tipo);
        return salida;
    },
};

async function cuentaDeDeportista(schoolId: string, hoy: string, col: string, id: string, tipo: string) {
    let q = supabase.from('payments')
        .select('id, parent_id, user_id, child_id, unregistered_athlete_id, concept, amount, amount_paid, status, due_date, payment_type, payment_category, period_year, period_month')
        .eq('school_id', schoolId).eq(col, id).in('status', ESTADOS_ABIERTOS);
    // Un adulto figura en user_id; un cobro de un menor también puede traer user_id del acudiente.
    if (tipo === 'adult') q = q.is('child_id', null).is('unregistered_athlete_id', null);
    const { data, error } = await q.limit(100);
    if (error) throw new Error(error.message);
    const crudos = (data as any[]) ?? [];
    const duplicados = crudos.length ? await findDuplicatePaymentIds(schoolId, crudos) : new Set<string>();
    const pagos = crudos.filter((p) => !duplicados.has(p.id));
    const vencidos = pagos.filter((p) => esVencido(p, hoy));
    const total = pagos.reduce((s, p) => s + saldoDe(p), 0);
    return {
        saldo_pendiente: fmtCop(total),
        saldo_vencido: fmtCop(vencidos.reduce((s, p) => s + saldoDe(p), 0)),
        cobros_abiertos: pagos.slice(0, 6).map((p) => ({
            concepto: p.concept || 'Cobro',
            mes: etiquetaMes(mesDelCobro(p)),
            saldo: fmtCop(saldoDe(p)),
            vence: p.due_date ? String(p.due_date).slice(0, 10) : null,
            estado: p.status === 'awaiting_approval' ? 'comprobante en revisión' : esVencido(p, hoy) ? 'vencido' : 'por vencer',
        })),
        ...(pagos.length > 6 ? { otros_cobros: pagos.length - 6 } : {}),
        ...(duplicados.size ? { excluidos_por_duplicado: duplicados.size } : {}),
    };
}

// ─── cartera ────────────────────────────────────────────────────────────────

export const cartera: HerramientaConsulta<{ mes?: string }> = {
    tipo: 'consulta',
    nombre: 'cartera',
    descripcion: 'Cartera de la escuela: cuánto se debe y quiénes deben (vencido), por mes y por antigüedad, más lo que está por vencer y los comprobantes en revisión. Misma fuente que el informe semanal de cartera. Solo administración.',
    esquema: {
        type: 'object',
        properties: { mes: { type: 'string', description: 'Opcional: AAAA-MM para ver solo lo que se debe de ese mes.' } },
        required: [],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar: validarCon(z.object({ mes: z.string().optional() })),
    async ejecutar(a, { mes }) {
        const inf = await armarInformeCartera(a.schoolId);
        const m = inf.morosos;
        const porMes = esMes(mes) ? m.porMes.filter((x) => x.mes === mes) : m.porMes;
        return {
            corte: inf.hoy,
            vencido: {
                total: fmtCop(m.total), familias: m.familias, deportistas: m.atletas, cobros: m.cobros,
                mensualidades: fmtCop(m.mensualidades), otros_conceptos: fmtCop(m.otros),
            },
            por_mes: porMes.map((x) => ({ mes: etiquetaMes(x.mes), cobros: x.cobros, total: fmtCop(x.total) })),
            por_antiguedad: m.porAntiguedad.map((x) => ({ tramo: x.tramo, cobros: x.cobros, total: fmtCop(x.total) })),
            // Sin teléfono ni correo: el modelo no los necesita (plan §12.1).
            familias_que_mas_deben: m.filas.slice(0, 10).map((f) => ({
                familia: f.familia, deportistas: f.atletas, total: fmtCop(f.total), meses: f.mesesLista.map(etiquetaMes), dias_de_mora: f.diasMora,
            })),
            por_vencer: { total: fmtCop(inf.pendientes.porVencerTotal), familias: inf.pendientes.porVencerFamilias },
            comprobantes_en_revision: { cobros: inf.pendientes.enRevision.length, total: fmtCop(inf.pendientes.enRevisionTotal) },
            ...(inf.excluidos.duplicados ? { excluidos_por_duplicado: inf.excluidos.duplicados } : {}),
        };
    },
};

// ─── buscar_ayuda ───────────────────────────────────────────────────────────

export const buscarAyuda: HerramientaConsulta<{ consulta: string }> = {
    tipo: 'consulta',
    nombre: 'buscar_ayuda',
    descripcion: 'Busca en los artículos de ayuda de SportMaps. Úsala solo si el MAPA DE LA APP no cubre cómo se hace algo.',
    esquema: {
        type: 'object',
        properties: { consulta: { type: 'string', description: 'Qué quiere hacer la persona (ej. "registrar un pago en efectivo")' } },
        required: ['consulta'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar: validarCon(z.object({ consulta: z.string().trim().min(2).max(200) })),
    async ejecutar(a, { consulta }) {
        return searchHelpArticles(consulta, 3, a.rol === 'admin' ? ['school'] : ['coach'])
            .map((r) => ({ titulo: r.title, enlace: r.href, contenido: r.contenido }));
    },
};
