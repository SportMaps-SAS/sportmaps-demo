/**
 * whatsapp-tipo-contacto — las marcas MANUALES de «no es familia».
 *
 * Con Coexistence entra al sistema todo el WhatsApp de la escuela, que en una
 * escuela chica es también el de la dueña. Hasta el 2026-10-13 la única marca
 * era `personal`; en Dynasty, de 87 filas «para revisar» de la bandeja, 37 eran
 * de un proveedor mayorista, 14 del círculo personal de la dueña y 5 de
 * negocios, otro club y el propio número de SportMaps (migración
 * 20261013164839_whatsapp_tipos_de_contacto).
 *
 * Las cinco marcas significan lo mismo para el bot: NO es familia. No se le
 * habla, no se guarda el contenido de sus mensajes, sus adjuntos no se
 * procesan y sus filas no cuentan en la bandeja. Cambian solo la etiqueta.
 *
 * `tambien_familia` (bandera): la persona marcada TAMBIÉN es acudiente (el
 * esposo de la dueña que es papá de una atleta). Sus comprobantes se aplican
 * en silencio a los cobros de sus hijos; sus fotos personales no llegan a
 * «revisar». Sin marca manual la bandera no tiene efecto.
 *
 * Este archivo es el único lugar que sabe cuáles son las marcas: el resto
 * pregunta `esMarcaNoFamilia(kind)` en vez de comparar con 'personal'.
 */

/** `equipo` = «Staff» marcado a mano (distinto del `staff` AUTOMÁTICO, que la clasificación pisa). */
export const TIPOS_MARCADOS = ['personal', 'negocio', 'otro_club', 'plataforma', 'equipo'] as const;
export type TipoMarcado = typeof TIPOS_MARCADOS[number];

/** Lo que ve la escuela («contacto marcado como …»). */
export const ETIQUETA_DE_MARCA: Record<TipoMarcado, string> = {
    personal: 'personal',
    negocio: 'negocio',
    otro_club: 'otro club',
    plataforma: 'plataforma',
    equipo: 'staff',
};

/** ¿La escuela marcó a mano este contacto como no-familia? */
export function esMarcaNoFamilia(kind: string | null | undefined): kind is TipoMarcado {
    return !!kind && (TIPOS_MARCADOS as readonly string[]).includes(kind);
}

/**
 * ¿De este contacto NO se guarda contenido ni se procesan adjuntos? Marca
 * manual sin la bandera «también es familia».
 */
export function esContactoSinContenido(kind: string | null | undefined, tambienFamilia?: boolean | null): boolean {
    return esMarcaNoFamilia(kind) && tambienFamilia !== true;
}

/**
 * Filtro PostgREST: filas cuyo `contact_kind` NO es una marca manual. Lo usa
 * la clasificación automática para no pisar lo que marcó la escuela.
 */
export const FILTRO_SIN_MARCA_MANUAL = `contact_kind.is.null,contact_kind.not.in.(${TIPOS_MARCADOS.join(',')})`;

export interface MarcaDeContacto { kind: string | null; tambienFamilia: boolean }

/**
 * Lee `contact_kind` + `tambien_familia` con una consulta que recibe las
 * columnas. Si `tambien_familia` todavía no existe (la migración se aplica a
 * mano) se reintenta sin ella: la marca sigue valiendo y la bandera es false.
 * Nunca lanza; ante un error devuelve `null`.
 */
export async function leerConMarca<T = any>(
    consulta: (columnas: string) => PromiseLike<{ data: any; error: any }>,
    columnasBase: string,
): Promise<{ data: T | null; error: any }> {
    const base = columnasBase ? `${columnasBase}, ` : '';
    try {
        const con = await consulta(`${base}contact_kind, tambien_familia`);
        if (!con.error) return { data: con.data as T, error: null };
        const sin = await consulta(`${base}contact_kind`);
        if (!sin.error) {
            const fill = (x: any) => (x && typeof x === 'object' ? { ...x, tambien_familia: false } : x);
            const data = Array.isArray(sin.data) ? sin.data.map(fill) : fill(sin.data);
            return { data: data as T, error: null };
        }
        return { data: null, error: sin.error };
    } catch (err) {
        return { data: null, error: err };
    }
}

/** Nombres que suenan a negocio, club o plataforma (sugerencia, nunca marca sola). */
const PALABRAS_DE_NEGOCIO: { re: RegExp; tipo: TipoMarcado }[] = [
    { re: /\b(club|deportivo|academia|escuela de|liga)\b/, tipo: 'otro_club' },
    { re: /\bsportmaps\b/, tipo: 'plataforma' },
    { re: /\b(s\s?a\s?s|sas|ltda|tienda|mayorista|mayoristas|distribuidora|almacen|gastrobar|restaurante|bar|turismo|viajes|agencia|ferreteria|drogueria|papeleria|publicidad|importadora|comercializadora|store|shop|market|supermercado|panaderia|inversiones|servicios)\b/, tipo: 'negocio' },
];

const plano = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** ¿El nombre (o el pie del adjunto) suena a negocio? Pura. Devuelve la marca sugerida o null. */
export function marcaPorNombre(...textos: (string | null | undefined)[]): TipoMarcado | null {
    const t = ` ${plano(textos.filter(Boolean).join(' '))} `;
    if (!t.trim()) return null;
    for (const { re, tipo } of PALABRAS_DE_NEGOCIO) if (re.test(t)) return tipo;
    return null;
}
