/**
 * whatsapp-pago-publico — «¿Cómo / dónde / cuándo pago?» sin pedir identificación.
 *
 * Dynasty 2026-10-07 (…5281): una mamá escribía desde un número que no está en
 * ninguna ficha y preguntó «En que horario se puede ir a cancelar la
 * mensualidad» («cancelar» = PAGAR en Colombia), «Hay atención presencial en el
 * club mañana?». El bot le contestó «No reconozco este número…» y le pidió el
 * correo. La conversación terminó en «Yo así no pago sin informar nada».
 *
 * Los medios de pago y el horario de atención son información PÚBLICA de la
 * escuela (la misma que muestra /p/:token sin sesión). Solo lo que depende de la
 * cuenta —cuánto debo, mis cobros— exige identificarse.
 *
 * Todo lo de acá es PURO (reglas y armado de texto); la consulta y el envío
 * viven en whatsapp-bot.service (`responderComoPagarPublico`).
 */

import { normalizarFrase } from './whatsapp-reglas-turno';

export interface PreguntaDePago {
    /** Pregunta cómo/dónde/cuándo pagar (medios de pago). */
    pagar: boolean;
    /** Pregunta por la atención presencial (horario, ir a la sede u oficina). */
    presencial: boolean;
}

/** Lo que solo se contesta con la cuenta de la familia: no es «cómo pagar». */
const DE_SU_CUENTA = /\b(cuanto (debo|me falta|tengo pendiente|es lo que debo)|mis (pagos|cobros|deudas?)|estado de cuenta|paz y salvo|que debo|ya (pague|cancele|consigne|transferi))\b/;

/** «cancelar» es pagar SOLO con lo que se paga: «cancelar la clase» es otra cosa. */
const CANCELAR_PAGO = /\b(cancelar|cancelo|cancela|cancelamos|cancelaria)\b(\s+\w+){0,3}\s+(la |el |las |los )?(mensualidad(es)?|mes|meses|cuotas?|matricula|pension|inscripcion|valor|saldo|deuda|pagos?)\b/;
const VERBO_PAGAR = /\b(pagar|pago|pagos|pagarle|pagarles|consignar|consigno|consignacion|transferir|transfiero|transferencia|abonar|abono)\b/;
// «¿A qué número te consigno?» (Monster 2026-11-04, después de la ficha de la clínica): el
// número, el Nequi o la llave también son «a dónde», no solo la cuenta.
const COMO_O_DONDE = /\b(como|donde|cuando|por donde|en donde|a donde|a que cuenta|a cual cuenta|a que (numero|nequi|daviplata|llave)|a cual (numero|nequi|daviplata|llave)|que horario|en que horario|a que hora|hasta que hora|se puede|puedo|podemos|forma|formas|medios?|metodos?)\b/;
const DATOS_DE_PAGO = [
    /\b(medios|formas|metodos|opciones) de pago\b/,
    /\b(numero|datos) de (la )?cuenta\b/,
    /\bcuenta (para|donde|a la que) (pagar|consignar|transferir)\b/,
    /\bdatos (de|para) (pago|pagar|consignar|transferir|la transferencia)\b/,
    /\b(llave|bre ?b|nequi|daviplata)\b.*\b(para|de) (pagar|consignar|transferir)\b/,
    /\b(link|enlace) (de|para) (pago|pagar)\b/,
];

const PRESENCIAL: RegExp[] = [
    /\batencion (presencial|en (la )?(sede|oficina|club|escuela|coliseo))\b/,
    /\bhorarios? de (atencion|oficina)\b/,
    /\b(hay|tienen|habra) (atencion|alguien|oficina)\b/,
    /\batencion (hoy|manana|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/,
    /\b(atienden|abren|esta abierto|estan atendiendo)\b/,
    /\b(ir|pasar|acercarme|acercarse|acercarnos|llegar)\b(\s+\w+){0,4}\s+(al club|a la sede|a la oficina|al coliseo|a la escuela|a pagar|a cancelar|personalmente)\b/,
    /\b(en que horario|a que hora|hasta que hora|que horario)\b(\s+\w+){0,4}\s+(ir|pasar|atienden|abren|acercarme|acercarse)\b/,
];

/**
 * ¿Pregunta cómo / dónde / cuándo pagar, o por la atención presencial? Pura.
 * «Cuánto debo» o «mis cobros» NO cuentan: eso es de la cuenta y va por la
 * identificación.
 */
export function preguntaComoPagar(texto: string | null | undefined): PreguntaDePago {
    const t = normalizarFrase(texto);
    if (!t) return { pagar: false, presencial: false };
    const presencial = PRESENCIAL.some((re) => re.test(t));
    if (DE_SU_CUENTA.test(t)) return { pagar: false, presencial };
    const pagar = CANCELAR_PAGO.test(t) && (COMO_O_DONDE.test(t) || presencial || /\?/.test(String(texto)))
        || (VERBO_PAGAR.test(t) && COMO_O_DONDE.test(t) && !/\bcuanto\b/.test(t))
        || DATOS_DE_PAGO.some((re) => re.test(t));
    return { pagar, presencial };
}

/** school_settings.business_hours (mig. 20260914184316): [{day 0-6, closed, open, close}]. */
export interface FilaHorarioAtencion { day: number; closed?: boolean | null; open?: string | null; close?: string | null }

const DIA_CORTO = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0];

function horaLegible(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    if (!Number.isInteger(h)) return hhmm;
    const sufijo = h >= 12 ? 'p. m.' : 'a. m.';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m || 0).padStart(2, '0')} ${sufijo}`;
}

/**
 * «lun a vie 8:00 a. m. – 5:00 p. m.; sáb 8:00 a. m. – 12:00 p. m.», o null si
 * la escuela no lo configuró (NULL, vacío o todo cerrado). Nunca se inventa.
 */
export function textoHorarioPresencial(filas: unknown): string | null {
    if (!Array.isArray(filas)) return null;
    const porDia = new Map<number, string>();
    for (const f of filas as FilaHorarioAtencion[]) {
        if (!f || typeof f.day !== 'number' || f.closed || !f.open || !f.close) continue;
        porDia.set(f.day, `${horaLegible(f.open)} – ${horaLegible(f.close)}`);
    }
    if (!porDia.size) return null;
    const grupos: { desde: number; hasta: number; rango: string }[] = [];
    for (const d of ORDEN_SEMANA) {
        const rango = porDia.get(d);
        const ultimo = grupos[grupos.length - 1];
        if (!rango) { grupos.push({ desde: -1, hasta: -1, rango: '' }); continue; }
        if (ultimo && ultimo.rango === rango && ORDEN_SEMANA.indexOf(ultimo.hasta) === ORDEN_SEMANA.indexOf(d) - 1) {
            ultimo.hasta = d;
        } else {
            grupos.push({ desde: d, hasta: d, rango });
        }
    }
    return grupos.filter((g) => g.rango)
        .map((g) => `${DIA_CORTO[g.desde]}${g.hasta !== g.desde ? ` a ${DIA_CORTO[g.hasta]}` : ''} ${g.rango}`)
        .join('; ');
}

export interface DatosDePagoPublicos {
    cuentas: { tipo: string; titular: string | null; numero: string }[];
    /** Solo el link de pago PÚBLICO de la escuela (no /my-payments, que pide sesión). */
    linkDePago: string | null;
}

/** Máximo de caracteres de un mensaje del bot (auditoría 2026-10-07). */
export const MAX_CARACTERES_MENSAJE = 600;
const MAX_CUENTAS = 3;

/**
 * El mensaje de «cómo pagar» para cualquiera, sin datos de la familia. ≤ 600
 * caracteres y ≤ 3 emojis. `horario`: el texto de `textoHorarioPresencial`.
 * `preguntoPresencial` sin horario configurado → «te confirma la escuela» (no
 * se inventa), salvo `escalando` (lo dice el aviso de escalamiento).
 */
export function textoComoPagar(p: {
    pregunta: PreguntaDePago;
    datos: DatosDePagoPublicos;
    horario: string | null;
    escalando?: boolean;
}): string {
    const partes: string[] = [];
    if (p.pregunta.pagar || !p.pregunta.presencial) {
        const cuentas = p.datos.cuentas.slice(0, MAX_CUENTAS)
            .map((c) => `• *${c.tipo}*: ${c.numero}${c.titular ? ` (${c.titular})` : ''}`);
        // El link público de la escuela es el propio de ella: la familia escribe el
        // valor de su cobro, sin recargo. La transferencia directa tampoco lo lleva.
        if (p.datos.linkDePago) cuentas.push(`• En línea (escribes el valor de tu cobro): ${p.datos.linkDePago}`);
        if (cuentas.length) {
            partes.push(`Puedes pagar así (sin recargo):\n${cuentas.join('\n')}`);
            partes.push('Cuando pagues, mándame por aquí la foto del comprobante 📄 y lo aplico.');
        } else {
            partes.push('Los datos para pagar te los confirma la escuela por aquí.');
        }
    }
    if (p.horario) {
        partes.push(`🕘 Atención presencial: ${p.horario}.`);
    } else if (p.pregunta.presencial && !p.escalando) {
        partes.push('Sobre la atención presencial te confirma la escuela por aquí.');
    }
    let texto = partes.join('\n\n');
    if (texto.length > MAX_CARACTERES_MENSAJE) texto = texto.slice(0, MAX_CARACTERES_MENSAJE - 1).trimEnd() + '…';
    return texto;
}
