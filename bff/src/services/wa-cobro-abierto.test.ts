/**
 * wa-cobro-abierto (Monster 2026-11-11, docs/specs/pago-manual-de-servicio.md §3): el cobro abierto de la escuela,
 * la red de seguridad de la venta con UNA lectura, la RPC tolerante, el precio de afiliado por fecha, el nombre
 * de relleno ampliado y el dueño `user_id` del cobro creado. La base es un doble mínimo que cuenta lecturas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    type Resp = { data?: any; error?: any };
    const lecturas: { table: string; ops: [string, any[]][] }[] = [];
    const rpcs: { name: string; args: any }[] = [];
    const state = {
        responder: ((_t: string, _o: [string, any[]][]) => ({ data: [], error: null })) as (t: string, o: [string, any[]][]) => Resp,
        rpc: (() => ({ data: null, error: null })) as (n: string, a: any) => Resp,
    };
    const cadena = (table: string) => {
        const ops: [string, any[]][] = [];
        const dar = () => { lecturas.push({ table, ops }); const r = state.responder(table, ops); return { data: r.data ?? null, error: r.error ?? null }; };
        const p: any = new Proxy({}, {
            get: (_t, prop: string) => {
                if (prop === 'then') return (res: any, rej: any) => Promise.resolve(dar()).then(res, rej);
                if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve((() => { const r = dar(); return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }; })());
                return (...a: any[]) => { ops.push([prop, a]); return p; };
            },
        });
        return p;
    };
    return { lecturas, rpcs, state, cadena };
});

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (t: string) => h.cadena(t),
        rpc: (n: string, a: any) => { h.rpcs.push({ name: n, args: a }); return Promise.resolve(h.state.rpc(n, a)); },
    },
}));

const ab = await import('./wa-cobro-abierto.service');
const cobro = await import('./wa-cobro-desde-comprobante.service');

const ITEM = { id: 'item-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra' } as any;
const fila = (o: Record<string, unknown> = {}) => ({
    id: 'pay-1', amount: 175000, amount_paid: 0, status: 'pending', ocr_amount: null, concept: 'Clínica Jorge Mesa — Carlos Martínez',
    child_id: null, user_id: 'u-1', unregistered_athlete_id: null, signup_lead_id: null, payment_category: 'otro', ...o,
});
const opsDe = (i: number) => Object.fromEntries(h.lecturas[i].ops.map(([k, a]) => [k, a]));

beforeEach(() => {
    h.lecturas.length = 0; h.rpcs.length = 0;
    h.state.responder = () => ({ data: [], error: null });
    h.state.rpc = () => ({ data: null, error: null });
});

describe('aliasesDelServicio / cobrosDelServicio', () => {
    it('el nombre entero y su prefijo («Clínica»); un prefijo genérico («Clase…») no sirve', () => {
        expect(ab.aliasesDelServicio({ name: 'Clínica de armadores y atacantes' })).toEqual(['clinica de armadores y atacantes', 'clinica']);
        expect(ab.aliasesDelServicio({ name: 'Clase perfeccionamiento' })).toEqual(['clase perfeccionamiento']);
        expect(ab.aliasesDelServicio({ name: 'Copa X', alias: ['Mundialito'] })).toEqual(['copa x', 'mundialito']);
    });
    it('el enlace al ítem manda: ligado a otro ítem no es de este; sin enlace, por el concepto', () => {
        const base: any = { ...fila(), categoria: 'otro', userId: 'u', unregisteredId: null, leadId: null, itemEnlazado: null };
        const mios = ab.cobrosDelServicio([
            { ...base, id: 'a', itemEnlazado: 'item-clinica', concept: 'cualquier cosa' },
            { ...base, id: 'b', itemEnlazado: 'otro-item', concept: 'Clínica Jorge Mesa — X' },
            { ...base, id: 'c', concept: 'Clínica Jorge Mesa — X' },
            { ...base, id: 'd', concept: 'Uniforme — X' },
        ], ITEM);
        expect(mios.map((c) => c.id)).toEqual(['a', 'c']);
    });
});

describe('cobroAbiertoDelAtleta: UNA lectura, sin filtro de categoría clase_extra', () => {
    it('lee una vez, con categorías «otro» y la del ítem, estados abiertos, y devuelve el cobro de la escuela', async () => {
        h.state.responder = () => ({ data: [fila(), fila({ id: 'pay-x', concept: 'Mensualidad — Carlos' })] });
        const r = await ab.cobroAbiertoDelAtleta('s1', { userId: 'u-1' }, ITEM);
        expect(r).toMatchObject({ tipo: 'uno', cobro: { id: 'pay-1', amount: 175000, userId: 'u-1', categoria: 'otro' } });
        expect(h.lecturas).toHaveLength(1);
        const o = opsDe(0);
        expect(o.in).toBeDefined();
        const ins = h.lecturas[0].ops.filter(([k]) => k === 'in').map(([, a]) => a);
        expect(ins).toContainEqual(['status', ['pending', 'overdue', 'partial']]);
        expect(ins).toContainEqual(['payment_category', ['otro', 'clase_extra']]);
        expect(ins).toContainEqual(['user_id', ['u-1']]);
    });
    it('dos cobros abiertos del servicio → ambiguo', async () => {
        h.state.responder = () => ({ data: [fila(), fila({ id: 'pay-2' })] });
        const r = await ab.cobroAbiertoDelAtleta('s1', { userId: 'u-1' }, ITEM);
        expect(r).toMatchObject({ tipo: 'ambiguo' });
        expect((r as any).cobros).toHaveLength(2);
    });
    it('ninguno cuando no hay del servicio; sin llaves no lee nada', async () => {
        h.state.responder = () => ({ data: [fila({ concept: 'Mensualidad — X' })] });
        expect(await ab.cobroAbiertoDelAtleta('s1', { userId: 'u-1' }, ITEM)).toEqual({ tipo: 'ninguno' });
        h.lecturas.length = 0;
        expect(await ab.cobroAbiertoDelAtleta('s1', {}, ITEM)).toEqual({ tipo: 'ninguno' });
        expect(h.lecturas).toHaveLength(0);
    });
    it('con el enlace cobros_servicio_item embebido: ligado por ítem, sin mirar el concepto', async () => {
        h.state.responder = () => ({ data: [fila({ concept: 'Cobro por equipo', cobros_servicio_item: { item_id: 'item-clinica' } })] });
        expect(await ab.cobroAbiertoDelAtleta('s1', { userId: 'u-1' }, ITEM)).toMatchObject({ tipo: 'uno', cobro: { itemEnlazado: 'item-clinica' } });
    });
    it('si la tabla de enlace no existe, repite SIN el embebido (segunda lectura solo en ese caso)', async () => {
        let n = 0;
        h.state.responder = (_t, ops) => {
            n++;
            const sel = String(ops.find(([k]) => k === 'select')?.[1][0]);
            return sel.includes('cobros_servicio_item') ? { error: { code: '42P01', message: 'relation does not exist' } } : { data: [fila()] };
        };
        expect(await ab.cobroAbiertoDelAtleta('s1', { userId: 'u-1' }, ITEM)).toMatchObject({ tipo: 'uno' });
        expect(n).toBe(2);
    });
    it('varias llaves → un .or con las columnas; un fallo de lectura → error (nada se crea)', async () => {
        h.state.responder = () => ({ error: { code: 'XX', message: 'boom' } });
        expect(await ab.cobroAbiertoDelAtleta('s1', { userId: 'u-1', unregisteredId: 'ua-1' }, ITEM)).toEqual({ tipo: 'error' });
        const or = h.lecturas[0].ops.find(([k]) => k === 'or');
        expect(or?.[1][0]).toBe('user_id.in.(u-1),unregistered_athlete_id.in.(ua-1)');
    });
    it('ids con caracteres raros no entran al filtro', async () => {
        await ab.cobroAbiertoDelAtleta('s1', { userId: 'a,b)' }, ITEM);
        expect(h.lecturas).toHaveLength(0);
    });
});

describe('reconocerAtletaDelClub (contacto wau-)', () => {
    const base = (tablas: Record<string, any[]>) => {
        h.state.responder = (t) => ({ data: tablas[t] ?? [] });
    };
    it('patrón con comodín para las tildes', () => {
        expect(ab.patronDeNombre('Carlos Martínez')).toBe('%carlos%mart_nez%');
    });
    it('una persona (ficha inactiva vinculada + perfil miembro, la MISMA) con un cobro abierto', async () => {
        base({
            unregistered_athletes: [{ id: 'ua-1', full_name: 'Carlos Martínez', linked_profile_id: 'u-1' }],
            profiles: [{ id: 'u-1', full_name: 'Carlos Martínez' }],
            school_members: [{ profile_id: 'u-1' }],
            payments: [fila()],
        });
        const r = await ab.reconocerAtletaDelClub('s1', 'Carlos Martínez', ITEM);
        expect(r).toMatchObject({ tipo: 'uno', persona: { userId: 'u-1', unregisteredIds: ['ua-1'] } });
        expect((r as any).cobros).toHaveLength(1);
        // Ninguna lectura filtra por is_active.
        expect(h.lecturas.every((l) => !l.ops.some(([k, a]) => k === 'eq' && a[0] === 'is_active'))).toBe(true);
    });
    it('dos personas con el mismo nombre → homónimos (sin leer cobros)', async () => {
        base({
            unregistered_athletes: [
                { id: 'ua-1', full_name: 'Carlos Martínez', linked_profile_id: 'u-1' },
                { id: 'ua-2', full_name: 'Carlos Martínez', linked_profile_id: null },
            ],
        });
        expect(await ab.reconocerAtletaDelClub('s1', 'Carlos Martínez', ITEM)).toEqual({ tipo: 'homonimos', n: 2 });
        expect(h.lecturas.some((l) => l.table === 'payments')).toBe(false);
    });
    it('un nombre parecido pero no exacto no cuenta; un solo nombre/apellido tampoco', async () => {
        base({ unregistered_athletes: [{ id: 'ua-1', full_name: 'Carlos Martínez Gómez', linked_profile_id: null }] });
        expect(await ab.reconocerAtletaDelClub('s1', 'Carlos Martínez', ITEM)).toEqual({ tipo: 'ninguno' });
        h.lecturas.length = 0;
        expect(await ab.reconocerAtletaDelClub('s1', 'Carlos', ITEM)).toEqual({ tipo: 'ninguno' });
        expect(h.lecturas).toHaveLength(0);
    });
    it('un perfil que NO es miembro de la escuela no cuenta', async () => {
        base({ profiles: [{ id: 'u-9', full_name: 'Carlos Martínez' }], school_members: [] });
        expect(await ab.reconocerAtletaDelClub('s1', 'Carlos Martínez', ITEM)).toEqual({ tipo: 'ninguno' });
    });
    it('un fallo de lectura → error', async () => {
        h.state.responder = () => ({ error: { code: 'XX', message: 'boom' } });
        expect(await ab.reconocerAtletaDelClub('s1', 'Carlos Martínez', ITEM)).toEqual({ tipo: 'error' });
    });
});

describe('aplicarComprobanteACobroAbierto (RPC tolerante)', () => {
    const args = { schoolId: 's1', queueId: 'q1', monto: 175000, itemId: 'item-clinica', dueno: { userId: 'u-1' } };
    it('manda los parámetros del contrato', async () => {
        h.state.rpc = () => ({ data: { ok: true, payment_id: 'pay-1', estado: 'paid' } });
        expect(await ab.aplicarComprobanteACobroAbierto(args)).toEqual({ ok: true, paymentId: 'pay-1', estado: 'paid' });
        expect(h.rpcs[0]).toEqual({ name: 'aplicar_comprobante_a_cobro_abierto', args: {
            p_school_id: 's1', p_queue_id: 'q1', p_monto: 175000, p_item_id: 'item-clinica', p_child_id: null, p_user_id: 'u-1',
            p_unregistered_id: null, p_signup_lead_id: null, p_payment_id: null, p_origen: 'comprobante_bot',
        } });
    });
    it.each(['ambiguo', 'en_revision', 'sobrepago', 'sin_cobro_abierto'])('el código %s pasa tal cual', async (codigo) => {
        h.state.rpc = () => ({ data: { ok: false, codigo, candidatos: ['a', 'b'] } });
        expect(await ab.aplicarComprobanteACobroAbierto(args)).toEqual({ ok: false, codigo, candidatos: ['a', 'b'] });
    });
    it('sin la migración → migracion_pendiente (no lanza)', async () => {
        h.state.rpc = () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } });
        expect(await ab.aplicarComprobanteACobroAbierto(args)).toEqual({ ok: false, codigo: 'migracion_pendiente' });
        h.state.rpc = () => { throw new Error('red'); };
        expect(await ab.aplicarComprobanteACobroAbierto(args)).toEqual({ ok: false, codigo: 'error' });
    });
});

// ─── Red de seguridad de la venta ────────────────────────────────────────────

describe('corregirServicioPorMonto (la red de seguridad, con UNA lectura)', () => {
    const CLINICA = { id: 'item-clinica', name: 'Clínica de armadores', kind: 'clase_extra', price: 300000, precio_afiliado: 250000, allow_installments: true, abono_minimo_pct: 50 } as any;
    const VACACIONAL = { id: 'item-vac', name: 'Vacacional', kind: 'vacacional', price: 450000, allow_installments: true, abono_minimo_pct: 50 } as any;
    const TORNEO = { id: 'item-torneo', name: 'Torneo Copa', kind: 'torneo', price: 150000 } as any;
    const AHORA = Date.parse('2026-11-10T12:00:00-05:00');
    const base = { schoolId: 's1', dueno: { leadId: 'lead-1' }, afiliado: false, fechaPago: null };

    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AHORA); });

    it('el monto es el abono de UN solo otro servicio → se corrige a ese', async () => {
        const r = await ab.corregirServicioPorMonto({ ...base, monto: 225000, otros: [VACACIONAL, TORNEO] });
        expect(r?.item.id).toBe('item-vac');
        expect(r?.decision.tipo).toBe('abono');
        expect(h.lecturas.filter((l) => l.table === 'payments')).toHaveLength(1);
    });
    it('el monto cuadra con el precio completo de UN otro servicio', async () => {
        const r = await ab.corregirServicioPorMonto({ ...base, monto: 150000, otros: [VACACIONAL, TORNEO] });
        expect(r?.item.id).toBe('item-torneo');
        expect(r?.decision.tipo).toBe('completo');
    });
    it('dos coincidencias → no se corrige (a la escuela)', async () => {
        const OTRO = { ...TORNEO, id: 'item-torneo-2', name: 'Torneo Liga' };
        expect(await ab.corregirServicioPorMonto({ ...base, monto: 150000, otros: [TORNEO, OTRO] })).toBeNull();
    });
    it('ninguna coincidencia → null', async () => {
        expect(await ab.corregirServicioPorMonto({ ...base, monto: 12345, otros: [VACACIONAL, TORNEO] })).toBeNull();
    });
    it('una sola lectura aunque haya muchos servicios (antes una por servicio)', async () => {
        const muchos = Array.from({ length: 8 }, (_, i) => ({ ...TORNEO, id: `t${i}`, name: `Torneo ${i}`, price: 100000 + i }));
        await ab.corregirServicioPorMonto({ ...base, monto: 105000, otros: [...muchos, VACACIONAL] });
        expect(h.lecturas.filter((l) => l.table === 'payments')).toHaveLength(1);
    });
    it('falla la lectura de cobros → sigue sin corregir', async () => {
        h.state.responder = () => ({ error: { code: 'XX', message: 'boom' } });
        expect(await ab.corregirServicioPorMonto({ ...base, monto: 150000, otros: [TORNEO] })).toBeNull();
    });
    it('el afiliado cambia el precio de comparación', async () => {
        const OTRA = { ...CLINICA, id: 'item-otra', name: 'Otra clínica' };
        // 300.000 es el precio de lista, no el de afiliado (250.000): solo cuadra si quien paga NO es afiliado.
        const externo = await ab.corregirServicioPorMonto({ ...base, monto: 300000, otros: [OTRA], afiliado: false });
        expect(externo?.item.id).toBe('item-otra');
        expect(externo?.decision.tipo).toBe('completo');
        expect(await ab.corregirServicioPorMonto({ ...base, monto: 300000, otros: [OTRA], afiliado: true })).toBeNull();
        // Y 250.000 completo solo es del afiliado.
        const afil = await ab.corregirServicioPorMonto({ ...base, monto: 250000, otros: [{ ...OTRA, allow_installments: false }], afiliado: true });
        expect(afil?.decision.tipo).toBe('completo');
        expect(await ab.corregirServicioPorMonto({ ...base, monto: 250000, otros: [{ ...OTRA, allow_installments: false }], afiliado: false })).toBeNull();
    });
    it('con un cobro previo del otro servicio, la decisión es la del saldo; sin dueño no lee nada', async () => {
        h.state.responder = () => ({ data: [{ id: 'p1', amount: 450000, amount_paid: 225000, status: 'partial', ocr_amount: null, concept: 'Vacacional — X', child_id: null, payment_category: 'vacacional' }] });
        const r = await ab.corregirServicioPorMonto({ ...base, monto: 225000, otros: [VACACIONAL] });
        expect(r?.decision.tipo).toBe('saldo');
        expect(r?.previo?.id).toBe('p1');
        h.lecturas.length = 0;
        await ab.corregirServicioPorMonto({ ...base, dueno: null, monto: 225000, otros: [VACACIONAL] });
        expect(h.lecturas).toHaveLength(0);
    });
});

// ─── Precio de afiliado por fecha (reglas de Iván) ───────────────────────────

describe('precioVigente con precios_afiliado_por_fecha', () => {
    const item = {
        price: 300000, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
        precios_afiliado_por_fecha: [{ desde: '2026-11-16', precio: 300000 }],
    };
    it('afiliado: $250.000 hasta el 15-nov y $300.000 desde el 16-nov', () => {
        expect(cobro.precioVigente(item, { afiliado: true, hoy: '2026-11-15' })).toBe(250000);
        expect(cobro.precioVigente(item, { afiliado: true, hoy: '2026-11-16' })).toBe(300000);
    });
    it('externo: no cambia ($300.000 y $350.000 desde el 11-nov)', () => {
        expect(cobro.precioVigente(item, { afiliado: false, hoy: '2026-11-10' })).toBe(300000);
        expect(cobro.precioVigente(item, { afiliado: false, hoy: '2026-11-11' })).toBe(350000);
    });
    it('tolerante: columna ausente, null o basura → como antes', () => {
        const { precios_afiliado_por_fecha: _x, ...sin } = item;
        expect(cobro.precioVigente(sin, { afiliado: true, hoy: '2026-11-20' })).toBe(250000);
        expect(cobro.precioVigente({ ...item, precios_afiliado_por_fecha: null }, { afiliado: true, hoy: '2026-11-20' })).toBe(250000);
        expect(cobro.precioVigente({ ...item, precios_afiliado_por_fecha: 'x' }, { afiliado: true, hoy: '2026-11-20' })).toBe(250000);
    });
    it('el 30 % de grupo NO lo decide el bot: con el cobro abierto de $175.000 como ancla el monto es igual / abono, no el catálogo', () => {
        const it = { id: 'i', name: 'Clínica', kind: 'clase_extra', ...item, allow_installments: true, abono_minimo_pct: 50 } as any;
        const previo = { id: 'p', amount: 175000, amountPaid: 0, status: 'pending', ocrAmount: null, concept: 'Clínica — X', childId: null };
        expect(cobro.decidirMontoDeVenta(175000, it, { afiliado: true, previo })).toMatchObject({ tipo: 'aplicar_previo', esAbono: false });
        expect(cobro.decidirMontoDeVenta(87500, it, { afiliado: true, previo })).toMatchObject({ tipo: 'aplicar_previo', esAbono: true });
        // Con 30 % de grupo después del 15-nov: $210.000 (= 300.000 × 0,7), también el ancla.
        const previo2 = { ...previo, amount: 210000 };
        expect(cobro.decidirMontoDeVenta(210000, it, { afiliado: true, previo: previo2 })).toMatchObject({ tipo: 'aplicar_previo', esAbono: false });
        expect(cobro.decidirMontoDeVenta(105000, it, { afiliado: true, previo: previo2 })).toMatchObject({ tipo: 'aplicar_previo', esAbono: true });
    });
});

// ─── Nombre de relleno ampliado y dueño `user_id` ────────────────────────────

describe('esNombreDeRelleno ampliado', () => {
    it('el nombre del perfil de WhatsApp y los que traen emoji son de relleno', () => {
        expect(cobro.esNombreDeRelleno('Aleja 💫')).toBe(true);
        expect(cobro.esNombreDeRelleno('Aleja', 'aleja')).toBe(true);
        expect(cobro.esNombreDeRelleno('Aleja Muñoz', 'Aleja Muñoz')).toBe(true);
        expect(cobro.esNombreDeRelleno('Prospecto WhatsApp')).toBe(true);
    });
    it('un nombre real distinto del perfil no lo es', () => {
        expect(cobro.esNombreDeRelleno('María Alejandra Muñoz Hernández', 'Aleja 💫')).toBe(false);
        expect(cobro.esNombreDeRelleno('Nicolás Cubides')).toBe(false);
    });
});

describe('crearCobroDesdeComprobante con dueño userId', () => {
    it('manda p_user_id solo si el dueño es un usuario (con la RPC vieja un parámetro de más fallaría)', async () => {
        h.state.rpc = () => ({ data: { ok: true, payment_id: 'p1', precio: 175000 } });
        const base = { schoolId: 's1', queueId: 'q1', categoria: 'clase_extra' as const, monto: 175000, fuente: 'tournament_item' as const, fuenteId: 'i', concepto: null };
        expect(await cobro.crearCobroDesdeComprobante({ ...base, userId: 'u-1' })).toMatchObject({ ok: true });
        expect(h.rpcs[0].args).toMatchObject({ p_user_id: 'u-1', p_child_id: null });
        await cobro.crearCobroDesdeComprobante({ ...base, leadId: 'l-1' });
        expect('p_user_id' in h.rpcs[1].args).toBe(false);
        // Dos dueños a la vez no es válido.
        expect(await cobro.crearCobroDesdeComprobante({ ...base, userId: 'u-1', leadId: 'l-1' })).toEqual({ ok: false, codigo: 'datos_invalidos' });
    });
    it('sin la migración → migracion_pendiente', async () => {
        h.state.rpc = () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } });
        expect(await cobro.crearCobroDesdeComprobante({
            schoolId: 's1', queueId: 'q1', categoria: 'clase_extra', monto: 1, fuente: 'tournament_item', fuenteId: 'i', concepto: null, userId: 'u',
        })).toEqual({ ok: false, codigo: 'migracion_pendiente' });
    });
});
