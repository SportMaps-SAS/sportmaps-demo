/**
 * Base falsa en memoria para las pruebas de los avisos de pagos
 * (whatsapp-payment-outcome, pagos-por-validar, receipt-approval).
 * No es un *.test.ts: lo importan las pruebas desde su `vi.mock`.
 *
 * A diferencia de charge-batches.test-helpers, ESCRIBE: `update` cambia las
 * filas que pasan los filtros (y con `.select()` las devuelve), `insert` choca
 * con 23505 si el id ya existe (así se prueba la reserva de email_sends). Cada
 * consulta queda en `llamadas` para contar lecturas (sin N+1).
 */
export type Fila = Record<string, any>;

export interface BaseFalsa {
    tablas: Record<string, Fila[]>;
    rpc: Record<string, (args: any) => { data?: any; error?: any }>;
    llamadas: { tabla: string; op: 'select' | 'update' | 'insert' }[];
    llamadasRpc: { nombre: string; args: any }[];
    /** Descargas de storage: path → bytes. */
    archivos: Record<string, Uint8Array>;
}

export function baseVacia(tablas: Record<string, Fila[]> = {}): BaseFalsa {
    return { tablas, rpc: {}, llamadas: [], llamadasRpc: [], archivos: {} };
}

/** Lee `a->>b` como f.a.b. */
function valor(f: Fila, c: string): any {
    if (c.includes('->>')) {
        const [a, b] = c.split('->>');
        return f[a]?.[b] ?? null;
    }
    return f[c] ?? null;
}

export function supabaseFalso(base: BaseFalsa) {
    function builder(tabla: string) {
        const preds: ((f: Fila) => boolean)[] = [];
        let op: 'select' | 'update' | 'insert' = 'select';
        let cambios: Fila = {};
        let nuevas: Fila[] = [];
        let devolver = false;
        const orden: [string, boolean][] = [];
        let limite: number | null = null;
        const filas = (): Fila[] => (base.tablas[tabla] ??= []);

        const ejecutar = (): { data: any; error: any } => {
            base.llamadas.push({ tabla, op });
            if (op === 'insert') {
                for (const n of nuevas) {
                    if (n.id !== undefined && filas().some((f) => f.id === n.id)) {
                        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                    }
                }
                filas().push(...nuevas.map((n) => ({ ...n })));
                return { data: devolver ? nuevas.map((n) => ({ ...n })) : null, error: null };
            }
            let sel = filas().filter((f) => preds.every((p) => p(f)));
            if (op === 'update') {
                for (const f of sel) Object.assign(f, cambios);
                return { data: devolver ? sel.map((f) => ({ ...f })) : null, error: null };
            }
            for (const [c, asc] of [...orden].reverse()) {
                sel = [...sel].sort((a, b) => (valor(a, c) < valor(b, c) ? -1 : valor(a, c) > valor(b, c) ? 1 : 0) * (asc ? 1 : -1));
            }
            if (limite !== null) sel = sel.slice(0, limite);
            return { data: sel.map((f) => ({ ...f })), error: null };
        };

        const api: any = {
            select: () => { if (op !== 'select') devolver = true; return api; },
            update: (c: Fila) => { op = 'update'; cambios = c; return api; },
            insert: (r: Fila | Fila[]) => { op = 'insert'; nuevas = Array.isArray(r) ? r : [r]; return api; },
            upsert: (r: Fila | Fila[]) => { op = 'insert'; nuevas = Array.isArray(r) ? r : [r]; return api; },
            eq: (c: string, v: any) => { preds.push((f) => valor(f, c) === v); return api; },
            neq: (c: string, v: any) => { preds.push((f) => valor(f, c) !== v); return api; },
            in: (c: string, vs: any[]) => { preds.push((f) => vs.includes(valor(f, c))); return api; },
            is: (c: string, v: any) => { preds.push((f) => valor(f, c) === v); return api; },
            not: (c: string, o: string, v: any) => {
                if (o === 'is' && v === null) preds.push((f) => valor(f, c) !== null);
                return api;
            },
            or: (expr: string) => {
                const partes = expr.split(',').map((p) => p.split('.'));
                preds.push((f) => partes.some(([c, o, ...v]) => o === 'eq' && String(valor(f, c)) === v.join('.')));
                return api;
            },
            like: (c: string, pat: string) => {
                const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
                preds.push((f) => re.test(String(valor(f, c) ?? '')));
                return api;
            },
            gte: (c: string, v: any) => { preds.push((f) => valor(f, c) >= v); return api; },
            lte: (c: string, v: any) => { preds.push((f) => valor(f, c) <= v); return api; },
            lt: (c: string, v: any) => { preds.push((f) => valor(f, c) < v); return api; },
            gt: (c: string, v: any) => { preds.push((f) => valor(f, c) > v); return api; },
            order: (c: string, o?: { ascending?: boolean }) => { orden.push([c, o?.ascending !== false]); return api; },
            limit: (n: number) => { limite = n; return api; },
            maybeSingle: async () => {
                const r = ejecutar();
                return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
            },
            single: async () => {
                const r = ejecutar();
                const d = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
                return d || r.error ? { data: d, error: r.error } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
            },
            then: (ok: any, ko: any) => Promise.resolve(ejecutar()).then(ok, ko),
        };
        return api;
    }

    return {
        from: (t: string) => builder(t),
        rpc: async (nombre: string, args: any) => {
            base.llamadasRpc.push({ nombre, args });
            const h = base.rpc[nombre];
            if (!h) return { data: null, error: null };
            const r = h(args);
            return { data: r.data ?? null, error: r.error ?? null };
        },
        storage: {
            from: () => ({
                download: async (path: string) => {
                    const b = base.archivos[path];
                    return b
                        ? { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null }
                        : { data: null, error: { message: 'not found' } };
                },
            }),
        },
    };
}

/** Las lecturas (select) hechas a una tabla. */
export const lecturas = (base: BaseFalsa, tabla: string) =>
    base.llamadas.filter((l) => l.tabla === tabla && l.op === 'select').length;
