/**
 * whatsapp-coherencia-ficha — ¿el texto libre que la escuela le escribió al
 * asistente contradice su propio catálogo? (plan
 * docs/specs/whatsapp-ventas-de-servicio-blindaje.md, frente B).
 *
 * Caso que lo originó (Monster, 2026-11-08): la ficha de prospectos decía
 * «Preventa: $300.000 hasta el 9 de noviembre. Desde el 10 de noviembre:
 * $350.000»; el catálogo de la clínica tenía `precios_por_fecha` =
 * [{desde: '2026-11-11', precio: 350000}] (preventa HASTA el 10) y el anuncio
 * también decía «hasta el 10». Nadie lo notó hasta que la IA repitió «hasta el
 * 9» a 12 personas.
 *
 * `auditarFichaContraCatalogo(ficha, items)` revisa línea por línea:
 *   · a qué servicio se refiere cada línea: por un monto que solo tiene ese
 *     servicio ($350.000 → la clínica), porque lo nombra («CLÍNICA DE ARMADORES»)
 *     o porque está debajo de un encabezado que lo nombra (hasta el siguiente
 *     encabezado);
 *   · FECHAS DE PRECIO («hasta el 9 de noviembre», «desde el 10») que no cuadran
 *     con los tramos del catálogo, o que el servicio no tiene tramos;
 *   · MONTOS de precio de ese servicio que el catálogo no tiene («Preventa:
 *     $280.000» con el catálogo en $300.000). Solo en líneas que hablan del
 *     precio del servicio y no de cosas del club (matrícula, mensualidad,
 *     uniformes, clase de prueba).
 * Devuelve una contradicción por hallazgo, con el texto claro para la escuela:
 * «Tu texto para el asistente dice “Preventa: $300.000 hasta el 9 de
 * noviembre”; el catálogo de Clínica de armadores y atacantes dice hasta el
 * martes 10 de noviembre (desde el miércoles 11 de noviembre, $350.000).»
 *
 * Lo usan: el endpoint de la escuela (aviso amarillo en WhatsApp › Configuración),
 * el script `bff/scripts/wa-coherencia-fichas.ts` y el verificador de salida de
 * la IA (`permitidosDeTextoLibre`: los montos y fechas de las líneas que
 * contradicen el catálogo NO quedan permitidos). Puro.
 */

import type { ItemConFicha } from './whatsapp-anuncio-destino';
import { itemNombradoEn } from './whatsapp-venta-contexto';
import { hoyBogota, tramosPorFecha } from './wa-cobro-desde-comprobante.service';
import { cop } from './whatsapp-venta-servicios.service';
import { diaConSemana, textoDeTramos } from './whatsapp-catalogo-para-ia';
import {
    cortesDelItem, diasDelItem, extraerFechasDePrecio, extraerMontos, montosDelItem, normalizarParaMontos,
    permitidosVacios, ultimoMesDe, type FechaDePrecio, type Permitidos,
} from './whatsapp-verificador-montos';

export type FuenteDelTexto = 'ficha' | 'descripcion';

export interface ContradiccionFicha {
    fuente: FuenteDelTexto;
    /** Número de línea (1 = la primera) del texto revisado. */
    linea: number;
    /** El pedazo que contradice, tal cual lo escribió la escuela. */
    dice: string;
    servicioId: string;
    servicio: string;
    tipo: 'fecha_de_precio' | 'monto';
    /** Lo que dice el catálogo. */
    catalogo: string;
    /** El aviso completo para la escuela. */
    mensaje: string;
}

/** Palabras del club: una línea con estas no habla del precio de un servicio. */
const COSAS_DEL_CLUB = /\b(matricula|mensualidad(es)?|uniformes?|clases? de (prueba|cortesia)|inscripcion al club|plan(es)? (mensual|del club)|sudadera)\b/;
/** La línea habla del precio del servicio. */
const HABLA_DE_PRECIO = /\b(precio|valor(es)?|preventa|inversion|cuesta|vale|tarifa|afiliados?|externos?|abono|separas?|semanas?|neto)\b/;

/** ¿Es un encabezado de sección? («VALORES 2026», «🎁 REGALO DE CIERRE DE AÑO (…)»). Pura. */
export function esEncabezado(linea: string): boolean {
    const palabras = linea.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((p) => p.length >= 2);
    if (palabras.length < 1) return false;
    const primeras = palabras.slice(0, 3);
    const letras = primeras.join('');
    return letras.length >= 4 && primeras.every((p) => p === p.toUpperCase());
}

/** El pedazo de la línea que se le muestra a la escuela: la frase de la fecha, sin viñetas ni emojis al inicio. Pura. */
function limpioParaMostrar(t: string, max = 140): string {
    const s = t.replace(/^[\s\p{Extended_Pictographic}️•·*\-–—:]+/u, '').replace(/[\s.;,]+$/, '').trim();
    return s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, '')}…` : s;
}

/** 'MM-DD' → distancia en días a otro 'MM-DD' (mismo año de referencia). Pura. */
function distancia(a: string, b: string, anio: number): number {
    const t = (x: string) => Date.UTC(anio, Number(x.slice(0, 2)) - 1, Number(x.slice(3, 5)));
    return Math.abs(t(a) - t(b)) / 86_400_000;
}

/** Lo que dice el catálogo sobre el corte más cercano al que escribió la escuela. Pura. */
function loQueDiceElCatalogo(item: ItemConFicha, f: FechaDePrecio, anio: number): string {
    const tramos = tramosPorFecha(item.precios_por_fecha);
    if (!tramos.length) {
        const precio = Number(item.price) > 0 ? ` (valor: ${cop(Number(item.price))})` : '';
        return `no tiene cambio de precio por fecha${precio}`;
    }
    const cercano = [...tramos].sort((a, b) => distancia(a.desde.slice(5), f.corte, anio) - distancia(b.desde.slice(5), f.corte, anio))[0];
    const i = tramos.indexOf(cercano);
    const anterior = i === 0 ? Number(item.price) : tramos[i - 1].precio;
    if (f.tipo === 'hasta' || f.tipo === 'antes') {
        return `hasta el ${diaConSemana(cercano.desde, 1)} (${anterior > 0 ? `${cop(anterior)}; ` : ''}desde el ${diaConSemana(cercano.desde)}, ${cop(cercano.precio)})`;
    }
    return `desde el ${diaConSemana(cercano.desde)}, ${cop(cercano.precio)}${anterior > 0 ? ` (hasta el ${diaConSemana(cercano.desde, 1)}, ${cop(anterior)})` : ''}`;
}

/** Resumen de precios del servicio para el aviso de un monto que no cuadra. Pura. */
function preciosDelCatalogo(item: ItemConFicha): string {
    return textoDeTramos(item)
        ?? [...montosDelItem(item, { afiliado: 'todos' })].sort((a, b) => a - b).map(cop).join(', ');
}

/**
 * Las contradicciones del texto contra el catálogo. `fuente` cambia el aviso
 * («Tu texto para el asistente dice…» / «La descripción de X dice…»); con
 * `itemFijo` todas las líneas son de ese servicio (la descripción de un ítem).
 * `hoy` ('YYYY-MM-DD') da el año para fechas sin año. Pura.
 */
export function auditarFichaContraCatalogo(
    ficha: string | null | undefined,
    items: ItemConFicha[],
    o: { hoy?: string; fuente?: FuenteDelTexto; itemFijo?: ItemConFicha | null } = {},
): ContradiccionFicha[] {
    const texto = String(ficha ?? '');
    if (!texto.trim() || !items.length) return [];
    const hoy = o.hoy ?? hoyBogota();
    const anio = Number(hoy.slice(0, 4));
    const fuente = o.fuente ?? 'ficha';
    const montosPorItem = new Map(items.map((it) => [it.id, montosDelItem(it, { afiliado: 'todos' })]));
    const out: ContradiccionFicha[] = [];
    let seccion: ItemConFicha | null = o.itemFijo ?? null;
    let mes: number | null = null;

    texto.split(/\r?\n/).forEach((crudo, idx) => {
        const linea = crudo.trim();
        if (!linea) return;
        const n = normalizarParaMontos(linea);
        const nombrado = o.itemFijo ? null : itemNombradoEn(linea, items);
        if (!o.itemFijo) {
            if (nombrado) seccion = nombrado;
            else if (esEncabezado(linea)) seccion = null;
        }
        const fechas = extraerFechasDePrecio(linea, { hoy, mesInicial: mes });
        mes = ultimoMesDe(linea) ?? mes;
        const montos = extraerMontos(linea);
        if (!fechas.length && !montos.length) return;
        // Una línea de cosas del club (matrícula, mensualidad…) que no nombra un servicio no es de un servicio.
        if (!o.itemFijo && !nombrado && COSAS_DEL_CLUB.test(n)) return;

        // El servicio de la línea: un monto que solo tiene ese servicio manda; si no, el que nombra o la sección.
        const porMonto = new Set<ItemConFicha>();
        for (const m of montos) {
            const duenos = items.filter((it) => montosPorItem.get(it.id)!.has(m.valor));
            if (duenos.length === 1) porMonto.add(duenos[0]);
        }
        const item = o.itemFijo ?? (porMonto.size === 1 ? [...porMonto][0] : null) ?? nombrado ?? seccion;
        if (!item) return;
        const cortes = cortesDelItem(item);
        const dias = diasDelItem(item);
        const decir = (dice: string, tipo: ContradiccionFicha['tipo'], catalogo: string) => {
            const quien = fuente === 'ficha'
                ? 'Tu texto para el asistente dice'
                : `La descripción de ${item.name} dice`;
            const deQue = fuente === 'ficha' ? `el catálogo de ${item.name} dice` : 'los precios del catálogo dicen';
            out.push({
                fuente, linea: idx + 1, dice, servicioId: item.id, servicio: item.name, tipo, catalogo,
                mensaje: `${quien} “${dice}”; ${deQue} ${catalogo}.`,
            });
        };

        for (const f of fechas) {
            if (dias.has(f.declarada) || cortes.has(f.corte)) continue;
            decir(limpioParaMostrar(f.frase), 'fecha_de_precio', loQueDiceElCatalogo(item, f, anio));
        }

        // Montos: solo si la línea habla del precio del servicio (no del club) y la atribución no salió del monto mismo.
        if (porMonto.size === 0 && HABLA_DE_PRECIO.test(n) && !COSAS_DEL_CLUB.test(n)) {
            const propios = montosPorItem.get(item.id)!;
            const deOtro = (v: number) => items.some((it) => it.id !== item.id && montosPorItem.get(it.id)!.has(v));
            for (const m of montos) {
                if (propios.has(m.valor) || deOtro(m.valor)) continue;
                decir(limpioParaMostrar(linea), 'monto', preciosDelCatalogo(item));
                break; // una por línea basta
            }
        }
    });
    return out;
}

/** Los números de línea que contradicen el catálogo. Pura. */
export function lineasQueContradicen(ficha: string | null | undefined, items: ItemConFicha[], o: { hoy?: string } = {}): Set<number> {
    return new Set(auditarFichaContraCatalogo(ficha, items, o).map((c) => c.linea));
}

/**
 * Montos y cortes de precio que aparecen en un texto de la escuela (ficha libre
 * o descripción), SIN las líneas que contradicen el catálogo: lo que la ficha
 * dice de la matrícula o de los planes queda permitido; el «hasta el 9» que
 * choca con el catálogo, no. Pura.
 */
export function permitidosDeTextoLibre(
    texto: string | null | undefined,
    items: ItemConFicha[],
    o: { hoy?: string; itemFijo?: ItemConFicha | null } = {},
): Permitidos {
    const out = permitidosVacios();
    const t = String(texto ?? '');
    if (!t.trim()) return out;
    const hoy = o.hoy ?? hoyBogota();
    const malas = new Set(auditarFichaContraCatalogo(t, items, { hoy, itemFijo: o.itemFijo }).map((c) => c.linea));
    let mes: number | null = null;
    t.split(/\r?\n/).forEach((linea, idx) => {
        const fechas = extraerFechasDePrecio(linea, { hoy, mesInicial: mes });
        mes = ultimoMesDe(linea) ?? mes;
        if (malas.has(idx + 1)) return;
        for (const m of extraerMontos(linea)) out.montos.add(m.valor);
        for (const f of fechas) out.cortes.add(f.corte);
    });
    return out;
}
