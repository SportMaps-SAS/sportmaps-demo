/**
 * Valores de la escuela para quien pregunta «¿cuánto cuesta?» (ajuste
 * `wa_responder_precios`, spec docs/specs/whatsapp-ajustes-por-escuela.md).
 *
 * Besser: «si pregunta cuánto cuesta, indicamos el valor, no que deba pagar».
 * Se informa la lista de precios de los planes activos (`offering_plans`) —la
 * misma que ve la escuela en su catálogo— y NO se manda enlace de pago.
 * Los planes en $0 (p. ej. «CORTESÍA») no son un precio: se omiten.
 *
 * DETERMINISTA: un valor redactado por el modelo es justo lo que una familia
 * después reclama.
 */
import { supabase } from '../config/supabase';
import { pesos } from './whatsapp-reclamo-valor.service';
import type { PrecioDeMotivo } from './wa-cobro-desde-comprobante.service';

export interface PlanConPrecio {
    nombre: string | null;
    precio: number | string | null;
    /** `offering_plans.max_sessions`: clases al mes. Sin dato (null/0) no se inventa. */
    clases?: number | string | null;
}

/** «8 clases al mes» / «1 clase al mes»; null si el plan no tiene un tope cargado. */
export function textoDeClases(clases: number | string | null | undefined): string | null {
    const n = Math.round(Number(clases ?? 0));
    if (!Number.isFinite(n) || n <= 0) return null;
    return `${n} ${n === 1 ? 'clase' : 'clases'} al mes`;
}

/** «4 DÍAS / SEMANA (PROFUNDIZACIÓN) » → «4 días por semana (profundización)». */
export function nombreDePlan(nombre: string | null | undefined): string {
    const t = String(nombre ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const minus = t === t.toUpperCase() ? t.toLowerCase() : t;
    const conPor = minus.replace(/\s*\/\s*semana\b/gi, ' por semana');
    return conPor.charAt(0).toUpperCase() + conPor.slice(1);
}

/** Lista de precios en texto, de menor a mayor. null = no hay ningún plan con valor. */
export function textoDePrecios(planes: PlanConPrecio[]): string | null {
    const vistos = new Set<string>();
    const lista = planes
        .map((p) => ({ nombre: nombreDePlan(p.nombre), precio: Math.round(Number(p.precio ?? 0)), clases: textoDeClases(p.clases) }))
        .filter((p) => p.nombre && Number.isFinite(p.precio) && p.precio > 0)
        .filter((p) => {
            const clave = `${p.nombre.toLowerCase()}|${p.precio}`;
            if (vistos.has(clave)) return false;
            vistos.add(clave);
            return true;
        })
        .sort((a, b) => a.precio - b.precio);
    if (!lista.length) return null;
    // «Plan pro: *$150.000* · 8 clases al mes». Sin clases cargadas no se escribe nada (no se inventa).
    return ['💰 Estos son los valores de la mensualidad:',
        ...lista.map((p) => `• ${p.nombre}: *${pesos(p.precio)}*${p.clases ? ` · ${p.clases}` : ''}`)].join('\n');
}

// ─── Matrícula y artículos (Monster 2026-11-16) ──────────────────────────────
//
// El bot solo sabía la mensualidad: la matrícula (`offering_plans.registration_fee`)
// y los artículos (`school_merchandise_items`) había que escribirlos a mano en la
// ficha, y el verificador de salida rechazaba cualquier otra cifra. Ahora salen de
// los campos, con las MISMAS lecturas y la misma regla del reconocimiento de
// comprobantes (`preciosDeMotivos`): si los planes activos tienen matrículas
// distintas y no se sabe el plan, no se afirma ninguna.

/** Lo que la escuela tiene cargado además de la mensualidad. */
export interface ValoresFijos {
    /** null = no hay, o los planes activos tienen valores distintos (no se afirma ninguno). */
    matricula: number | null;
    /** Un artículo activo con su precio (y los de cada talla, de menor a mayor). */
    articulos: { nombre: string; precios: number[] }[];
}

/** Tope de artículos que se listan en un mensaje de WhatsApp. */
const MAX_ARTICULOS_EN_TEXTO = 12;

/** De los precios del reconocimiento de comprobantes, la matrícula y los artículos. Pura. */
export function valoresFijosDe(precios: PrecioDeMotivo[]): ValoresFijos {
    const matriculas = [...new Set(precios
        .filter((p) => p.motivo === 'inscripcion' && !p.esAbono && p.monto > 0).map((p) => Math.round(p.monto)))];
    const porArticulo = new Map<string, { nombre: string; precios: Set<number> }>();
    for (const p of precios) {
        if (p.motivo !== 'articulos' || p.esAbono || !(p.monto > 0)) continue;
        const nombre = String(p.etiqueta ?? '').replace(/\s+/g, ' ').trim();
        if (!nombre) continue;
        const llave = p.fuenteId ?? nombre.toLowerCase();
        const a = porArticulo.get(llave) ?? { nombre, precios: new Set<number>() };
        a.precios.add(Math.round(p.monto));
        porArticulo.set(llave, a);
    }
    return {
        matricula: matriculas.length === 1 ? matriculas[0] : null,
        articulos: [...porArticulo.values()]
            .map((a) => ({ nombre: a.nombre, precios: [...a.precios].sort((x, y) => x - y) }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    };
}

/** ¿Hay matrícula o algún artículo para decir? Pura. */
export function hayValoresFijos(v: ValoresFijos | null | undefined): boolean {
    return !!v && (v.matricula !== null || v.articulos.length > 0);
}

/**
 * Matrícula y artículos en líneas aparte, o null si no hay ninguno. Pura.
 * «📝 Matrícula: *$310.000*» / «👕 Uniformes y artículos:» + un renglón por artículo.
 */
export function textoDeValoresFijos(v: ValoresFijos | null | undefined): string | null {
    if (!v || !hayValoresFijos(v)) return null;
    const bloques: string[] = [];
    if (v.matricula !== null) bloques.push(`📝 Matrícula: *${pesos(v.matricula)}*`);
    if (v.articulos.length) {
        const lista = v.articulos.slice(0, MAX_ARTICULOS_EN_TEXTO).map((a) => (a.precios.length === 1
            ? `• ${a.nombre}: *${pesos(a.precios[0])}*`
            : `• ${a.nombre}: de *${pesos(a.precios[0])}* a *${pesos(a.precios[a.precios.length - 1])}* según la talla`));
        if (v.articulos.length > MAX_ARTICULOS_EN_TEXTO) lista.push('• Hay más artículos: pregúntale a la escuela por el que necesites.');
        bloques.push(['👕 Uniformes y artículos:', ...lista].join('\n'));
    }
    return bloques.join('\n\n');
}

/**
 * Los montos que el asistente puede decir por estos valores: la matrícula, cada
 * precio de artículo y la SUMA matrícula + un artículo (lo que paga quien entra:
 * $310.000 + $60.000 = $370.000). Pura.
 */
export function montosDeValoresFijos(v: ValoresFijos | null | undefined): number[] {
    if (!v) return [];
    const articulos = v.articulos.flatMap((a) => a.precios);
    return [...new Set([
        ...(v.matricula !== null ? [v.matricula] : []),
        ...articulos,
        ...(v.matricula !== null ? articulos.map((a) => (v.matricula as number) + a) : []),
    ])];
}

const SIN_VALORES_FIJOS: ValoresFijos = { matricula: null, articulos: [] };

/**
 * Matrícula y artículos activos de la escuela, por las lecturas del
 * reconocimiento de comprobantes (una por fuente, sin N+1). Nunca lanza.
 */
export async function valoresFijosDeEscuela(schoolId: string): Promise<ValoresFijos> {
    try {
        if (!schoolId) return SIN_VALORES_FIJOS;
        const { preciosDeMotivos } = await import('./wa-cobro-desde-comprobante.service');
        return valoresFijosDe(await preciosDeMotivos(schoolId, {}, { motivos: ['inscripcion', 'articulos'] }));
    } catch {
        return SIN_VALORES_FIJOS;
    }
}

/** Solo las mensualidades de los planes activos. Nunca lanza. */
async function textoDeMensualidadesDeEscuela(schoolId: string): Promise<string | null> {
    try {
        const { data, error } = await supabase
            .from('offering_plans')
            .select('name, price, is_active, max_sessions')
            .eq('school_id', schoolId)
            .eq('is_active', true)
            .order('price', { ascending: true })
            .limit(30);
        if (error || !Array.isArray(data)) return null;
        return textoDePrecios((data as any[]).map((p) => ({ nombre: p.name, precio: p.price, clases: p.max_sessions })));
    } catch {
        return null;
    }
}

/**
 * Los valores de la escuela: las mensualidades de los planes activos y, en líneas
 * aparte, la matrícula y los artículos que tenga cargados. null = no hay ninguno.
 * Quien llama ya revisó `wa_responder_precios`. Nunca lanza.
 */
export async function textoDePreciosDeEscuela(schoolId: string): Promise<string | null> {
    const [mensualidades, fijos] = await Promise.all([
        textoDeMensualidadesDeEscuela(schoolId),
        valoresFijosDeEscuela(schoolId),
    ]);
    return [mensualidades, textoDeValoresFijos(fijos)].filter(Boolean).join('\n\n') || null;
}

// ─── «¿Cuántas clases tiene el plan pro?» (Dynasty 2026-10-24) ────────────────
//
// Sin regla, la pregunta se quedaba en silencio y una hora después salía «Todavía
// nadie de la escuela ha podido contestarte». El dato está en el catálogo
// (`offering_plans.max_sessions`): se contesta determinista, sin escalar.
// «Plan pro» (8 clases) no es «PLAN SELECCION» (sin tope cargado): cada plan se
// busca por su nombre COMPLETO y el que no tiene `max_sessions` NO inventa nada.

export interface PlanDeCatalogo extends PlanConPrecio { activo?: boolean | null }

/** Normaliza para comparar nombres de plan: sin tildes, sin signos, sin «plan». */
function claveDePlan(t: string | null | undefined): string {
    return normalizarPrecio(t).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/^plan /, '').trim();
}

/**
 * ¿Pregunta cuántas clases (o días, o veces por semana) trae un plan?
 * «¿El plan pro cuántas clases son?», «cuántas clases incluye la mensualidad»,
 * «¿cuántas veces a la semana es el plan elite?». Debe nombrar un plan o decir
 * «plan(es)» / «mensualidad»: «¿cuántas clases hay hoy?» no es esto. Pura.
 */
export function preguntaPorClasesDePlan(texto: string | null | undefined): boolean {
    const t = normalizarPrecio(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
    if (!t) return false;
    if (YA_PAGA.some((re) => re.test(t))) return false;
    const cuantas = /\bcuantas (clases|sesiones|veces|dias|horas)\b/.test(t)
        || /\bcuantos (dias|entrenamientos|entrenos|cupos)\b/.test(t)
        || /\bcuantas son\b/.test(t);
    if (!cuantas) return false;
    return /\b(plan|planes|mensualidad|paquete|paquetes|incluye|incluyen)\b/.test(t);
}

export interface RespuestaClases { texto: string; sinDato: boolean }

/**
 * La respuesta, sobre el catálogo de planes activos. null = no hay con qué
 * contestar (sin planes). `sinDato` = nombró un plan que no trae tope de clases:
 * se dice que la escuela lo confirma y el bot lo deja en el buzón. Pura.
 */
export function respuestaClasesDePlan(planes: PlanDeCatalogo[], texto: string | null | undefined): RespuestaClases | null {
    const activos = planes.filter((p) => p.activo !== false && nombreDePlan(p.nombre));
    if (!activos.length) return null;
    const t = ` ${normalizarPrecio(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
    // Un plan «coincide» si TODAS las palabras de su nombre están en la pregunta; gana el de nombre más largo.
    const coincidentes = activos
        .map((p) => ({ p, clave: claveDePlan(p.nombre) }))
        .filter(({ clave }) => clave && clave.split(' ').every((w) => t.includes(` ${w} `)))
        .sort((a, b) => b.clave.length - a.clave.length);
    const elegido = coincidentes[0]?.p;
    if (elegido) {
        const nombre = nombreDePlan(elegido.nombre).replace(/^plan /i, '');
        const clases = textoDeClases(elegido.clases);
        const precio = Math.round(Number(elegido.precio ?? 0));
        if (!clases) {
            return { sinDato: true, texto: `El plan *${nombre}* no tiene un número de clases fijo en mi catálogo; ` +
                'la escuela te confirma cuántas incluye y te responde por aquí. 🙏' };
        }
        return { sinDato: false, texto: `El plan *${nombre}* incluye *${clases}*` +
            (precio > 0 ? ` y cuesta *${pesos(precio)}* al mes.` : '.') };
    }
    // No nombró un plan que exista: la lista completa (con clases donde se sabe).
    const lista = textoDePrecios(activos);
    return lista ? { sinDato: false, texto: lista } : null;
}

/** Catálogo activo de la escuela → respuesta. Nunca lanza (null: sigue el camino de siempre). */
export async function responderClasesDePlan(schoolId: string, texto: string | null | undefined): Promise<RespuestaClases | null> {
    if (!preguntaPorClasesDePlan(texto)) return null;
    try {
        const { data, error } = await supabase
            .from('offering_plans')
            .select('name, price, is_active, max_sessions')
            .eq('school_id', schoolId)
            .eq('is_active', true)
            .order('price', { ascending: true })
            .limit(30);
        if (error || !Array.isArray(data)) return null;
        return respuestaClasesDePlan((data as any[]).map((p) => ({
            nombre: p.name, precio: p.price, clases: p.max_sessions, activo: p.is_active })), texto);
    } catch {
        return null;
    }
}

// ─── El precio en la PRIMERA respuesta al prospecto (embudo 2026-10-08) ──────
//
// Dynasty, 24 prospectos en 6 días: 9 preguntaron el precio y el bot dio 0
// cifras aunque `wa_responder_precios` estaba prendido. La pregunta venía junto
// con otra («¿qué precio tiene? ¿horarios? ¿desde qué edad?») y ganaba la rama
// de la clase de cortesía, que solo mandaba el enlace. Ahora cualquier
// respuesta al prospecto que pidió precio lleva la lista corta en el MISMO
// mensaje y, si dijo la edad, el grupo que le corresponde.

function normalizarPrecio(texto: string | null | undefined): string {
    return String(texto ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/\s+/g, ' ').trim();
}

/** Lo de una familia que ya paga (comprobante, «ya te envío la mensualidad», saldo): no es pregunta de precio. */
const YA_PAGA: RegExp[] = [
    /\b(comprobantes?|consign\w*|transfer\w*|pague|pagamos|ya (te |le )?(envi|mand)\w*|te envio|soportes?|recibo)\b/,
    /\b(pendientes?|debo|debemos|paz y salvo|del mes)\b/,
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/,
    // «¿En qué horario se puede ir a cancelar la mensualidad?»: cómo pagar, no cuánto.
    /\b(cancelar|pagar|abonar) (la |el )?(mensualidad|cuota)\b/,
    /\b(como|donde) (pago|pagar|cancelo)\b/,
];

/**
 * ¿Pregunta cuánto cuesta? «qué precio tiene», «costos», «cuánto es la
 * mensualidad», «y los precios», «cuánto sería? 130 mil?». Pura.
 * «Mensualidad agosto» / «ya te envío la mensualidad» / «valor pendiente»: no.
 */
export function pidePrecio(texto: string | null | undefined): boolean {
    const t = normalizarPrecio(texto);
    if (!t) return false;
    if (YA_PAGA.some((re) => re.test(t))) return false;
    if (/\b(precios?|valor(es)?|costos?|tarifas?)\b/.test(t)) return true;
    if (/\bcuanto (cuesta|cuestan|vale|valen|cobran|es|son|sale|salen|seria|serian|esta|estan|pago|se paga)\b/.test(t)) return true;
    if (/\bmensualidad(es)?\b/.test(t) && /(\?|\bcuanto\b|\bque\b|\bcomo\b|\binfo\w*)/.test(t)) return true;
    return false;
}

/** Lo que se sabe del deportista para elegir el grupo. */
export interface PerfilPrecio { edad?: number | null; genero?: 'f' | 'm' | null; adulto?: boolean }

/**
 * Lista corta de mensualidades + el grupo para la edad (si la dijo y los
 * grupos tienen edades). Pura: la arma quien tiene los datos.
 */
export function bloqueDePreciosProspecto(precios: string | null, lineaGrupo: string | null): string | null {
    if (!precios) return null;
    return lineaGrupo ? `${precios}\n\n👉 ${lineaGrupo}` : precios;
}

/**
 * El bloque de precios para un prospecto, o null si la escuela no responde
 * precios (`wa_responder_precios` apagado) o no tiene planes con valor.
 * `perfil` con edad → «Para 12 años le corresponde …». Nunca lanza.
 */
export async function preciosParaProspecto(
    schoolId: string,
    responderPrecios: boolean,
    perfil: PerfilPrecio | null = null,
): Promise<string | null> {
    if (!responderPrecios) return null;
    try {
        const precios = await textoDePreciosDeEscuela(schoolId);
        if (!precios) return null;
        let linea: string | null = null;
        if (perfil && (typeof perfil.edad === 'number' || perfil.adulto)) {
            const { rangosDeEscuela, elegirGrupo, textoGrupoParaEdad } = await import('./grupos-por-edad.service');
            const rangos = await rangosDeEscuela(schoolId).catch(() => []);
            if (rangos.length) linea = textoGrupoParaEdad(elegirGrupo(rangos, perfil), perfil);
        }
        return bloqueDePreciosProspecto(precios, linea);
    } catch {
        return null;
    }
}
