/**
 * whatsapp-formulario-servicio — formulario F2 «Inscripción a un servicio»
 * (clínica, vacacional, torneo) dentro de WhatsApp, fase F-a (sin endpoint).
 *
 * Plan: docs/specs/whatsapp-plan-v2-anuncios-campanas-formularios.md §3.2 y
 * docs/specs/whatsapp-flows-formularios.md §2. El JSON vive en
 * bff/whatsapp-flows/servicio_inscripcion.json (4 pantallas):
 *
 *   FICHA           servicio, cuándo, valor de hoy, valor de afiliado, abono,
 *                   qué incluye — TODO inyectado al enviar (`armarFormularioServicio`)
 *   DEPORTISTA      nombre completo, fecha de nacimiento (DatePicker), ¿ya entrena
 *                   en el club? y, si el servicio la pide, talla de camiseta
 *   CONSENTIMIENTO  «Acepto la política de tratamiento de datos» (obligatorio, con
 *                   «Leer más» → política unificada) y «Quiero recibir novedades»
 *   RESUMEN         el valor (de afiliado o no), completo o abono → `complete`
 *
 * Nada de números de documento (la Policy de WhatsApp lo prohíbe).
 *
 * Al recibir (`atenderRespuestaDeFormulario`): token firmado y vigente →
 * idempotencia por wa_message_id → consentimientos (+ opt-in con «novedades») →
 * lead del servicio con los datos → motivo esperado con el monto elegido → los
 * datos de pago por el chat. El precio se REVALIDA: si cambió entre el envío y la
 * respuesta se usa el vigente y se le dice; si el servicio ya no está, a una
 * persona. El motor no habla con Meta ni con la base: todo entra por el contexto.
 */

import { normalizarFrase } from './whatsapp-reglas-turno';
import { cop, cuandoEs } from './whatsapp-venta-servicios.service';
import { comoPagar, type CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import { abonoMinimo, opcionesDelItem, precioVigente } from './wa-cobro-desde-comprobante.service';
import {
    diaLegible, motivoDeServicio, precioDelServicio, servicioVigente, type ItemConFicha,
} from './whatsapp-anuncio-destino';
import { verificarTokenFormulario, type PreciosMostrados, type RespuestaDeFormulario } from './whatsapp-flows.service';
import type { Motivo } from './motivos-de-cobro';
import { claveDeContacto } from './whatsapp-usuario-meta';

// ─── Constantes ──────────────────────────────────────────────────────────────

export const FORMULARIO_SERVICIO = 'servicio_inscripcion';
export const PANTALLA_INICIAL_SERVICIO = 'FICHA';
/** Texto del botón del mensaje (≤ 30, sin emoji). */
export const CTA_FORMULARIO_SERVICIO = 'Inscribirme';
/** La política unificada de SportMaps (frontend /politica-de-privacidad, versión 2.3 del 29-oct-2026). */
export const URL_POLITICA_DATOS = 'https://app.sportmaps.co/politica-de-privacidad';
export const VERSION_POLITICA_DATOS = '2.3';
/** El texto del OptIn obligatorio, tal cual está en el JSON (prueba de qué aceptó). */
export const TEXTO_OPTIN_DATOS = 'Acepto la política de tratamiento de datos personales de SportMaps y de la escuela.';

export const PASO_FORMULARIO_ENVIADO = 'formulario_enviado';
export const PASO_FORMULARIO_RESPUESTA = 'formulario_respuesta';
export const PASO_FORMULARIO_RESPALDO = 'formulario_respaldo';

/** El texto del OptIn de novedades (≤ 120, lo que se le mostró). Pura. */
export function textoOptinNovedades(escuela: string | null | undefined): string {
    const t = `Quiero recibir novedades de ${String(escuela || 'la escuela').trim()} por WhatsApp.`;
    return Array.from(t).length <= 120 ? t : 'Quiero recibir novedades de la escuela por WhatsApp.';
}

/** Tallas si la escuela no fijó las suyas (`whatsapp_flows.config.tallas`). */
export const TALLAS_POR_DEFECTO: readonly string[] = Object.freeze([
    'Talla 8 (niños)', 'Talla 10 (niños)', 'Talla 12 (niños)', 'Talla 14 (niños)', 'Talla 16 (niños)',
    'XS', 'S', 'M', 'L', 'XL',
]);
const SIN_TALLA = 'na';
const MAX_TITULO_OPCION = 30;
const MAX_HEADING = 80;
const MAX_INCLUYE = 900;

const largo = (t: string) => Array.from(t).length;
const recortar = (t: string, max: number) => (largo(t) <= max ? t : `${Array.from(t).slice(0, max - 1).join('').trimEnd()}…`);
const capital = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

// ─── Lo que se inyecta al enviar (puro) ──────────────────────────────────────

/** ¿El servicio pide la talla de camiseta? `config.pedir_talla`: 'siempre' | 'nunca' | 'auto' (la descripción la nombra). Pura. */
export function pideTalla(item: Pick<ItemConFicha, 'description' | 'name'>, config: Record<string, unknown> = {}): boolean {
    if (config.pedir_talla === 'siempre') return true;
    if (config.pedir_talla === 'nunca') return false;
    const t = normalizarFrase(`${item.name ?? ''} ${item.description ?? ''}`);
    return /\b(camisetas?|camisas?|uniformes?|jersey|dotacion)\b/.test(t);
}

/** Las tallas de la escuela (`config.tallas`, 1–20 de ≤ 30) o las de siempre. Pura. */
export function tallasDe(config: Record<string, unknown> = {}): string[] {
    const crudas = Array.isArray(config.tallas) ? config.tallas : null;
    const limpias = crudas?.filter((t): t is string => typeof t === 'string').map((t) => t.trim())
        .filter((t) => t && largo(t) <= MAX_TITULO_OPCION);
    return limpias && limpias.length && limpias.length <= 20 && limpias.length === crudas!.length
        ? [...new Set(limpias)] : [...TALLAS_POR_DEFECTO];
}

export interface ArmadoFormularioServicio {
    /** `flow_action_payload.data` de la pantalla FICHA. */
    data: Record<string, unknown>;
    /** Lo que se le mostró (va en el token para revalidar al recibir). */
    precios: PreciosMostrados;
    /** Cuerpo del mensaje con el botón (WhatsApp, admite *negrita*). */
    cuerpo: string;
}

/**
 * Los datos de la ficha del formulario: el valor de HOY (y el tramo que sigue),
 * el de afiliado, el abono, cuándo, qué incluye y las tallas. null si el
 * servicio no se presta para el formulario (opciones por semana, sin precio):
 * sigue el chat. `hoy` = 'YYYY-MM-DD' (Bogotá). Pura.
 */
export function armarFormularioServicio(p: {
    item: ItemConFicha; escuela: string; hoy: string; config?: Record<string, unknown>;
}): ArmadoFormularioServicio | null {
    const { item, hoy } = p;
    const config = p.config ?? {};
    if (opcionesDelItem(item).length) return null;
    const lista = precioDelServicio(item, { afiliado: false, hoy });
    if (lista.hoy === null) return null;
    const afiliado = Number(item.precio_afiliado) > 0 ? precioVigente(item, { afiliado: true, hoy }) : null;
    const pct = lista.abono !== null ? lista.abonoPct : null;
    const abonoLista = pct !== null ? abonoMinimo(lista.hoy, pct) : null;
    const abonoAfiliado = pct !== null && afiliado !== null ? abonoMinimo(afiliado, pct) : null;

    const tramo = lista.siguiente
        ? ` (hasta el ${diaLegible(lista.siguiente.desde, 1)}; desde el ${diaLegible(lista.siguiente.desde)}, ${cop(lista.siguiente.precio)})`
        : '';
    const cuando = cuandoEs({ iniciaEn: item.starts_at ?? null, terminaEn: item.ends_at ?? null });
    const incluye = String(item.description ?? '').replace(/\s+/g, ' ').trim();
    const talla = pideTalla(item, config);
    const lineaAbono = (abono: number | null) => (abono !== null ? `\nAbono para separar el cupo: ${cop(abono)}` : '');
    const resumen = `Valor completo: ${cop(lista.hoy)}${lineaAbono(abonoLista)}`;

    const data: Record<string, unknown> = {
        servicio: recortar(item.name, MAX_HEADING),
        cuando: cuando ? capital(cuando) : '—',
        hay_cuando: Boolean(cuando),
        valor: `Valor hoy: ${cop(lista.hoy)}${tramo}`,
        valor_afiliado: afiliado !== null ? `Si ya entrena en el club: ${cop(afiliado)}` : '—',
        hay_afiliado: afiliado !== null,
        abono: abonoLista !== null
            ? `Separas el cupo con un abono mínimo de ${cop(abonoLista)} (${pct} %)${abonoAfiliado !== null ? `; ${cop(abonoAfiliado)} si ya entrena en el club` : ''}.`
            : '—',
        hay_abono: abonoLista !== null,
        incluye: incluye ? recortar(incluye, MAX_INCLUYE) : '—',
        hay_incluye: Boolean(incluye),
        fecha_max: hoy,
        pide_talla: talla,
        tallas: talla ? tallasDe(config).map((t) => ({ id: t, title: t })) : [{ id: SIN_TALLA, title: 'No aplica' }],
        label_novedades: textoOptinNovedades(p.escuela),
        resumen_valores: resumen,
        resumen_valores_afiliado: afiliado !== null ? `Valor de afiliado: ${cop(afiliado)}${lineaAbono(abonoAfiliado)}` : resumen,
    };
    return {
        data,
        precios: { lista: lista.hoy, afiliado, abonoPct: pct },
        cuerpo: `¿Quieres dejar listo el cupo en *${item.name}*? Toca *${CTA_FORMULARIO_SERVICIO}*, llena los datos del deportista `
            + '(toma un minuto) y te confirmo el valor exacto a pagar.',
    };
}

/** Lo que sale por el chat si el formulario no abre (error al enviar o 131026). Pura. */
export function textoRespaldoFormulario(conCuentas: boolean): string {
    return conCuentas
        ? 'No pude abrirte el formulario en este WhatsApp 🙏 Sigamos por aquí: transfiere con los datos que te envié '
            + 'y mándame la foto o el PDF del comprobante.'
        : 'No pude abrirte el formulario en este WhatsApp 🙏 La escuela te escribe por aquí para terminar la inscripción.';
}

// ─── Lo que llegó (puro) ─────────────────────────────────────────────────────

export interface DatosDelFormulario {
    deportista: string | null;
    /** 'YYYY-MM-DD'; null si no llegó o no es una fecha posible. */
    fechaNacimiento: string | null;
    /** Lo que dijo: 'si' | 'no' | null. */
    afiliado: 'si' | 'no' | null;
    talla: string | null;
    aceptaDatos: boolean;
    aceptaNovedades: boolean;
    formaPago: 'completo' | 'abono';
}

const verdadero = (v: unknown) => v === true || v === 'true';

/** Una fecha de nacimiento posible ('YYYY-MM-DD' o, de clientes viejos, milisegundos). Pura. */
export function fechaDeNacimiento(v: unknown, hoy: string): string | null {
    let ymd: string | null = null;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) ymd = v.trim();
    else if ((typeof v === 'string' && /^\d{11,14}$/.test(v.trim())) || typeof v === 'number') {
        const ms = Number(v);
        if (Number.isFinite(ms)) ymd = new Date(ms - 5 * 3600_000).toISOString().slice(0, 10);
    }
    if (!ymd) return null;
    const [y, m, d] = ymd.split('-').map(Number);
    const f = new Date(Date.UTC(y, m - 1, d));
    if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
    return y >= 1900 && ymd <= hoy ? ymd : null;
}

/** El response_json → datos limpios. Pura. */
export function leerRespuestaServicio(datos: Record<string, unknown>, hoy: string): DatosDelFormulario {
    const nombre = typeof datos.nombre_deportista === 'string'
        ? datos.nombre_deportista.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const talla = typeof datos.talla === 'string' ? datos.talla.trim().slice(0, MAX_TITULO_OPCION) : '';
    const afiliado = datos.afiliado === 'si' || datos.afiliado === 'no' ? datos.afiliado : null;
    return {
        deportista: /\p{L}.*\p{L}/u.test(nombre) ? nombre : null,
        fechaNacimiento: fechaDeNacimiento(datos.fecha_nacimiento, hoy),
        afiliado,
        talla: talla && talla !== SIN_TALLA ? talla : null,
        aceptaDatos: verdadero(datos.acepta_datos),
        aceptaNovedades: verdadero(datos.acepta_novedades),
        formaPago: datos.forma_pago === 'abono' ? 'abono' : 'completo',
    };
}

/** Sin consentimiento de datos: lo que se guarda de la respuesta (nada personal). Pura. */
export function sinDatosPersonales(datos: Record<string, unknown>): Record<string, unknown> {
    const quedan = ['formulario', 'acepta_datos', 'acepta_novedades', 'forma_pago'];
    return Object.fromEntries(Object.entries(datos).filter(([k]) => quedan.includes(k)));
}

// ─── Cuánto paga (puro) ──────────────────────────────────────────────────────

export interface Cobro {
    /** Valor completo que le corresponde hoy. */
    precio: number;
    /** El abono, si eligió abono y el servicio lo permite. */
    abono: number | null;
    /** Lo que paga ahora (= abono o precio). */
    monto: number;
    pct: number | null;
    deAfiliado: boolean;
    /** Lo que le habría tocado pagar ahora con los precios que vio en el formulario. */
    montoMostrado: number | null;
}

/** Lo que paga ahora con los precios vigentes y lo que vio en el formulario. null = sin precio. Pura. */
export function cobroDelFormulario(
    item: ItemConFicha, d: Pick<DatosDelFormulario, 'formaPago'>, o: { deAfiliado: boolean; hoy: string; mostrados: PreciosMostrados | null },
): Cobro | null {
    const precio = precioVigente(item, { afiliado: o.deAfiliado, hoy: o.hoy });
    if (precio === null) return null;
    const permiteAbono = item.allow_installments === true;
    const pct = permiteAbono && Number.isFinite(Number(item.abono_minimo_pct)) ? Number(item.abono_minimo_pct) : null;
    const abonoCalc = d.formaPago === 'abono' && pct !== null ? abonoMinimo(precio, pct) : null;
    const abono = abonoCalc !== null && abonoCalc < precio ? abonoCalc : null;
    const m = o.mostrados;
    const precioVisto = m ? (o.deAfiliado && m.afiliado !== null ? m.afiliado : m.lista) : null;
    const montoMostrado = precioVisto === null ? null
        : abono !== null ? abonoMinimo(precioVisto, m?.abonoPct ?? pct) ?? precioVisto : precioVisto;
    return { precio, abono, monto: abono ?? precio, pct: abono !== null ? pct : null, deAfiliado: o.deAfiliado, montoMostrado };
}

// ─── Textos (puros) ──────────────────────────────────────────────────────────

/** La confirmación con lo que paga y cómo. Todo sale de la base; nunca «gratis». Pura. */
export function textoConfirmacion(p: {
    deportista: string; servicio: string; cobro: Cobro; talla: string | null;
    afiliadoSinVerificar: boolean; cuentas: CuentaDePagoEmbudo[];
}): string {
    const c = p.cobro;
    const cabeza = [`¡Listo! Recibí la inscripción de *${p.deportista}* a *${p.servicio}* ✅`,
        p.talla ? `Talla de camiseta: ${p.talla}` : null].filter(Boolean).join('\n');
    const valor: string[] = [];
    if (c.abono !== null) {
        valor.push(`Valor${c.deAfiliado ? ' de afiliado' : ''}: ${cop(c.precio)}`);
        valor.push(`Pagas ahora el abono para separar el cupo: *${cop(c.abono)}*${c.pct ? ` (${c.pct} %)` : ''}; `
            + `quedan ${cop(c.precio - c.abono)} pendientes.`);
    } else {
        valor.push(`Valor a pagar${c.deAfiliado ? ' (afiliado)' : ''}: *${cop(c.precio)}*`);
    }
    if (c.montoMostrado !== null && Math.abs(c.montoMostrado - c.monto) >= 1) {
        valor.push(`El valor cambió desde que te envié el formulario: antes era ${cop(c.montoMostrado)} y hoy es *${cop(c.monto)}*.`);
    }
    if (p.afiliadoSinVerificar) valor.push('Tomé el valor de afiliado: la escuela confirma que el deportista ya entrena en el club.');
    const como = p.cuentas.length ? comoPagar(p.cuentas) : null;
    const pago = como
        ? `Para pagar, transfiere ${como}${como.endsWith('\n') ? '\n' : ' '}y envíame aquí mismo la foto o el PDF del comprobante 📸`
        : 'La escuela te escribe por aquí con los datos de pago.';
    return [cabeza, valor.join('\n'), pago].join('\n\n');
}

export function textoSinConsentimiento(reenviado: boolean): string {
    return 'Para inscribir al deportista necesito que aceptes la política de tratamiento de datos 🙏 No guardé los datos del formulario.'
        + (reenviado ? ' Te lo dejo otra vez: marca la casilla y envíalo.' : ' Escríbeme por aquí y alguien de la escuela te ayuda.');
}

export function textoTokenNoValido(vencido: boolean): string {
    return vencido
        ? 'Este formulario ya venció 🙏 Ya le pasé tu mensaje a la escuela y alguien te responde por aquí para terminar la inscripción.'
        : 'No pude validar este formulario 🙏 Ya le pasé tu mensaje a la escuela y alguien te responde por aquí.';
}

export function textoServicioCerrado(nombre: string | null): string {
    return `La inscripción a ${nombre ? `*${nombre}*` : 'ese servicio'} ya no está abierta por aquí. `
        + 'Ya le pasé tus datos a la escuela y alguien te responde 🙌';
}

export function textoSinNombre(): string {
    return 'Recibí el formulario, pero no me llegó el nombre del deportista 🙏 Ya le pasé tu mensaje a la escuela y alguien te responde por aquí.';
}

// ─── El motor de la respuesta ────────────────────────────────────────────────

export type ResultadoFormulario =
    | 'procesada' | 'procesada_precio_nuevo' | 'servicio_inactivo' | 'sin_consentimiento'
    | 'token_invalido' | 'token_vencido' | 'duplicada' | 'error';

export interface ConsentimientoNuevo {
    tipo: 'datos' | 'novedades';
    aceptado: boolean;
    texto: string;
    versionPolitica: string;
}

export interface LeadDeFormulario {
    servicio: { id: string; nombre: string; tipo: string } | null;
    deportista: string;
    fechaNacimiento: string | null;
    formulario: Record<string, unknown>;
}

export interface CtxRespuestaFormulario {
    schoolId: string;
    /** Nombre de la escuela (el texto del OptIn de novedades que se le mostró). */
    escuela?: string | null;
    contactWaId: string;
    conversationId: string | null;
    /**
     * Reserva la respuesta (idempotencia por wa_message_id). 'nueva' con su id;
     * 'duplicada' = ya se atendió; 'sin_registro' = no se pudo guardar (tabla sin
     * migrar, simulación): se sigue igual (la ingesta ya deduplica el mensaje).
     */
    guardarRespuesta: (r: {
        formulario: string | null; tokenId: string | null; servicioId: string | null;
        responseJson: Record<string, unknown>;
    }) => Promise<{ estado: 'nueva' | 'duplicada' | 'sin_registro'; id: string | null }>;
    cerrarRespuesta: (id: string | null, resultado: Exclude<ResultadoFormulario, 'duplicada'>, detalle: Record<string, unknown>) => Promise<void>;
    /** El ítem del catálogo por id (activo o no); null si no existe. */
    servicio: (id: string) => Promise<ItemConFicha | null>;
    /** ¿El número es de una familia del club? (precio de afiliado). */
    afiliado: () => Promise<boolean>;
    cuentas: (motivo: Motivo) => Promise<CuentaDePagoEmbudo[]>;
    guardarConsentimientos: (c: ConsentimientoNuevo[], fuenteId: string | null) => Promise<boolean>;
    /** Opt-in de marketing (`wa_register_optin`, source formulario_wa). */
    registrarOptin: (fuenteId: string | null) => Promise<boolean>;
    guardarLead: (l: LeadDeFormulario) => Promise<string | null>;
    registrarEsperado: (e: { motivo: Motivo; leadId: string | null; monto: number }) => Promise<boolean>;
    enviar: (texto: string, contexto: Record<string, unknown>) => Promise<void>;
    /** Vuelve a mandar el formulario (sin consentimiento). false = no se pudo. */
    reenviarFormulario?: (servicioId: string | null) => Promise<boolean>;
    avisarEscuela: (detalle: string) => Promise<void>;
    ahora?: () => Date;
}

const hoyDe = (d: Date) => new Date(d.getTime() - 5 * 3600_000).toISOString().slice(0, 10);

/**
 * Atiende un formulario terminado. Cada camino manda UN mensaje (nunca
 * silencio), salvo la respuesta duplicada (ya se contestó). Nunca lanza.
 */
export async function atenderRespuestaDeFormulario(
    ctx: CtxRespuestaFormulario, r: RespuestaDeFormulario,
): Promise<ResultadoFormulario> {
    const ahora = (ctx.ahora ?? (() => new Date()))();
    const hoy = hoyDe(ahora);
    const base = { step: PASO_FORMULARIO_RESPUESTA, formulario: FORMULARIO_SERVICIO };
    let respuestaId: string | null = null;
    const cerrar = async (resultado: Exclude<ResultadoFormulario, 'duplicada'>, detalle: Record<string, unknown> = {}) => {
        await ctx.cerrarRespuesta(respuestaId, resultado, detalle).catch(() => undefined);
        return resultado;
    };
    try {
        const v = verificarTokenFormulario(r.token, { ahora: ahora.getTime() });
        // El token tiene que ser de ESTA escuela, ESTE contacto y (si la trae) ESTA conversación.
        const ajeno = v.ok && (v.token.schoolId !== ctx.schoolId
            || v.token.contactWaId !== claveDeContacto(ctx.contactWaId)
            || (v.token.conversationId !== null && ctx.conversationId !== null && v.token.conversationId !== ctx.conversationId));
        const tk = v.ok ? v.token : null;
        const datos = leerRespuestaServicio(r.datos, hoy);
        const conDatos = tk && !ajeno && datos.aceptaDatos;

        const reserva = await ctx.guardarRespuesta({
            formulario: tk?.formulario ?? (v.ok ? null : v.token?.formulario ?? null),
            tokenId: tk?.id ?? null,
            servicioId: tk?.servicioId ?? null,
            // Sin token válido o sin consentimiento, no se guarda nada personal.
            responseJson: conDatos ? r.datos : sinDatosPersonales(r.datos),
        }).catch(() => ({ estado: 'sin_registro' as const, id: null }));
        if (reserva.estado === 'duplicada') return 'duplicada';
        respuestaId = reserva.id;

        if (!v.ok || ajeno || !r.legible) {
            const vencido = !v.ok && v.motivo === 'vencido';
            await ctx.enviar(textoTokenNoValido(vencido), { ...base, resultado: vencido ? 'token_vencido' : 'token_invalido' });
            await ctx.avisarEscuela(vencido
                ? 'Mandó un formulario de inscripción que ya había vencido (72 h): escríbele para terminar la inscripción.'
                : 'Llegó un formulario de inscripción que no se pudo validar: revisa la conversación.');
            return cerrar(vencido ? 'token_vencido' : 'token_invalido', { motivo: v.ok ? (ajeno ? 'ajeno' : 'ilegible') : v.motivo });
        }
        const token = v.token;
        if (token.formulario !== FORMULARIO_SERVICIO) {
            await ctx.enviar(textoTokenNoValido(false), { ...base, resultado: 'error' });
            await ctx.avisarEscuela(`Llegó un formulario «${token.formulario}» que el bot todavía no sabe atender: revisa la conversación.`);
            return cerrar('error', { motivo: 'formulario_desconocido' });
        }

        if (!datos.aceptaDatos) {
            // El JSON exige la casilla (OptIn required): esto es defensa. Nada personal queda guardado.
            const reenviado = ctx.reenviarFormulario ? await ctx.reenviarFormulario(token.servicioId).catch(() => false) : false;
            if (!reenviado) await ctx.avisarEscuela('Llenó el formulario de inscripción sin aceptar el tratamiento de datos: escríbele.');
            await ctx.enviar(textoSinConsentimiento(reenviado), { ...base, resultado: 'sin_consentimiento' });
            return cerrar('sin_consentimiento', { reenviado });
        }
        if (!datos.deportista) {
            await ctx.enviar(textoSinNombre(), { ...base, resultado: 'error' });
            await ctx.avisarEscuela('Llegó un formulario de inscripción sin el nombre del deportista: escríbele.');
            return cerrar('error', { motivo: 'sin_nombre' });
        }

        await ctx.guardarConsentimientos([
            { tipo: 'datos', aceptado: true, texto: TEXTO_OPTIN_DATOS, versionPolitica: VERSION_POLITICA_DATOS },
            { tipo: 'novedades', aceptado: datos.aceptaNovedades, texto: textoOptinNovedades(ctx.escuela), versionPolitica: VERSION_POLITICA_DATOS },
        ], respuestaId).catch(() => false);
        const optin = datos.aceptaNovedades ? await ctx.registrarOptin(respuestaId).catch(() => false) : false;

        const formulario = {
            nombre: FORMULARIO_SERVICIO, respuesta_id: respuestaId, token_id: token.id,
            afiliado_declarado: datos.afiliado === 'si', talla: datos.talla, forma_pago: datos.formaPago,
            novedades: datos.aceptaNovedades,
        };
        const item = token.servicioId ? await ctx.servicio(token.servicioId).catch(() => null) : null;
        if (!item || !servicioVigente(item, ahora.getTime())) {
            await ctx.guardarLead({ servicio: item ? servicioDelLead(item) : null, deportista: datos.deportista, fechaNacimiento: datos.fechaNacimiento, formulario })
                .catch(() => null);
            await ctx.enviar(textoServicioCerrado(item?.name ?? null), { ...base, resultado: 'servicio_inactivo', servicio_id: token.servicioId });
            await ctx.avisarEscuela(`Llenó el formulario de inscripción a «${item?.name ?? 'un servicio'}», que ya no está activo, `
                + `para ${datos.deportista}: escríbele.`);
            return cerrar('servicio_inactivo', { servicio_id: token.servicioId, optin });
        }

        // Afiliado: el que dice que entrena en el club o el que el número confirma.
        const tieneAfiliado = Number(item.precio_afiliado) > 0;
        const verificado = tieneAfiliado ? await ctx.afiliado().catch(() => false) : false;
        const deAfiliado = tieneAfiliado && (verificado || datos.afiliado === 'si');
        const cobro = cobroDelFormulario(item, datos, { deAfiliado, hoy, mostrados: token.precios });
        const motivo = motivoDeServicio(item);
        const leadId = await ctx.guardarLead({
            servicio: servicioDelLead(item), deportista: datos.deportista, fechaNacimiento: datos.fechaNacimiento,
            formulario: { ...formulario, ...(cobro ? { monto: cobro.monto, precio: cobro.precio } : {}) },
        }).catch(() => null);
        if (!cobro) {
            await ctx.enviar(`¡Gracias! Recibí la inscripción de *${datos.deportista}* a *${item.name}*. El valor te lo confirma la escuela por aquí 🙌`,
                { ...base, resultado: 'error', servicio_id: item.id });
            await ctx.avisarEscuela(`Llenó el formulario de «${item.name}», que no tiene precio cargado: escríbele con el valor y los datos de pago.`);
            return cerrar('error', { motivo: 'sin_precio', lead_id: leadId });
        }
        const registrado = await ctx.registrarEsperado({ motivo, leadId, monto: cobro.monto }).catch(() => false);
        const cuentas = await ctx.cuentas(motivo).catch(() => [] as CuentaDePagoEmbudo[]);
        const afiliadoSinVerificar = deAfiliado && !verificado;
        const cambio = cobro.montoMostrado !== null && Math.abs(cobro.montoMostrado - cobro.monto) >= 1;
        await ctx.enviar(textoConfirmacion({
            deportista: datos.deportista, servicio: item.name, cobro, talla: datos.talla, afiliadoSinVerificar, cuentas,
        }), {
            ...base,
            resultado: cambio ? 'procesada_precio_nuevo' : 'procesada',
            servicio_id: item.id,
            monto: cobro.monto,
            forma_pago: cobro.abono !== null ? 'abono' : 'completo',
            ...(cobro.deAfiliado ? { afiliado: true } : {}),
            motivo_esperado: { motivo, monto: cobro.monto, registrado },
            ...(cuentas.length ? {} : { sin_cuentas: true }),
        });
        if (!cuentas.length) await ctx.avisarEscuela(`Se inscribió a «${item.name}» por el formulario y la escuela no tiene cuentas de pago cargadas: escríbele con los datos de pago.`);
        else if (afiliadoSinVerificar) {
            await ctx.avisarEscuela(`Se inscribió a «${item.name}» con el valor de afiliado (${cop(cobro.precio)}) diciendo que ${datos.deportista} ya entrena en el club: confírmalo.`);
        }
        return cerrar(cambio ? 'procesada_precio_nuevo' : 'procesada', {
            servicio_id: item.id, lead_id: leadId, monto: cobro.monto, precio: cobro.precio, abono: cobro.abono,
            de_afiliado: cobro.deAfiliado, afiliado_verificado: verificado, monto_mostrado: cobro.montoMostrado,
            esperado_registrado: registrado, optin, sin_cuentas: !cuentas.length,
        });
    } catch (e: any) {
        console.warn('[wa-formulario] la respuesta falló', { err: e?.message });
        await ctx.enviar(textoTokenNoValido(false), { ...base, resultado: 'error' }).catch(() => undefined);
        await ctx.avisarEscuela('Llegó un formulario de inscripción y no se pudo procesar: revisa la conversación.').catch(() => undefined);
        return cerrar('error', { motivo: 'excepcion', err: String(e?.message ?? e).slice(0, 200) });
    }
}

function servicioDelLead(item: ItemConFicha): LeadDeFormulario['servicio'] {
    return { id: item.id, nombre: item.name, tipo: String(item.kind) };
}
