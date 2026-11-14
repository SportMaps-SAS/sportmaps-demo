/**
 * El PERSONAL no es un prospecto (Monster 2026-11-08): un admin de SportMaps le
 * escribió a Iván al número del club y Mapi le contestó con el guion de prospecto; los
 * profes (Santiago Carranza, coach activo) quedaban como «desconocido».
 * `wa_identify_staff_admin_by_phone` solo reconoce owner/admin/school_admin: los
 * profes y los admins de plataforma salen de `whatsapp-personal-escuela` (una consulta
 * por escuela, cacheada) y se clasifican `staff` → el bot calla. Datos inventados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    const state = {
        miembros: [] as any[],
        perfilesPlataforma: [] as any[],
        platformAdmins: [] as any[],
        identify: { estado: 'desconocido' } as any,
        staffAdmin: { estado: 'no_es_staff_admin' } as any,
        consultas: [] as string[],
        conv: { id: 'conv-1', identified: false, parent_id: null, contact_kind: null, tambien_familia: false, tomada_por: null, tomada_hasta: null } as any,
    };
    function chain(table: string) {
        const ops: [string, any[]][] = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'not', 'is', 'or', 'limit', 'order', 'update', 'gte', 'neq']) {
            b[m] = (...a: any[]) => { ops.push([m, a]); return b; };
        }
        const resolver = () => {
            state.consultas.push(table);
            if (table === 'whatsapp_settings') return { data: { ai_enabled: true, responder_desconocidos: true, responder_prospectos: true }, error: null };
            if (table === 'whatsapp_conversations') return { data: state.conv, error: null };
            if (table === 'school_members') return { data: state.miembros, error: null };
            if (table === 'profiles') return { data: state.perfilesPlataforma, error: null };
            if (table === 'platform_admins') return { data: state.platformAdmins, error: null };
            return { data: null, error: null };
        };
        b.maybeSingle = () => Promise.resolve(resolver());
        b.single = b.maybeSingle;
        b.then = (res: any, rej: any) => Promise.resolve(resolver()).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => chain(t),
            rpc: (n: string) => Promise.resolve({
                data: n === 'wa_identify_by_phone' ? state.identify : n === 'wa_identify_staff_admin_by_phone' ? state.staffAdmin : null,
                error: null,
            }),
        },
    };
});
vi.mock('../config/supabase', () => ({ supabase: h.supabase }));

import { celular10, mapaDePersonal, rolDePersonal, _olvidarPersonal } from './whatsapp-personal-escuela.service';
import { debeAtender } from './whatsapp-atencion.service';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const INTEG = { id: 'int-1', school_id: ESCUELA } as any;

beforeEach(() => {
    _olvidarPersonal();
    h.state.consultas = [];
    h.state.miembros = [
        { role: 'owner', profile: { phone: '+57 300 111 2241' } },
        { role: 'coach', profile: { phone: '3001113371' } },           // Santiago Carranza (coach activo)
        { role: 'admin', profile: [{ phone: '573001113400' }] },        // PostgREST puede traer el perfil como arreglo
        { role: 'coach', profile: { phone: '6012345678' } },            // fijo: no cruza
    ];
    h.state.perfilesPlataforma = [{ phone: '3128463555' }];
    h.state.platformAdmins = [{ profile: { phone: '3109990000' } }];
    h.state.identify = { estado: 'desconocido' };
    h.state.staffAdmin = { estado: 'no_es_staff_admin' };
});

describe('whatsapp-personal-escuela (puro)', () => {
    it('celular10: los 10 dígitos del celular colombiano; fijo o extranjero no', () => {
        expect(celular10('+57 300 111 3371')).toBe('3001113371');
        expect(celular10('573001113371')).toBe('3001113371');
        expect(celular10('3001113371')).toBe('3001113371');
        expect(celular10('6012345678')).toBeNull();
        expect(celular10('+1 415 555 0101')).toBeNull();
        expect(celular10(null)).toBeNull();
    });

    it('mapaDePersonal: owner/admin/school_admin → admin; coach → coach; plataforma; padres y atletas NO', () => {
        const m = mapaDePersonal([
            { role: 'owner', phone: '3000000001' }, { role: 'school_admin', phone: '3000000002' },
            { role: 'coach', phone: '3000000003' }, { role: 'parent', phone: '3000000004' }, { role: 'athlete', phone: '3000000005' },
            { role: 'coach', phone: '3000000001' }, // el dueño que también entrena: gana admin
        ], ['3000000006', '3000000003']);
        expect(Object.fromEntries(m)).toEqual({
            3000000001: 'admin', 3000000002: 'admin', 3000000003: 'plataforma', 3000000006: 'plataforma',
        });
    });
});

describe('rolDePersonal (una consulta por escuela, cacheada)', () => {
    it('profe, admin, dueño y admin de plataforma; un número cualquiera no', async () => {
        expect(await rolDePersonal(ESCUELA, '573001113371')).toBe('coach');
        expect(await rolDePersonal(ESCUELA, '573001113400')).toBe('admin');
        expect(await rolDePersonal(ESCUELA, '573001112241')).toBe('admin');
        expect(await rolDePersonal(ESCUELA, '573128463555')).toBe('plataforma');
        expect(await rolDePersonal(ESCUELA, '573109990000')).toBe('plataforma');
        expect(await rolDePersonal(ESCUELA, '573017517726')).toBeNull();
        expect(await rolDePersonal(ESCUELA, '6012345678')).toBeNull();
        // Siete preguntas, UNA lectura de la escuela (y una de la plataforma): sin N+1.
        expect(h.state.consultas.filter((t) => t === 'school_members')).toHaveLength(1);
        expect(h.state.consultas.filter((t) => t === 'profiles')).toHaveLength(1);
    });

    it('si la base falla, null (nunca lanza) y no se cachea el error', async () => {
        const original = h.supabase.from;
        (h.supabase as any).from = () => { throw new Error('caída'); };
        expect(await rolDePersonal(ESCUELA, '573001113371')).toBeNull();
        (h.supabase as any).from = original;
        expect(await rolDePersonal(ESCUELA, '573001113371')).toBe('coach');
    });
});

describe('debeAtender: el personal es `staff` y el bot NO le contesta (ni como prospecto)', () => {
    it('un profe de la escuela (antes «desconocido» → guion de prospecto)', async () => {
        const d = await debeAtender(INTEG, 'conv-1', '573001113371');
        expect(d).toMatchObject({ tipo: 'staff', atender: false });
    });

    it('un admin de la plataforma que le escribe al número del club', async () => {
        expect(await debeAtender(INTEG, 'conv-1', '573128463555')).toMatchObject({ tipo: 'staff', atender: false });
    });

    it('un prospecto de verdad sigue siendo desconocido (y con responder_desconocidos, se atiende)', async () => {
        expect(await debeAtender(INTEG, 'conv-1', '573017517726')).toMatchObject({ tipo: 'desconocido', atender: true });
    });

    it('familia gana: un profe que también es acudiente se atiende como familia', async () => {
        h.state.identify = { estado: 'identificado', parent_id: 'p-1' };
        expect(await debeAtender(INTEG, 'conv-1', '573001113371')).toMatchObject({ tipo: 'familia', atender: true });
    });
});
