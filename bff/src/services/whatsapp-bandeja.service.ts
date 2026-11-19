/**
 * whatsapp-bandeja.service — la «Bandeja» de comprobantes de la pantalla de WhatsApp.
 *
 * La bandeja son las filas de `whatsapp_inbound_queue` en `failed | ignored |
 * waiting_user`. Hasta el 2026-10-07 se listaban todas juntas, con un contador
 * que sumaba fotos personales, capturas de correos y comprobantes que la
 * escuela ya había registrado (Dynasty: 113 filas, ~25 pedían algo de verdad,
 * y el listado cortaba en 100). Este módulo:
 *
 *  1. Clasifica cada fila en tres grupos: `accion` (la escuela tiene que
 *     decidir: varios cobros, monto distinto, número sin ficha…), `revisar`
 *     (puede ser plata, pero lo normal es que no) e `informativo` (no pide
 *     nada: no era comprobante, ya estaba registrado, contacto personal).
 *  2. Marca como cerradas por la escuela las filas que alguien resolvió o
 *     descartó. NO hay columna para eso (sin migración): se escribe un prefijo
 *     en `error_message` y se conserva el motivo original detrás de « | ».
 *     El status queda `ignored`, que es lo que ya significa «no lo procesó el
 *     bot»; ningún job reprocesa un `error_message` con este prefijo
 *     (ver `esRecuperable` en whatsapp-recuperacion.service).
 *  3. Cierra solas (sin tocar `payments`) las filas `ya_registrado` cuyo pago
 *     sigue registrado — eran ruido que la escuela no podía sacar de la lista.
 */

import { ETIQUETA_DE_MARCA, esContactoSinContenido, esMarcaNoFamilia, marcaPorNombre,
         type TipoMarcado } from './whatsapp-tipo-contacto';

/** Prefijo de `error_message` de las filas que cerró la escuela (o el barrido). */
export const PREFIJO_CERRADA = 'cerrado_escuela:';

/**
 * ¿La fila ya la cerró la escuela / el sistema (p. ej. pasó a «Por clasificar» en Cobros)? Una fila así puede seguir
 * en `waiting_user` (la RPC `wa_crear_comprobante_por_clasificar` solo le antepone el prefijo), pero YA NO espera a
 * la familia: contestarle no puede aplicar el pago, porque la escuela lo decide desde Cobros. Pura.
 */
export const esCerradaPorEscuela = (errorMessage: unknown): boolean =>
    typeof errorMessage === 'string' && errorMessage.startsWith(PREFIJO_CERRADA);

export const ESTADOS_BANDEJA = ['failed', 'ignored', 'waiting_user'] as const;

/** Estados de pago que cuentan como «ya está registrado». */
export const ESTADOS_PAGO_REGISTRADO = ['paid', 'awaiting_approval', 'approved', 'completed'] as const;

export type GrupoBandeja = 'accion' | 'revisar' | 'informativo';

export interface FilaCruda {
    id: string;
    status: string;
    error_message: string | null;
    result_type?: string | null;
    result_ref_id?: string | null;
    matched_child_id?: string | null;
}

export interface Clasificacion {
    grupo: GrupoBandeja;
    /** Código estable: varios_cobros, no_es_comprobante, contacto_no_atendido… */
    motivo: string;
    /** Lo que ve la escuela. */
    etiqueta: string;
    /** El detalle que dejó el bot (montos, cobros), sin el código. */
    detalle: string | null;
}

const ETIQUETAS: Record<string, string> = {
    varios_cobros: 'Hay varios cobros posibles',
    monto_distinto: 'El monto no coincide con el cobro',
    sin_familia: 'El número no está en ninguna ficha',
    familia_sin_cuenta: 'Familia sin cuenta en la app',
    numero_ambiguo: 'El número está en varias fichas',
    destino_ajeno: 'El dinero fue a una cuenta que no es de la escuela',
    otro_concepto: 'Es de otro concepto (uniforme, torneo…)',
    fallido: 'No se pudo procesar',
    pregunta_vencida: 'La familia no dijo a qué cobro va',
    sin_pendientes: 'La familia no tiene cobros pendientes',
    esperando_familia: 'Esperando respuesta de la familia',
    archivo_no_disponible: 'No se pudo descargar el archivo',
    bot_apagado: 'Llegó con el asistente apagado',
    contacto_no_atendido: 'Número que no es de una familia',
    no_es_comprobante: 'No era un comprobante',
    es_listado: 'Era un listado de movimientos',
    ya_registrado: 'El pago ya estaba registrado',
    enviado_por_equipo: 'Lo envió alguien del equipo',
    aviso_no_entregado: 'No se le pudo avisar a la familia',
    sin_integracion: 'El canal ya no existe',
    duplicado: 'Comprobante repetido (misma imagen)',
    fuera_de_sportmaps: 'Pago por fuera de SportMaps',
    // Venta de un servicio por WhatsApp (clínica, vacacional, torneo): el pago llegó y falta que la escuela lo registre.
    venta_servicio: 'Pago de un servicio por registrar',
    venta_faltan_datos: 'Pago de un servicio: faltan los datos de quien asiste',
    venta_incompleto: 'Pago de un servicio: captura sin fecha ni número',
    escuela_tomo: 'La escuela escribió en el chat: aplicarlo a mano',
    // Auditoría 1–16 nov 2026: 22 filas con plata caían en «Sin clasificar» / «revisar».
    sin_pendientes_con_pago: 'Pagó y no tiene cobros abiertos',
    saldo_de_parcial: 'Es el saldo de un cobro abonado',
    excedente_de_parcial: 'Pagó más que el saldo del cobro',
    prospecto_sin_concepto: 'Pago de un prospecto: falta saber de qué es',
    limite_ocr: 'No se leyó (tope de lecturas): revisarlo a mano',
    archivo_no_leido: 'No se pudo abrir el archivo (muy grande o formato raro)',
    torneo_o_club: 'Pago de torneo o de un club',
    pago_partido: 'Pago partido en varios comprobantes',
    monto_distinto_aplicado: 'Se aplicó, pero el monto no es el del cobro',
    reclamo_del_cliente: 'La familia corrigió o reclamó el resultado',
    motivo_esperado: 'Pago de un prospecto que no coincide con lo esperado',
    ocr_omitido: 'No se leyó: ráfaga de imágenes de un número sin ficha',
    otro: 'Sin clasificar',
};

const GRUPO_DE: Record<string, GrupoBandeja> = {
    varios_cobros: 'accion',
    monto_distinto: 'accion',
    sin_familia: 'accion',
    familia_sin_cuenta: 'accion',
    numero_ambiguo: 'accion',
    destino_ajeno: 'accion',
    otro_concepto: 'accion',
    fallido: 'accion',
    pregunta_vencida: 'accion',
    venta_servicio: 'accion',
    venta_faltan_datos: 'accion',
    venta_incompleto: 'accion',
    escuela_tomo: 'accion',
    // Hay plata por aplicar (auditoría 1–16 nov 2026).
    sin_pendientes_con_pago: 'accion',
    saldo_de_parcial: 'accion',
    excedente_de_parcial: 'accion',
    prospecto_sin_concepto: 'accion',
    limite_ocr: 'accion',
    archivo_no_leido: 'accion',
    torneo_o_club: 'accion',
    pago_partido: 'accion',
    monto_distinto_aplicado: 'accion',
    reclamo_del_cliente: 'accion',
    motivo_esperado: 'accion',
    ocr_omitido: 'revisar',
    sin_pendientes: 'revisar',
    esperando_familia: 'revisar',
    archivo_no_disponible: 'revisar',
    bot_apagado: 'revisar',
    contacto_no_atendido: 'revisar',
    otro: 'revisar',
    no_es_comprobante: 'informativo',
    es_listado: 'informativo',
    ya_registrado: 'informativo',
    enviado_por_equipo: 'informativo',
    aviso_no_entregado: 'informativo',
    sin_integracion: 'informativo',
    duplicado: 'informativo',
    // Cuenta que la escuela acepta por fuera de la app (Nequi de un entrenador
    // para torneos, 2026-10-13): no es plata perdida ni pide nada.
    fuera_de_sportmaps: 'informativo',
};

/**
 * `error_message` de la pregunta que se cerró porque una persona de la escuela escribió (lo escribe
 * whatsapp-respuesta-de-cobro: `MOTIVO_ESCUELA_TOMO`; acá va el texto para no importar ese servicio).
 */
export const MOTIVO_ESCUELA_TOMO_EN_BANDEJA = 'la escuela tomó la conversación';

/** Códigos que escribe la recuperación (`recuperado: <código> — <motivo>`). */
const ALIAS_RECUPERACION: Record<string, string> = {
    numero_ambiguo: 'numero_ambiguo',
};

/**
 * Prefijos de `error_message` que traen plata por aplicar y su motivo en la bandeja. El orden importa: gana el
 * primero. Los escriben whatsapp-queue.job, whatsapp-cobro-por-texto, wa-limite-comprobantes y
 * whatsapp-respuesta-de-cobro (los códigos viven en wa-cola-reglas; acá va el texto para no importar esos módulos).
 */
const PREFIJOS_CON_PLATA: [string, string][] = [
    ['reclamo_del_cliente', 'reclamo_del_cliente'],
    ['monto_distinto_aplicado', 'monto_distinto_aplicado'],
    ['abono_en_revision', 'monto_distinto_aplicado'],
    ['pago_partido', 'pago_partido'],
    ['torneo_o_club', 'torneo_o_club'],
    ['excedente_de_parcial', 'excedente_de_parcial'],
    ['saldo_de_parcial', 'saldo_de_parcial'],
    ['prospecto_sin_concepto', 'prospecto_sin_concepto'],
    ['prospecto_con_cantidad', 'prospecto_sin_concepto'],
    ['monto_con_cantidad', 'monto_distinto'],
    ['motivo_esperado_no_coincide', 'motivo_esperado'],
    ['motivo_esperado_sin_precio', 'motivo_esperado'],
    ['cobro_no_creado', 'motivo_esperado'],
    ['limite_ocr', 'limite_ocr'],
    ['ocr_omitido', 'ocr_omitido'],
];

/** El motivo «crudo» de la fila: código + detalle, sin mirar el contacto. */
export function motivoDeFila(fila: FilaCruda): { motivo: string; detalle: string | null } {
    const em = (fila.error_message ?? '').trim();

    if (em.startsWith('recuperado:')) {
        const resto = em.slice('recuperado:'.length).trim();
        const [codigo, ...det] = resto.split(' — ');
        const c = ALIAS_RECUPERACION[codigo.trim()] ?? codigo.trim();
        return { motivo: c in GRUPO_DE ? c : 'otro', detalle: det.join(' — ').trim() || null };
    }
    if (em.includes('aviso_no_entregado')) return { motivo: 'aviso_no_entregado', detalle: em };
    if (em.startsWith('otro_concepto')) return { motivo: 'otro_concepto', detalle: em.replace(/^otro_concepto:\s*/, '') || null };
    if (em.startsWith('pregunta_vencida')) return { motivo: 'pregunta_vencida', detalle: em.replace(/^pregunta_vencida:\s*/, '') || null };
    if (em.startsWith('referencia ya usada')) return { motivo: 'ya_registrado', detalle: em };
    // Códigos que escribe el worker con «código: detalle» (medido en Dynasty
    // 2026-10-13: 6 «monto_no_cuadra» y 2 «sin_familia:» caían en «Sin clasificar»).
    if (em.startsWith('monto_no_cuadra')) return { motivo: 'monto_distinto', detalle: em.replace(/^monto_no_cuadra:\s*/, '') || null };
    if (em.startsWith('sin_familia:')) return { motivo: 'sin_familia', detalle: em.replace(/^sin_familia:\s*/, '') || null };
    if (em.startsWith('comprobante ya recibido')) return { motivo: 'duplicado', detalle: null };
    // ── Códigos con plata que caían en «Sin clasificar» (auditoría 1–16 nov 2026, 22 filas) ──
    // El reclamo del cliente va primero: conserva detrás lo que la fila decía antes.
    for (const [prefijo, motivo] of PREFIJOS_CON_PLATA) {
        if (em.startsWith(prefijo)) return { motivo, detalle: em.slice(prefijo.length).replace(/^[:\s]+/, '') || null };
    }
    // «sin_pendientes: …» (la familia eligió el mes, o pagó y no tiene cobros abiertos): antes solo se reconocía
    // el texto exacto «sin pagos pendientes». Trae monto y propuesta: es acción.
    if (em.startsWith('sin_pendientes:')) return { motivo: 'sin_pendientes_con_pago', detalle: em.replace(/^sin_pendientes:\s*/, '') || null };
    if (em.startsWith('familia_sin_cuenta:')) return { motivo: 'familia_sin_cuenta', detalle: em.replace(/^familia_sin_cuenta:\s*/, '') || null };
    // «ya registrado: <concepto>» (lo escribe el worker con `result_ref_id`): informativo, y el barrido lo cierra solo.
    if (em.startsWith('ya registrado:')) return { motivo: 'ya_registrado', detalle: em.replace(/^ya registrado:\s*/, '') || null };
    if (em.startsWith('numero_sin_verificar: comprobante repetido')) return { motivo: 'duplicado', detalle: em };
    if (em.startsWith('varios_cobros:')) return { motivo: 'varios_cobros', detalle: em.replace(/^varios_cobros:\s*/, '') || null };
    if (/^(archivo_muy_grande|mime_no_soportado)\b/.test(em)) return { motivo: 'archivo_no_leido', detalle: em };
    // Venta de un servicio (2026-11-16): los `venta_*` caían en «Sin clasificar» y nadie los veía como pendientes.
    // Un comprobante repetido no pide nada; los demás son plata recibida que falta registrar.
    if (em.startsWith('venta_comprobante_repetido')) return { motivo: 'duplicado', detalle: em.replace(/^venta_comprobante_repetido:\s*/, '') || null };
    const venta = /^(venta_[a-z_]+):\s*/.exec(em);
    if (venta) {
        const motivo = venta[1] === 'venta_comprobante_incompleto' ? 'venta_incompleto'
            : venta[1] === 'venta_falta_nombre' ? 'venta_faltan_datos' : 'venta_servicio';
        return { motivo, detalle: em.slice(venta[0].length) || null };
    }
    // La escuela escribió mientras el asistente esperaba una respuesta: el comprobante quedó guardado sin aplicar.
    if (em === MOTIVO_ESCUELA_TOMO_EN_BANDEJA) return { motivo: 'escuela_tomo', detalle: em };
    if (em.startsWith('consulta_no_comprobante')
        || ['no es un comprobante', 'no_es_comprobante_sin_contexto', 'ni comprobante ni matrícula'].includes(em)) {
        return { motivo: 'no_es_comprobante', detalle: null };
    }
    if (em === 'listado de movimientos') return { motivo: 'es_listado', detalle: null };
    if (em === 'contacto_no_atendido') return { motivo: 'contacto_no_atendido', detalle: null };
    if (em === 'bot_apagado') return { motivo: 'bot_apagado', detalle: null };
    if (em === 'familia_sin_cuenta') return { motivo: 'familia_sin_cuenta', detalle: null };
    if (em === 'sin pagos pendientes') return { motivo: 'sin_pendientes', detalle: null };
    if (em === 'destino no es de la escuela') return { motivo: 'destino_ajeno', detalle: null };
    if (em === 'pago por fuera de SportMaps') return { motivo: 'fuera_de_sportmaps', detalle: null };
    if (em.startsWith('admin no acudiente')) return { motivo: 'enviado_por_equipo', detalle: null };
    if (em === 'la integración ya no existe') return { motivo: 'sin_integracion', detalle: null };

    if (fila.status === 'waiting_user') return { motivo: 'esperando_familia', detalle: em || null };
    if (fila.status === 'failed') return { motivo: 'fallido', detalle: em || null };
    return { motivo: 'otro', detalle: em || null };
}

/**
 * Motivos que hablan de un COBRO concreto (hay monto y un atleta o una familia
 * detrás). Con «también es familia» estas filas se quedan: pueden ser el pago
 * del hijo. El resto (fotos, capturas, contacto no atendido) no.
 */
const MOTIVOS_DE_COBRO = new Set([
    'varios_cobros', 'monto_distinto', 'familia_sin_cuenta', 'numero_ambiguo', 'destino_ajeno',
    'otro_concepto', 'pregunta_vencida', 'esperando_familia',
    'venta_servicio', 'venta_faltan_datos', 'venta_incompleto', 'escuela_tomo',
    'sin_pendientes_con_pago', 'saldo_de_parcial', 'excedente_de_parcial', 'pago_partido', 'monto_distinto_aplicado',
    'reclamo_del_cliente',
]);

/** ¿La fila es (o puede ser) el pago de un hijo? Pura. */
export function filaConPagoDeFamilia(fila: FilaCruda): boolean {
    return !!fila.matched_child_id || MOTIVOS_DE_COBRO.has(motivoDeFila(fila).motivo);
}

/**
 * ¿La fila entra en la bandeja (lista y contadores)? Las de un contacto que la
 * escuela marcó como no-familia (personal, negocio, otro club, plataforma) NO:
 * marcar es decir «esto no es de la escuela». Con «también es familia» sí
 * entran, y `clasificarFila` decide el grupo.
 */
export function filaCuentaEnBandeja(
    tipoContacto?: string | null, tambienFamilia?: boolean | null, errorMessage?: string | null,
): boolean {
    // Un pago REAL guardado de un contacto que el asistente no atiende (el worker
    // lo cierra `sin_familia: contacto_no_atendido (tipo): comprobante de $X a una
    // cuenta de la escuela`, con quién pagó) NO se oculta aunque el contacto sea
    // personal/negocio/otro club: es plata que llegó a la escuela y alguien tiene
    // que mirarla (conversación v2 §3.4). Las fotos sin pago siguen escondidas.
    if (typeof errorMessage === 'string' && errorMessage.startsWith(PREFIJO_PAGO_DE_CONTACTO_NO_ATENDIDO)) return true;
    return !esContactoSinContenido(tipoContacto, tambienFamilia);
}

/** Prefijo del `error_message` de un comprobante real de un contacto no atendido (lo escribe whatsapp-queue.job). */
export const PREFIJO_PAGO_DE_CONTACTO_NO_ATENDIDO = 'sin_familia: contacto_no_atendido';

/**
 * Grupo final de la fila. `tipoContacto` es `whatsapp_conversations.contact_kind`
 * (null si no se sabe): lo que manda un contacto personal o del equipo baja un
 * escalón — en Dynasty eran la familia de la dueña y transferencias internas.
 *
 * Con una marca manual y «también es familia» (el esposo de la dueña que es
 * papá de una atleta): lo que habla de un cobro conserva su grupo; lo demás
 * (sus fotos personales) es informativo, nunca «revisar».
 */
export function clasificarFila(fila: FilaCruda, tipoContacto?: string | null, tambienFamilia?: boolean | null): Clasificacion {
    const { motivo, detalle } = motivoDeFila(fila);
    let grupo = GRUPO_DE[motivo] ?? 'revisar';
    if (esMarcaNoFamilia(tipoContacto) && tambienFamilia === true) {
        if (!filaConPagoDeFamilia(fila)) grupo = 'informativo';
    } else if (esMarcaNoFamilia(tipoContacto) || tipoContacto === 'staff') {
        if (grupo === 'accion') grupo = 'revisar';
        else if (motivo === 'contacto_no_atendido') grupo = 'informativo';
    }
    return { grupo, motivo, etiqueta: ETIQUETAS[motivo] ?? ETIQUETAS.otro, detalle };
}

/**
 * Filas abiertas que se cierran al marcar un contacto como no-familia. Pura.
 * Con «también es familia» se quedan las que pueden ser el pago de un hijo.
 */
export function filasParaCierrePorMarca<T extends FilaCruda>(filas: T[], tambienFamilia: boolean): T[] {
    return filas.filter((f) => (ESTADOS_BANDEJA as readonly string[]).includes(f.status)
        && !estaCerrada(f.error_message)
        && !(tambienFamilia && filaConPagoDeFamilia(f)));
}

/** El motivo del cierre en lote al marcar: «contacto marcado como negocio». */
export function motivoDeCierrePorMarca(tipo: TipoMarcado): string {
    return `contacto marcado como ${ETIQUETA_DE_MARCA[tipo]}`;
}

// ─── Sugerencias de marca (2026-10-13) ───────────────────────────────────────
//
// Dynasty: un proveedor mayorista mandó 37 fotos de catálogo en 13 horas y
// todas quedaron en «revisar». La bandeja SUGIERE marcar (nunca marca sola) un
// número que nunca estuvo en una ficha y:
//   · mandó más de UMBRAL_RAFAGA adjuntos en 24 h, o
//   · su nombre (o el pie de sus adjuntos) suena a negocio, club o plataforma.
// No se mira el tono de la conversación (privacidad): solo volumen y nombre.

/** Más de esto en 24 h es una ráfaga. */
export const UMBRAL_RAFAGA = 5;
const VENTANA_RAFAGA_MS = 24 * 3_600_000;

export interface FilaParaSugerir {
    wa_phone_number?: string | null;
    created_at?: string | null;
    media_caption?: string | null;
}

export interface ConversacionParaSugerir {
    id: string;
    contact_name: string | null;
    contact_kind: string | null;
    identified?: boolean | null;
    parent_id?: string | null;
}

export interface SugerenciaDeMarca {
    wa_phone_number: string;
    conversacion_id: string | null;
    contacto: string | null;
    motivo: 'rafaga' | 'nombre';
    /** El máximo de adjuntos abiertos en una ventana de 24 h. */
    adjuntos_24h: number;
    filas: number;
    tipo_sugerido: TipoMarcado;
}

/** Máximo de fechas dentro de una ventana deslizante de 24 h. Pura. */
export function maximoEn24h(fechas: (string | null | undefined)[]): number {
    const t = fechas.map((f) => Date.parse(String(f ?? ''))).filter(Number.isFinite).sort((a, b) => a - b);
    let max = 0;
    for (let i = 0, j = 0; j < t.length; j++) {
        while (t[j] - t[i] > VENTANA_RAFAGA_MS) i++;
        max = Math.max(max, j - i + 1);
    }
    return max;
}

/** Tipos que ya dicen «es de la escuela»: no se sugiere marcarlos. */
const TIPOS_DE_LA_ESCUELA = new Set(['familia', 'familia_sin_cuenta', 'ambiguo', 'staff']);

/**
 * Números candidatos a sugerencia, ANTES de cruzar con las fichas. Pura.
 * El llamador descarta después los que tienen ficha (`numerosConFicha`).
 */
export function candidatosASugerir(
    filas: FilaParaSugerir[],
    convs: Map<string, ConversacionParaSugerir>,
): SugerenciaDeMarca[] {
    const porNumero = new Map<string, FilaParaSugerir[]>();
    for (const f of filas) {
        if (!f.wa_phone_number) continue;
        if (!porNumero.has(f.wa_phone_number)) porNumero.set(f.wa_phone_number, []);
        porNumero.get(f.wa_phone_number)!.push(f);
    }
    const out: SugerenciaDeMarca[] = [];
    for (const [numero, propias] of porNumero) {
        const c = convs.get(numero) ?? null;
        if (c && (esMarcaNoFamilia(c.contact_kind) || TIPOS_DE_LA_ESCUELA.has(String(c.contact_kind)))) continue;
        if (c?.identified && c?.parent_id) continue;
        const adjuntos24h = maximoEn24h(propias.map((f) => f.created_at));
        const porNombre = marcaPorNombre(c?.contact_name, ...propias.map((f) => f.media_caption));
        if (adjuntos24h <= UMBRAL_RAFAGA && !porNombre) continue;
        out.push({
            wa_phone_number: numero,
            conversacion_id: c?.id ?? null,
            contacto: c?.contact_name ?? null,
            motivo: adjuntos24h > UMBRAL_RAFAGA ? 'rafaga' : 'nombre',
            adjuntos_24h: adjuntos24h,
            filas: propias.length,
            tipo_sugerido: porNombre ?? 'negocio',
        });
    }
    return out.sort((a, b) => b.filas - a.filas);
}

export function estaCerrada(errorMessage: string | null | undefined): boolean {
    return (errorMessage ?? '').startsWith(PREFIJO_CERRADA);
}

export type AccionDeCierre = 'resuelto' | 'descartado' | 'resuelto_auto';

/** El `error_message` que deja un cierre. Conserva el motivo original tras « | ». */
export function marcaDeCierre(accion: AccionDeCierre, motivo: string, quien: string | null,
                              previo: string | null): string {
    const limpio = motivo.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 200);
    const por = quien ? ` (por ${quien.slice(0, 8)})` : '';
    return `${PREFIJO_CERRADA} ${accion} — ${limpio}${por} | ${previo ?? ''}`.slice(0, 1000);
}

/** Referencia de banco de «referencia ya usada: X» (lo escribe el worker). */
export function referenciaUsada(errorMessage: string | null): string | null {
    const m = (errorMessage ?? '').match(/^referencia ya usada:\s*(\S+)/);
    return m ? m[1] : null;
}

export interface PagoMinimo { id: string; school_id: string; status: string; concept: string | null; ocr_reference?: string | null }

/**
 * Filas que el barrido cierra solas: `ya_registrado` (de la recuperación, con
 * `result_ref_id`, o del worker, «referencia ya usada: X») cuyo pago ES de la
 * escuela y sigue registrado. Si el pago se anuló o rechazó después, la fila
 * se queda: ahí sí puede faltar plata.
 */
export function filasParaAutocierre(
    schoolId: string,
    filas: FilaCruda[],
    pagosPorId: Map<string, PagoMinimo>,
    pagosPorReferencia: Map<string, PagoMinimo>,
): { fila: FilaCruda; pago: PagoMinimo }[] {
    const out: { fila: FilaCruda; pago: PagoMinimo }[] = [];
    for (const f of filas) {
        if (f.status !== 'ignored' || estaCerrada(f.error_message)) continue;
        if (motivoDeFila(f).motivo !== 'ya_registrado') continue;
        const ref = referenciaUsada(f.error_message);
        const pago = (f.result_ref_id ? pagosPorId.get(f.result_ref_id) : undefined)
            ?? (ref ? pagosPorReferencia.get(ref) : undefined);
        if (!pago || pago.school_id !== schoolId) continue;
        if (!(ESTADOS_PAGO_REGISTRADO as readonly string[]).includes(pago.status)) continue;
        out.push({ fila: f, pago });
    }
    return out;
}

export function resumenDeGrupos(clases: Clasificacion[]): Record<GrupoBandeja, number> & { total: number } {
    const r = { accion: 0, revisar: 0, informativo: 0, total: clases.length };
    for (const c of clases) r[c.grupo] += 1;
    return r;
}

// ─── Autocierre por la decisión sobre el pago (2026-10-13) ───────────────────
//
// Dynasty: 206 abiertas y 0 cerradas por la escuela. El barrido de arriba solo
// cerraba `ya_registrado`. Una fila que pedía decidir (varios cobros, monto
// distinto…) seguía abierta aunque la escuela YA hubiera aprobado o rechazado
// ese comprobante desde Pagos (u otro camino): la bandeja quedaba como una
// lista de pendientes que ya no lo eran. Ahora se cierra sola cuando el pago
// enlazado a la fila tiene una decisión POSTERIOR a la llegada de la fila.
//
// Enlace fila → pago (de más a menos directo):
//   · `result_ref_id`                         (lo deja el worker/recuperación)
//   · `pregunta_ocr.sha` = receipt_image_sha256  (misma imagen)
//   · `pregunta_ocr.ocr.reference` = ocr_reference / receipt_reference_norm
//   · `pregunta_ocr.referencias[]` (2026-10-13): la referencia y las
//     ALTERNATIVAS del comprobante («Recibo» y «Aprob.» distintos), cruda y
//     normalizada. Igualdad exacta; nunca parecido.
// Nunca por «la familia tiene un pago aprobado esos días»: eso cerraría fotos
// que no tenían nada que ver (medido: 20 de 196 en Dynasty, casi todas «no es
// un comprobante»).

/** Pago con lo necesario para saber si ya se decidió. */
export interface PagoDecidible extends PagoMinimo {
    approved_at?: string | null;
    payment_date?: string | null;
    updated_at?: string | null;
    receipt_rejected_at?: string | null;
    receipt_image_sha256?: string | null;
    receipt_reference_norm?: string | null;
}

export interface FilaConEnlace extends FilaCruda {
    created_at?: string | null;
    pregunta_ocr?: any;
}

/** Estados que dejan el cobro vivo tras rechazar el comprobante (reject_payment_receipt). */
const VIVOS_TRAS_RECHAZO = ['pending', 'overdue', 'partial'];

export type DecisionDePago = 'aprobado' | 'rechazado';

/**
 * ¿Se decidió el pago DESPUÉS de que llegó la fila? Pura. Misma semántica que
 * `desenlaceDelPago` del job de desenlaces: un rechazo se reconoce por
 * `receipt_rejected_at` (o el viejo status 'rejected'); una aprobación, por el
 * estado registrado con fecha de aprobación (o de pago) posterior.
 */
export function decisionDelPago(pago: PagoDecidible, filaCreadaEn: string | null | undefined): DecisionDePago | null {
    const llegada = Date.parse(String(filaCreadaEn ?? ''));
    if (!Number.isFinite(llegada)) return null;
    // Margen: la fila se guarda unos segundos después de que entra el mensaje.
    const desde = llegada - 5 * 60_000;
    const despues = (s: string | null | undefined) => {
        const t = Date.parse(String(s ?? ''));
        return Number.isFinite(t) && t >= desde;
    };
    if ((ESTADOS_PAGO_REGISTRADO as readonly string[]).includes(pago.status) && pago.status !== 'awaiting_approval') {
        return despues(pago.approved_at ?? pago.payment_date ?? pago.updated_at) ? 'aprobado' : null;
    }
    if (pago.status === 'rejected') return despues(pago.receipt_rejected_at ?? pago.updated_at) ? 'rechazado' : null;
    if (VIVOS_TRAS_RECHAZO.includes(pago.status) && pago.receipt_rejected_at) {
        return despues(pago.receipt_rejected_at) ? 'rechazado' : null;
    }
    return null;
}

/**
 * sha y referencias que el worker o la recuperación guardaron en
 * `pregunta_ocr`. `referencia` es la que eligió el OCR; `referencias`, todas
 * (esa + las alternativas), sin repetir. Pura.
 */
export function huellasDeFila(f: FilaConEnlace): { sha: string | null; referencia: string | null; referencias: string[] } {
    const p = f.pregunta_ocr ?? null;
    const sha = typeof p?.sha === 'string' && p.sha ? p.sha : null;
    const ref = p?.ocr?.reference ?? p?.ocr?.referencia ?? null;
    const referencia = typeof ref === 'string' && ref.trim() ? ref.trim() : null;
    const otras = Array.isArray(p?.referencias)
        ? (p.referencias as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim())
        : [];
    const referencias = [...new Set([...(referencia ? [referencia] : []), ...otras])];
    return { sha, referencia, referencias };
}

/**
 * Filas abiertas cuyo pago enlazado ya se decidió después de su llegada. Pura.
 * No incluye las `ya_registrado` (las cierra `filasParaAutocierre`).
 */
export function filasParaAutocierrePorDecision(
    schoolId: string,
    filas: FilaConEnlace[],
    pagos: PagoDecidible[],
): { fila: FilaConEnlace; pago: PagoDecidible; decision: DecisionDePago }[] {
    const deLaEscuela = pagos.filter((p) => p.school_id === schoolId);
    const porId = new Map(deLaEscuela.map((p) => [p.id, p]));
    const out: { fila: FilaConEnlace; pago: PagoDecidible; decision: DecisionDePago }[] = [];
    for (const f of filas) {
        if (estaCerrada(f.error_message)) continue;
        if (!(ESTADOS_BANDEJA as readonly string[]).includes(f.status)) continue;
        if (motivoDeFila(f).motivo === 'ya_registrado') continue;
        const { sha, referencias } = huellasDeFila(f);
        const candidatos: PagoDecidible[] = [];
        if (f.result_ref_id && porId.has(f.result_ref_id)) candidatos.push(porId.get(f.result_ref_id)!);
        if (sha) candidatos.push(...deLaEscuela.filter((p) => p.receipt_image_sha256 === sha));
        if (referencias.length) {
            const refs = new Set(referencias);
            candidatos.push(...deLaEscuela.filter((p) =>
                (p.ocr_reference && refs.has(p.ocr_reference))
                || (p.receipt_reference_norm && refs.has(p.receipt_reference_norm))));
        }
        for (const pago of candidatos) {
            const decision = decisionDelPago(pago, f.created_at);
            if (decision) { out.push({ fila: f, pago, decision }); break; }
        }
    }
    return out;
}

/** Cuántas cerró la escuela y cuántas se cerraron solas, a partir de su `error_message`. Pura. */
export function contarCierres(mensajes: (string | null | undefined)[]): { escuela: number; automaticas: number; total: number } {
    let escuela = 0, automaticas = 0;
    for (const m of mensajes) {
        if (!estaCerrada(m)) continue;
        if (/^cerrado_escuela:\s*resuelto_auto\b/.test(String(m))) automaticas++;
        else escuela++;
    }
    return { escuela, automaticas, total: escuela + automaticas };
}
