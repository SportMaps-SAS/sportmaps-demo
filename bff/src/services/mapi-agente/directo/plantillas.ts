/**
 * directo/plantillas — el texto FIJO de cada consulta sin modelo
 * (docs/specs/mapi-consultas-sin-ia.md). Puras: reciben el resultado de la
 * herramienta TAL CUAL y no calculan nada de negocio.
 *
 * Reglas:
 *   · solo se muestran campos que la herramienta ya filtra; además nunca se
 *     muestran notas libres de familias, motivos de ausencia (pueden ser
 *     médicos), teléfonos, correos ni documentos: `limpio` tapa cualquier número
 *     largo o correo que se cuele en un nombre o un concepto;
 *   · app: markdown simple (**negrita**, viñetas «-»); WhatsApp: *negrita*,
 *     viñetas «•», sin tablas, sin rutas ni enlaces (la pantalla, en palabras);
 *   · lo largo lo parte el canal (partirMensaje, ≤ 4.000 por mensaje).
 */

import { fechaCorta, fechaLarga } from '../fechas';

export type CanalDirecto = 'app' | 'whatsapp';

export const MAX_TEXTO = 3800;

/** Negrita según el canal. */
export const negrita = (canal: CanalDirecto, s: string) => (canal === 'whatsapp' ? `*${s}*` : `**${s}**`);
const vineta = (canal: CanalDirecto) => (canal === 'whatsapp' ? '•' : '-');

/**
 * Texto de la base para mostrar: sin las marcas <dato_no_confiable>, sin
 * números largos (teléfonos, documentos, cuentas), sin correos ni caracteres
 * de formato (para que un nombre no cambie la negrita). Pura.
 */
export function limpio(v: unknown, max = 80): string {
    let s = String(v ?? '')
        .replace(/<\s*dato_no_confiable[^>]*>/gi, '').replace(/<\s*\/\s*dato_no_confiable\s*>/gi, '')
        .replace(/\s+/g, ' ').trim();
    s = s.replace(/[*_`~#|<>[\]]/g, '');
    s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]');
    s = s.replace(/\+?\d[\d\s-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[número]' : m));
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (k: number, uno: string, varios: string) => `${k} ${k === 1 ? uno : varios}`;
const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const dia = (v: unknown) => { const f = iso(v); return f ? fechaCorta(f) : null; };
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pantalla = (canal: CanalDirecto, nombre: string) => (canal === 'whatsapp' ? `En la app: *${nombre}*.` : `En la app: **${nombre}**.`);

/** Une líneas, sin vacías, y recorta al máximo de un mensaje. */
export function unir(lineas: (string | null | undefined | false)[]): string {
    const t = lineas.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
    return t.length > MAX_TEXTO ? `${t.slice(0, MAX_TEXTO - 1).trimEnd()}…` : t;
}

/** Nombres internos de herramientas que se cuelan en un texto de la herramienta («revísalos con auditar_pendientes»). */
const NOMBRE_INTERNO: Record<string, string> = {
    auditar_pendientes: '«auditar comprobantes»', pagos_por_validar: '«por validar»', buscar_deportista: 'el buscador',
    convocar_a_torneo: 'la convocatoria', inscribir_a_torneo: 'la inscripción',
};
export function sinNombresInternos(s: string): string {
    return s.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (m) => NOMBRE_INTERNO[m] ?? 'Mapi');
}

// ─── cartera ────────────────────────────────────────────────────────────────

export function plantillaCartera(d: any, canal: CanalDirecto, mes: string | null): string {
    const v = d?.vencido ?? {};
    const b = (s: string) => negrita(canal, s);
    const p = vineta(canal);
    const familias = (d?.familias_que_mas_deben ?? []) as any[];
    const porMes = (d?.por_mes ?? []) as any[];
    const corte = dia(d?.corte);
    const sinMora = n(v.familias) === 0 && n(v.cobros) === 0;
    return unir([
        `${b('Cartera')}${corte ? ` (corte ${corte})` : ''}`,
        sinMora ? 'No hay cobros vencidos.' : `Vencido: ${b(limpio(v.total))} · ${plural(n(v.familias), 'familia', 'familias')} · ${plural(n(v.deportistas), 'deportista', 'deportistas')} · ${plural(n(v.cobros), 'cobro', 'cobros')}`,
        mes ? (porMes.length
            ? `De ${limpio(porMes[0].mes)}: ${plural(n(porMes[0].cobros), 'cobro', 'cobros')} por ${limpio(porMes[0].total)}`
            : 'De ese mes no hay cobros vencidos.') : null,
        !sinMora && familias.length ? '' : null,
        !sinMora && familias.length ? 'Quiénes deben más:' : null,
        ...(!sinMora ? familias.slice(0, 10).map((f) => {
            const meses = ((f.meses ?? []) as unknown[]).map((x) => limpio(x, 20)).filter(Boolean);
            return `${p} ${limpio(f.familia)} — ${limpio(f.total)}${meses.length ? ` (${meses.join(', ')})` : ''}${n(f.dias_de_mora) ? ` · ${plural(n(f.dias_de_mora), 'día', 'días')} de mora` : ''}`;
        }) : []),
        '',
        `Por vencer: ${limpio(d?.por_vencer?.total)} (${plural(n(d?.por_vencer?.familias), 'familia', 'familias')})`,
        n(d?.comprobantes_en_revision?.cobros) ? `Comprobantes en revisión: ${n(d.comprobantes_en_revision.cobros)} (${limpio(d.comprobantes_en_revision.total)})` : null,
        pantalla(canal, 'Finanzas › Cartera'),
    ]);
}

// ─── resumen_deportista ─────────────────────────────────────────────────────

const INSCRIPCION: Record<string, string> = { active: 'activa', paused: 'en pausa', cancelled: 'cancelada', pending: 'pendiente', inactive: 'inactiva', expired: 'vencida' };

function cabezaDeportista(d: any, canal: CanalDirecto): string {
    const equipos = ((d?.equipos ?? []) as unknown[]).map((x) => limpio(x, 40)).filter(Boolean);
    return `${negrita(canal, limpio(d?.nombre))}${equipos.length ? ` (${equipos.join(', ')})` : ''}${d?.activo === false ? ' · inactivo' : ''}`;
}

/** «¿Cuánto debe X?»: la cuenta del resumen (solo administración; la herramienta no la trae para el coach). */
export function plantillaDebe(d: any, canal: CanalDirecto): string {
    const c = d?.cuenta;
    const p = vineta(canal);
    if (!c) return 'Los pagos solo los ve la administración de la escuela.';
    const cobros = (c.cobros_abiertos ?? []) as any[];
    if (!cobros.length) return unir([cabezaDeportista(d, canal), 'Está al día: no tiene cobros abiertos.']);
    return unir([
        cabezaDeportista(d, canal),
        `Debe ${negrita(canal, limpio(c.saldo_pendiente))}${limpio(c.saldo_vencido) && limpio(c.saldo_vencido) !== '$0' ? ` (vencido: ${limpio(c.saldo_vencido)})` : ' (nada vencido)'}`,
        ...cobros.map((x) => `${p} ${limpio(x.concepto)}${x.mes ? ` (${limpio(x.mes, 20)})` : ''}: ${limpio(x.saldo)} — ${limpio(x.estado, 30)}${dia(x.vence) ? ` · vence el ${dia(x.vence)}` : ''}`),
        n(c.otros_cobros) ? `Y ${plural(n(c.otros_cobros), 'cobro más', 'cobros más')}.` : null,
        pantalla(canal, 'Pagos'),
    ]);
}

/** «¿Cómo va X?»: asistencia, avisos (sin motivos), inscripción e informe; la cuenta solo si viene. */
export function plantillaResumen(d: any, canal: CanalDirecto): string {
    const a = d?.asistencia ?? {};
    const avisos = (d?.avisos_de_ausencia ?? []) as any[];
    const inf = d?.ultimo_informe_mensual;
    const c = d?.cuenta;
    return unir([
        `${cabezaDeportista(d, canal)} · ${limpio(d?.mes, 30)}`,
        [d?.plan ? `Plan: ${limpio(d.plan, 50)}` : null, d?.estado_inscripcion ? `Inscripción: ${INSCRIPCION[d.estado_inscripcion] ?? limpio(d.estado_inscripcion, 20)}` : null].filter(Boolean).join(' · ') || null,
        n(a.sesiones_registradas)
            ? `Asistencia: ${n(a.presente)} vino · ${n(a.tarde)} tarde · ${n(a.falta)} faltó · ${n(a.excusado)} con excusa (${plural(n(a.sesiones_registradas), 'sesión registrada', 'sesiones registradas')})`
            : 'Asistencia: sin sesiones registradas este mes.',
        avisos.length ? `Avisos de ausencia: ${avisos.length} (${avisos.slice(0, 6).map((v) => limpio(v.dia, 20)).join(', ')})` : null,
        d?.ultima_medicion ? `Última medición: ${dia(d.ultima_medicion) ?? limpio(d.ultima_medicion, 12)}` : null,
        inf ? `Último informe mensual: ${limpio(inf.mes, 20)} (${limpio(inf.estado, 30)})` : null,
        c ? `Cuenta: debe ${limpio(c.saldo_pendiente)}${limpio(c.saldo_vencido) !== '$0' ? ` (vencido: ${limpio(c.saldo_vencido)})` : ''}` : null,
    ]);
}

// ─── pagos ──────────────────────────────────────────────────────────────────

export function plantillaPorValidar(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    if (!n(d?.por_validar)) return limpio(d?.nota, 200) || 'No hay comprobantes por validar.';
    const lista = (d?.lista ?? []) as any[];
    return unir([
        `${negrita(canal, plural(n(d.por_validar), 'comprobante por validar', 'comprobantes por validar'))} · suman ${limpio(d.suman)}`,
        `${limpio(d.filtro, 80)}`,
        `El más viejo espera ${limpio(d.el_mas_viejo_espera, 30)}${n(d.mas_de_24_horas) ? ` · ${n(d.mas_de_24_horas)} con más de 24 h` : ''}`,
        n(d.nivel_2) ? `Nivel 2 (coinciden con el cobro, se aprueban de un clic): ${n(d.nivel_2)}` : null,
        '',
        ...lista.map((x) => `${p} ${limpio(x.deportista)} — ${limpio(x.concepto)}: cobro ${limpio(x.cobro)}, comprobante ${limpio(x.comprobante)} · nivel ${n(x.nivel)} · espera ${limpio(x.espera, 30)}${x.revisar_por ? ` · revisar: ${limpio(x.revisar_por, 80)}` : ''}`),
        d.nota ? limpio(d.nota, 200) : null,
        pantalla(canal, 'Pagos › Aprobar'),
    ]);
}

export function plantillaPorQue(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const motivos = ((d?.motivos ?? []) as unknown[]).map((m) => limpio(m, 200)).filter(Boolean);
    return unir([
        `${negrita(canal, limpio(d?.deportista))} — ${limpio(d?.concepto)}`,
        `Estado: ${limpio(d?.estado, 40)} · cobro ${limpio(d?.cobro)} · comprobante ${limpio(d?.comprobante)}`,
        d?.veredicto ? `Lectura del comprobante: ${limpio(d.veredicto, 30)}${d?.nivel ? ` · nivel ${n(d.nivel)}` : ''}` : null,
        d?.explicacion ? limpio(d.explicacion, 300) : null,
        motivos.length ? 'Por qué:' : null,
        ...motivos.map((m) => `${p} ${m}`),
        d?.aprobacion_automatica ? limpio(d.aprobacion_automatica, 300) : null,
        pantalla(canal, 'Pagos › Aprobar'),
    ]);
}

const PROPUESTA: Record<string, string> = { completo: 'Completo', abono: 'Abono', revisar: 'Revisar', 'no aprobar': 'No aprobar' };

export function plantillaAuditoria(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    if (!n(d?.por_validar)) return limpio(d?.nota, 200) || 'No hay comprobantes por validar.';
    const props = Object.entries((d?.propuestas ?? {}) as Record<string, any>)
        .map(([k, v]) => `${PROPUESTA[k] ?? limpio(k, 20)}: ${n(v?.cantidad)} (${limpio(v?.suman)})`);
    const lista = (d?.lista ?? []) as any[];
    return unir([
        `${negrita(canal, `Auditoría de ${plural(n(d.por_validar), 'comprobante', 'comprobantes')}`)} (es una propuesta: no aprueba ni rechaza nada)`,
        props.join(' · '),
        '',
        // Sin «lo que escribió la familia»: es texto libre de terceros.
        ...lista.map((x) => `${p} ${limpio(x.deportista)} — ${limpio(x.concepto)}: ${negrita(canal, PROPUESTA[x.propuesta] ?? limpio(x.propuesta, 20))}${(x.por_que ?? [])[0] ? ` · ${limpio(x.por_que[0], 160)}` : ''}`),
        n(d.faltan_en_la_lista) ? `Y ${plural(n(d.faltan_en_la_lista), 'comprobante más', 'comprobantes más')}.` : null,
        'Cada pago se decide en la pantalla Aprobar, con la foto al lado.',
    ]);
}

const PUNTO: Record<string, string> = { cumple: 'Cumple', falta: 'Falta', 'verificar a mano': 'A mano' };

export function plantillaAprobacionAutomatica(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    return unir([
        `${negrita(canal, `Aprobación automática: ${limpio(d?.aprobacion_automatica, 20)}`)}`,
        limpio(d?.resumen, 200),
        '',
        ...((d?.lista ?? []) as any[]).map((x) => `${p} ${PUNTO[x.estado] ?? limpio(x.estado, 20)} — ${limpio(x.punto, 120)}: ${sinNombresInternos(limpio(x.detalle, 220))}`),
        d?.nota ? sinNombresInternos(limpio(d.nota, 200)) : null,
    ]);
}

// ─── entrenador ─────────────────────────────────────────────────────────────

export function plantillaAsistencia(d: any, canal: CanalDirecto): string {
    const r = d?.resumen ?? {};
    const deportistas = (d?.deportistas ?? []) as any[];
    const de = (estado: string) => deportistas.filter((x) => x.estado === estado).map((x) => limpio(x.nombre, 40));
    const grupo = (titulo: string, xs: string[]) => (xs.length ? `${titulo} (${xs.length}): ${xs.join(', ')}` : null);
    // Quién avisó, sin el motivo (puede ser médico).
    const avisaron = deportistas.filter((x) => x.aviso).map((x) => `${limpio(x.nombre, 40)} (${/la escuela/.test(String(x.aviso)) ? 'la escuela' : 'la familia'})`);
    return unir([
        `${negrita(canal, `Asistencia · ${limpio(d?.equipo, 50)}`)}`,
        `${capital(limpio(d?.fecha, 60))} · lista ${limpio(d?.lista, 30)}`,
        `Vinieron ${n(r.vinieron)} · tarde ${n(r.tarde)} · faltaron ${n(r.faltaron)} · con excusa ${n(r.con_excusa)} · sin marca ${n(r.sin_marca)} (de ${n(r.en_la_lista)})`,
        grupo('Faltaron', de('Faltó')),
        grupo('Con excusa', de('Excusa')),
        grupo('Llegaron tarde', de('Tarde')),
        grupo('Sin marca', de('sin marca')),
        avisaron.length ? `Avisaron que no venían: ${avisaron.join(', ')}` : null,
        n(d?.en_pausa_ese_dia) ? `En pausa ese día: ${n(d.en_pausa_ese_dia)}` : null,
        d?.nota_lista ? limpio(d.nota_lista, 160) : null,
        d?.nota ? limpio(d.nota, 160) : null,
    ]);
}

function planTexto(p: any): string | null {
    if (!p) return null;
    const o = limpio(p.objetivos, 100);
    return o ? `plan: ${o}` : null;
}

export function plantillaSemana(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const base = ((d?.horario_base ?? []) as unknown[]).map((x) => limpio(x, 100)).filter(Boolean);
    return unir([
        negrita(canal, `Semana de ${limpio(d?.equipo, 50)}`),
        base.length ? `Horario: ${base.join(' · ')}` : 'Sin horario base.',
        '',
        ...((d?.dias ?? []) as any[]).map((x) => {
            const ses = ((x.sesiones ?? []) as unknown[]).map((s) => limpio(s, 100));
            const canc = ((x.canceladas ?? []) as unknown[]).map((s) => limpio(s, 40));
            const partes = [ses.length ? ses.join(' · ') : 'sin entreno', canc.length ? `cancelada: ${canc.join(', ')}` : null, planTexto(x.plan)].filter(Boolean);
            return `${p} ${capital(limpio(x.fecha, 50))}: ${partes.join(' · ')}`;
        }),
    ]);
}

const MAX_EQUIPOS = 25;

export function plantillaHorarios(d: any, canal: CanalDirecto): string {
    const equipos = (d?.equipos ?? []) as any[];
    if (!equipos.length) return limpio(d?.nota, 200) || 'No hay equipos.';
    const p = vineta(canal);
    return unir([
        `${negrita(canal, 'Equipos y horarios')} · hoy ${limpio(d?.hoy, 60)}`,
        ...equipos.slice(0, MAX_EQUIPOS).flatMap((e) => {
            const hoy = ((e.sesiones_hoy ?? []) as unknown[]).map((s) => limpio(s, 80));
            const man = ((e.sesiones_manana ?? []) as unknown[]).map((s) => limpio(s, 80));
            const base = ((e.horario ?? []) as unknown[]).map((s) => limpio(s, 80));
            return [
                '',
                `${p} ${negrita(canal, limpio(e.nombre, 50))}${e.categoria ? ` (${limpio(e.categoria, 20)})` : ''} — ${plural(n(e.inscritos_activos), 'inscrito', 'inscritos')}`,
                base.length ? `   Horario: ${base.join(' · ')}` : null,
                `   Hoy: ${hoy.length ? hoy.join(' · ') : 'sin entreno'}${hoy.length ? ` (lista ${limpio(e.lista_de_hoy, 20)})` : ''}`,
                ((e.canceladas_hoy ?? []) as unknown[]).length ? `   Cancelada hoy: ${(e.canceladas_hoy as unknown[]).map((s) => limpio(s, 40)).join(', ')}` : null,
                `   Mañana: ${man.length ? man.join(' · ') : 'sin entreno'}`,
            ];
        }),
        equipos.length > MAX_EQUIPOS ? `\nY ${equipos.length - MAX_EQUIPOS} equipos más: pide la semana de uno por su nombre.` : null,
    ]);
}

// ─── informes, torneos, clases de prueba ────────────────────────────────────

export function plantillaClasesPrueba(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const clases = (d?.clases ?? []) as any[];
    const rango = d?.desde === d?.hasta ? (iso(d?.desde) ? fechaLarga(iso(d.desde)!) : '') : `del ${dia(d?.desde) ?? ''} al ${dia(d?.hasta) ?? ''}`;
    const pros = d?.prospectos;
    return unir([
        `${negrita(canal, 'Clases de prueba')} · ${rango}`,
        clases.length ? null : limpio(d?.nota, 200) || 'No hay clases de prueba en esas fechas.',
        ...clases.slice(0, 30).map((c) => `${p} ${dia(c.fecha) ?? ''}${c.hora ? ` ${limpio(c.hora, 15)}` : ''} — ${limpio(c.nombre, 50)}${c.grupo ? ` · ${limpio(c.grupo, 40)}` : ''}${c.lugar ? ` · ${limpio(c.lugar, 40)}` : ''} · ${limpio(c.estado, 40)}${c.asistencia ? ` · ${limpio(c.asistencia, 15)}` : ''}${c.pago ? ` · pago: ${limpio(c.pago, 40)}` : ''}`),
        n(d?.total) > 30 ? `Y ${n(d.total) - 30} más.` : null,
        pros ? '' : null,
        pros ? `Prospectos pendientes: ${n(pros.pendientes)} · sin clase agendada: ${n(pros.sin_clase_agendada)}` : null,
        ...(pros?.recientes_sin_clase ?? []).slice(0, 10).map((x: any) => `${p} ${limpio(x.nombre, 50)}${x.grupo ? ` · ${limpio(x.grupo, 40)}` : ''}${x.canal ? ` · llegó por ${limpio(x.canal, 20)}` : ''}${dia(x.desde) ? ` · desde el ${dia(x.desde)}` : ''}`),
        d?.pantalla?.nombre ? pantalla(canal, limpio(d.pantalla.nombre, 60)) : null,
    ]);
}

export function plantillaInformes(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const informes = (d?.informes ?? []) as any[];
    return unir([
        negrita(canal, `Informes mensuales de ${limpio(d?.nombre, 60)}`),
        informes.length ? null : limpio(d?.nota, 200) || 'Todavía no tiene informes mensuales.',
        ...informes.map((r) => `${p} ${capital(limpio(r.mes, 30))}: ${limpio(r.estado, 30)}${dia(r.enviado) ? ` · enviado el ${dia(r.enviado)}` : ''}${dia(r.visto_por_la_familia) ? ` · visto por la familia el ${dia(r.visto_por_la_familia)}` : ''}`),
        pantalla(canal, 'Informe mensual'),
    ]);
}

export function plantillaTorneos(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const ts = (d?.torneos ?? []) as any[];
    return unir([
        negrita(canal, 'Torneos'),
        ts.length ? null : limpio(d?.nota, 200) || 'La escuela no tiene torneos con ese estado.',
        ...ts.slice(0, 15).map((t) => {
            const fechas = dia(t.fecha) ? `${dia(t.fecha)}${dia(t.hasta) && t.hasta !== t.fecha ? ` al ${dia(t.hasta)}` : ''}` : 'sin fecha';
            const cuantos = t.inscritos !== undefined ? plural(n(t.inscritos), 'inscrito', 'inscritos') : plural(n(t.delegaciones), 'delegación', 'delegaciones');
            return `${p} ${negrita(canal, limpio(t.nombre, 60))} — ${limpio(t.estado, 20)} · ${fechas} · ${cuantos}${t.cupo ? ` de ${n(t.cupo)}` : ''} · inscripciones ${limpio(t.inscripciones, 10)}${dia(t.cierre_inscripciones) ? ` hasta el ${dia(t.cierre_inscripciones)}` : ''} · ${limpio(t.inscripcion, 30)}`;
        }),
        ts.length > 15 ? `Y ${ts.length - 15} más.` : null,
        pantalla(canal, 'Torneos'),
    ]);
}

// ─── operación ──────────────────────────────────────────────────────────────

export function plantillaReservas(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const inst = (d?.instalaciones ?? []) as any[];
    if (!inst.length) return limpio(d?.nota, 200) || 'No hay instalaciones.';
    return unir([
        `${negrita(canal, 'Reservas')} · ${limpio(d?.fecha, 60)}`,
        ...inst.flatMap((f) => {
            const rs = (f.reservas ?? []) as any[];
            const libre = Array.isArray(f.libre) ? (f.libre as unknown[]).map((x) => limpio(x, 20)).join(', ') : limpio(f.libre, 40);
            return [
                '',
                negrita(canal, limpio(f.nombre, 50)),
                rs.length ? null : 'Sin reservas.',
                // Sin notas: texto libre de quien reservó.
                ...rs.map((r) => `${p} ${limpio(r.hora, 15)} — ${limpio(r.a_nombre_de, 50)} · ${limpio(r.estado, 20)}${r.pago ? ` · ${limpio(r.pago, 20)}` : ''}${n(r.participantes) > 1 ? ` · ${n(r.participantes)} personas` : ''}`),
                n(f.otras_reservas) ? `Y ${n(f.otras_reservas)} reservas más.` : null,
                ...((f.cupos_de_clase ?? []) as any[]).map((c) => `${p} Clase ${limpio(c.hora, 15)}: ${plural(n(c.personas), 'cupo', 'cupos')}`),
                `Libre: ${libre || '—'}`,
            ];
        }),
        d?.nota ? limpio(d.nota, 160) : null,
    ]);
}

export function plantillaTienda(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const v = d?.vendido ?? {};
    const pa = d?.por_atender ?? {};
    const top = (d?.mas_vendidos ?? []) as any[];
    return unir([
        `${negrita(canal, `${limpio(d?.tienda, 50)} · ${limpio(d?.periodo, 30)}`)} — ${plural(n(d?.pedidos), 'pedido', 'pedidos')}`,
        `Vendido: ${negrita(canal, limpio(v.total))} en ${plural(n(v.pedidos_pagados), 'pedido pagado', 'pedidos pagados')} (ticket promedio ${limpio(v.ticket_promedio)}, ${plural(n(v.unidades), 'unidad', 'unidades')})`,
        ((d?.por_estado ?? []) as any[]).length ? `Por estado: ${(d.por_estado as any[]).map((g) => `${limpio(g.grupo, 20)} ${n(g.pedidos)} (${limpio(g.total)})`).join(' · ')}` : null,
        top.length ? 'Lo más vendido:' : null,
        ...top.slice(0, 5).map((x) => `${p} ${limpio(x.producto, 50)}: ${plural(n(x.unidades), 'unidad', 'unidades')} (${limpio(x.total)})`),
        `Por atender: ${n(pa.comprobantes_por_revisar)} comprobantes por revisar · ${n(pa.pagados_por_preparar)} pagados por preparar · ${n(pa.en_preparacion)} en preparación · ${n(pa.listos_para_retirar)} listos para retirar`,
        d?.nota ? limpio(d.nota, 200) : null,
        pantalla(canal, 'Tienda › Pedidos'),
    ]);
}

export function plantillaInventario(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const lista = (d?.lista ?? []) as any[];
    const fila = (x: any) => {
        const vars = (x.variantes ?? []) as any[];
        const extra = vars.length
            ? `\n${vars.slice(0, 12).map((v) => `   ${limpio(v.nombre, 30)}: ${n(v.disponible)} disponibles`).join('\n')}`
            : n(x.variantes_agotadas) || n(x.variantes_bajas) ? ` · tallas/colores: ${n(x.variantes_agotadas)} agotados, ${n(x.variantes_bajas)} bajos` : '';
        return `${p} ${limpio(x.nombre, 50)}: ${limpio(x.nivel, 10)} — ${n(x.disponible)} disponibles (stock ${n(x.stock)}, reservado ${n(x.reservado)})${extra}`;
    };
    if (d?.encontrados !== undefined) {
        return unir([negrita(canal, 'Inventario'), ...lista.map(fila), d?.nota ? limpio(d.nota, 160) : null]);
    }
    if (!lista.length) {
        return unir([negrita(canal, 'Inventario'), limpio(d?.nota, 200) || `${plural(n(d?.productos), 'producto', 'productos')}, todos con stock normal.`]);
    }
    return unir([
        `${negrita(canal, 'Inventario')} — ${plural(n(d?.productos), 'producto', 'productos')}: ${n(d?.agotados)} agotados, ${n(d?.stock_bajo)} con stock bajo`,
        ...lista.map(fila),
        n(d?.con_stock_normal) ? `${plural(n(d.con_stock_normal), 'producto', 'productos')} con stock normal.` : null,
        d?.nota ? limpio(d.nota, 160) : null,
    ]);
}

export function plantillaServicios(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const ss = (d?.servicios ?? []) as any[];
    return unir([
        negrita(canal, 'Ventas de servicios (últimos 31 días)'),
        ss.length ? null : 'No hay servicios con ventas ni interesados.',
        ...ss.flatMap((s) => [
            '',
            `${p} ${negrita(canal, limpio(s.servicio, 60))}${s.precio ? ` — ${limpio(s.precio)}` : ''}${s.cupos ? ` · cupos: ${limpio(s.cupos, 40)}` : ''}${s.termina ? ` · termina el ${limpio(s.termina, 20)}` : ''}`,
            `   Interesados ${n(s.interesados)} · sin responder ${n(s.sin_responder)} · con datos de pago ${n(s.con_datos_de_pago)} · con comprobante ${n(s.con_comprobante)}`,
            `   Cobros: ${n(s.cobros?.pagados)} pagados · ${n(s.cobros?.por_validar)} por validar · ${n(s.cobros?.pendientes)} pendientes`,
        ]),
        d?.aviso ? limpio(d.aviso, 160) : null,
    ]);
}

export function plantillaWhatsapp(d: any, canal: CanalDirecto): string {
    const p = vineta(canal);
    const r = d?.resumen ?? {};
    const lista = (d?.sin_responder ?? []) as any[];
    return unir([
        `${negrita(canal, 'WhatsApp')} · desde el ${limpio(d?.desde, 30)}`,
        `Escribieron ${n(r.escribieron)} · respondió la escuela ${n(r.respondio_la_escuela)} · el bot ${n(r.respondio_el_bot)} · nadie ${n(r.nadie_respondio)}`,
        `Sin responder: ${n(r.sin_responder)}${n(r.esperando_mas_de_2_horas) ? ` (${n(r.esperando_mas_de_2_horas)} esperan más de 2 h)` : ''}`,
        lista.length ? '' : null,
        // Sin el texto de las preguntas: es lo que escribió la familia.
        ...lista.map((x) => `${p} ${limpio(x.contacto, 50)} — ${limpio(x.tema, 50)}${x.esperando ? ` · espera ${limpio(x.esperando, 20)}` : ''}${(x.preguntas_para_la_escuela ?? []).length ? ` · ${plural(x.preguntas_para_la_escuela.length, 'pregunta', 'preguntas')} para la escuela` : ''}${x.la_atiende_una_persona ? ' · la atiende una persona' : ''}`),
        d?.nota ? limpio(d.nota, 200) : null,
        pantalla(canal, 'WhatsApp › Seguimiento'),
    ]);
}
