/**
 * whatsapp-precios-escuela.service — WhatsApp › Precios: los valores que el bot
 * usa para reconocer pagos y responder precios, en un solo lugar.
 *
 *   mensualidad      offering_plans.price                       (solo lectura aquí)
 *   matrícula        offering_plans.registration_fee            (igual en todos los planes activos)
 *   clase de prueba  school_trial_class_settings.trial_price    (0 = NULL, como guardar_valor_clase_prueba)
 *   artículos        school_merchandise_items                   (para TODAS las escuelas: no exige merchandise_enabled)
 *   servicios        school_tournament_items                    (solo lectura)
 *   interruptores    school_settings.wa_responder_precios / wa_cobro_desde_comprobante
 *
 * El BFF escribe con service role: la RLS no protege nada de esto. La ruta
 * valida que la sesión administre ESA escuela y aquí toda consulta y toda
 * escritura va filtrada por `school_id`. Nada lanza hacia la ruta: los errores
 * de base salen como `{ ok:false, status:500, error:'<clave>' }`.
 */

import { supabase } from '../config/supabase';
import { aplicarPagosUnicosAPlanes } from '../routes/offerings';
import { esMigracionPendiente } from './ventas-servicios.service';
import { itemsDeServicio, opcionesDelItem } from './wa-cobro-desde-comprobante.service';

// ─── Contrato ────────────────────────────────────────────────────────────────

export interface AvisoDePrecios { clave: string; texto: string }

export interface PreciosDeEscuela {
    interruptores: { responde_precios: boolean; cobra_desde_comprobante: boolean };
    mensualidades: { plan_id: string; nombre: string; precio: number | null }[];
    matricula: { valor: number | null; valores_distintos: number[]; planes: number };
    clase_prueba: { valor: number | null; habilitada: boolean };
    articulos: { id: string; nombre: string; precio: number; activo: boolean }[];
    servicios: {
        id: string; nombre: string; tipo: string; precio: number | null; precio_afiliado: number | null;
        opciones: { clave: string; etiqueta: string; precio: number | null; precio_afiliado: number | null }[];
        activo: boolean; vende_por_whatsapp: boolean;
    }[];
    avisos: AvisoDePrecios[];
}

export type ResultadoPrecios =
    | { ok: true; precios: PreciosDeEscuela }
    | { ok: false; status: number; error: string };

const fallo = (status: number, error: string): ResultadoPrecios => ({ ok: false, status, error });

// ─── Validación (pura) ───────────────────────────────────────────────────────

export const MONTO_MAXIMO = 50_000_000;

/** Monto entero, 0 < valor ≤ 50.000.000. Solo números de verdad (ni texto ni decimales). */
export function montoValido(v: unknown): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MONTO_MAXIMO ? v : null;
}

/** null y 0 = «sin valor»; un monto válido = ese monto; lo demás es inválido. */
export function montoOpcional(v: unknown): { ok: true; valor: number | null } | { ok: false } {
    if (v === null || v === 0) return { ok: true, valor: null };
    const n = montoValido(v);
    return n === null ? { ok: false } : { ok: true, valor: n };
}

/** Nombre recortado, de 2 a 80 caracteres. */
export function nombreValido(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\s+/g, ' ').trim();
    return t.length >= 2 && t.length <= 80 ? t : null;
}

const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
};
const positivo = (v: unknown): number | null => { const n = num(v); return n !== null && n > 0 ? n : null; };

/** $310.000 (sin depender del ICU del servidor). */
export const pesos = (n: number) => `$${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

// ─── La ficha contra lo cargado (pura) ───────────────────────────────────────

export type ConceptoDeFicha = 'matricula' | 'inscripcion' | 'uniforme' | 'camiseta';
export interface MontoDeFicha { concepto: ConceptoDeFicha; monto: number }

const CONCEPTOS: { concepto: ConceptoDeFicha; re: RegExp; para: string }[] = [
    { concepto: 'matricula', re: /^matr[ií]culas?$/i, para: 'la matrícula' },
    { concepto: 'inscripcion', re: /^inscripci[oó]n(?:es)?$/i, para: 'la inscripción' },
    { concepto: 'uniforme', re: /^uniformes?$/i, para: 'el uniforme' },
    { concepto: 'camiseta', re: /^camisetas?$/i, para: 'la camiseta' },
];
const RE_CONCEPTO = /matr[ií]culas?|inscripci[oó]n(?:es)?|uniformes?|camisetas?/gi;
/** «310 mil» · «$310.000» / «$ 310,000» / «$310000» · «310.000» / «310000» (sin $, mínimo 5 cifras: un año no es un monto). */
const RE_MONTO = /(?<![\d.,])(?:(\d{1,4})\s?mil\b|\$\s?(\d{1,3}(?:[.,]\d{3})+|\d{4,8})|(\d{1,3}(?:[.,]\d{3})+|\d{5,8}))(?!\d)/gi;
/** Fin de frase: salto de línea, punto y coma, o punto que no es separador de miles. */
const RE_FIN_DE_FRASE = /[\n;]|\.(?=\s|$)/;
const VENTANA = 80;

function montosEn(texto: string): number[] {
    const out: number[] = [];
    for (const m of texto.matchAll(RE_MONTO)) {
        const n = m[1] ? Number(m[1]) * 1000 : Number((m[2] ?? m[3]).replace(/[.,]/g, ''));
        if (Number.isInteger(n) && n >= 1000 && n <= MONTO_MAXIMO) out.push(n);
    }
    return out;
}

/**
 * Los montos que la ficha de prospectos (texto libre) le pone a la matrícula, la
 * inscripción, el uniforme o la camiseta y que NO coinciden con ningún valor
 * cargado. El monto se busca en la misma frase, después de la palabra (hasta la
 * siguiente palabra clave); si no hay, justo antes («$310.000 de matrícula»). Pura.
 */
export function montosDeFichaSinCargar(ficha: string | null | undefined, cargados: Iterable<number>): MontoDeFicha[] {
    if (typeof ficha !== 'string' || !ficha.trim()) return [];
    const conocidos = new Set<number>();
    for (const v of cargados) if (Number.isFinite(v)) conocidos.add(Math.round(v));
    const menciones = [...ficha.matchAll(RE_CONCEPTO)];
    const out: MontoDeFicha[] = [];
    const vistos = new Set<string>();
    menciones.forEach((m, i) => {
        const concepto = CONCEPTOS.find((c) => c.re.test(m[0]))?.concepto;
        if (!concepto) return;
        const fin = (m.index ?? 0) + m[0].length;
        const tope = Math.min(menciones[i + 1]?.index ?? ficha.length, fin + VENTANA);
        const despues = ficha.slice(fin, tope).split(RE_FIN_DE_FRASE)[0];
        let monto: number | undefined = montosEn(despues)[0];
        if (monto === undefined) {
            const anterior = i > 0 ? (menciones[i - 1].index ?? 0) + menciones[i - 1][0].length : 0;
            const desde = Math.max(anterior, (m.index ?? 0) - VENTANA / 2);
            const antes = ficha.slice(desde, m.index ?? 0).split(RE_FIN_DE_FRASE).pop() ?? '';
            // Si la palabra anterior ya se quedó con el monto de después, ese tramo no llega hasta acá.
            monto = montosEn(antes).pop();
        }
        if (monto === undefined || conocidos.has(monto)) return;
        const k = `${concepto}|${monto}`;
        if (vistos.has(k)) return;
        vistos.add(k);
        out.push({ concepto, monto });
    });
    return out;
}

const enLista = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

/** Los avisos de la pantalla, en español de Colombia y sin jerga. Pura. */
export function avisosDePrecios(d: {
    respondePrecios: boolean;
    matriculasDistintas: number[];
    articulosActivos: number;
    fichaSinCargar: MontoDeFicha[];
}): AvisoDePrecios[] {
    const avisos: AvisoDePrecios[] = [];
    if (d.matriculasDistintas.length > 1) {
        avisos.push({
            clave: 'matricula_distinta_por_plan',
            texto: `Tus planes tienen matrículas distintas (${enLista(d.matriculasDistintas.map(pesos))}). `
                + 'Cuando te escribe alguien que todavía no está inscrito, el bot no sabe cuál le corresponde y no puede reconocer su pago de matrícula. '
                + 'Si cobras un solo valor, ponlo igual en todos los planes.',
        });
    } else if (d.matriculasDistintas.length === 0) {
        avisos.push({
            clave: 'sin_matricula',
            texto: 'No tienes un valor de matrícula cargado. Si la cobras, cárgala para que el bot reconozca ese pago.',
        });
    }
    if (d.fichaSinCargar.length) {
        const partes = d.fichaSinCargar.map((f) => `${pesos(f.monto)} para ${CONCEPTOS.find((c) => c.concepto === f.concepto)!.para}`);
        avisos.push({
            clave: 'ficha_menciona_valor_sin_cargar',
            texto: d.fichaSinCargar.length === 1
                ? `Tu ficha de prospectos menciona ${partes[0]}, pero ese valor no está cargado aquí. Cárgalo para que el bot reconozca ese pago.`
                : `Tu ficha de prospectos menciona ${enLista(partes)}, pero esos valores no están cargados aquí. Cárgalos para que el bot reconozca esos pagos.`,
        });
    }
    if (d.articulosActivos === 0) {
        avisos.push({
            clave: 'sin_articulos',
            texto: 'No tienes artículos cargados (uniforme, camiseta, kit…). Si los vendes, agrégalos con su precio para que el bot reconozca esos pagos.',
        });
    }
    if (!d.respondePrecios) {
        avisos.push({
            clave: 'responde_precios_apagado',
            texto: 'El bot no está respondiendo precios por WhatsApp: cuando alguien pregunta cuánto cuesta, no le da los valores. Actívalo si quieres que los responda.',
        });
    }
    return avisos;
}

// ─── Lectura ─────────────────────────────────────────────────────────────────

/** Falta la tabla, la columna o la función (migración sin aplicar o caché de esquema viejo). */
function faltaEsquema(e: unknown): boolean {
    const code = (e as { code?: string } | null)?.code;
    return esMigracionPendiente(e) || code === 'PGRST204' || code === 'PGRST205';
}

const COLUMNAS_AJUSTES = 'wa_responder_precios, wa_cobro_desde_comprobante, wa_ficha_prospectos, wa_ventas_habilitadas, tournament_charges_enabled';

/** Una lectura; si falta alguna columna, la fila entera (lo que no exista se lee como apagado). */
async function leerAjustes(schoolId: string): Promise<{ fila: Record<string, unknown> | null; error: unknown }> {
    const leer = (cols: string) => supabase.from('school_settings').select(cols).eq('school_id', schoolId).maybeSingle();
    let { data, error } = await leer(COLUMNAS_AJUSTES);
    if (error && faltaEsquema(error)) ({ data, error } = await leer('*'));
    return { fila: (data as Record<string, unknown> | null) ?? null, error: error ?? null };
}

/** El objeto del GET. Una lectura por fuente, en paralelo. Nunca lanza. */
export async function leerPreciosDeEscuela(schoolId: string): Promise<ResultadoPrecios> {
    try {
        const [ajustes, planes, clase, articulos, servicios] = await Promise.all([
            leerAjustes(schoolId),
            supabase.from('offering_plans').select('id, name, price, registration_fee')
                .eq('school_id', schoolId).eq('is_active', true).order('name').limit(500),
            supabase.from('school_trial_class_settings').select('*').eq('school_id', schoolId).maybeSingle(),
            supabase.from('school_merchandise_items').select('id, name, price, price_by_size, active')
                .eq('school_id', schoolId).order('sort_order').order('name').limit(200),
            itemsDeServicio(schoolId),
        ]);
        if (ajustes.error || planes.error
            || (clase.error && !faltaEsquema(clase.error))
            || (articulos.error && !faltaEsquema(articulos.error))) {
            console.error('[precios-escuela] lectura falló', {
                schoolId,
                ajustes: (ajustes.error as any)?.message, planes: planes.error?.message,
                clase: clase.error?.message, articulos: articulos.error?.message,
            });
            return fallo(500, 'error_leyendo_precios');
        }

        const fila = ajustes.fila ?? {};
        const filasPlanes = (planes.data ?? []) as any[];
        const filaClase = (clase.error ? null : clase.data) as Record<string, unknown> | null;
        const filasArticulos = (articulos.error ? [] : (articulos.data ?? [])) as any[];
        const vendePorWhatsapp = fila.wa_ventas_habilitadas === true && fila.tournament_charges_enabled === true;

        const interruptores = {
            responde_precios: fila.wa_responder_precios === true,
            cobra_desde_comprobante: fila.wa_cobro_desde_comprobante === true,
        };
        const mensualidades = filasPlanes.map((p) => ({ plan_id: String(p.id), nombre: String(p.name ?? ''), precio: num(p.price) }));
        const valoresMatricula = [...new Set(filasPlanes.map((p) => positivo(p.registration_fee)).filter((v): v is number => v !== null))]
            .sort((a, b) => a - b);
        const claseValor = positivo(filaClase?.trial_price);
        const listaArticulos = filasArticulos.map((a) => ({
            id: String(a.id), nombre: String(a.name ?? ''), precio: num(a.price) ?? 0, activo: a.active !== false,
        }));
        const listaServicios = servicios.map((s) => ({
            id: s.id,
            nombre: String(s.name ?? ''),
            tipo: String(s.kind ?? 'otro'),
            precio: num(s.price),
            precio_afiliado: num(s.precio_afiliado),
            opciones: opcionesDelItem(s).map((o) => ({
                clave: o.clave, etiqueta: o.etiqueta, precio: o.precio, precio_afiliado: o.precio_afiliado ?? null,
            })),
            activo: s.active !== false,
            vende_por_whatsapp: vendePorWhatsapp && s.active !== false,
        }));

        // Todo lo que el bot puede reconocer hoy: contra eso se contrasta la ficha.
        const cargados: number[] = [...valoresMatricula];
        for (const m of mensualidades) if (m.precio) cargados.push(m.precio);
        if (claseValor) cargados.push(claseValor);
        for (const a of filasArticulos) {
            if (a.active === false) continue;
            const p = positivo(a.price);
            if (p) cargados.push(p);
            if (a.price_by_size && typeof a.price_by_size === 'object') {
                for (const v of Object.values(a.price_by_size as Record<string, unknown>)) { const n = positivo(v); if (n) cargados.push(n); }
            }
        }
        for (const s of listaServicios) {
            for (const v of [s.precio, s.precio_afiliado, ...s.opciones.flatMap((o) => [o.precio, o.precio_afiliado])]) if (v && v > 0) cargados.push(v);
        }

        return {
            ok: true,
            precios: {
                interruptores,
                mensualidades,
                matricula: {
                    valor: valoresMatricula.length === 1 ? valoresMatricula[0] : null,
                    valores_distintos: valoresMatricula,
                    planes: filasPlanes.length,
                },
                // Sin fila de configuración = clase de prueba prendida (default de la tabla).
                clase_prueba: { valor: claseValor, habilitada: filaClase?.enabled !== false },
                articulos: listaArticulos,
                servicios: listaServicios,
                avisos: avisosDePrecios({
                    respondePrecios: interruptores.responde_precios,
                    matriculasDistintas: valoresMatricula,
                    articulosActivos: listaArticulos.filter((a) => a.activo).length,
                    fichaSinCargar: montosDeFichaSinCargar(fila.wa_ficha_prospectos as string | null, cargados),
                }),
            },
        };
    } catch (e: any) {
        console.error('[precios-escuela] lectura falló', { schoolId, err: e?.message });
        return fallo(500, 'error_leyendo_precios');
    }
}

// ─── Escrituras (todas devuelven el objeto del GET ya actualizado) ───────────

const esObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Envuelve una escritura: lo que lance o falle en la base sale como 500 con clave. */
async function escribir(schoolId: string, que: string, fn: () => Promise<ResultadoPrecios | null>): Promise<ResultadoPrecios> {
    try {
        const r = await fn();
        return r ?? await leerPreciosDeEscuela(schoolId);
    } catch (e: any) {
        console.error(`[precios-escuela] ${que} falló`, { schoolId, err: e?.message });
        return fallo(500, 'error_guardando');
    }
}

export async function guardarInterruptores(schoolId: string, body: unknown): Promise<ResultadoPrecios> {
    if (!esObjeto(body)) return fallo(400, 'interruptores_invalidos');
    const patch: Record<string, boolean> = {};
    for (const [campo, columna] of [['responde_precios', 'wa_responder_precios'], ['cobra_desde_comprobante', 'wa_cobro_desde_comprobante']] as const) {
        if (body[campo] === undefined) continue;
        if (typeof body[campo] !== 'boolean') return fallo(400, 'interruptores_invalidos');
        patch[columna] = body[campo] as boolean;
    }
    if (!Object.keys(patch).length) return fallo(400, 'interruptores_invalidos');

    return escribir(schoolId, 'interruptores', async () => {
        const upd = await supabase.from('school_settings').update(patch).eq('school_id', schoolId).select('school_id');
        if (upd.error) {
            if (faltaEsquema(upd.error)) return fallo(503, 'migracion_pendiente');
            throw new Error(`school_settings: ${upd.error.message}`);
        }
        if (!(upd.data ?? []).length) {
            const ins = await supabase.from('school_settings').insert({ school_id: schoolId, ...patch });
            if (ins.error) throw new Error(`school_settings: ${ins.error.message}`);
        }
        return null;
    });
}

/** La misma matrícula en TODOS los planes activos de la escuela (null o 0 = sin matrícula). */
export async function guardarMatricula(schoolId: string, body: unknown): Promise<ResultadoPrecios> {
    const v = esObjeto(body) ? montoOpcional(body.valor) : { ok: false as const };
    if (!v.ok) return fallo(400, 'valor_invalido');

    return escribir(schoolId, 'matrícula', async () => {
        const { data, error } = await supabase.from('offering_plans').select('id')
            .eq('school_id', schoolId).eq('is_active', true).limit(500);
        if (error) throw new Error(`offering_plans: ${error.message}`);
        const ids = ((data ?? []) as any[]).map((p) => String(p.id));
        if (!ids.length) return fallo(409, 'sin_planes_activos');
        // La regla (0 = NULL, un solo UPDATE acotado a la escuela) vive en offerings.ts.
        await aplicarPagosUnicosAPlanes(schoolId, ids, { registration_fee: v.valor });
        return null;
    });
}

/** 0 se guarda como NULL, igual que la RPC guardar_valor_clase_prueba; sin fila, se crea con sus defaults. */
export async function guardarClasePrueba(schoolId: string, body: unknown): Promise<ResultadoPrecios> {
    const v = esObjeto(body) ? montoOpcional(body.valor) : { ok: false as const };
    if (!v.ok) return fallo(400, 'valor_invalido');

    return escribir(schoolId, 'clase de prueba', async () => {
        const { error } = await supabase.from('school_trial_class_settings')
            .upsert({ school_id: schoolId, trial_price: v.valor, updated_at: new Date().toISOString() }, { onConflict: 'school_id' });
        if (error) {
            if (faltaEsquema(error)) return fallo(503, 'migracion_pendiente');
            throw new Error(`school_trial_class_settings: ${error.message}`);
        }
        return null;
    });
}

export async function crearArticulo(schoolId: string, body: unknown): Promise<ResultadoPrecios> {
    if (!esObjeto(body)) return fallo(400, 'articulo_invalido');
    const nombre = nombreValido(body.nombre);
    if (!nombre) return fallo(400, 'nombre_invalido');
    const precio = montoValido(body.precio);
    if (precio === null) return fallo(400, 'precio_invalido');

    return escribir(schoolId, 'crear artículo', async () => {
        const { error } = await supabase.from('school_merchandise_items').insert({ school_id: schoolId, name: nombre, price: precio });
        if (error) throw new Error(`school_merchandise_items: ${error.message}`);
        return null;
    });
}

/** Nunca se borra: se desactiva. El artículo tiene que ser de ESTA escuela (si no, 404). */
export async function actualizarArticulo(schoolId: string, articuloId: string, body: unknown): Promise<ResultadoPrecios> {
    if (!esObjeto(body)) return fallo(400, 'articulo_invalido');
    const patch: Record<string, unknown> = {};
    if (body.nombre !== undefined) {
        const nombre = nombreValido(body.nombre);
        if (!nombre) return fallo(400, 'nombre_invalido');
        patch.name = nombre;
    }
    if (body.precio !== undefined) {
        const precio = montoValido(body.precio);
        if (precio === null) return fallo(400, 'precio_invalido');
        patch.price = precio;
    }
    if (body.activo !== undefined) {
        if (typeof body.activo !== 'boolean') return fallo(400, 'activo_invalido');
        patch.active = body.activo;
    }
    if (!Object.keys(patch).length) return fallo(400, 'sin_cambios');

    return escribir(schoolId, 'actualizar artículo', async () => {
        const { data, error } = await supabase.from('school_merchandise_items')
            .update(patch).eq('id', articuloId).eq('school_id', schoolId).select('id');
        if (error) throw new Error(`school_merchandise_items: ${error.message}`);
        if (!(data ?? []).length) return fallo(404, 'articulo_no_encontrado');
        return null;
    });
}
