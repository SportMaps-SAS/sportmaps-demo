/**
 * Ajustes del asistente de WhatsApp POR ESCUELA (mig. 20261006120601,
 * spec docs/specs/whatsapp-ajustes-por-escuela.md).
 *
 * Viven en `school_settings` y no en `whatsapp_settings` porque esta última es
 * por integración y no existe hasta que la escuela conecta su número: Besser
 * los dejó listos antes de conectar.
 *
 * Los defaults reproducen el comportamiento de siempre. Si la migración no
 * está aplicada (columna inexistente) o la lectura falla, se devuelven los
 * defaults: un ajuste que no se pudo leer nunca le cambia la conducta al bot.
 */
import { supabase } from '../config/supabase';

export type ModoCortesia = 'clase' | 'semana_app';

/** Modo discreto de la escuela (B6): 'global' = lo que diga la variable de entorno de siempre. */
export type ModoDiscretoEscuela = 'global' | 'si' | 'no';

/** Botón de sede de la bienvenida del embudo (`wa_botones_sede`): título ≤ 20 con su emoji. */
export interface BotonSede {
    branchId: string;
    titulo: string;
}

export type TipoPreguntaProspecto = 'texto' | 'fecha' | 'botones' | 'lista';

export interface OpcionPregunta {
    titulo: string;
    /** Solo listas: línea gris debajo del título (≤ 72). */
    descripcion?: string;
}

/**
 * Una pregunta del embudo del interesado (`wa_preguntas_prospecto`, en orden).
 * Claves reservadas: `nombre` → full_name, `fecha_nacimiento` → birth_date (acepta
 * solo el año), `sexo` → gender. Las demás quedan en `school_signup_leads.respuestas`.
 */
export interface PreguntaProspecto {
    clave: string;
    texto: string;
    tipo: TipoPreguntaProspecto;
    /** botones: 1–3 (título ≤ 20); lista: 1–10 (título ≤ 24). */
    opciones?: OpcionPregunta[];
    /** Texto del botón que abre la lista («Elegir posición», ≤ 20). */
    boton?: string;
    /** Pregunta de seguimiento solo si la respuesta es una de `si` (trayectoria «Club y torneos»). */
    detalle?: { si: string[]; clave: string; texto: string };
}

export interface AjustesWhatsAppEscuela {
    /** 'clase' = agenda una clase suelta (lo de siempre); 'semana_app' = paso a paso del enlace de cortesía. */
    modoCortesia: ModoCortesia;
    cortesiaQrId: string | null;
    cortesiaDias: number;
    ayudaApp: boolean;
    reclamosDeValor: boolean;
    /** Al desconocido que pregunta el precio, los valores de los planes (sin enlace de pago). */
    responderPrecios: boolean;
    /**
     * Ventas por WhatsApp, carril B (docs/specs/ventas-por-whatsapp.md): el bot
     * responde por los servicios del catálogo (clase extra, vacacionales,
     * torneos, viajes) y, a la familia identificada, le arma el cobro y el link.
     * Apagado por defecto (`school_settings.wa_ventas_habilitadas`, F0).
     */
    ventasHabilitadas: boolean;
    // ── Embudo del interesado y paso a una persona (mig. embudo_y_agenda_clase_prueba) ──
    // Las claves SOLO aparecen cuando la columna existe (migración aplicada): sin
    // ellas la escuela se comporta exactamente como hoy. Leerlas con los helpers
    // de abajo (`embudoActivo`, `modoDiscretoDeEscuela`, `temasAPersonaDeEscuela`).
    /** Bienvenida al desconocido (≤ 1000). null = la del bot. */
    bienvenida?: string | null;
    /** Botones de sede de la bienvenida. null = sin pregunta de sede. */
    botonesSede?: BotonSede[] | null;
    /** Preguntas del embudo. null (o JSON inválido) = embudo apagado. */
    preguntasProspecto?: PreguntaProspecto[] | null;
    modoDiscreto?: ModoDiscretoEscuela;
    /** Temas que siempre pasan a una persona. null = la lista global de hoy. */
    temasAPersona?: string[] | null;
}

export const AJUSTES_POR_DEFECTO: Readonly<AjustesWhatsAppEscuela> = Object.freeze({
    modoCortesia: 'clase',
    cortesiaQrId: null,
    cortesiaDias: 7,
    ayudaApp: false,
    reclamosDeValor: false,
    responderPrecios: false,
    ventasHabilitadas: false,
});

// ─── Validación del embudo (pura) ────────────────────────────────────────────

const MAX_TITULO_BOTON = 20;
const MAX_TITULO_FILA = 24;
const MAX_DESC_FILA = 72;
/** Los mismos topes del CHECK de la migración (1–15 preguntas, clave [a-z0-9_]{1,40}). */
const MAX_PREGUNTAS = 15;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAVE = /^[a-z0-9_]{1,40}$/;
const largo = (t: string) => Array.from(t).length;

/** Texto multilínea de la escuela: conserva los saltos de línea, recorta el resto. */
export function textoMultilinea(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n').trim();
    return t && largo(t) <= max ? t : null;
}

function opcionDe(v: unknown, maxTitulo: number): OpcionPregunta | null {
    const crudo = typeof v === 'string' ? { titulo: v } : (v && typeof v === 'object' ? v as Record<string, unknown> : null);
    if (!crudo) return null;
    const titulo = typeof crudo.titulo === 'string' ? crudo.titulo.trim()
        : typeof (crudo as any).title === 'string' ? String((crudo as any).title).trim() : '';
    if (!titulo || largo(titulo) > maxTitulo) return null;
    const desc = typeof crudo.descripcion === 'string' ? crudo.descripcion.trim() : '';
    if (desc && largo(desc) > MAX_DESC_FILA) return null;
    return desc ? { titulo, descripcion: desc } : { titulo };
}

/**
 * `wa_preguntas_prospecto` → preguntas validadas, o null (= embudo apagado).
 * Una sola pregunta inválida apaga todo: un embudo a medias pregunta mal y no
 * hay persona mirando. Pura.
 */
export function preguntasDesdeJson(v: unknown): PreguntaProspecto[] | null {
    if (!Array.isArray(v) || !v.length || v.length > MAX_PREGUNTAS) return null;
    const claves = new Set<string>();
    const salida: PreguntaProspecto[] = [];
    for (const crudo of v) {
        if (!crudo || typeof crudo !== 'object') return null;
        const p = crudo as Record<string, unknown>;
        const clave = typeof p.clave === 'string' ? p.clave.trim() : '';
        const texto = textoMultilinea(p.texto, 1000);
        const tipo = p.tipo;
        if (!CLAVE.test(clave) || claves.has(clave) || !texto) return null;
        if (tipo !== 'texto' && tipo !== 'fecha' && tipo !== 'botones' && tipo !== 'lista') return null;
        claves.add(clave);
        const pregunta: PreguntaProspecto = { clave, texto, tipo };
        if (tipo === 'botones' || tipo === 'lista') {
            const max = tipo === 'botones' ? 3 : 10;
            if (!Array.isArray(p.opciones) || !p.opciones.length || p.opciones.length > max) return null;
            const opciones = p.opciones.map((o) => opcionDe(o, tipo === 'botones' ? MAX_TITULO_BOTON : MAX_TITULO_FILA));
            if (opciones.some((o) => !o)) return null;
            pregunta.opciones = opciones as OpcionPregunta[];
            if (p.boton != null) {
                if (typeof p.boton !== 'string' || !p.boton.trim() || largo(p.boton.trim()) > MAX_TITULO_BOTON) return null;
                pregunta.boton = p.boton.trim();
            }
        }
        if (p.detalle != null) {
            const d = p.detalle as Record<string, unknown>;
            const dClave = typeof d?.clave === 'string' ? d.clave.trim() : '';
            const dTexto = textoMultilinea(d?.texto, 1000);
            const si = Array.isArray(d?.si) ? d.si.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
            if (!pregunta.opciones || !CLAVE.test(dClave) || claves.has(dClave) || !dTexto || !si.length) return null;
            claves.add(dClave);
            pregunta.detalle = { si: si.map((x) => x.trim()), clave: dClave, texto: dTexto };
        }
        salida.push(pregunta);
    }
    return salida;
}

/** `wa_botones_sede` → botones validados, o null (= sin pregunta de sede). Pura. */
export function botonesSedeDesdeJson(v: unknown): BotonSede[] | null {
    if (!Array.isArray(v) || !v.length || v.length > 9) return null;
    const vistos = new Set<string>();
    const salida: BotonSede[] = [];
    for (const crudo of v) {
        const b = (crudo && typeof crudo === 'object' ? crudo : {}) as Record<string, unknown>;
        const branchId = typeof b.branch_id === 'string' ? b.branch_id : typeof b.branchId === 'string' ? b.branchId : '';
        const titulo = typeof b.titulo === 'string' ? b.titulo.trim() : '';
        if (!UUID.test(branchId) || vistos.has(branchId) || !titulo || largo(titulo) > MAX_TITULO_BOTON) return null;
        vistos.add(branchId);
        salida.push({ branchId, titulo });
    }
    return salida;
}

/** `wa_temas_a_persona` → claves de tema, o null (= la lista global). Pura. */
export function temasDesdeJson(v: unknown): string[] | null {
    if (!Array.isArray(v) || v.length > 40) return null;
    const temas = v.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
    if (temas.length !== v.length || temas.some((t) => largo(t) > 60)) return null;
    return [...new Set(temas)];
}

/** Fila cruda → ajustes. Cualquier valor raro cae al default. */
export function ajustesDesdeFila(fila: Record<string, unknown> | null | undefined): AjustesWhatsAppEscuela {
    if (!fila) return { ...AJUSTES_POR_DEFECTO };
    const dias = Number(fila.wa_cortesia_dias);
    const tiene = (c: string) => Object.prototype.hasOwnProperty.call(fila, c);
    return {
        modoCortesia: fila.wa_modo_cortesia === 'semana_app' ? 'semana_app' : 'clase',
        cortesiaQrId: typeof fila.wa_cortesia_qr_id === 'string' && fila.wa_cortesia_qr_id ? fila.wa_cortesia_qr_id : null,
        cortesiaDias: Number.isInteger(dias) && dias >= 1 && dias <= 60 ? dias : AJUSTES_POR_DEFECTO.cortesiaDias,
        ayudaApp: fila.wa_ayuda_app === true,
        reclamosDeValor: fila.wa_reclamos_de_valor === true,
        responderPrecios: fila.wa_responder_precios === true,
        ventasHabilitadas: fila.wa_ventas_habilitadas === true,
        // Solo si la columna vino en la fila (migración aplicada).
        ...(tiene('wa_bienvenida') ? { bienvenida: textoMultilinea(fila.wa_bienvenida, 1000) } : {}),
        ...(tiene('wa_botones_sede') ? { botonesSede: botonesSedeDesdeJson(fila.wa_botones_sede) } : {}),
        ...(tiene('wa_preguntas_prospecto') ? { preguntasProspecto: preguntasDesdeJson(fila.wa_preguntas_prospecto) } : {}),
        ...(tiene('wa_modo_discreto') ? {
            modoDiscreto: (fila.wa_modo_discreto === 'si' || fila.wa_modo_discreto === 'no' ? fila.wa_modo_discreto : 'global') as ModoDiscretoEscuela,
        } : {}),
        ...(tiene('wa_temas_a_persona') ? { temasAPersona: temasDesdeJson(fila.wa_temas_a_persona) } : {}),
    };
}

/** ¿La escuela tiene el embudo del interesado? = preguntas válidas y no vacías. Pura. */
export function embudoActivo(a: Pick<AjustesWhatsAppEscuela, 'preguntasProspecto'> | null | undefined): boolean {
    return Array.isArray(a?.preguntasProspecto) && a!.preguntasProspecto!.length > 0;
}

/** Modo discreto efectivo: el de la escuela si lo fijó; si no, el global de siempre. Pura. */
export function modoDiscretoDeEscuela(a: Pick<AjustesWhatsAppEscuela, 'modoDiscreto'> | null | undefined, global: boolean): boolean {
    if (a?.modoDiscreto === 'si') return true;
    if (a?.modoDiscreto === 'no') return false;
    return global;
}

/** Temas que pasan a una persona: los de la escuela si los fijó; si no, la lista global. Pura. */
export function temasAPersonaDeEscuela<T extends string>(
    a: Pick<AjustesWhatsAppEscuela, 'temasAPersona'> | null | undefined, global: readonly T[],
): readonly string[] {
    return Array.isArray(a?.temasAPersona) ? a!.temasAPersona! : global;
}

// De la consulta más completa a la más pobre: cada columna llegó con una
// migración distinta, y una que falte no puede apagar las demás.
const COLUMNAS = [
    'wa_modo_cortesia, wa_cortesia_qr_id, wa_cortesia_dias, wa_ayuda_app, wa_reclamos_de_valor, wa_responder_precios, wa_ventas_habilitadas, '
        + 'wa_bienvenida, wa_botones_sede, wa_preguntas_prospecto, wa_modo_discreto, wa_temas_a_persona',
    'wa_modo_cortesia, wa_cortesia_qr_id, wa_cortesia_dias, wa_ayuda_app, wa_reclamos_de_valor, wa_responder_precios, wa_ventas_habilitadas',
    'wa_modo_cortesia, wa_cortesia_qr_id, wa_cortesia_dias, wa_ayuda_app, wa_reclamos_de_valor, wa_responder_precios',
    'wa_modo_cortesia, wa_cortesia_qr_id, wa_cortesia_dias, wa_ayuda_app, wa_reclamos_de_valor',
];

/** Nunca lanza. */
export async function ajustesWhatsAppDeEscuela(schoolId: string | null | undefined): Promise<AjustesWhatsAppEscuela> {
    if (!schoolId) return { ...AJUSTES_POR_DEFECTO };
    try {
        for (const columnas of COLUMNAS) {
            const { data, error } = await supabase
                .from('school_settings')
                .select(columnas)
                .eq('school_id', schoolId)
                .maybeSingle();
            if (!error) return ajustesDesdeFila(data as Record<string, unknown> | null);
        }
        return { ...AJUSTES_POR_DEFECTO };
    } catch {
        return { ...AJUSTES_POR_DEFECTO };
    }
}

// ─── Clase de prueba: agenda por escuela (school_trial_class_settings) ───────
//
// Mig. embudo_y_agenda_clase_prueba. Todo NULL/por defecto = el comportamiento de
// hoy: «clase de cortesía», sin cobro en el bot, 999 cupos, todos los días.

export type NombreClase = 'cortesia' | 'prueba';

export interface AjustesClasePrueba {
    /** null = «clase de cortesía» (los textos de siempre). */
    nombreClase: NombreClase | null;
    /** `trial_price` (20261029215003). null o 0 = sin valor. */
    precio: number | null;
    /** Horas que se sostiene un cupo separado. null = sin flujo de pago en el bot. */
    separarHoras: number | null;
    /** null = sin tope (999). */
    cuposPorSesion: number | null;
    /** D9: agendar al recibir el comprobante (si coincide), sin esperar la revisión. */
    agendarAlRecibir: boolean;
    /** Aviso al entrenador del equipo al agendar, cambiar o cancelar. */
    avisarEntrenador: boolean;
    /** Días en que se agenda (0 = domingo … 6 = sábado, como teams.schedule[].day). null = todos. */
    diasSemana: number[] | null;
}

export const AJUSTES_CLASE_PRUEBA_POR_DEFECTO: Readonly<AjustesClasePrueba> = Object.freeze({
    nombreClase: null,
    precio: null,
    separarHoras: null,
    cuposPorSesion: null,
    agendarAlRecibir: true,
    avisarEntrenador: false,
    diasSemana: null,
});

const enteroEntre = (v: unknown, min: number, max: number): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Fila de school_trial_class_settings → ajustes. Lo raro cae al default. Pura. */
export function ajustesClasePruebaDesdeFila(fila: Record<string, unknown> | null | undefined): AjustesClasePrueba {
    if (!fila) return { ...AJUSTES_CLASE_PRUEBA_POR_DEFECTO };
    const precio = fila.trial_price == null || fila.trial_price === '' ? null : Number(fila.trial_price);
    const dias = Array.isArray(fila.dias_semana)
        ? [...new Set((fila.dias_semana as unknown[]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
        : null;
    return {
        nombreClase: fila.nombre_clase === 'cortesia' || fila.nombre_clase === 'prueba' ? fila.nombre_clase : null,
        precio: precio != null && Number.isFinite(precio) && precio >= 0 ? precio : null,
        separarHoras: enteroEntre(fila.separar_horas, 1, 72),
        cuposPorSesion: enteroEntre(fila.cupos_por_sesion, 1, 500),
        agendarAlRecibir: fila.agendar_al_recibir !== false,
        avisarEntrenador: fila.avisar_entrenador === true,
        diasSemana: dias && dias.length ? dias : null,
    };
}

/** ¿El bot cobra la clase por el chat? Embudo + horas para separar + valor > 0. Pura. */
export function cobraClaseEnElBot(a: Pick<AjustesClasePrueba, 'precio' | 'separarHoras'>): boolean {
    return a.separarHoras != null && (a.precio ?? 0) > 0;
}

const COLUMNAS_CLASE = [
    'nombre_clase, trial_price, separar_horas, cupos_por_sesion, agendar_al_recibir, avisar_entrenador, dias_semana',
    'trial_price',
];

/** Nunca lanza: sin fila, sin columnas o con error → los defaults de hoy. */
export async function ajustesClasePrueba(schoolId: string | null | undefined): Promise<AjustesClasePrueba> {
    if (!schoolId) return { ...AJUSTES_CLASE_PRUEBA_POR_DEFECTO };
    try {
        for (const columnas of COLUMNAS_CLASE) {
            const { data, error } = await supabase
                .from('school_trial_class_settings')
                .select(columnas)
                .eq('school_id', schoolId)
                .maybeSingle();
            if (!error) return ajustesClasePruebaDesdeFila(data as Record<string, unknown> | null);
        }
        return { ...AJUSTES_CLASE_PRUEBA_POR_DEFECTO };
    } catch {
        return { ...AJUSTES_CLASE_PRUEBA_POR_DEFECTO };
    }
}

// ─── Textos libres por escuela (mig. 20261007183601) ─────────────────────────
//
// `wa_atencion_presencial` y `wa_cortesia_indicaciones` en school_settings.
// Mientras la migración no esté aplicada, el mismo dato se lee de
// `schools.payment_settings` (jsonb legacy que ningún formulario escribe), con
// la misma clave: así Dynasty lo tiene hoy sin tocar el esquema.

export type TextoDeEscuela = 'wa_atencion_presencial' | 'wa_cortesia_indicaciones';

/** Recorta y descarta lo vacío o lo que no es texto. Pura. */
export function textoLimpio(v: unknown, max = 400): string | null {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
}

/** Columna de school_settings; si no existe o está vacía, la clave puente. Nunca lanza. */
export async function textoDeEscuela(schoolId: string | null | undefined, campo: TextoDeEscuela): Promise<string | null> {
    if (!schoolId) return null;
    try {
        const { data, error } = await supabase
            .from('school_settings').select(campo).eq('school_id', schoolId).maybeSingle();
        if (!error) {
            const v = textoLimpio((data as Record<string, unknown> | null)?.[campo]);
            if (v) return v;
        }
    } catch { /* columna sin migrar: se intenta el puente */ }
    try {
        const { data } = await supabase
            .from('schools').select('payment_settings').eq('id', schoolId).maybeSingle();
        return textoLimpio((data as any)?.payment_settings?.[campo]);
    } catch {
        return null;
    }
}

/**
 * Dónde y cuándo atiende la escuela EN PERSONA (pagos, trámites), tal como lo
 * escribió la escuela, o null si no lo configuró: entonces el bot no lo dice
 * (nunca se inventa). Dynasty 2026-10-07: «Club de voleibol Coliseo Dynasty,
 * Cl. 12 Bis #71g-09, Bogotá. Desde las 4 p. m. hasta las 9 p. m.»
 */
export function atencionPresencialDeEscuela(schoolId: string | null | undefined): Promise<string | null> {
    return textoDeEscuela(schoolId, 'wa_atencion_presencial');
}

/** Qué llevar / a quién buscar en la clase de cortesía, o null (= texto genérico). */
export function indicacionesCortesiaDeEscuela(schoolId: string | null | undefined): Promise<string | null> {
    return textoDeEscuela(schoolId, 'wa_cortesia_indicaciones');
}
