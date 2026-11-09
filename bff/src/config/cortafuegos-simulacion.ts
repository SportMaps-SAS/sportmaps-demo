/**
 * cortafuegos-simulacion — que un turno simulado del bot NO escriba nada real.
 *
 * Lo usa el modo pruebas del canal de plataforma (spec
 * docs/specs/canal-whatsapp-plataforma.md, D13): el tester le escribe al número
 * de SportMaps y el bot contesta con la configuración REAL de una escuela,
 * corriendo el mismo pipeline (`debeAtender` → `runBotTurn`). Para que eso no
 * deje rastro en la escuela, el bloqueo va en el CLIENTE de Supabase y no en
 * cada camino del bot: el día que el bot gane un camino nuevo, también queda
 * cubierto.
 *
 * Dentro de `conCortafuegos(ctx, fn)` (AsyncLocalStorage; se hereda en todo lo
 * que `fn` encadene, timers incluidos):
 *   - `from(tabla)` de una tabla VIRTUAL → memoria del contexto (lee y escribe
 *     ahí). Son las tablas de la conversación: sin ellas el bot no tiene hilo.
 *   - `from(tabla)` de cualquier otra → lecturas reales; `insert/upsert/update/
 *     delete` devuelven error `SIM00` sin tocar la base.
 *   - `rpc(fn)` → override del contexto, o allowlist de RPC `STABLE`
 *     (verificado en pg_proc.provolatile el 2026-10-09), o error `SIM00`.
 *   - `functions`, `storage`, `auth`, `schema` → error `SIM00`.
 *   - `fetch` a Graph (WhatsApp), edge functions (correo), Resend, pasarelas y
 *     FCM → 503 simulado (`instalarGuardiaFetch`).
 *
 * Fuera del contexto el proxy no cambia NADA: devuelve el método real.
 *
 * Fail-closed: una escritura bloqueada responde ERROR, no éxito. Las reservas
 * idempotentes (`email_sends`, `notifications` con id determinístico) leen el
 * error como "otro ya lo hizo" y no siguen al envío.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

// ─── Contexto ────────────────────────────────────────────────────────────────

export type Fila = Record<string, any>;

export interface ContextoCortafuegos {
    /** Tablas virtuales: nombre → filas. */
    memoria: Record<string, Fila[]>;
    /** Respuestas fijas por RPC (identificación del tester, etc.). */
    rpc: Record<string, (args: any) => unknown>;
    /** Lo que se bloqueó en este turno, para `/estado`. */
    bloqueadas: string[];
}

const als = new AsyncLocalStorage<ContextoCortafuegos>();

export function conCortafuegos<T>(ctx: ContextoCortafuegos, fn: () => Promise<T>): Promise<T> {
    return als.run(ctx, fn);
}

export function enCortafuegos(): boolean {
    return als.getStore() !== undefined;
}

export function contextoCortafuegos(): ContextoCortafuegos | undefined {
    return als.getStore();
}

/** Tablas de la conversación que se sirven desde memoria. */
export const TABLAS_VIRTUALES: ReadonlySet<string> = new Set([
    'whatsapp_conversations',
    'whatsapp_messages',
    'whatsapp_message_drafts',
    'whatsapp_conversation_flows',
    'whatsapp_settings',
    'whatsapp_optins',
    'whatsapp_identifications',
]);

/**
 * RPC de solo lectura que pasan a la base real. Todas `STABLE` en pg_proc
 * (2026-10-09). Cualquier otra, si no tiene override, se bloquea.
 */
export const RPC_SOLO_LECTURA: ReadonlySet<string> = new Set([
    'wa_get_payment_status',
    'list_open_trial_slots_public',
    'wa_catalogo_servicios',
    'school_is_operational',
    'store_enabled',
    'school_shows_own_brand',
    'school_has_branding_feature',
]);

/** Unicidad de las tablas virtuales (además de `id`). */
const UNICOS: Record<string, string[][]> = {
    whatsapp_conversations: [['integration_id', 'contact_wa_id']],
    whatsapp_messages: [['wa_message_id']],
    whatsapp_conversation_flows: [['conversation_id', 'flow']],
    whatsapp_settings: [['integration_id']],
    whatsapp_optins: [['integration_id', 'contact_wa_id']],
    // Solo cuando una batería la vuelve virtual (qa-embudo --solo flows): idempotencia del formulario.
    whatsapp_flow_respuestas: [['wa_message_id']],
};

export const ERROR_SIM = Object.freeze({
    code: 'SIM00',
    message: 'simulación: escritura bloqueada por el cortafuegos',
    details: null,
    hint: null,
});

function registrar(ctx: ContextoCortafuegos, que: string): void {
    if (ctx.bloqueadas.length < 200) ctx.bloqueadas.push(que);
}

// ─── Resultado "bloqueado": encadenable y awaitable ─────────────────────────

/**
 * Un builder falso: cualquier método devuelve el mismo objeto, y al hacer
 * `await` resuelve `{ data: null, error: SIM00 }`. Sirve para
 * `.insert(...).select('id').single()` y cualquier otra cadena.
 */
export function bloqueado(): any {
    const resultado = { data: null, error: { ...ERROR_SIM }, count: null, status: 403, statusText: 'SIM00' };
    const handler: ProxyHandler<any> = {
        get(_t, prop) {
            if (prop === 'then') {
                return (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                    Promise.resolve(resultado).then(ok, ko);
            }
            if (prop === 'catch') return (ko: (e: unknown) => unknown) => Promise.resolve(resultado).catch(ko);
            if (prop === 'finally') return (f: () => void) => Promise.resolve(resultado).finally(f);
            return () => proxy;
        },
    };
    const proxy: any = new Proxy(function () { /* encadenable */ }, handler);
    return proxy;
}

// ─── Consultas sobre memoria ────────────────────────────────────────────────

/** Valor de una columna, con `a->b` y `a->>b` de PostgREST. */
export function valorDeColumna(fila: Fila, col: string): any {
    const partes = col.split(/->>?/).map((p) => p.trim());
    let v: any = fila;
    for (const p of partes) {
        if (v === null || v === undefined) return undefined;
        v = v[p];
    }
    if (/->>/.test(col) && v !== null && v !== undefined && typeof v !== 'string') return String(v);
    return v;
}

/**
 * Las columnas CALCULADAS de un select de PostgREST: `alias:col->>clave`,
 * `alias:col->a->>b`, `alias:col` (renombre) y `col->>clave` sin alias (PostgREST
 * la nombra con la última clave). Los recursos embebidos (`tabla(...)`) y las
 * columnas simples no cuentan: la fila en memoria ya las trae. Pura.
 *
 * Sin esto `mensajesParaVenta` (whatsapp-venta-contexto.db) leía el payload vacío
 * en simulación y una venta marcada con `venta_servicio_id` no se detectaba en
 * qa:embudo ni en el número de pruebas (frente F, 2026-11-08).
 */
export function aliasesDelSelect(cols: string | null | undefined): { alias: string; expr: string }[] {
    if (!cols) return [];
    const partes: string[] = [];
    let profundidad = 0;
    let actual = '';
    for (const ch of cols) {
        if (ch === '(') profundidad++;
        if (ch === ')') profundidad--;
        if (ch === ',' && profundidad === 0) { partes.push(actual); actual = ''; } else actual += ch;
    }
    partes.push(actual);
    const out: { alias: string; expr: string }[] = [];
    for (const parte of partes.map((p) => p.trim()).filter(Boolean)) {
        if (parte.includes('(') || parte === '*') continue;
        const m = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(parte);
        const expr = (m ? m[2] : parte).trim().replace(/::[\w\s]+$/, '').trim();
        if (!m && !/->/.test(expr)) continue;
        const alias = m ? m[1] : expr.split(/->>?/).pop()!.trim();
        if (alias) out.push({ alias, expr });
    }
    return out;
}

function comparar(a: any, b: any): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function patronLike(p: string, insensible: boolean): RegExp {
    const re = String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${re}$`, insensible ? 'i' : '');
}

type Filtro = (f: Fila) => boolean;

function filtroPorOperador(col: string, op: string, valor: any): Filtro | null {
    switch (op) {
        case 'eq': return (f) => comparar(valorDeColumna(f, col), valor) === 0;
        case 'neq': return (f) => comparar(valorDeColumna(f, col), valor) !== 0;
        case 'gt': return (f) => comparar(valorDeColumna(f, col), valor) > 0;
        case 'gte': return (f) => comparar(valorDeColumna(f, col), valor) >= 0;
        case 'lt': return (f) => comparar(valorDeColumna(f, col), valor) < 0;
        case 'lte': return (f) => comparar(valorDeColumna(f, col), valor) <= 0;
        case 'is': return (f) => (valor === null ? valorDeColumna(f, col) == null : valorDeColumna(f, col) === valor);
        case 'in': return (f) => (Array.isArray(valor) ? valor : []).some((x: any) => comparar(valorDeColumna(f, col), x) === 0);
        case 'like': return (f) => patronLike(valor, false).test(String(valorDeColumna(f, col) ?? ''));
        case 'ilike': return (f) => patronLike(valor, true).test(String(valorDeColumna(f, col) ?? ''));
        default: return null;
    }
}

/**
 * Un builder de PostgREST sobre una tabla en memoria. Implementa lo que usan
 * los servicios de WhatsApp (eq/neq/gt/gte/lt/lte/is/in/like/ilike/not/match,
 * order, limit, range, single, maybeSingle, insert, upsert, update, delete).
 * Lo que no entiende (`or`, `contains`, `textSearch`…) NO filtra: en una
 * conversación de una sola persona devolver de más es inofensivo.
 */
export class ConsultaVirtual {
    private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
    private filtros: Filtro[] = [];
    private orden: { col: string; asc: boolean }[] = [];
    private limite: number | null = null;
    private desde = 0;
    private modo: 'muchas' | 'una' | 'quizas' = 'muchas';
    private filasNuevas: Fila[] = [];
    private parche: Fila = {};
    private onConflict: string[] | null = null;
    private ignorarDuplicados = false;
    private devolver = false;
    private soloConteo = false;
    private conConteo = false;
    private aliases: { alias: string; expr: string }[] = [];

    constructor(private readonly ctx: ContextoCortafuegos, private readonly tabla: string) {}

    private filas(): Fila[] {
        if (!this.ctx.memoria[this.tabla]) this.ctx.memoria[this.tabla] = [];
        return this.ctx.memoria[this.tabla];
    }

    select(cols?: string, opts?: { count?: string; head?: boolean }): this {
        if (this.op !== 'select') this.devolver = true;
        // La fila completa sale igual; los alias calculados (`x:payload->>x`) se agregan.
        this.aliases = aliasesDelSelect(cols);
        if (opts?.count) this.conConteo = true;
        if (opts?.head) this.soloConteo = true;
        return this;
    }
    insert(filas: Fila | Fila[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
        this.op = 'insert';
        this.filasNuevas = (Array.isArray(filas) ? filas : [filas]).map((f) => ({ ...f }));
        if (opts?.onConflict) this.onConflict = opts.onConflict.split(',').map((s) => s.trim());
        this.ignorarDuplicados = Boolean(opts?.ignoreDuplicates);
        return this;
    }
    upsert(filas: Fila | Fila[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
        this.insert(filas, opts);
        this.op = 'upsert';
        return this;
    }
    update(parche: Fila): this { this.op = 'update'; this.parche = { ...parche }; return this; }
    delete(): this { this.op = 'delete'; return this; }

    eq(c: string, v: any): this { return this.agregar(c, 'eq', v); }
    neq(c: string, v: any): this { return this.agregar(c, 'neq', v); }
    gt(c: string, v: any): this { return this.agregar(c, 'gt', v); }
    gte(c: string, v: any): this { return this.agregar(c, 'gte', v); }
    lt(c: string, v: any): this { return this.agregar(c, 'lt', v); }
    lte(c: string, v: any): this { return this.agregar(c, 'lte', v); }
    is(c: string, v: any): this { return this.agregar(c, 'is', v); }
    in(c: string, v: any[]): this { return this.agregar(c, 'in', v); }
    like(c: string, v: string): this { return this.agregar(c, 'like', v); }
    ilike(c: string, v: string): this { return this.agregar(c, 'ilike', v); }
    filter(c: string, op: string, v: any): this { return this.agregar(c, op, v); }
    match(obj: Fila): this { for (const [c, v] of Object.entries(obj)) this.agregar(c, 'eq', v); return this; }
    not(c: string, op: string, v: any): this {
        const f = filtroPorOperador(c, op, op === 'is' && (v === 'null' || v === null) ? null : v);
        if (f) this.filtros.push((x) => !f(x));
        return this;
    }
    order(c: string, opts?: { ascending?: boolean }): this { this.orden.push({ col: c, asc: opts?.ascending !== false }); return this; }
    limit(n: number): this { this.limite = n; return this; }
    range(a: number, b: number): this { this.desde = a; this.limite = b - a + 1; return this; }
    single(): this { this.modo = 'una'; return this; }
    maybeSingle(): this { this.modo = 'quizas'; return this; }

    private agregar(c: string, op: string, v: any): this {
        const f = filtroPorOperador(c, op, v);
        if (f) this.filtros.push(f);
        return this;
    }

    private coinciden(): Fila[] {
        return this.filas().filter((f) => this.filtros.every((p) => p(f)));
    }

    private clavesUnicas(): string[][] {
        if (this.onConflict) return [this.onConflict];
        return [['id'], ...(UNICOS[this.tabla] ?? [])];
    }

    private choca(nueva: Fila): Fila | undefined {
        return this.filas().find((f) => this.clavesUnicas().some((cols) =>
            cols.every((c) => nueva[c] !== undefined && comparar(f[c], nueva[c]) === 0)));
    }

    private ejecutar(): { data: any; error: any; count: number | null; status: number; statusText: string } {
        const ahora = new Date().toISOString();
        let filas: Fila[] = [];
        if (this.op === 'select') {
            filas = [...this.coinciden()];
        } else if (this.op === 'insert' || this.op === 'upsert') {
            for (const n of this.filasNuevas) {
                const existente = this.choca(n);
                if (existente) {
                    if (this.op === 'upsert' && !this.ignorarDuplicados) {
                        Object.assign(existente, n, { updated_at: ahora });
                        filas.push(existente);
                    } else if (this.op === 'insert' && !this.ignorarDuplicados) {
                        return { data: null, error: { code: '23505', message: 'duplicate key (memoria)', details: null, hint: null }, count: null, status: 409, statusText: 'Conflict' };
                    }
                    continue;
                }
                const fila = { id: randomUUID(), created_at: ahora, updated_at: ahora, ...n };
                this.filas().push(fila);
                filas.push(fila);
            }
        } else if (this.op === 'update') {
            filas = this.coinciden();
            for (const f of filas) Object.assign(f, this.parche);
        } else if (this.op === 'delete') {
            filas = this.coinciden();
            this.ctx.memoria[this.tabla] = this.filas().filter((f) => !filas.includes(f));
        }

        if (this.op !== 'select' && !this.devolver) {
            return { data: null, error: null, count: null, status: 204, statusText: 'No Content' };
        }
        for (const o of [...this.orden].reverse()) {
            filas.sort((a, b) => (o.asc ? 1 : -1) * comparar(valorDeColumna(a, o.col), valorDeColumna(b, o.col)));
        }
        const total = filas.length;
        if (this.desde) filas = filas.slice(this.desde);
        if (this.limite !== null) filas = filas.slice(0, this.limite);
        const copia = filas.map((f) => {
            const c = JSON.parse(JSON.stringify(f));
            for (const a of this.aliases) {
                const v = valorDeColumna(f, a.expr);
                c[a.alias] = v === undefined ? null : JSON.parse(JSON.stringify(v));
            }
            return c;
        });
        if (this.soloConteo) return { data: null, error: null, count: total, status: 200, statusText: 'OK' };
        if (this.modo === 'una') {
            if (copia.length !== 1) {
                return { data: null, error: { code: 'PGRST116', message: 'no rows (memoria)', details: null, hint: null }, count: null, status: 406, statusText: 'Not Acceptable' };
            }
            return { data: copia[0], error: null, count: this.conConteo ? total : null, status: 200, statusText: 'OK' };
        }
        if (this.modo === 'quizas') {
            return { data: copia[0] ?? null, error: null, count: this.conConteo ? total : null, status: 200, statusText: 'OK' };
        }
        return { data: copia, error: null, count: this.conConteo ? total : null, status: 200, statusText: 'OK' };
    }

    then<A = any, B = never>(ok?: ((v: any) => A | PromiseLike<A>) | null, ko?: ((e: any) => B | PromiseLike<B>) | null): Promise<A | B> {
        let r: ReturnType<ConsultaVirtual['ejecutar']>;
        try {
            r = this.ejecutar();
        } catch (e) {
            return Promise.reject(e).then(ok, ko);
        }
        return Promise.resolve(r).then(ok, ko);
    }
    catch<B = never>(ko?: ((e: any) => B | PromiseLike<B>) | null) { return this.then(undefined, ko); }
    // Lo que el builder real tiene y aquí no significa nada.
    returns(): this { return this; }
    abortSignal(): this { return this; }
    throwOnError(): this { return this; }
    or(): this { return this; }
    contains(): this { return this; }
    containedBy(): this { return this; }
    textSearch(): this { return this; }
    overlaps(): this { return this; }
}

// ─── El proxy del cliente ───────────────────────────────────────────────────

const ESCRITURAS = new Set(['insert', 'upsert', 'update', 'delete']);

function envolverConsultaReal(real: any, ctx: ContextoCortafuegos, tabla: string): any {
    return new Proxy(real, {
        get(t, prop, r) {
            if (typeof prop === 'string' && ESCRITURAS.has(prop)) {
                return () => {
                    registrar(ctx, `${prop} ${tabla}`);
                    return bloqueado();
                };
            }
            const v = Reflect.get(t, prop, r);
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
}

/** Un objeto donde cualquier método devuelve el error SIM00. */
function superficieBloqueada(ctx: ContextoCortafuegos, nombre: string): any {
    const handler: ProxyHandler<any> = {
        get(_t, prop) {
            if (prop === 'then') return undefined; // no es una promesa
            return new Proxy(function () { /* método */ }, {
                apply() {
                    registrar(ctx, `${nombre}.${String(prop)}`);
                    return bloqueado();
                },
                get(_t2, p2) {
                    if (p2 === 'then') return undefined;
                    return superficieBloqueada(ctx, `${nombre}.${String(prop)}.${String(p2)}`);
                },
            });
        },
    };
    return new Proxy({}, handler);
}

/**
 * Envuelve el cliente de Supabase. Fuera de `conCortafuegos` devuelve cada
 * propiedad tal cual (los métodos ligados al cliente real).
 */
export function envolverCliente<T extends object>(cliente: T): T {
    return new Proxy(cliente, {
        get(target, prop, receiver) {
            const ctx = als.getStore();
            const real = Reflect.get(target, prop, receiver);
            if (!ctx) return typeof real === 'function' ? real.bind(target) : real;

            if (prop === 'from') {
                return (tabla: string) => {
                    if (TABLAS_VIRTUALES.has(tabla)) return new ConsultaVirtual(ctx, tabla);
                    return envolverConsultaReal((target as any).from(tabla), ctx, tabla);
                };
            }
            if (prop === 'rpc') {
                return (fn: string, args?: any, opts?: any) => {
                    const fijo = ctx.rpc[fn];
                    if (fijo) {
                        let data: unknown;
                        try { data = fijo(args); } catch { data = null; }
                        return Promise.resolve({ data, error: null, count: null, status: 200, statusText: 'OK' });
                    }
                    if (RPC_SOLO_LECTURA.has(fn)) return (target as any).rpc(fn, args, opts);
                    registrar(ctx, `rpc ${fn}`);
                    return bloqueado();
                };
            }
            if (prop === 'functions' || prop === 'storage' || prop === 'auth') return superficieBloqueada(ctx, String(prop));
            if (prop === 'schema') return () => superficieBloqueada(ctx, 'schema');
            return typeof real === 'function' ? real.bind(target) : real;
        },
    });
}

// ─── fetch ───────────────────────────────────────────────────────────────────

const HOSTS_BLOQUEADOS = [
    'graph.facebook.com',
    'api.resend.com',
    'fcm.googleapis.com',
    'production.wompi.co',
    'sandbox.wompi.co',
    'api.mercadopago.com',
];

/** ¿Esta URL produce un efecto fuera (mensaje, correo, cobro, push)? Pura. */
export function urlConEfecto(url: string): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (HOSTS_BLOQUEADOS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return true;
    return u.pathname.startsWith('/functions/v1/');
}

/**
 * Pone una guardia sobre `globalThis.fetch`: dentro del cortafuegos, las URL con
 * efecto devuelven 503 sin salir. Fuera, llama al fetch original sin tocar
 * nada. Idempotente.
 */
export function instalarGuardiaFetch(): void {
    const g = globalThis as any;
    if (g.__guardiaFetchSimulacion || typeof g.fetch !== 'function') return;
    const original = g.fetch.bind(globalThis);
    g.fetch = (input: any, init?: any) => {
        const ctx = als.getStore();
        if (ctx) {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '');
            if (urlConEfecto(url)) {
                let host = url;
                try { host = new URL(url).hostname + new URL(url).pathname.split('/').slice(0, 3).join('/'); } catch { /* deja la url */ }
                registrar(ctx, `fetch ${host}`);
                return Promise.resolve(new Response(JSON.stringify({ error: { message: 'simulación: llamada bloqueada' } }), {
                    status: 503, headers: { 'content-type': 'application/json' },
                }));
            }
        }
        return original(input, init);
    };
    g.__guardiaFetchSimulacion = true;
}
