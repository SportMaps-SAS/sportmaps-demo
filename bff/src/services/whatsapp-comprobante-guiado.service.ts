/**
 * whatsapp-comprobante-guiado — comprobante: deportista + mes, SIN interrogatorio
 * (spec whatsapp-conversacion-v2-dynasty §3.3).
 *
 * Hoy el 80 % de los comprobantes de la última semana terminó `ignored` porque
 * «el nombre no señala a un único deportista» y nunca se pregunta el mes. El
 * orden nuevo pregunta SOLO lo que falta, con botones:
 *
 *  1. Deportista. Una coincidencia → no se pregunta. 2-3 → botones con los
 *     nombres. Ninguna → «¿De qué deportista es? Escribe nombre y apellido»
 *     (una vez, la pregunta de siempre).
 *  2. Mes. Con el deportista resuelto: 1 cobro pendiente → se aplica sin
 *     preguntar (lo hace el worker); 2+ → botones de cobros (ya existen); SIN
 *     cobros → botones con los últimos 3 meses (+ «Otro mes»). Elegir el mes NO
 *     crea ni aplica nada: va a la bandeja con la propuesta «crear el cobro de
 *     ese mes y aplicarlo».
 *  3. Concepto, solo si el monto no calza con una mensualidad:
 *     [Mensualidad] [Inscripción] [Otro]. También va a la bandeja.
 *  4. Cierre de una línea: «Listo: comprobante de *$150.000* de *Sofía* para
 *     *octubre*. La escuela lo confirma.»
 *
 * Todo se guarda en la fila de la cola (`pregunta_ocr.tipo` + `pregunta_ocr.guia`,
 * jsonb que ya existe: SIN migración). Los botones reusan el id `sm_cobro_N`,
 * que el bot ya traduce a «N» (`textoDeEleccion`), así que la respuesta llega a
 * `resolverRespuestaDeCobro` como un número.
 *
 * NUNCA por audio: un comprobante mueve plata y las notas de voz no se leen
 * como respuesta a estas preguntas (solo botón, número o texto escrito).
 */

import { supabase } from '../config/supabase';
import type { BotonInteractivo } from './whatsapp.service';
import { deportistasEsperados, type DeportistaEsperado } from './whatsapp-pago-esperado.service';
import type { ValorMotivoElegido } from './wa-cobro-desde-comprobante.service';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type TipoGuia = 'deportista' | 'mes' | 'concepto';

export interface OpcionGuiada {
    /** «1», «2»… lo que llega cuando toca el botón. */
    n: number;
    etiqueta: string;
    /** deportista: la ficha; mes: {mes, anio} | 'otro'; concepto: 'mensualidad'|'inscripcion'|'otro'. */
    valor: any;
}

export interface FichaConNombre { id: string; nombre: string; tipo: 'child' | 'unregistered' }

export interface GuiaGuardada {
    opciones: OpcionGuiada[];
    monto: number | null;
    /** El deportista ya resuelto (preguntas de mes y concepto). */
    deportista?: { id: string; tipo: 'child' | 'unregistered'; nombre: string | null; cuota: number | null } | null;
    /** Quién hizo la transferencia (para el motivo de la bandeja). */
    quienPago?: string | null;
    /** Lo que ya se sabe de la propuesta (se agrega al motivo cuando va a la bandeja). */
    propuesta?: string | null;
    parentId?: string | null;
    /**
     * (Plan B4, 2026-10-30) Pregunta de hermanos: el motivo ya está resuelto
     * (matrícula de $310.000) y solo falta de cuál deportista es. Al contestar,
     * se crea el cobro de ESE deportista.
     */
    motivo?: (ValorMotivoElegido & { esperadoId?: string | null }) | null;
}

/** Lo que dejó la pregunta que no salió porque había otra abierta (la persiste `en_fila`). */
export interface PreguntaGuiadaEnFila {
    texto: string;
    paso: string;
    botones: BotonInteractivo[] | null;
    monto: number | null;
}

/**
 * (Plan B4 §3 T4.7) Resumen de una ráfaga en la que el asistente asignó
 * motivos: «¡Recibí 2 comprobantes! ✅ …» con [Sí, está bien][Cambiar un motivo].
 * Lo arma la cola; lo contesta whatsapp-respuesta-de-cobro.
 */
export const PASO_RESUMEN_MOTIVOS = 'resumen_motivos';
export const BOTON_MOTIVOS_OK = { id: 'sm_motivos_ok', title: 'Sí, está bien' } as const;
export const BOTON_MOTIVOS_CAMBIAR = { id: 'sm_motivos_cambiar', title: 'Cambiar un motivo' } as const;

export const PASO_PREGUNTA_MES = 'ask_mes';
export const PASO_PREGUNTA_CONCEPTO = 'ask_concepto';
export const PASO_PREGUNTA_DEPORTISTA_BOTONES = 'ask_deportista_botones';
export const MAX_BOTONES_DEPORTISTA = 3;
export const PREGUNTA_DEPORTISTA_ESCRITA = '¿De qué deportista es? Escribe nombre y apellido.';

const cop = (n: number) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n))}`;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plano = (s: string | null | undefined) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9ñ]+/g, ' ').trim();
const MAX_TITULO = 20;

// ─── Deportista ──────────────────────────────────────────────────────────────

/**
 * Las fichas que el texto nombra con UNA palabra o más (nombre o apellido): a
 * diferencia de `candidatosPorNombre` (≥ 2 palabras, para APLICAR), esto sirve
 * para PREGUNTAR con botones. Gana la(s) que más palabras acierta; si son más de
 * `MAX_BOTONES_DEPORTISTA`, no se ofrece ninguna (se pide escribir). Pura.
 */
export function candidatosParcialesPorNombre(
    textos: (string | null | undefined)[],
    fichas: FichaConNombre[],
    max = MAX_BOTONES_DEPORTISTA,
): FichaConNombre[] {
    const t = ` ${plano(textos.filter(Boolean).join(' '))} `;
    if (t.trim().length < 3) return [];
    let mejor = 0;
    let out: FichaConNombre[] = [];
    for (const f of fichas) {
        const palabras = [...new Set(plano(f.nombre).split(' ').filter((w) => w.length >= 4))];
        const aciertos = palabras.filter((w) => t.includes(` ${w} `)).length;
        if (aciertos === 0) continue;
        if (aciertos > mejor) { mejor = aciertos; out = [f]; } else if (aciertos === mejor) out.push(f);
    }
    return out.length >= 1 && out.length <= max ? out : [];
}

/** «1. Sofía Pérez» recortado a 20 caracteres; el nombre completo va en la descripción. Pura. */
export function botonesDeDeportistas(fichas: FichaConNombre[]): BotonInteractivo[] {
    return fichas.slice(0, MAX_BOTONES_DEPORTISTA).map((f, i) => {
        const partes = f.nombre.trim().split(/\s+/);
        const candidatos = [`${i + 1}. ${partes.slice(0, 2).join(' ')}`, `${i + 1}. ${partes[0]}`];
        const title = candidatos.find((c) => c.length <= MAX_TITULO) ?? candidatos[1].slice(0, MAX_TITULO);
        return { id: `sm_cobro_${i + 1}`, title, descripcion: f.nombre.slice(0, 72) };
    });
}

export function textoPreguntaDeportista(): string {
    return 'Recibí tu comprobante 📄 ¿De cuál deportista es? Toca el nombre o escríbeme su nombre y apellido.';
}

/** Las opciones guardadas de una pregunta de deportista. Pura. */
export function opcionesDeDeportistas(fichas: FichaConNombre[]): OpcionGuiada[] {
    return fichas.slice(0, MAX_BOTONES_DEPORTISTA).map((f, i) => ({ n: i + 1, etiqueta: f.nombre, valor: f }));
}

export async function fichasDeLaEscuela(schoolId: string): Promise<FichaConNombre[]> {
    try {
        const [{ data: hijos }, { data: sinReg }] = await Promise.all([
            supabase.from('children').select('id, full_name').eq('school_id', schoolId).eq('is_active', true).limit(5000),
            supabase.from('unregistered_athletes').select('id, full_name')
                .eq('school_id', schoolId).eq('is_active', true).is('linked_profile_id', null).limit(5000),
        ]);
        return [
            ...((hijos ?? []) as any[]).filter((h) => h.full_name).map((h) => ({ id: h.id as string, nombre: h.full_name as string, tipo: 'child' as const })),
            ...((sinReg ?? []) as any[]).filter((u) => u.full_name).map((u) => ({ id: u.id as string, nombre: u.full_name as string, tipo: 'unregistered' as const })),
        ];
    } catch {
        return [];
    }
}

/** Candidatos para los botones, por los textos del comprobante. Nunca lanza. */
export async function candidatosParaPreguntar(schoolId: string, textos: (string | null | undefined)[]): Promise<FichaConNombre[]> {
    try {
        return candidatosParcialesPorNombre(textos, await fichasDeLaEscuela(schoolId));
    } catch {
        return [];
    }
}

/**
 * Si el usuario tocó un botón de deportista (o escribió su número), la ficha
 * elegida; null si no hay opciones guardadas o el texto no es un número válido.
 * Lee `pregunta_ocr.guia`. Nunca lanza.
 */
export async function deportistaElegidoPorBoton(
    queueId: string,
    texto: string,
): Promise<{ childIds: string[]; unregisteredIds: string[] } | null> {
    const m = String(texto ?? '').trim().match(/^(\d)$/);
    if (!m) return null;
    try {
        const { data } = await supabase.from('whatsapp_inbound_queue').select('pregunta_ocr').eq('id', queueId).maybeSingle();
        const opciones = ((data as any)?.pregunta_ocr?.guia?.opciones ?? []) as OpcionGuiada[];
        const o = opciones.find((x) => x.n === Number(m[1]));
        const f = o?.valor as FichaConNombre | undefined;
        if (!f?.id) return null;
        return f.tipo === 'child' ? { childIds: [f.id], unregisteredIds: [] } : { childIds: [], unregisteredIds: [f.id] };
    } catch {
        return null;
    }
}

// ─── Mes ─────────────────────────────────────────────────────────────────────

export interface MesOpcion { mes: number; anio: number }

/** Los últimos `n` meses, del más reciente al más antiguo (el actual primero). Pura. */
export function ultimosMeses(hoy: Date, n = 3): MesOpcion[] {
    const out: MesOpcion[] = [];
    let y = hoy.getUTCFullYear();
    let m = hoy.getUTCMonth() + 1;
    for (let i = 0; i < n; i++) {
        out.push({ mes: m, anio: y });
        m -= 1;
        if (m === 0) { m = 12; y -= 1; }
    }
    return out;
}

export const nombreDelMes = (m: number) => cap(MESES[m - 1] ?? '');

export function opcionesDeMeses(meses: MesOpcion[]): OpcionGuiada[] {
    return [
        ...meses.map((x, i) => ({ n: i + 1, etiqueta: `${nombreDelMes(x.mes)} ${x.anio}`, valor: x })),
        { n: meses.length + 1, etiqueta: 'Otro mes', valor: 'otro' },
    ];
}

/** Botones de la pregunta de mes; con 4 opciones sale como lista. Pura. */
export function botonesDeOpciones(opciones: OpcionGuiada[]): BotonInteractivo[] {
    return opciones.map((o) => ({
        id: `sm_cobro_${o.n}`,
        title: `${o.n}. ${o.etiqueta}`.slice(0, MAX_TITULO),
        descripcion: o.etiqueta.slice(0, 72),
    }));
}

export function textoPreguntaMes(e: { monto: number | null; atleta: string | null }): string {
    const de = e.atleta ? ` de *${e.atleta.trim().split(/\s+/)[0]}*` : '';
    const por = e.monto ? ` por *${cop(e.monto)}*` : '';
    return `Recibí tu comprobante${por}${de} 📄 ¿De qué mes es? Toca una opción.`;
}

// ─── Concepto ────────────────────────────────────────────────────────────────

export const OPCIONES_CONCEPTO: OpcionGuiada[] = [
    { n: 1, etiqueta: 'Mensualidad', valor: 'mensualidad' },
    { n: 2, etiqueta: 'Inscripción', valor: 'inscripcion' },
    { n: 3, etiqueta: 'Otro', valor: 'otro' },
];

export function textoPreguntaConcepto(e: { monto: number | null }): string {
    return `Recibí tu comprobante${e.monto ? ` por *${cop(e.monto)}*` : ''} 📄 Ese valor no coincide con una mensualidad. ¿Es de…?`;
}

// ─── Interpretar la respuesta ────────────────────────────────────────────────

/**
 * La opción que eligió: el número (botón o escrito) o una palabra de su
 * etiqueta («octubre», «inscripción»). Pura. null si no se entiende.
 */
export function interpretarOpcion(texto: string, opciones: OpcionGuiada[]): OpcionGuiada | null {
    const t = String(texto ?? '').trim();
    const num = t.match(/^(\d)\.?$/);
    if (num) return opciones.find((o) => o.n === Number(num[1])) ?? null;
    const p = ` ${plano(t)} `;
    if (p.trim().length < 3) return null;
    const hits = opciones.filter((o) => plano(o.etiqueta).split(' ').some((w) => w.length >= 4 && p.includes(` ${w} `)));
    return hits.length === 1 ? hits[0] : null;
}

// ─── Textos de cierre ────────────────────────────────────────────────────────

/** El cierre de UNA línea (spec 3.3). Pura. */
export function textoCierreEnRevision(e: {
    monto: number | null; atleta: string | null; para: string | null; abono?: boolean;
}): string {
    const nombre = e.atleta ? ` de *${e.atleta.trim().split(/\s+/)[0]}*` : '';
    const para = e.para ? ` para *${e.para}*` : '';
    const que = e.abono ? 'abono' : 'comprobante';
    return `Listo: ${que}${e.monto ? ` de *${cop(e.monto)}*` : ''}${nombre}${para}. La escuela lo confirma.`;
}

/** `mes` de un cobro («octubre») a partir de su vencimiento/periodo, para el cierre. Pura. */
export function mesDeCobroEnTexto(c: { due_date?: string | null; period_month?: number | null; concept?: string | null }): string | null {
    const mm = Number(c.period_month);
    if (mm >= 1 && mm <= 12) return MESES[mm - 1];
    const m = String(c.concept ?? '').match(/\b(0?[1-9]|1[0-2])\s*[/-]\s*20\d{2}\b/);
    if (m) return MESES[Number(m[1]) - 1];
    const d = String(c.due_date ?? '');
    if (/^\d{4}-\d{2}/.test(d)) return MESES[Number(d.slice(5, 7)) - 1] ?? null;
    return null;
}

// ─── Guardar y resolver la pregunta ──────────────────────────────────────────

/**
 * Deja la fila esperando la respuesta, conservando lo que ya traía
 * `pregunta_ocr` (ocr, sha, storagePath…) y agregando `tipo` y `guia`.
 * Si la conversación está tomada y no se pudo preguntar, quien llama escala.
 */
export async function guardarPreguntaGuiada(
    queueId: string,
    base: { ocr: unknown; sha: string; storagePath: string | null; parentId: string | null; referencias?: string[] },
    tipo: TipoGuia,
    guia: GuiaGuardada,
    /**
     * (Plan B4) `enFila`: la pregunta no salió porque el contacto ya tenía otra
     * abierta. Queda con `pregunta_at` null y sale cuando conteste la anterior.
     */
    o: { enFila?: PreguntaGuiadaEnFila | null } = {},
): Promise<void> {
    const enFila = o.enFila ? { ...o.enFila, monto: o.enFila.monto ?? guia.monto ?? null } : null;
    await supabase.from('whatsapp_inbound_queue')
        .update({
            status: 'waiting_user', locked_until: null, updated_at: new Date().toISOString(),
            pregunta_opciones: [],
            pregunta_ocr: { ...base, referencias: base.referencias ?? [], tipo, guia, ...(enFila ? { en_fila: enFila } : {}) },
            pregunta_at: enFila ? null : new Date().toISOString(),
        })
        .eq('id', queueId);
}

type Responder = (texto: string, paso: string, botones?: BotonInteractivo[]) => Promise<unknown>;

interface FilaGuiada {
    id: string;
    school_id: string;
    retries?: number;
    pregunta_ocr: { tipo?: TipoGuia; guia?: GuiaGuardada; ocr?: any; parentId?: string | null } | null;
}

/** Pasa la fila a la bandeja (ignored + escalated) con su motivo. Solo si seguía esperando. */
async function aLaBandeja(fila: FilaGuiada, motivo: string, childId: string | null): Promise<void> {
    await supabase.from('whatsapp_inbound_queue').update({
        status: 'ignored', result_type: 'escalated', processed_at: new Date().toISOString(),
        error_message: motivo.slice(0, 500), locked_until: null,
        matched_parent_id: fila.pregunta_ocr?.parentId ?? null,
        ...(childId ? { matched_child_id: childId } : {}),
    }).eq('id', fila.id).eq('status', 'waiting_user');
}

/**
 * La respuesta a la pregunta de MES o de CONCEPTO. Devuelve true: consumió el
 * turno. Una respuesta que no se entiende se repregunta UNA vez; a la segunda
 * pasa a la bandeja con lo que ya se sabe. Nunca aplica un cobro ni aprueba.
 */
export async function resolverRespuestaGuiada(
    fila: FilaGuiada,
    texto: string,
    responder: Responder,
): Promise<boolean> {
    const tipo = fila.pregunta_ocr?.tipo;
    const guia = fila.pregunta_ocr?.guia;
    if ((tipo !== 'mes' && tipo !== 'concepto') || !guia?.opciones?.length) return false;

    const opcion = interpretarOpcion(texto, guia.opciones);
    const dep = guia.deportista ?? null;
    const childId = dep?.tipo === 'child' ? dep.id : null;
    const sujeto = dep?.nombre ? `${dep.nombre}` : 'deportista sin identificar';
    const monto = guia.monto;
    const montoTxt = monto ? cop(monto) : 'monto no leído';
    const pagoPor = guia.quienPago ? ` · pagó: ${guia.quienPago}` : '';
    const prop = guia.propuesta ? ` | ${guia.propuesta}` : '';

    if (!opcion) {
        if ((fila.retries ?? 0) < 1) {
            await supabase.from('whatsapp_inbound_queue').update({ retries: (fila.retries ?? 0) + 1 }).eq('id', fila.id);
            const deSiempre = guia.opciones.every((o) => typeof o.valor === 'string');
            await responder(
                tipo === 'mes' ? 'No te entendí 🙏 Toca el mes al que corresponde el comprobante.'
                    : deSiempre ? 'No te entendí 🙏 Toca si es mensualidad, inscripción u otro.'
                        : 'No te entendí 🙏 Toca de qué es el comprobante.',
                tipo === 'mes' ? PASO_PREGUNTA_MES : PASO_PREGUNTA_CONCEPTO, botonesDeOpciones(guia.opciones));
            return true;
        }
        await aLaBandeja(fila, `${tipo === 'mes' ? 'sin_pendientes' : 'monto_no_cuadra'}: la familia no contestó ${tipo === 'mes' ? 'de qué mes es' : 'de qué concepto es'} · ${sujeto} · ${montoTxt}${pagoPor}${prop}`, childId);
        await responder('Gracias 🙏 Le paso tu comprobante a la escuela para que lo aplique y te confirme.', 'guiado_a_la_escuela');
        return true;
    }

    if (tipo === 'mes') {
        if (opcion.valor === 'otro') {
            await aLaBandeja(fila, `sin_pendientes: ${sujeto} no tiene cobros pendientes y la familia dice que es de OTRO mes · ${montoTxt}${pagoPor}${prop}`, childId);
            await responder('Listo 🙏 Le paso tu comprobante a la escuela para que lo ubique en el mes correcto y te confirme.', 'guiado_a_la_escuela');
            return true;
        }
        const { mes, anio } = opcion.valor as MesOpcion;
        const cuota = dep?.cuota ? ` por ${cop(dep.cuota)}` : '';
        await aLaBandeja(fila,
            `sin_pendientes: ${sujeto} no tiene cobro de ${nombreDelMes(mes).toLowerCase()} ${anio} · comprobante de ${montoTxt}${pagoPor}`
            + ` | Propuesta → deportista: ${sujeto} · mes: ${nombreDelMes(mes).toLowerCase()} ${anio} · crear el cobro de ese mes${cuota} y aplicar este comprobante`
            + (guia.propuesta ? ` · ${guia.propuesta.replace(/^Propuesta → /, '')}` : ''),
            childId);
        await responder(textoCierreEnRevision({ monto, atleta: dep?.nombre ?? null, para: nombreDelMes(mes).toLowerCase() }), 'resultado_comprobante_guiado');
        return true;
    }

    // concepto
    // (Plan B4) Con el interruptor, la opción es un motivo con precio (objeto).
    // Si llegó acá es porque el monto no es ese precio (o no se pudo crear): a
    // la bandeja nombrándolo por su etiqueta, como «otro concepto».
    const v = opcion.valor;
    const c = (v && typeof v === 'object' ? 'otro' : v) as 'mensualidad' | 'inscripcion' | 'otro';
    const etiqueta = v && typeof v === 'object'
        ? String((v as { etiqueta?: string }).etiqueta ?? opcion.etiqueta).toLowerCase()
        : c === 'mensualidad' ? 'mensualidad' : c === 'inscripcion' ? 'inscripción' : 'otro concepto';
    const motivo = c === 'otro' || c === 'inscripcion'
        ? `otro_concepto: ${etiqueta} (la familia lo eligió) · ${sujeto} · ${montoTxt}${pagoPor}${prop}`
        : `monto_no_cuadra: la familia dice que es mensualidad de ${sujeto} pero ${montoTxt} no cuadra con la cuota${pagoPor}${prop}`;
    await aLaBandeja(fila, motivo, childId);
    await responder(textoCierreEnRevision({ monto, atleta: dep?.nombre ?? null, para: etiqueta }), 'resultado_comprobante_guiado');
    return true;
}


// ─── Los deportistas de una familia, para preguntar ──────────────────────────

/** Nombres de los deportistas de la familia (para botones). Nunca lanza. */
export async function deportistasParaPreguntar(
    schoolId: string,
    k: { parentId?: string | null; childIds?: string[]; unregisteredIds?: string[] },
): Promise<DeportistaEsperado[]> {
    return deportistasEsperados(schoolId, k);
}

export function fichasDesdeDeportistas(ds: DeportistaEsperado[]): FichaConNombre[] {
    return ds.filter((d) => d.nombre).map((d) => ({ id: d.id, nombre: d.nombre as string, tipo: d.tipo }));
}
