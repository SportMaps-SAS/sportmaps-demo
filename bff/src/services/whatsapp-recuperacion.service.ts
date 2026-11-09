/**
 * whatsapp-recuperacion.service — comprobantes que llegaron por WhatsApp y
 * nadie aplicó, metidos al cobro EN REVISIÓN y sin hablarle a nadie.
 *
 * Origen, medido el 2026-10-05 en Dynasty (Coexistence desde el 2026-10-02):
 * 56 fotos de comprobantes en `whatsapp_inbound_queue` sin archivo guardado —
 * 22 cerradas `bot_apagado`, 21 `contacto sin identificar` (el bug viejo que
 * pedía el correo) y 13 `pending` con el cron frenado. La dueña dice que tiene
 * muchos comprobantes de padres sin subir.
 *
 * Dos entradas usan este módulo y deciden IGUAL:
 *   - scripts/wa-recuperar-comprobantes.ts  → filas de la cola (Tarea A).
 *   - POST /whatsapp/:schoolId/importar-chat → el .zip de «Exportar chat» (Tarea B).
 *
 * Reglas que mandan sobre todo lo demás:
 *
 *  1. **Nunca se aprueba.** El resultado bueno es `awaiting_approval` con el
 *     comprobante y su veredicto — lo mismo que deja el worker cuando NO
 *     auto-aprueba. Por eso se usa `estamparComprobante` y NO
 *     `evaluatePaymentReceipt`: con la auto-aprobación de la escuela prendida
 *     esa función aprueba sola (y le manda correo al acudiente).
 *  2. **Solo se le avisa a la familia cuyo comprobante quedó en un cobro**
 *     (2026-10-07; antes no se le decía nada a nadie y la familia seguía
 *     creyendo que su pago se había perdido). Dentro de la ventana de 24 h, un
 *     texto: «quedó en revisión de la escuela» (`avisarRecuperacion`). Fuera,
 *     la plantilla `comprobante_en_revision` si está APPROVED y hay opt-in
 *     (2026-10-07); si no, nada en el momento. En los dos casos la fila queda
 *     SIN `outcome_notified_at`: cuando la escuela apruebe o rechace, el job de
 *     desenlace (whatsapp-payment-outcome.job) avisa, por plantilla si la
 *     ventana está cerrada. Lo demás (buzón, ya registrado, no es comprobante)
 *     no le escribe a nadie. El importador de chats exportados no avisa.
 *  3. **Nunca un doble pago.** Muchos de estos pagos la dueña ya los registró a
 *     mano o con las planillas de papel. Si la familia ya tiene un pago
 *     registrado por ese monto en esas fechas, es `ya_registrado` y no se toca
 *     ningún cobro. Si además hay un pendiente del mismo monto, no se adivina:
 *     va al buzón como `varios_cobros`.
 *  4. **No adivinar el cobro.** Mismo motor que el worker (`resolverPago`):
 *     solo se estampa cuando hay UN cobro posible Y el monto leído coincide
 *     (o no se pudo leer). Lo que el worker resolvería preguntándole al
 *     acudiente acá va al buzón, porque no se le pregunta.
 */

import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { extractReceipt, type OcrResult } from './ocr.service';
import { normalizeReference } from './receipt-verdict';
import {
    pagosPendientesDe, resolverPago, describirPago, type PagoPendiente,
} from './whatsapp-receipt-matching.service';
import crypto from 'node:crypto';
import {
    destinoEsDeLaEscuela, destinoFueraDeSportmaps, estamparComprobante, obtenerArchivoDeFila, elegirPorPista,
    pistaDesdeTextos, type FilaCola,
} from '../jobs/whatsapp-queue.job';
import { elMasAntiguoDelMismoDeportista } from './whatsapp-cobro-por-texto.service';
import {
    cargarRecargos, cubrirCobrosConComprobante, huellasDelComprobante, ordenarDelMasAntiguo, textoExcedente,
} from './whatsapp-excedente.service';
import { normalizarFrase } from './whatsapp-reglas-turno';
import { categoriaDelCobro } from './tipo-de-cobro';
import { sendTextMessage, aFormatoWhatsApp, type WhatsAppIntegration } from './whatsapp.service';
import {
    detectarOtroConcepto, decidirOtroConcepto, motivoOtroConcepto, NOMBRE_OTRO_CONCEPTO,
} from './whatsapp-otro-concepto.service';
import { ventanaAbierta } from './whatsapp-plantillas.service';
import { estaDadoDeBaja, AVISO_DADO_DE_BAJA } from './whatsapp-optin.service';
import { conversacionTomada } from './whatsapp-tomada.service';
import { modoDiscreto, escuelaActiva } from './whatsapp-modo-discreto';
import { modoDiscretoEfectivo } from './whatsapp-ajustes-escuela.service';
import { botEncendido } from './whatsapp-atencion.service';
import {
    calcularCandidatosDePago, deportistasEsperados, textoPropuesta, motivoConPropuesta,
} from './whatsapp-pago-esperado.service';
import { cargarItemsDeTorneo, cruzarTorneo, motivoTorneo, type ItemDeTorneo } from './whatsapp-torneos-pago.service';
import { candidatosParaPreguntar, nombreDelMes } from './whatsapp-comprobante-guiado.service';
import { deportistaPorNombreSinVerificar } from './whatsapp-comprobante-de-ficha.service';

// ─── Tipos ───────────────────────────────────────────────────────────────────

/**
 * Quién mandó el comprobante, ya resuelto.
 *
 * `sin_cuenta` lleva las fichas cuyo acudiente tiene ese número (2026-10-06):
 * el cobro de esas familias no tiene `parent_id` —está en `child_id` o en
 * `unregistered_athlete_id`, ver los cuatro caminos del pagador—, así que se
 * busca por la ficha. Sin fichas, queda como antes (al buzón).
 */
export type Familia =
    | { tipo: 'identificado'; parentId: string }
    | { tipo: 'sin_cuenta'; childIds?: string[]; unregisteredIds?: string[] }
    | { tipo: 'ambiguo' }
    | { tipo: 'staff' }
    | { tipo: 'desconocido' };

export type DecisionRecuperacion =
    | 'en_revision'          // estampado en el cobro, awaiting_approval
    | 'abono_en_revision'    // igual, pero el comprobante es MENOR al cobro: la escuela lo aprueba como abono
    | 'ya_registrado'       // ese pago ya está en la base: no se toca nada
    | 'no_es_comprobante'
    | 'es_listado'
    | 'destino_ajeno'
    | 'fuera_de_sportmaps'   // a una cuenta que la escuela acepta por fuera de la app: informativo
    | 'sin_pendientes'
    | 'varios_cobros'        // el monto no desempata, o puede ser uno ya registrado
    | 'monto_distinto'       // un solo cobro pendiente, pero el comprobante es por otro valor
    | 'otro_concepto'        // el pie/chat/comprobante nombra otra cosa (uniforme, torneo…) y no hay cobro de eso
    | 'familia_sin_cuenta'
    | 'numero_ambiguo'
    | 'sin_familia'
    | 'enviado_por_equipo'
    | 'archivo_no_disponible'
    | 'reintentar';          // OCR caído u otro transitorio: la fila vuelve como estaba

/** Pago que ya cuenta como plata recibida (o en revisión) de la familia. */
export interface PagoRegistrado {
    id: string;
    amount: number;
    amount_paid: number | null;
    status: string;
    payment_date: string | null;
    updated_at: string | null;
    concept: string | null;
}

export interface ResultadoRecuperacion {
    decision: DecisionRecuperacion;
    motivo: string;
    ocr: OcrResult | null;
    /** El cobro donde quedó (en_revision) o el que se propone (simulación). */
    pago?: PagoPendiente;
    /** El pago que ya cubre este comprobante (ya_registrado). */
    pagoRegistradoId?: string | null;
    parentId?: string | null;
    veredicto?: string | null;
    /** Qué se le dijo a la familia (solo cuando quedó en un cobro y se aplicó). */
    aviso?: AvisoRecuperacion;
    /** sha256 de la imagen: huella para que la bandeja enlace la fila con el pago. */
    sha?: string | null;
    /** Otros cobros que paga el MISMO comprobante (suma exacta), además de `pago`. */
    pagosCubiertos?: PagoPendiente[];
    /** Lo que debe decir el comprobante si no es el valor del cobro (recargo del link o suma). */
    esperado?: number;
    /** Lo que pagó de más: queda como saldo a favor cuando la escuela aprueba. */
    excedente?: number;
    /**
     * La propuesta armada para la escuela (deportista, mes, cobro, por qué —
     * spec 3.5/3.3, 2026-10-24). Ya va dentro de `motivo`; acá aparte para el script.
     */
    propuesta?: string | null;
    /**
     * El deportista salió del NOMBRE escrito por un número que no es de ninguna
     * familia: a ese número no se le dice ningún dato del deportista (ni su nombre,
     * ni el concepto del cobro). Monster 2026-11-05 (Ethann / Laura Sofía).
     */
    porNombreSinVerificar?: boolean;
}

/** Lo que devuelve la regla (sin la lectura ni quién es la familia). */
export interface DecisionDeRecuperacion {
    decision: DecisionRecuperacion;
    motivo: string;
    pago?: PagoPendiente;
    pagoRegistradoId?: string | null;
    pagosCubiertos?: PagoPendiente[];
    esperado?: number;
    excedente?: number;
}

// ─── Fechas ──────────────────────────────────────────────────────────────────

/** Días antes de la fecha del comprobante en que un pago registrado aún «lo cubre». */
const VENTANA_ANTES_DIAS = 3;
/**
 * Días DESPUÉS. `payment_date` es el día en que la escuela aprueba o registra
 * (no el de la transferencia), y la dueña registra a mano con días de atraso;
 * las planillas de papel de septiembre se cargaron el 3 de octubre con la fecha
 * real. 20 días cubre las dos cosas sin alcanzar al mes siguiente completo.
 */
const VENTANA_DESPUES_DIAS = 20;

const DIA_MS = 86_400_000;
const aDia = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/**
 * La fecha que manda para comparar: la del comprobante si es creíble, si no la
 * del mensaje. El OCR a veces lee mal el año; una fecha a más de 60 días del
 * mensaje (o en el futuro) no es la de este pago.
 */
export function fechaDeReferencia(ocrDate: string | null, fechaMensaje: string): string {
    if (ocrDate && /^\d{4}-\d{2}-\d{2}$/.test(ocrDate)) {
        const d = aDia(ocrDate);
        const m = aDia(fechaMensaje);
        if (!Number.isNaN(d) && d <= m + DIA_MS && d >= m - 60 * DIA_MS) return ocrDate;
    }
    return fechaMensaje.slice(0, 10);
}

/**
 * Pagos de la familia que ya cubren un comprobante de `monto` hecho el día
 * `fecha`: mismo monto (cobrado o abonado) y fecha de registro dentro de la
 * ventana. Pura, para probarla sin base.
 */
export function pagosQueYaCubren(pagos: PagoRegistrado[], monto: number | null, fecha: string): PagoRegistrado[] {
    if (monto === null || !(monto > 0)) return [];
    const ref = aDia(fecha);
    return pagos.filter((p) => {
        const mismoMonto = Number(p.amount) === monto || (p.amount_paid !== null && Number(p.amount_paid) === monto);
        if (!mismoMonto) return false;
        // En revisión no tiene payment_date todavía: vale la última edición.
        const cuando = p.payment_date ?? p.updated_at;
        if (!cuando) return false;
        const d = aDia(cuando);
        return d >= ref - VENTANA_ANTES_DIAS * DIA_MS && d <= ref + VENTANA_DESPUES_DIAS * DIA_MS;
    });
}

// ─── La regla ────────────────────────────────────────────────────────────────

/**
 * Qué hacer con un comprobante ya leído. Función pura: es LA regla, se prueba
 * sin mocks.
 */
export function decidirRecuperacion(e: {
    familia: Familia;
    ocr: OcrResult;
    destinoDeLaEscuela: boolean;
    /** Pago que ya tiene esta referencia de banco o esta misma imagen. */
    yaUsadoEn: { paymentId: string | null; por: 'referencia' | 'imagen' } | null;
    pagadosQueCubren: PagoRegistrado[];
    pendientes: PagoPendiente[];
    /** Todos los pagos ya registrados de la familia (para el motivo de «sin pendientes»). */
    registrados?: PagoRegistrado[];
    /** Pie de foto, mensajes de la familia cerca de la foto y descripción del comprobante. */
    textos?: (string | null | undefined)[];
    /** El pie de la foto solo: pesa más que el chat para decir de qué concepto es. */
    pie?: string | null;
    /** El dinero fue a una cuenta que la escuela acepta «por fuera de SportMaps». */
    fueraDeSportmaps?: boolean;
    /** Montos con el recargo del enlace de pago de cada cobro (id → montos). */
    recargos?: Map<string, number[]>;
    /**
     * Torneos del catálogo de la escuela (`school_tournament_items`) y el/los
     * deportista(s) ya identificados: para el motivo de un comprobante de torneo
     * (quién pagó, a qué torneo, cuánto). Sin catálogo degrada a «registrar a mano».
     */
    torneos?: ItemDeTorneo[];
    deportista?: string | null;
}): DecisionDeRecuperacion {
    const { ocr } = e;
    const recargos = e.recargos ?? new Map<string, number[]>();
    if (ocr.isReceipt === false) return { decision: 'no_es_comprobante', motivo: 'el archivo no es un comprobante de pago' };
    if (ocr.isTransactionList === true) return { decision: 'es_listado', motivo: 'listado de movimientos, no un comprobante' };
    if (e.fueraDeSportmaps) {
        return { decision: 'fuera_de_sportmaps', motivo: `el dinero fue a ${ocr.destination ?? '?'}, una cuenta que la escuela acepta por fuera de SportMaps` };
    }
    if (!e.destinoDeLaEscuela) {
        return { decision: 'destino_ajeno', motivo: `el dinero fue a ${ocr.destination ?? '?'}, que no es una cuenta de la escuela` };
    }
    if (e.yaUsadoEn) {
        return {
            decision: 'ya_registrado',
            motivo: e.yaUsadoEn.por === 'referencia'
                ? `la referencia ${ocr.reference} ya está en otro pago`
                : 'esta misma imagen ya está en otro pago',
            pagoRegistradoId: e.yaUsadoEn.paymentId,
        };
    }

    const f = e.familia;
    if (f.tipo === 'sin_cuenta' && !(f.childIds?.length || f.unregisteredIds?.length)) {
        return { decision: 'familia_sin_cuenta', motivo: 'familia de la escuela sin cuenta y sin ficha con ese número: aplicarlo a mano' };
    }
    if (f.tipo === 'ambiguo') return { decision: 'numero_ambiguo', motivo: 'el número está en más de una cuenta' };
    if (f.tipo === 'staff') return { decision: 'enviado_por_equipo', motivo: 'lo mandó alguien que administra la escuela (puede ser de otra familia): aplicarlo a mano' };
    if (f.tipo === 'desconocido') return { decision: 'sin_familia', motivo: 'el número no está en ninguna ficha de la escuela' };

    const monto = ocr.amount ?? null;
    const hayPendienteDelMonto = monto !== null && e.pendientes.some((p) => p.amount === monto);
    if (e.pagadosQueCubren.length > 0) {
        const reg = e.pagadosQueCubren[0];
        if (hayPendienteDelMonto) {
            // Puede ser el pago que la dueña ya registró… o el siguiente mes.
            // Elegir mal es cobrar dos veces o dejar un mes sin pagar: decide ella.
            return {
                decision: 'varios_cobros',
                motivo: `puede ser el pago ya registrado (${reg.concept ?? reg.id}) o un cobro pendiente del mismo monto`,
                pagoRegistradoId: reg.id,
            };
        }
        return {
            decision: 'ya_registrado',
            motivo: `ya hay un pago ${reg.status} de ${monto} (${reg.concept ?? reg.id}, ${reg.payment_date ?? reg.updated_at?.slice(0, 10) ?? 's/f'})`,
            pagoRegistradoId: reg.id,
        };
    }

    // ¿Nombra otro concepto? (P0, 2026-10-07: perfeccionamiento y uniformes
    // aplicados a la mensualidad.) Misma regla que el worker.
    const otro = decidirOtroConcepto(
        detectarOtroConcepto({ pie: e.pie, descripcion: ocr.description, chat: e.textos }),
        e.pendientes, monto,
    );
    if (otro.tipo === 'aplicar') {
        return {
            decision: 'en_revision',
            motivo: `a ${describirPago(otro.pago)} (la familia lo nombra como ${NOMBRE_OTRO_CONCEPTO[otro.senal.concepto]})`,
            pago: otro.pago,
        };
    }
    if (otro.tipo === 'a_la_escuela') {
        if (otro.senal.concepto === 'torneo') {
            // Spec 3.6: que se vea quién pagó, el deportista y el torneo del catálogo.
            return {
                decision: 'otro_concepto',
                motivo: motivoTorneo({
                    quienPago: ocr.originName, deportista: e.deportista ?? null, monto,
                    cruce: cruzarTorneo({ textos: [e.pie, ocr.description, ...(e.textos ?? [])], monto, items: e.torneos ?? [] }),
                    evidencia: otro.senal.evidencia,
                }),
            };
        }
        return { decision: 'otro_concepto', motivo: motivoOtroConcepto(otro.senal) };
    }

    // Recargo del enlace de pago (2026-10-13): el monto es el de UN cobro con su
    // recargo online (aunque hoy la escuela cobre otro %): pago completo de ese.
    if (monto !== null && e.pendientes.length > 1 && !e.pendientes.some((p) => p.amount === monto)) {
        const conRecargo = e.pendientes.filter((p) => (recargos.get(p.id) ?? []).includes(monto));
        const elegido = conRecargo.length === 1 ? conRecargo[0] : elMasAntiguoDelMismoDeportista(conRecargo);
        if (elegido) return decidirPorMonto(elegido, monto, e.pendientes, 'el cobro del enlace de pago', recargos);
    }

    const match = resolverPago(e.pendientes, monto);
    if (match.tipo === 'sin_pendientes') {
        // ¿Otro mes ya pagado por el mismo valor? No se marca ya_registrado
        // (está fuera de la ventana de fechas), pero se le dice a la escuela.
        const parecido = monto !== null
            ? (e.registrados ?? []).find((p) => Number(p.amount) === monto || Number(p.amount_paid) === monto)
            : undefined;
        return {
            decision: 'sin_pendientes',
            motivo: 'la familia no tiene cobros pendientes'
                + (parecido ? `; ya hay un pago ${parecido.status} de ${monto} (${parecido.concept ?? parecido.id}, ${parecido.payment_date ?? parecido.updated_at?.slice(0, 10) ?? 's/f'}): ¿otro mes?` : ''),
            pagoRegistradoId: parecido?.id ?? null,
        };
    }
    if (match.tipo === 'unico') return decidirPorMonto(match.pago, monto, e.pendientes, 'el único cobro pendiente', recargos);
    if (match.tipo === 'por_monto') {
        return { decision: 'en_revision', motivo: `a ${describirPago(match.pago)}`, pago: match.pago };
    }
    if (match.tipo === 'combinacion') {
        // Suma exacta (2026-10-13): a todos, empezando por el más antiguo. El
        // principal lleva el comprobante; los demás quedan en revisión con el
        // mismo archivo (wa_cubrir_cobros_con_comprobante).
        const [principal, ...cubre] = ordenarDelMasAntiguo(match.pagos);
        return {
            decision: 'en_revision',
            motivo: `cubre ${match.pagos.length} cobros: ${match.pagos.map(describirPago).join(' + ')}`,
            pago: principal,
            pagosCubiertos: cubre,
            esperado: match.pagos.reduce((s, p) => s + p.amount, 0),
        };
    }

    // El monto no desempata: ¿la familia dijo a cuál iba? (2026-10-06)
    // Candidatos: los del mismo monto si hay varios; si ninguno coincide, todos.
    const exactos = monto !== null ? e.pendientes.filter((p) => p.amount === monto) : [];
    const candidatos = exactos.length > 1 ? exactos : e.pendientes;
    const elegido = desempatarCobro(candidatos, e.textos ?? []);
    if (elegido) return decidirPorMonto(elegido.pago, monto, e.pendientes, `el cobro señalado ${elegido.via}`, recargos);
    // «El más antiguo» (la misma regla del worker, `elMasAntiguoDelMismoDeportista`):
    // varios del mismo monto del MISMO deportista, o un monto MAYOR que el más
    // antiguo (lo de más queda como saldo a favor). Con deportistas distintos,
    // o un monto menor, no se adivina.
    const masAntiguo = elMasAntiguoDelMismoDeportista(candidatos);
    if (masAntiguo && (exactos.length > 1 || (monto !== null && monto > masAntiguo.amount))) {
        return decidirPorMonto(masAntiguo, monto, e.pendientes, 'el cobro más antiguo', recargos);
    }
    return {
        decision: 'varios_cobros',
        motivo: `${e.pendientes.length} cobros pendientes y ni el monto ni el chat desempatan: `
            + candidatos.slice(0, 3).map(describirPago).join(' | '),
    };
}

/** Un comprobante por debajo de esto no se toma como abono: es otra cosa (o mal leído). */
export const ABONO_MINIMO = 0.2;

/**
 * Ya hay UN cobro; falta ver si el monto le sirve.
 *
 *  - igual (o ilegible: lo marca el veredicto) → en revisión.
 *  - MENOR y razonable (≥ 20 %) → en revisión como ABONO. Se estampa igual
 *    que cualquier comprobante (`awaiting_approval`, `ocr_amount` = lo leído,
 *    veredicto con MONTO_DIFIERE); al abrirlo, la pantalla de aprobación de la
 *    escuela (ApprovePaymentMethodSheet) ve `ocr_amount < saldo` y propone sola
 *    «Registrar abono» por ese valor → `partial` + `amount_paid`. Nunca se
 *    escribe `partial` ni `amount_paid` desde acá: eso ES aprobar.
 *  - menor al 20 % → buzón (lo típico: un comprobante de otra cosa, o mal leído).
 *  - MAYOR → buzón, con la sugerencia: varios meses o hermanos en una sola
 *    transferencia. Repartirlo es decisión de la escuela.
 *
 * Origen: simulación de Dynasty del 2026-10-05, 4 de 9 «único pendiente» por
 * otro valor ($25.000 y $170.000 contra un cobro de $180.000).
 */
export function decidirPorMonto(
    pago: PagoPendiente,
    monto: number | null,
    pendientes: PagoPendiente[],
    cual: string,
    recargos: Map<string, number[]> = new Map(),
): DecisionDeRecuperacion {
    const sufijo = cual.startsWith('el único') ? '' : ` (${cual})`;
    if (monto === null || monto === pago.amount) {
        return { decision: 'en_revision', motivo: `a ${describirPago(pago)}${sufijo}`, pago };
    }
    // Recargo del enlace de pago: es pago completo (el recargo es de la escuela).
    if ((recargos.get(pago.id) ?? []).includes(monto)) {
        return {
            decision: 'en_revision',
            motivo: `a ${describirPago(pago)}${sufijo}: ${monto} es el valor con el recargo del enlace de pago`,
            pago,
            esperado: monto,
        };
    }
    if (monto < pago.amount) {
        if (monto >= pago.amount * ABONO_MINIMO) {
            return {
                decision: 'abono_en_revision',
                motivo: `abono de ${monto} (saldo ${pago.amount - monto}) a ${describirPago(pago)}${cual.startsWith('el único') ? '' : ` (${cual})`}`,
                pago,
            };
        }
        return { decision: 'monto_distinto', motivo: `leído ${monto}: menos del ${ABONO_MINIMO * 100} % de ${describirPago(pago)} (${cual})` };
    }
    // MAYOR (decisión de la escuela, 2026-10-13): se toma el pago igual y lo de
    // más queda como saldo a favor cuando la escuela lo aprueba (lo registra la
    // base: trg_payments_saldo_a_favor_al_aprobar). Si suma justo TODOS los
    // pendientes y no se pudo repartir (más de una combinación), decide la escuela.
    const suma = pendientes.reduce((s, p) => s + p.amount, 0);
    if (pendientes.length > 1 && suma === monto) {
        return { decision: 'monto_distinto', motivo: `leído ${monto}: MAYOR que ${describirPago(pago)} (${cual}); ${sugerenciaMontoMayor(monto, pago, pendientes)}` };
    }
    return {
        decision: 'en_revision',
        motivo: `leído ${monto}: MAYOR que ${describirPago(pago)}${sufijo}; ${monto - pago.amount} de más quedan como saldo a favor al aprobar`,
        pago,
        excedente: monto - pago.amount,
    };
}

/** Qué puede ser un comprobante mayor que el cobro, para el motivo del buzón. */
export function sugerenciaMontoMayor(monto: number, pago: PagoPendiente, pendientes: PagoPendiente[]): string {
    const suma = pendientes.reduce((s, p) => s + p.amount, 0);
    if (pendientes.length > 1 && suma === monto) return `coincide con la suma de los ${pendientes.length} cobros pendientes`;
    if (pago.amount > 0 && monto % pago.amount === 0) return `equivale a ${monto / pago.amount} cobros de ${pago.amount} (varios meses o hermanos)`;
    return 'posible pago de varios meses o de hermanos';
}

// ─── Desempate por lo que dijo la familia ────────────────────────────────────

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** Palabras de los conceptos que no nombran a nadie. */
const NO_SON_NOMBRE = new Set(['mensualidad', 'inscripcion', 'matricula', 'pago', 'cobro', 'cuota', 'uniforme',
    'del', 'los', 'las', 'mes', 'sub', 'categoria', 'plan', 'clase', 'clases', 'torneo', ...MESES]);

/** Meses (1-12) que nombra un texto: «octubre», «10/2026», «oct». */
export function mesesMencionados(texto: string): Set<number> {
    const t = normalizarFrase(texto);
    const meses = new Set<number>();
    MESES.forEach((m, i) => { if (new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(t)) meses.add(i + 1); });
    for (const m of (texto || '').matchAll(/\b(0?[1-9]|1[0-2])\s*[/-]\s*(20\d{2})\b/g)) meses.add(Number(m[1]));
    return meses;
}

/** El mes al que corresponde un cobro: el del concepto («10/2026», «octubre») o el del vencimiento. */
export function mesDelCobro(p: PagoPendiente): number | null {
    const delConcepto = mesesMencionados(p.concept ?? '');
    if (delConcepto.size === 1) return Array.from(delConcepto)[0];
    if (p.due_date && /^\d{4}-\d{2}/.test(p.due_date)) return Number(p.due_date.slice(5, 7));
    return null;
}

/** Palabras del nombre del deportista: el de la ficha, o lo que sigue al « - » del concepto. */
function nombreDe(p: PagoPendiente): string[] {
    const crudo = p.atleta ?? (p.concept?.includes(' - ') ? p.concept.split(' - ').slice(1).join(' ') : '');
    return normalizarFrase(crudo).split(' ').filter((w) => w.length >= 3 && !NO_SON_NOMBRE.has(w) && !/^\d+$/.test(w));
}

/**
 * El cobro que señala el chat (pie de foto, mensajes de la familia cerca de la
 * foto, descripción del comprobante), o null. En orden:
 *
 *  1. La referencia o el concepto anunciados (texto precargado de /p/:token) —
 *     la misma regla que el worker (`elegirPorPista`).
 *  2. El deportista: un nombre que distingue a un candidato de los demás (los
 *     hermanos comparten apellido, así que cuenta lo que NO comparten).
 *  3. El mes: «octubre», «10/2026».
 *
 * Solo elige si queda UNO. Lo que elige igual queda en revisión de la escuela.
 */
export function desempatarCobro(
    candidatos: PagoPendiente[],
    textos: (string | null | undefined)[],
): { pago: PagoPendiente; via: string } | null {
    if (candidatos.length === 0) return null;
    const porPista = elegirPorPista(candidatos, pistaDesdeTextos(textos));
    if (porPista) return { pago: porPista, via: 'por la referencia/concepto que anunció la familia' };

    const todo = textos.filter(Boolean).join(' \n ');
    if (!todo.trim()) return null;
    const palabras = new Set(normalizarFrase(todo).split(' '));

    let quedan = candidatos;
    const via: string[] = [];
    const nombres = candidatos.map(nombreDe);
    // Cuenta la palabra que NO tienen todos (el apellido de los hermanos no
    // separa a nadie; el nombre de pila sí). Dos cobros del mismo niño (meses
    // distintos) quedan juntos y los separa el mes.
    const deTodos = new Set(nombres[0].filter((w) => nombres.every((n) => n.includes(w))));
    const nombrados = candidatos.filter((_, i) => nombres[i].some((w) => !deTodos.has(w) && palabras.has(w)));
    if (nombrados.length > 0 && nombrados.length < candidatos.length) {
        quedan = nombrados;
        via.push('por el nombre del deportista');
    }
    if (quedan.length > 1) {
        const meses = mesesMencionados(todo);
        if (meses.size > 0) {
            const delMes = quedan.filter((p) => { const m = mesDelCobro(p); return m !== null && meses.has(m); });
            if (delMes.length > 0 && delMes.length < quedan.length) {
                quedan = delMes;
                via.push('por el mes');
            }
        }
    }
    return quedan.length === 1 && via.length > 0 ? { pago: quedan[0], via: via.join(' y ') } : null;
}

// ─── Cómo queda la fila de la cola ───────────────────────────────────────────

/** Prefijo de `error_message` de todo lo que tocó la recuperación: así no se reprocesa. */
export const PREFIJO_RECUPERADO = 'recuperado:';

/**
 * El cierre de la fila según la decisión. `null` = no se cierra (transitorio):
 * la fila vuelve a su estado previo y la próxima corrida lo intenta de nuevo.
 *
 * Estados y result_type dentro de los CHECK de la tabla (verificados en la base
 * el 2026-10-05): status pending|processing|waiting_user|done|failed|ignored;
 * result_type payment_receipt|glosa|escalated|none. Lo que necesita a una
 * persona va `ignored` + `escalated`, que es lo que lista el buzón.
 */
export function cierreDeFila(
    r: ResultadoRecuperacion,
    ahoraIso: string,
    opciones: { avisarDesenlace?: boolean } = {},
): Record<string, unknown> | null {
    if (r.decision === 'reintentar') return null;
    const base = {
        processed_at: ahoraIso,
        locked_until: null,
        error_message: `${PREFIJO_RECUPERADO} ${r.decision} — ${r.motivo}`.slice(0, 500),
        // Regla 2: el job de desenlace no avisa de estos pagos, salvo que el
        // llamador pida avisar (la recuperación de la cola, ver arriba).
        outcome_notified_at: ahoraIso,
        matched_parent_id: r.parentId ?? null,
        // Huellas (bug 1 del informe 2026-10-13): sin sha ni referencia la
        // bandeja no podía enlazar la fila con el pago y no la cerraba sola.
        ...(r.sha || r.ocr ? { pregunta_ocr: huellasDelComprobante({ sha: r.sha, ocr: r.ocr, parentId: r.parentId ?? null }) } : {}),
    };
    switch (r.decision) {
        case 'en_revision':
        case 'abono_en_revision':
            return {
                ...base, status: 'done', result_type: 'payment_receipt',
                result_ref_id: r.pago?.id ?? null, matched_child_id: r.pago?.child_id ?? null,
                ...(opciones.avisarDesenlace ? { outcome_notified_at: null } : {}),
            };
        case 'ya_registrado':
            return { ...base, status: 'ignored', result_type: 'none', result_ref_id: r.pagoRegistradoId ?? null };
        case 'no_es_comprobante':
        case 'es_listado':
        case 'fuera_de_sportmaps':
            return { ...base, status: 'ignored', result_type: 'none' };
        case 'archivo_no_disponible':
            return { ...base, status: 'failed', result_type: 'none' };
        default:
            // destino_ajeno, sin_pendientes, varios_cobros, monto_distinto, familia_sin_cuenta,
            // numero_ambiguo, sin_familia: los ve una persona en el buzón.
            return { ...base, status: 'ignored', result_type: 'escalated', result_ref_id: r.pagoRegistradoId ?? null };
    }
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

/**
 * ¿Esta referencia de banco o esta imagen ya están en algún pago de la escuela?
 *
 * Es la misma defensa que el veredicto (checks 7 y 8 de
 * `buildVerdictContext`) más el UNIQUE `uq_payments_school_ocr_reference`,
 * pero devolviendo EL pago — la escuela necesita saber a cuál quedó. Se
 * busca también por `ocr_reference` crudo porque el estampado del worker no
 * llena `receipt_reference_norm`.
 *
 * Una referencia de menos de 6 caracteres no se usa: «1» o «OK» chocan con
 * cualquier cosa.
 */
export async function buscarComprobanteYaUsado(
    schoolId: string,
    ocr: OcrResult,
    sha: string,
): Promise<{ paymentId: string | null; por: 'referencia' | 'imagen' } | null> {
    const norm = normalizeReference(ocr.reference);
    if (norm && norm.length >= 6) {
        const { data: porCrudo } = await supabase.from('payments').select('id')
            .eq('school_id', schoolId).eq('ocr_reference', ocr.reference as string).limit(1);
        if (porCrudo?.length) return { paymentId: porCrudo[0].id as string, por: 'referencia' };
        const { data: porNorm } = await supabase.from('payments').select('id')
            .eq('school_id', schoolId).eq('receipt_reference_norm', norm).limit(1);
        if (porNorm?.length) return { paymentId: porNorm[0].id as string, por: 'referencia' };
    }
    // Igual que el índice único parcial: un rechazo libera la imagen.
    const { data: porImagen } = await supabase.from('payments').select('id')
        .eq('school_id', schoolId).eq('receipt_image_sha256', sha)
        .not('status', 'in', '(rejected,cancelled,failed)').limit(1);
    if (porImagen?.length) return { paymentId: porImagen[0].id as string, por: 'imagen' };
    return null;
}

/**
 * Pagos de la familia que ya cuentan: cobrados, abonados o en revisión.
 *
 * Por `parent_id` Y por los hijos del acudiente: las planillas de papel y el
 * registro a mano dejan pagos con `child_id` y sin `parent_id` (14 de 120 en
 * Dynasty desde el 25-sep). Buscar solo por `parent_id` los perdería y
 * produciría justo el doble pago que esto evita.
 */
export async function pagosRegistradosDeLaFamilia(parentId: string, schoolId: string): Promise<PagoRegistrado[]> {
    return pagosRegistradosDe(schoolId, { parentId, childIds: await hijosDelAcudiente(parentId, schoolId) });
}

/** Ids de los hijos del acudiente en la escuela. */
async function hijosDelAcudiente(parentId: string, schoolId: string): Promise<string[]> {
    const { data: hijos } = await supabase.from('children').select('id')
        .eq('parent_id', parentId).eq('school_id', schoolId);
    return (hijos ?? []).map((h: any) => h.id as string);
}

/** Quién es la familia en la tabla `payments`: cualquiera de los cuatro caminos que tenga. */
export interface LlavesDeFamilia { parentId?: string | null; childIds?: string[]; unregisteredIds?: string[] }

/** Filtro `.or()` de PostgREST para las llaves; null si no hay ninguna. */
export function filtroDeFamilia(k: LlavesDeFamilia): string | null {
    const partes: string[] = [];
    // Un atleta ADULTO identificado por su número (bug 5, 2026-10-13) aparece
    // como `parentId`; sus cobros pueden estar con user_id = él.
    if (k.parentId) partes.push(`parent_id.eq.${k.parentId}`, `user_id.eq.${k.parentId}`);
    if (k.childIds?.length) partes.push(`child_id.in.(${k.childIds.join(',')})`);
    if (k.unregisteredIds?.length) partes.push(`unregistered_athlete_id.in.(${k.unregisteredIds.join(',')})`);
    return partes.length ? partes.join(',') : null;
}

/**
 * Cobros pendientes de la familia por TODAS sus llaves (2026-10-06).
 *
 * `pagosPendientesDe` (la del worker) mira solo `parent_id`: el cobro de un
 * hijo cargado por la escuela con `child_id` y sin `parent_id` no aparece, y
 * el worker le contestó «no tienes cobros pendientes» a 7 familias el 06-oct.
 * Acá se suman los de los hijos y, para familias sin cuenta, los de la ficha.
 */
export async function pendientesDeLaFamilia(
    schoolId: string,
    k: LlavesDeFamilia,
    nombresSinRegistrar?: Map<string, string>,
): Promise<PagoPendiente[]> {
    const filtro = filtroDeFamilia(k);
    if (!filtro) return [];
    const { data, error } = await supabase.from('payments')
        .select('id, amount, concept, due_date, child_id, unregistered_athlete_id, payment_category, payment_type, child:children(full_name)')
        .eq('school_id', schoolId)
        .in('status', ['pending', 'overdue'])
        .or(filtro)
        .order('due_date', { ascending: true })
        .limit(50);
    if (error || !data) return [];
    return (data as any[]).map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        concept: p.concept ?? null,
        due_date: p.due_date ?? null,
        child_id: p.child_id ?? null,
        atleta: p.child?.full_name ?? (p.unregistered_athlete_id ? nombresSinRegistrar?.get(p.unregistered_athlete_id) ?? null : null),
        categoria: categoriaDelCobro(p),
    }));
}

/** Pagos ya registrados (cobrados, abonados o en revisión) por las llaves de la familia. */
export async function pagosRegistradosDe(schoolId: string, k: LlavesDeFamilia): Promise<PagoRegistrado[]> {
    const filtro = filtroDeFamilia(k);
    if (!filtro) return [];
    const desde = new Date(Date.now() - 150 * DIA_MS).toISOString();
    const { data } = await supabase.from('payments')
        .select('id, amount, amount_paid, status, payment_date, updated_at, concept')
        .eq('school_id', schoolId)
        .in('status', ['paid', 'partial', 'awaiting_approval'])
        .or(filtro)
        .gte('updated_at', desde)
        .limit(200);
    return (data ?? []).map((p: any) => ({
        id: p.id, amount: Number(p.amount), amount_paid: p.amount_paid === null ? null : Number(p.amount_paid),
        status: p.status, payment_date: p.payment_date ?? null, updated_at: p.updated_at ?? null,
        concept: p.concept ?? null,
    }));
}

/** Decisiones que NO terminan en un cobro y por eso llevan propuesta para la escuela. */
const DECISIONES_CON_PROPUESTA: DecisionRecuperacion[] = [
    'monto_distinto', 'sin_pendientes', 'varios_cobros', 'familia_sin_cuenta', 'sin_familia', 'numero_ambiguo',
];

/**
 * La propuesta de la bandeja (F): qué deportista, qué mes, qué cobro y por qué.
 * Con el deportista conocido, el pago esperado (`calcularCandidatosDePago`); sin
 * él, los deportistas que el comprobante nombra a medias. Solo lectura; nunca lanza.
 */
export async function propuestaParaLaBandeja(e: {
    decision: DecisionRecuperacion;
    schoolId: string;
    llaves: LlavesDeFamilia | null;
    ocr: OcrResult;
    textos: (string | null | undefined)[];
    fecha: string;
    destinoDeLaEscuela: boolean;
    noDuplicado: boolean;
}): Promise<string | null> {
    if (!DECISIONES_CON_PROPUESTA.includes(e.decision)) return null;
    try {
        const pago = e.ocr.originName ? `pagó: ${e.ocr.originName}` : null;
        if (e.llaves) {
            const r = await calcularCandidatosDePago({
                schoolId: e.schoolId, monto: e.ocr.amount ?? null, destinoDeLaEscuela: e.destinoDeLaEscuela, noDuplicado: e.noDuplicado,
                llaves: { parentId: e.llaves.parentId, childIds: e.llaves.childIds, unregisteredIds: e.llaves.unregisteredIds },
            });
            if (!r.deportistas.length) return pago ? `Propuesta → ${pago} · sin inscripción activa para calcular lo esperado` : null;
            let t = textoPropuesta(r.propuesta);
            if (e.decision === 'sin_pendientes') {
                const mes = Number(e.fecha.slice(5, 7));
                const nombres = r.deportistas.map((d) => d.nombre).filter(Boolean).join(' / ');
                t += ` · mes del comprobante: ${nombreDelMes(mes).toLowerCase()} ${e.fecha.slice(0, 4)}`
                    + ` → crear el cobro de ese mes${nombres ? ` de ${nombres}` : ''} y aplicarlo (no se crea solo)`;
            }
            return pago ? `${t} · ${pago}` : t;
        }
        const posibles = await candidatosParaPreguntar(e.schoolId, e.textos);
        return `Propuesta → ${pago ? `${pago} · ` : ''}deportista: `
            + (posibles.length ? `¿${posibles.map((p) => p.nombre).join(' o ')}?` : 'sin identificar (el nombre del comprobante no señala a nadie de la escuela)');
    } catch {
        return null;
    }
}

export interface EntradaComprobante {
    schoolId: string;
    familia: Familia;
    base64: string;
    mime: string;
    sha: string;
    /** Ruta en el bucket. null solo en simulación (no se sube nada). */
    storagePath: string | null;
    /** Cuándo llegó el mensaje (ISO). Respaldo de la fecha del comprobante. */
    fechaMensaje: string;
    /** false = simulación: decide igual, pero no escribe nada. */
    aplicar: boolean;
    queueId: string;
    log?: Logger;
    /** Pie de foto y mensajes de la familia cerca de la foto: pista del cobro. */
    textos?: (string | null | undefined)[];
    /** El pie de la foto solo (pesa más para decir de qué concepto es). */
    pie?: string | null;
    /** Nombre de los deportistas sin registrar (id → nombre), para describir sus cobros. */
    nombresSinRegistrar?: Map<string, string>;
    /** Inyectable para pruebas. */
    ocrFn?: (base64: string, mime: string) => Promise<OcrResult>;
}

/**
 * Lee, decide y —si `aplicar`— estampa. No toca la fila de la cola: eso lo
 * hace quien llama, con `cierreDeFila`.
 */
export async function procesarComprobanteRecuperado(e: EntradaComprobante): Promise<ResultadoRecuperacion> {
    const parentId = e.familia.tipo === 'identificado' ? e.familia.parentId : null;

    let ocr: OcrResult;
    try {
        ocr = await (e.ocrFn ?? extractReceipt)(e.base64, e.mime);
    } catch (err: any) {
        // Un OCR caído nunca decide: «no pude leer» no es «no es válido».
        return { decision: 'reintentar', motivo: `OCR no disponible: ${err?.message ?? err}`, ocr: null, parentId };
    }

    const [destinoDeLaEscuela, fueraDeSportmaps, yaUsadoEn] = await Promise.all([
        destinoEsDeLaEscuela(e.schoolId, ocr),
        destinoFueraDeSportmaps(e.schoolId, ocr),
        buscarComprobanteYaUsado(e.schoolId, ocr, e.sha),
    ]);

    let pendientes: PagoPendiente[] = [];
    let pagadosQueCubren: PagoRegistrado[] = [];
    let registrados: PagoRegistrado[] = [];
    let llaves: LlavesDeFamilia | null = null;
    let familia: Familia = e.familia;
    if (parentId) {
        llaves = { parentId, childIds: await hijosDelAcudiente(parentId, e.schoolId) };
    } else if (e.familia.tipo === 'sin_cuenta' && (e.familia.childIds?.length || e.familia.unregisteredIds?.length)) {
        llaves = { childIds: e.familia.childIds, unregisteredIds: e.familia.unregisteredIds };
    }
    // Spec 3.3/3.5 (2026-10-24): número sin ficha (o familia sin cuenta sin fichas):
    // el deportista por lo que dice el pie, el chat, el concepto y quien paga —igual
    // que el worker con un número sin ficha—. Con UN solo candidato se sigue como
    // familia con ficha; si no, va al buzón con los candidatos. Nunca se aprueba.
    // Solo el nombre COMPLETO de UN deportista (un número sin verificar nunca se liga por
    // dos palabras sueltas ni por el apellido: Monster 2026-11-05, Ethann / Laura Sofía).
    let deportistaPorElNombre = false;
    if (!llaves && (familia.tipo === 'desconocido' || familia.tipo === 'sin_cuenta')) {
        const exacta = (await deportistaPorNombreSinVerificar(e.schoolId, [e.pie, ocr.description, ocr.originName, ...(e.textos ?? [])])
            .catch(() => null))?.exacta ?? null;
        const k = exacta
            ? (exacta.tipo === 'child' ? { childIds: [exacta.id], unregisteredIds: [] } : { childIds: [], unregisteredIds: [exacta.id] })
            : null;
        if (k && (k.childIds.length || k.unregisteredIds.length)) {
            llaves = { childIds: k.childIds, unregisteredIds: k.unregisteredIds };
            familia = { tipo: 'sin_cuenta', childIds: k.childIds, unregisteredIds: k.unregisteredIds };
            deportistaPorElNombre = true;
        }
    }
    if (llaves) {
        const [porLlaves, delWorker, regs] = await Promise.all([
            pendientesDeLaFamilia(e.schoolId, llaves, e.nombresSinRegistrar),
            // El del worker, por si algún día mira algo más que parent_id.
            parentId ? pagosPendientesDe(parentId, e.schoolId) : Promise.resolve([] as PagoPendiente[]),
            pagosRegistradosDe(e.schoolId, llaves),
        ]);
        const vistos = new Set<string>();
        pendientes = [...porLlaves, ...delWorker].filter((p) => (vistos.has(p.id) ? false : (vistos.add(p.id), true)));
        registrados = regs;
        pagadosQueCubren = pagosQueYaCubren(registrados, ocr.amount ?? null, fechaDeReferencia(ocr.date, e.fechaMensaje));
    }

    const recargos = await cargarRecargos(e.schoolId, pendientes);
    const textosDecision = [...(e.textos ?? []), ocr.description];
    // Torneo: se lee el catálogo y el deportista SOLO si el comprobante lo nombra.
    let torneos: ItemDeTorneo[] | undefined;
    let deportistaTorneo: string | null = null;
    if (detectarOtroConcepto({ pie: e.pie, descripcion: ocr.description, chat: textosDecision })?.concepto === 'torneo') {
        torneos = await cargarItemsDeTorneo(e.schoolId);
        if (llaves) {
            const nombres = (await deportistasEsperados(e.schoolId, llaves)).map((x) => x.nombre).filter(Boolean) as string[];
            deportistaTorneo = nombres.length === 1 ? nombres[0] : nombres.length > 1 ? `${nombres.join(' / ')} (¿cuál?)` : null;
        }
    }
    const d = decidirRecuperacion({
        familia, ocr, destinoDeLaEscuela, yaUsadoEn, pagadosQueCubren, pendientes, registrados,
        textos: textosDecision,
        pie: e.pie ?? null,
        fueraDeSportmaps,
        recargos,
        torneos, deportista: deportistaTorneo,
    });
    if (deportistaPorElNombre && (d.decision === 'en_revision' || d.decision === 'abono_en_revision')) {
        d.motivo += ' (deportista identificado por el nombre del comprobante, no por el teléfono)';
    }
    // Spec 3.5 / F: lo que no se aplica sale con la propuesta armada (deportista,
    // mes, cobro, por qué) en el motivo, para que la escuela decida con un toque.
    const propuesta = await propuestaParaLaBandeja({
        decision: d.decision, schoolId: e.schoolId, llaves, ocr, textos: [e.pie, ...textosDecision],
        fecha: fechaDeReferencia(ocr.date, e.fechaMensaje),
        destinoDeLaEscuela, noDuplicado: !yaUsadoEn,
    });
    if (propuesta) d.motivo = motivoConPropuesta(d.motivo, propuesta);
    const resultado: ResultadoRecuperacion = {
        ...d, ocr, parentId, sha: e.sha, propuesta, ...(deportistaPorElNombre ? { porNombreSinVerificar: true } : {}),
    };

    if ((d.decision !== 'en_revision' && d.decision !== 'abono_en_revision') || !e.aplicar) return resultado;

    if (!e.storagePath) {
        // No debería pasar: aplicar siempre guarda el archivo antes.
        return { ...resultado, decision: 'reintentar', motivo: 'sin archivo guardado para adjuntar' };
    }
    const estampado = await estamparComprobante(
        { queueId: e.queueId, schoolId: e.schoolId, storagePath: e.storagePath, sha: e.sha, ocr, log: e.log },
        d.pago as PagoPendiente,
        d.esperado,
    );
    if (!estampado.ok) {
        if (estampado.duplicado) {
            return {
                ...resultado, decision: 'ya_registrado', pago: undefined,
                motivo: `la referencia ${ocr.reference} ya está en otro pago`,
                pagoRegistradoId: estampado.yaAplicado?.id ?? null,
            };
        }
        return { ...resultado, decision: 'reintentar', motivo: estampado.error };
    }
    if (!estampado.actualizado) {
        // Lo registró la escuela entre la búsqueda y el estampado.
        return { ...resultado, decision: 'sin_pendientes', pago: undefined, motivo: 'el cobro dejó de estar pendiente mientras se procesaba' };
    }
    if (d.pagosCubiertos?.length) {
        const c = await cubrirCobrosConComprobante(e.schoolId, (d.pago as PagoPendiente).id, d.pagosCubiertos.map((p) => p.id));
        // Si falla, el principal queda con el comprobante entero y, al aprobarlo,
        // lo de más se vuelve saldo a favor de esos mismos cobros. Queda en el log.
        if (!c.ok) e.log?.warn?.({ queueId: e.queueId, err: c.error }, '[wa-recuperar] no se pudieron cubrir los otros cobros');
    }
    return { ...resultado, veredicto: estampado.veredicto.verdict };
}

// ─── Identificación por teléfono ─────────────────────────────────────────────

const tel10 = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '').slice(-10);

/**
 * Quién es el dueño de este número para la escuela.
 *
 * Con `soloLectura=false` usa `wa_identify_by_phone`, la misma RPC del bot y
 * del worker — que además vincula la conversación al acudiente (efecto que el
 * bot ya tiene en cada turno).
 *
 * En SIMULACIÓN no se puede llamar: escribe (`whatsapp_conversations` y
 * `whatsapp_identifications`). Ahí se usa `identificarSoloLectura`, que espeja
 * la RPC con lecturas. Si la RPC cambia, este espejo tiene que cambiar con
 * ella — es el precio de una simulación que de verdad no escribe.
 */
export async function identificarFamilia(
    integrationId: string,
    schoolId: string,
    contactWaId: string,
    opciones: { soloLectura: boolean; cache?: CacheEscuela },
): Promise<Familia> {
    // Quien administra la escuela va PRIMERO, aunque también sea acudiente: es
    // la misma regla del worker (`decidirAdjunto`). En Dynasty la dueña tiene
    // una hija entrenando y reenvía al chat fotos de comprobantes de OTRAS
    // familias; tratarla como «familia» aplicaría esa plata a SUS cobros.
    // Solo lectura en la base (sin efectos), así que vale en los dos modos.
    const { data: staff } = await supabase.rpc('wa_identify_staff_admin_by_phone', {
        p_school_id: schoolId, p_wa_phone_number: contactWaId,
    });
    if ((staff as any)?.estado === 'identificado') return { tipo: 'staff' };

    let familia: Familia;
    if (opciones.soloLectura) {
        familia = await identificarSoloLectura(schoolId, contactWaId, opciones.cache);
    } else {
        const { data, error } = await supabase.rpc('wa_identify_by_phone', {
            p_integration_id: integrationId, p_contact_wa_id: contactWaId,
        });
        const r = error ? null : (data as any);
        if (r?.estado === 'identificado' && r.parent_id) familia = { tipo: 'identificado', parentId: r.parent_id };
        else if (r?.estado === 'debe_registrarse') familia = { tipo: 'sin_cuenta' };
        else if (r?.estado === 'ambiguo') familia = { tipo: 'ambiguo' };
        else familia = { tipo: 'desconocido' };
    }
    if (familia.tipo === 'sin_cuenta') {
        // La RPC solo dice «es familia»; las fichas dicen DE QUIÉN, para buscar
        // sus cobros por child_id / unregistered_athlete_id.
        return { tipo: 'sin_cuenta', ...(await fichasDelTelefono(schoolId, contactWaId, opciones.cache)) };
    }
    if (familia.tipo !== 'desconocido') return familia;

    // Verificado por OTP desde este número (camino viejo del bot).
    const { data: conv } = await supabase.from('whatsapp_conversations')
        .select('identified, parent_id')
        .eq('integration_id', integrationId).eq('contact_wa_id', contactWaId).maybeSingle();
    if ((conv as any)?.identified && (conv as any)?.parent_id) {
        return { tipo: 'identificado', parentId: (conv as any).parent_id };
    }
    return { tipo: 'desconocido' };
}

/** Teléfonos de la escuela, leídos una vez por corrida. */
export interface CacheEscuela {
    acudientesPorTel?: Map<string, Set<string>>;
    /** Teléfono del perfil de un atleta ADULTO activo de la escuela → perfiles. */
    adultosPorTel?: Map<string, Set<string>>;
    /** Teléfono del acudiente en la ficha (`children.parent_phone_temp`) → hijos activos. */
    hijosPorTelFicha?: Map<string, string[]>;
    /** Teléfono de `unregistered_athletes` (acudiente o propio) → deportistas sin registrar activos. */
    sinRegistrarPorTel?: Map<string, string[]>;
    nombresSinRegistrar?: Map<string, string>;
    /** La carga en curso: con varias filas en paralelo se lee una sola vez. */
    cargando?: Promise<void>;
}

function cargarCache(schoolId: string, cache: CacheEscuela): Promise<void> {
    if (!cache.cargando) cache.cargando = leerTelefonosDeLaEscuela(schoolId, cache);
    return cache.cargando;
}

function agregar(m: Map<string, string[]>, tel: string, id: string) {
    if (!/^3\d{9}$/.test(tel)) return; // un fijo no se cruza
    if (!m.has(tel)) m.set(tel, []);
    if (!m.get(tel)!.includes(id)) m.get(tel)!.push(id);
}

async function leerTelefonosDeLaEscuela(schoolId: string, cache: CacheEscuela): Promise<void> {
    const { data: hijos } = await supabase.from('children')
        .select('id, parent_id, parent_phone_temp')
        .eq('school_id', schoolId).eq('is_active', true).limit(5000);
    const parentIds = Array.from(new Set((hijos ?? []).map((h: any) => h.parent_id).filter(Boolean))) as string[];
    const porTel = new Map<string, Set<string>>();
    for (let i = 0; i < parentIds.length; i += 150) {
        const { data: perfiles } = await supabase.from('profiles').select('id, phone')
            .in('id', parentIds.slice(i, i + 150));
        for (const p of perfiles ?? []) {
            const t = tel10((p as any).phone);
            if (!t) continue;
            if (!porTel.has(t)) porTel.set(t, new Set());
            porTel.get(t)!.add((p as any).id);
        }
    }
    cache.acudientesPorTel = porTel;

    // Atletas adultos activos (school_members role 'athlete'), como el bloque
    // «Atleta adulto» de wa_identify_by_phone (migración 20261013165308).
    const adultos = new Map<string, Set<string>>();
    try {
        const { data: miembros } = await supabase.from('school_members').select('profile_id')
            .eq('school_id', schoolId).eq('role', 'athlete').eq('status', 'active').limit(5000);
        const ids = Array.from(new Set(((miembros ?? []) as any[]).map((m) => m?.profile_id).filter(Boolean))) as string[];
        for (let i = 0; i < ids.length; i += 150) {
            const { data: perfiles } = await supabase.from('profiles').select('id, phone').in('id', ids.slice(i, i + 150));
            for (const p of (perfiles ?? []) as any[]) {
                const t = tel10(p?.phone);
                if (!/^3\d{9}$/.test(t)) continue;
                if (!adultos.has(t)) adultos.set(t, new Set());
                adultos.get(t)!.add(p.id);
            }
        }
    } catch { /* sin adultos: como antes */ }
    cache.adultosPorTel = adultos;

    const hijosPorTel = new Map<string, string[]>();
    for (const h of (hijos ?? []) as any[]) if (h.id) agregar(hijosPorTel, tel10(h.parent_phone_temp), h.id);
    cache.hijosPorTelFicha = hijosPorTel;

    // Mismo filtro que `wa_es_familia_sin_registrar`: activos y sin perfil vinculado.
    const { data: sinReg } = await supabase.from('unregistered_athletes')
        .select('id, full_name, guardian_phone, phone')
        .eq('school_id', schoolId).eq('is_active', true).is('linked_profile_id', null).limit(5000);
    const sinRegPorTel = new Map<string, string[]>();
    const nombres = new Map<string, string>();
    for (const u of (sinReg ?? []) as any[]) {
        if (!u.id) continue;
        agregar(sinRegPorTel, tel10(u.guardian_phone), u.id);
        agregar(sinRegPorTel, tel10(u.phone), u.id);
        if (u.full_name) nombres.set(u.id, u.full_name);
    }
    cache.sinRegistrarPorTel = sinRegPorTel;
    cache.nombresSinRegistrar = nombres;
}

/**
 * Las fichas de la escuela cuyo acudiente tiene este número: hijos activos por
 * `parent_phone_temp` y deportistas sin registrar por `guardian_phone`/`phone`.
 * Últimos 10 dígitos y solo celulares, como `wa_identify_by_phone`.
 */
export async function fichasDelTelefono(
    schoolId: string,
    contactWaId: string,
    cache: CacheEscuela = {},
): Promise<{ childIds: string[]; unregisteredIds: string[] }> {
    const t = tel10(contactWaId);
    if (!/^3\d{9}$/.test(t)) return { childIds: [], unregisteredIds: [] };
    await cargarCache(schoolId, cache);
    return {
        childIds: [...(cache.hijosPorTelFicha!.get(t) ?? [])],
        unregisteredIds: [...(cache.sinRegistrarPorTel!.get(t) ?? [])],
    };
}

/** Espejo de `wa_identify_by_phone` sin escrituras (ver `identificarFamilia`). */
async function identificarSoloLectura(schoolId: string, contactWaId: string, cache: CacheEscuela = {}): Promise<Familia> {
    const t = tel10(contactWaId);
    if (!/^3\d{9}$/.test(t)) return { tipo: 'desconocido' };
    await cargarCache(schoolId, cache);
    const ids = cache.acudientesPorTel!.get(t);
    if (ids && ids.size > 1) return { tipo: 'ambiguo' };
    if (ids && ids.size === 1) return { tipo: 'identificado', parentId: Array.from(ids)[0] };
    // Ningún acudiente con ese número: ¿un atleta adulto con su propio número?
    const adultos = cache.adultosPorTel?.get(t);
    if (adultos && adultos.size > 1) return { tipo: 'ambiguo' };
    if (adultos && adultos.size === 1) return { tipo: 'identificado', parentId: Array.from(adultos)[0] };
    if (cache.hijosPorTelFicha!.has(t)) return { tipo: 'sin_cuenta' };
    // STABLE en la base: solo lee `unregistered_athletes`.
    const { data } = await supabase.rpc('wa_es_familia_sin_registrar', { p_school_id: schoolId, p_contact_wa_id: contactWaId });
    return data === true ? { tipo: 'sin_cuenta' } : { tipo: 'desconocido' };
}

// ─── Una fila de la cola (Tarea A) ───────────────────────────────────────────

/** Filas que la recuperación toma: lo que nunca llegó a leerse. */
export const MOTIVOS_RECUPERABLES = ['bot_apagado', 'contacto sin identificar'] as const;

/**
 * Con `--reprocesar` (2026-10-06): lo que una corrida anterior —o el worker—
 * dejó en el buzón por algo que las reglas nuevas ya resuelven: familias sin
 * cuenta (cobro por ficha), varios cobros (pista del chat), monto distinto
 * (abono), sin pendientes (cobros por child_id) y sin familia (fichas sin
 * registrar). Más las que el worker cerró con «sin pagos pendientes» mirando
 * solo `parent_id`. Nada que haya quedado en un cobro (`en_revision`,
 * `ya_registrado`, `done`) se vuelve a tomar.
 */
export const DECISIONES_REPROCESABLES = [
    'familia_sin_cuenta', 'varios_cobros', 'monto_distinto', 'sin_pendientes', 'sin_familia',
] as const;
export const MOTIVOS_DEL_WORKER_REPROCESABLES = ['sin pagos pendientes'] as const;

/** ¿Esta fila de la cola le toca a la recuperación? */
export function esRecuperable(
    fila: { status: string; error_message: string | null; media_id?: string | null },
    reprocesar: boolean,
): boolean {
    if (!fila.media_id) return false;
    if (fila.status === 'pending') return true;
    if (fila.status !== 'ignored') return false;
    const em = fila.error_message ?? '';
    if ((MOTIVOS_RECUPERABLES as readonly string[]).includes(em)) return true;
    if (!reprocesar) return false;
    if ((MOTIVOS_DEL_WORKER_REPROCESABLES as readonly string[]).includes(em)) return true;
    // El worker cerró «monto_no_cuadra» ANTES de que existiera el recargo por
    // link (2026-10-13): un 157.500 de un link al 5 % quedó en el buzón. Las
    // reglas actuales lo leen; si no cuadra de verdad, vuelve al buzón igual.
    if (em.startsWith('monto_no_cuadra:')) return true;
    return DECISIONES_REPROCESABLES.some((d) => em.startsWith(`${PREFIJO_RECUPERADO} ${d} `));
}

export interface FilaParaRecuperar extends FilaCola {
    status: string;
    error_message: string | null;
    created_at: string;
    wa_timestamp: string | null;
}

/** Minutos alrededor de la foto en los que un mensaje de la familia cuenta como pista. */
export const VENTANA_TEXTOS_MIN = 10;

/**
 * Lo que escribió la familia alrededor de la foto: el pie y sus mensajes
 * ENTRANTES ±10 min (nombre del deportista, mes, el texto precargado de
 * /p/:token con la ref. del cobro). Solo lectura. Si falla, sin pista.
 */
export async function textosCercanos(fila: FilaParaRecuperar): Promise<string[]> {
    const textos: string[] = [];
    if (fila.media_caption) textos.push(fila.media_caption);
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id').eq('integration_id', fila.integration_id).eq('contact_wa_id', fila.wa_phone_number)
            .maybeSingle();
        const convId = (conv as any)?.id;
        if (!convId) return textos;
        // Las dos marcas son de llegada (`created_at`), como en el worker.
        const base = new Date(fila.created_at).getTime();
        if (Number.isNaN(base)) return textos;
        const { data } = await supabase.from('whatsapp_messages')
            .select('text_body, created_at')
            .eq('conversation_id', convId)
            .eq('direction', 'inbound')
            .gte('created_at', new Date(base - VENTANA_TEXTOS_MIN * 60_000).toISOString())
            .lte('created_at', new Date(base + VENTANA_TEXTOS_MIN * 60_000).toISOString())
            .limit(30);
        for (const m of (Array.isArray(data) ? data : []) as any[]) if (m?.text_body) textos.push(String(m.text_body));
    } catch { /* sin pista */ }
    return textos;
}

/** Minutos que la fila queda tomada mientras se procesa. */
const LEASE_RECUPERACION_MIN = 15;

/**
 * Recupera UNA fila: la toma, identifica a la familia, baja el archivo, decide
 * y —si `aplicar`— estampa y cierra la fila. En simulación no escribe NADA:
 * ni la toma, ni el bucket, ni la fila, ni el cobro.
 *
 * La toma es un UPDATE condicionado al estado que se leyó: si el cron (o otra
 * corrida) la agarró en el medio, no se procesa dos veces.
 */
export async function recuperarFilaDeCola(
    fila: FilaParaRecuperar,
    wa: WhatsAppIntegration,
    opciones: {
        aplicar: boolean; log?: Logger; cache?: CacheEscuela; ocrFn?: EntradaComprobante['ocrFn'];
        /** false = no avisarle a la familia (por defecto sí, ver regla 2). */
        avisar?: boolean;
    },
): Promise<ResultadoRecuperacion> {
    const { aplicar } = opciones;
    const avisar = opciones.avisar !== false;

    if (aplicar) {
        let toma = supabase.from('whatsapp_inbound_queue')
            .update({
                status: 'processing',
                locked_until: new Date(Date.now() + LEASE_RECUPERACION_MIN * 60_000).toISOString(),
            })
            .eq('id', fila.id)
            .eq('status', fila.status);
        toma = fila.error_message === null ? toma.is('error_message', null) : toma.eq('error_message', fila.error_message);
        const { data: tomadas } = await toma.select('id');
        if (!tomadas || tomadas.length === 0) {
            return { decision: 'reintentar', motivo: 'la fila cambió mientras tanto (la tomó otro proceso)', ocr: null };
        }
    }

    const devolver = async () => {
        if (aplicar) {
            await supabase.from('whatsapp_inbound_queue')
                .update({ status: fila.status, locked_until: null })
                .eq('id', fila.id);
        }
    };
    const cerrarCon = async (r: ResultadoRecuperacion) => {
        if (!aplicar) return;
        const cierre = cierreDeFila(r, new Date().toISOString(), { avisarDesenlace: avisar });
        if (!cierre) { await devolver(); return; }
        const { error } = await supabase.from('whatsapp_inbound_queue').update(cierre).eq('id', fila.id);
        if (error) opciones.log?.error?.({ id: fila.id, err: error.message }, '[wa-recuperar] no se pudo cerrar la fila');
    };

    try {
        const familia = await identificarFamilia(fila.integration_id, fila.school_id, fila.wa_phone_number,
            { soloLectura: !aplicar, cache: opciones.cache });

        const archivo = await obtenerArchivoDeFila(fila, wa, { guardar: aplicar });
        if (!archivo.ok) {
            const r: ResultadoRecuperacion = archivo.transitorio
                ? { decision: 'reintentar', motivo: archivo.error, ocr: null }
                // Lo típico: Meta ya no lo tiene (pasaron los ~30 días) o el
                // tipo no es imagen/PDF. No mejora reintentando.
                : { decision: 'archivo_no_disponible', motivo: `no se pudo bajar de WhatsApp: ${archivo.error}`, ocr: null };
            r.parentId = familia.tipo === 'identificado' ? familia.parentId : null;
            await cerrarCon(r);
            return r;
        }

        const sha = crypto.createHash('sha256').update(Buffer.from(archivo.base64, 'base64')).digest('hex');
        const r = await procesarComprobanteRecuperado({
            schoolId: fila.school_id, familia, base64: archivo.base64, mime: archivo.mime, sha,
            storagePath: archivo.storagePath,
            fechaMensaje: fila.wa_timestamp ?? fila.created_at,
            aplicar, queueId: fila.id, log: opciones.log, ocrFn: opciones.ocrFn,
            textos: await textosCercanos(fila),
            pie: fila.media_caption ?? null,
            nombresSinRegistrar: opciones.cache?.nombresSinRegistrar,
        });
        await cerrarCon(r);
        if (aplicar && avisar && (r.decision === 'en_revision' || r.decision === 'abono_en_revision')) {
            r.aviso = await avisarRecuperacion(fila, wa, r, opciones.log)
                .catch((err: any): AvisoRecuperacion => `error: ${err?.message ?? err}`);
        }
        return r;
    } catch (err: any) {
        await devolver();
        return { decision: 'reintentar', motivo: `excepción: ${err?.message ?? err}`, ocr: null };
    }
}

// ─── Aviso a la familia (regla 2) ────────────────────────────────────────────

export type AvisoRecuperacion =
    | 'avisado'
    | 'avisado_por_plantilla' // ventana cerrada: salió `comprobante_en_revision`
    | 'fuera_de_ventana'      // nada ahora; el desenlace sale por plantilla cuando la escuela decida
    | 'bot_apagado'
    | 'conversacion_tomada'
    | 'escuela_en_la_conversacion' // modo discreto: la escuela escribió en el chat en las últimas 12 h
    | 'sin_conversacion'
    | `error: ${string}`;

/** El texto para la familia. Pura. */
export function mensajeRecuperacion(
    r: Pick<ResultadoRecuperacion, 'decision' | 'pago' | 'ocr' | 'pagosCubiertos' | 'excedente' | 'porNombreSinVerificar'>,
): string | null {
    if (!r.pago) return null;
    if (r.porNombreSinVerificar && (r.decision === 'en_revision' || r.decision === 'abono_en_revision')) {
        // Número sin verificar: ningún dato del deportista (ni el concepto del cobro).
        const valor = r.ocr?.amount
            ? ` de ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(r.ocr.amount)}`
            : '';
        return `Recibí tu comprobante${valor} 📄\n\nLa escuela lo está revisando y te confirmo por aquí cuando lo apruebe.`;
    }
    const monto = r.ocr?.amount
        ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(r.ocr.amount)
        : null;
    const de = monto ? ` de ${monto}` : '';
    const cierre = '\n\nLa escuela lo está revisando y te confirmo por aquí cuando lo apruebe.';
    if (r.decision === 'abono_en_revision') {
        return `Recibí tu comprobante${de} y quedó como abono a *${describirPago(r.pago)}* 📄${cierre}`;
    }
    if (r.decision === 'en_revision') {
        const cobros = [r.pago, ...(r.pagosCubiertos ?? [])].map((p) => `*${describirPago(p)}*`).join(' y ');
        const extra = r.excedente ? `\n\n${textoExcedente(r.excedente)}` : '';
        return `Recibí tu comprobante${de} y quedó aplicado a ${cobros} 📄${extra}${cierre}`;
    }
    return null;
}

/**
 * Le cuenta a la familia que su comprobante quedó en revisión. Solo dentro de
 * la ventana de 24 h, con el bot prendido y la conversación sin tomar. Envía
 * y REGISTRA (como el worker), para que la escuela vea qué se le dijo.
 */
export async function avisarRecuperacion(
    fila: FilaParaRecuperar,
    wa: WhatsAppIntegration,
    r: ResultadoRecuperacion,
    log?: Logger,
): Promise<AvisoRecuperacion> {
    const texto = mensajeRecuperacion(r);
    if (!texto) return 'sin_conversacion';
    const { data: conv } = await supabase.from('whatsapp_conversations')
        .select('id, last_inbound_at')
        .eq('integration_id', fila.integration_id).eq('contact_wa_id', fila.wa_phone_number)
        .maybeSingle();
    const convId = (conv as any)?.id as string | undefined;
    if (!convId) return 'sin_conversacion';
    const abierta = ventanaAbierta((conv as any)?.last_inbound_at ?? null);
    if (!(await botEncendido(fila.integration_id))) return 'bot_apagado';
    if (await conversacionTomada(convId)) return 'conversacion_tomada';
    // Modo discreto (el de ESA escuela, B6): con la escuela en la conversación (12 h) no se le escribe.
    if (await modoDiscretoEfectivo(fila.school_id, modoDiscreto()) && await escuelaActiva(convId)) return 'escuela_en_la_conversacion';
    if (!abierta) {
        // Fuera de la ventana el texto no llega (131047). La plantilla, si la
        // WABA la tiene aprobada y hay opt-in; si no, como antes: nada ahora.
        const { avisarRevisionPorPlantilla } = await import('./whatsapp-aviso-revision.service');
        const env = await avisarRevisionPorPlantilla({
            schoolId: fila.school_id, telefono: fila.wa_phone_number,
            paymentId: (r.pago as PagoPendiente).id, parentId: r.parentId ?? null,
            monto: r.ocr?.amount ?? null, atleta: r.pago?.atleta ?? null,
            paso: `recuperado_${r.decision}`,
        });
        if (env.enviado) return 'avisado_por_plantilla';
        log?.info?.({ queueId: fila.id, motivo: env.motivo, detalle: env.detalle }, '[wa-recuperar] fuera de ventana, sin plantilla');
        return 'fuera_de_ventana';
    }

    const dadoDeBaja = await estaDadoDeBaja(fila.integration_id, fila.wa_phone_number);
    const final = aFormatoWhatsApp(dadoDeBaja ? texto + AVISO_DADO_DE_BAJA : texto);
    const enviado = await sendTextMessage(wa, fila.wa_phone_number, final);
    if (!enviado.ok) {
        log?.warn?.({ queueId: fila.id, err: enviado.error }, '[wa-recuperar] no salió el aviso');
        return `error: ${enviado.error ?? 'envío fallido'}`;
    }
    await supabase.rpc('wa_record_outbound_message', {
        p_conversation_id: convId,
        p_integration_id: fila.integration_id,
        p_wa_message_id: enviado.waMessageId || `local-${crypto.randomUUID()}`,
        p_type: 'text',
        p_text_body: final,
        p_payload: { step: `recuperado_${r.decision}`, queue_id: fila.id, payment_id: r.pago?.id ?? null },
        p_ai_generated: true,
        p_to_wa_id: fila.wa_phone_number,
    });
    return 'avisado';
}
