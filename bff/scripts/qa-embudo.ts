/**
 * Batería de escenarios del embudo del interesado contra la configuración REAL
 * de una escuela. No manda un solo mensaje ni escribe en la base.
 *
 * Desde la RAIZ del repo o desde bff/, da igual:
 *
 *   npm run qa:embudo -- --escuela monsters-volley-club
 *   npm run qa:embudo -- --escuela <uuid|slug> --solo guiones
 *   npm run qa:embudo -- --escuela monsters-volley-club --anios 2009,2012 --transcripcion embudo.md
 *
 * CÓMO
 * Cada conversación corre turno a turno por `turnoSimulado`, el mismo camino del
 * número de pruebas: lee la base de verdad (ajustes, grupos, franjas, cuentas),
 * el cortafuegos bloquea toda escritura y nada sale a Meta. Del lado del
 * interesado contesta un «interesado automático»: lee lo que preguntó el bot y
 * responde según su perfil (sede, año, sexo, trayectoria).
 *
 * QUÉ REVISA
 *   · Matriz: cada sede × año de nacimiento × sexo (la trayectoria rota), por
 *     botones, hasta el pago. El grupo tiene que recibir clase de prueba, no ser
 *     de Competencia, aceptar ese año y ese sexo, y ser de la sede elegida (o
 *     haberse ofrecido «otra sede»). Las franjas: de ese grupo, en los días que la
 *     escuela agenda y con la anticipación mínima. Si ningún grupo acepta ese año,
 *     pasar a una persona es lo correcto.
 *   · Guiones: texto libre (varias respuestas en un mensaje, fechas escritas de
 *     otras formas, la sede escrita, pedir una persona, decir que no al
 *     consentimiento…).
 *   · En TODO mensaje: que el bot conteste, sin «gratis» si la clase tiene valor,
 *     sin undefined/null/NaN, sin reglas de cancha sin resolver, títulos dentro
 *     del límite de WhatsApp, sin renglones repetidos y ≤ 4096 caracteres.
 *
 * Lo que NO mide: la redacción del LLM fuera del embudo ni la cola de
 * comprobantes (eso se prueba en el número de pruebas con una foto real).
 * Es determinista mientras no cambien los datos de la escuela: las franjas
 * son las de hoy.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { supabase } from '../src/config/supabase';
import { turnoSimulado, type SesionPrueba } from '../src/services/plataforma-wa-pruebas.service';
import type { SalidaSimulada } from '../src/services/whatsapp-bot.service';
import {
    ajustesWhatsAppDeEscuela, ajustesClasePrueba, embudoActivo,
    type PreguntaProspecto, type BotonSede,
} from '../src/services/whatsapp-ajustes-escuela.service';
import { rangosDeEscuela, type RangoGrupo } from '../src/services/grupos-por-edad.service';
import { BOTON_EMBUDO, ANTICIPACION_MIN_EMBUDO, sinEmojis } from '../src/services/whatsapp-embudo-prospecto';
import { BOTON_PUERTA } from '../src/services/whatsapp-puerta-desconocido';
import { normalizar } from '../src/services/whatsapp-clase-cortesia.service';
import { diaDeLaSemana } from '../src/services/semana-equipo.service';

// ─── Argumentos ──────────────────────────────────────────────────────────────

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(`--${nombre}`);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const ESCUELA = arg('escuela');
const SOLO = arg('solo') as 'matriz' | 'guiones' | null;
const ANIOS = arg('anios')?.split(',').map(Number).filter(Number.isInteger) ?? null;
const TRANSCRIPCION = arg('transcripcion');
const MAX_TURNOS = 16;

// ─── Contexto de la escuela (solo lectura) ───────────────────────────────────

interface Escuela {
    id: string;
    nombre: string;
    sedes: BotonSede[];
    preguntas: PreguntaProspecto[];
    precio: number | null;
    diasSemana: number[] | null;
    rangos: RangoGrupo[];
    franjas: Map<string, { team_id: string | null; slot_date: string; start_time: string }>;
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
        supabase.from('school_trial_slots').select('id, team_id, slot_date, start_time')
            .eq('school_id', id).eq('is_open', true).gte('slot_date', new Date().toISOString().slice(0, 10)).limit(2000),
    ]);
    if (!embudoActivo(aj)) throw new Error('Esta escuela no tiene el embudo del interesado (wa_preguntas_prospecto).');
    return {
        id, nombre: (data as any).name,
        sedes: aj.botonesSede ?? [],
        preguntas: aj.preguntasProspecto ?? [],
        precio: clase?.precio ?? null,
        diasSemana: clase?.diasSemana ?? null,
        rangos,
        franjas: new Map(((slots.data ?? []) as any[]).map((s) => [s.id, s])),
    };
}

// ─── Conversación ────────────────────────────────────────────────────────────

interface Turno { entrada: string; botonId: string | null; salidas: SalidaSimulada[]; bloqueadas: string[]; nota: string | null }

class Conversacion {
    readonly turnos: Turno[] = [];
    private readonly sesion: SesionPrueba;

    constructor(readonly titulo: string, escuela: Escuela, n: number) {
        this.sesion = {
            contact_wa_id: `5730${String(n).padStart(8, '0')}`, school_id: escuela.id, rol: 'prospecto',
            child_id: null, parent_id: null, estado: {},
        };
    }

    async decir(texto: string, botonId: string | null = null): Promise<SalidaSimulada[]> {
        const r = await turnoSimulado(this.sesion, { waMessageId: `qa-${randomUUID()}`, textBody: texto, botonId });
        this.turnos.push({ entrada: texto, botonId, salidas: r.salidas, bloqueadas: r.bloqueadas, nota: r.nota });
        return r.salidas;
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
        return (this.turnos.at(-1)?.salidas ?? []).map((s) => s.texto).join('\n');
    }

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
}

// ─── Revisión de cada mensaje ────────────────────────────────────────────────

const BASURA = /\b(undefined|NaN)\b|\[object |\{\{|\bnull\b/;
const REGLA_SIN_RESOLVER = /\d\s*\.?\s*(er|º|°|do|ro|to)\b[^\n]{0,30}(del mes)?\s*:/i;

function revisarMensaje(s: SalidaSimulada, escuela: Escuela): string[] {
    const fallas: string[] = [];
    const texto = s.texto ?? '';
    if (escuela.precio && /\bgratis\b|\bsin costo\b/i.test(texto)) fallas.push('dice «gratis» y la clase tiene valor');
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

interface Perfil { sede: BotonSede; anio: number; genero: 'f' | 'm'; trayectoria: number; nombre: string }

type Desenlace = 'pago' | 'persona' | 'sin_horarios' | 'club' | 'inicio' | 'atascado';

interface Resultado {
    titulo: string;
    desenlace: Desenlace;
    fallas: string[];
    avisos: string[];
    grupo: string | null;
    conv: Conversacion;
}

const ultimaLinea = (t: string) => t.trim().split('\n').filter(Boolean).at(-1) ?? t;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function preguntaEn(texto: string, preguntas: PreguntaProspecto[]): { p: PreguntaProspecto; detalle: boolean } | null {
    for (const p of preguntas) {
        if (texto.includes(ultimaLinea(p.texto))) return { p, detalle: false };
        if (p.detalle && texto.includes(ultimaLinea(p.detalle.texto))) return { p, detalle: true };
    }
    return null;
}

/** Sigue contestando lo que pregunte el bot hasta un desenlace. */
async function seguir(conv: Conversacion, escuela: Escuela, perfil: Perfil, r: Resultado): Promise<void> {
    for (let i = 0; i < MAX_TURNOS; i++) {
        const texto = conv.ultimoTexto();
        const ops = conv.opciones();
        if (/^\[se abre en el buz[oó]n/m.test(texto) || /te escriben por aqu[ií]/i.test(texto)) {
            r.desenlace = /no tengo horarios/i.test(texto) ? 'sin_horarios' : 'persona';
            return;
        }
        if (/comprobante/i.test(texto) && /\$|valor|paga/i.test(texto)) { r.desenlace = 'pago'; return; }

        let salidas: SalidaSimulada[] | null = null;
        if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE))) {
            salidas = await conv.tocar((o) => o.id === `${BOTON_EMBUDO.SEDE}${perfil.sede.branchId}`);
        } else if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA))) {
            revisarGrupoYFranjas(conv, escuela, perfil, r);
            salidas = await conv.tocar((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA));
        } else if (ops.some((o) => o.id === BOTON_EMBUDO.OPTIN_SI)) {
            salidas = await conv.tocar((o) => o.id === BOTON_EMBUDO.OPTIN_SI);
        } else if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.OTRA_SEDE))) {
            r.avisos.push(`sin grupo en ${sinEmojis(perfil.sede.titulo)}: ofreció otra sede`);
            salidas = await conv.tocar((o) => o.id.startsWith(BOTON_EMBUDO.OTRA_SEDE));
        } else {
            const q = preguntaEn(texto, escuela.preguntas);
            if (!q) { r.desenlace = 'atascado'; r.fallas.push(`no reconozco qué pide el bot: «${ultimaLinea(texto).slice(0, 90)}»`); return; }
            salidas = await contestar(conv, q.p, q.detalle, perfil);
        }
        if (!salidas) { r.desenlace = 'atascado'; r.fallas.push(`no encontré el botón que buscaba entre: ${ops.map((o) => `[${o.title}]`).join(' ')}`); return; }
        if (!salidas.length) { r.desenlace = 'atascado'; r.fallas.push(`el bot no contestó a «${conv.turnos.at(-1)!.entrada}»`); return; }
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
    if (rango.branchId && rango.branchId !== perfil.sede.branchId && !r.avisos.some((a) => a.includes('otra sede'))) {
        r.fallas.push(`${rango.nombre}: es de otra sede y no se ofreció como tal`);
    }
    const limite = Date.now() + ANTICIPACION_MIN_EMBUDO * 60_000;
    for (const o of conv.opciones().filter((x) => x.id.startsWith(BOTON_EMBUDO.FRANJA))) {
        const f = escuela.franjas.get(o.id.slice(BOTON_EMBUDO.FRANJA.length));
        if (!f) { r.fallas.push(`franja «${o.title}» no está abierta en la base`); continue; }
        if (f.team_id !== rango.teamId) r.fallas.push(`franja «${o.title}» es de otro grupo`);
        if (escuela.diasSemana && !escuela.diasSemana.includes(diaDeLaSemana(f.slot_date))) r.fallas.push(`franja «${o.title}» cae en un día sin agenda`);
        const inicio = Date.parse(`${f.slot_date}T${String(f.start_time).slice(0, 5)}:00-05:00`);
        if (inicio < limite) r.fallas.push(`franja «${o.title}» empieza en menos de ${ANTICIPACION_MIN_EMBUDO} min`);
    }
}

/** ¿Algún grupo que recibe clase de prueba acepta este año y sexo? (en la sede, o en cualquiera) */
function hayGrupoPara(escuela: Escuela, perfil: Perfil, soloSede: boolean): boolean {
    return escuela.rangos.some((x) => x.recibeClasePrueba !== false && x.admiteNuevos !== false
        && !/competen/i.test(x.nombre)
        && (x.anioMin != null || x.anioMax != null)
        && (x.anioMin == null || perfil.anio >= x.anioMin) && (x.anioMax == null || perfil.anio <= x.anioMax)
        && (!x.genero || x.genero === 'mixto' || x.genero === perfil.genero)
        && (!soloSede || !x.branchId || x.branchId === perfil.sede.branchId));
}

function nuevoResultado(titulo: string, conv: Conversacion): Resultado {
    return { titulo, desenlace: 'atascado', fallas: [], avisos: [], grupo: null, conv };
}

function cerrar(r: Resultado, escuela: Escuela, perfil: Perfil | null): Resultado {
    for (const t of r.conv.turnos) {
        if (!t.salidas.length && !r.fallas.some((f) => f.includes('no contestó'))) {
            r.fallas.push(`el bot no contestó a «${t.entrada.slice(0, 50)}»${t.nota ? ` (${t.nota})` : ''}`);
        }
        for (const s of t.salidas) for (const f of revisarMensaje(s, escuela)) r.fallas.push(f);
    }
    if (perfil && (r.desenlace === 'persona' || r.desenlace === 'sin_horarios') && hayGrupoPara(escuela, perfil, false)) {
        r.fallas.push(r.desenlace === 'sin_horarios'
            ? 'hay grupo para este perfil pero no tiene franjas abiertas'
            : 'pasó a una persona aunque hay un grupo que recibe este perfil');
    }
    r.fallas = [...new Set(r.fallas)];
    return r;
}

// ─── Matriz ──────────────────────────────────────────────────────────────────

const NOMBRES_F = ['Mariana Gómez Ruiz', 'Valentina Rojas', 'Sara Lucía Pérez', 'Isabella Torres'];
const NOMBRES_M = ['Santiago Pérez Rojas', 'Samuel Díaz', 'Juan José Martínez', 'Tomás Herrera'];

function aniosDeLaMatriz(escuela: Escuela): number[] {
    if (ANIOS?.length) return ANIOS;
    const hoy = new Date().getFullYear();
    const bordes = escuela.rangos.flatMap((x) => [x.anioMin, x.anioMax]).filter((a): a is number => typeof a === 'number');
    const desde = Math.max(hoy - 60, Math.min(...bordes, hoy - 18) - 1);
    const hasta = Math.min(hoy - 3, Math.max(...bordes, hoy - 6) + 1);
    const anios = new Set<number>();
    for (let a = desde; a <= hasta; a++) if (a >= hoy - 25) anios.add(a);
    anios.add(hoy - 30); // un adulto
    return [...anios].sort();
}

async function correrMatriz(escuela: Escuela, n0: number): Promise<Resultado[]> {
    const resultados: Resultado[] = [];
    let n = n0;
    for (const sede of escuela.sedes) {
        for (const anio of aniosDeLaMatriz(escuela)) {
            for (const genero of ['f', 'm'] as const) {
                n++;
                const nombres = genero === 'f' ? NOMBRES_F : NOMBRES_M;
                const perfil: Perfil = { sede, anio, genero, trayectoria: n % 3, nombre: nombres[n % nombres.length] };
                const titulo = `${sinEmojis(sede.titulo)} · ${anio} · ${genero === 'f' ? 'mujer' : 'hombre'}`;
                const conv = new Conversacion(titulo, escuela, n);
                const r = nuevoResultado(titulo, conv);
                await conv.decir('Hola, quiero información para entrenar voleibol');
                await seguir(conv, escuela, perfil, r);
                resultados.push(cerrar(r, escuela, perfil));
                process.stdout.write(r.fallas.length ? 'F' : '.');
            }
        }
    }
    process.stdout.write('\n');
    return resultados;
}

// ─── Guiones (texto libre) ───────────────────────────────────────────────────

interface Guion {
    titulo: string;
    correr: (c: Conversacion, e: Escuela, r: Resultado) => Promise<Perfil | null>;
}

const debe = (r: Resultado, ok: boolean, falla: string) => { if (!ok) r.fallas.push(falla); };
const preguntoClave = (texto: string, e: Escuela, clave: string) => {
    const p = e.preguntas.find((x) => x.clave === clave);
    return !!p && texto.includes(ultimaLinea(p.texto));
};
const claveDe = (e: Escuela, tipo: PreguntaProspecto['tipo']) => e.preguntas.find((p) => p.tipo === tipo)?.clave ?? '';

function perfilDe(e: Escuela, o: Partial<Perfil> = {}): Perfil {
    return { sede: e.sedes.at(-1)!, anio: new Date().getFullYear() - 14, genero: 'f', trayectoria: 1, nombre: 'Mariana Gómez Ruiz', ...o };
}

async function hastaPregunta(c: Conversacion, e: Escuela, sede: BotonSede): Promise<void> {
    await c.decir('Hola');
    await c.tocar((o) => o.id === `${BOTON_EMBUDO.SEDE}${sede.branchId}`);
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
            const perfil = perfilDe(e, { anio: new Date().getFullYear() - 17, genero: 'm', nombre: 'Santiago Pérez Rojas' });
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
    ...['14 de marzo de 2012', '2012-03-14', '14-03-2012', 'marzo 14 del 2012'].map((fecha): Guion => ({
        titulo: `fecha escrita «${fecha}»`,
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { anio: 2012 });
            await hastaPregunta(c, e, perfil.sede);
            await c.decir(perfil.nombre);
            await c.decir(fecha);
            debe(r, !preguntoClave(c.ultimoTexto(), e, claveDe(e, 'fecha')), `no entendió la fecha «${fecha}»`);
            return perfil;
        },
    })),
    {
        titulo: 'escribe la sede en vez de tocar el botón',
        correr: async (c, e, r) => {
            const sede = e.sedes.at(-1)!;
            await c.decir('Hola');
            const palabra = normalizar(sinEmojis(sede.titulo)).split(' ').at(-1)!;
            await c.decir(palabra);
            debe(r, preguntoClave(c.ultimoTexto(), e, e.preguntas[0].clave), `no tomó «${palabra}» como la sede`);
            return perfilDe(e, { sede });
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
            await hastaPregunta(c, e, e.sedes[0]);
            await c.decir('Mariana Gómez');
            await c.decir('prefiero hablar con una persona por favor');
            debe(r, /buz[oó]n|persona|te escrib/i.test(c.ultimoTexto()), 'no pasó a una persona cuando la pidieron');
            r.desenlace = 'persona';
            return null;
        },
    },
    {
        titulo: 'fecha que no se entiende dos veces → persona',
        correr: async (c, e, r) => {
            await hastaPregunta(c, e, e.sedes[0]);
            await c.decir('Mariana Gómez');
            await c.decir('no me acuerdo');
            await c.decir('ni idea la verdad');
            debe(r, /buz[oó]n|persona|te escrib/i.test(c.ultimoTexto()), 'tras dos respuestas sin fecha no pasó a una persona');
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
        titulo: 'dice que no al consentimiento: igual recibe cómo pagar',
        correr: async (c, e, r) => {
            const perfil = perfilDe(e, { sede: e.sedes[0], anio: new Date().getFullYear() - 13 });
            await c.decir('Hola');
            const tmp = nuevoResultado('', c);
            await seguirHasta(c, e, perfil, tmp, (o) => o.id === BOTON_EMBUDO.OPTIN_SI);
            const no = await c.tocar((o) => o.id === BOTON_EMBUDO.OPTIN_NO);
            if (!no) { r.fallas.push('nunca llegó al consentimiento'); return null; }
            debe(r, /comprobante/i.test(c.ultimoTexto()), 'tras «No, gracias» no le dijo cómo pagar');
            r.desenlace = 'pago';
            return null;
        },
    },
];

/** Como `seguir`, pero se detiene cuando aparece la opción buscada (sin tocarla). */
async function seguirHasta(c: Conversacion, e: Escuela, perfil: Perfil, r: Resultado, parar: (o: { id: string }) => boolean): Promise<void> {
    for (let i = 0; i < MAX_TURNOS; i++) {
        if (c.opciones().some(parar)) return;
        const antes = c.turnos.length;
        const ops = c.opciones();
        if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.SEDE))) await c.tocar((o) => o.id === `${BOTON_EMBUDO.SEDE}${perfil.sede.branchId}`);
        else if (ops.some((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA))) await c.tocar((o) => o.id.startsWith(BOTON_EMBUDO.FRANJA));
        else {
            const q = preguntaEn(c.ultimoTexto(), e.preguntas);
            if (!q) return;
            await contestar(c, q.p, q.detalle, perfil);
        }
        if (c.turnos.length === antes) return;
    }
}

async function correrGuiones(escuela: Escuela, n0: number): Promise<Resultado[]> {
    const resultados: Resultado[] = [];
    let n = n0;
    for (const g of GUIONES) {
        const conv = new Conversacion(g.titulo, escuela, ++n);
        const r = nuevoResultado(g.titulo, conv);
        const perfil = await g.correr(conv, escuela, r);
        // Lo que el guion dejó a medias lo termina el interesado automático.
        if (perfil && !r.fallas.length) await seguir(conv, escuela, perfil, r);
        resultados.push(cerrar(r, escuela, perfil));
        process.stdout.write(r.fallas.length ? 'F' : '.');
    }
    process.stdout.write('\n');
    return resultados;
}

// ─── Reporte ─────────────────────────────────────────────────────────────────

function transcripcion(r: Resultado): string {
    const lineas = [`### ${r.fallas.length ? '❌' : '✅'} ${r.titulo} — ${r.desenlace}${r.grupo ? ` · ${r.grupo}` : ''}`];
    for (const f of r.fallas) lineas.push(`- **Falla:** ${f}`);
    for (const a of r.avisos) lineas.push(`- Aviso: ${a}`);
    lineas.push('');
    for (const t of r.conv.turnos) {
        lineas.push(`> 👤 ${t.entrada}`);
        for (const s of t.salidas) {
            lineas.push(`> 🤖 ${s.texto.replace(/\n/g, '\n> ')}`);
            if (s.opciones?.length) lineas.push(`> ${s.opciones.map((o) => `[${o.title}${o.descripcion ? ` · ${o.descripcion}` : ''}]`).join(' ')}`);
        }
        lineas.push('>');
    }
    return lineas.join('\n');
}

(async () => {
    if (!ESCUELA) {
        console.error('Uso: npm run qa:embudo -- --escuela <uuid|slug> [--solo matriz|guiones] [--anios 2009,2012] [--transcripcion archivo.md]');
        process.exit(2);
    }
    const escuela = await cargarEscuela(ESCUELA);
    console.log(`${escuela.nombre}: ${escuela.sedes.length} sedes, ${escuela.preguntas.length} preguntas, ` +
        `${escuela.rangos.length} grupos, ${escuela.franjas.size} franjas abiertas, clase ${escuela.precio ? `$${escuela.precio}` : 'sin valor'}`);
    if (!escuela.franjas.size) console.log('⚠️  Sin franjas abiertas: todo interesado va a terminar en «no tengo horarios».');

    const resultados: Resultado[] = [];
    if (SOLO !== 'guiones') resultados.push(...await correrMatriz(escuela, 0));
    if (SOLO !== 'matriz') resultados.push(...await correrGuiones(escuela, 5000));

    const malos = resultados.filter((r) => r.fallas.length);
    const porDesenlace = new Map<string, number>();
    for (const r of resultados) porDesenlace.set(r.desenlace, (porDesenlace.get(r.desenlace) ?? 0) + 1);
    const porGrupo = new Map<string, number>();
    for (const r of resultados) if (r.grupo) porGrupo.set(r.grupo, (porGrupo.get(r.grupo) ?? 0) + 1);

    console.log(`\n${resultados.length} conversaciones · ${resultados.length - malos.length} bien · ${malos.length} con fallas`);
    console.log(`Desenlaces: ${[...porDesenlace].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`Grupos asignados: ${[...porGrupo].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const r of malos) {
        console.log(`\n❌ ${r.titulo} — ${r.desenlace}${r.grupo ? ` · ${r.grupo}` : ''}`);
        for (const f of r.fallas) console.log(`   · ${f}`);
    }
    const bloqueadas = new Set(resultados.flatMap((r) => r.conv.turnos.flatMap((t) => t.bloqueadas)));
    if (bloqueadas.size) console.log(`\nEscrituras que bloqueó el cortafuegos (esperado): ${[...bloqueadas].slice(0, 12).join(' · ')}`);

    if (TRANSCRIPCION) {
        const md = [`# Embudo de ${escuela.nombre} — ${new Date().toISOString().slice(0, 16)}`, '',
            ...resultados.sort((a, b) => b.fallas.length - a.fallas.length).map(transcripcion)].join('\n\n');
        writeFileSync(TRANSCRIPCION, md);
        console.log(`\nTranscripción: ${TRANSCRIPCION}`);
    }
    process.exit(malos.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
