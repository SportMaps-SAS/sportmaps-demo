/**
 * whatsapp-flows.service — formularios dentro de WhatsApp (WhatsApp Flows), fase F-a.
 *
 * Plan: docs/specs/whatsapp-plan-v2-anuncios-campanas-formularios.md §3 (lo que
 * confirmó la documentación de Meta) y docs/specs/whatsapp-flows-formularios.md.
 * Esto es la INFRAESTRUCTURA, sin endpoint (todo lo que depende de la escuela
 * se inyecta al enviar y se revalida al recibir):
 *
 *   · Flow JSON en el repo (`bff/whatsapp-flows/<nombre>.json`, versión 7.3) y
 *     su validación contra los límites de la doc (`validarFlowJson`,
 *     `validarDatosDeEntrada`): largos, strings vacíos, un Footer por pantalla,
 *     `sensitive`, referencias, rutas, máx. 5 OptIn, nada de documento de
 *     identidad (la Policy lo prohíbe).
 *   · `flow_token` firmado (HMAC-SHA256 con WHATSAPP_FLOW_TOKEN_SECRET): escuela,
 *     conversación, contacto, formulario, servicio, precios mostrados y
 *     vencimiento (72 h, lo que recomienda la doc). La respuesta (nfm_reply) no
 *     trae el flow_id: el token es lo que dice de dónde viene.
 *   · El mensaje interactivo `type: flow` (`payloadDeFormulario`), con
 *     `flow_message_version` "3", `flow_cta` ≤ 30 sin emoji, modo draft|published
 *     y `flow_action_payload` { screen, data } con los datos de la escuela.
 *   · `respuestaDeFormulario`: el `interactive.nfm_reply.response_json` (string).
 *   · Flows API para los scripts (crear, subir el JSON, publicar, detalle con
 *     `health_status` contra el número) y `formularioDisponible`: el bot solo
 *     manda un formulario PUBLICADO, prendido por la escuela (`activo`) y sano
 *     (health AVAILABLE/LIMITED; sin dato → no).
 *
 * Nada lanza hacia el bot: cualquier falla deja a la escuela en el chat por pasos.
 */

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { supabase } from '../config/supabase';
import { enCortafuegos } from '../config/cortafuegos-simulacion';
import { decryptToken, sendRawPayload, type SendTextResult, type WhatsAppIntegration } from './whatsapp.service';
import { claveDeContacto } from './whatsapp-usuario-meta';

// ─── Constantes de Meta ──────────────────────────────────────────────────────

export const FLOW_JSON_VERSION = '7.3';
export const FLOW_MESSAGE_VERSION = '3';
export const GRAPH_FLOWS = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`;
/** Texto del botón: «30 caracteres o menos (sin emoji)». */
export const MAX_CTA_FORMULARIO = 30;
export const MAX_CUERPO_FORMULARIO = 1024;
export const MAX_ENCABEZADO_FORMULARIO = 60;
export const MAX_PIE_FORMULARIO = 60;
/** «Message Undeliverable»: entre otras, la app de la persona no abre formularios. */
export const ERROR_NO_SOPORTA_FORMULARIO = 131026;

export type EstadoFlow = 'DRAFT' | 'PUBLISHED' | 'DEPRECATED' | 'THROTTLED' | 'BLOCKED';
export const ESTADOS_FLOW: readonly EstadoFlow[] = ['DRAFT', 'PUBLISHED', 'DEPRECATED', 'THROTTLED', 'BLOCKED'];
export type PuedeEnviar = 'AVAILABLE' | 'LIMITED' | 'BLOCKED';

export const esEstadoFlow = (v: unknown): v is EstadoFlow => (ESTADOS_FLOW as readonly unknown[]).includes(v);

// ─── El JSON del repo ────────────────────────────────────────────────────────

/** `bff/whatsapp-flows` (igual desde src/ que desde dist/). */
export const DIR_FLOWS = path.join(__dirname, '..', '..', 'whatsapp-flows');

export interface FlowDelRepo {
    nombre: string;
    texto: string;
    json: Record<string, any>;
    /** sha256 corto del archivo: la «versión del repo» que se guarda en whatsapp_flows. */
    versionRepo: string;
}

/** Lee `bff/whatsapp-flows/<nombre>.json`. Lanza si no existe o no es JSON (solo scripts y pruebas). */
export function leerFlowDelRepo(nombre: string, dir = DIR_FLOWS): FlowDelRepo {
    if (!/^[a-z0-9_]{1,60}$/.test(nombre)) throw new Error(`Nombre de formulario inválido: «${nombre}»`);
    const texto = fs.readFileSync(path.join(dir, `${nombre}.json`), 'utf8');
    return {
        nombre, texto, json: JSON.parse(texto),
        versionRepo: crypto.createHash('sha256').update(texto).digest('hex').slice(0, 12),
    };
}

// ─── Validación del Flow JSON (pura) ─────────────────────────────────────────

export interface ProblemaFlow { ruta: string; problema: string }

/** Límites de la doc de componentes (2026-11-04), por `Tipo.propiedad`. */
export const LIMITES_TEXTO: Readonly<Record<string, number>> = Object.freeze({
    'TextHeading.text': 80,
    'TextSubheading.text': 80,
    'TextBody.text': 4096,
    'TextCaption.text': 409,
    'Footer.label': 35,
    'Footer.left-caption': 15,
    'Footer.right-caption': 15,
    'Footer.center-caption': 15,
    'TextInput.label': 20,
    'TextInput.helper-text': 80,
    'TextInput.error-message': 30,
    'TextArea.label': 20,
    'TextArea.helper-text': 80,
    'RadioButtonsGroup.label': 30,
    'CheckboxGroup.label': 30,
    'Dropdown.label': 20,
    'DatePicker.label': 40,
    'DatePicker.helper-text': 80,
    'DatePicker.error-message': 80,
    'OptIn.label': 120,
    'EmbeddedLink.text': 25,
});
const LIMITES_OPCION: Readonly<Record<string, number>> = Object.freeze({ title: 30, description: 300, metadata: 20 });
const MAX_OPCIONES: Readonly<Record<string, number>> = Object.freeze({ RadioButtonsGroup: 20, CheckboxGroup: 20, Dropdown: 200 });
const COMPONENTES_DE_FORMULARIO = new Set([
    'TextInput', 'TextArea', 'CheckboxGroup', 'RadioButtonsGroup', 'Dropdown', 'DatePicker', 'CalendarPicker',
    'OptIn', 'PhotoPicker', 'DocumentPicker', 'ChipsSelector',
]);
const MAX_COMPONENTES_POR_PANTALLA = 50;
const MAX_OPTIN_POR_PANTALLA = 5;
const MAX_LINKS_POR_PANTALLA = 2;
/** La Policy de WhatsApp prohíbe pedir números completos de documentos de identidad. */
const PIDE_DOCUMENTO = /c[eé]dula|documento|tarjeta de identidad|pasaporte|\bnit\b|\bdni\b|\bnuip\b|\bt\.?\s?i\.?\b/i;
const REF = /\$\{(data|form|screen\.([A-Za-z_]+)\.(data|form))\.([A-Za-z0-9_]+)\}/g;

/** Las referencias `${…}` de un texto. Pura. */
export function referenciasDe(texto: string): { pantalla: string | null; tipo: 'data' | 'form'; clave: string }[] {
    const out: { pantalla: string | null; tipo: 'data' | 'form'; clave: string }[] = [];
    for (const m of texto.matchAll(REF)) {
        if (m[1] === 'data' || m[1] === 'form') out.push({ pantalla: null, tipo: m[1], clave: m[4] });
        else out.push({ pantalla: m[2], tipo: m[3] as 'data' | 'form', clave: m[4] });
    }
    return out;
}

const esDinamico = (s: string) => s.includes('${') || /^`.*`$/s.test(s);

/** Los componentes de una lista, con los de If/Switch adentro (y en qué rama). */
function aplanar(hijos: unknown, ruta: string): { c: Record<string, any>; ruta: string; rama: string | null }[] {
    const out: { c: Record<string, any>; ruta: string; rama: string | null }[] = [];
    const recorrer = (lista: unknown, r: string, rama: string | null) => {
        if (!Array.isArray(lista)) return;
        lista.forEach((c, i) => {
            if (!c || typeof c !== 'object') return;
            const rc = `${r}[${i}]`;
            out.push({ c: c as Record<string, any>, ruta: rc, rama });
            if ((c as any).type === 'If') {
                recorrer((c as any).then, `${rc}.then`, `${rc}.then`);
                recorrer((c as any).else, `${rc}.else`, `${rc}.else`);
            }
            if ((c as any).type === 'Switch' && (c as any).cases && typeof (c as any).cases === 'object') {
                for (const [k, v] of Object.entries((c as any).cases)) recorrer(v, `${rc}.cases.${k}`, `${rc}.cases.${k}`);
            }
        });
    };
    recorrer(hijos, ruta, null);
    return out;
}

/** Recorre todos los strings de un valor (objeto, arreglo) con su ruta. */
function cadaString(v: unknown, ruta: string, fn: (s: string, ruta: string) => void): void {
    if (typeof v === 'string') fn(v, ruta);
    else if (Array.isArray(v)) v.forEach((x, i) => cadaString(x, `${ruta}[${i}]`, fn));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) cadaString(x, `${ruta}.${k}`, fn);
}

/**
 * Valida un Flow JSON SIN endpoint contra las reglas de la doc de Meta que se
 * pueden revisar sin subirlo. [] = sin problemas. Meta valida lo demás al subir
 * el borrador (`validation_errors`). Pura.
 */
export function validarFlowJson(flow: unknown): ProblemaFlow[] {
    const p: ProblemaFlow[] = [];
    const mal = (ruta: string, problema: string) => p.push({ ruta, problema });
    if (!flow || typeof flow !== 'object') return [{ ruta: '$', problema: 'no es un objeto' }];
    const f = flow as Record<string, any>;
    if (f.version !== FLOW_JSON_VERSION) mal('version', `se usa ${FLOW_JSON_VERSION} (llegó ${String(f.version)})`);
    if ('data_api_version' in f || 'routing_model' in f || 'data_channel_uri' in f) {
        mal('$', 'formulario sin endpoint: sin data_api_version, routing_model ni data_channel_uri');
    }
    const pantallas: Record<string, any>[] = Array.isArray(f.screens) ? f.screens : [];
    if (!pantallas.length) return [...p, { ruta: 'screens', problema: 'sin pantallas' }];

    const ids = pantallas.map((s) => String(s?.id ?? ''));
    const porId = new Map(pantallas.map((s) => [String(s?.id ?? ''), s]));
    ids.forEach((id, i) => {
        if (!/^[A-Z][A-Z_]*$/.test(id)) mal(`screens[${i}].id`, `id inválido «${id}» (mayúsculas y _)`);
        if (id === 'SUCCESS') mal(`screens[${i}].id`, 'SUCCESS está reservado');
        if (ids.indexOf(id) !== i) mal(`screens[${i}].id`, `id repetido «${id}»`);
    });

    // Lo que declara cada pantalla (data) y los campos de formulario que tiene.
    const nombresDe = new Map<string, Set<string>>();
    for (const s of pantallas) {
        const nombres = new Set<string>();
        for (const { c } of aplanar(s?.layout?.children, '')) if (COMPONENTES_DE_FORMULARIO.has(c.type) && typeof c.name === 'string') nombres.add(c.name);
        nombresDe.set(String(s?.id), nombres);
    }

    const destinos = new Map<string, string[]>();
    let terminales = 0;
    pantallas.forEach((s, i) => {
        const rs = `screens[${i}](${s?.id})`;
        if (s?.layout?.type !== 'SingleColumnLayout') mal(`${rs}.layout.type`, 'tiene que ser SingleColumnLayout');
        if (typeof s?.title === 'string' && !s.title.trim()) mal(`${rs}.title`, 'título vacío');
        const data = s?.data && typeof s.data === 'object' ? s.data as Record<string, any> : {};
        for (const [k, d] of Object.entries(data)) {
            if (!d || typeof d !== 'object' || !d.type) mal(`${rs}.data.${k}`, 'sin type');
            else if (!('__example__' in d)) mal(`${rs}.data.${k}`, 'sin __example__ (obligatorio)');
        }

        const comps = aplanar(s?.layout?.children, `${rs}.children`);
        if (comps.length > MAX_COMPONENTES_POR_PANTALLA) mal(rs, `${comps.length} componentes (máx. ${MAX_COMPONENTES_POR_PANTALLA})`);
        if (comps.filter(({ c }) => c.type === 'OptIn').length > MAX_OPTIN_POR_PANTALLA) mal(rs, `más de ${MAX_OPTIN_POR_PANTALLA} OptIn`);
        if (comps.filter(({ c }) => c.type === 'EmbeddedLink').length > MAX_LINKS_POR_PANTALLA) mal(rs, `más de ${MAX_LINKS_POR_PANTALLA} EmbeddedLink`);

        // Un Footer por pantalla (contando las ramas de un If como uno, si están en ambas).
        const footers = comps.filter(({ c }) => c.type === 'Footer');
        const fuera = footers.filter((x) => x.rama === null).length;
        const ifs = comps.filter(({ c }) => c.type === 'If');
        let enIfs = 0;
        for (const x of ifs) {
            const enThen = footers.some((ft) => ft.rama === `${x.ruta}.then`);
            const enElse = footers.some((ft) => ft.rama === `${x.ruta}.else`);
            if (enThen !== enElse) mal(x.ruta, 'el Footer tiene que estar en las dos ramas del If');
            if (enThen || enElse) enIfs++;
            if (!Array.isArray(x.c.then) || !x.c.then.length) mal(`${x.ruta}.then`, 'rama then vacía');
            if (typeof x.c.condition !== 'string' || !referenciasDe(x.c.condition).length) mal(`${x.ruta}.condition`, 'la condición necesita un valor dinámico');
        }
        if (fuera + enIfs !== 1) mal(rs, `tiene que tener exactamente un Footer (tiene ${fuera + enIfs})`);
        if (s?.terminal === true) terminales++;

        // Nombres de campos únicos (también entre ramas de If).
        const vistos = new Set<string>();
        for (const { c, ruta } of comps) {
            if (!COMPONENTES_DE_FORMULARIO.has(c.type)) continue;
            if (typeof c.name !== 'string' || !c.name.trim()) { mal(ruta, `${c.type} sin name`); continue; }
            if (vistos.has(c.name)) mal(ruta, `name repetido «${c.name}»`);
            vistos.add(c.name);
            const texto = `${c.name} ${typeof c.label === 'string' ? c.label : ''}`;
            if (PIDE_DOCUMENTO.test(texto)) mal(ruta, `pide un documento de identidad («${texto.trim()}»): la Policy de WhatsApp lo prohíbe`);
            if (c.type === 'TextInput' && (c['input-type'] === 'password' || c['input-type'] === 'passcode')) mal(ruta, 'no se piden contraseñas');
        }
        if (s?.sensitive !== undefined) {
            if (!Array.isArray(s.sensitive)) mal(`${rs}.sensitive`, 'tiene que ser un arreglo');
            else for (const n of s.sensitive) if (!vistos.has(String(n))) mal(`${rs}.sensitive`, `«${n}» no es un campo de esta pantalla`);
        }

        for (const { c, ruta } of comps) {
            // Largos y vacíos de lo estático.
            for (const [prop, max] of Object.entries(LIMITES_TEXTO)) {
                const [tipo, campo] = prop.split('.');
                if (c.type !== tipo || !(campo in c)) continue;
                const v = c[campo];
                if (typeof v !== 'string') continue;
                if (!v.trim()) mal(`${ruta}.${campo}`, 'texto vacío');
                else if (!esDinamico(v) && Array.from(v).length > max) mal(`${ruta}.${campo}`, `${Array.from(v).length} caracteres (máx. ${max})`);
            }
            if (Array.isArray(c['data-source'])) {
                const ops = c['data-source'] as any[];
                const max = MAX_OPCIONES[c.type] ?? 20;
                if (!ops.length || ops.length > max) mal(`${ruta}.data-source`, `${ops.length} opciones (1–${max})`);
                const idsOp = ops.map((o) => String(o?.id ?? ''));
                ops.forEach((o, k) => {
                    if (!idsOp[k].trim()) mal(`${ruta}.data-source[${k}].id`, 'id vacío');
                    if (idsOp.indexOf(idsOp[k]) !== k) mal(`${ruta}.data-source[${k}].id`, `id repetido «${idsOp[k]}»`);
                    for (const [campo, maxC] of Object.entries(LIMITES_OPCION)) {
                        const v = o?.[campo];
                        if (typeof v === 'string' && (!v.trim() || Array.from(v).length > maxC)) {
                            mal(`${ruta}.data-source[${k}].${campo}`, !v.trim() ? 'vacío' : `${Array.from(v).length} caracteres (máx. ${maxC})`);
                        }
                    }
                    if (typeof o?.title !== 'string' || !o.title.trim()) mal(`${ruta}.data-source[${k}].title`, 'sin título');
                });
            }
            // Acciones: sin endpoint no hay data_exchange; navigate a una pantalla que exista.
            const accion = c['on-click-action'];
            if (accion && typeof accion === 'object') {
                if (accion.name === 'data_exchange') mal(`${ruta}.on-click-action`, 'data_exchange necesita endpoint');
                if (accion.name === 'navigate') {
                    const destino = String(accion?.next?.name ?? '');
                    if (!porId.has(destino)) mal(`${ruta}.on-click-action.next`, `pantalla «${destino}» no existe`);
                    else destinos.set(String(s.id), [...(destinos.get(String(s.id)) ?? []), destino]);
                    if (s?.terminal === true && c.type === 'Footer') mal(`${ruta}.on-click-action`, 'el Footer de una pantalla terminal no navega: completa');
                }
                if (accion.name === 'complete') {
                    if (s?.terminal !== true) mal(`${ruta}.on-click-action`, 'complete solo en una pantalla terminal');
                    if (!accion.payload || typeof accion.payload !== 'object' || !Object.keys(accion.payload).length) {
                        mal(`${ruta}.on-click-action.payload`, 'complete sin payload: la respuesta llegaría vacía');
                    }
                }
                if (accion.name === 'open_url' && !/^https:\/\/\S+$/.test(String(accion.url ?? ''))) mal(`${ruta}.on-click-action.url`, 'open_url necesita una URL https');
            }
            if (c.type === 'Footer' && s?.terminal === true && accion?.name !== 'complete') mal(`${ruta}`, 'la pantalla terminal termina con complete');
        }

        // Referencias: a datos declarados y a campos que existen.
        cadaString(s?.layout, `${rs}.layout`, (texto, ruta) => {
            for (const r of referenciasDe(texto)) {
                const pid = r.pantalla ?? String(s.id);
                const destino = porId.get(pid);
                if (!destino) { mal(ruta, `referencia a la pantalla «${pid}», que no existe`); continue; }
                if (r.tipo === 'data') {
                    const d = destino.data && typeof destino.data === 'object' ? destino.data : {};
                    if (!(r.clave in d)) mal(ruta, `\${${r.pantalla ? `screen.${pid}.` : ''}data.${r.clave}} no está declarado en ${pid}.data`);
                } else if (!nombresDe.get(pid)?.has(r.clave)) {
                    mal(ruta, `\${${r.pantalla ? `screen.${pid}.` : ''}form.${r.clave}} no es un campo de ${pid}`);
                }
            }
        });
    });
    if (!terminales) mal('screens', 'ninguna pantalla terminal');

    // Rutas: una sola pantalla de entrada y todas alcanzables desde ella.
    const conEntrada = new Set([...destinos.values()].flat());
    const entradas = ids.filter((id) => !conEntrada.has(id));
    if (entradas.length !== 1) mal('screens', `tiene que haber una sola pantalla de entrada (hay ${entradas.length}: ${entradas.join(', ')})`);
    else {
        const alcanzadas = new Set<string>([entradas[0]]);
        const cola = [entradas[0]];
        while (cola.length) for (const d of destinos.get(cola.shift()!) ?? []) if (!alcanzadas.has(d)) { alcanzadas.add(d); cola.push(d); }
        for (const id of ids) if (!alcanzadas.has(id)) mal('screens', `la pantalla «${id}» no se alcanza desde ${entradas[0]}`);
    }
    return p;
}

/** La pantalla de entrada (la que ningún navigate tiene de destino). Pura. */
export function pantallaDeEntrada(flow: Record<string, any>): string | null {
    const pantallas: any[] = Array.isArray(flow?.screens) ? flow.screens : [];
    const destinos = new Set<string>();
    for (const s of pantallas) for (const { c } of aplanar(s?.layout?.children, '')) {
        const a = c['on-click-action'];
        if (a?.name === 'navigate' && a?.next?.name) destinos.add(String(a.next.name));
    }
    const entradas = pantallas.map((s) => String(s?.id)).filter((id) => !destinos.has(id));
    return entradas.length === 1 ? entradas[0] : null;
}

const tipoJson = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' ? 'number' : typeof v);

/**
 * Valida los datos que se inyectan en `flow_action_payload.data` para la
 * pantalla `pantalla`: que estén todas las claves declaradas, con su tipo, sin
 * null (Flows no lo admite), y que cada texto quepa donde se usa (en esa
 * pantalla o en otra con `${screen.<pantalla>.data.x}`). [] = bien. Pura.
 */
export function validarDatosDeEntrada(flow: Record<string, any>, pantalla: string, datos: Record<string, unknown>): ProblemaFlow[] {
    const p: ProblemaFlow[] = [];
    const pantallas: any[] = Array.isArray(flow?.screens) ? flow.screens : [];
    const s = pantallas.find((x) => x?.id === pantalla);
    if (!s) return [{ ruta: pantalla, problema: 'la pantalla no existe' }];
    if (!datos || typeof datos !== 'object' || !Object.keys(datos).length) return [{ ruta: 'data', problema: 'vacío (Meta exige un objeto no vacío)' }];
    const decl: Record<string, any> = s.data ?? {};
    for (const [k, d] of Object.entries(decl)) {
        if (!(k in datos)) { p.push({ ruta: `data.${k}`, problema: 'falta' }); continue; }
        const v = datos[k];
        const tipo = d?.type === 'integer' ? 'number' : d?.type;
        if (v === null || v === undefined) p.push({ ruta: `data.${k}`, problema: 'null/undefined no se admite' });
        else if (tipo && tipoJson(v) !== tipo) p.push({ ruta: `data.${k}`, problema: `tipo ${tipoJson(v)} (se declaró ${tipo})` });
        if (Array.isArray(v)) {
            if (!v.length) p.push({ ruta: `data.${k}`, problema: 'arreglo vacío (una lista necesita al menos una opción)' });
            v.forEach((o: any, i) => {
                if (typeof o?.id !== 'string' || !o.id.trim()) p.push({ ruta: `data.${k}[${i}].id`, problema: 'vacío' });
                if (typeof o?.title !== 'string' || !o.title.trim()) p.push({ ruta: `data.${k}[${i}].title`, problema: 'vacío' });
                else if (Array.from(o.title).length > LIMITES_OPCION.title) p.push({ ruta: `data.${k}[${i}].title`, problema: `${Array.from(o.title as string).length} caracteres (máx. ${LIMITES_OPCION.title})` });
            });
        }
    }
    for (const k of Object.keys(datos)) if (!(k in decl)) p.push({ ruta: `data.${k}`, problema: 'no está declarado en la pantalla' });

    // Dónde se usa cada dato: el límite del componente que lo muestra.
    for (const otra of pantallas) {
        for (const { c, ruta } of aplanar(otra?.layout?.children, `${otra?.id}`)) {
            for (const [prop, max] of Object.entries(LIMITES_TEXTO)) {
                const [tipo, campo] = prop.split('.');
                if (c.type !== tipo || typeof c[campo] !== 'string') continue;
                for (const r of referenciasDe(c[campo])) {
                    const pid = r.pantalla ?? String(otra.id);
                    if (pid !== pantalla || r.tipo !== 'data' || !(r.clave in datos)) continue;
                    const v = datos[r.clave];
                    if (typeof v !== 'string') continue;
                    if (!v.trim()) p.push({ ruta: `data.${r.clave}`, problema: `vacío y se muestra en ${ruta}.${campo}` });
                    else if (Array.from(v).length > max) p.push({ ruta: `data.${r.clave}`, problema: `${Array.from(v).length} caracteres en ${ruta}.${campo} (máx. ${max})` });
                }
            }
        }
    }
    return p;
}

// ─── flow_token firmado ──────────────────────────────────────────────────────

/** Variable de entorno del secreto con que el BFF firma los tokens (≥ 16 caracteres). */
export const ENV_SECRETO_TOKEN = 'WHATSAPP_FLOW_TOKEN_SECRET';
/** La doc recomienda 2–3 días para que la persona alcance a abrirlo. */
export const HORAS_VIGENCIA_TOKEN = 72;

export interface PreciosMostrados {
    /** El valor de lista de hoy (sin afiliado). */
    lista: number | null;
    /** El de afiliado (null si el servicio no lo tiene). */
    afiliado: number | null;
    /** % del abono mínimo (null = sin abono). */
    abonoPct: number | null;
}

export interface TokenFormulario {
    /** Id del envío (nonce): queda en la respuesta para auditar. */
    id: string;
    schoolId: string;
    conversationId: string | null;
    contactWaId: string;
    formulario: string;
    servicioId: string | null;
    /** epoch ms. */
    venceEn: number;
    precios: PreciosMostrados | null;
}

export type VerificacionToken =
    | { ok: true; token: TokenFormulario }
    | { ok: false; motivo: 'sin_secreto' | 'formato' | 'firma' | 'vencido'; token?: TokenFormulario };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function secretoDeTokens(secreto?: string | null): string | null {
    const s = secreto ?? process.env[ENV_SECRETO_TOKEN] ?? '';
    return s.length >= 16 ? s : null;
}

function firma(secreto: string, cuerpo: string): string {
    return crypto.createHmac('sha256', secreto).update(`v1.${cuerpo}`).digest('base64url');
}

const numONull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Firma el token del formulario: `v1.<datos base64url>.<HMAC-SHA256 base64url>`.
 * null si no hay secreto configurado (sin secreto no se manda ningún formulario:
 * la respuesta no se podría verificar). Pura salvo el nonce.
 */
export function firmarTokenFormulario(
    t: Omit<TokenFormulario, 'id' | 'venceEn'> & { id?: string; venceEn?: number },
    o: { ahora?: number; secreto?: string | null } = {},
): string | null {
    const secreto = secretoDeTokens(o.secreto);
    if (!secreto || !t.schoolId || !t.contactWaId || !t.formulario) return null;
    const ahora = o.ahora ?? Date.now();
    const compacto = {
        v: 1,
        i: t.id ?? crypto.randomBytes(9).toString('base64url'),
        e: t.schoolId,
        c: t.conversationId,
        t: claveDeContacto(t.contactWaId),
        f: t.formulario,
        s: t.servicioId,
        x: Math.floor((t.venceEn ?? ahora + HORAS_VIGENCIA_TOKEN * 3600_000) / 1000),
        p: t.precios ? [t.precios.lista, t.precios.afiliado, t.precios.abonoPct] : null,
    };
    const cuerpo = b64url(JSON.stringify(compacto));
    return `v1.${cuerpo}.${firma(secreto, cuerpo)}`;
}

/** Verifica firma y vencimiento. Nunca lanza. */
export function verificarTokenFormulario(
    token: string | null | undefined,
    o: { ahora?: number; secreto?: string | null } = {},
): VerificacionToken {
    const secreto = secretoDeTokens(o.secreto);
    if (!secreto) return { ok: false, motivo: 'sin_secreto' };
    const partes = String(token ?? '').split('.');
    if (partes.length !== 3 || partes[0] !== 'v1' || !partes[1] || !partes[2]) return { ok: false, motivo: 'formato' };
    const esperada = Buffer.from(firma(secreto, partes[1]));
    const recibida = Buffer.from(partes[2]);
    if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return { ok: false, motivo: 'firma' };
    let d: any;
    try {
        d = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    } catch {
        return { ok: false, motivo: 'formato' };
    }
    if (!d || d.v !== 1 || typeof d.e !== 'string' || typeof d.t !== 'string' || typeof d.f !== 'string' || !Number.isFinite(d.x)) {
        return { ok: false, motivo: 'formato' };
    }
    const p = Array.isArray(d.p) ? d.p : null;
    const tk: TokenFormulario = {
        id: String(d.i ?? ''),
        schoolId: d.e,
        conversationId: typeof d.c === 'string' ? d.c : null,
        contactWaId: d.t,
        formulario: d.f,
        servicioId: typeof d.s === 'string' ? d.s : null,
        venceEn: Number(d.x) * 1000,
        precios: p ? { lista: numONull(p[0]), afiliado: numONull(p[1]), abonoPct: numONull(p[2]) } : null,
    };
    if (tk.venceEn <= (o.ahora ?? Date.now())) return { ok: false, motivo: 'vencido', token: tk };
    return { ok: true, token: tk };
}

// ─── El mensaje interactivo `flow` ───────────────────────────────────────────

export interface MensajeDeFormulario {
    /** Id de Meta del flow (o `flowName`). */
    flowId?: string | null;
    flowName?: string | null;
    cta: string;
    cuerpo: string;
    encabezado?: string | null;
    pie?: string | null;
    token: string;
    /** Pantalla de entrada. */
    pantalla: string;
    /** Datos de la pantalla de entrada (objeto no vacío). */
    data: Record<string, unknown>;
    /** 'draft' para probar un borrador; 'published' (por defecto) para el publicado. */
    modo?: 'draft' | 'published';
    /**
     * La doc dice en un lugar que `data` es un objeto y en otro un objeto
     * «serializado como string». Por defecto va como objeto; con esto, como texto.
     */
    dataComoTexto?: boolean;
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** ¿Sirve como texto del botón? 1–30 caracteres y sin emoji. Pura. */
export function ctaValido(cta: string | null | undefined): boolean {
    const t = String(cta ?? '').trim();
    return !!t && Array.from(t).length <= MAX_CTA_FORMULARIO && !EMOJI.test(t);
}

/**
 * Payload de Graph para mandar un formulario (`interactive.type = 'flow'`). null
 * si algo no cabe (cuerpo > 1024, botón > 30 o con emoji, data vacía, sin
 * flow ni token): quien llama sigue por chat. Pura.
 */
export function payloadDeFormulario(to: string, m: MensajeDeFormulario): Record<string, unknown> | null {
    const cuerpo = String(m.cuerpo ?? '').trim();
    const encabezado = String(m.encabezado ?? '').trim();
    const pie = String(m.pie ?? '').trim();
    if (!to || !cuerpo || Array.from(cuerpo).length > MAX_CUERPO_FORMULARIO) return null;
    if (encabezado && Array.from(encabezado).length > MAX_ENCABEZADO_FORMULARIO) return null;
    if (pie && Array.from(pie).length > MAX_PIE_FORMULARIO) return null;
    if (!ctaValido(m.cta) || !m.token || !m.pantalla) return null;
    if (!m.flowId === !m.flowName) return null; // uno y solo uno
    if (!m.data || typeof m.data !== 'object' || !Object.keys(m.data).length) return null;
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
            type: 'flow',
            ...(encabezado ? { header: { type: 'text', text: encabezado } } : {}),
            body: { text: cuerpo },
            ...(pie ? { footer: { text: pie } } : {}),
            action: {
                name: 'flow',
                parameters: {
                    flow_message_version: FLOW_MESSAGE_VERSION,
                    ...(m.flowId ? { flow_id: m.flowId } : { flow_name: m.flowName }),
                    flow_cta: String(m.cta).trim(),
                    flow_token: m.token,
                    mode: m.modo ?? 'published',
                    flow_action: 'navigate',
                    flow_action_payload: {
                        screen: m.pantalla,
                        data: m.dataComoTexto ? JSON.stringify(m.data) : m.data,
                    },
                },
            },
        },
    };
}

/** Manda el formulario. Solo dentro de la ventana de 24 h. No lanza. */
export async function sendFlowMessage(
    integration: WhatsAppIntegration, to: string, m: MensajeDeFormulario,
): Promise<SendTextResult> {
    const payload = payloadDeFormulario(to, m);
    if (!payload) return { ok: false, error: 'no_cabe_como_formulario' };
    return sendRawPayload(integration, payload);
}

/** ¿El error dice que la app de la persona no abre el formulario (131026)? Pura. */
export function esClienteSinFormularios(codigo: number | string | null | undefined, detalle?: string | null): boolean {
    return Number(codigo) === ERROR_NO_SOPORTA_FORMULARIO || /131026|undeliverable/i.test(String(detalle ?? ''));
}

// ─── La respuesta (interactive.nfm_reply) ────────────────────────────────────

export interface RespuestaDeFormulario {
    /** El flow_token (lo agrega Meta al response_json). */
    token: string | null;
    /** El response_json ya parseado (sin flow_token). {} si no se pudo leer. */
    datos: Record<string, unknown>;
    /** false = response_json ilegible. */
    legible: boolean;
}

/** ¿El mensaje crudo de Meta es un formulario terminado? Pura. */
export function esRespuestaDeFormulario(raw: unknown): boolean {
    const m = raw as any;
    return m?.type === 'interactive' && m?.interactive?.type === 'nfm_reply';
}

/** El formulario terminado de un mensaje crudo de Meta; null si no es uno. Pura. */
export function respuestaDeFormulario(raw: unknown): RespuestaDeFormulario | null {
    if (!esRespuestaDeFormulario(raw)) return null;
    const crudo = (raw as any).interactive?.nfm_reply?.response_json;
    let datos: Record<string, unknown> = {};
    let legible = false;
    if (typeof crudo === 'string') {
        try {
            const j = JSON.parse(crudo);
            if (j && typeof j === 'object' && !Array.isArray(j)) { datos = j; legible = true; }
        } catch { /* ilegible */ }
    } else if (crudo && typeof crudo === 'object' && !Array.isArray(crudo)) {
        datos = crudo as Record<string, unknown>;
        legible = true;
    }
    const { flow_token: token, ...resto } = datos as Record<string, unknown> & { flow_token?: unknown };
    return { token: typeof token === 'string' && token ? token : null, datos: resto, legible };
}

// ─── Flows API (scripts y salud en vivo) ─────────────────────────────────────

export class ErrorGraph extends Error {
    constructor(message: string, readonly status: number, readonly detalle: unknown) { super(message); }
}

async function graph(token: string, ruta: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(/^https:\/\//.test(ruta) ? ruta : `${GRAPH_FLOWS}/${ruta}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> ?? {}) },
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ErrorGraph(j?.error?.error_user_msg || j?.error?.message || `graph_${res.status}`, res.status, j?.error ?? j);
    return j;
}

export interface FlowEnMeta { id: string; name: string; status: string; categories?: string[]; validation_errors?: unknown[] }

/** Llamadas a la Flows API con el token de la escuela (descifrado por quien llama; nunca se imprime). */
export const metaFlows = {
    async listar(token: string, wabaId: string): Promise<FlowEnMeta[]> {
        const todos: FlowEnMeta[] = [];
        let ruta: string | null = `${wabaId}/flows?fields=id,name,status,categories,validation_errors&limit=100`;
        while (ruta) {
            const j: any = await graph(token, ruta);
            todos.push(...(j.data ?? []));
            // `paging.next` es una URL completa (con su versión de Graph): se usa tal cual.
            ruta = typeof j.paging?.next === 'string' ? j.paging.next : null;
        }
        return todos;
    },
    /** Crea el flow (BORRADOR salvo `publicar`). */
    async crear(token: string, wabaId: string, p: { nombre: string; categorias: string[]; flowJson: string; publicar: boolean }): Promise<{ id: string; validation_errors?: unknown[] }> {
        return graph(token, `${wabaId}/flows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: p.nombre, categories: p.categorias, flow_json: p.flowJson, publish: p.publicar }),
        });
    },
    /** Sube el JSON (si estaba publicado, Meta lo devuelve a borrador). */
    async subirJson(token: string, flowId: string, flowJson: string): Promise<{ success: boolean; validation_errors?: unknown[] }> {
        const form = new FormData();
        form.append('file', new Blob([flowJson], { type: 'application/json' }), 'flow.json');
        form.append('name', 'flow.json');
        form.append('asset_type', 'FLOW_JSON');
        return graph(token, `${flowId}/assets`, { method: 'POST', body: form });
    },
    async publicar(token: string, flowId: string): Promise<{ success: boolean }> {
        return graph(token, `${flowId}/publish`, { method: 'POST' });
    },
    /** Estado, errores, versión, salud contra el número y vista previa. */
    async detalle(token: string, flowId: string, phoneNumberId?: string | null, conPreview = false): Promise<any> {
        const campos = ['id', 'name', 'status', 'categories', 'validation_errors', 'json_version',
            phoneNumberId ? `health_status.phone_number(${phoneNumberId})` : 'health_status',
            ...(conPreview ? ['preview.invalidate(false)'] : [])].join(',');
        return graph(token, `${flowId}?fields=${encodeURIComponent(campos)}`);
    },
    /** `business_verification_status` de la WABA (lo exige publicar y enviar). */
    async verificacionDelNegocio(token: string, wabaId: string): Promise<string | null> {
        const j = await graph(token, `${wabaId}?fields=${encodeURIComponent('name,business_verification_status')}`);
        return typeof j?.business_verification_status === 'string' ? j.business_verification_status : null;
    },
};

export interface SaludDeFlow {
    estado: EstadoFlow | null;
    puedeEnviar: PuedeEnviar | null;
    entidades: { tipo: string; id: string | null; puede: string | null; problemas: string[] }[];
}

/** El detalle de la Flows API → estado y salud. Pura. */
export function saludDesdeDetalle(d: any): SaludDeFlow {
    const hs = d?.health_status ?? null;
    const puede = hs?.can_send_message;
    return {
        estado: esEstadoFlow(d?.status) ? d.status : null,
        puedeEnviar: puede === 'AVAILABLE' || puede === 'LIMITED' || puede === 'BLOCKED' ? puede : null,
        entidades: (Array.isArray(hs?.entities) ? hs.entities : []).map((e: any) => ({
            tipo: String(e?.entity_type ?? '?'),
            id: e?.id != null ? String(e.id) : null,
            puede: e?.can_send_message ?? null,
            problemas: [
                ...(Array.isArray(e?.errors) ? e.errors.map((x: any) => `${x?.error_code ?? ''} ${x?.error_description ?? ''}`.trim()) : []),
                ...(Array.isArray(e?.additional_info) ? e.additional_info.map(String) : []),
            ],
        })),
    };
}

// ─── ¿La escuela tiene el formulario listo para mandar? ──────────────────────

export interface FilaFlow {
    id: string;
    school_id: string;
    integration_id: string;
    nombre: string;
    flow_id: string | null;
    estado: string;
    activo: boolean;
    health_can_send: string | null;
    health_revisado_at: string | null;
    config: Record<string, unknown> | null;
}

export interface FormularioListo {
    /** whatsapp_flows.id */
    filaId: string;
    /** Id de Meta. */
    flowId: string;
    nombre: string;
    config: Record<string, unknown>;
}

const COLUMNAS_FLOW = 'id, school_id, integration_id, nombre, flow_id, estado, activo, health_can_send, health_revisado_at, config';
const CACHE_FILA_MS = 10 * 60_000;
/** La salud guardada (script o consulta anterior) vale un día. */
const SALUD_FRESCA_MS = 24 * 3600_000;
const CACHE_SALUD_MS = 6 * 3600_000;
const cacheFilas = new Map<string, { hasta: number; fila: FilaFlow | null }>();
const cacheSalud = new Map<string, { hasta: number; puede: PuedeEnviar | null }>();

/** Solo pruebas (y el webhook de estados): olvida lo cacheado. */
export function olvidarCacheDeFlows(): void {
    cacheFilas.clear();
    cacheSalud.clear();
}

export type MotivoSinFormulario = 'sin_formulario' | 'apagado' | 'no_publicado' | 'sin_salud' | 'bloqueado';

/**
 * ¿Se manda? Publicado + prendido + con flow_id + salud AVAILABLE/LIMITED. La
 * salud ausente es NO (sin dato no se arriesga un formulario que no abre). Pura.
 */
export function decisionDeFormulario(fila: Pick<FilaFlow, 'flow_id' | 'activo' | 'estado'> | null, salud: PuedeEnviar | null): 'listo' | MotivoSinFormulario {
    if (!fila?.flow_id) return 'sin_formulario';
    if (fila.activo !== true) return 'apagado';
    if (fila.estado !== 'PUBLISHED') return 'no_publicado';
    if (!salud) return 'sin_salud';
    return salud === 'BLOCKED' ? 'bloqueado' : 'listo';
}

/** La salud guardada si es de las últimas 24 h; undefined si no sirve. Pura. */
export function saludGuardada(fila: Pick<FilaFlow, 'health_can_send' | 'health_revisado_at'>, ahora = Date.now()): PuedeEnviar | undefined {
    const at = fila.health_revisado_at ? new Date(fila.health_revisado_at).getTime() : NaN;
    if (!Number.isFinite(at) || ahora - at > SALUD_FRESCA_MS) return undefined;
    const p = fila.health_can_send;
    return p === 'AVAILABLE' || p === 'LIMITED' || p === 'BLOCKED' ? p : undefined;
}

/** La fila de ese formulario en esa integración (10 min de caché fuera de la simulación). Nunca lanza. */
export async function filaDeFlow(integrationId: string, nombre: string, ahora = Date.now()): Promise<FilaFlow | null> {
    const clave = `${integrationId}:${nombre}`;
    const sim = enCortafuegos();
    const c = sim ? undefined : cacheFilas.get(clave);
    if (c && c.hasta > ahora) return c.fila;
    let fila: FilaFlow | null = null;
    try {
        const { data, error } = await supabase.from('whatsapp_flows').select(COLUMNAS_FLOW)
            .eq('integration_id', integrationId).eq('nombre', nombre).limit(1);
        fila = !error && Array.isArray(data) && data[0] ? data[0] as unknown as FilaFlow : null;
    } catch {
        fila = null;
    }
    if (!sim) cacheFilas.set(clave, { hasta: ahora + CACHE_FILA_MS, fila });
    return fila;
}

/** La salud en vivo del flow contra el número (6 h de caché). En simulación, nunca (sin dato → no). Nunca lanza. */
async function saludEnVivo(integration: WhatsAppIntegration, fila: FilaFlow, ahora: number): Promise<PuedeEnviar | null> {
    if (enCortafuegos() || !fila.flow_id || !integration.access_token_encrypted) return null;
    const clave = `${fila.flow_id}:${integration.phone_number_id}`;
    const c = cacheSalud.get(clave);
    if (c && c.hasta > ahora) return c.puede;
    let puede: PuedeEnviar | null = null;
    try {
        const token = decryptToken(integration.access_token_encrypted);
        const s = saludDesdeDetalle(await metaFlows.detalle(token, fila.flow_id, integration.phone_number_id));
        // Un flow que en Meta ya no está publicado no se manda, diga lo que diga la salud.
        puede = s.estado && s.estado !== 'PUBLISHED' ? 'BLOCKED' : s.puedeEnviar;
        await supabase.from('whatsapp_flows').update({
            ...(s.estado ? { estado: s.estado } : {}),
            health_can_send: s.puedeEnviar,
            health_detalle: { entidades: s.entidades },
            health_revisado_at: new Date(ahora).toISOString(),
            updated_at: new Date(ahora).toISOString(),
        }).eq('id', fila.id).then(() => undefined, () => undefined);
    } catch (e: any) {
        console.warn('[wa-flows] no se pudo consultar la salud del formulario', { flowId: fila.flow_id, err: e?.message });
        puede = null;
    }
    cacheSalud.set(clave, { hasta: ahora + CACHE_SALUD_MS, puede });
    return puede;
}

/**
 * El formulario `nombre` de esta integración, si se puede mandar hoy. null =
 * sigue el chat (sin fila, apagado, no publicado, sin salud o bloqueado). Una
 * lectura de la base cada 10 min y una consulta a Meta cada 6 h como mucho.
 * Nunca lanza.
 */
export async function formularioDisponible(
    integration: WhatsAppIntegration, nombre: string, ahora = Date.now(),
): Promise<FormularioListo | null> {
    try {
        const fila = await filaDeFlow(integration.id, nombre, ahora);
        if (!fila || decisionDeFormulario(fila, 'AVAILABLE') !== 'listo') return null;
        const guardada = saludGuardada(fila, ahora);
        const salud = guardada !== undefined ? guardada : await saludEnVivo(integration, fila, ahora);
        if (decisionDeFormulario(fila, salud) !== 'listo') return null;
        return {
            filaId: fila.id, flowId: fila.flow_id as string, nombre: fila.nombre,
            config: fila.config && typeof fila.config === 'object' ? fila.config : {},
        };
    } catch {
        return null;
    }
}

/**
 * Webhook `flows` (FLOW_STATUS_CHANGE): el estado nuevo queda en la fila y se
 * olvida la caché (un formulario BLOCKED o THROTTLED deja de mandarse ya).
 * Nunca lanza.
 */
export async function sincronizarEstadoDeFlow(flowId: string | null | undefined, estado: unknown): Promise<boolean> {
    if (!flowId || !esEstadoFlow(estado)) return false;
    try {
        const ahora = new Date().toISOString();
        const { error } = await supabase.from('whatsapp_flows')
            .update({ estado, updated_at: ahora, ...(estado === 'PUBLISHED' ? {} : { health_can_send: null, health_revisado_at: null }) })
            .eq('flow_id', String(flowId));
        olvidarCacheDeFlows();
        return !error;
    } catch {
        return false;
    }
}
