/**
 * Batería de escenarios del embudo del interesado contra la configuración REAL
 * de una escuela, y contra variantes de esa configuración armadas en memoria.
 * No manda un solo mensaje ni escribe en la base.
 *
 * Desde la RAIZ del repo o desde bff/, da igual:
 *
 *   npm run qa:embudo -- --escuela monsters-volley-club
 *   npm run qa:embudo -- --escuela <uuid|slug> --solo guiones,despues
 *   npm run qa:embudo -- --escuela monsters-volley-club --variante sin-valor,sin-cuentas
 *   npm run qa:embudo -- --escuela monsters-volley-club --anios 2009,2012 --transcripcion embudo.md
 *
 * Opciones: --solo matriz|guiones|despues|variantes|anuncios|flows|pagos|conversaciones (varias con coma; sin --solo
 * corren todos) · --variante <nombre>[,<nombre>] (implica --solo variantes) ·
 * --paralelo N (conversaciones a la vez, 3 por defecto, máx. 8) · --anios ·
 * --transcripcion <archivo.md> · --verbose (deja ver los logs del bot).
 *
 * CÓMO
 * Cada conversación corre turno a turno por `turnoSimulado`, el mismo camino del
 * número de pruebas: lee la base de verdad (ajustes, grupos, franjas, cuentas),
 * el cortafuegos bloquea toda escritura y nada sale a Meta. Del lado del
 * interesado contesta un «interesado automático»: lee lo que preguntó el bot y
 * responde según su perfil (sede, año, sexo, trayectoria).
 *
 * VARIANTES. El cortafuegos sirve desde memoria las tablas de `TABLAS_VIRTUALES`.
 * Para una variante la batería agrega a ese Set, mientras corre la variante, las
 * tablas que cambia (`school_settings`, `school_trial_class_settings`,
 * `school_trial_slots`, `school_signup_leads`) y siembra en la sesión las filas
 * COMPLETAS leídas de la base (`select *`) con el cambio aplicado: con una tabla
 * virtual TODAS sus lecturas salen de memoria. Entre variantes se limpia la caché
 * de textos de la clase (10 min por escuela); los ajustes de WhatsApp, la clase
 * de prueba y los medios de pago no tienen caché entre turnos.
 *
 * DESPUÉS DEL EMBUDO. Una conversación base llega hasta las instrucciones de
 * pago; de ahí se BIFURCA (copia de la memoria con otro contacto) una
 * conversación por cada cosa que escribe la familia, en dos momentos: esperando
 * el pago y ya agendada (se inyecta el mensaje con que B4 confirma el pago, tal
 * cual lo deja el job: sin el estado del embudo, y el lead en memoria).
 *
 * QUÉ REVISA
 *   · Matriz: cada sede × año de nacimiento × sexo (la trayectoria rota), por
 *     botones, hasta el pago. El grupo tiene que recibir clase de prueba, no ser
 *     de Competencia, aceptar ese año y ese sexo, y ser de la sede elegida (o
 *     de la «otra sede» que se tocó). Las franjas: de ese grupo, abiertas, con
 *     cupo («N cupos» bien contado), en los días que la escuela agenda y con la
 *     anticipación mínima. Si ningún grupo acepta ese año, una persona.
 *   · Guiones: texto libre y caminos sueltos (otra sede, «Hablar con alguien»,
 *     la lista contestada por texto, sede escrita mal, «Club y torneos», adulto,
 *     menor sin grupo, varias respuestas en otro orden, preguntas sin «?»).
 *   · Después: matrícula, qué llevar, dónde queda, mensualidad, «ya pagué»,
 *     cambiar de horario (escrito y botón), «no puedo ir», «gracias».
 *   · Variantes: sin valor, sin cuentas de pago, sin sedes / una sede, sin
 *     franjas, días, cupos llenos, horas para separar, embudo apagado.
 *   · Anuncios (whatsapp-anuncio-destino): el primer mensaje trae el `referral` de
 *     Meta. Anuncio de la clínica sin mapeo (la tabla real todavía no existe) y con
 *     mapeo (`whatsapp_anuncio_destino` virtual), mapeo a una persona, anuncio de la
 *     clase de prueba, anuncio desconocido, evento sin servicio activo, «info de la
 *     clínica» sin anuncio, afiliado y la clínica a mitad del embudo. Que vaya al
 *     destino correcto, con el precio de HOY, sin el embudo equivocado, con el motivo
 *     esperado intentado (el cortafuegos bloquea su insert) y nunca en silencio.
 *   · Flows (formularios de WhatsApp, fase F-a): con el formulario publicado (fila
 *     virtual de whatsapp_flows) la ficha va seguida del formulario (datos que
 *     caben en el JSON, token de 72 h, respaldo por chat); la respuesta
 *     (`nfm_reply`) completa/abono × afiliado o no, sin consentimiento, token
 *     inválido o vencido, servicio desactivado, precio cambiado y duplicada; y
 *     borrador/apagado/bloqueado/sin salud → solo la ficha.
 *   · Conversaciones (casos reales de producción, Monster 2026-11-05): mensajes personales a
 *     alguien de la escuela («Hola Pipe») sin aviso de registro, disputas de pago sin datos
 *     de pago, «este numero?» tras los datos de pago, y «el campamento del 21 de nov… edades».
 *   · En TODO mensaje: que la familia reciba algo (la nota «se abre en el buzón»
 *     NO cuenta), sin «gratis» si la clase tiene valor, sin undefined/null/NaN,
 *     sin reglas de cancha sin resolver, títulos dentro del límite de WhatsApp,
 *     sin renglones repetidos y ≤ 4096 caracteres.
 *
 * Cada falla sale clasificada: falla (bug del bot), esperada (silencio después
 * del embudo, en arreglo) o limitación de la simulación (no cuenta como falla).
 *
 * Lo que NO mide: la cola de comprobantes con una foto real (eso se prueba en el
 * número de pruebas). Es determinista mientras no cambien los datos de la
 * escuela, salvo las respuestas del modelo después del embudo.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { supabase } from '../src/config/supabase';
import { TABLAS_VIRTUALES, type Fila } from '../src/config/cortafuegos-simulacion';
import {
    turnoSimulado, contactoSintetico, conversacionDePrueba, type SesionPrueba,
} from '../src/services/plataforma-wa-pruebas.service';
import type { SalidaSimulada } from '../src/services/whatsapp-bot.service';
import {
    ajustesWhatsAppDeEscuela, ajustesClasePrueba, embudoActivo, ajustesDesdeFila, ajustesClasePruebaDesdeFila,
    indicacionesCortesiaDeEscuela,
    type PreguntaProspecto, type BotonSede, type AjustesWhatsAppEscuela, type AjustesClasePrueba, type NombreClase,
} from '../src/services/whatsapp-ajustes-escuela.service';
import { rangosDeEscuela, elegirGrupoEmbudo, type RangoGrupo } from '../src/services/grupos-por-edad.service';
import { BOTON_EMBUDO, PASO_EMBUDO, ANTICIPACION_MIN_EMBUDO, sinEmojis } from '../src/services/whatsapp-embudo-prospecto';
import { BOTON_PUERTA } from '../src/services/whatsapp-puerta-desconocido';
import { BOTON_PAGO_MENSUALIDAD, PASO_PAGO_ACLARACION } from '../src/services/whatsapp-pagar-mensualidad';
import { normalizar } from '../src/services/whatsapp-clase-cortesia.service';
import { diaDeLaSemana } from '../src/services/semana-equipo.service';
import { limpiarCacheTextosClase, formatoPesos } from '../src/services/textos-clase-prueba';
import { franjaDeAgenda, textoConfirmacion } from '../src/services/clase-prueba-agenda.service';
import { serviciosDeAnuncio, inferirServicio, MARCA_DESTINO, type ItemConFicha } from '../src/services/whatsapp-anuncio-destino';
import { integracionParaSimular } from '../src/services/plataforma-wa-pruebas.service';
import {
    leerFlowDelRepo, validarFlowJson, validarDatosDeEntrada, firmarTokenFormulario, verificarTokenFormulario,
    payloadDeFormulario, ENV_SECRETO_TOKEN,
} from '../src/services/whatsapp-flows.service';
import { FORMULARIO_SERVICIO, PANTALLA_INICIAL_SERVICIO, CTA_FORMULARIO_SERVICIO } from '../src/services/whatsapp-formulario-servicio';

// ─── Argumentos ──────────────────────────────────────────────────────────────

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(`--${nombre}`);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
type Bloque = 'matriz' | 'guiones' | 'despues' | 'variantes' | 'anuncios' | 'flows' | 'pagos' | 'conversaciones';
const BLOQUES: Bloque[] = ['matriz', 'guiones', 'despues', 'variantes', 'anuncios', 'flows', 'pagos', 'conversaciones'];
const ESCUELA = arg('escuela');
const VARIANTES_PEDIDAS = arg('variante')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const SOLO_CRUDO = arg('solo')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const SOLO: Bloque[] = SOLO_CRUDO
    ? SOLO_CRUDO.filter((s): s is Bloque => (BLOQUES as string[]).includes(s))
    : VARIANTES_PEDIDAS ? ['variantes'] : BLOQUES;
const ANIOS = arg('anios')?.split(',').map(Number).filter(Number.isInteger) ?? null;
const TRANSCRIPCION = arg('transcripcion');
const PARALELO = Math.max(1, Math.min(8, Number(arg('paralelo') ?? 3) || 3));
const VERBOSE = process.argv.includes('--verbose');
const MAX_TURNOS = 16;

// Los logs del bot ([llm] uso, avisos del cortafuegos…) tapan el resumen: se callan.
const log = console.log.bind(console);
if (!VERBOSE) {
    const nada = () => undefined;
    console.log = nada; console.info = nada; console.warn = nada; console.error = nada; console.debug = nada;
}

// ─── Fechas (Bogotá) ─────────────────────────────────────────────────────────

const hoyBogota = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const masDias = (fecha: string, n: number) => {
    const [y, m, d] = fecha.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** El primer día `dow` (0 = domingo) desde `desde` (incluido). */
const proximoDia = (dow: number, desde: string) => {
    for (let i = 0; i < 7; i++) if (diaDeLaSemana(masDias(desde, i)) === dow) return masDias(desde, i);
    return desde;
};

// ─── Contexto de la escuela (solo lectura) ───────────────────────────────────

interface FranjaBase {
    id: string; team_id: string | null; slot_date: string; start_time: string;
    max_capacity: number | null; reserved_count: number | null;
}

interface Escuela {
    id: string;
    nombre: string;
    embudo: boolean;
    bienvenida: string | null;
    sedes: BotonSede[];
    preguntas: PreguntaProspecto[];
    nombreClase: NombreClase | null;
    precio: number | null;
    separarHoras: number | null;
    diasSemana: number[] | null;
    rangos: RangoGrupo[];
    /** Abiertas y de hoy en adelante. */
    franjas: Map<string, FranjaBase>;
}

function armarEscuela(
    id: string, nombre: string, aj: AjustesWhatsAppEscuela, clase: AjustesClasePrueba | null,
    rangos: RangoGrupo[], slots: Fila[],
): Escuela {
    const hoy = hoyBogota();
    return {
        id, nombre,
        embudo: embudoActivo(aj),
        bienvenida: aj.bienvenida ?? null,
        sedes: aj.botonesSede ?? [],
        preguntas: aj.preguntasProspecto ?? [],
        nombreClase: clase?.nombreClase ?? null,
        precio: clase?.precio ?? null,
        separarHoras: clase?.separarHoras ?? null,
        diasSemana: clase?.diasSemana ?? null,
        rangos,
        franjas: new Map(slots
            .filter((s) => s.is_open !== false && String(s.slot_date).slice(0, 10) >= hoy)
            .map((s) => [String(s.id), {
                id: String(s.id), team_id: s.team_id ?? null, slot_date: String(s.slot_date).slice(0, 10),
                start_time: String(s.start_time), max_capacity: s.max_capacity ?? null, reserved_count: s.reserved_count ?? null,
            }])),
    };
}

async function cargarEscuela(clave: string): Promise<Escuela> {
    const esUuid = /^[0-9a-f-]{36}$/i.test(clave);
    const { data, error } = await supabase.from('schools').select('id, name').eq(esUuid ? 'id' : 'slug', clave).maybeSingle();
    if (error || !data) throw new Error(`No encontré la escuela «${clave}»`);
    const id = (data as any).id as string;
    const [aj, clase, rangos, slots] = await Promise.all([
        ajustesWhatsAppDeEscuela(id),
        ajustesClasePrueba(id),
        rangosDeEscuela(id),
        supabase.from('school_trial_slots').select('id, team_id, slot_date, start_time, max_capacity, reserved_count, is_open')
            .eq('school_id', id).eq('is_open', true).gte('slot_date', hoyBogota()).limit(2000),
    ]);
    if (!embudoActivo(aj)) throw new Error('Esta escuela no tiene el embudo del interesado (wa_preguntas_prospecto).');
    return armarEscuela(id, (data as any).name, aj, clase, rangos, (slots.data ?? []) as Fila[]);
}

/** Las filas completas que las variantes modifican (una sola lectura). */
interface FilasReales { settings: Fila; clase: Fila | null; slots: Fila[] }

async function leerFilasReales(schoolId: string): Promise<FilasReales> {
    const [ss, tc, sl] = await Promise.all([
        supabase.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle(),
        supabase.from('school_trial_class_settings').select('*').eq('school_id', schoolId).maybeSingle(),
        supabase.from('school_trial_slots').select('*').eq('school_id', schoolId).gte('slot_date', hoyBogota()).limit(1000),
    ]);
    if (ss.error || !ss.data) throw new Error(`No pude leer school_settings: ${ss.error?.message ?? 'sin fila'}`);
    return { settings: ss.data as Fila, clase: (tc.data as Fila | null) ?? null, slots: (sl.data ?? []) as Fila[] };
}

// ─── Tablas virtuales de una variante ────────────────────────────────────────

const VIRTUALES = TABLAS_VIRTUALES as unknown as Set<string>;

/** Mientras corre `fn`, esas tablas se sirven desde la memoria de cada conversación. */
async function conTablasVirtuales<T>(tablas: string[], fn: () => Promise<T>): Promise<T> {
    const agregadas = tablas.filter((t) => !VIRTUALES.has(t));
    for (const t of agregadas) VIRTUALES.add(t);
    limpiarCacheTextosClase();
    try {
        return await fn();
    } finally {
        for (const t of agregadas) VIRTUALES.delete(t);
        limpiarCacheTextosClase();
    }
}

const copia = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ─── Conversación ────────────────────────────────────────────────────────────

type Fase = 'embudo' | 'despues';

interface Turno {
    entrada: string; botonId: string | null; salidas: SalidaSimulada[]; bloqueadas: string[]; nota: string | null;
    fase: Fase;
    /** Callar aquí es lo correcto («gracias»). */
    silencioOk?: boolean;
    /** Lo puso la batería (el aviso de B4), no es un turno de la familia. */
    sistema?: boolean;
}

/** La nota del simulador al abrir el buzón: la familia no la ve. */
const esNotaDelSimulador = (s: SalidaSimulada) => /^\[se abre en el buz[oó]n/.test(s.texto ?? '');
const paraLaFamilia = (salidas: SalidaSimulada[]) => salidas.filter((s) => !esNotaDelSimulador(s));

let contadorN = 0;
const nuevoN = () => ++contadorN;

class Conversacion {
    turnos: Turno[] = [];
    /** Turnos copiados de la conversación de la que se bifurcó. */
    heredados = 0;
    fase: Fase = 'embudo';
    readonly sesion: SesionPrueba;

    constructor(readonly titulo: string, readonly schoolId: string, n: number, semilla: Record<string, Fila[]> = {}) {
        this.sesion = {
            contact_wa_id: `5730${String(n).padStart(8, '0')}`, school_id: schoolId, rol: 'prospecto',
            child_id: null, parent_id: null, estado: { tablas: copia(semilla) },
        };
    }

    contacto(): string { return contactoSintetico(this.sesion.contact_wa_id); }

    /**
     * `referral`: el mensaje viene de un anuncio (lo que Meta trae en `messages[].referral`).
     * `rpc`: respuestas fijas de RPC en este turno (p. ej. `wa_es_afiliado`).
     */
    async decir(texto: string, botonId: string | null = null, o: {
        silencioOk?: boolean; referral?: Record<string, unknown>; rpc?: Record<string, (args: any) => unknown>;
        /** El mensaje crudo de Meta (p. ej. un formulario terminado, `interactive.nfm_reply`). */
        raw?: Record<string, unknown>; rotulo?: string; waMessageId?: string;
    } = {}): Promise<SalidaSimulada[]> {
        const r = await turnoSimulado(this.sesion,
            {
                waMessageId: o.waMessageId ?? `qa-${randomUUID()}`, textBody: texto, botonId,
                ...(o.referral ? { referral: o.referral } : {}), ...(o.raw ? { raw: o.raw } : {}),
            },
            Date.now(), o.rpc ? { rpc: o.rpc } : {});
        const entrada = o.rotulo ?? (o.referral ? `${texto} ⟵ anuncio «${String(o.referral.headline ?? o.referral.source_id ?? '')}»` : texto);
        this.turnos.push({ entrada, botonId, salidas: r.salidas, bloqueadas: r.bloqueadas, nota: r.nota, fase: this.fase, silencioOk: o.silencioOk });
        return paraLaFamilia(r.salidas);
    }

    /** Los botones/filas del último mensaje que trajo opciones. */
    opciones(): { id: string; title: string; descripcion?: string }[] {
        const ultimas = this.turnos.at(-1)?.salidas ?? [];
        return [...ultimas].reverse().find((s) => s.opciones?.length)?.opciones ?? [];
    }

    tocar(pred: (o: { id: string; title: string }) => boolean): Promise<SalidaSimulada[]> | null {
        const o = this.opciones().find(pred);
        return o ? this.decir(o.title, o.id) : null;
    }

    ultimoTexto(): string {
        return paraLaFamilia(this.turnos.at(-1)?.salidas ?? []).map((s) => s.texto).join('\n');
    }

    /** ¿La familia recibió algo en el último turno? */
    hablo(): boolean { return paraLaFamilia(this.turnos.at(-1)?.salidas ?? []).length > 0; }

    /** Todo lo que le llegó a la familia en esta conversación (sin lo heredado). */
    textos(): string {
        return this.turnos.slice(this.heredados).flatMap((t) => paraLaFamilia(t.salidas).map((s) => s.texto)).join('\n');
    }

    salidas(): SalidaSimulada[] { return this.turnos.slice(this.heredados).flatMap((t) => paraLaFamilia(t.salidas)); }

    /** El estado del embudo que viaja en el payload del último saliente que lo trae. */
    datosEmbudo(): Record<string, any> | null {
        for (const t of [...this.turnos].reverse()) {
            for (const s of [...t.salidas].reverse()) {
                const d = (s.payload as any)?.datos_embudo;
                if (d) return d;
            }
        }
        return null;
    }

    sembrar(tabla: string, filas: Fila[]): void {
        (this.sesion.estado.tablas ??= {})[tabla] = copia(filas);
    }

    /**
     * Copia la conversación (memoria y turnos) con otro contacto y otra
     * conversación: cada bifurcación sigue por su lado sin pisar a las demás
     * (los frenos en memoria del bot van por conversación).
     */
    bifurcar(titulo: string): Conversacion {
        const nueva = new Conversacion(titulo, this.schoolId, nuevoN());
        const viejaConv = conversacionDePrueba(this.sesion);
        const nuevaConv = conversacionDePrueba(nueva.sesion);
        const json = JSON.stringify(this.sesion.estado.tablas ?? {})
            .split(viejaConv).join(nuevaConv)
            .split(this.contacto()).join(nueva.contacto());
        nueva.sesion.estado = { conversationId: nuevaConv, tablas: JSON.parse(json), bloqueadas: [] };
        nueva.turnos = this.turnos.map((t) => ({ ...t }));
        nueva.heredados = this.turnos.length;
        nueva.fase = this.fase;
        return nueva;
    }

    /**
     * Un saliente que no salió de un turno del bot (p. ej. la confirmación de B4).
     * `ai_generated: true` como lo graba el job (`wa_record_outbound_message`): con
     * false el bot lo toma por una persona de la escuela y se calla.
     */
    inyectarSaliente(rotulo: string, texto: string, payload: Record<string, unknown>): void {
        const tablas = (this.sesion.estado.tablas ??= {});
        const conv = (tablas.whatsapp_conversations ?? [])[0];
        const ahora = new Date(Date.now() + 1000).toISOString();
        (tablas.whatsapp_messages ??= []).push({
            id: randomUUID(), conversation_id: conversacionDePrueba(this.sesion), integration_id: conv?.integration_id ?? null,
            direction: 'outbound', type: 'text', text_body: texto, payload, ai_generated: true,
            wa_message_id: `qa-${randomUUID()}`, from_wa_id: null, to_wa_id: this.contacto(),
            wa_timestamp: ahora, created_at: ahora, status: 'sent',
        });
        this.turnos.push({
            entrada: rotulo, botonId: null, salidas: [{ texto, step: String(payload.step ?? ''), botones: [], payload } as SalidaSimulada],
            bloqueadas: [], nota: null, fase: this.fase, sistema: true,
        });
    }
}

// ─── Revisión de cada mensaje ────────────────────────────────────────────────

const BASURA = /\b(undefined|NaN)\b|\[object |\{\{|\bnull\b/;
const REGLA_SIN_RESOLVER = /\d\s*\.?\s*(er|º|°|do|ro|to)\b[^\n]{0,30}(del mes)?\s*:/i;
const GRATIS = /\b(gratis|sin costo|gratuit[ao])\b/gi;

/**
 * ¿Dice que la CLASE es gratis? En los mensajes del embudo, cualquier «gratis»
 * cuenta. En los demás (el modelo) solo cerca de «clase/prueba/cortesía» y no
 * pegado a otra cosa («la mensualidad de noviembre es GRATIS» es la promo de
 * Monster, no la clase).
 */
function diceClaseGratis(texto: string, estricto: boolean): boolean {
    if (estricto) return /\b(gratis|sin costo|gratuit[ao])\b/i.test(texto);
    for (const m of texto.matchAll(GRATIS)) {
        const i = m.index ?? 0;
        if (/mensualidad|noviembre|matr[ií]cula|uniforme/i.test(texto.slice(Math.max(0, i - 35), i + 20))) continue;
        if (/\bclase\b|\bprueba\b|cortes[ií]a/i.test(texto.slice(Math.max(0, i - 60), i + 30))) return true;
    }
    return false;
}

function revisarMensaje(s: SalidaSimulada, escuela: Escuela): string[] {
    const fallas: string[] = [];
    const texto = s.texto ?? '';
    if (escuela.precio && diceClaseGratis(texto, String(s.step ?? '').startsWith('embudo_'))) {
        fallas.push('dice «gratis» y la clase tiene valor');
    }
    if (BASURA.test(texto)) fallas.push(`texto con basura: «${texto.match(BASURA)![0]}»`);
    if (texto.length > 4096) fallas.push(`mensaje de ${texto.length} caracteres (máx. 4096)`);
    const renglones = texto.split('\n').map((r) => r.trim()).filter((r) => r.length > 12);
    const repetido = renglones.find((r, i) => renglones.indexOf(r) !== i);
    if (repetido) fallas.push(`renglón repetido: «${repetido.slice(0, 60)}»`);
    const ops = s.opciones ?? [];
    const esLista = ops.length > 3 || ops.some((o) => o.descripcion);
    for (const o of ops) {
        const max = esLista ? 24 : 20;
        if (o.title.length > max) fallas.push(`título de ${esLista ? 'fila' : 'botón'} de ${o.title.length} (máx. ${max}): «${o.title}»`);
        if ((o.descripcion ?? '').length > 72) fallas.push(`descripción de ${o.descripcion!.length} (máx. 72): «${o.descripcion}»`);
        if (REGLA_SIN_RESOLVER.test(`${o.title} ${o.descripcion ?? ''}`)) fallas.push(`regla de cancha sin resolver: «${o.descripcion ?? o.title}»`);
        if (BASURA.test(`${o.title} ${o.descripcion ?? ''}`)) fallas.push(`opción con basura: «${o.title} ${o.descripcion ?? ''}»`);
        if (/·\s*$/.test(o.descripcion ?? '')) fallas.push(`descripción cortada: «${o.descripcion}»`);
    }
    return fallas;
}

// ─── El interesado automático ────────────────────────────────────────────────

interface Perfil { sede: BotonSede | null; anio: number; genero: 'f' | 'm'; trayectoria: number; nombre: string }

type Desenlace = 'pago' | 'agendada' | 'persona' | 'sin_horarios' | 'club' | 'inicio' | 'respuesta' | 'silencio'
    | 'atascado' | 'no_aplica';

interface Resultado {
    titulo: string;
    bloque: Bloque;
    variante: string | null;
    desenlace: Desenlace;
    /** Bugs del bot. */
    fallas: string[];
    /** Fallas conocidas con arreglo en curso (silencio después del embudo). */
    esperadas: string[];
    /** Lo que la simulación no puede representar (no cuenta como falla). */
    limitaciones: string[];
    avisos: string[];
    grupo: string | null;
    /** La «otra sede» que se tocó (`sm_em_otra:`). */
    otraSede: string | null;
    franjasOfrecidas: string[];
    /** Pasar a una persona es lo esperado (la pidió, sin cuentas, otra sede…). */
    personaEsperada: boolean;
    sinHorariosEsperado: boolean;
    conv: Conversacion;
}

const ultimaLinea = (t: string) => t.trim().split('\n').filter(Boolean).at(-1) ?? t;

function preguntaEn(texto: string, preguntas: PreguntaProspecto[]): { p: PreguntaProspecto; detalle: boolean } | null {
    for (const p of preguntas) {
        if (texto.includes(ultimaLinea(p.texto))) return { p, detalle: false };
        if (p.detalle && texto.includes(ultimaLinea(p.detalle.texto))) return { p, detalle: true };
    }
    return null;
}

/** ¿El último turno cerró el embudo? Por el step del mensaje (y el texto, de respaldo). */
function desenlaceDe(conv: Conversacion): Desenlace | null {
    const ult = paraLaFamilia(conv.turnos.at(-1)?.salidas ?? []);
    const s = ult.at(-1);
    const texto = conv.turnos.at(-1)?.salidas.map((x) => x.texto).join('\n') ?? '';
    if (s?.step === PASO_EMBUDO.A_PERSONA || /^\[se abre en el buz[oó]n/m.test(texto) || /te escriben por aqu[ií]/i.test(texto)) {
        return /no tengo horarios/i.test(texto) ? 'sin_horarios' : 'persona';
    }
    if (s?.step === PASO_EMBUDO.PAGO || (/comprobante/i.test(texto) && /\$|valor|paga/i.test(texto))) return 'pago';
    if (s?.step === PASO_EMBUDO.AGENDADA && !s.opciones?.length) return 'agendada';
    return null;
}

/** Sigue contestando lo que pregunte el bot hasta un desenlace. */
async function seguir(conv: Conversacion, escuela: Escuela, perfil: Perfil, r: Resultado): Promise<void> {
    for (let i = 0; i < MAX_TURNOS; i++) {
        const fin = desenlaceDe(conv);
        if (fin) { r.desenlace = fin; return; }
        if (!conv.hablo()) { r.desenlace = 'atascado'; return; } // el silencio lo anota `cerrar`
        const texto = conv.ultimoTexto();
        const ops = conv.opciones();

        let salidas: SalidaSimulada[] | null = null;
        if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE))) {
            salidas = perfil.sede ? await conv.tocar((o) => o.id === `${BOTON_EMBUDO.SEDE}${perfil.sede!.branchId}`) : null;
        } else if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA))) {
            revisarGrupoYFranjas(conv, escuela, perfil, r);
            salidas = await conv.tocar((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA));
        } else if (ops.some((o) => o.id === BOTON_EMBUDO.OPTIN_SI)) {
            salidas = await conv.tocar((o) => o.id === BOTON_EMBUDO.OPTIN_SI);
        } else if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.OTRA_SEDE))) {
            const otra = ops.find((o) => o.id.startsWith(BOTON_EMBUDO.OTRA_SEDE))!;
            r.otraSede = otra.id.slice(BOTON_EMBUDO.OTRA_SEDE.length);
            r.avisos.push(`sin grupo en ${sinEmojis(perfil.sede?.titulo ?? 'la sede')}: ofreció otra sede`);
            salidas = await conv.tocar((o) => o.id === otra.id);
        } else {
            const q = preguntaEn(texto, escuela.preguntas);
            if (!q) { r.desenlace = 'atascado'; r.fallas.push(`no reconozco qué pide el bot: «${ultimaLinea(texto).slice(0, 90)}»`); return; }
            salidas = await contestar(conv, q.p, q.detalle, perfil);
        }
        if (!salidas) { r.desenlace = 'atascado'; r.fallas.push(`no encontré el botón que buscaba entre: ${ops.map((o) => `[${o.title}]`).join(' ')}`); return; }
    }
    r.desenlace = 'atascado';
    r.fallas.push(`más de ${MAX_TURNOS} turnos sin llegar a un desenlace`);
}

function contestar(conv: Conversacion, p: PreguntaProspecto, detalle: boolean, perfil: Perfil): Promise<SalidaSimulada[]> | null {
    if (detalle) return conv.decir('Entrenó dos años en un club de Engativá y jugó los Intercolegiados');
    if (p.tipo === 'texto') return conv.decir(perfil.nombre);
    if (p.tipo === 'fecha') return conv.decir(`14/03/${perfil.anio}`);
    const opciones = p.opciones ?? [];
    let j = perfil.trayectoria % Math.max(1, opciones.length);
    if (/sexo|genero|g[eé]nero/i.test(p.clave)) {
        const re = perfil.genero === 'f' ? /mujer|femenin|niña/i : /hombre|masculin|niño/i;
        j = Math.max(0, opciones.findIndex((o) => re.test(o.titulo)));
    }
    const elegida = opciones[j]?.titulo;
    return elegida ? conv.tocar((o) => o.title === elegida) : null;
}

/** El grupo asignado y las franjas ofrecidas, contra los datos de la escuela. */
function revisarGrupoYFranjas(conv: Conversacion, escuela: Escuela, perfil: Perfil, r: Resultado): void {
    const d = conv.datosEmbudo();
    const rango = escuela.rangos.find((x) => x.teamId === d?.teamId);
    if (!rango) { r.fallas.push('ofrece horarios sin un grupo identificable'); return; }
    r.grupo = rango.nombre;
    if (rango.recibeClasePrueba === false) r.fallas.push(`${rango.nombre}: no recibe clase de prueba`);
    if (/competen/i.test(rango.nombre)) r.fallas.push(`${rango.nombre}: es de Competencia (la clase de prueba va a Proyección)`);
    if ((rango.anioMin != null && perfil.anio < rango.anioMin) || (rango.anioMax != null && perfil.anio > rango.anioMax)) {
        r.fallas.push(`${rango.nombre}: recibe ${rango.anioMin ?? '…'}–${rango.anioMax ?? '…'} y el deportista es de ${perfil.anio}`);
    }
    if (rango.genero && rango.genero !== 'mixto' && rango.genero !== perfil.genero) {
        r.fallas.push(`${rango.nombre}: es ${rango.genero} y el deportista es ${perfil.genero}`);
    }
    if (rango.branchId && perfil.sede && rango.branchId !== perfil.sede.branchId && rango.branchId !== r.otraSede) {
        r.fallas.push(`${rango.nombre}: es de otra sede y no se ofreció como tal`);
    }
    revisarFranjas(conv, escuela, rango.teamId, r);
}

/** Las franjas del último mensaje: de ese grupo, abiertas, con cupo bien contado, en días y horas válidos. */
function revisarFranjas(conv: Conversacion, escuela: Escuela, teamId: string, r: Resultado): void {
    const limite = Date.now() + ANTICIPACION_MIN_EMBUDO * 60_000;
    const filas = conv.opciones().filter((x) => x.id.startsWith(BOTON_EMBUDO.FRANJA));
    r.franjasOfrecidas = filas.map((o) => o.id.slice(BOTON_EMBUDO.FRANJA.length));
    for (const o of filas) {
        const f = escuela.franjas.get(o.id.slice(BOTON_EMBUDO.FRANJA.length));
        if (!f) { r.fallas.push(`franja «${o.title}» no está abierta en la base`); continue; }
        if (f.team_id !== teamId) r.fallas.push(`franja «${o.title}» es de otro grupo`);
        if (escuela.diasSemana && !escuela.diasSemana.includes(diaDeLaSemana(f.slot_date))) r.fallas.push(`franja «${o.title}» cae en un día sin agenda`);
        const inicio = Date.parse(`${f.slot_date}T${String(f.start_time).slice(0, 5)}:00-05:00`);
        if (inicio < limite) r.fallas.push(`franja «${o.title}» empieza en menos de ${ANTICIPACION_MIN_EMBUDO} min`);
        const max = Number(f.max_capacity ?? 0);
        const libres = max - Number(f.reserved_count ?? 0);
        if (libres <= 0) r.fallas.push(`franja «${o.title}» está llena (${f.reserved_count}/${f.max_capacity})`);
        else if (max < 999 && !new RegExp(`(^|\\D)${libres} cupos?\\b`).test(o.descripcion ?? '')) {
            r.fallas.push(`franja «${o.title}» dice «${o.descripcion ?? ''}» y le quedan ${libres} cupo${libres === 1 ? '' : 's'}`);
        }
    }
}

/** ¿Algún grupo que recibe clase de prueba acepta este año y sexo? (en la sede, o en cualquiera de las sedes con botón) */
function hayGrupoPara(escuela: Escuela, perfil: Perfil, soloSede: boolean): boolean {
    const sedes = new Set(escuela.sedes.map((s) => s.branchId));
    return escuela.rangos.some((x) => x.recibeClasePrueba !== false && x.admiteNuevos !== false
        && !/competen/i.test(x.nombre)
        && (x.anioMin != null || x.anioMax != null)
        && (x.anioMin == null || perfil.anio >= x.anioMin) && (x.anioMax == null || perfil.anio <= x.anioMax)
        && (!x.genero || x.genero === 'mixto' || x.genero === perfil.genero)
        && (!sedes.size || !x.branchId || sedes.has(x.branchId))
        && (!soloSede || !perfil.sede || !x.branchId || x.branchId === perfil.sede.branchId));
}

function nuevoResultado(titulo: string, conv: Conversacion, bloque: Bloque, variante: string | null = null): Resultado {
    return {
        titulo, bloque, variante, desenlace: 'atascado', fallas: [], esperadas: [], limitaciones: [], avisos: [],
        grupo: null, otraSede: null, franjasOfrecidas: [], personaEsperada: false, sinHorariosEsperado: false, conv,
    };
}

const SILENCIO_POST = 'silencio después del embudo (arreglo en curso)';

function cerrar(r: Resultado, escuela: Escuela, perfil: Perfil | null): Resultado {
    let silencioAnotado = false;
    for (const t of r.conv.turnos.slice(r.conv.heredados)) {
        if (t.sistema) continue;
        if (!paraLaFamilia(t.salidas).length && !t.silencioOk) {
            const f = `el bot no le contestó nada a la familia ante «${t.entrada.slice(0, 50)}»${t.nota ? ` (${t.nota})` : ''}`;
            if (t.fase === 'despues') r.esperadas.push(`${SILENCIO_POST}: ${f}`);
            else if (!silencioAnotado) { r.fallas.push(f); silencioAnotado = true; }
        }
        for (const s of paraLaFamilia(t.salidas)) for (const f of revisarMensaje(s, escuela)) r.fallas.push(f);
    }
    if (perfil && !r.personaEsperada && r.desenlace === 'persona' && hayGrupoPara(escuela, perfil, false)) {
        r.fallas.push('pasó a una persona aunque hay un grupo que recibe este perfil');
    }
    if (perfil && !r.sinHorariosEsperado && r.desenlace === 'sin_horarios' && hayGrupoPara(escuela, perfil, false)) {
        r.fallas.push('hay grupo para este perfil pero no tiene franjas abiertas');
    }
    r.fallas = [...new Set(r.fallas)];
    r.esperadas = [...new Set(r.esperadas)];
    r.limitaciones = [...new Set(r.limitaciones)];
    r.avisos = [...new Set(r.avisos)];
    return r;
}

// ─── Perfiles que sirven a cada escenario (de los datos de la escuela) ───────

const NOMBRES_F = ['Mariana Gómez Ruiz', 'Valentina Rojas', 'Sara Lucía Pérez', 'Isabella Torres'];
const NOMBRES_M = ['Santiago Pérez Rojas', 'Samuel Díaz', 'Juan José Martínez', 'Tomás Herrera'];
const ANIO = new Date().getFullYear();
const nombreDe = (genero: 'f' | 'm', k: number) => (genero === 'f' ? NOMBRES_F : NOMBRES_M)[k % 4];
const generoTexto = (g: 'f' | 'm') => (g === 'f' ? 'mujer' : 'hombre');
const tituloPerfil = (p: Perfil) => `${sinEmojis(p.sede?.titulo ?? 'sin sede')} · ${p.anio} · ${generoTexto(p.genero)}`;

const tieneFranjas = (e: Escuela, teamId: string) =>
    [...e.franjas.values()].some((f) => f.team_id === teamId && Number(f.max_capacity ?? 0) > Number(f.reserved_count ?? 0)
        && (!e.diasSemana || e.diasSemana.includes(diaDeLaSemana(f.slot_date))));

const grupoEsperado = (e: Escuela, p: Perfil) => elegirGrupoEmbudo(e.rangos, { branchId: p.sede?.branchId ?? null, anio: p.anio, genero: p.genero });

/** Hasta `k` perfiles que caen en grupos DISTINTOS con franjas (alternando sede y sexo). */
function perfilesConGrupo(e: Escuela, k: number, o: { sede?: BotonSede | null; genero?: 'f' | 'm' } = {}): Perfil[] {
    const anios = [ANIO - 14, ANIO - 10, ANIO - 17, ANIO - 30, ANIO - 12, ANIO - 8, ANIO - 16, ANIO - 19];
    const sedes = o.sede !== undefined ? [o.sede] : e.sedes.length ? e.sedes : [null];
    const generos: ('f' | 'm')[] = o.genero ? [o.genero] : ['f', 'm'];
    const salida: Perfil[] = [];
    const equipos = new Set<string>();
    for (const anio of anios) for (const genero of generos) for (const sede of sedes) {
        const p: Perfil = { sede, anio, genero, trayectoria: salida.length % 3, nombre: nombreDe(genero, salida.length) };
        const g = grupoEsperado(e, p).principal;
        if (!g || equipos.has(g.teamId) || !tieneFranjas(e, g.teamId)) continue;
        equipos.add(g.teamId);
        salida.push(p);
        if (salida.length >= k) return salida;
    }
    return salida;
}

/** Sin grupo en su sede, con grupo (y franjas) en otra sede con botón. */
function perfilSinGrupoEnSede(e: Escuela, sede?: BotonSede): Perfil | null {
    const ids = new Set(e.sedes.map((s) => s.branchId));
    for (let anio = ANIO - 3; anio >= ANIO - 25; anio--) for (const s of sede ? [sede] : e.sedes) for (const genero of ['f', 'm'] as const) {
        const p: Perfil = { sede: s, anio, genero, trayectoria: 0, nombre: nombreDe(genero, anio) };
        const el = grupoEsperado(e, p);
        if (!el.principal && el.otraSede?.branchId && ids.has(el.otraSede.branchId) && tieneFranjas(e, el.otraSede.teamId)) return p;
    }
    return null;
}

/** Un menor sin grupo en NINGUNA sede. */
function perfilSinGrupo(e: Escuela): Perfil | null {
    for (let anio = ANIO - 4; anio >= ANIO - 8; anio--) {
        const p: Perfil = { sede: e.sedes[0] ?? null, anio, genero: 'f', trayectoria: 0, nombre: 'Sara Lucía Pérez' };
        if (!hayGrupoPara(e, p, false)) return p;
    }
    return null;
}

// ─── Utilidades de los escenarios ────────────────────────────────────────────

const debe = (r: Resultado, ok: boolean, falla: string) => { if (!ok) r.fallas.push(falla); };
const preguntoClave = (texto: string, e: Escuela, clave: string) => {
    const p = e.preguntas.find((x) => x.clave === clave);
    return !!p && texto.includes(ultimaLinea(p.texto));
};
const claveDe = (e: Escuela, tipo: PreguntaProspecto['tipo']) => e.preguntas.find((p) => p.tipo === tipo)?.clave ?? '';
const noAplica = (r: Resultado, porque: string): null => { r.desenlace = 'no_aplica'; r.avisos.push(`no aplica a esta escuela: ${porque}`); return null; };
const huboPaso = (c: Conversacion, step: string) => c.salidas().some((s) => s.step === step);
const huboOpcion = (c: Conversacion, pred: (id: string) => boolean) => c.salidas().some((s) => (s.opciones ?? []).some((o) => pred(o.id)));

function perfilDe(e: Escuela, o: Partial<Perfil> = {}): Perfil {
    return { sede: e.sedes.at(-1) ?? null, anio: ANIO - 14, genero: 'f', trayectoria: 1, nombre: 'Mariana Gómez Ruiz', ...o };
}

async function hastaPregunta(c: Conversacion, e: Escuela, sede: BotonSede | null): Promise<void> {
    await c.decir('Hola');
    if (sede) await c.tocar((o) => o.id === `${BOTON_EMBUDO.SEDE}${sede.branchId}`);
}

/** Como `seguir`, pero se detiene cuando aparece la opción buscada (sin tocarla). */
async function seguirHasta(c: Conversacion, e: Escuela, perfil: Perfil, parar: (o: { id: string }) => boolean): Promise<boolean> {
    for (let i = 0; i < MAX_TURNOS; i++) {
        if (c.opciones().some(parar)) return true;
        const antes = c.turnos.length;
        const ops = c.opciones();
        if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE)) && perfil.sede) await c.tocar((o) => o.id === `${BOTON_EMBUDO.SEDE}${perfil.sede!.branchId}`);
        else if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA))) await c.tocar((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA));
        else {
            const q = preguntaEn(c.ultimoTexto(), e.preguntas);
            if (!q) return false;
            await contestar(c, q.p, q.detalle, perfil);
        }
        if (c.turnos.length === antes) return false;
    }
    return false;
}

/** Corre `fn` sobre cada elemento con hasta PARALELO a la vez; conserva el orden. */
async function enParalelo<T, R>(items: T[], fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
    const salida: R[] = new Array(items.length);
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(PARALELO, items.length) }, async () => {
        while (k < items.length) {
            const i = k++;
            salida[i] = await fn(items[i], i);
        }
    }));
    return salida;
}

const progreso = (r: Resultado) => process.stdout.write(r.fallas.length ? 'F' : r.esperadas.length ? 'e' : r.limitaciones.length ? 'l' : '.');

async function protegido(r: Resultado, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (e: any) {
        r.fallas.push(`la batería falló: ${String(e?.message ?? e).slice(0, 200)}`);
    }
}

// ─── Matriz ──────────────────────────────────────────────────────────────────

function aniosDeLaMatriz(escuela: Escuela): number[] {
    if (ANIOS?.length) return ANIOS;
    const bordes = escuela.rangos.flatMap((x) => [x.anioMin, x.anioMax]).filter((a): a is number => typeof a === 'number');
    const desde = Math.max(ANIO - 60, Math.min(...bordes, ANIO - 18) - 1);
    const hasta = Math.min(ANIO - 3, Math.max(...bordes, ANIO - 6) + 1);
    const anios = new Set<number>();
    for (let a = desde; a <= hasta; a++) if (a >= ANIO - 25) anios.add(a);
    anios.add(ANIO - 30); // un adulto
    return [...anios].sort();
}

async function correrMatriz(escuela: Escuela): Promise<Resultado[]> {
    const perfiles: Perfil[] = [];
    for (const sede of escuela.sedes) for (const anio of aniosDeLaMatriz(escuela)) for (const genero of ['f', 'm'] as const) {
        perfiles.push({ sede, anio, genero, trayectoria: perfiles.length % 3, nombre: nombreDe(genero, perfiles.length) });
    }
    const rs = await enParalelo(perfiles, async (perfil) => {
        const conv = new Conversacion(tituloPerfil(perfil), escuela.id, nuevoN());
        const r = nuevoResultado(conv.titulo, conv, 'matriz');
        await protegido(r, async () => {
            await conv.decir('Hola, quiero información para entrenar voleibol');
            await seguir(conv, escuela, perfil, r);
        });
        cerrar(r, escuela, perfil);
        progreso(r);
        return r;
    });
    process.stdout.write('\n');
    return rs;
}

// ─── Guiones (texto libre y caminos sueltos) ─────────────────────────────────

interface Guion {
    titulo: string;
    /** Devuelve el perfil para que el interesado automático termine la conversación, o null si ya terminó. */
    correr: (c: Conversacion, e: Escuela, r: Resultado) => Promise<Perfil | null>;
    /** Revisión al final (después de que el interesado automático terminó). */
    verificar?: (c: Conversacion, e: Escuela, r: Resultado) => void;
}

/** Hasta que ofrezca «Ver Sede X»; null si no aplica o no llegó. */
async function hastaOtraSede(c: Conversacion, e: Escuela, r: Resultado): Promise<Perfil | null> {
    const perfil = perfilSinGrupoEnSede(e);
    if (!perfil) return noAplica(r, 'ningún perfil se queda sin grupo en una sede y lo tiene en otra');
    await c.decir('Hola');
    const ok = await seguirHasta(c, e, perfil, (o) => o.id.startsWith(BOTON_EMBUDO.OTRA_SEDE));
    if (!ok) { r.fallas.push(`${tituloPerfil(perfil)}: no ofreció la otra sede`); return null; }
    debe(r, /no tengo un grupo/i.test(c.ultimoTexto()), 'no explicó que en esa sede no hay grupo');
    debe(r, c.opciones().some((o) => o.id === BOTON_EMBUDO.PERSONA), 'falta el botón «Hablar con alguien»');
    return perfil;
}

const GUIONES: Guion[] = [
    {
        titulo: 'pregunta el precio de entrada (no puede decir «gratis»)',
        correr: async (c, e, r) => {
            await c.decir('Buenas tardes, cuánto vale la clase de prueba?');
            debe(r, c.opciones().some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE)) || !e.sedes.length, 'no arrancó el embudo con los botones de sede');
            r.desenlace = 'inicio';
            return null;
        },
    },
    {
        titulo: 'varias respuestas en un mensaje (nombre, fecha y posición)',
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { anio: ANIO - 17, genero: 'm', nombre: 'Santiago Pérez Rojas' });
            await hastaPregunta(c, e, perfil.sede);
            const lista = e.preguntas.find((p) => p.tipo === 'lista');
            const extra = lista?.opciones?.[3]?.titulo?.toLowerCase() ?? '';
            await c.decir(`Santiago Pérez Rojas, 10/07/${perfil.anio}${extra ? `, ${extra}` : ''}`);
            const t = c.ultimoTexto();
            debe(r, !preguntoClave(t, e, claveDe(e, 'fecha')), 'volvió a preguntar la fecha que ya le dieron');
            if (lista) debe(r, !preguntoClave(t, e, lista.clave), `volvió a preguntar «${lista.clave}» que ya le dieron`);
            return perfil;
        },
    },
    {
        titulo: 'varias respuestas en OTRO orden («fecha, sexo, nombre, posición»)',
        correr: async (c, e, r) => {
            const lista = e.preguntas.find((p) => p.tipo === 'lista');
            const sexo = e.preguntas.find((p) => p.clave === 'sexo');
            const perfil = perfilDe(e, { anio: ANIO - 14, genero: 'f', nombre: 'Valentina Rojas' });
            await hastaPregunta(c, e, perfil.sede);
            const posicion = lista?.opciones?.[3]?.titulo?.toLowerCase() ?? '';
            await c.decir(`${perfil.anio}-05-20, mujer, Valentina Rojas${posicion ? `, ${posicion}` : ''}`);
            const t = c.ultimoTexto();
            debe(r, /Valentina/.test(t), 'no tomó «Valentina Rojas» como el nombre');
            debe(r, !preguntoClave(t, e, claveDe(e, 'fecha')), 'volvió a preguntar la fecha que ya le dieron');
            if (sexo) debe(r, !preguntoClave(t, e, sexo.clave), 'volvió a preguntar el sexo que ya le dieron');
            if (lista) debe(r, !preguntoClave(t, e, lista.clave), `volvió a preguntar «${lista.clave}» que ya le dieron`);
            return perfil;
        },
    },
    ...[`14 de marzo de ${ANIO - 14}`, `${ANIO - 14}-03-14`, `14-03-${ANIO - 14}`, `marzo 14 del ${ANIO - 14}`].map((fecha): Guion => ({
        titulo: `fecha escrita «${fecha}»`,
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { anio: ANIO - 14 });
            await hastaPregunta(c, e, perfil.sede);
            await c.decir(perfil.nombre);
            await c.decir(fecha);
            debe(r, !preguntoClave(c.ultimoTexto(), e, claveDe(e, 'fecha')), `no entendió la fecha «${fecha}»`);
            return perfil;
        },
    })),
    {
        titulo: 'adulto escribe solo el año («nació en …»)',
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { anio: ANIO - 36, genero: 'm', nombre: 'Juan José Martínez' });
            await hastaPregunta(c, e, perfil.sede);
            await c.decir(perfil.nombre);
            await c.decir(`nació en ${perfil.anio}`);
            debe(r, !preguntoClave(c.ultimoTexto(), e, claveDe(e, 'fecha')), `no aceptó solo el año (${perfil.anio})`);
            return perfil;
        },
        verificar: (c, e, r) => debe(r, r.desenlace === 'pago' || r.desenlace === 'agendada', `el adulto terminó en «${r.desenlace}»`),
    },
    {
        titulo: 'escribe la sede en vez de tocar el botón',
        correr: async (c, e, r) => {
            const sede = e.sedes.at(-1);
            if (!sede) return noAplica(r, 'sin botones de sede');
            await c.decir('Hola');
            const palabra = normalizar(sinEmojis(sede.titulo)).split(' ').at(-1)!;
            await c.decir(palabra);
            debe(r, preguntoClave(c.ultimoTexto(), e, e.preguntas[0].clave), `no tomó «${palabra}» como la sede`);
            return perfilDe(e, { sede });
        },
    },
    {
        titulo: 'sede escrita mal dos veces → una persona',
        correr: async (c, e, r) => {
            if (!e.sedes.length) return noAplica(r, 'sin botones de sede');
            await c.decir('Hola');
            await c.decir('en el centro');
            debe(r, c.opciones().some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE)), 'tras la primera sede que no entendió no volvió a mostrar las sedes');
            await c.decir('cerca de mi casa');
            r.personaEsperada = true;
            r.desenlace = desenlaceDe(c) ?? 'atascado';
            debe(r, r.desenlace === 'persona', 'tras dos sedes que no entendió no pasó a una persona');
            return null;
        },
    },
    {
        titulo: 'sede sin grupo → «Ver Sede X» (botón) → sigue en la otra sede',
        correr: async (c, e, r) => {
            const perfil = await hastaOtraSede(c, e, r);
            return perfil; // el interesado automático toca «Ver Sede X» y revisa que el grupo sea de esa sede
        },
        verificar: (c, e, r) => {
            if (r.desenlace === 'no_aplica') return;
            debe(r, !!r.otraSede, 'no llegó a tocar «Ver Sede X»');
            debe(r, r.desenlace === 'pago', `después de la otra sede terminó en «${r.desenlace}»`);
        },
    },
    {
        titulo: 'sede sin grupo → contesta «sí» por texto a la otra sede',
        correr: async (c, e, r) => {
            const perfil = await hastaOtraSede(c, e, r);
            if (!perfil) return null;
            const otra = c.opciones().find((o) => o.id.startsWith(BOTON_EMBUDO.OTRA_SEDE))!;
            await c.decir('sí, de una');
            const franjas = c.opciones().some((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA));
            debe(r, franjas, 'no entendió el «sí» a la otra sede (no mostró horarios)');
            if (!franjas) return null;
            r.otraSede = otra.id.slice(BOTON_EMBUDO.OTRA_SEDE.length);
            return perfil;
        },
    },
    {
        titulo: 'sede sin grupo → toca «Hablar con alguien»',
        correr: async (c, e, r) => {
            const perfil = await hastaOtraSede(c, e, r);
            if (!perfil) return null;
            await c.tocar((o) => o.id === BOTON_EMBUDO.PERSONA);
            r.personaEsperada = true;
            r.desenlace = desenlaceDe(c) ?? 'atascado';
            debe(r, r.desenlace === 'persona', '«Hablar con alguien» no pasó a una persona');
            return null;
        },
    },
    {
        titulo: 'menor sin grupo en ninguna sede → una persona («no encontré un grupo»)',
        correr: async (c, e, r) => {
            const perfil = perfilSinGrupo(e);
            if (!perfil) return noAplica(r, 'todo año de 4 a 8 años tiene grupo');
            r.titulo = `${r.titulo} · ${perfil.anio}`;
            await c.decir('Hola');
            return perfil;
        },
        verificar: (c, e, r) => {
            if (r.desenlace === 'no_aplica') return;
            debe(r, r.desenlace === 'persona', `un menor sin grupo terminó en «${r.desenlace}»`);
            debe(r, /no encontr[eé] un grupo/i.test(c.textos()), 'no le dijo que no hay un grupo para su año');
            debe(r, !huboOpcion(c, (id) => id.startsWith(BOTON_EMBUDO.FRANJA)), 'le ofreció horarios a un menor sin grupo');
        },
    },
    ...[{ que: 'el nombre', k: 2, escribir: (t: string) => normalizar(sinEmojis(t)).split(' ')[0] }, { que: 'el número', k: 1, escribir: (_t: string) => '2' }]
        .map(({ que, k, escribir }): Guion => ({
            titulo: `lista (posición) contestada escribiendo ${que} en vez de tocar la fila`,
            correr: async (c, e, r) => {
                const lista = e.preguntas.find((p) => p.tipo === 'lista');
                if (!lista?.opciones?.[k]) return noAplica(r, 'sin pregunta de lista');
                const perfil = perfilDe(e, { sede: e.sedes[0] ?? null, anio: ANIO - 12 });
                await c.decir('Hola');
                const llego = await seguirHasta(c, e, perfil, (o) => o.id.startsWith(`${BOTON_EMBUDO.OPCION}${lista.clave}:`));
                if (!llego) { r.fallas.push(`no llegó a la pregunta «${lista.clave}»`); return null; }
                const opcion = lista.opciones[k].titulo;
                await c.decir(escribir(opcion));
                debe(r, !preguntoClave(c.ultimoTexto(), e, lista.clave), `no entendió «${escribir(opcion)}» como «${opcion}»`);
                debe(r, c.datosEmbudo()?.respuestas?.[lista.clave] === opcion,
                    `guardó «${c.datosEmbudo()?.respuestas?.[lista.clave] ?? '—'}» y escribió «${escribir(opcion)}» (= «${opcion}»)`);
                return perfil;
            },
        })),
    {
        titulo: 'trayectoria «Club y torneos» → pregunta en qué clubes y lo guarda',
        correr: async (c, e, r) => {
            const p = e.preguntas.find((x) => x.detalle && x.opciones?.length);
            const j = p ? (p.opciones ?? []).findIndex((o) => p.detalle!.si.some((s) => normalizar(s) === normalizar(o.titulo))) : -1;
            if (!p || j < 0) return noAplica(r, 'ninguna pregunta tiene detalle');
            await c.decir('Hola');
            return perfilDe(e, { sede: e.sedes[0] ?? null, anio: ANIO - 16, genero: 'm', trayectoria: j, nombre: 'Tomás Herrera' });
        },
        verificar: (c, e, r) => {
            if (r.desenlace === 'no_aplica') return;
            const p = e.preguntas.find((x) => x.detalle)!;
            debe(r, c.textos().includes(ultimaLinea(p.detalle!.texto)), 'no preguntó el detalle de la trayectoria');
            debe(r, !!c.datosEmbudo()?.respuestas?.[p.detalle!.clave], `no guardó «${p.detalle!.clave}»`);
        },
    },
    {
        titulo: '«Ya soy del club» no entra al embudo',
        correr: async (c, e, r) => {
            await c.decir('Hola');
            await c.tocar((o) => o.id === BOTON_PUERTA.CLUB);
            const t = c.ultimoTexto();
            debe(r, t.length > 0, 'no contestó a «Ya soy del club»');
            debe(r, !preguntoClave(t, e, e.preguntas[0].clave), 'a alguien del club le hizo las preguntas del interesado');
            r.desenlace = 'club';
            return null;
        },
    },
    {
        titulo: 'pide una persona a mitad del embudo',
        correr: async (c, e, r) => {
            await hastaPregunta(c, e, e.sedes[0] ?? null);
            await c.decir('Mariana Gómez');
            await c.decir('prefiero hablar con una persona por favor');
            debe(r, /persona|te escrib/i.test(c.ultimoTexto()) || desenlaceDe(c) === 'persona', 'no pasó a una persona cuando la pidieron');
            r.personaEsperada = true;
            r.desenlace = 'persona';
            return null;
        },
    },
    {
        titulo: 'fecha que no se entiende dos veces → persona',
        correr: async (c, e, r) => {
            await hastaPregunta(c, e, e.sedes[0] ?? null);
            await c.decir('Mariana Gómez');
            await c.decir('no me acuerdo');
            await c.decir('ni idea la verdad');
            debe(r, desenlaceDe(c) === 'persona', 'tras dos respuestas sin fecha no pasó a una persona');
            r.personaEsperada = true;
            r.desenlace = 'persona';
            return null;
        },
    },
    {
        titulo: 'nombre con emoji y en minúsculas',
        correr: async (c, e, r) => {
            const perfil = perfilDe(e);
            await hastaPregunta(c, e, perfil.sede);
            await c.decir('mariana gómez 😊');
            debe(r, /Mariana/.test(c.ultimoTexto()), 'no saludó por el nombre («Mariana»)');
            return perfil;
        },
    },
    {
        titulo: 'pregunta sin «?» en vez del nombre («cuanto vale la mensualidad»)',
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { sede: e.sedes[0] ?? null });
            await hastaPregunta(c, e, perfil.sede);
            await c.decir('cuanto vale la mensualidad');
            const t = c.ultimoTexto();
            const nombre = String(c.datosEmbudo()?.nombre ?? '');
            debe(r, !/vale|mensualidad/i.test(nombre) && !/mucho gusto, cuanto/i.test(t), `tomó la pregunta como el nombre del deportista («${nombre}»)`);
            debe(r, /\$\s?\d/.test(t), 'no contestó la pregunta de la mensualidad');
            // La respuesta del modelo va con la nota del buzón en el mismo turno: el registro
            // tiene que seguir donde estaba (el nombre), no darse por cerrado.
            await c.decir(perfil.nombre);
            debe(r, /mucho gusto/i.test(c.ultimoTexto()), 'después de la pregunta no retomó el registro en el nombre');
            return perfil;
        },
    },
    {
        titulo: 'pregunta sin «?» al elegir horario («cuanto vale la mensualidad»)',
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { sede: e.sedes[0] ?? null, anio: ANIO - 13 });
            await c.decir('Hola');
            const llego = await seguirHasta(c, e, perfil, (o) => o.id.startsWith(BOTON_EMBUDO.FRANJA));
            if (!llego) { r.fallas.push('no llegó a los horarios'); return null; }
            await c.decir('cuanto vale la mensualidad');
            const t = c.ultimoTexto();
            debe(r, !/elige uno de los horarios/i.test(t), 'tomó la pregunta como un horario mal elegido («Elige uno de los horarios…») y gastó un intento');
            debe(r, /\$\s?\d/.test(t), 'no contestó la pregunta de la mensualidad');
            if (!c.opciones().some((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA))) {
                // Sin la lista a mano, el interesado vuelve a pedir los horarios.
                await c.decir('ok, me muestras los horarios otra vez');
            }
            return perfil;
        },
    },
    {
        titulo: 'dice que no al consentimiento: igual recibe cómo pagar',
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { sede: e.sedes[0] ?? null, anio: ANIO - 13 });
            await c.decir('Hola');
            await seguirHasta(c, e, perfil, (o) => o.id === BOTON_EMBUDO.OPTIN_SI);
            const no = await c.tocar((o) => o.id === BOTON_EMBUDO.OPTIN_NO);
            if (!no) { r.fallas.push('nunca llegó al consentimiento'); return null; }
            debe(r, /comprobante/i.test(c.ultimoTexto()), 'tras «No, gracias» no le dijo cómo pagar');
            r.desenlace = 'pago';
            return null;
        },
    },
];

async function correrGuiones(escuela: Escuela): Promise<Resultado[]> {
    const rs = await enParalelo(GUIONES, async (g) => {
        const conv = new Conversacion(g.titulo, escuela.id, nuevoN());
        const r = nuevoResultado(g.titulo, conv, 'guiones');
        let perfil: Perfil | null = null;
        await protegido(r, async () => {
            perfil = await g.correr(conv, escuela, r);
            // Lo que el guion dejó a medias lo termina el interesado automático.
            if (perfil && !r.fallas.length) await seguir(conv, escuela, perfil, r);
            if (r.desenlace !== 'no_aplica') g.verificar?.(conv, escuela, r);
        });
        cerrar(r, escuela, perfil);
        progreso(r);
        return r;
    });
    process.stdout.write('\n');
    return rs;
}

// ─── Después del embudo ──────────────────────────────────────────────────────

/** Dónde está la familia cuando escribe. */
type Momento = 'esperando_pago' | 'pagada' | 'agendada_embudo';

interface BaseDespues {
    momento: Momento;
    datos: Record<string, any>;
    /** Número de la vía principal de la sede de su clase («201») y el de las otras sedes («152»). */
    via?: { suya: string; otras: string[] } | null;
}

/** «AV. El Polo, Cl. 201 #67-12» → «201». Pura. */
function viaDe(direccion: string | null | undefined): string | null {
    return String(direccion ?? '').match(/\b(?:cl|cll|calle|ac|av|avenida|cra|kr|carrera|dg|diagonal|tv|transversal)\b\.?\s*(\d{2,3})/i)?.[1] ?? null;
}

const mencionaNumero = (texto: string, n: string) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(texto);

interface PostEmbudo {
    clave: string;
    titulo: string;
    correr: (c: Conversacion, e: Escuela, r: Resultado, b: BaseDespues) => Promise<void>;
}

/** Que no vuelva a arrancar el embudo (bienvenida, sedes, primera pregunta). */
function noReinicia(c: Conversacion, e: Escuela, r: Resultado): void {
    debe(r, !c.opciones().some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE)) && !preguntoClave(c.ultimoTexto(), e, e.preguntas[0]?.clave ?? ''),
        'volvió a empezar el embudo (sedes o primera pregunta)');
}

/** La dirección que dio es la de la sede de SU clase, no la de otra sede. */
function revisarSede(c: Conversacion, r: Resultado, b: BaseDespues): void {
    if (!c.hablo() || !b.via) return;
    const t = c.ultimoTexto();
    const otra = b.via.otras.find((n) => mencionaNumero(t, n));
    if (otra && !mencionaNumero(t, b.via.suya)) {
        r.fallas.push(`le dio la dirección de otra sede (vía ${otra}) y su clase es en la sede de la vía ${b.via.suya}`);
    }
}

/** Si contestó (el silencio lo anota `cerrar`), que diga lo que se espera. */
function responde(c: Conversacion, e: Escuela, r: Resultado, re: RegExp | null, falla: string): void {
    if (!c.hablo()) return;
    if (re) debe(r, re.test(c.ultimoTexto()), falla);
    noReinicia(c, e, r);
}

const DIRECCION = /\b(cl|calle|av|avenida|ac|carrera|cra|kr|diagonal|dg|transversal|tv)\b\.?\s*\d|maps\.app|goo\.gl|google\.com\/maps|direcci[oó]n/i;
const PIDE_PAGO = (c: Conversacion) => c.salidas().some((s) => s.step === PASO_EMBUDO.PAGO) || /env[ií]a(me)?[^.\n]{0,40}comprobante/i.test(c.ultimoTexto());

/** «Cambiar horario» (escrito o botón): lista del MISMO grupo, sin la franja que ya tiene; al elegir, según el momento. */
function cambio(texto: string, boton: string | null): PostEmbudo['correr'] {
    return async (c, e, r, b) => {
        await c.decir(texto, boton);
        if (!c.hablo()) return;
        const filas = c.opciones().filter((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA));
        if (!filas.length) {
            const otras = c.opciones();
            r.fallas.push(`no le ofreció los horarios de su grupo para cambiar`
                + (otras.length ? `: mostró otro flujo con ${otras.length} opciones (p. ej. «${otras[0].title}${otras[0].descripcion ? ` · ${otras[0].descripcion}` : ''}»)` : '')
                + (b.momento === 'pagada' ? ' — el aviso de B4 no deja el estado del embudo en el payload' : ''));
            noReinicia(c, e, r);
            return;
        }
        revisarFranjas(c, e, b.datos.teamId, r);
        debe(r, !filas.some((o) => o.id === `${BOTON_EMBUDO.FRANJA}${b.datos.slotId}`), 'ofreció la misma franja que ya tiene');
        if (b.momento === 'esperando_pago') {
            debe(r, !/no tienes que pagar de nuevo/i.test(c.ultimoTexto()), 'ofrece el cambio con «No tienes que pagar de nuevo» y todavía no ha pagado');
        }
        if (b.momento === 'agendada_embudo' && /no tienes que pagar de nuevo/i.test(c.ultimoTexto())) {
            r.avisos.push('ofrece el cambio con «No tienes que pagar de nuevo» y la clase no tiene valor (el texto de ofrecerCambio no mira el valor)');
        }
        await c.tocar((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA) && o.id !== `${BOTON_EMBUDO.FRANJA}${b.datos.slotId}`);
        if (!c.hablo()) return;
        const t = c.ultimoTexto();
        if (b.momento === 'esperando_pago') {
            debe(r, PIDE_PAGO(c), 'tras cambiar de horario (sin haber pagado) no le volvió a dar cómo pagar');
        } else if (PIDE_PAGO(c)) {
            if (b.momento === 'pagada') {
                r.limitaciones.push('al elegir el nuevo horario vuelve a pedir el pago: `cupoSimulado` no sabe que el lead ya pagó (la RPC tomar_cupo_clase_prueba agendaría sin cobrar)');
            } else r.fallas.push('tras cambiar el horario de una clase sin valor pidió pago');
        } else {
            debe(r, /cambi[eé] el horario|qued[oó] agendada/i.test(t), 'tras elegir el nuevo horario no confirmó el cambio');
        }
    };
}

const POST: PostEmbudo[] = [
    {
        clave: 'matricula', titulo: '«Y para matricularla qué hago?»',
        correr: async (c, e, r) => { await c.decir('Y para matricularla qué hago?'); responde(c, e, r, /matr[ií]cul|inscrib|inscripci/i, 'no le explicó cómo matricularla'); },
    },
    {
        clave: 'matricular', titulo: '«quiero matricularla»',
        correr: async (c, e, r) => { await c.decir('quiero matricularla'); responde(c, e, r, /matr[ií]cul|inscrib|inscripci/i, 'no le respondió sobre la matrícula'); },
    },
    {
        clave: 'llevar', titulo: '«qué debo llevar»',
        correr: async (c, e, r) => { await c.decir('qué debo llevar'); responde(c, e, r, /ropa|agua|tenis|camiseta|hidrat|uniforme|pantaloneta/i, 'no le dijo qué llevar'); },
    },
    {
        clave: 'donde', titulo: '«dónde queda? cómo llego»',
        correr: async (c, e, r, b) => {
            await c.decir('dónde queda? cómo llego');
            responde(c, e, r, DIRECCION, 'no le dio la dirección ni el mapa');
            revisarSede(c, r, b);
        },
    },
    {
        clave: 'mensualidad', titulo: '«cuánto vale la mensualidad»',
        correr: async (c, e, r) => { await c.decir('cuánto vale la mensualidad'); responde(c, e, r, /\$\s?\d{1,3}([.,]\d{3})+/, 'no le dio el valor de la mensualidad'); },
    },
    {
        clave: 'ya_pague', titulo: '«ya pagué» (sin foto)',
        correr: async (c, e, r, b) => {
            await c.decir('ya pagué');
            responde(c, e, r, b.momento === 'esperando_pago' ? /comprobante|foto|pdf|captura|imagen|soporte/i : null,
                'no le pidió la foto o el PDF del comprobante');
        },
    },
    { clave: 'cambiar', titulo: '«quiero cambiar de horario» escrito', correr: cambio('Quiero cambiar de horario', null) },
    { clave: 'cambiar_el', titulo: '«necesito cambiar el horario» escrito', correr: cambio('Necesito cambiar el horario', null) },
    { clave: 'cambiar_boton', titulo: 'botón «Cambiar horario» (sm_em_cambiar)', correr: cambio('Cambiar horario', BOTON_EMBUDO.CAMBIAR) },
    { clave: 'no_puedo', titulo: '«no puedo ir»', correr: cambio('no puedo ir', null) },
    {
        clave: 'seguidas', titulo: 'cuatro preguntas seguidas (llevar, dónde, mensualidad, matrícula)',
        correr: async (c, e, r, b) => {
            const preguntas: [string, RegExp, string][] = [
                ['qué debo llevar', /ropa|agua|tenis|camiseta|hidrat|uniforme|pantaloneta/i, 'no le dijo qué llevar'],
                ['y dónde queda?', DIRECCION, 'no le dio la dirección ni el mapa'],
                ['cuánto vale la mensualidad', /\$\s?\d{1,3}([.,]\d{3})+/, 'no le dio el valor de la mensualidad'],
                ['y para matricularla qué hago?', /matr[ií]cul|inscrib|inscripci/i, 'no le explicó cómo matricularla'],
            ];
            for (const [texto, re, falla] of preguntas) {
                await c.decir(texto);
                responde(c, e, r, re, `${falla} («${texto}»)`);
                if (re === DIRECCION) revisarSede(c, r, b);
            }
        },
    },
    {
        clave: 'gracias', titulo: '«gracias» (cierre de cortesía: callar está bien)',
        correr: async (c, e, r) => {
            await c.decir('Gracias', null, { silencioOk: true });
            if (!c.hablo()) return;
            noReinicia(c, e, r);
            debe(r, c.ultimoTexto().length <= 400, 'a un «gracias» contestó con un mensaje largo');
        },
    },
];

/** El lead como lo dejó el embudo real (en memoria: la simulación no lo guardó). */
function leadSembrado(c: Conversacion, e: Escuela, d: Record<string, any>, momento: Momento): Fila {
    const agendada = momento !== 'esperando_pago';
    const ahora = new Date().toISOString();
    return {
        id: d.leadId ?? 'lead-simulado', school_id: e.id, full_name: d.nombre ?? null, guardian_name: null, phone: c.contacto(),
        birth_date: d.fechaNacimiento ?? null, gender: d.genero ?? null, status: 'contacted',
        team_id: d.teamId ?? null, branch_id: d.branchId ?? null,
        trial_slot_id: agendada ? d.slotId ?? null : null,
        cupo_separado_slot_id: agendada ? null : d.slotId ?? null,
        cupo_separado_hasta: agendada ? null : d.hasta ?? null,
        respuestas: d.respuestas ?? {},
        source_detail: {
            via: 'embudo', consentimiento: d.consentimiento ?? null, etapa: agendada ? 'agendado' : 'respondido',
            // Lo que deja B4 al agendar por el comprobante: el cambio de horario ya no cobra.
            ...(momento === 'pagada' ? { agendado_por: 'pago' } : {}),
            embudo: { team_id: d.teamId ?? null, branch_id: d.branchId ?? null, respuestas: d.respuestas ?? {} },
        },
        created_at: ahora, updated_at: ahora,
    };
}

const ROTULO_MOMENTO: Record<Momento, string> = {
    esperando_pago: 'esperando el pago', pagada: 'ya agendada (pagó)', agendada_embudo: 'agendada (sin valor)',
};

/** Una bifurcación por cada cosa que escribe la familia. */
async function correrPost(
    base: Conversacion, e: Escuela, b: BaseDespues, claves: string[] | null, bloque: Bloque, variante: string | null,
): Promise<Resultado[]> {
    const posts = POST.filter((p) => !claves || claves.includes(p.clave));
    return enParalelo(posts, async (p) => {
        const c = base.bifurcar(`${ROTULO_MOMENTO[b.momento]} · ${p.titulo}`);
        if (VIRTUALES.has('school_signup_leads')) c.sembrar('school_signup_leads', [leadSembrado(c, e, b.datos, b.momento)]);
        c.fase = 'despues';
        const r = nuevoResultado(c.titulo, c, bloque, variante);
        await protegido(r, () => p.correr(c, e, r, b));
        r.desenlace = c.turnos.slice(c.heredados).some((t) => !t.sistema && paraLaFamilia(t.salidas).length) ? 'respuesta' : 'silencio';
        cerrar(r, e, null);
        progreso(r);
        return r;
    });
}

async function correrDespues(e: Escuela): Promise<Resultado[]> {
    const perfil = perfilesConGrupo(e, 1, { genero: 'f' })[0];
    const base = new Conversacion('base: el interesado llega hasta las instrucciones de pago', e.id, nuevoN());
    const rb = nuevoResultado(base.titulo, base, 'despues');
    if (!perfil) { noAplica(rb, 'ningún perfil tiene grupo con franjas'); return [rb]; }
    return conTablasVirtuales(['school_signup_leads'], async () => {
        await protegido(rb, async () => {
            await base.decir('Hola, quiero información para entrenar voleibol');
            await seguir(base, e, perfil, rb);
        });
        debe(rb, rb.desenlace === 'pago', `la base terminó en «${rb.desenlace}» y no en las instrucciones de pago`);
        const resultados = [cerrar(rb, e, perfil)];
        progreso(rb);
        if (rb.desenlace !== 'pago') return resultados;
        const datos = base.datosEmbudo() ?? {};

        // B4: llega el comprobante, coincide y `confirmarClasePruebaPagada` agenda. El
        // job manda la confirmación con { step, queue_id }: sin el estado del embudo.
        const pagada = base.bifurcar('base: pagó y B4 confirmó la clase');
        const franja = datos.slotId ? await franjaDeAgenda(e.id, datos.slotId) : null;
        const queLlevar = await indicacionesCortesiaDeEscuela(e.id).catch(() => null);
        const confirmacion = franja
            ? textoConfirmacion(franja, { deportista: datos.nombre, nombreClase: e.nombreClase, queLlevar })
            : 'Tu clase de prueba quedó agendada 🎉';
        pagada.inyectarSaliente('(B4: llega el comprobante, coincide y agenda)', confirmacion, { step: 'clase_prueba_agendada', queue_id: 'qa-embudo' });

        // La vía de la sede de su clase (la de la franja, o la de la sede) contra las de las otras sedes.
        const { data: sedes } = await supabase.from('school_branches').select('id, address')
            .in('id', e.sedes.map((s) => s.branchId));
        const suya = viaDe((franja as any)?.direccion) ?? viaDe(((sedes ?? []) as any[]).find((s) => s.id === datos.branchId)?.address);
        const otras = ((sedes ?? []) as any[]).filter((s) => s.id !== datos.branchId).map((s) => viaDe(s.address))
            .filter((n): n is string => !!n && n !== suya);
        const via = suya && otras.length ? { suya, otras } : null;

        resultados.push(...await correrPost(base, e, { momento: 'esperando_pago', datos, via }, null, 'despues', null));
        resultados.push(...await correrPost(pagada, e, { momento: 'pagada', datos, via }, null, 'despues', null));
        process.stdout.write('\n');
        return resultados;
    });
}

// ─── Variantes de configuración ──────────────────────────────────────────────

interface CasoVariante {
    titulo: string;
    perfil: Perfil | null;
    /** Primer mensaje (por defecto, pedir información). */
    abrir?: string;
    /** Desenlaces correctos; vacío = cualquiera. */
    espera: Desenlace[];
    personaEsperada?: boolean;
    sinHorariosEsperado?: boolean;
    /** Callar al primer mensaje es correcto (por diseño). */
    silencioOk?: boolean;
    /** Si el desenlace no es el esperado por una limitación conocida de la simulación, cuál. */
    limitacion?: (r: Resultado) => string | null;
    revisar?: (c: Conversacion, e: Escuela, r: Resultado) => void;
    /** Claves de POST a probar después (bifurcando). */
    despues?: string[];
}

interface Variante {
    nombre: string;
    descripcion: string;
    armar: (e: Escuela, f: FilasReales) => { tablas: Record<string, Fila[]>; casos: CasoVariante[]; avisos?: string[] };
}

const claseReal = (e: Escuela, f: FilasReales): Fila => ({ ...(f.clase ?? { school_id: e.id, enabled: true }) });
const sinCasos = (aviso: string): ReturnType<Variante['armar']> => ({ tablas: {}, casos: [], avisos: [aviso] });

/** El primer mensaje ya trae la primera pregunta (sin preguntar la sede). */
function directoALasPreguntas(c: Conversacion, e: Escuela, r: Resultado): void {
    const primera = c.turnos[0];
    const texto = paraLaFamilia(primera?.salidas ?? []).map((s) => s.texto).join('\n');
    debe(r, !(primera?.salidas ?? []).some((s) => (s.opciones ?? []).some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE))),
        'pregunta la sede con botones (debería ir directo a las preguntas)');
    debe(r, preguntoClave(texto, e, e.preguntas[0]?.clave ?? ''), 'el primer mensaje no trae la primera pregunta');
}

function revisarSinValor(precioReal: number | null, cortesia: boolean) {
    return (c: Conversacion, e: Escuela, r: Resultado) => {
        const ts = c.textos();
        debe(r, !huboPaso(c, PASO_EMBUDO.PAGO) && !/comprobante/i.test(ts), 'pidió pago o comprobante y la clase no tiene valor');
        if (precioReal) debe(r, !ts.includes(formatoPesos(precioReal)), `mencionó ${formatoPesos(precioReal)} y la clase no tiene valor`);
        debe(r, /qued[oó] agendada/i.test(ts), 'no confirmó que la clase quedó agendada');
        debe(r, huboOpcion(c, (id) => id === BOTON_EMBUDO.OPTIN_SI), 'no preguntó el consentimiento');
        if (cortesia) debe(r, /clase de cortes[ií]a/i.test(ts), 'sin nombre de clase ni valor no la llamó «clase de cortesía»');
    };
}

/** Clones de franjas reales movidos a un miércoles y un jueves próximos (para probar los días). */
function clonesEntreSemana(slots: Fila[], teamIds: string[]): Fila[] {
    const desde = masDias(hoyBogota(), 2);
    const salida: Fila[] = [];
    for (const teamId of teamIds) {
        const s = slots.find((x) => x.team_id === teamId && x.is_open !== false);
        if (!s) continue;
        for (const dow of [3, 4]) {
            salida.push({ ...s, id: randomUUID(), slot_date: proximoDia(dow, desde), generated_from_schedule: false, reserved_count: 0 });
        }
    }
    return salida;
}

const VARIANTES: Variante[] = [
    {
        nombre: 'sin-valor',
        descripcion: 'trial_price = 0: sin paso de pago; agendada + confirmación + consentimiento (puede decir «sin costo»)',
        armar: (e, f) => ({
            tablas: { school_trial_class_settings: [{ ...claseReal(e, f), trial_price: 0 }] },
            casos: perfilesConGrupo(e, 3).map((p, i) => ({
                titulo: tituloPerfil(p), perfil: p, espera: ['agendada'], revisar: revisarSinValor(e.precio, false),
                ...(i === 0 ? { despues: ['cambiar', 'gracias'] } : {}),
            })),
        }),
    },
    {
        nombre: 'sin-valor-null',
        descripcion: 'trial_price y nombre_clase null: «clase de cortesía», agendada sin pago',
        armar: (e, f) => ({
            tablas: { school_trial_class_settings: [{ ...claseReal(e, f), trial_price: null, nombre_clase: null }] },
            casos: perfilesConGrupo(e, 2).map((p) => ({ titulo: tituloPerfil(p), perfil: p, espera: ['agendada'], revisar: revisarSinValor(e.precio, true) })),
        }),
    },
    {
        nombre: 'sin-cuentas',
        descripcion: 'sin cuentas de pago (Nequi, banco, Bre-B y payment_accounts vacíos): una persona y se suelta el cupo',
        armar: (e, f) => {
            const numero = String(f.settings.nequi_number ?? '').replace(/\D/g, '');
            return {
                tablas: { school_settings: [{ ...f.settings, nequi_number: null, bank_account_number: null, breb_key: null, breb_number: null, payment_accounts: [] }] },
                casos: perfilesConGrupo(e, 2).map((p) => ({
                    titulo: tituloPerfil(p), perfil: p, espera: ['persona'], personaEsperada: true,
                    revisar: (c, _e, r) => {
                        debe(r, /datos de pago/i.test(c.ultimoTexto()), 'al pasar a una persona no le dijo que le escriben con los datos de pago');
                        debe(r, !huboPaso(c, PASO_EMBUDO.PAGO), 'dio instrucciones de pago sin cuentas cargadas');
                        if (numero) debe(r, !c.textos().replace(/\s/g, '').includes(numero), 'mostró un número de cuenta que la escuela ya no tiene');
                    },
                })),
            };
        },
    },
    {
        nombre: 'sin-sedes',
        descripcion: 'wa_botones_sede y wa_bienvenida null: directo a las preguntas, grupo de cualquier sede',
        armar: (e, f) => ({
            tablas: { school_settings: [{ ...f.settings, wa_botones_sede: null, wa_bienvenida: null }] },
            casos: perfilesConGrupo({ ...e, sedes: [] }, 2).map((p) => ({ titulo: tituloPerfil(p), perfil: p, espera: ['pago'], revisar: directoALasPreguntas })),
        }),
    },
    {
        nombre: 'sin-sedes-bienvenida-propia',
        descripcion: 'sin botones de sede pero con la bienvenida de la escuela (que pregunta por la sede)',
        armar: (e, f) => ({
            tablas: { school_settings: [{ ...f.settings, wa_botones_sede: null }] },
            casos: perfilesConGrupo({ ...e, sedes: [] }, 1).map((p) => ({
                titulo: tituloPerfil(p), perfil: p, espera: ['pago'],
                revisar: (c, ev, r) => {
                    directoALasPreguntas(c, ev, r);
                    if (/\bsede\b/i.test(c.turnos[0] ? paraLaFamilia(c.turnos[0].salidas).map((s) => s.texto).join('\n') : '')) {
                        r.avisos.push('la bienvenida (texto de la escuela) pregunta por la sede y ya no hay botones de sede: ajustar wa_bienvenida al quitarlos');
                    }
                },
            })),
        }),
    },
    {
        nombre: 'una-sede',
        descripcion: 'un solo botón de sede (y bienvenida por defecto): directo a las preguntas en esa sede; sin «otra sede» que no tiene botón',
        armar: (e, f) => {
            const sede = e.sedes[0];
            if (!sede) return sinCasos('la escuela no tiene sedes');
            const conGrupo = perfilesConGrupo(e, 1, { sede })[0];
            const sinGrupo = perfilSinGrupoEnSede(e, sede);
            const casos: CasoVariante[] = [];
            if (conGrupo) casos.push({ titulo: `${tituloPerfil(conGrupo)} (con grupo en la sede)`, perfil: conGrupo, espera: ['pago'], revisar: directoALasPreguntas });
            if (sinGrupo) {
                casos.push({
                    titulo: `${tituloPerfil(sinGrupo)} (sin grupo en la única sede)`, perfil: sinGrupo, espera: ['persona'], personaEsperada: true,
                    revisar: (c, ev, r) => {
                        directoALasPreguntas(c, ev, r);
                        debe(r, !huboOpcion(c, (id) => id.startsWith(BOTON_EMBUDO.OTRA_SEDE)), 'ofreció una sede que no tiene botón');
                    },
                });
            }
            return { tablas: { school_settings: [{ ...f.settings, wa_botones_sede: [{ titulo: sede.titulo, branch_id: sede.branchId }], wa_bienvenida: null }] }, casos };
        },
    },
    {
        nombre: 'sin-franjas',
        descripcion: 'school_trial_slots vacío: «no tengo horarios» + una persona',
        armar: (e) => ({
            tablas: { school_trial_slots: [] },
            casos: perfilesConGrupo(e, 2).map((p) => ({
                titulo: tituloPerfil(p), perfil: p, espera: ['sin_horarios'], sinHorariosEsperado: true,
                revisar: (c, _e, r) => debe(r, /no tengo horarios abiertos/i.test(c.ultimoTexto()), 'no le dijo que no hay horarios abiertos'),
            })),
        }),
    },
    {
        nombre: 'dias-null',
        descripcion: 'dias_semana null (todos los días) + franjas reales clonadas a miércoles y jueves: se ofrecen',
        armar: (e, f) => {
            const perfiles = perfilesConGrupo(e, 2);
            const clones = clonesEntreSemana(f.slots, perfiles.map((p) => grupoEsperado(e, p).principal!.teamId));
            const ids = new Set(clones.map((x) => String(x.id)));
            return {
                tablas: { school_trial_class_settings: [{ ...claseReal(e, f), dias_semana: null }], school_trial_slots: [...f.slots, ...clones] },
                casos: perfiles.map((p) => ({
                    titulo: tituloPerfil(p), perfil: p, espera: ['pago'],
                    revisar: (_c, _e, r) => debe(r, r.franjasOfrecidas.some((id) => ids.has(id)), 'con dias_semana null no ofreció las franjas de entre semana'),
                })),
            };
        },
    },
    {
        nombre: 'dias-solo-agenda',
        descripcion: 'dias_semana de la escuela + franjas clonadas a miércoles y jueves: NO se ofrecen',
        armar: (e, f) => {
            if (!e.diasSemana) return sinCasos('la escuela agenda todos los días (dias_semana null)');
            const perfiles = perfilesConGrupo(e, 1);
            const clones = clonesEntreSemana(f.slots, perfiles.map((p) => grupoEsperado(e, p).principal!.teamId))
                .filter((x) => !e.diasSemana!.includes(diaDeLaSemana(String(x.slot_date))));
            const ids = new Set(clones.map((x) => String(x.id)));
            return {
                tablas: { school_trial_slots: [...f.slots, ...clones] },
                casos: perfiles.map((p) => ({
                    titulo: tituloPerfil(p), perfil: p, espera: ['pago'],
                    revisar: (_c, _e, r) => debe(r, !r.franjasOfrecidas.some((id) => ids.has(id)), 'ofreció franjas en días que la escuela no agenda'),
                })),
            };
        },
    },
    {
        nombre: 'cupos-llenos',
        descripcion: 'grupo A con todas sus franjas llenas (→ sin horarios); grupo B con las 2 primeras llenas y las demás con 1 y 2 cupos',
        armar: (e, f) => {
            const [a, b] = perfilesConGrupo(e, 2);
            if (!a || !b) return sinCasos('no hay dos grupos con franjas');
            const ga = grupoEsperado(e, a).principal!.teamId;
            const gb = grupoEsperado(e, b).principal!.teamId;
            const deB = f.slots.filter((s) => s.team_id === gb)
                .sort((x, y) => `${x.slot_date}${x.start_time}`.localeCompare(`${y.slot_date}${y.start_time}`)).map((s) => s.id);
            const slots = f.slots.map((s) => {
                if (s.team_id === ga) return { ...s, max_capacity: 5, reserved_count: 5 };
                if (s.team_id !== gb) return s;
                const k = deB.indexOf(s.id);
                return { ...s, max_capacity: 5, reserved_count: k < 2 ? 5 : k === 2 ? 4 : 3 };
            });
            return {
                tablas: { school_trial_slots: slots },
                casos: [
                    {
                        titulo: `${tituloPerfil(a)} (todas llenas)`, perfil: a, espera: ['sin_horarios'], sinHorariosEsperado: true,
                        revisar: (c, _e, r) => debe(r, /no tengo horarios abiertos/i.test(c.ultimoTexto()), 'con todo lleno no le dijo que no hay horarios'),
                    },
                    {
                        titulo: `${tituloPerfil(b)} (2 llenas, 1 y 2 cupos)`, perfil: b, espera: ['pago'],
                        revisar: (_c, _e, r) => {
                            debe(r, !r.franjasOfrecidas.some((id) => deB.slice(0, 2).includes(id)), 'ofreció franjas llenas');
                            debe(r, r.franjasOfrecidas.length > 0, 'no ofreció las franjas con cupo');
                        },
                    },
                ],
            };
        },
    },
    {
        nombre: 'separar-48',
        descripcion: 'separar_horas = 48: «te separo el cupo … durante 48 horas»',
        armar: (e, f) => ({
            tablas: { school_trial_class_settings: [{ ...claseReal(e, f), separar_horas: 48 }] },
            casos: perfilesConGrupo(e, 2).map((p) => ({
                titulo: tituloPerfil(p), perfil: p, espera: ['pago'],
                revisar: (c, _e, r) => {
                    debe(r, /durante 48 horas/i.test(c.textos()), 'no dijo que separa el cupo durante 48 horas');
                    const hasta = Date.parse(String(c.datosEmbudo()?.hasta ?? ''));
                    debe(r, Number.isFinite(hasta) && Math.abs(hasta - Date.now() - 48 * 3600_000) < 15 * 60_000,
                        `el cupo separado vence ${c.datosEmbudo()?.hasta ?? '—'} y no en 48 h`);
                },
            })),
        }),
    },
    {
        nombre: 'separar-null',
        descripcion: 'separar_horas null con valor: la RPC real AGENDA sin cobrar en el bot (v_horas IS NULL)',
        armar: (e, f) => ({
            tablas: { school_trial_class_settings: [{ ...claseReal(e, f), separar_horas: null }] },
            casos: perfilesConGrupo(e, 1).map((p) => ({
                titulo: tituloPerfil(p), perfil: p, espera: ['agendada'],
                limitacion: (r) => (r.desenlace === 'pago'
                    ? '`cupoSimulado` separa (24 h) con separar_horas null; la RPC tomar_cupo_clase_prueba agenda sin cobrar (v_horas IS NULL): la simulación no muestra lo que vería la familia'
                    : null),
            })),
        }),
    },
    {
        nombre: 'embudo-apagado',
        descripcion: 'wa_preguntas_prospecto null: no hay embudo; ¿qué contesta el bot?',
        armar: (e, f) => {
            const q1 = e.preguntas[0];
            const sinEmbudo = (c: Conversacion, _e: Escuela, r: Resultado) => {
                debe(r, !huboOpcion(c, (id) => id.startsWith('sm_em_')), 'mostró botones del embudo con el embudo apagado');
                if (q1) debe(r, !c.textos().includes(ultimaLinea(q1.texto)), 'hizo las preguntas del embudo con el embudo apagado');
            };
            return {
                tablas: { school_settings: [{ ...f.settings, wa_preguntas_prospecto: null }] },
                casos: [
                    {
                        // Por diseño: sin embudo, el saludo suelto de un número nuevo no se contesta
                        // (bienvenida al desconocido solo en WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS).
                        titulo: '«Hola»', perfil: null, abrir: 'Hola', espera: [], silencioOk: true,
                        revisar: (c, ev, r) => {
                            sinEmbudo(c, ev, r);
                            if (!c.hablo()) r.avisos.push('sin embudo, «Hola» de un número nuevo queda sin respuesta (por diseño: la bienvenida al desconocido solo va en WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS)');
                        },
                    },
                    { titulo: '«quiero información… nació en …»', perfil: null, abrir: `Hola, quiero información para entrenar voleibol. Mi hija nació en ${ANIO - 14}`, espera: [], revisar: sinEmbudo },
                    {
                        titulo: '«cuánto vale la clase de prueba?»', perfil: null, abrir: 'Cuánto vale la clase de prueba?', espera: [],
                        revisar: (c, ev, r) => {
                            sinEmbudo(c, ev, r);
                            if (e.precio && c.hablo()) debe(r, c.textos().includes(formatoPesos(e.precio)), `no dijo el valor de la clase (${formatoPesos(e.precio)})`);
                        },
                    },
                ],
            };
        },
    },
];

/** La escuela tal como la ve el bot en la variante (para revisar contra eso). */
function escuelaDeVariante(e: Escuela, f: FilasReales, tablas: Record<string, Fila[]>): Escuela {
    const settings = tablas.school_settings?.[0] ?? f.settings;
    const clase = tablas.school_trial_class_settings?.[0] ?? f.clase;
    const slots = tablas.school_trial_slots ?? f.slots;
    return armarEscuela(e.id, e.nombre, ajustesDesdeFila(settings), ajustesClasePruebaDesdeFila(clase), e.rangos, slots);
}

async function correrCaso(caso: CasoVariante, ev: Escuela, semilla: Record<string, Fila[]>, variante: string): Promise<Resultado[]> {
    const conv = new Conversacion(caso.titulo, ev.id, nuevoN(), semilla);
    const r = nuevoResultado(caso.titulo, conv, 'variantes', variante);
    r.personaEsperada = !!caso.personaEsperada;
    r.sinHorariosEsperado = !!caso.sinHorariosEsperado;
    await protegido(r, async () => {
        await conv.decir(caso.abrir ?? 'Hola, quiero información para entrenar voleibol', null, { silencioOk: !!caso.silencioOk });
        if (caso.perfil) await seguir(conv, ev, caso.perfil, r);
        else r.desenlace = desenlaceDe(conv) ?? (conv.hablo() ? 'respuesta' : 'silencio');
        if (caso.espera.length && !caso.espera.includes(r.desenlace)) {
            const lim = caso.limitacion?.(r);
            if (lim) r.limitaciones.push(lim);
            else r.fallas.push(`terminó en «${r.desenlace}» y se esperaba ${caso.espera.map((x) => `«${x}»`).join(' o ')}`);
        }
        caso.revisar?.(conv, ev, r);
    });
    cerrar(r, ev, caso.perfil);
    progreso(r);
    const salida = [r];
    if (caso.despues?.length && (r.desenlace === 'agendada' || r.desenlace === 'pago')) {
        const momento: Momento = r.desenlace === 'pago' ? 'esperando_pago' : 'agendada_embudo';
        for (const x of await correrPost(conv, ev, { momento, datos: conv.datosEmbudo() ?? {} }, caso.despues, 'variantes', variante)) {
            x.titulo = `${caso.titulo} → ${x.titulo}`;
            salida.push(x);
        }
    }
    return salida;
}

async function correrVariantes(e: Escuela): Promise<{ resultados: Resultado[]; avisos: string[] }> {
    const desconocidas = (VARIANTES_PEDIDAS ?? []).filter((v) => !VARIANTES.some((x) => x.nombre === v));
    if (desconocidas.length) throw new Error(`Variante desconocida: ${desconocidas.join(', ')}. Hay: ${VARIANTES.map((v) => v.nombre).join(', ')}`);
    const f = await leerFilasReales(e.id);
    const resultados: Resultado[] = [];
    const avisos: string[] = [];
    for (const v of VARIANTES.filter((x) => !VARIANTES_PEDIDAS || VARIANTES_PEDIDAS.includes(x.nombre))) {
        const armado = v.armar(e, f);
        for (const a of armado.avisos ?? []) avisos.push(`${v.nombre}: ${a}`);
        if (!armado.casos.length) { avisos.push(`${v.nombre}: sin casos para esta escuela`); continue; }
        const ev = escuelaDeVariante(e, f, armado.tablas);
        process.stdout.write(`  ${v.nombre.padEnd(28)} `);
        const rs = await conTablasVirtuales(Object.keys(armado.tablas),
            () => enParalelo(armado.casos, (caso) => correrCaso(caso, ev, armado.tablas, v.nombre)));
        resultados.push(...rs.flat());
        process.stdout.write('\n');
    }
    return { resultados, avisos };
}

// ─── Anuncios con clic a WhatsApp (whatsapp-anuncio-destino) ────────────────

/**
 * El precio de hoy calculado APARTE (no con la función del bot): el de afiliado si
 * lo es; si no, el último tramo de `precios_por_fecha` cuya fecha ya llegó, o el de lista.
 */
function precioDeHoyEsperado(it: ItemConFicha, afiliado: boolean): number | null {
    if (afiliado && Number(it.precio_afiliado) > 0) return Number(it.precio_afiliado);
    let precio = Number(it.price) > 0 ? Number(it.price) : null;
    const tramos = (Array.isArray(it.precios_por_fecha) ? it.precios_por_fecha as any[] : [])
        .filter((t) => t && /^\d{4}-\d{2}-\d{2}/.test(String(t.desde)) && Number(t.precio) > 0)
        .sort((a, b) => String(a.desde).localeCompare(String(b.desde)));
    for (const t of tramos) if (String(t.desde).slice(0, 10) <= hoyBogota()) precio = Number(t.precio);
    return precio;
}

const anuncio = (id: string, headline: string, body: string): Record<string, unknown> => ({
    source_id: id, source_type: 'ad', source_url: 'https://fb.me/qa-embudo', headline, body, media_type: 'image', ctwa_clid: `qa-clid-${id}`,
});

const MOTIVOS_DE_ITEM = ['torneo', 'viaje', 'clase_extra', 'vacacional', 'otro'];

/** El último turno trajo la ficha de ESE servicio: precio de hoy, abono, cómo pagar, motivo esperado y nada del embudo. */
function revisarFicha(c: Conversacion, e: Escuela, r: Resultado, it: ItemConFicha, o: { afiliado?: boolean } = {}): void {
    const t = c.turnos.at(-1)!;
    // La ficha (si después salió el formulario, la ficha es la de antes).
    const s = paraLaFamilia(t.salidas).filter((x) => (x.payload as any)?.[MARCA_DESTINO] === 'servicio').at(-1)
        ?? paraLaFamilia(t.salidas).at(-1);
    if (!s) return; // el silencio lo anota `cerrar`
    const p = (s.payload ?? {}) as Record<string, any>;
    debe(r, p[MARCA_DESTINO] === 'servicio' && p.servicio_id === it.id,
        `no fue a la ficha de «${it.name}» (destino: ${p[MARCA_DESTINO] ?? '—'}, step: ${s.step ?? '—'})`);
    // Si la descripción es el texto completo del anuncio de la escuela (≥ 700 caracteres), la ficha lo manda
    // tal cual: trae su propio título, fechas y precios (sin el nombre en negrita ni la línea del abono).
    const textoCompleto = String(it.description ?? '').trim().length >= 700;
    if (!textoCompleto) debe(r, s.texto.includes(`*${it.name}*`), 'la ficha no trae el nombre del servicio');
    const hoy = precioDeHoyEsperado(it, !!o.afiliado);
    if (hoy) debe(r, s.texto.includes(formatoPesos(hoy)), `la ficha no dice el precio de hoy (${formatoPesos(hoy)})`);
    if (o.afiliado && Number(it.precio_afiliado) > 0) debe(r, /afiliado/i.test(s.texto), 'no le dijo que es su valor de afiliado');
    const pct = Number(it.abono_minimo_pct);
    if (!textoCompleto && hoy && it.allow_installments === true && pct >= 1 && pct < 100) {
        debe(r, s.texto.includes(formatoPesos(Math.ceil((hoy * pct) / 100))), `no dice el abono mínimo (${pct} %)`);
    }
    debe(r, /comprobante|datos de pago/i.test(s.texto), 'no le dice cómo pagar ni que la escuela le manda los datos de pago');
    debe(r, !paraLaFamilia(t.salidas).some((x) => (x.opciones ?? []).some((op) => op.id.startsWith('sm_em_'))) && p.flujo !== 'embudo',
        'mostró el embudo de la clase de prueba (sedes o preguntas)');
    debe(r, !e.preguntas.length || !preguntoClave(s.texto, e, e.preguntas[0].clave), 'hizo la primera pregunta del embudo');
    const motivo = MOTIVOS_DE_ITEM.includes(String(it.kind)) ? String(it.kind) : 'otro';
    debe(r, p.motivo_esperado?.motivo === motivo, `no dejó el motivo esperado «${motivo}» en el saliente`);
    // En simulación no se escribe: que se INTENTÓ lo prueba el insert que bloqueó el cortafuegos.
    debe(r, t.bloqueadas.some((b) => /^(insert|update) whatsapp_conceptos_esperados$/.test(b)),
        'no intentó registrar el motivo esperado (el cortafuegos no vio el insert)');
}

/** El último turno arrancó el embudo de la clase de prueba (sedes o la primera pregunta), sin ficha de servicio. */
function revisarEmbudoDeClase(c: Conversacion, e: Escuela, r: Resultado, servicio: ItemConFicha | undefined): void {
    const s = paraLaFamilia(c.turnos.at(-1)?.salidas ?? []).at(-1);
    if (!s) return;
    const arranco = e.sedes.length > 1
        ? (s.opciones ?? []).some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE))
        : preguntoClave(s.texto, e, e.preguntas[0]?.clave ?? '');
    debe(r, arranco, 'no arrancó el embudo de la clase de prueba');
    debe(r, (s.payload as any)?.[MARCA_DESTINO] !== 'servicio' && (!servicio || !s.texto.includes(servicio.name)),
        'mandó la ficha de un servicio a quien llegó por la clase de prueba');
}

/** El último turno: «alguien te responde», el buzón con aviso y nada del embudo. */
function revisarPersona(c: Conversacion, r: Resultado): void {
    const t = c.turnos.at(-1)!;
    const fam = paraLaFamilia(t.salidas);
    if (!fam.length) return;
    debe(r, fam.some((s) => /te responde/i.test(s.texto)), 'no le confirmó que una persona le responde');
    debe(r, t.salidas.some(esNotaDelSimulador), 'no abrió la conversación en el buzón con aviso a la escuela');
    debe(r, !fam.some((s) => (s.opciones ?? []).some((o) => o.id.startsWith('sm_em_'))), 'mostró el embudo de la clase de prueba');
}

interface CasoAnuncio {
    titulo: string;
    /** Filas de `whatsapp_anuncio_destino` (la tabla va virtual mientras corren estos casos). */
    mapeo?: Fila[];
    correr: (c: Conversacion, e: Escuela, r: Resultado) => Promise<void>;
}

async function correrCasoAnuncio(caso: CasoAnuncio, e: Escuela): Promise<Resultado> {
    const conv = new Conversacion(caso.titulo, e.id, nuevoN(), caso.mapeo ? { whatsapp_anuncio_destino: caso.mapeo } : {});
    const r = nuevoResultado(caso.titulo, conv, 'anuncios');
    r.desenlace = 'respuesta';
    await protegido(r, () => caso.correr(conv, e, r));
    cerrar(r, e, null);
    progreso(r);
    return r;
}

async function correrAnuncios(e: Escuela): Promise<Resultado[]> {
    const items = await serviciosDeAnuncio(e.id);
    const clinica = items.find((it) => /\bclinicas?\b/.test(normalizar(it.name)));
    const vacacional = items.find((it) => it.kind === 'vacacional');
    // Un anuncio de un evento que la escuela NO tiene activo (el primero que no calza con nada del catálogo).
    const eventoSinServicio = ['Torneo relámpago de diciembre', 'Campamento de vacaciones', 'Clínica de líberos']
        .find((h) => inferirServicio([h], items).tipo === 'evento_sin_servicio') ?? null;
    const AD_CLASE = anuncio('qa-ad-clase', 'Ven a tu clase de prueba de voleibol', `Entrena con ${e.nombre}.`);
    const AD_MARCA = anuncio('qa-ad-marca', e.nombre, 'Entrena con nosotros. ¡Te esperamos!');
    const AD_GENERICO = anuncio('qa-ad-generico', '¡Inscríbete ya!', 'Cupos limitados.');
    const AD_CLINICA = clinica ? anuncio('qa-ad-clinica', clinica.name, 'Separa tu cupo con el 50 %.') : null;
    const perfil = perfilesConGrupo(e, 1, { genero: 'f' })[0] ?? null;
    const conClinica = (titulo: string, correr: (c: Conversacion, e: Escuela, r: Resultado, it: ItemConFicha) => Promise<void>, mapeo?: (it: ItemConFicha) => Fila[]): CasoAnuncio => ({
        titulo,
        ...(clinica && mapeo ? { mapeo: mapeo(clinica) } : {}),
        correr: async (c, ev, r) => {
            if (!clinica) { noAplica(r, 'la escuela no tiene una clínica activa en el catálogo'); return; }
            await correr(c, ev, r, clinica);
        },
    });
    const fila = (sourceId: string, destino: string, servicioId: string | null): Fila =>
        ({ id: randomUUID(), school_id: e.id, source_id: sourceId, destino, servicio_id: servicioId });

    // Contra la base real: la tabla del mapeo todavía no existe (o no tiene estos anuncios).
    const sinMapeo: CasoAnuncio[] = [
        conClinica('anuncio de la clínica (sin mapeo) + «quiero más información» → la ficha; y lo que pregunta después', async (c, ev, r, it) => {
            await c.decir('Hola, quiero más información', null, { referral: AD_CLINICA! });
            revisarFicha(c, ev, r, it);
            await c.decir('Listo, ¿a qué número te consigno?');
            noReinicia(c, ev, r);
            // Monster 2026-11-04: lo mandaba al buzón («ya le pasé tu mensaje a la escuela»)
            // justo cuando la persona iba a pagar. Tiene que volver a darle a dónde consignar.
            const t = c.ultimoTexto();
            debe(r, /nequi|bre-?b|daviplata|llave|cuenta|\b\d{7,}\b|@\w+/i.test(t) && !/le pas[eé] tu mensaje/i.test(t),
                'a «¿a qué número te consigno?» no le volvió a dar los datos de pago');
        }),
        conClinica('afiliado: anuncio de la clínica → su valor de afiliado', async (c, ev, r, it) => {
            await c.decir('Hola, quiero más información', null, { referral: AD_CLINICA!, rpc: { wa_es_afiliado: () => ({ afiliado: true }) } });
            revisarFicha(c, ev, r, it, { afiliado: true });
        }),
        ...['Buenas, info de la clínica', '¿Cuánto vale la clínica?', 'quiero inscribirme a la clínica'].map((texto) =>
            conClinica(`sin anuncio: «${texto}» → la ficha`, async (c, ev, r, it) => {
                await c.decir(texto);
                revisarFicha(c, ev, r, it);
            })),
        conClinica('la clínica a mitad del embudo de la clase de prueba: la ficha, y el embudo sigue donde iba', async (c, ev, r, it) => {
            await c.decir('Hola, quiero información para entrenar voleibol');
            const sede = ev.sedes.at(-1);
            if (sede && ev.sedes.length > 1) await c.tocar((o) => o.id === `${BOTON_EMBUDO.SEDE}${sede.branchId}`);
            await c.decir('¿cuánto vale la clínica?');
            revisarFicha(c, ev, r, it);
            await c.decir('Mariana Gómez Ruiz');
            const s = paraLaFamilia(c.turnos.at(-1)?.salidas ?? []).at(-1);
            debe(r, !!s && String(s.step ?? '').startsWith('embudo_'), `después de la ficha el embudo no siguió con su pregunta (step: ${s?.step ?? 'nada'})`);
        }),
        {
            titulo: 'anuncio de la clase de prueba → el embudo de siempre, hasta el pago',
            correr: async (c, ev, r) => {
                await c.decir('Hola, quiero más información', null, { referral: AD_CLASE });
                revisarEmbudoDeClase(c, ev, r, clinica);
                r.desenlace = 'inicio';
                if (perfil && !r.fallas.length) {
                    await seguir(c, ev, perfil, r);
                    // `seguir` cambia el desenlace (TS no lo ve): se lee como Desenlace.
                    const fin = r.desenlace as Desenlace;
                    debe(r, fin === 'pago' || fin === 'agendada', `el embudo del anuncio terminó en «${fin}»`);
                }
            },
        },
        {
            titulo: 'anuncio sin palabra de servicio (la marca) → el embudo de siempre',
            correr: async (c, ev, r) => {
                await c.decir('Hola', null, { referral: AD_MARCA });
                revisarEmbudoDeClase(c, ev, r, clinica);
                r.desenlace = 'inicio';
            },
        },
        {
            titulo: `anuncio de un evento que no está activo («${eventoSinServicio ?? '—'}») → una persona (nunca la clase de prueba)`,
            correr: async (c, ev, r) => {
                if (!eventoSinServicio) { noAplica(r, 'la escuela tiene activos un torneo, un vacacional y una clínica'); return; }
                await c.decir('Hola, me interesa', null, { referral: anuncio('qa-ad-sin-servicio', eventoSinServicio, 'Inscripciones abiertas') });
                revisarPersona(c, r);
                r.desenlace = 'persona';
            },
        },
        {
            titulo: 'anuncio del vacacional → su ficha con las opciones y sus valores',
            correr: async (c, ev, r) => {
                if (!vacacional) { noAplica(r, 'la escuela no tiene un vacacional activo'); return; }
                await c.decir('Hola, quiero más información', null, { referral: anuncio('qa-ad-vacacional', vacacional.name, 'Inscripciones abiertas') });
                revisarFicha(c, ev, r, vacacional);
                const texto = c.ultimoTexto();
                for (const o of (Array.isArray(vacacional.opciones) ? vacacional.opciones as any[] : [])) {
                    if (Number(o?.precio) > 0) debe(r, texto.includes(formatoPesos(Number(o.precio))), `no dice el valor de «${o.etiqueta}» (${formatoPesos(Number(o.precio))})`);
                }
                debe(r, !clinica || !texto.includes(clinica.name), 'mezcló la clínica en la ficha del vacacional');
            },
        },
    ];

    // Con el mapeo de la escuela (tabla virtual sembrada): el mapeo manda sobre la inferencia.
    const conMapeo: CasoAnuncio[] = [
        conClinica('anuncio genérico («¡Inscríbete ya!») mapeado a la clínica → la ficha', async (c, ev, r, it) => {
            await c.decir('Hola', null, { referral: AD_GENERICO });
            revisarFicha(c, ev, r, it);
        }, (it) => [fila('qa-ad-generico', 'servicio', it.id)]),
        conClinica('anuncio de la clínica mapeado a una persona → buzón y «alguien te responde»', async (c, _ev, r) => {
            await c.decir('Hola, quiero más información', null, { referral: AD_CLINICA! });
            revisarPersona(c, r);
            r.desenlace = 'persona';
        }, () => [fila('qa-ad-clinica', 'persona', null)]),
        conClinica('anuncio de la clínica mapeado a la clase de prueba → el embudo (el mapeo manda)', async (c, ev, r, it) => {
            await c.decir('Hola, quiero más información', null, { referral: AD_CLINICA! });
            revisarEmbudoDeClase(c, ev, r, it);
            r.desenlace = 'inicio';
        }, () => [fila('qa-ad-clinica', 'clase_prueba', null)]),
    ];

    const rs = await enParalelo(sinMapeo, (caso) => correrCasoAnuncio(caso, e));
    rs.push(...await conTablasVirtuales(['whatsapp_anuncio_destino'], () => enParalelo(conMapeo, (caso) => correrCasoAnuncio(caso, e))));
    process.stdout.write('\n');
    return rs;
}

// ─── «Pagar una mensualidad» de quien el teléfono no reconoce (whatsapp-pagar-mensualidad) ──

const TIENE_ACLARACION = (c: Conversacion) => c.opciones().some((o) => o.id === BOTON_PAGO_MENSUALIDAD.CLUB)
    && c.opciones().some((o) => o.id === BOTON_PAGO_MENSUALIDAD.INSCRIBIRME);
const ACUSE_GENERICO = /le pas[eé] tu mensaje a la escuela/i;

/**
 * Estados: (A) familia reconocida, (B) interesado del embudo, (C) desconocido. «Quiero
 * pagar una mensualidad» de B y C recibe UNA pregunta con dos botones, una sola vez; la
 * familia (A) sigue su flujo de pagos sin preguntas; preguntar «cuánto es» no abre la
 * aclaración; y «¿y si soy afiliado?» no le da la cifra de afiliado como suya.
 */
async function correrPagos(e: Escuela): Promise<Resultado[]> {
    const perfil = perfilesConGrupo(e, 1, { genero: 'f' })[0] ?? null;
    const items = await serviciosDeAnuncio(e.id);
    const clinica = items.find((it) => /\bclinicas?\b/.test(normalizar(it.name))) ?? null;
    const cifraAfiliado = clinica && Number(clinica.precio_afiliado) > 0 ? formatoPesos(Number(clinica.precio_afiliado)) : null;
    const extra: Resultado[] = [];
    const casos: { titulo: string; correr: (c: Conversacion, r: Resultado) => Promise<void>; familia?: boolean }[] = [
        {
            titulo: 'CAPTURA 05-nov: embudo → clínica → pagos → «Y si soy afiliado?» → «Para pagar una mensualidad»',
            correr: async (c, r) => {
                if (!perfil) { noAplica(r, 'ningún perfil tiene grupo con franjas'); return; }
                await c.decir('Hola, quiero información para una clase de prueba');
                await seguir(c, e, perfil, r);
                debe(r, r.desenlace === 'pago', `no llegó al pago del embudo (terminó en «${r.desenlace}»)`);
                // Cambiar de tema a mitad: no reinicia nada ni repite la bienvenida.
                await c.decir('Info de la clínica');
                noReinicia(c, e, r);
                await c.decir('¿A qué número te consigno?');
                noReinicia(c, e, r);
                await c.decir('Y si soy afiliado?');
                noReinicia(c, e, r);
                if (cifraAfiliado) debe(r, !c.ultimoTexto().includes(cifraAfiliado), `le dio la cifra de afiliado (${cifraAfiliado}) a quien no está reconocido como familia`);
                debe(r, !TIENE_ACLARACION(c), 'la hipótesis «¿y si soy afiliado?» abrió la aclaración de pago');
                await c.decir('Para pagar una mensualidad');
                debe(r, TIENE_ACLARACION(c), 'a «Para pagar una mensualidad» no le preguntó [Soy del club y pago] / [Quiero inscribirme]');
                debe(r, !ACUSE_GENERICO.test(c.ultimoTexto()), 'a «Para pagar una mensualidad» le contestó solo el acuse genérico');
                noReinicia(c, e, r);
                debe(r, c.opciones().length === 2, `la aclaración trae ${c.opciones().length} botones y no 2`);
                const club = c.bifurcar('captura · [Soy del club y pago]');
                const insc = c.bifurcar('captura · [Quiero inscribirme]');
                // Una sola vez por conversación: no la repite.
                await c.decir('Quiero pagar la mensualidad');
                debe(r, !TIENE_ACLARACION(c), 'repitió la aclaración (una sola vez por conversación)');
                // Botón 1 → la puerta del club: pide el nombre del deportista o el correo.
                const rc = nuevoResultado(club.titulo, club, 'pagos'); rc.desenlace = 'respuesta';
                await club.tocar((o) => o.id === BOTON_PAGO_MENSUALIDAD.CLUB);
                debe(rc, /nombre[^\n]*deportista/i.test(club.ultimoTexto()) && /correo/i.test(club.ultimoTexto()), 'el botón del club no pidió el nombre del deportista o el correo');
                await club.decir('Sofía Gómez Uribe');
                debe(rc, /alguien te responde|la escuela/i.test(club.ultimoTexto()), 'tras el nombre no dijo que la escuela le responde');
                // Botón 2 → el embudo: clase de prueba primero, la mensualidad después; sin reiniciar.
                const ri = nuevoResultado(insc.titulo, insc, 'pagos'); ri.desenlace = 'respuesta';
                await insc.tocar((o) => o.id === BOTON_PAGO_MENSUALIDAD.INSCRIBIRME);
                debe(ri, /clase/i.test(insc.ultimoTexto()) && /mensualidad/i.test(insc.ultimoTexto()), 'el botón de inscribirme no explicó la clase primero y la mensualidad después');
                noReinicia(insc, e, ri);
                extra.push(cerrar(rc, e, null), cerrar(ri, e, null));
            },
        },
        {
            titulo: 'interesado: clínica → «Quiero pagar la mensualidad» → la aclaración (y con el título del botón escrito)',
            correr: async (c, r) => {
                await c.decir('Hola, quiero información para una clase de prueba');
                if (e.sedes.length > 1) await c.tocar((o) => o.id.startsWith(BOTON_EMBUDO.SEDE));
                await c.decir('Info de la clínica');
                await c.decir('Quiero pagar la mensualidad');
                debe(r, TIENE_ACLARACION(c), 'no preguntó si es del club o quiere inscribirse');
                debe(r, !/gratis/i.test(c.ultimoTexto()), 'dice «gratis»');
                await c.decir('Soy del club y pago');
                debe(r, /nombre[^\n]*deportista/i.test(c.ultimoTexto()), 'el título escrito del botón del club no pidió el nombre del deportista');
            },
        },
        {
            titulo: 'desconocido sin contexto: «voy a pagar la mensualidad» → la aclaración → [Quiero inscribirme] arranca el embudo',
            correr: async (c, r) => {
                await c.decir('Voy a pagar la mensualidad');
                debe(r, TIENE_ACLARACION(c), 'a un desconocido que dice «voy a pagar la mensualidad» no le preguntó');
                await c.tocar((o) => o.id === BOTON_PAGO_MENSUALIDAD.INSCRIBIRME);
                debe(r, c.opciones().some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE)) || /clase/i.test(c.ultimoTexto()), 'no siguió el embudo de la clase de prueba');
                // «Cancelar la mensualidad» (en Colombia = pagar) también.
                const c2 = new Conversacion('cancelar', e.id, nuevoN());
                await c2.decir('Quiero cancelar la mensualidad');
                debe(r, TIENE_ACLARACION(c2), '«quiero cancelar la mensualidad» no abrió la aclaración');
            },
        },
        {
            titulo: 'interesado pregunta «¿cuánto es la mensualidad?» → el valor, sin la aclaración de pago',
            correr: async (c, r) => {
                if (!perfil) { noAplica(r, 'ningún perfil tiene grupo con franjas'); return; }
                await c.decir('Hola, quiero información para entrenar voleibol');
                await seguir(c, e, perfil, r);
                await c.decir('¿Cuánto es la mensualidad?');
                debe(r, !TIENE_ACLARACION(c), 'a «¿cuánto es la mensualidad?» le abrió la aclaración de pago');
                if (c.hablo()) debe(r, /\$\s?\d{1,3}([.,]\d{3})+/.test(c.ultimoTexto()), 'no le dio el valor de la mensualidad');
                noReinicia(c, e, r);
                debe(r, !diceClaseGratis(c.ultimoTexto(), false), 'dice «gratis»');
            },
        },
        {
            titulo: 'FAMILIA reconocida: «Para pagar una mensualidad» → su flujo de pagos, sin preguntar nada',
            familia: true,
            correr: async (c, r) => {
                await c.decir('Para pagar una mensualidad');
                debe(r, !TIENE_ACLARACION(c), 'a la familia reconocida le preguntó si es del club');
                debe(r, !c.salidas().some((s) => s.step === PASO_PAGO_ACLARACION), 'a la familia reconocida le mandó la aclaración');
            },
        },
    ];
    const rs = await enParalelo(casos, async (caso) => {
        const c = new Conversacion(caso.titulo, e.id, nuevoN());
        if (caso.familia) {
            // El número ya está ligado a un deportista inscrito: la identificación de la sesión (un id inexistente).
            c.sesion.rol = 'papa';
            c.sesion.parent_id = randomUUID();
        }
        const r = nuevoResultado(caso.titulo, c, 'pagos');
        r.desenlace = 'respuesta';
        await protegido(r, () => caso.correr(c, r));
        cerrar(r, e, null);
        progreso(r);
        return r;
    });
    process.stdout.write('\n');
    return [...rs, ...extra];
}

// ─── Conversaciones reales de producción (Monster 2026-11-05) ───────────────

const PASO_DEBE_REGISTRARSE = 'debe_registrarse';
const ENLACE_DE_REGISTRO = /Créala aquí|cuenta creada|\/register/i;
const DATOS_DE_PAGO = /\b(nequi|daviplata|bre-?b|llave)\b|\d{7,}/i;

/**
 * Cuatro fallos del bot encendido en Monster, con los textos de las familias:
 *  1. «Hello Pipe!! …» / «Hola Pipe, como vas ??» (número registrado sin cuenta): charla con
 *     alguien de la escuela → ni `debe_registrarse` ni ninguna otra respuesta; queda en el buzón.
 *  2. Disputa de pago («me llegó un correo donde dice que debo», «yo envié el comprobante») →
 *     un acuse corto, SIN datos de pago, a la escuela; una sola vez.
 *  3. «me indicas a donde consigno» → datos de pago; «este numero?» → se confirma el dato, sin
 *     el enlace de registro.
 *  4. «el campamento del 21 de nov… hasta qué edades aplica» (es la clínica) → la ficha o el
 *     pedazo del texto de la escuela, no la bienvenida que pide la sede.
 * Cada uno corre como número sin ficha (desconocido) y como familia registrada sin cuenta.
 */
async function correrConversaciones(e: Escuela): Promise<Resultado[]> {
    const items = await serviciosDeAnuncio(e.id);
    const clinica = items.find((it) => /\bclinicas?\b/.test(normalizar(it.name))) ?? null;
    const PREGUNTA_EDAD = 'por favor me confirmas el campamentos del 21 de nov. hasta que edades aplica';
    type Caso = { titulo: string; sinCuenta?: boolean; correr: (c: Conversacion, r: Resultado) => Promise<void> };

    const personal = (titulo: string, texto: string): Caso => ({
        titulo, sinCuenta: true,
        correr: async (c, r) => {
            await c.decir(texto, null, { silencioOk: true });
            debe(r, !c.hablo(), `le contestó algo a un mensaje personal para alguien de la escuela: «${c.ultimoTexto().slice(0, 80)}»`);
            debe(r, !huboPaso(c, PASO_DEBE_REGISTRARSE) && !ENLACE_DE_REGISTRO.test(c.textos()), 'le mandó el aviso/enlace de registro');
        },
    });

    const disputa = (titulo: string, sinCuenta: boolean): Caso => ({
        titulo, sinCuenta,
        correr: async (c, r) => {
            await c.decir('Una pregunta, es que iba a hacer el pago de la mensualidad y lo del torneo, pero me fijé y llegó un correo de un portal de pagos donde dice que yo debo la mensualidad');
            debe(r, huboPaso(c, 'disputa_de_pago'), 'no lo pasó a la escuela (no hubo el acuse de disputa)');
            debe(r, !DATOS_DE_PAGO.test(c.textos()) && !huboPaso(c, 'medios_de_pago_publicos'), 'a una disputa de pago le dio datos de pago');
            debe(r, /escuela/i.test(c.ultimoTexto()), 'el acuse no dice que lo revisa la escuela');
            await c.decir('Estaba revisando y yo envié el mes pasado el comprobante', null, { silencioOk: true });
            debe(r, !DATOS_DE_PAGO.test(c.textos()), 'al «yo envié el comprobante» le dio datos de pago');
            debe(r, c.salidas().filter((s) => s.step === 'disputa_de_pago').length === 1, 'repitió el acuse de la disputa');
        },
    });

    const seguimiento = (titulo: string, sinCuenta: boolean): Caso => ({
        titulo, sinCuenta,
        correr: async (c, r) => {
            await c.decir('me indicas a donde consigno por favor');
            debe(r, huboPaso(c, 'medios_de_pago_publicos'), 'no le dio los datos de pago');
            const dato = c.ultimoTexto().match(/•[^\n:]*:\s*(\S+)/)?.[1] ?? null;
            await c.decir('este numero?');
            debe(r, !huboPaso(c, PASO_DEBE_REGISTRARSE) && !ENLACE_DE_REGISTRO.test(c.textos()), 'a «este numero?» le mandó el enlace de registro');
            debe(r, huboPaso(c, 'medios_de_pago_confirma'), 'no confirmó el dato ya dado');
            if (dato) debe(r, c.ultimoTexto().includes(dato), `la confirmación no repite el dato (${dato})`);
            await c.decir('y a nombre de quién?', null, { silencioOk: true });
            debe(r, !huboPaso(c, PASO_DEBE_REGISTRARSE) && !ENLACE_DE_REGISTRO.test(c.textos()), 'a «y a nombre de quién?» le mandó el enlace de registro');
        },
    });

    const evento = (titulo: string, sinCuenta: boolean, antes: string | null): Caso => ({
        titulo, sinCuenta,
        correr: async (c, r) => {
            if (!clinica) { noAplica(r, 'no hay una clínica activa en el catálogo'); return; }
            const desde = new Date(String(clinica.starts_at ?? '')).getTime();
            if (!(desde > Date.now())) { noAplica(r, 'la clínica activa ya empezó'); return; }
            if (antes) await c.decir(antes);
            await c.decir(PREGUNTA_EDAD);
            const t = c.ultimoTexto();
            debe(r, c.salidas().some((s) => (s.payload as any)?.[MARCA_DESTINO] === 'servicio'), 'no contestó con la ficha del servicio (o el pedazo de su texto)');
            debe(r, !c.salidas().some((s) => (s.step === 'desconocido_tema_escolar' || s.step === PASO_DEBE_REGISTRARSE) && !(s.payload as any)?.[MARCA_DESTINO]),
                'contestó con la bienvenida/registro en vez de la pregunta');
            const edad = /(\d{1,2})\s*a[ñn]os/i.exec(String(clinica.description ?? ''))?.[0];
            if (edad) debe(r, t.includes(edad), `la respuesta no trae la edad que dice la escuela («${edad}»)`);
        },
    });

    const casos: Caso[] = [
        personal('«Hello Pipe!! Cómo vas? … compartir la aplicación con los acudientes» → silencio, sin enlace de registro',
            'Hello Pipe!! Cómo vas? Disculpame ayer no recuerdo si podemos compartir la aplicación con los acudientes o no'),
        personal('«Hola Pipe, como vas ??» → silencio, sin enlace de registro', 'Hola Pipe, como vas ??'),
        personal('«Hola profe Iván, cómo está» → silencio, sin enlace de registro', 'Hola profe Iván, cómo está'),
        disputa('DISPUTA de pago (número registrado sin cuenta) → a la escuela, sin datos de pago', true),
        disputa('DISPUTA de pago (número sin ficha) → a la escuela, sin datos de pago', false),
        seguimiento('SEGUIMIENTO «este numero?» (registrado sin cuenta) → confirma el dato, sin enlace de registro', true),
        seguimiento('SEGUIMIENTO «este numero?» (número sin ficha) → confirma el dato', false),
        evento('EVENTO «campamento del 21 de nov… edades» (número sin ficha) → la ficha de la clínica', false, null),
        evento('EVENTO «campamento del 21 de nov… edades» tras «info de la clínica» → el pedazo que responde', false, 'Info de la clínica'),
    ];
    const rs = await enParalelo(casos, async (caso) => {
        const c = new Conversacion(caso.titulo, e.id, nuevoN());
        if (caso.sinCuenta) { c.sesion.rol = 'papa'; c.sesion.parent_id = null; }
        const r = nuevoResultado(caso.titulo, c, 'conversaciones');
        r.desenlace = 'respuesta';
        await protegido(r, () => caso.correr(c, r));
        cerrar(r, e, null);
        progreso(r);
        return r;
    });
    process.stdout.write('\n');
    return rs;
}

// ─── Formularios de WhatsApp (Flows, fase F-a) ──────────────────────────────

/**
 * Las tablas del formulario van VIRTUALES (whatsapp_flows sembrada con el estado
 * que pide cada caso, las respuestas y los consentimientos en memoria) y el
 * catálogo también (el caso «servicio desactivado» apaga la clínica en SU copia).
 * El secreto del token, si el .env no lo trae, es uno local de la batería.
 */
const TABLAS_FLOWS = ['whatsapp_flows', 'whatsapp_flow_respuestas', 'whatsapp_consentimientos', 'school_tournament_items'];
const SECRETO_QA = 'qa-embudo-flows-secreto-local';

/** El formulario terminado tal como lo trae el webhook (`interactive.nfm_reply`). */
const nfm = (token: string | null, datos: Record<string, unknown>): Record<string, unknown> => ({
    type: 'interactive',
    interactive: {
        type: 'nfm_reply',
        nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify({ ...(token ? { flow_token: token } : {}), ...datos }) },
    },
});

interface CasoFlow {
    titulo: string;
    /** Cambios a la fila virtual de whatsapp_flows (estado, activo, salud). */
    fila?: Partial<Fila>;
    correr: (c: Conversacion, e: Escuela, r: Resultado, x: CtxFlows) => Promise<void>;
}

interface CtxFlows {
    clinica: ItemConFicha;
    integrationId: string;
    flowJson: Record<string, any>;
}

/** La primera vuelta: anuncio de la clínica → la ficha y DESPUÉS el formulario, bien armado. */
async function hastaFormulario(c: Conversacion, e: Escuela, r: Resultado, x: CtxFlows): Promise<SalidaSimulada | null> {
    await c.decir('Hola, quiero más información', null, {
        referral: anuncio('qa-ad-clinica', x.clinica.name, 'Separa tu cupo con el 50 %.'),
    });
    revisarFicha(c, e, r, x.clinica);
    const fam = paraLaFamilia(c.turnos.at(-1)?.salidas ?? []);
    const iForm = fam.findIndex((s) => s.formulario);
    const iFicha = fam.findIndex((s) => (s.payload as any)?.[MARCA_DESTINO] === 'servicio');
    debe(r, iForm >= 0, 'no mandó el formulario aunque está publicado, prendido y sano');
    if (iForm < 0) return null;
    debe(r, iFicha >= 0 && iFicha < iForm, 'el formulario tiene que ir DESPUÉS de la ficha (si no abre, la ficha ya tiene cómo pagar)');
    const s = fam[iForm];
    const f = s.formulario!;
    debe(r, f.cta === CTA_FORMULARIO_SERVICIO && f.pantalla === PANTALLA_INICIAL_SERVICIO, `botón/pantalla inesperados: ${f.cta} · ${f.pantalla}`);
    const problemas = validarDatosDeEntrada(x.flowJson, PANTALLA_INICIAL_SERVICIO, f.data);
    debe(r, !problemas.length, `los datos inyectados no caben en el JSON: ${problemas.map((p) => `${p.ruta} ${p.problema}`).join('; ')}`);
    const hoy = precioDeHoyEsperado(x.clinica, false);
    if (hoy) debe(r, String(f.data.valor ?? '').includes(formatoPesos(hoy)), `la ficha del formulario no dice el precio de hoy (${formatoPesos(hoy)})`);
    if (Number(x.clinica.precio_afiliado) > 0) {
        debe(r, String(f.data.valor_afiliado ?? '').includes(formatoPesos(Number(x.clinica.precio_afiliado))), 'la ficha del formulario no dice el valor de afiliado');
    }
    const v = verificarTokenFormulario(f.token);
    debe(r, v.ok, `el token no verifica (${v.ok ? '' : v.motivo})`);
    if (v.ok) {
        debe(r, v.token.servicioId === x.clinica.id && v.token.contactWaId === c.contacto()
            && v.token.conversationId === conversacionDePrueba(c.sesion), 'el token no es de esta conversación / servicio');
        debe(r, Math.abs(v.token.venceEn - Date.now() - 72 * 3600_000) < 120_000, 'el token no vence a las 72 h');
    }
    debe(r, !!payloadDeFormulario(c.contacto(), { flowId: f.flowId, cta: f.cta, cuerpo: s.texto, token: f.token, pantalla: f.pantalla, data: f.data }),
        'el mensaje del formulario no cabe en los límites de Meta');
    debe(r, !!f.respaldo && /comprobante|te escribe/i.test(f.respaldo), 'el formulario no lleva respaldo por chat');
    return s;
}

/** Lo que llenaría la persona, con lo que el formulario mostró. */
function llenado(s: SalidaSimulada, o: { afiliado?: 'si' | 'no'; abono?: boolean; novedades?: boolean; datos?: boolean } = {}): Record<string, unknown> {
    const d = s.formulario!.data as Record<string, any>;
    return {
        formulario: FORMULARIO_SERVICIO,
        nombre_deportista: 'Mariana Gómez Ruiz',
        fecha_nacimiento: `${ANIO - 14}-05-09`,
        afiliado: o.afiliado ?? 'no',
        talla: d.pide_talla ? String(d.tallas?.[0]?.id ?? 'M') : '',
        acepta_datos: o.datos ?? true,
        acepta_novedades: o.novedades ?? true,
        forma_pago: d.hay_abono ? (o.abono ? 'abono' : 'completo') : '',
    };
}

async function responder(c: Conversacion, token: string | null, datos: Record<string, unknown>, rotulo: string,
    o: { waMessageId?: string; silencioOk?: boolean; rpc?: Record<string, (args: any) => unknown> } = {}): Promise<SalidaSimulada[]> {
    return c.decir('Formulario enviado', null, {
        raw: nfm(token, datos), rotulo: `📝 formulario: ${rotulo}`, waMessageId: o.waMessageId, silencioOk: o.silencioOk, rpc: o.rpc,
    });
}

const respuestasEnMemoria = (c: Conversacion) => (c.sesion.estado.tablas?.whatsapp_flow_respuestas ?? []) as Fila[];
const consentimientosEnMemoria = (c: Conversacion) => (c.sesion.estado.tablas?.whatsapp_consentimientos ?? []) as Fila[];
const bloqueadasDelTurno = (c: Conversacion) => c.turnos.at(-1)?.bloqueadas ?? [];

/** Una respuesta procesada: un mensaje con el monto, el esperado intentado, consentimientos y la fila cerrada. */
function revisarProcesada(c: Conversacion, r: Resultado, o: { monto: number; resultado: string; novedades: boolean; afiliadoTexto?: RegExp }): void {
    const fam = paraLaFamilia(c.turnos.at(-1)?.salidas ?? []);
    debe(r, fam.length === 1, `la respuesta al formulario tiene que ser UN mensaje (salieron ${fam.length})`);
    const s = fam[0];
    if (!s) return;
    const p = (s.payload ?? {}) as Record<string, any>;
    debe(r, s.step === 'formulario_respuesta' && p.resultado === o.resultado, `resultado ${p.resultado ?? '—'} (se esperaba ${o.resultado})`);
    debe(r, p.monto === o.monto, `monto ${p.monto} (se esperaba ${o.monto})`);
    debe(r, s.texto.includes(formatoPesos(o.monto)), `no le dice el valor a pagar (${formatoPesos(o.monto)})`);
    debe(r, /comprobante|te escribe por aqu[ií] con los datos de pago/i.test(s.texto), 'no le dice cómo pagar');
    if (o.afiliadoTexto) debe(r, o.afiliadoTexto.test(s.texto), `no menciona lo del afiliado (${o.afiliadoTexto})`);
    debe(r, bloqueadasDelTurno(c).some((b) => /^(insert|update) whatsapp_conceptos_esperados$/.test(b)),
        'no intentó registrar el motivo esperado con el monto (el cortafuegos no vio el insert)');
    debe(r, p.motivo_esperado?.monto === o.monto, 'el motivo esperado no lleva el monto elegido');
    const filas = respuestasEnMemoria(c);
    debe(r, filas.length >= 1 && filas.at(-1)!.resultado === o.resultado, `whatsapp_flow_respuestas: ${filas.at(-1)?.resultado ?? 'sin fila'}`);
    const cons = consentimientosEnMemoria(c).filter((x) => x.contact_wa_id === c.contacto());
    debe(r, cons.some((x) => x.tipo === 'datos' && x.aceptado === true && x.canal === 'formulario' && x.version_politica),
        'no guardó el consentimiento de datos');
    debe(r, cons.some((x) => x.tipo === 'novedades' && x.aceptado === o.novedades), 'no guardó el consentimiento de novedades');
    debe(r, bloqueadasDelTurno(c).includes('rpc wa_register_optin') === o.novedades,
        o.novedades ? 'aceptó novedades y no intentó el opt-in' : 'registró opt-in sin que aceptara novedades');
}

/** Ni lead, ni esperado, ni consentimientos: el formulario no aplicó nada. */
function revisarNoAplico(c: Conversacion, r: Resultado, resultado: string, texto: RegExp): void {
    const t = c.turnos.at(-1)!;
    const fam = paraLaFamilia(t.salidas);
    debe(r, fam.some((s) => texto.test(s.texto)), `no le explicó (${texto})`);
    debe(r, t.salidas.some(esNotaDelSimulador), 'no avisó a la escuela por el buzón');
    debe(r, !t.bloqueadas.some((b) => /whatsapp_conceptos_esperados|wa_register_optin/.test(b)), 'aplicó algo (esperado u opt-in) con un formulario que no vale');
    debe(r, !consentimientosEnMemoria(c).length, 'guardó consentimientos con un formulario que no vale');
    const fila = respuestasEnMemoria(c).at(-1);
    debe(r, fila?.resultado === resultado, `whatsapp_flow_respuestas: ${fila?.resultado ?? 'sin fila'} (se esperaba ${resultado})`);
    debe(r, !fila || !('nombre_deportista' in (fila.response_json ?? {})), 'guardó datos personales de un formulario que no vale');
}

async function correrFlows(e: Escuela): Promise<Resultado[]> {
    if (!process.env[ENV_SECRETO_TOKEN] || process.env[ENV_SECRETO_TOKEN]!.length < 16) process.env[ENV_SECRETO_TOKEN] = SECRETO_QA;
    const items = await serviciosDeAnuncio(e.id);
    const clinica = items.find((it) => /\bclinicas?\b/.test(normalizar(it.name)) && !(Array.isArray(it.opciones) && it.opciones.length));
    const integ = await integracionParaSimular(e.id);
    const flowJson = leerFlowDelRepo(FORMULARIO_SERVICIO).json;
    const { data: catalogo } = await supabase.from('school_tournament_items').select('*').eq('school_id', e.id).limit(200);
    const filaFlow = (cambios: Partial<Fila> = {}): Fila => ({
        id: randomUUID(), school_id: e.id, integration_id: integ.id, nombre: FORMULARIO_SERVICIO, flow_id: '900000000000001',
        estado: 'PUBLISHED', activo: true, health_can_send: 'AVAILABLE', health_revisado_at: new Date().toISOString(), config: {},
        ...cambios,
    });
    const x: CtxFlows | null = clinica ? { clinica, integrationId: integ.id, flowJson } : null;
    const firmar = (c: Conversacion, o: { ahora?: number; secreto?: string; lista?: number } = {}) => firmarTokenFormulario({
        schoolId: e.id, conversationId: conversacionDePrueba(c.sesion), contactWaId: c.contacto(), formulario: FORMULARIO_SERVICIO,
        servicioId: clinica!.id,
        precios: { lista: o.lista ?? precioDeHoyEsperado(clinica!, false), afiliado: Number(clinica!.precio_afiliado) > 0 ? Number(clinica!.precio_afiliado) : null, abonoPct: Number(clinica!.abono_minimo_pct) || null },
    }, { ahora: o.ahora, secreto: o.secreto })!;
    const pct = clinica && clinica.allow_installments === true ? Number(clinica.abono_minimo_pct) : NaN;
    const abonoDe = (precio: number) => (pct >= 1 && pct < 100 ? Math.ceil((precio * pct) / 100) : precio);
    const lista = clinica ? precioDeHoyEsperado(clinica, false)! : 0;
    const afiliado = clinica && Number(clinica.precio_afiliado) > 0 ? Number(clinica.precio_afiliado) : null;

    const CASOS: CasoFlow[] = [
        {
            titulo: 'el JSON del repo pasa la validación local y EXIGE el consentimiento de datos',
            correr: async (_c, _e, r) => {
                const problemas = validarFlowJson(flowJson);
                debe(r, !problemas.length, `el Flow JSON no pasa: ${problemas.map((p) => `${p.ruta} ${p.problema}`).join('; ')}`);
                const optin = (flowJson.screens as any[]).flatMap((s) => s.layout?.children ?? []).find((ch: any) => ch.name === 'acepta_datos');
                debe(r, optin?.type === 'OptIn' && optin?.required === true, 'el OptIn de datos no es obligatorio: el formulario se podría enviar sin aceptarlo');
                r.desenlace = 'respuesta';
            },
        },
        {
            titulo: 'completo · no afiliado: consentimientos + opt-in, esperado con el valor de hoy y los datos de pago',
            correr: async (c, ev, r, xx) => {
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, s.formulario!.token, llenado(s), 'completo · no afiliado');
                revisarProcesada(c, r, { monto: lista, resultado: 'procesada', novedades: true });
            },
        },
        {
            titulo: 'abono · no afiliado: el esperado es el abono',
            correr: async (c, ev, r, xx) => {
                if (!(pct >= 1 && pct < 100)) { noAplica(r, 'la clínica no tiene abono'); return; }
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, s.formulario!.token, llenado(s, { abono: true, novedades: false }), 'abono · no afiliado');
                revisarProcesada(c, r, { monto: abonoDe(lista), resultado: 'procesada', novedades: false });
            },
        },
        {
            titulo: 'completo · dice que es afiliado (el número no lo confirma): valor de afiliado, se lo dice y avisa',
            correr: async (c, ev, r, xx) => {
                if (!afiliado) { noAplica(r, 'la clínica no tiene precio de afiliado'); return; }
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, s.formulario!.token, llenado(s, { afiliado: 'si' }), 'completo · afiliado declarado');
                revisarProcesada(c, r, { monto: afiliado, resultado: 'procesada', novedades: true, afiliadoTexto: /la escuela confirma/ });
                debe(r, c.turnos.at(-1)!.salidas.some(esNotaDelSimulador), 'no avisó a la escuela que confirme el afiliado');
            },
        },
        {
            titulo: 'abono · afiliado confirmado por el número: el abono del valor de afiliado',
            correr: async (c, ev, r, xx) => {
                if (!afiliado || !(pct >= 1 && pct < 100)) { noAplica(r, 'la clínica no tiene afiliado con abono'); return; }
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, s.formulario!.token, llenado(s, { afiliado: 'no', abono: true }), 'abono · afiliado por el número',
                    { rpc: { wa_es_afiliado: () => ({ afiliado: true }) } });
                revisarProcesada(c, r, { monto: abonoDe(afiliado), resultado: 'procesada', novedades: true, afiliadoTexto: /afiliado/ });
                debe(r, !/la escuela confirma/.test(c.ultimoTexto()), 'pidió confirmar un afiliado que el número ya confirma');
            },
        },
        {
            titulo: 'sin consentimiento de datos: nada personal guardado, lo pide y reenvía el formulario',
            correr: async (c, ev, r, xx) => {
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, s.formulario!.token, llenado(s, { datos: false }), 'sin aceptar datos');
                const t = c.turnos.at(-1)!;
                const fam = paraLaFamilia(t.salidas);
                debe(r, fam.some((m) => /aceptes la pol[ií]tica/.test(m.texto)), 'no le pidió aceptar la política');
                debe(r, fam.some((m) => m.formulario), 'no le reenvió el formulario');
                debe(r, !t.bloqueadas.some((b) => /whatsapp_conceptos_esperados|wa_register_optin/.test(b)), 'aplicó esperado u opt-in sin consentimiento');
                debe(r, !consentimientosEnMemoria(c).length, 'guardó consentimientos sin aceptar los datos');
                const fila = respuestasEnMemoria(c).at(-1);
                debe(r, fila?.resultado === 'sin_consentimiento', `whatsapp_flow_respuestas: ${fila?.resultado ?? 'sin fila'}`);
                debe(r, !!fila && !('nombre_deportista' in (fila.response_json ?? {})) && !('fecha_nacimiento' in (fila.response_json ?? {})),
                    'guardó el nombre o la fecha sin consentimiento');
            },
        },
        {
            titulo: 'token inválido (firma de otro secreto): no aplica nada y avisa al buzón',
            correr: async (c, ev, r, xx) => {
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, firmar(c, { secreto: 'otro-secreto-que-no-es-el-del-bff' }), llenado(s), 'token inválido');
                revisarNoAplico(c, r, 'token_invalido', /No pude validar este formulario/);
            },
        },
        {
            titulo: 'token vencido (enviado hace 73 h): no aplica nada, se lo dice y avisa',
            correr: async (c, ev, r, xx) => {
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, firmar(c, { ahora: Date.now() - 73 * 3600_000 }), llenado(s), 'token vencido');
                revisarNoAplico(c, r, 'token_vencido', /ya venci[oó]/);
            },
        },
        {
            titulo: 'el servicio se desactivó entre el envío y la respuesta: a una persona, sin esperado',
            correr: async (c, ev, r, xx) => {
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                for (const it of (c.sesion.estado.tablas?.school_tournament_items ?? []) as Fila[]) if (it.id === xx.clinica.id) it.active = false;
                await responder(c, s.formulario!.token, llenado(s), 'servicio desactivado');
                const t = c.turnos.at(-1)!;
                debe(r, paraLaFamilia(t.salidas).some((m) => /ya no est[aá] abierta/.test(m.texto)), 'no le dijo que la inscripción ya no está abierta');
                debe(r, t.salidas.some(esNotaDelSimulador), 'no pasó a una persona');
                debe(r, !t.bloqueadas.some((b) => /whatsapp_conceptos_esperados/.test(b)), 'registró un esperado de un servicio inactivo');
                debe(r, respuestasEnMemoria(c).at(-1)?.resultado === 'servicio_inactivo', 'la respuesta no quedó como servicio_inactivo');
                r.desenlace = 'persona';
            },
        },
        {
            titulo: 'el precio cambió entre el envío y la respuesta: cobra el vigente y se lo dice',
            correr: async (c, ev, r, xx) => {
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                await responder(c, firmar(c, { lista: lista - 20000 }), llenado(s), 'precio cambiado');
                revisarProcesada(c, r, { monto: lista, resultado: 'procesada_precio_nuevo', novedades: true });
                debe(r, /el valor cambi[oó]/i.test(c.ultimoTexto()) && c.ultimoTexto().includes(formatoPesos(lista - 20000)),
                    'no le dijo que el valor cambió (y cuál vio)');
            },
        },
        {
            titulo: 'respuesta duplicada (mismo wa_message_id): la segunda no hace nada',
            correr: async (c, ev, r, xx) => {
                const s = await hastaFormulario(c, ev, r, xx);
                if (!s) return;
                const id = `qa-nfm-${randomUUID()}`;
                await responder(c, s.formulario!.token, llenado(s), 'primera', { waMessageId: id });
                await responder(c, s.formulario!.token, llenado(s), 'duplicada', { waMessageId: id, silencioOk: true });
                debe(r, !paraLaFamilia(c.turnos.at(-1)!.salidas).length, 'contestó dos veces el mismo formulario');
                debe(r, respuestasEnMemoria(c).length === 1, `quedaron ${respuestasEnMemoria(c).length} filas en whatsapp_flow_respuestas`);
                debe(r, !c.turnos.at(-1)!.bloqueadas.some((b) => /whatsapp_conceptos_esperados|wa_register_optin/.test(b)), 'la duplicada volvió a aplicar');
            },
        },
        ...([
            ['en borrador (no publicado)', { estado: 'DRAFT' }],
            ['apagado por la escuela (activo = false)', { activo: false }],
            ['bloqueado contra el número (negocio sin verificar)', { health_can_send: 'BLOCKED' }],
            ['sin dato de salud', { health_can_send: null, health_revisado_at: null }],
        ] as [string, Partial<Fila>][]).map(([que, fila]): CasoFlow => ({
            titulo: `formulario ${que} → solo la ficha (el chat de hoy)`,
            fila,
            correr: async (c, ev, r, xx) => {
                await c.decir('Hola, quiero más información', null, { referral: anuncio('qa-ad-clinica', xx.clinica.name, 'Separa tu cupo.') });
                revisarFicha(c, ev, r, xx.clinica);
                debe(r, !paraLaFamilia(c.turnos.at(-1)!.salidas).some((s) => s.formulario), 'mandó un formulario que no se puede mandar');
            },
        })),
    ];

    const rs = await conTablasVirtuales(TABLAS_FLOWS, () => enParalelo(CASOS, async (caso) => {
        const conv = new Conversacion(caso.titulo, e.id, nuevoN(), {
            whatsapp_flows: [filaFlow(caso.fila)],
            whatsapp_flow_respuestas: [],
            whatsapp_consentimientos: [],
            school_tournament_items: (catalogo ?? []) as Fila[],
        });
        const r = nuevoResultado(caso.titulo, conv, 'flows');
        r.desenlace = 'respuesta';
        await protegido(r, async () => {
            if (!x) { noAplica(r, 'la escuela no tiene una clínica activa con un solo precio'); return; }
            await caso.correr(conv, e, r, x);
        });
        cerrar(r, e, null);
        progreso(r);
        return r;
    }));
    process.stdout.write('\n');
    return rs;
}

// ─── Reporte ─────────────────────────────────────────────────────────────────

const esBien = (r: Resultado) => !r.fallas.length && !r.esperadas.length;

function resumen(rs: Resultado[]): string {
    const conFallas = rs.filter((r) => r.fallas.length).length;
    const soloEsperadas = rs.filter((r) => !r.fallas.length && r.esperadas.length).length;
    const lim = rs.filter((r) => r.limitaciones.length).length;
    const noAplican = rs.filter((r) => r.desenlace === 'no_aplica').length;
    return [`${rs.length} conversaciones`, `${rs.filter(esBien).length} bien`,
        conFallas ? `${conFallas} con fallas` : '', soloEsperadas ? `${soloEsperadas} solo con fallas esperadas` : '',
        lim ? `${lim} con limitaciones de la simulación` : '', noAplican ? `${noAplican} no aplican` : '']
        .filter(Boolean).join(' · ');
}

function transcripcion(r: Resultado): string {
    const icono = r.fallas.length ? '❌' : r.esperadas.length ? '⏳' : r.limitaciones.length ? '⚠️' : '✅';
    const lineas = [`### ${icono} [${r.bloque}${r.variante ? ` · ${r.variante}` : ''}] ${r.titulo} — ${r.desenlace}${r.grupo ? ` · ${r.grupo}` : ''}`];
    for (const f of r.fallas) lineas.push(`- **Falla:** ${f}`);
    for (const f of r.esperadas) lineas.push(`- **Esperada:** ${f}`);
    for (const f of r.limitaciones) lineas.push(`- Limitación de la simulación: ${f}`);
    for (const a of r.avisos) lineas.push(`- Aviso: ${a}`);
    lineas.push('');
    const desde = Math.max(0, r.conv.heredados - 1);
    if (desde > 0) lineas.push(`> _(… ${desde} turnos de la conversación base)_`, '>');
    for (const t of r.conv.turnos.slice(desde)) {
        lineas.push(t.sistema ? `> ⚙️ ${t.entrada}` : `> 👤 ${t.entrada}${t.botonId ? ` \`[${t.botonId.slice(0, 24)}]\`` : ''}`);
        if (!t.salidas.length) lineas.push(`> 🤖 _(nada${t.nota ? `: ${t.nota}` : ''})_`);
        for (const s of t.salidas) {
            if (esNotaDelSimulador(s)) { lineas.push(`> _${s.texto}_`); continue; }
            lineas.push(`> 🤖 ${s.texto.replace(/\n/g, '\n> ')}`);
            if (s.opciones?.length) lineas.push(`> ${s.opciones.map((o) => `[${o.title}${o.descripcion ? ` · ${o.descripcion}` : ''}]`).join(' ')}`);
        }
        if (t.salidas.length && !paraLaFamilia(t.salidas).length) lineas.push(`> _(la familia no recibe nada${t.nota ? `: ${t.nota}` : ''})_`);
        lineas.push('>');
    }
    return lineas.join('\n');
}

function imprimirFallas(rs: Resultado[]): void {
    for (const r of rs.filter((x) => x.fallas.length || x.esperadas.length || x.limitaciones.length)) {
        const icono = r.fallas.length ? '❌' : r.esperadas.length ? '⏳' : '⚠️';
        log(`\n${icono} [${r.bloque}${r.variante ? ` · ${r.variante}` : ''}] ${r.titulo} — ${r.desenlace}${r.grupo ? ` · ${r.grupo}` : ''}`);
        for (const f of r.fallas) log(`   · ${f}`);
        for (const f of r.esperadas) log(`   ⏳ ${f}`);
        for (const f of r.limitaciones) log(`   ⚠️  ${f}`);
    }
}

(async () => {
    if (!ESCUELA || (SOLO_CRUDO && SOLO.length !== SOLO_CRUDO.length)) {
        log('Uso: npm run qa:embudo -- --escuela <uuid|slug> [--solo matriz|guiones|despues|variantes|anuncios|flows|pagos|conversaciones[,…]] [--variante <nombre>[,…]] '
            + '[--paralelo N] [--anios 2009,2012] [--transcripcion archivo.md] [--verbose]');
        log(`Variantes: ${VARIANTES.map((v) => v.nombre).join(', ')}`);
        process.exit(2);
    }
    const inicio = Date.now();
    const escuela = await cargarEscuela(ESCUELA);
    log(`${escuela.nombre}: ${escuela.sedes.length} sedes, ${escuela.preguntas.length} preguntas, `
        + `${escuela.rangos.length} grupos, ${escuela.franjas.size} franjas abiertas, clase ${escuela.precio ? formatoPesos(escuela.precio) : 'sin valor'}`
        + ` · bloques: ${SOLO.join(', ')} · ${PARALELO} a la vez`);
    if (!escuela.franjas.size) log('⚠️  Sin franjas abiertas: todo interesado va a terminar en «no tengo horarios».');

    const porBloque = new Map<Bloque, Resultado[]>();
    const avisosGenerales: string[] = [];
    for (const b of BLOQUES.filter((x) => SOLO.includes(x))) {
        const t0 = Date.now();
        process.stdout.write(`\n${b}${b === 'variantes' ? '\n' : ': '}`);
        let rs: Resultado[] = [];
        if (b === 'matriz') rs = await correrMatriz(escuela);
        if (b === 'guiones') rs = await correrGuiones(escuela);
        if (b === 'despues') rs = await correrDespues(escuela);
        if (b === 'anuncios') rs = await correrAnuncios(escuela);
        if (b === 'flows') rs = await correrFlows(escuela);
        if (b === 'pagos') rs = await correrPagos(escuela);
        if (b === 'conversaciones') rs = await correrConversaciones(escuela);
        if (b === 'variantes') {
            const v = await correrVariantes(escuela);
            rs = v.resultados;
            avisosGenerales.push(...v.avisos);
        }
        porBloque.set(b, rs);
        log(`  → ${resumen(rs)} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }

    const resultados = [...porBloque.values()].flat();
    const malos = resultados.filter((r) => !esBien(r));
    log(`\n══ ${resumen(resultados)} · ${Math.round((Date.now() - inicio) / 1000)} s`);
    for (const [b, rs] of porBloque) log(`   ${b.padEnd(10)} ${resumen(rs)}`);
    const variantes = porBloque.get('variantes') ?? [];
    if (variantes.length) {
        log('   Por variante:');
        for (const v of [...new Set(variantes.map((r) => r.variante!))]) log(`     ${v.padEnd(28)} ${resumen(variantes.filter((r) => r.variante === v))}`);
    }
    const porDesenlace = new Map<string, number>();
    for (const r of resultados) porDesenlace.set(r.desenlace, (porDesenlace.get(r.desenlace) ?? 0) + 1);
    log(`Desenlaces: ${[...porDesenlace].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    const porGrupo = new Map<string, number>();
    for (const r of resultados) if (r.grupo) porGrupo.set(r.grupo, (porGrupo.get(r.grupo) ?? 0) + 1);
    log(`Grupos asignados: ${[...porGrupo].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const a of avisosGenerales) log(`Aviso: ${a}`);
    const avisos = new Map<string, number>();
    for (const r of resultados) for (const a of r.avisos) if (!/ofreció otra sede$/.test(a)) avisos.set(a, (avisos.get(a) ?? 0) + 1);
    for (const [a, n] of avisos) log(`Aviso${n > 1 ? ` (×${n})` : ''}: ${a}`);
    imprimirFallas(resultados);
    const bloqueadas = new Set(resultados.flatMap((r) => r.conv.turnos.flatMap((t) => t.bloqueadas)));
    if (bloqueadas.size) log(`\nEscrituras que bloqueó el cortafuegos (esperado): ${[...bloqueadas].slice(0, 14).join(' · ')}`);

    if (TRANSCRIPCION) {
        const orden = (r: Resultado) => (r.fallas.length ? 0 : r.esperadas.length ? 1 : r.limitaciones.length ? 2 : 3);
        const md = [
            `# Embudo de ${escuela.nombre} — ${new Date().toISOString().slice(0, 16)}`, '',
            `**${resumen(resultados)}**`, '',
            ...[...porBloque].map(([b, rs]) => `- ${b}: ${resumen(rs)}`),
            ...[...new Set(variantes.map((r) => r.variante!))].map((v) => `  - ${v}: ${resumen(variantes.filter((r) => r.variante === v))}`),
            ...avisosGenerales.map((a) => `- Aviso: ${a}`), '',
            ...[...porBloque].flatMap(([b, rs]) => [`## ${b}`, '', ...[...rs].sort((x, y) => orden(x) - orden(y)).map(transcripcion)]),
        ].join('\n\n');
        writeFileSync(TRANSCRIPCION, md);
        log(`\nTranscripción: ${TRANSCRIPCION}`);
    }
    process.exit(malos.length ? 1 : 0);
})().catch((e) => { log(e); process.exit(1); });
