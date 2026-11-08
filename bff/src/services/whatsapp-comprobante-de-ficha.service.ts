/**
 * whatsapp-comprobante-de-ficha — comprobantes que el bot escalaba porque no
 * sabía de quién eran (Dynasty, 28-sep → 08-oct: 43 de 188 adjuntos).
 *
 *  (a) Familia SIN cuenta pero con ficha por teléfono (`children.parent_phone_temp`
 *      o `unregistered_athletes.guardian_phone/phone`): el cobro se busca por
 *      la ficha (`child_id` / `unregistered_athlete_id`) y se aplica igual que a
 *      una familia con cuenta. No se le pide crear la cuenta para pagar.
 *  (b) Número SIN ficha: se busca al deportista por nombre en lo que escribió
 *      (pie, chat, concepto del comprobante, nombre de quien paga). Con un
 *      único candidato se aplica; si no, se pregunta UNA vez «¿De qué
 *      deportista es este pago?» y la respuesta se resuelve igual (único
 *      candidato o a la escuela).
 *  (c) Varios cobros pendientes: la pregunta sale con botones (concepto + monto).
 *  (d) Sin pendientes: si ya hay un pago aprobado que coincide (monto + fecha,
 *      o la referencia del banco), «Este pago ya estaba registrado ✅».
 *
 * Nunca se adivina: un nombre con dos candidatos no se aplica a ninguno.
 *
 *  (e) (2026-11-08) En la VENTA de un servicio (clínica, torneo, vacacional) el
 *      comprobante no es de un deportista del club: se pregunta UNA vez el
 *      nombre completo de quien asiste («¿Cuál es el nombre completo de quien
 *      asiste a la Clínica…?») y con la respuesta se crea el cobro del servicio.
 *      Nunca «¿De qué deportista?» contra el padrón. Ver whatsapp-queue.job
 *      (`atenderComprobanteDeVenta`).
 */

import { supabase } from '../config/supabase';
import type { OcrResult } from './ocr.service';
import { normalizeReference } from './receipt-verdict';
import { describirPago, type PagoPendiente } from './whatsapp-receipt-matching.service';
import type { BotonInteractivo } from './whatsapp.service';
import { categoriaDelCobro, etiquetaCortaDelCobro } from './tipo-de-cobro';
import { deportistaElegidoPorBoton } from './whatsapp-comprobante-guiado.service';
import { normalizarFrase } from './whatsapp-reglas-turno';

/** Las fichas de una familia en `payments` cuando no hay `parent_id`. */
export interface LlavesDeFicha { childIds: string[]; unregisteredIds: string[] }

export const PREGUNTA_DEPORTISTA = 'Recibí tu comprobante 📄 ¿De qué deportista es este pago? Escríbeme su nombre completo.';
export const PASO_PREGUNTA_DEPORTISTA = 'ask_deportista';
export const TEXTO_YA_REGISTRADO = 'Este pago ya estaba registrado ✅';

const tel10 = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '').slice(-10);
const hayLlaves = (k: LlavesDeFicha | null | undefined): k is LlavesDeFicha =>
    !!k && (k.childIds.length > 0 || k.unregisteredIds.length > 0);

// ─── (a) Fichas por teléfono ────────────────────────────────────────────────

/**
 * Las fichas activas cuyo acudiente tiene este celular. Últimos 10 dígitos y
 * solo celulares, como `wa_identify_by_phone`. Nunca lanza.
 */
export async function fichasPorTelefono(schoolId: string, waPhone: string): Promise<LlavesDeFicha> {
    const vacio = { childIds: [], unregisteredIds: [] };
    const t = tel10(waPhone);
    if (!/^3\d{9}$/.test(t)) return vacio;
    try {
        const [{ data: hijos }, { data: sinReg }] = await Promise.all([
            supabase.from('children').select('id, parent_phone_temp')
                .eq('school_id', schoolId).eq('is_active', true)
                .ilike('parent_phone_temp', `%${t}`).limit(10),
            supabase.from('unregistered_athletes').select('id, guardian_phone, phone')
                .eq('school_id', schoolId).eq('is_active', true).is('linked_profile_id', null)
                .or(`guardian_phone.ilike.%${t},phone.ilike.%${t}`).limit(10),
        ]);
        return {
            childIds: ((hijos ?? []) as any[]).filter((h) => tel10(h.parent_phone_temp) === t).map((h) => h.id),
            unregisteredIds: ((sinReg ?? []) as any[])
                .filter((u) => tel10(u.guardian_phone) === t || tel10(u.phone) === t).map((u) => u.id),
        };
    } catch {
        return vacio;
    }
}

// ─── (b) Deportista por nombre ──────────────────────────────────────────────

export interface FichaConNombre { id: string; nombre: string; tipo: 'child' | 'unregistered' }

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9ñ]+/g, ' ').trim();

/**
 * Las fichas que el texto nombra. Pura. Cuenta como nombrada la que tiene al
 * menos DOS palabras de su nombre (≥ 3 letras) escritas en el texto —«Sara» o
 * «Pérez» solos son media escuela—, y gana la que más palabras acierta. Puede
 * devolver varias: el llamador solo aplica si hay UNA.
 */
export function candidatosPorNombre(
    textos: (string | null | undefined)[],
    fichas: FichaConNombre[],
): FichaConNombre[] {
    const t = ` ${plano(textos.filter(Boolean).join(' '))} `;
    if (t.trim().length < 3) return [];
    let mejor = 0;
    let out: FichaConNombre[] = [];
    for (const f of fichas) {
        const palabras = [...new Set(plano(f.nombre ?? '').split(' ').filter((w) => w.length >= 3))];
        if (palabras.length < 2) continue;
        const aciertos = palabras.filter((w) => t.includes(` ${w} `)).length;
        if (aciertos < 2) continue;
        if (aciertos > mejor) { mejor = aciertos; out = [f]; } else if (aciertos === mejor) out.push(f);
    }
    return out;
}

/** Deportistas activos de la escuela (con y sin cuenta), con su nombre. Nunca lanza. */
async function fichasDeLaEscuela(schoolId: string): Promise<FichaConNombre[]> {
    try {
        const [{ data: hijos }, { data: sinReg }] = await Promise.all([
            supabase.from('children').select('id, full_name')
                .eq('school_id', schoolId).eq('is_active', true).limit(5000),
            supabase.from('unregistered_athletes').select('id, full_name')
                .eq('school_id', schoolId).eq('is_active', true).is('linked_profile_id', null).limit(5000),
        ]);
        return [
            ...((hijos ?? []) as any[]).filter((h) => h.full_name).map((h) => ({ id: h.id, nombre: h.full_name, tipo: 'child' as const })),
            ...((sinReg ?? []) as any[]).filter((u) => u.full_name).map((u) => ({ id: u.id, nombre: u.full_name, tipo: 'unregistered' as const })),
        ];
    } catch {
        return [];
    }
}

/** La ficha que los textos nombran, si es UNA sola; null si ninguna o varias. */
export async function deportistaPorNombre(
    schoolId: string,
    textos: (string | null | undefined)[],
): Promise<LlavesDeFicha | null> {
    if (!textos.some((t) => t && String(t).trim())) return null;
    const c = candidatosPorNombre(textos, await fichasDeLaEscuela(schoolId));
    if (c.length !== 1) return null;
    return c[0].tipo === 'child'
        ? { childIds: [c[0].id], unregisteredIds: [] }
        : { childIds: [], unregisteredIds: [c[0].id] };
}

// ─── Cobros por llaves ──────────────────────────────────────────────────────

/**
 * Pendientes de la familia por sus llaves (parent_id y/o fichas). Import
 * diferido: la recuperación importa el worker y el worker importa esto.
 */
export async function pendientesPorLlaves(
    schoolId: string,
    k: { parentId?: string | null } & Partial<LlavesDeFicha>,
): Promise<PagoPendiente[]> {
    try {
        const { pendientesDeLaFamilia } = await import('./whatsapp-recuperacion.service');
        return await pendientesDeLaFamilia(schoolId, k);
    } catch {
        return [];
    }
}

// ─── (d) ¿Ya estaba registrado? ─────────────────────────────────────────────

/**
 * El pago YA APROBADO (paid/partial) de la familia que este comprobante ya
 * cubre: la misma referencia de banco, o mismo monto con fecha de registro
 * dentro de la ventana de la recuperación (-3 / +20 días). Nunca lanza.
 */
export async function pagoYaRegistrado(
    schoolId: string,
    k: { parentId?: string | null } & Partial<LlavesDeFicha>,
    ocr: Pick<OcrResult, 'amount' | 'date' | 'reference'>,
    fechaMensaje: string,
): Promise<{ id: string; concept: string | null } | null> {
    try {
        const norm = normalizeReference(ocr.reference);
        if (norm && norm.length >= 6) {
            for (const [col, val] of [['ocr_reference', String(ocr.reference)], ['receipt_reference_norm', norm]] as const) {
                const { data } = await supabase.from('payments').select('id, concept')
                    .eq('school_id', schoolId).in('status', ['paid', 'partial'])
                    .eq(col, val).limit(1);
                if (Array.isArray(data) && data.length) return { id: (data[0] as any).id, concept: (data[0] as any).concept ?? null };
            }
        }
        const r = await import('./whatsapp-recuperacion.service');
        const registrados = (await r.pagosRegistradosDe(schoolId, k)).filter((p) => p.status === 'paid' || p.status === 'partial');
        const cubre = r.pagosQueYaCubren(registrados, ocr.amount ?? null, r.fechaDeReferencia(ocr.date ?? null, fechaMensaje));
        return cubre.length ? { id: cubre[0].id, concept: cubre[0].concept } : null;
    } catch {
        return null;
    }
}

// ─── (c) Botones de la pregunta «¿a cuál cobro?» ────────────────────────────

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const pesos = (n: number) => `$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n)}`;
const MAX_TITULO = 20;

/**
 * «Inscrip.», «Seguro», «Torneo»… si el cobro es un pago único reconocible
 * (por su categoría o, en opciones viejas sin categoría, por su concepto).
 * null = mensualidad o un cobro sin tipo claro: el botón sigue con el mes. Pura.
 */
export function rotuloDePagoUnico(p: Pick<PagoPendiente, 'concept' | 'due_date'> & { categoria?: string | null }): string | null {
    const cat = categoriaDelCobro({ payment_category: p.categoria ?? null, concept: p.concept });
    if (cat === 'mensualidad' || cat === 'otro') return null;
    return etiquetaCortaDelCobro({ payment_category: cat, concept: p.concept, due_date: p.due_date });
}

/** Prefijo del id de cada botón: «sm_cobro_2» = la opción 2. */
export const PREFIJO_BOTON_COBRO = 'sm_cobro_';

/**
 * Un botón por cobro: «1. Sep $150.000» (con el primer nombre si son de
 * varios deportistas: «2. Sara Oct $150.000»). Más de 3 salen como lista
 * (`sendInteractiveButtons`), con el concepto completo en la descripción. Pura.
 */
export function botonesDeCobros(opciones: PagoPendiente[]): BotonInteractivo[] {
    const varios = new Set(opciones.map((p) => p.child_id ?? p.atleta ?? '')).size > 1;
    return opciones.map((p, i) => {
        const m = p.due_date ? Number(String(p.due_date).slice(5, 7)) : NaN;
        const mesDeVencimiento = Number.isInteger(m) && m >= 1 && m <= 12 ? MES[m - 1].replace(/^./, (c) => c.toUpperCase()) : '';
        // Un pago único (inscripción, seguro, torneo…) vence el mismo día que la
        // mensualidad del alta: «Oct $180.000 / Oct $300.000 / Oct $35.000» no
        // dice cuál es cuál. Va su tipo corto en vez del mes (2026-10-10).
        const mes = rotuloDePagoUnico(p) ?? mesDeVencimiento;
        const nombre = varios && p.atleta ? String(p.atleta).trim().split(/\s+/)[0] : '';
        const n = `${i + 1}.`;
        const candidatos = [
            [n, nombre, mes, pesos(p.amount)], [n, nombre, pesos(p.amount)], [n, mes, pesos(p.amount)], [n, pesos(p.amount)],
        ].map((partes) => partes.filter(Boolean).join(' '));
        const title = candidatos.find((c) => c.length <= MAX_TITULO) ?? candidatos[candidatos.length - 1];
        return { id: `${PREFIJO_BOTON_COBRO}${i + 1}`, title, descripcion: describirPago(p).slice(0, 72) };
    });
}

/**
 * Lo que vale como respuesta a la pregunta: el número del botón tocado (el
 * título trae el monto, y «$15.000» no puede leerse como la opción 15). Pura.
 */
export function textoDeEleccion(botonId: string | null | undefined, texto: string): string {
    const m = String(botonId ?? '').match(/^sm_cobro_(\d{1,2})$/);
    return m ? m[1] : texto;
}

// ─── (e) Venta de un servicio: el nombre de quien asiste ─────────────────────

export const PASO_PREGUNTA_ASISTENTE = 'ask_asistente_servicio';
/** Plan §4.C: «ya lo teníamos», sin cobro nuevo. */
export const TEXTO_VENTA_REPETIDO = 'Ese comprobante ya lo teníamos ✅';

/** Primera palabra del servicio → artículo. «Clínica…» → la; «Torneo…» → el; si no se sabe, ninguno. */
const FEMENINOS = new Set(['clinica', 'copa', 'jornada', 'semana', 'clase', 'salida', 'excursion', 'escuela', 'liga',
    'competencia', 'convivencia', 'gira', 'temporada', 'capacitacion', 'charla', 'practica', 'carrera', 'maraton',
    'olimpiada', 'valida', 'feria', 'muestra', 'actividad', 'experiencia']);
const MASCULINOS = new Set(['torneo', 'campamento', 'vacacional', 'curso', 'viaje', 'festival', 'partido', 'evento',
    'taller', 'encuentro', 'entrenamiento', 'seminario', 'cuadrangular', 'triangular', 'intercambio', 'campeonato',
    'clinic', 'camp', 'programa', 'plan', 'paseo', 'reto', 'desafio']);

function articuloDe(servicio: string): 'la' | 'el' | null {
    const primera = normalizarFrase(servicio).split(' ')[0] ?? '';
    if (FEMENINOS.has(primera)) return 'la';
    if (MASCULINOS.has(primera)) return 'el';
    return null;
}

/** «para la *Clínica…*», «para el *Torneo…*», «para *Copa Relámpago*». Pura. */
export function paraElServicio(servicio: string): string {
    const art = articuloDe(servicio);
    return `para ${art ? `${art} ` : ''}*${servicio.trim()}*`;
}

/** «a la *Clínica…*», «al *Torneo…*», «a *X*». Pura. */
export function aElServicio(servicio: string): string {
    const art = articuloDe(servicio);
    return `${art === 'el' ? 'al' : art === 'la' ? 'a la' : 'a'} *${servicio.trim()}*`;
}

/** «Recibí tu comprobante de *$300.000* 📄 ¿Cuál es el nombre completo de quien asiste a la *Clínica…*?» Pura. */
export function preguntaAsistenteDeServicio(monto: number | null, servicio: string): string {
    return `Recibí tu comprobante${monto ? ` de *${pesos(monto)}*` : ''} 📄 ` +
        `¿Cuál es el nombre completo de quien asiste ${aElServicio(servicio)}?`;
}

/** Partículas que van DENTRO de un nombre («María de los Ángeles», «Van der Berg»). */
const CONECTORES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'do', 'dos', 'van', 'von', 'der', 'san', 'santa']);

/**
 * Palabras que nunca son parte de un nombre (normalizadas): saludos, cortesías,
 * preguntas, pagos, servicios, días, meses, posiciones de juego. Cortan el nombre.
 */
const NO_NOMBRE = new Set(('hola buenas buenos buen dia dias tardes tarde noches noche gracias muchas mil ok okey oki ' +
    'listo lista dale perfecto perfecta vale claro si no ya que como cuando donde cual cuanto cuantos cuanta ' +
    'quien porque por para con sin aqui aca alli ahi esto este esta ese esa eso estos estas envio envie envia mando ' +
    'mande adjunto adjunta pago pague pagado pagada pagamos pagar abono abone saldo cupo cupos comprobante soporte ' +
    'transferencia consignacion nequi daviplata bancolombia davivienda clinica torneo campamento vacacional clase ' +
    'inscripcion valor precio cuenta quedo atento atenta favor porfa porfavor confirmar confirmo confirmas mi mis tu tus ' +
    'su sus hijo hija hijos hijas nino nina el lo le les me te se un una unos unas al es son soy estoy tengo tiene ' +
    'tienen fue era hay va voy sera puede puedo quiero queria gustaria necesito saber info informacion horario hora ' +
    'fecha lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto ' +
    'septiembre setiembre octubre noviembre diciembre opuesto opuesta armador armadora atacante central libero punta ' +
    'receptor receptora posicion ano anos edad nacido nacida nacimiento categoria sede asiste asistira participa ' +
    'nombre nombres apellido apellidos completo completa llama llamo jugador jugadora deportista participante alumno ' +
    'alumna listos ninguno nada otro otra tambien igual entonces pero ademas todo bien mal super genial excelente ' +
    'disculpa disculpe perdon senor senora don dona profe profesor profesora entrenador pregunta preguntar pregunto ' +
    'consulta duda club equipo escuela torneos clinicas oye aun todavia voley voleibol futbol playa piso partido ' +
    'partidos entreno entrenos entrenamiento entrenamientos grupo femenino masculino mixto trayectoria').split(' '));

/** Prefijos con los que se contesta el nombre: «Se llama…», «Es para mi hijo…», «Nombre: …». */
const PREFIJO_NOMBRE = /^(?:(?:hola|bueno|buenas(?: tardes| noches| dias)?|buen dia|buenos dias)\b[\s,.!:;-]*|(?:el )?nombre(?: completo)?(?: es| de)?\s*:?\s+|se llama\s+|me llamo\s+|mi (?:hijo|hija|nino|nina|sobrino|sobrina|nieto|nieta)(?: se llama| es)?\s+|es para\s+|es\s+|soy\s+|para\s+|a nombre de\s+|asiste\s+|(?:el|la) (?:jugador|jugadora|deportista|participante)(?: es)?\s*:?\s+)/i;

const plano1 = (w: string) => w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const capital = (w: string) => w.charAt(0).toLocaleUpperCase('es-CO') + w.slice(1).toLocaleLowerCase('es-CO');

/**
 * El nombre de una persona al COMIENZO del texto, o null. Pura.
 * Toma palabras de letras desde el principio hasta un número, un signo de
 * pregunta o una palabra que no es de nombre («Nicolás Cubides Ávila 18 de
 * Diciembre del 2006 Opuesto» → «Nicolás Cubides Ávila»). Exige al menos DOS
 * palabras de nombre (se pidió el nombre completo). `entero`: además, el texto
 * entero tiene que ser el nombre (para un pie o un texto suelto, sin pregunta).
 */
export function nombreDeAsistente(texto: string | null | undefined, o: { entero?: boolean } = {}): string | null {
    let t = String(texto ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
    if (!t || t.length > 160 || t.includes('?') || t.includes('¿')) return null;
    for (let i = 0; i < 4; i++) {
        const sin = t.replace(PREFIJO_NOMBRE, '').trim();
        if (sin === t) break;
        t = sin;
    }
    const tokens = t.split(/[\s,;:.!()"“”/]+/).filter(Boolean);
    const nombre: string[] = [];
    let i = 0;
    for (; i < tokens.length; i++) {
        const w = tokens[i];
        if (!/^[\p{L}][\p{L}'’-]*$/u.test(w)) break;
        const n = plano1(w).replace(/[’']/g, '');
        if (NO_NOMBRE.has(n)) break;
        if (CONECTORES.has(n) && !nombre.length) break;
        nombre.push(w);
    }
    while (nombre.length && CONECTORES.has(plano1(nombre[nombre.length - 1]))) nombre.pop();
    const palabras = nombre.filter((w) => !CONECTORES.has(plano1(w)));
    if (palabras.length < 2 || palabras.length > 6 || palabras.some((w) => w.length < 2)) return null;
    if (o.entero && i < tokens.length) return null;
    return nombre.map((w) => (CONECTORES.has(plano1(w)) ? plano1(w) : capital(w))).join(' ').slice(0, 80);
}

/** Marcas con las que se dice el nombre de quien asiste en un pie o en la descripción del pago. */
const MARCA_DE_NOMBRE = /\b(?:a nombre de|nombre(?: completo)?(?: es)?\s*:|se llama|asiste|participante\s*:|jugador(?:a)?\s*:|deportista\s*:|alumn[oa]\s*:)\s+(.+)$/i;

/**
 * El nombre de quien asiste si ya viene con el archivo. Nunca el titular de la
 * cuenta que pagó (`originName`): suele ser el papá. Pura.
 *  · `pie` (el pie de la foto y la descripción del pago que leyó el OCR): con
 *    una marca («a nombre de…», «se llama…», «participante: …») o un texto que
 *    es SOLO un nombre («Nicolás Cubides Ávila»), quitando antes las palabras
 *    del pago y del servicio («Clínica Nicolás Cubides»);
 *  · `chat` (lo que escribió alrededor): SOLO con una marca. Un texto suelto
 *    del chat puede ser cualquier cosa («Club y torneos», un botón del embudo).
 */
export function nombreDeAsistenteEnTextos(
    pie: (string | null | undefined)[], servicio: string, chat: (string | null | undefined)[] = [],
): string | null {
    for (const crudo of chat) {
        const m = String(crudo ?? '').trim().match(MARCA_DE_NOMBRE);
        const n = m ? nombreDeAsistente(m[1]) : null;
        if (n) return n;
    }
    const textos = pie;
    const delServicio = new Set(normalizarFrase(servicio).split(' ').filter((w) => w.length >= 3));
    // Lo que va antes del nombre en un pie: «Comprobante clínica — Laura Gómez», «Abono clínica Laura…».
    const ruido = (w: string) => {
        const n = plano1(w).replace(/[^a-z0-9]/g, '');
        return !n || delServicio.has(n) || CONECTORES.has(n)
            || /^(pagos?|abonos?|saldo|cupos?|inscripcion|clinica|torneo|campamento|vacacional|comprobantes?|soportes?|transferencia|consignacion|envio|adjunto|aqui|va|mira)$/.test(n);
    };
    for (const crudo of textos) {
        const texto = String(crudo ?? '').trim();
        if (!texto) continue;
        const m = texto.match(MARCA_DE_NOMBRE);
        if (m) {
            const n = nombreDeAsistente(m[1]);
            if (n) return n;
        }
        // «Soy Juan…» / «me llamo…» es quien ESCRIBE (suele ser el papá), no quien asiste.
        if (/^(?:hola[\s,.!]*)?(?:soy|me llamo)\b/i.test(texto)) continue;
        const palabras = texto.split(/\s+/);
        let k = 0;
        while (k < palabras.length && ruido(palabras[k])) k++;
        const n = nombreDeAsistente(palabras.slice(k).join(' '), { entero: true });
        if (n) return n;
    }
    return null;
}

/**
 * La respuesta a «¿Cuál es el nombre completo de quien asiste…?»: si trae un
 * nombre, la cola crea el cobro del servicio a ese nombre (`aplicarComprobanteDeVenta`).
 * Si no es un nombre (una pregunta sobre el servicio, «ok»), NO consume el turno:
 * lo atiende el bot y la pregunta sigue abierta (a las 24 h va al buzón). No se
 * repregunta: la pregunta va UNA vez.
 */
export async function resolverRespuestaDeAsistente(
    fila: { id: string; school_id: string },
    texto: string,
    responder: (texto: string, paso: string, botones?: BotonInteractivo[], linea?: unknown, payload?: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
    const nombre = nombreDeAsistente(texto);
    if (!nombre) return false;
    const { aplicarComprobanteDeVenta } = await import('../jobs/whatsapp-queue.job');
    await aplicarComprobanteDeVenta(fila.id, nombre, responder);
    return true;
}

// ─── La respuesta a «¿De qué deportista es este pago?» ──────────────────────

/**
 * Resuelve una fila `waiting_user` que preguntó por el deportista: un único
 * candidato → se aplica como familia con ficha; si no → a la escuela. No se
 * repregunta (la pregunta va UNA vez). Devuelve true: consumió el turno.
 */
export async function resolverRespuestaDeDeportista(
    fila: { id: string; school_id: string },
    texto: string,
    responder: (texto: string, paso: string) => Promise<unknown>,
): Promise<boolean> {
    // Tocó uno de los botones con nombres (spec 3.3, 2026-10-24): «1», «2» o «3».
    const porBoton = await deportistaElegidoPorBoton(fila.id, texto);
    const llaves = porBoton ?? await deportistaPorNombre(fila.school_id, [texto]);
    if (!hayLlaves(llaves)) {
        await responder('Gracias 🙏 No encontré a ese deportista, así que le paso tu comprobante a la escuela para que lo aplique.',
            'deportista_a_la_escuela');
        await supabase.from('whatsapp_inbound_queue').update({
            status: 'ignored', result_type: 'escalated', processed_at: new Date().toISOString(),
            error_message: 'sin_familia: el nombre no señala a un único deportista',
        }).eq('id', fila.id).eq('status', 'waiting_user');
        return true;
    }
    const { aplicarComprobanteDeFicha } = await import('../jobs/whatsapp-queue.job');
    await aplicarComprobanteDeFicha(fila.id, llaves, responder);
    return true;
}
