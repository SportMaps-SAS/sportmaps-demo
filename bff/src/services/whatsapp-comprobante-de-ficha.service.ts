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
import { normalizarFrase } from './whatsapp-reglas-turno';
import {
    datosFaltantes, elegirEntreNombres, nombresDeAsistentesEn, textoPidiendoDatos, textoVariosAsistentes, type DatosDeRegistro,
} from './whatsapp-datos-de-registro';

/** Las fichas de una familia en `payments` cuando no hay `parent_id`. */
export interface LlavesDeFicha { childIds: string[]; unregisteredIds: string[] }

export const PREGUNTA_DEPORTISTA = 'Recibí tu comprobante 📄 ¿De qué deportista es este pago? Escríbeme su nombre completo.';
export const PASO_PREGUNTA_DEPORTISTA = 'ask_deportista';
export const TEXTO_YA_REGISTRADO = 'Este pago ya estaba registrado ✅';

const tel10 = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '').slice(-10);

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
    // Empate entre parciales: el nombre COMPLETO escrito tal cual gana («Ana María Gómez»
    // escrito entero contra «Ana María Gómez Ruiz», que comparte las mismas tres palabras).
    if (out.length > 1) {
        const exactas = out.filter((f) => nombreCompletoEn(t, f.nombre));
        if (exactas.length === 1) return exactas;
    }
    return out;
}

/** Las palabras de un nombre sin las partículas («de», «la», «del»…), sin tildes. Pura. */
function palabrasDelNombre(nombre: string | null | undefined): string[] {
    return [...new Set(plano(String(nombre ?? '')).split(' ').filter((w) => w.length >= 2 && !CONECTORES.has(w)))];
}

/**
 * ¿El texto (ya `plano`, con espacios a los lados) trae el nombre COMPLETO de la
 * ficha? Todas sus palabras (al menos dos), en cualquier orden, sin importar
 * mayúsculas, tildes ni lo que haya alrededor («DEPORTISTA :\nETHANN MATIAS PEDRAZA
 * PINTO» trae «Ethann Matías Pedraza Pinto»). Pura.
 */
function nombreCompletoEn(textoPlano: string, nombre: string | null | undefined): boolean {
    const palabras = palabrasDelNombre(nombre);
    return palabras.length >= 2 && palabras.every((w) => textoPlano.includes(` ${w} `));
}

/**
 * La ficha cuyo nombre COMPLETO está escrito en los textos, si es UNA sola (y la que
 * más palabras tiene si un nombre contiene a otro: «Ana Gómez Ruiz» escrito entero
 * gana sobre «Ana Gómez»). Es la única coincidencia que vale para un número que NO
 * está verificado como acudiente: un apellido o dos palabras sueltas no alcanzan
 * (Monster 2026-11-05: «Ethann Pedraza» terminó aplicado a «Laura Sofía Pedraza
 * Sanchez», de otra familia). Pura.
 */
export function fichaExactaPorNombre(textos: (string | null | undefined)[], fichas: FichaConNombre[]): FichaConNombre | null {
    const t = ` ${plano(textos.filter(Boolean).join(' '))} `;
    if (t.trim().length < 3) return null;
    const exactas = fichas.filter((f) => nombreCompletoEn(t, f.nombre));
    if (!exactas.length) return null;
    const largo = (f: FichaConNombre) => palabrasDelNombre(f.nombre).length;
    const max = Math.max(...exactas.map(largo));
    const mejores = exactas.filter((f) => largo(f) === max);
    return mejores.length === 1 ? mejores[0] : null;
}

/**
 * Para un número SIN verificar: la ficha con el nombre completo escrito (`exacta`,
 * la única que permite ligar el comprobante) y, si no la hay, la única parecida
 * (`parecida`, ≥ 2 palabras; SOLO para la propuesta de la bandeja, nunca para
 * aplicar ni para mostrarle nada a quien escribe). Una lectura. Nunca lanza.
 */
export async function deportistaPorNombreSinVerificar(
    schoolId: string,
    textos: (string | null | undefined)[],
): Promise<{ exacta: FichaConNombre | null; parecida: FichaConNombre | null }> {
    if (!textos.some((t) => t && String(t).trim())) return { exacta: null, parecida: null };
    const fichas = await fichasDeLaEscuela(schoolId);
    const exacta = fichaExactaPorNombre(textos, fichas);
    if (exacta) return { exacta, parecida: null };
    const c = candidatosPorNombre(textos, fichas);
    return { exacta: null, parecida: c.length === 1 ? c[0] : null };
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
        const cubre = r.pagosQueYaCubren(registrados, ocr.amount ?? null, r.fechaDeReferencia(ocr.date ?? null, fechaMensaje), ocr.reference ?? null);
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
const NO_NOMBRE = new Set(('enlace enlaces link links url factura facturas cobro cobros colabora colaboras colaboran colaboracion hola buenas buenos buen dia dias tardes tarde noches noche gracias muchas mil ok okey oki ' +
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
    'partidos entreno entrenos entrenamiento entrenamientos grupo femenino masculino mixto trayectoria ' +
    // (auditoría 8–16 nov 2026) interrogativos y verbos de pedido que abrían un «nombre», y «Interesadísimas en la clínica».
    'cuales cuantas quienes quisiera quisieramos podrias podria podrian puedes pueden manejan manejas tendran en desde ' +
    'hasta entre sobre interesado interesada interesados interesadas interes interesa').split(' '));

/** Un enlace o un correo: nunca es un nombre («Https Portaldepago Segurosdelestado Com Pago-agil» quedó de asistente). */
const ENLACE_O_CORREO = /:\/\/|www\.|\.(?:com|co|net|org|io|app|link|me|ly|info|biz|site|online|page|pay|cc|ws)\b|@/i;
/** Un trozo (sin espacios) que es un enlace o un correo. */
const TROZO_DE_ENLACE = /\S*(?::\/\/|www\.|\.(?:com|co|net|org|io|app|link|me|ly|info|biz|site|online|page|pay|cc|ws)\b|@)\S*/gi;

/** ¿El texto trae un enlace o un correo? Pura. */
export function traeEnlaceOCorreo(texto: string | null | undefined): boolean {
    return ENLACE_O_CORREO.test(String(texto ?? ''));
}

/**
 * Tipos de documento: cortan el nombre y lo que les siga («a nombre de Mariana Isabel la Rotta Robles Ti» metió
 * «Ti» en el nombre). El documento nunca se pide ni se guarda.
 */
const TIPO_DE_DOCUMENTO = new Set(['ti', 'cc', 'ce', 'rc', 'nuip', 'tarjeta', 'cedula', 'identidad', 'documento', 'pasaporte',
    'doc', 'identificacion', 'nit']);
/** «T.I.», «C.C.», «R.C.», «C.E.» llegan partidos en dos letras. */
const SIGLA_DE_DOCUMENTO = new Set(['ti', 'cc', 'rc', 'ce']);
/** Lo que sigue al tipo de documento y sigue siendo «el documento»: «de identidad», «No.», «número», los dígitos. */
const COLA_DE_DOCUMENTO = /^(?:de|no|n|nro|num|numero|identidad|ciudadania|extranjeria|civil|registro|\d[\d.]*)$/;

/** Superlativos («interesadísimas», «muchísimas»): no son de un nombre. */
const SUPERLATIVO = /isim[oa]s?$/;

/** ¿La palabra puede ser de un nombre de persona? (ni saludo, ni pago, ni servicio, ni documento). Pura. */
export function puedeSerPalabraDeNombre(palabra: string | null | undefined): boolean {
    const n = String(palabra ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’']/g, '');
    return /^[a-zñ][a-zñ-]+$/.test(n) && !NO_NOMBRE.has(n) && !CONECTORES.has(n) && !TIPO_DE_DOCUMENTO.has(n) && !SUPERLATIVO.test(n);
}

/**
 * Prefijos con los que se contesta el nombre: «Se llama…», «Es para mi hijo…», «Nombre: …»,
 * «La niña…», «El joven…» (2026-11-15: «La niña Gabriela Reina Fonseca» no se leía).
 */
const PREFIJO_NOMBRE = /^(?:(?:hola|bueno|buenas(?: tardes| noches| dias)?|buen dia|buenos dias)\b[\s,.!:;-]*|(?:el )?nombre(?: completo)? de (?:mi |la |el )(?:hijo|hija|ni[ñn]o|ni[ñn]a|nena|nene|sobrino|sobrina|nieto|nieta)(?: es)?\s*:?\s+|(?:el )?nombre(?: completo)?(?: es| de)?\s*:?\s+|se llama\s+|me llamo\s+|mi (?:hijo|hija|ni[ñn]o|ni[ñn]a|nena|nene|sobrino|sobrina|nieto|nieta)(?: se llama| es)?\s*:?\s+|(?:el|la) (?:ni[ñn]o|ni[ñn]a|nena|nene|joven|chico|chica|muchacho|muchacha)(?: se llama| es)?\s*:?\s+|(?:jugador|jugadora|deportista|participante|asistente|alumno|alumna)\s*(?:n[°ºo]?\.?\s*|#\s*)?\d{1,2}\s*[:.)-]?\s+|es para\s+|es\s+|soy\s+|para\s+|a nombre de\s*:?\s+|asiste\s+|(?:el|la) (?:jugador|jugadora|deportista|participante)(?: es)?\s*:?\s+)/i;

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
    const r = nombreAlComienzo(texto);
    if (r) return o.entero && r.resto.length ? null : r.nombre;
    return o.entero ? null : nombreEnOtraLinea(texto);
}

/** El nombre al comienzo del texto, lo que escribió (sin partículas) y lo que sigue después. Pura. */
function nombreAlComienzo(texto: string | null | undefined): { nombre: string; escritas: string[]; resto: string[] } | null {
    let t =String(texto ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
    if (!t || t.length > 160 || t.includes('?') || t.includes('¿')) return null;
    // Un enlace o un correo en la línea del nombre: no es un nombre. En otra línea, corta (no es parte del nombre).
    if (ENLACE_O_CORREO.test(t.split(/\r?\n/)[0])) return null;
    t = t.replace(TROZO_DE_ENLACE, ' § ');
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
        if (NO_NOMBRE.has(n) || SUPERLATIVO.test(n)) break;
        if (CONECTORES.has(n) && !nombre.length) break;
        // «… Robles Ti 1034…», «… T.I. 1034…», «… cédula 1.012…»: el documento y lo que le siga no son del nombre.
        const sigla = w.length === 1 && tokens[i + 1]?.length === 1 && SIGLA_DE_DOCUMENTO.has(n + plano1(tokens[i + 1]));
        if (TIPO_DE_DOCUMENTO.has(n) || sigla) {
            let j = i + (sigla ? 2 : 1);
            while (j < tokens.length && COLA_DE_DOCUMENTO.test(plano1(tokens[j]))) j++;
            i = j;
            break;
        }
        nombre.push(w);
    }
    while (nombre.length && CONECTORES.has(plano1(nombre[nombre.length - 1]))) nombre.pop();
    const palabras = nombre.filter((w) => !CONECTORES.has(plano1(w)));
    if (palabras.length < 2 || palabras.length > 6 || palabras.some((w) => w.length < 2)) return null;
    return {
        nombre: nombre.map((w) => (CONECTORES.has(plano1(w)) ? plano1(w) : capital(w))).join(' ').slice(0, 80),
        escritas: palabras,
        resto: tokens.slice(i),
    };
}

/** Tope del mensaje de varias líneas en el que se busca el nombre. */
const MAX_TEXTO_CON_NOMBRE_EN_OTRA_LINEA = 400;

/**
 * El nombre en una línea que NO es la primera (Monster 2026-11-15: «Comparto soporte pago vacacional 2 semanas
 * (…)\nGabriela Covaleda García\n13 años 6 meses» → null, y el pago no se registró). La línea tiene que ser
 * ENTERA el nombre, y un nombre firme: tres palabras o más, o dos escritas con mayúscula inicial (así «sede suba»
 * o «muchas gracias» en la segunda línea no se vuelven una persona). Pura.
 */
function nombreEnOtraLinea(texto: string | null | undefined): string | null {
    const crudo = String(texto ?? '');
    if (crudo.length > MAX_TEXTO_CON_NOMBRE_EN_OTRA_LINEA || crudo.includes('?') || crudo.includes('¿')) return null;
    const lineas = crudo.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lineas.length < 2) return null;
    for (const linea of lineas.slice(1)) {
        const r = nombreAlComienzo(linea);
        if (!r || r.resto.length) continue;
        if (r.escritas.length >= 3 || r.escritas.every((w) => /^\p{Lu}/u.test(w))) return r.nombre;
    }
    return null;
}

/** Lo que puede seguir al nombre en la nota de un comprobante: «… Posición: Armador Año de nacimiento: 22/06/2007». */
const DATO_TRAS_EL_NOMBRE = /^(?:posicion|ano de nacimiento|fecha de nacimiento|nacimiento|nacio|nacid[oa]|edad|categoria|\d{1,2} anos|\d{1,2} \d{1,2} (?:19|20)\d{2}|armador|armadora|opuesto|opuesta|central|libero|punta|atacante|receptor|receptora|levantador|levantadora)\b/;

/** El nombre al comienzo, seguido de un dato de registro (posición, nacimiento, edad). Pura. */
function nombreSeguidoDeDato(texto: string): string | null {
    const r = nombreAlComienzo(texto);
    if (!r || !r.resto.length) return null;
    return DATO_TRAS_EL_NOMBRE.test(r.resto.slice(0, 5).map((w) => plano1(w)).join(' ')) ? r.nombre : null;
}

/** Marcas con las que se dice el nombre de quien asiste en un pie o en la descripción del pago. */
const MARCA_DE_NOMBRE = /\b(?:a nombre de|nombre(?: completo)?(?: es)?\s*:|(?:nombre(?: completo)? de )?mi (?:hij[oa]|ni[ñn][oa])\s*:|se llama|asiste|participante\s*:|jugador(?:a)?\s*:|deportista\s*:|alumn[oa]\s*:)\s+(.+)$/i;

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
        const resto = palabras.slice(k).join(' ');
        // SOLO el nombre, o el nombre seguido de un dato de registro (Monster 2026-11-15: la nota del Nequi traía
        // «Jesús Giovanni Solarte Chala Posición: Armador Año de nacimiento: 22/06/2007 …» y se preguntó igual).
        const n = nombreDeAsistente(resto, { entero: true }) ?? nombreSeguidoDeDato(resto);
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
    fila: { id: string; school_id: string; pregunta_ocr?: any },
    texto: string,
    responder: (texto: string, paso: string, botones?: BotonInteractivo[], linea?: unknown, payload?: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
    const reg = await import('./wa-registro-de-venta.service');
    const { hoyBogota } = await import('./wa-cobro-desde-comprobante.service');
    const hoy = hoyBogota(Date.now());
    const venta = (fila.pregunta_ocr?.venta ?? {}) as Record<string, any>;
    const guardarEnLaFila = async (cambios: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        if (!fila.pregunta_ocr) return;
        await supabase.from('whatsapp_inbound_queue')
            .update({ pregunta_ocr: { ...fila.pregunta_ocr, venta: { ...venta, ...cambios } }, ...extra })
            .eq('id', fila.id).eq('status', 'waiting_user');
    };

    // (R4) «¿Es para *Nombre*, como la vez pasada?»: sí → los datos de la ficha; otra persona → se piden los datos.
    const confirmar = typeof venta.confirmar?.nombre === 'string' ? venta.confirmar.nombre as string : null;
    if (confirmar) {
        const r = respuestaDeMismoAsistente(texto);
        if (r === 'si') {
            await guardarEnLaFila({ confirmar: null, confirmado: true });
            const { aplicarComprobanteDeVenta } = await import('../jobs/whatsapp-queue.job');
            await aplicarComprobanteDeVenta(fila.id, confirmar, responder);
            return true;
        }
        const dicho = reg.leerRespuestaDeDatos(texto, { hoy });
        const otroNombre = dicho.nombre && !reg.mismaPersona(dicho.nombre, confirmar) ? dicho.nombre : null;
        if (r !== 'otra' && !otroNombre) {
            // Escribió el mismo nombre («sí, para Gabriela Covaleda»): es un sí. Lo demás sigue al bot.
            if (!dicho.nombre) return false;
            await guardarEnLaFila({ confirmar: null, confirmado: true });
            const { aplicarComprobanteDeVenta } = await import('../jobs/whatsapp-queue.job');
            await aplicarComprobanteDeVenta(fila.id, confirmar, responder);
            return true;
        }
        if (!otroNombre) {
            // «Es para otra persona», sin decir quién: se piden los datos (los de la ficha no sirven).
            const item = String(venta.itemNombre ?? 'el servicio');
            await guardarEnLaFila({ confirmar: null, otraPersona: true, registro: null },
                { pregunta_at: new Date().toISOString(), updated_at: new Date().toISOString() });
            await responder(preguntaDeDatosDeServicio(null, item, reg.SIN_REGISTRO, hoy), PASO_PREGUNTA_ASISTENTE, undefined, undefined,
                { faltan_datos: reg.faltantesDe(reg.SIN_REGISTRO, hoy), ...(venta.itemId ? { venta_servicio_id: venta.itemId } : {}) });
            return true;
        }
        await guardarEnLaFila({ confirmar: null, otraPersona: true, registro: { ...dicho, nombre: otroNombre } });
        const { aplicarComprobanteDeVenta } = await import('../jobs/whatsapp-queue.job');
        await aplicarComprobanteDeVenta(fila.id, otroNombre, responder);
        return true;
    }

    // (auditoría 8–16 nov 2026) «Jugador 1: VALENTINA… / Jugador 2: MARIA ALEJANDRA…»: dos personas y un comprobante.
    // El cobro es por persona: no se elige una en silencio. Se pregunta UNA vez de quién es; la respuesta («Valentina»,
    // «la segunda») aplica el comprobante a ese nombre; «son dos cupos» sigue al bot, que se lo pasa a la escuela.
    const sinPregunta = !/[?¿]/.test(texto);
    const ofrecidos = (Array.isArray(venta.variosNombres) ? venta.variosNombres : [])
        .filter((n: unknown): n is string => typeof n === 'string' && !!n.trim());
    if (ofrecidos.length >= 2 && sinPregunta) {
        const elegido = elegirEntreNombres(texto, ofrecidos);
        if (elegido === 'todos') return false;
        if (elegido) {
            await guardarEnLaFila({ variosNombres: null });
            const { aplicarComprobanteDeVenta } = await import('../jobs/whatsapp-queue.job');
            await aplicarComprobanteDeVenta(fila.id, elegido, responder);
            return true;
        }
    }
    // Dos nombres sin marca en dos líneas NO son dos asistentes acá: son quien asiste y su persona responsable.
    const varios = sinPregunta ? nombresDeAsistentesEn(texto, { sinLineasSueltas: true }) : [];
    if (varios.length >= 2) {
        if (ofrecidos.length >= 2) return false; // ya se preguntó una vez: no se repregunta
        await guardarEnLaFila({ variosNombres: varios }, { pregunta_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        await responder(textoVariosAsistentes(varios, { pagado: true }), PASO_PREGUNTA_ASISTENTE, undefined, undefined,
            { asistentes_dichos: varios, ...(venta.itemId ? { venta_servicio_id: venta.itemId } : {}) });
        return true;
    }

    // Lo que ya se sabía al preguntar (ficha, nota del comprobante, chat de la venta) + lo que acaba de decir.
    const conocido = venta.registro ? reg.registroGuardado(venta.registro) : null;
    const datos = reg.combinarConRespuesta(conocido, reg.leerRespuestaDeDatos(texto, { hoy }));
    if (!datos.nombre) return false;
    // La fecha, el acudiente y la posición viajan en la fila: la cola los guarda en la ficha al crear el cobro.
    if (reg.traeOtroDato(datos)) await guardarEnLaFila({ registro: datos });
    const { aplicarComprobanteDeVenta } = await import('../jobs/whatsapp-queue.job');
    await aplicarComprobanteDeVenta(fila.id, datos.nombre, responder);
    return true;
}

// ─── (e-bis) Los datos de registro en la venta (2026-11-16) ─────────────────

/** La cola preguntó «¿Es para *Nombre*, como la vez pasada?» (segunda compra desde el mismo chat). */
export const PASO_CONFIRMAR_ASISTENTE = 'ask_asistente_confirmar';
/** La cola recibió una captura sin fecha ni número de comprobante y pidió la pantalla completa. */
export const PASO_VENTA_INCOMPLETO = 'venta_comprobante_incompleto';

export const BOTONES_MISMO_ASISTENTE: BotonInteractivo[] = [
    { id: 'sm_asiste_si', title: 'Sí' },
    { id: 'sm_asiste_otra', title: 'Es para otra persona' },
];

/** «Recibí tu comprobante de *$140.000* 📄 ¿Es para *Gabriela Covaleda García*, como la vez pasada?» Pura. */
export function preguntaMismoAsistente(monto: number | null, nombre: string): string {
    return `Recibí tu comprobante${monto ? ` de *${pesos(monto)}*` : ''} 📄 ¿Es para *${nombre}*, como la vez pasada?`;
}

/** La respuesta a «¿Es para X, como la vez pasada?»: el botón o lo mismo escrito. Pura. */
export function respuestaDeMismoAsistente(texto: string | null | undefined): 'si' | 'otra' | null {
    const t = normalizarFrase(texto);
    if (!t) return null;
    if (/^(si|sip|sii+|si senor|si senora|si claro|claro|claro que si|correcto|exacto|asi es|el mismo|la misma|si es|si es para (el|ella)|si para (el|ella)|si el mismo|si la misma|es para (el|ella))$/.test(t)) return 'si';
    if (/^(no|nop|no es|no es para (el|ella)|otra|otro|otra persona|es otra persona|es para otra persona|para otra persona|no es para otra persona|no es otra persona)$/.test(t)) return 'otra';
    return null;
}

/**
 * La pregunta de los datos que FALTAN, en un solo mensaje (la escribe `textoPidiendoDatos`), con el valor del
 * comprobante. `registro`: lo que ya se sabe (no se vuelve a pedir). Pura.
 */
export function preguntaDeDatosDeServicio(
    monto: number | null, servicio: string, registro: DatosDeRegistro, hoy: string,
): string {
    const faltan = datosFaltantes(registro, { hoy });
    const texto = textoPidiendoDatos(faltan, { servicio, conComprobante: true, anotado: { ...registro, nombre: null } });
    if (!texto) return preguntaAsistenteDeServicio(monto, servicio);
    return monto ? texto.replace(/^Recibí tu comprobante 📄/, `Recibí tu comprobante de *${pesos(monto)}* 📄`) : texto;
}

/**
 * La respuesta a una captura a la que le faltan la fecha y el número del comprobante (la pantalla «¡Transferencia
 * exitosa!» recortada): que llegó, qué le falta y, de una vez, los datos de registro que falten. Pura.
 */
export function textoCapturaIncompleta(monto: number | null, pedido: string): string {
    return `Recibí tu captura${monto ? ` de *${pesos(monto)}*` : ''} 📄 Le faltan la fecha y el número del comprobante. `
        + `Envíame la pantalla completa del pago, por favor.${pedido ? `\n\n${pedido}` : ''}`;
}

// ─── La respuesta a «¿De qué deportista es este pago?» ──────────────────────

/**
 * Resuelve una fila `waiting_user` que preguntó por el deportista. La decide la cola
 * (`resolverDeportistaDeLaFila`): una opción de los botones solo si es un deportista
 * LIGADO a ese número; un nombre escrito por un número sin verificar, solo con el
 * nombre COMPLETO y el monto de un cobro abierto de ese deportista (Monster
 * 2026-11-05: «1. Laura Sofía», de otra familia, terminó con el pago de Ethann). Lo
 * demás, a la bandeja con la propuesta y sin decirle a quien escribe ningún dato del
 * deportista. No se repregunta. Devuelve true: consumió el turno.
 */
export async function resolverRespuestaDeDeportista(
    fila: { id: string; school_id: string },
    texto: string,
    responder: (texto: string, paso: string) => Promise<unknown>,
): Promise<boolean> {
    const { resolverDeportistaDeLaFila } = await import('../jobs/whatsapp-queue.job');
    await resolverDeportistaDeLaFila(fila.id, texto, responder);
    return true;
}
