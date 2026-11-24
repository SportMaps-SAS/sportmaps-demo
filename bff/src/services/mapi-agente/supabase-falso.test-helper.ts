/**
 * Supabase falso para las pruebas del agente: registra cada consulta (tabla,
 * operación, filtros) y responde con lo que diga `responder`. Sin red.
 */

export interface Consulta {
    tabla: string;
    op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
    filtros: [string, string, unknown][];
    datos?: unknown;
    columnas?: string;
}

export type Respuesta = { data?: unknown; error?: unknown; count?: number };

export function crearSupabaseFalso(responder: (c: Consulta) => Respuesta | undefined) {
    const consultas: Consulta[] = [];
    const from = (tabla: string) => {
        const c: Consulta = { tabla, op: 'select', filtros: [] };
        let registrada = false;
        const registrar = () => { if (!registrada) { consultas.push(c); registrada = true; } };
        const resolver = (unico: boolean): Respuesta => {
            registrar();
            const r = responder(c) ?? {};
            if (unico && Array.isArray(r.data)) return { ...r, data: r.data[0] ?? null };
            return { data: r.data ?? (unico ? null : []), error: r.error ?? null, count: r.count };
        };
        const b: any = {};
        const filtro = (tipo: string) => (col: string, val?: unknown) => { c.filtros.push([tipo, col, val]); return b; };
        for (const t of ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'ilike', 'order', 'limit', 'range', 'not']) b[t] = filtro(t);
        b.select = (cols?: string) => { if (c.op === 'select') c.columnas = cols; return b; };
        b.insert = (d: unknown) => { c.op = 'insert'; c.datos = d; return b; };
        b.update = (d: unknown) => { c.op = 'update'; c.datos = d; return b; };
        b.delete = () => { c.op = 'delete'; return b; };
        b.upsert = (d: unknown) => { c.op = 'upsert'; c.datos = d; return b; };
        b.maybeSingle = async () => resolver(true);
        b.single = async () => resolver(true);
        b.then = (ok: any, mal: any) => Promise.resolve(resolver(false)).then(ok, mal);
        return b;
    };
    return { supabase: { from, rpc: async () => ({ data: null, error: null }) }, consultas };
}

/** Valor de un filtro `eq` de una consulta. */
export const eqDe = (c: Consulta, col: string) => c.filtros.find(([t, k]) => t === 'eq' && k === col)?.[2];
