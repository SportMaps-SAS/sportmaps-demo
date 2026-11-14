/**
 * receipt-verdict — Pipeline de decisión determinístico para comprobantes.
 *
 * El LLM (ocr.service) SOLO extrae. Aquí las REGLAS deciden. Esta función es
 * pura y sin I/O: recibe el OcrResult + los hechos de BD ya resueltos por el
 * caller (cuentas registradas, referencia ya usada, hash duplicado) y devuelve
 * un veredicto `verde | amarillo | rojo` con la lista de razones.
 *
 * Diseño (spec §2, docs/specs/receipt-extraction-v2-glosas.md):
 *   - ROJO   → imposible/fraude. Rechazo directo, NO genera glosa.
 *   - AMARILLO → discutible. En fases siguientes abre glosa.
 *   - Se evalúan TODOS los checks (no short-circuit) para que el admin vea todo.
 *   - El veredicto final = el peor nivel presente (rojo > amarillo > verde).
 *
 * Los `code` de cada razón se alinean con GlosaReason (spec §5.2) para que las
 * fases 3+ construyan la glosa sin re-mapear.
 */

import type { OcrResult } from './ocr.service';
import { describirCategorias } from './payment-accounts';

export type Verdict = 'verde' | 'amarillo' | 'rojo';

/** Códigos estables. Los AMARILLO mapean 1:1 a GlosaReason en fases posteriores. */
export type VerdictCode =
    | 'NOT_A_RECEIPT'
    | 'IS_TRANSACTION_LIST'
    | 'CAMPOS_ILEGIBLES'
    | 'DESTINO_NO_COINCIDE'
    | 'DESTINO_AUSENTE'
    | 'MONTO_DIFIERE'
    | 'FECHA_FUERA_VENTANA'
    | 'FECHA_FUTURA'
    | 'REFERENCIA_DUPLICADA'
    | 'IMAGEN_DUPLICADA'
    | 'FORMATO_REFERENCIA'
    | 'POSIBLE_MANIPULACION';

export interface VerdictReason {
    /** Nº de check en la tabla §2 (1..9). */
    check: number;
    code: VerdictCode;
    level: 'rojo' | 'amarillo';
    /** Mensaje orientado al admin/panel. El texto al acudiente se traduce en la capa de notificación. */
    message: string;
    detail?: Record<string, unknown>;
}

export interface VerdictContext {
    /** Valor esperado del cobro. Si se omite, no se evalúa el check de monto (§2.5). */
    expectedAmount?: number | null;
    /**
     * Identificadores de destino registrados de la escuela, YA normalizados con
     * normalizeDestination(). Si es undefined/vacío no se evalúa el check 4
     * (no hay con qué cruzar — típico en modo sombra sin cuentas cargadas).
     */
    registeredAccounts?: string[];
    /**
     * Llaves de la escuela que NO valen para este cobro porque están
     * restringidas a otras categorías (`payment_accounts[].only_for`, p.ej. el
     * Nequi de inscripciones de Dynasty). YA normalizadas. Si el destino cae en
     * una de estas, el dinero sí fue a la escuela pero por el canal de otro
     * concepto: AMARILLO (revisión humana), nunca rojo — rechazarlo haría que la
     * familia pagara dos veces.
     */
    restrictedAccounts?: { value: string; onlyFor: string[] }[];
    /**
     * Cuentas que la escuela acepta «por fuera de SportMaps» (2026-10-13), YA
     * normalizadas. NO cuentan como destino de la escuela en el veredicto (un
     * comprobante a ellas sale DESTINO_NO_COINCIDE); el worker y la
     * recuperación las usan para clasificar el comprobante como informativo.
     */
    cuentasFueraDeSportmaps?: string[];
    /** Categoría resuelta del cobro (solo para el detalle del motivo). */
    paymentCategory?: string | null;
    /** Ventana de días hacia atrás permitida para la fecha (§2.6). Default 5. */
    dateWindowDays?: number;
    /** Hoy en Bogotá, ISO yyyy-mm-dd. Lo inyecta el caller (mantiene la fn pura). */
    today: string;
    /** check 7 (BD): reference_norm ya usada en la escuela. */
    referenceAlreadyUsed?: boolean;
    /** check 8 (BD): image_sha256 ya visto. */
    imageHashDuplicate?: boolean;
}

export interface VerdictResult {
    verdict: Verdict;
    reasons: VerdictReason[];
    /** Referencia normalizada (para índice único / dedup en fase 2). null si no hay referencia. */
    referenceNorm: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formas de referencia, calibradas contra comprobantes reales el 2026-09-11.
//
// El bloque anterior indexaba por banco y decía «PUNTO DE PARTIDA — calibrar con
// comprobantes reales antes de confiar». Esta es esa calibración, medida sobre
// las 317 referencias que había en la base, y cambia dos cosas de fondo.
//
// 1) NO se indexa por banco declarado, porque el banco NO es confiable. Medido:
//    comprobantes rotulados "Bancolombia" traen referencias con forma Nequi
//    (M01914211) y forma Bre-B (TRMgzmmFhKEC). Tiene sentido — Nequi es de
//    Bancolombia, y "BreB" ni siquiera es una entidad: es el riel de pagos
//    inmediatos. Elegir el patrón por el rótulo hacía fallar comprobantes sanos.
//
// 2) Una forma DESCONOCIDA ya no es sospechosa. El diseño viejo era lista blanca:
//    lo que no reconocía, lo mandaba a revisión humana. Resultado medido: 116 de
//    158 motivos de glosa eran FORMATO_REFERENCIA — el 73% — sobre comprobantes
//    buenos. Una referencia que no conocemos no es evidencia de nada; el banco
//    puede estrenar formato mañana. Ahora solo se marca lo IMPLAUSIBLE (§ abajo).
//
// Frecuencias observadas: nequi 93 · bre-b 59 · numérico 53 · riel-35 51 · uuid 32.
// ─────────────────────────────────────────────────────────────────────────────
export const REFERENCE_SHAPES: { nombre: string; re: RegExp }[] = [
    // "M00944183" (86 casos), "M1338970". Letra + 7-9 dígitos: app Nequi/Bancolombia.
    { nombre: 'app_nequi', re: /^[A-Z]\d{7,9}$/i },
    // "TRcjXnMoooEC" (59). Transfiya/Bre-B: TR + 8 alfanuméricos + EC.
    { nombre: 'breb_trec', re: /^TR[A-Z0-9]{8}EC$/i },
    // 21-35 dígitos. Id del riel nacional; aparece bajo BBVA, DaviPlata, BreB,
    // Bancolombia y "Otro" indistintamente, que es la prueba de que es del riel.
    { nombre: 'riel_largo', re: /^\d{21,35}$/ },
    // UUID completo (32). Davivienda lo usa como id de transacción.
    { nombre: 'uuid', re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
    // "1d0078924bf1" — 12 hex.
    { nombre: 'hex12', re: /^[0-9a-f]{12}$/i },
    // "93LDJV4LNT" — 10 alfanuméricos en mayúscula.
    { nombre: 'codigo10', re: /^[A-Z0-9]{10}$/i },
    // "APIU6249326017491581".
    { nombre: 'apiu', re: /^APIU\d{16}$/i },
    // "11494938", "178550921349762" — el numérico corriente.
    { nombre: 'numerico', re: /^\d{6,20}$/ },
    // "20260803901383474SRV001785778599258".
    { nombre: 'mixto_srv', re: /^\d{17}[A-Z]{3}\d{15}$/i },
];

/** Largo mínimo para que una referencia sea creíble como tal. */
const REFERENCIA_LARGO_MINIMO = 6;

/**
 * Clasifica una referencia. Devuelve el nombre de la forma si la reconoce, o un
 * problema concreto si la referencia es implausible.
 *
 * Solo dos cosas se consideran problema, y ninguna es «no la reconozco»:
 *
 *  - `truncada`: empieza como UUID pero no tiene los 36 caracteres exactos. Eso
 *    NO es otro formato, es una mala lectura del OCR — medido: 8 casos de 33 y 34
 *    caracteres. Vale la pena decirlo, porque se arregla releyendo, no revisando
 *    a mano.
 *  - `muy_corta`: menos de 6 caracteres ("0543"). Ningún banco emite eso; es un
 *    pedazo de otro número.
 */
export function clasificarReferencia(
    reference: string,
): { ok: true; forma: string } | { ok: false; problema: 'truncada' | 'muy_corta' | 'desconocida' } {
    const ref = reference.trim();

    const match = REFERENCE_SHAPES.find((s) => s.re.test(ref));
    if (match) return { ok: true, forma: match.nombre };

    // Se parece a un UUID pero no lo es → lectura cortada, no formato nuevo.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) return { ok: false, problema: 'truncada' };
    if (ref.replace(/[\s-]/g, '').length < REFERENCIA_LARGO_MINIMO) return { ok: false, problema: 'muy_corta' };

    return { ok: false, problema: 'desconocida' };
}

/**
 * Normaliza una referencia para dedup/índice único: mayúsculas, sin espacios ni
 * guiones. Devuelve null si queda vacía.
 */
export function normalizeReference(reference: string | null | undefined): string | null {
    if (!reference) return null;
    const norm = reference.toUpperCase().replace(/[\s-]/g, '');
    return norm.length > 0 ? norm : null;
}

/**
 * Normaliza un identificador de destino (celular, cuenta, llave) para comparar
 * contra las cuentas registradas de la escuela: sin espacios, guiones ni puntos,
 * en mayúsculas. El caller debe normalizar las cuentas registradas con esta misma
 * función antes de pasarlas en el contexto.
 */
export function normalizeDestination(destination: string | null | undefined): string | null {
    if (!destination) return null;
    let norm = destination.toUpperCase().replace(/[\s.-]/g, '');
    // La llave Bre-B / Nequi se imprime con «@» delante («@3204298969»): es el mismo
    // número que la cuenta registrada (Dynasty 10-18).
    norm = norm.replace(/^@+/, '');
    // Un celular con indicativo («+57 319 450 5150», Monster 10-30) es el mismo
    // Nequi/Daviplata que «3194505150». Con «+» siempre; el «57» pelado solo si
    // viene separado del número («57 319…»): 12 dígitos seguidos que empiezan por
    // 573 pueden ser una cuenta de banco y no se tocan.
    const celular = /^\+?57(3\d{9})$/.exec(norm);
    if (celular && (norm.startsWith('+') || /^\s*57[\s.-]+3/.test(destination))) norm = celular[1];
    // El OCR confunde la O con el 0 (y la I/L con el 1) en una cuenta numérica:
    // «OO89455111» es la 0089455111 (Dynasty 10-14). Solo si son todo dígitos y
    // esas letras; una llave alfanumérica («XJI669») no se toca.
    if (/^[0-9OIL]{6,}$/.test(norm) && /\d{4}/.test(norm)) norm = norm.replace(/O/g, '0').replace(/[IL]/g, '1');
    return norm.length > 0 ? norm : null;
}

/**
 * Sufijo visible de un destino ENMASCARADO por el banco. La pantalla
 * "Transferencia exitosa" de Davivienda imprime la cuenta como "**** 6942"
 * (normalizado: "****6942"); otras apps usan "XXXX6942" o "••••6942". Devuelve
 * los dígitos visibles (mínimo 4) solo si van precedidos de una máscara: un
 * destino de puros dígitos cortos NO cuenta, porque puede ser una lectura
 * truncada del OCR y no una máscara del banco.
 */
export function maskedDestinationSuffix(destNorm: string | null | undefined): string | null {
    if (!destNorm) return null;
    const m = /[*•●·#X]+(\d{4,})$/i.exec(destNorm);
    return m ? m[1] : null;
}

/**
 * ¿El destino leído corresponde a alguna cuenta registrada de la escuela?
 * Igualdad exacta primero; si el banco enmascaró la cuenta, basta con que una
 * cuenta registrada TERMINE en los dígitos visibles. Caso real (Besser,
 * 2026-09-22): "**** 6942" contra 478170006942 caía en DESTINO_NO_COINCIDE y la
 * acudiente no podía subir un comprobante legítimo.
 */
export function destinationMatchesRegistered(destNorm: string | null | undefined, accounts: string[]): boolean {
    return classifyDestinationMatch(destNorm, accounts) !== 'none';
}

/**
 * Tipo de coincidencia del destino contra las cuentas registradas:
 *   - 'exact':  igualdad completa de la cuenta → suficiente para VERDE.
 *   - 'masked': el banco enmascaró la cuenta y solo coinciden los últimos
 *               dígitos ("****6942"). NO basta para verde: 4 dígitos colisionan
 *               fácil (SEG-26, 2026-10-05). Queda en amarillo, revisión humana.
 *   - 'none':   no coincide con ninguna.
 */
export type DestinationMatch = 'exact' | 'masked' | 'none';

export function classifyDestinationMatch(
    destNorm: string | null | undefined, accounts: string[],
): DestinationMatch {
    if (!destNorm || accounts.length === 0) return 'none';
    if (accounts.includes(destNorm)) return 'exact';
    const suffix = maskedDestinationSuffix(destNorm);
    if (suffix && accounts.some((a) => a.length > suffix.length && a.endsWith(suffix))) return 'masked';
    return 'none';
}

/** Diferencia en días calendario (a - b), tz-safe, sin depender del reloj. */
function diffDays(aIso: string, bIso: string): number | null {
    const a = parseIsoDate(aIso);
    const b = parseIsoDate(bIso);
    if (a === null || b === null) return null;
    return Math.round((a - b) / 86_400_000);
}

/** Parsea 'YYYY-MM-DD' a epoch ms UTC (medianoche). null si no es una fecha válida. */
function parseIsoDate(iso: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
}

const CRITICAL_FIELDS = ['amount', 'date', 'reference'] as const;

/**
 * Evalúa el veredicto de un comprobante. Pura: mismos inputs → mismo output.
 * Los checks se corren TODOS y se acumulan las razones; el veredicto final es el
 * peor nivel presente.
 */
export function evaluateVerdict(ocr: OcrResult, ctx: VerdictContext): VerdictResult {
    const reasons: VerdictReason[] = [];
    const referenceNorm = normalizeReference(ocr.reference);
    const dateWindowDays = ctx.dateWindowDays ?? 5;

    // 1) No es un comprobante de pago individual.
    if (ocr.isReceipt === false) {
        reasons.push({
            check: 1,
            code: 'NOT_A_RECEIPT',
            level: 'rojo',
            message: 'La imagen no es un comprobante de pago.',
        });
    }

    // 2) Es una lista de movimientos, no un comprobante individual.
    if (ocr.isTransactionList === true) {
        reasons.push({
            check: 2,
            code: 'IS_TRANSACTION_LIST',
            level: 'rojo',
            message: 'Sube el comprobante individual, no la lista de movimientos.',
        });
    }

    // 3) Campos críticos ilegibles/faltantes. Honramos missing_fields del modelo
    //    y, por robustez, también tratamos un valor crítico null como faltante.
    const reported = new Set(ocr.missingFields.map((f) => f.toLowerCase().trim()));
    const nullCritical = new Set<string>();
    if (ocr.amount === null) nullCritical.add('amount');
    if (ocr.date === null) nullCritical.add('date');
    if (ocr.reference === null) nullCritical.add('reference');
    const missingCritical = CRITICAL_FIELDS.filter((f) => reported.has(f) || nullCritical.has(f));
    if (missingCritical.length > 0) {
        reasons.push({
            check: 3,
            code: 'CAMPOS_ILEGIBLES',
            level: 'amarillo',
            message: 'El comprobante tiene campos ilegibles o incompletos; sube una captura completa y nítida.',
            detail: { missing: missingCritical },
        });
    }

    // 4) Destino. El destino es OBLIGATORIO para VERDE (SEG-26, 2026-10-05): no
    //    poder confirmar a qué cuenta fue la plata no puede quedar en verde.
    //    - ausente/ilegible (con cuentas cargadas) → amarillo (DESTINO_AUSENTE)
    //    - coincide (exacto O por máscara de 4)    → sin motivo (puede ser verde)
    //    - cuenta de la escuela, otro concepto     → amarillo (DESTINO_NO_COINCIDE)
    //    - no coincide con nada                    → rojo     (DESTINO_NO_COINCIDE)
    //
    //    OJO (feedback del usuario, 2026-10-05): HAY escuelas cuyo único dato de
    //    la cuenta de destino son los últimos dígitos, y bancos que enmascaran el
    //    destino. Por eso el match por máscara SIGUE valiendo como coincidencia —
    //    bajarlo a amarillo mandaría todo el volumen de esas escuelas a revisión.
    //    El hueco que se cierra es solo el destino AUSENTE: antes, un comprobante
    //    sin cuenta de destino legible no activaba el check 4 y salía verde.
    const destNorm = normalizeDestination(ocr.destination);
    const accounts = ctx.registeredAccounts ?? [];
    const restricted = ctx.restrictedAccounts ?? [];
    const tieneCuentas = accounts.length > 0 || restricted.length > 0;
    if (tieneCuentas && !destNorm) {
        reasons.push({
            check: 4,
            code: 'DESTINO_AUSENTE',
            level: 'amarillo',
            message: 'No pudimos leer la cuenta de destino; sube una captura donde se vea a qué cuenta se envió el dinero.',
        });
    } else if (destNorm && tieneCuentas && !destinationMatchesRegistered(destNorm, accounts)) {
        const restringida = restricted.find((r) => destinationMatchesRegistered(destNorm, [r.value]));
        if (restringida) {
            // Cuenta de la escuela, pero de otro concepto (Dynasty: Nequi solo
            // para inscripciones y llegó una mensualidad). Nivel amarillo.
            reasons.push({
                check: 4,
                code: 'DESTINO_NO_COINCIDE',
                level: 'amarillo',
                message: `El dinero se envió a una cuenta de la escuela que solo recibe ${describirCategorias(restringida.onlyFor)}; revisa a qué cobro corresponde.`,
                detail: {
                    destination: destNorm,
                    cuentaRestringida: true,
                    soloPara: restringida.onlyFor,
                    categoriaDelCobro: ctx.paymentCategory ?? null,
                },
            });
        } else {
            reasons.push({
                check: 4,
                code: 'DESTINO_NO_COINCIDE',
                level: 'rojo',
                message: 'El dinero se envió a una cuenta que no está registrada por la escuela.',
                // comparedAgainst se persiste para calibrar el modo sombra (no viaja
                // al cliente: payments.routes lo poda del response — SEG-26).
                detail: { destination: destNorm, comparedAgainst: [...accounts, ...restricted.map((r) => r.value)] },
            });
        }
    }

    // 5) Monto distinto al esperado (tolerancia 0).
    if (
        typeof ctx.expectedAmount === 'number' &&
        ctx.expectedAmount > 0 &&
        typeof ocr.amount === 'number' &&
        Math.round(ocr.amount) !== Math.round(ctx.expectedAmount)
    ) {
        reasons.push({
            check: 5,
            code: 'MONTO_DIFIERE',
            level: 'amarillo',
            message: 'El monto del comprobante no coincide con el valor esperado del cobro.',
            detail: { expected: Math.round(ctx.expectedAmount), extracted: Math.round(ocr.amount) },
        });
    }

    // 6) Fecha: futura → ROJO; fuera de la ventana hacia atrás → AMARILLO.
    if (ocr.date) {
        const delta = diffDays(ctx.today, ocr.date); // today - date; >0 = pasado, <0 = futuro
        if (delta !== null) {
            if (delta < 0) {
                reasons.push({
                    check: 6,
                    code: 'FECHA_FUTURA',
                    level: 'rojo',
                    message: 'El comprobante tiene una fecha futura.',
                    detail: { date: ocr.date, today: ctx.today },
                });
            } else if (delta > dateWindowDays) {
                reasons.push({
                    check: 6,
                    code: 'FECHA_FUERA_VENTANA',
                    level: 'amarillo',
                    message: `El comprobante es de hace ${delta} días, fuera de la ventana permitida (${dateWindowDays}).`,
                    detail: { date: ocr.date, today: ctx.today, windowDays: dateWindowDays },
                });
            }
        }
    }

    // 7) Referencia ya utilizada en la escuela.
    if (ctx.referenceAlreadyUsed === true) {
        reasons.push({
            check: 7,
            code: 'REFERENCIA_DUPLICADA',
            level: 'rojo',
            message: 'Este comprobante ya fue utilizado.',
            detail: referenceNorm ? { referenceNorm } : undefined,
        });
    }

    // 8) Hash de imagen duplicado.
    if (ctx.imageHashDuplicate === true) {
        reasons.push({
            check: 8,
            code: 'IMAGEN_DUPLICADA',
            level: 'rojo',
            message: 'Esta imagen de comprobante ya fue subida antes.',
        });
    }

    // 9) La referencia es implausible como referencia.
    //
    //    Antes: lista blanca por banco — lo que no reconocía iba a revisión humana.
    //    Eso producía el 73% de las glosas sobre comprobantes buenos (ver el bloque
    //    de REFERENCE_SHAPES). Ahora solo se marca lo que NO puede ser una
    //    referencia: una lectura cortada o un número demasiado corto. Un formato
    //    que no conocemos no es evidencia de nada.
    if (ocr.reference) {
        const clasificacion = clasificarReferencia(ocr.reference);
        if (!clasificacion.ok && clasificacion.problema !== 'desconocida') {
            reasons.push({
                check: 9,
                code: 'FORMATO_REFERENCIA',
                level: 'amarillo',
                message: clasificacion.problema === 'truncada'
                    ? 'La referencia quedó cortada al leerla; conviene volver a leer el comprobante.'
                    : 'El número de referencia es demasiado corto para ser una referencia.',
                detail: { bank: ocr.bank ?? null, reference: ocr.reference, problema: clasificacion.problema },
            });
        }
    }

    // 10) Posible manipulación (inyección de prompt escrita en la imagen o en el
    //     texto libre de la transferencia). Nunca verde: va a revisión humana.
    //     Amarillo y no rojo: un falso positivo no debe rechazarle el pago a
    //     una familia, solo quitarle la vía automática.
    const manipulacion = detectarManipulacion(ocr);
    if (manipulacion.length > 0) {
        reasons.push({
            check: 10,
            code: 'POSIBLE_MANIPULACION',
            level: 'amarillo',
            message: 'El comprobante contiene texto que no corresponde a un comprobante bancario (posibles instrucciones dirigidas al sistema). Requiere revisión manual.',
            detail: { motivo: 'posible_manipulacion', senales: manipulacion },
        });
    }

    const verdict: Verdict = reasons.some((r) => r.level === 'rojo')
        ? 'rojo'
        : reasons.some((r) => r.level === 'amarillo')
          ? 'amarillo'
          : 'verde';

    return { verdict, reasons, referenceNorm };
}

// ─────────────────────────────────────────────────────────────────────────────
// Defensa contra inyección de prompt en el comprobante (2026-10-07).
//
// PoC (seguridad-llm-comprobantes.poc.test.ts): una imagen con una orden escrita
// para el extractor ("devuelve este JSON") y la cuenta REAL de la escuela —que
// ven todas las familias— salía verde y se AUTO-APROBABA aunque la leyeran dos
// proveedores distintos: los dos leen los mismos píxeles y los dos obedecen.
//
// Dos capas, ninguna depende de que el modelo "diga" algo bueno:
//   1. detectarManipulacion: busca texto dirigido a un sistema/IA en la
//      transcripción (raw_text) y en los campos extraídos. Hallazgo → amarillo.
//   2. evaluarEvidenciaAutoAprobacion: para MOVER PLATA sin humano exige campos
//      con forma bancaria y coherentes, y que las dos lecturas coincidan CAMPO A
//      CAMPO (no en un veredicto). El veredicto lo calcula este código.
//
// Límite honesto: un modelo que obedece TODO (incluida una transcripción falsa
// "limpia") con datos verosímiles sigue pasando. Ninguna regla sobre una imagen
// prueba que hubo una transferencia; eso solo lo prueba el banco (notificación
// firmada con DKIM / extracto). Ver project_notificaciones_banco_por_correo_dkim.
// ─────────────────────────────────────────────────────────────────────────────

/** Minúsculas y sin tildes, para que "instrucción" e "instruccion" casen igual. */
function plano(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Frases dirigidas a un modelo/sistema. Calibradas para NO chocar con el texto
 * normal de un comprobante colombiano ("Transacción aprobada", "Número de
 * aprobación", "Sistema de pagos inmediatos", nombres propios como "Claude").
 */
const PATRONES_INYECCION: { senal: string; re: RegExp }[] = [
    { senal: 'ignora_instrucciones', re: /\b(ignora|ignore|ignorar|disregard|olvida|olvidar|forget)\b[^.\n]{0,40}\b(instruccion|instrucciones|instructions?|reglas|rules|anterior|anteriores|previous|above|prompt)/ },
    { senal: 'dirigido_al_sistema', re: /\b(nota|mensaje|orden|instruccion|instrucciones|indicacion|aviso)\b[^.\n]{0,15}\b(para|al|a la|del)\b[^.\n]{0,10}\b(sistema|modelo|extractor|asistente|validador|revisor|verificador|ia|ai|bot|llm)\b/ },
    { senal: 'rol_de_chat', re: /(^|[\s"'{[(<])(system|assistant|developer)\s*[:>]|<\|?\s*(system|im_start|im_end|assistant)|\[\/?(inst|system)\]/ },
    { senal: 'orden_de_aprobar', re: /\b(apruebalo|apruebe|apruebelo|apruebenlo|approve|auto-?aprueba|autoaprueba)\b|\baprueba (este|el|esta|la)\b|\bmarca(r|lo|la)? como (verde|aprobado|aprobada|valido|valida|pagado|pagada|legitimo)|\b(veredicto|verdict)\b/ },
    { senal: 'pide_json', re: /\b(devuelve|devolver|responde|responder|retorna|return|respond|output)\b[^.\n]{0,30}\bjson\b|\b(is_receipt|missing_fields|is_transaction_list|suspicious_instructions|raw_text)\b/ },
    { senal: 'json_embebido', re: /\{\s*"[a-z_]{2,40}"\s*:/ },
    { senal: 'menciona_ia', re: /\b(prompt|llm|chatgpt|openai|gemini|gpt-?\d|inteligencia artificial|modelo de lenguaje|language model)\b/ },
];

/** Caracteres que no tienen nada que hacer en una referencia/cuenta/banco/nombre. */
const CARACTERES_RAROS = /[{}<>"`|\\\n\r]/;

/**
 * Busca señales de manipulación en lo que el modelo transcribió y extrajo.
 * Devuelve las señales encontradas (vacío = nada sospechoso). Pura.
 */
export function detectarManipulacion(ocr: OcrResult): string[] {
    const senales = new Set<string>();

    if (ocr.injectionSuspected === true) senales.add('modelo_reporta_instrucciones');

    const textos: { campo: string; valor: string | null | undefined }[] = [
        { campo: 'raw_text', valor: ocr.rawText },
        { campo: 'reference', valor: ocr.reference },
        { campo: 'destination', valor: ocr.destination },
        { campo: 'destination_name', valor: ocr.destinationName },
        { campo: 'origin_name', valor: ocr.originName },
        { campo: 'bank', valor: ocr.bank },
        { campo: 'description', valor: ocr.description },
    ];
    for (const { campo, valor } of textos) {
        if (!valor) continue;
        const p = plano(valor);
        for (const { senal, re } of PATRONES_INYECCION) {
            if (re.test(p)) senales.add(`${senal}@${campo}`);
        }
    }

    // Campos estructurados con forma imposible: JSON, etiquetas, saltos de línea
    // o longitudes que ningún banco imprime en esa casilla.
    const estructurados: { campo: string; valor: string | null | undefined; max: number }[] = [
        { campo: 'reference', valor: ocr.reference, max: 48 },
        { campo: 'destination', valor: ocr.destination, max: 64 },
        { campo: 'bank', valor: ocr.bank, max: 40 },
        { campo: 'destination_name', valor: ocr.destinationName, max: 120 },
        { campo: 'origin_name', valor: ocr.originName, max: 120 },
    ];
    for (const { campo, valor, max } of estructurados) {
        if (!valor) continue;
        if (CARACTERES_RAROS.test(valor)) senales.add(`caracteres_raros@${campo}`);
        if (valor.length > max) senales.add(`largo_anomalo@${campo}`);
    }

    return [...senales];
}

/** 'HH:MM' 24h válido → minutos del día; si no, null. */
function minutosDelDia(hhmm: string | null | undefined): number | null {
    if (!hhmm) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}

export interface EvidenciaAutoAprobacion {
    ok: boolean;
    /** Por qué NO alcanza para aprobar sin humano. Vacío si ok. */
    faltas: string[];
}

/**
 * ¿Hay evidencia suficiente para AUTO-APROBAR (mover el pago a pagado sin que lo
 * mire nadie)? Más estricto que el veredicto verde, que también sirve para
 * mostrarle al acudiente que su comprobante "se ve bien".
 *
 * Exige, en las DOS lecturas y calculado aquí (nunca un veredicto del modelo):
 *   - ninguna señal de manipulación;
 *   - las dos lecturas en verde por las reglas;
 *   - referencia con forma bancaria conocida (REFERENCE_SHAPES) e igual;
 *   - monto exacto al esperado e igual;
 *   - destino EXACTO a una cuenta registrada (no solo los 4 últimos dígitos
 *     tras una máscara, que conoce cualquier familia) e igual;
 *   - fecha y hora presentes, iguales, dentro de la ventana y no en el futuro.
 *
 * `nowTime` = 'HH:MM' de Bogotá (lo inyecta el caller para mantener la fn pura).
 */
export function evaluarEvidenciaAutoAprobacion(
    a: OcrResult,
    b: OcrResult,
    ctx: VerdictContext,
    nowTime?: string | null,
): EvidenciaAutoAprobacion {
    const faltas = new Set<string>();

    if (detectarManipulacion(a).length > 0 || detectarManipulacion(b).length > 0) faltas.add('posible_manipulacion');
    if (evaluateVerdict(a, ctx).verdict !== 'verde' || evaluateVerdict(b, ctx).verdict !== 'verde') faltas.add('lectura_no_verde');

    // Referencia
    for (const o of [a, b]) {
        const c = o.reference ? clasificarReferencia(o.reference) : null;
        if (!c || !c.ok) faltas.add('referencia_sin_formato_bancario');
    }
    if (normalizeReference(a.reference) !== normalizeReference(b.reference)) faltas.add('referencia_no_coincide');

    // Monto
    const esperado = typeof ctx.expectedAmount === 'number' && ctx.expectedAmount > 0 ? Math.round(ctx.expectedAmount) : null;
    if (esperado === null) faltas.add('sin_monto_esperado');
    for (const o of [a, b]) {
        if (typeof o.amount !== 'number' || (esperado !== null && Math.round(o.amount) !== esperado)) faltas.add('monto_no_exacto');
    }
    if (a.amount !== b.amount) faltas.add('monto_no_coincide');

    // Destino
    const cuentas = ctx.registeredAccounts ?? [];
    const destA = normalizeDestination(a.destination);
    const destB = normalizeDestination(b.destination);
    if (classifyDestinationMatch(destA, cuentas) !== 'exact' || classifyDestinationMatch(destB, cuentas) !== 'exact') {
        faltas.add('destino_no_exacto');
    }
    if (destA !== destB) faltas.add('destino_no_coincide');

    // Fecha y hora
    if (!a.date || !b.date) faltas.add('fecha_ausente');
    else if (a.date.slice(0, 10) !== b.date.slice(0, 10)) faltas.add('fecha_no_coincide');
    else {
        const delta = diffDays(ctx.today, a.date);
        if (delta === null) faltas.add('fecha_invalida');
        else if (delta < 0) faltas.add('fecha_futura');
        else if (delta > (ctx.dateWindowDays ?? 5)) faltas.add('fecha_fuera_ventana');
    }
    const minA = minutosDelDia(a.time);
    const minB = minutosDelDia(b.time);
    if (minA === null || minB === null) faltas.add('hora_ausente');
    else {
        if (minA !== minB) faltas.add('hora_no_coincide');
        // Hoy y con hora posterior a "ahora" (+10 min de holgura por relojes).
        const ahora = minutosDelDia(nowTime);
        if (ahora !== null && a.date && a.date.slice(0, 10) === ctx.today && minA > ahora + 10) faltas.add('hora_futura');
    }

    return { ok: faltas.size === 0, faltas: [...faltas] };
}
