/**
 * Reglas de fechas aprobadas (plan §11.2) y vista previa de excusar_ausencia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ responder: (_c: any): any => undefined, aviso: vi.fn() }));
vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('./aviso-familia', () => ({ avisarFamiliaExcusa: h.aviso }));

import { errorDeRango, excusarAusencia, quitarExcusa, lineaFamilia } from './herramientas/excusas';
import { rangoLegible, fechaLarga, diasDelRango } from './fechas';
import type { Alcance } from './tipos';

const ESCUELA = '11111111-1111-1111-1111-111111111111';
const NINA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const admin: Alcance = {
    schoolId: ESCUELA, userId: 'u-admin', rol: 'admin', teamIds: [],
    ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false }, hoy: '2026-11-23',
};
const coach: Alcance = { ...admin, rol: 'coach', userId: 'u-coach', teamIds: ['eq'] };
const fila = { id: NINA, full_name: 'Mariana López', athlete_type: 'child', team_id: 'eq', enrolled_team_id: 'eq', team_name: 'Tiburones', is_active: true, parent_id: 'p1', user_id: null };

let avisos: any[] = [];
beforeEach(() => {
    (globalThis as any).__consultas.length = 0;
    avisos = [];
    h.aviso.mockReset().mockResolvedValue({ app: 'enviado', correo: 'enviado', whatsapp: 'ventana_cerrada' });
    h.responder = (c) => {
        if (c.tabla === 'school_athletes') return { data: [fila] };
        if (c.tabla === 'athlete_absence_notices' && c.op === 'select') return { data: avisos };
        if (c.tabla === 'athlete_absence_notices' && c.op === 'insert') return { data: null };
        if (c.tabla === 'athlete_absence_notices' && c.op === 'update') return { data: avisos.map((a) => ({ id: a.id })) };
        return undefined;
    };
});

describe('fechas', () => {
    it('legibles con día, mes y año', () => {
        expect(fechaLarga('2026-11-03')).toBe('martes 3 de noviembre de 2026');
        expect(rangoLegible('2026-11-03', '2026-11-10')).toBe('del martes 3 al martes 10 de noviembre de 2026');
        expect(rangoLegible('2026-11-30', '2026-12-02')).toBe('del lunes 30 de noviembre al miércoles 2 de diciembre de 2026');
        expect(rangoLegible('2026-11-03', '2026-11-03')).toBe('el martes 3 de noviembre de 2026');
        expect(diasDelRango('2026-11-29', '2026-12-01')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01']);
    });
});

describe('errorDeRango (§11.2 aprobado)', () => {
    it('admin: 30 atrás, 90 adelante; coach: 7 atrás, 31 adelante; máximo 31 días', () => {
        expect(errorDeRango(admin, '2026-10-24', '2026-10-24')).toBeNull();
        expect(errorDeRango(admin, '2026-10-23', '2026-10-23')).toMatch(/30 días atrás/);
        expect(errorDeRango(admin, '2027-02-21', '2027-02-21')).toBeNull();
        expect(errorDeRango(admin, '2027-02-22', '2027-02-22')).toMatch(/90 días adelante/);
        expect(errorDeRango(coach, '2026-11-16', '2026-11-16')).toBeNull();
        expect(errorDeRango(coach, '2026-11-15', '2026-11-15')).toMatch(/administración/);
        expect(errorDeRango(coach, '2026-12-24', '2026-12-24')).toBeNull();
        expect(errorDeRango(coach, '2026-12-25', '2026-12-25')).toMatch(/31 días adelante/);
        expect(errorDeRango(admin, '2026-11-24', '2026-12-25')).toMatch(/máximo 31/);
        expect(errorDeRango(admin, '2026-11-25', '2026-11-24')).toMatch(/anterior/);
        expect(errorDeRango(admin, '24/11/2026', '2026-11-24')).toMatch(/AAAA-MM-DD/);
    });
});

describe('excusar_ausencia', () => {
    const args = { deportista: `child:${NINA}`, desde: '2026-11-24', hasta: '2026-11-27', motivo: 'viaje' as const };

    it('la vista previa dice fechas completas, respeta el aviso de la familia y no escribe nada', async () => {
        avisos = [{ id: 'f1', absence_date: '2026-11-25', source: 'whatsapp' }];
        const p = await excusarAusencia.preparar(admin, args);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Excusar a Mariana López');
        expect(p.vista.lineas[0]).toBe('Del martes 24 al viernes 27 de noviembre de 2026 · 4 días');
        expect(p.vista.lineas.join(' ')).toContain('25 de noviembre: ya lo había avisado la familia');
        expect((p.huella as any).nuevos).toEqual(['2026-11-24', '2026-11-26', '2026-11-27']);
        expect(((globalThis as any).__consultas as any[]).some((c) => c.op !== 'select')).toBe(false);
    });

    it('si todos los días ya tienen aviso, no hay nada que confirmar', async () => {
        avisos = diasDelRango('2026-11-24', '2026-11-27').map((d, i) => ({ id: `a${i}`, absence_date: d, source: 'app' }));
        expect(await excusarAusencia.preparar(admin, args)).toMatchObject({ ok: false });
    });

    it('ejecutar inserta solo los días que faltan, con source staff y quién confirmó, y avisa a la familia', async () => {
        avisos = [{ id: 'f1', absence_date: '2026-11-25', source: 'whatsapp' }];
        const r = await excusarAusencia.ejecutar(admin, args);
        expect(r.estado).toBe('executed');
        const ins = ((globalThis as any).__consultas as any[]).find((c) => c.tabla === 'athlete_absence_notices' && c.op === 'insert');
        expect((ins.datos as any[]).map((x) => x.absence_date)).toEqual(['2026-11-24', '2026-11-26', '2026-11-27']);
        expect(ins.datos[0]).toMatchObject({ school_id: ESCUELA, child_id: NINA, user_id: null, source: 'staff', reported_by: 'u-admin', status: 'active', reason: 'viaje' });
        expect(h.aviso).toHaveBeenCalledTimes(1);
        expect(excusarAusencia.mensajeResultado(r, args)).toBe(
            'Quedó registrada la excusa de Mariana López del martes 24 al viernes 27 de noviembre de 2026 (3 días). ' +
            'Aviso a la familia — app: enviado · correo: enviado · WhatsApp: no salió (no ha escrito en 24 h).');
    });

    it('una ficha sin cuenta no se puede excusar por aquí', async () => {
        h.responder = (c) => (c.tabla === 'school_athletes' ? { data: [{ ...fila, athlete_type: 'unregistered' }] } : { data: [] });
        await expect(excusarAusencia.preparar(admin, { ...args, deportista: `unregistered:${NINA}` })).rejects.toThrow(/sin cuenta/);
    });
});

describe('quitar_excusa', () => {
    const args = { deportista: `child:${NINA}`, desde: '2026-11-24', hasta: '2026-11-27' };

    it('el coach solo quita las que puso la escuela', async () => {
        avisos = [{ id: 's1', absence_date: '2026-11-24', source: 'staff' }, { id: 'f1', absence_date: '2026-11-25', source: 'whatsapp' }];
        const p = await quitarExcusa.preparar(coach, args);
        expect(p.ok).toBe(true);
        if (p.ok) {
            expect((p.huella as any).ids).toEqual(['s1']);
            expect(p.vista.lineas.join(' ')).toContain('El aviso que puso la familia no se toca.');
        }
    });

    it('el coach no puede quitar un aviso que solo puso la familia', async () => {
        avisos = [{ id: 'f1', absence_date: '2026-11-25', source: 'whatsapp' }];
        expect(await quitarExcusa.preparar(coach, args)).toMatchObject({ ok: false, motivo: expect.stringMatching(/familia/) });
    });

    it('el admin quita todas', async () => {
        avisos = [{ id: 's1', absence_date: '2026-11-24', source: 'staff' }, { id: 'f1', absence_date: '2026-11-25', source: 'whatsapp' }];
        const p = await quitarExcusa.preparar(admin, args);
        expect(p.ok && (p.huella as any).ids).toEqual(['f1', 's1']);
    });
});

describe('lineaFamilia', () => {
    it('explica cada canal', () => {
        expect(lineaFamilia({ app: 'enviado', correo: 'sin_dato', whatsapp: 'sin_integracion' }))
            .toBe('Aviso a la familia — app: enviado · correo: sin dato de contacto · WhatsApp: la escuela no tiene WhatsApp conectado.');
    });
});
