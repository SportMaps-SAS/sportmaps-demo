/**
 * Lead del embudo (plan B2/B3 §3): sede, grupo, sexo y respuestas en las
 * columnas nuevas de `school_signup_leads`; sin la migración se guarda igual,
 * con lo nuevo en `source_detail.embudo`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    escrituras: [] as { op: 'insert' | 'update'; fila: any }[],
    /** Error de la PRIMERA escritura (columna inexistente). */
    errorPrimera: null as any,
    previo: null as any,
    lead: null as any,
}));
vi.mock('../config/supabase', () => ({
    supabase: {
        from: (tabla: string) => {
            let escritura: 'insert' | 'update' | null = null;
            let cols = '';
            const resultado = () => {
                if (escritura) {
                    const primera = h.escrituras.length === 1;
                    return { data: { id: 'lead-nuevo' }, error: primera ? h.errorPrimera : null };
                }
                if (tabla === 'schools') return { data: { slug: 'monster' }, error: null };
                if (cols.includes('cupo_separado_slot_id') && h.lead?.sinColumnas) {
                    return { data: null, error: { code: '42703', message: 'column school_signup_leads.team_id does not exist' } };
                }
                if (h.lead) return { data: [h.lead.fila], error: null };
                return { data: h.previo ? [h.previo] : [], error: null };
            };
            const api: any = {
                select: (c?: string) => { if (c) cols = c; return api; },
                eq: () => api, in: () => api, order: () => api, limit: () => api, is: () => api,
                insert: (fila: any) => { escritura = 'insert'; h.escrituras.push({ op: 'insert', fila }); return api; },
                update: (fila: any) => { escritura = 'update'; h.escrituras.push({ op: 'update', fila }); return api; },
                single: async () => resultado(),
                maybeSingle: async () => resultado(),
                then: (ok: any, err: any) => Promise.resolve(resultado()).then(ok, err),
            };
            return api;
        },
    },
}));
vi.mock('./whatsapp-atencion.service', () => ({
    interesesDeProspecto: () => [], buscaParaAdulto: () => false, edadMencionada: () => null,
}));

import {
    camposDeLeadCompleto, sinColumnasDeEmbudo, esColumnaInexistente, registrarLeadDeProspecto, leadDelEmbudo,
} from './whatsapp-prospecto-lead.service';

const NORTE = '11111111-1111-4111-8111-111111111111';
const COMPLETO = {
    deportista: 'Mariana Gómez', fechaNacimiento: '2011-03-14', edad: 15, categoriaSugerida: 'Infantil Femenino', quiere: 'clase_prueba',
    branchId: NORTE, teamId: 't-1', genero: 'f' as const, respuestas: { posicion: 'Punta' }, via: 'embudo' as const,
};
const PARAMS = { schoolId: 'monster', conversationId: 'conv-1', contactWaId: '573001112233', nombre: 'Carolina', textos: ['hola'], estado: 'respondido' as const };

beforeEach(() => {
    h.escrituras = [];
    h.errorPrimera = null;
    h.previo = null;
    h.lead = null;
});

describe('camposDeLeadCompleto', () => {
    it('el embudo llena sede, grupo, sexo (F/M como el formulario) y respuestas', () => {
        const c = camposDeLeadCompleto(COMPLETO, 'Carolina', '2026-10-30T00:00:00Z');
        expect(c.columnas).toEqual({
            full_name: 'Mariana Gómez', guardian_name: null, birth_date: '2011-03-14', suggested_category: 'Infantil Femenino',
            gender: 'F', branch_id: NORTE, team_id: 't-1', respuestas: { posicion: 'Punta' },
        });
        expect(c.detalle).toMatchObject({ via: 'embudo', contacto: 'Carolina', edad: 15, quiere: 'clase_prueba' });
    });

    it('la puerta de siempre no toca las columnas nuevas', () => {
        const c = camposDeLeadCompleto({ deportista: 'Sofía', edad: 9, quiere: 'precios' }, null, 'x');
        expect(Object.keys(c.columnas).sort()).toEqual(['birth_date', 'full_name', 'guardian_name', 'suggested_category']);
        expect(c.detalle.via).toBe('puerta_v2');
    });

    it('sin la migración, lo nuevo va a source_detail.embudo', () => {
        const c = camposDeLeadCompleto(COMPLETO, null, 'x');
        const s = sinColumnasDeEmbudo(c.columnas, c.detalle);
        expect(Object.keys(s.columnas)).not.toContain('branch_id');
        expect(s.columnas.gender).toBe('F');
        expect(s.detalle.embudo).toEqual({ branch_id: NORTE, team_id: 't-1', respuestas: { posicion: 'Punta' } });
    });

    it('esColumnaInexistente', () => {
        expect(esColumnaInexistente({ code: '42703' })).toBe(true);
        expect(esColumnaInexistente({ code: 'PGRST204', message: "Could not find the 'team_id' column" })).toBe(true);
        expect(esColumnaInexistente({ code: '23505', message: 'duplicate' })).toBe(false);
        expect(esColumnaInexistente(null)).toBe(false);
    });
});

describe('registrarLeadDeProspecto con el embudo', () => {
    it('lead nuevo con columnas del embudo', async () => {
        const r = await registrarLeadDeProspecto({ ...PARAMS, completo: COMPLETO });
        expect(r).toEqual({ leadId: 'lead-nuevo', creado: true });
        expect(h.escrituras).toHaveLength(1);
        expect(h.escrituras[0].fila).toMatchObject({ branch_id: NORTE, team_id: 't-1', gender: 'F', full_name: 'Mariana Gómez' });
    });

    it('sin la migración reintenta sin las columnas y el lead se guarda igual', async () => {
        h.errorPrimera = { code: 'PGRST204', message: "Could not find the 'branch_id' column of 'school_signup_leads'" };
        const r = await registrarLeadDeProspecto({ ...PARAMS, completo: COMPLETO });
        expect(r).toEqual({ leadId: 'lead-nuevo', creado: true });
        expect(h.escrituras).toHaveLength(2);
        expect(h.escrituras[1].fila).not.toHaveProperty('branch_id');
        expect(h.escrituras[1].fila.source_detail.embudo).toEqual({ branch_id: NORTE, team_id: 't-1', respuestas: { posicion: 'Punta' } });
    });

    it('lead existente: update con el mismo reintento', async () => {
        h.previo = { id: 'lead-1', status: 'new', source_detail: { etapa: 'nuevo' }, trial_slot_id: null };
        h.errorPrimera = { code: '42703', message: 'column "team_id" of relation "school_signup_leads" does not exist' };
        const r = await registrarLeadDeProspecto({ ...PARAMS, completo: COMPLETO });
        expect(r).toEqual({ leadId: 'lead-1', creado: false });
        expect(h.escrituras.map((e) => e.op)).toEqual(['update', 'update']);
        expect(h.escrituras[1].fila.source_detail).toMatchObject({ via: 'embudo', embudo: { team_id: 't-1' } });
    });
});

describe('leadDelEmbudo', () => {
    it('con las columnas', async () => {
        h.lead = { fila: { id: 'lead-1', full_name: 'Mariana', trial_slot_id: 's-1', team_id: 't-1', branch_id: NORTE, cupo_separado_slot_id: null, source_detail: { consentimiento: 'si' } } };
        expect(await leadDelEmbudo('monster', '573001112233')).toEqual({
            leadId: 'lead-1', nombre: 'Mariana', teamId: 't-1', branchId: NORTE, slotId: 's-1', separadoSlotId: null, consentimiento: 'si',
        });
    });

    it('sin la migración lee el grupo de source_detail.embudo', async () => {
        h.lead = { sinColumnas: true, fila: { id: 'lead-1', full_name: 'Mariana', trial_slot_id: null, source_detail: { embudo: { team_id: 't-1', branch_id: NORTE } } } };
        expect(await leadDelEmbudo('monster', '573001112233')).toMatchObject({ leadId: 'lead-1', teamId: 't-1', branchId: NORTE, consentimiento: null });
    });
});
