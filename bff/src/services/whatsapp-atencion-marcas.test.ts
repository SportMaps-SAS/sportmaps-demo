/**
 * `debeAtender` con las marcas manuales (2026-10-13). Datos inventados.
 *
 *  - negocio / otro_club / plataforma: igual que personal — no se atiende y la
 *    clasificación automática no pisa la marca.
 *  - personal + «también es familia»: el texto no se atiende (atender=false),
 *    pero el tipo es el de familia y `tambienFamilia=true`, para que el worker
 *    aplique sus comprobantes en silencio.
 *  - Sin la columna `tambien_familia` (migración sin aplicar): la marca vale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    conv: null as Record<string, any> | null,
    sinColumnaNueva: false,
    identificacion: { estado: 'desconocido' } as any,
    updates: [] as { row: any; or: string | null }[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let cols = '';
        let row: any = null;
        let or: string | null = null;
        const api: any = {
            select: (c: string) => { cols = c ?? ''; return api; },
            eq: () => api, in: () => api, is: () => api, order: () => api, limit: () => api,
            or: (f: string) => { or = f; return api; },
            update: (r: any) => { row = r; return api; },
            maybeSingle: async () => resolver(),
            then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
        };
        function resolver() {
            if (row) { h.updates.push({ row, or }); return { data: null, error: null }; }
            if (tabla === 'whatsapp_settings') return { data: { ai_enabled: true }, error: null };
            if (tabla === 'whatsapp_conversations') {
                if (h.sinColumnaNueva && cols.includes('tambien_familia')) return { data: null, error: { code: '42703' } };
                return { data: h.conv, error: null };
            }
            return { data: null, error: null };
        }
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (fn: string) => fn === 'wa_identify_by_phone'
                ? { data: h.identificacion, error: null }
                : { data: { estado: 'desconocido' }, error: null },
        },
    };
});
vi.mock('./whatsapp-tomada.service', () => ({ conversacionTomada: async () => false }));

const { debeAtender, clasificarContacto } = await import('./whatsapp-atencion.service');
const integ = { id: 'int-1', school_id: 'school-1' } as any;

beforeEach(() => {
    h.conv = null;
    h.sinColumnaNueva = false;
    h.identificacion = { estado: 'desconocido' };
    h.updates = [];
});

describe('debeAtender con marcas manuales', () => {
    for (const marca of ['negocio', 'otro_club', 'plataforma', 'equipo', 'personal']) {
        it(`${marca}: no se atiende y no se reclasifica`, async () => {
            h.conv = { id: 'conv-1', contact_kind: marca, tambien_familia: false };
            h.identificacion = { estado: 'identificado', parent_id: 'p-1' };
            const d = await debeAtender(integ, 'conv-1', '573000000099');
            expect(d).toMatchObject({ atender: false, tipo: marca, tambienFamilia: false });
            expect(h.updates).toEqual([]);
        });
    }

    it('personal + también es familia: tipo de familia, texto sin atender', async () => {
        h.conv = { id: 'conv-1', contact_kind: 'personal', tambien_familia: true };
        h.identificacion = { estado: 'identificado', parent_id: 'p-1' };
        const d = await debeAtender(integ, 'conv-1', '573000000099');
        expect(d).toMatchObject({ atender: false, tipo: 'familia', tambienFamilia: true, botEncendido: true });
        // La marca no se pisa.
        expect(h.updates).toEqual([]);
    });

    it('también es familia, pero el número no está en ninguna ficha: queda la marca', async () => {
        h.conv = { id: 'conv-1', contact_kind: 'personal', tambien_familia: true };
        const d = await debeAtender(integ, 'conv-1', '573000000099');
        expect(d).toMatchObject({ atender: false, tipo: 'personal', tambienFamilia: false });
    });

    it('sin la columna nueva la marca sigue valiendo', async () => {
        h.sinColumnaNueva = true;
        h.conv = { id: 'conv-1', contact_kind: 'negocio' };
        expect(await clasificarContacto(integ, 'conv-1', '573000000099')).toBe('negocio');
    });

    it('sin marca: se clasifica y se guarda sin pisar ninguna de las cuatro marcas', async () => {
        h.conv = { id: 'conv-1', contact_kind: 'desconocido', tambien_familia: false };
        h.identificacion = { estado: 'identificado', parent_id: 'p-1' };
        const d = await debeAtender(integ, 'conv-1', '573000000099');
        expect(d).toMatchObject({ atender: true, tipo: 'familia', tambienFamilia: false });
        expect(h.updates[0]).toEqual({
            row: { contact_kind: 'familia' },
            or: 'contact_kind.is.null,contact_kind.not.in.(personal,negocio,otro_club,plataforma,equipo)',
        });
    });
});
