/**
 * Freno de calidad de las campañas (plan B5 T3), con la forma REAL de los
 * eventos de la base viva (2026-10-30): `phone_number_quality_update` trae
 * `{event, current_limit, old_limit}` sin color; `account_update` llega a diario
 * con ACCOUNT_DELETED y no puede frenar.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
vi.mock('./whatsapp.service', () => ({ decryptToken: () => 't' }));

import { bajasQueFaltanParaElFreno, evaluarFreno, type SenalesDeCalidad } from './whatsapp-campanas-freno';

const APROBADA = '2026-11-03T12:00:00Z';
const despues = '2026-11-03T14:00:00Z';
const antes = '2026-11-02T14:00:00Z';

const base = (extra: Partial<SenalesDeCalidad> = {}): SenalesDeCalidad => ({
    calidadNumero: 'GREEN', eventos: [], desde: APROBADA,
    plantilla: { nombre: 'monster_cierre_2026', estado: 'APPROVED' },
    enviados24h: 50, bajas24h: 0, fallidos24h: 0, ...extra,
});
const evNumero = (event: string, created_at = despues) => ({
    field: 'phone_number_quality_update', nuevo_estado: 'TIER_250', motivo: event,
    payload: { value: { event, current_limit: 'TIER_250', old_limit: 'TIER_250' } }, created_at,
});

describe('evaluarFreno', () => {
    it('todo verde: sigue', () => {
        expect(evaluarFreno(base())).toEqual({ frenar: false });
    });

    it('Graph YELLOW o RED pausa', () => {
        expect(evaluarFreno(base({ calidadNumero: 'YELLOW' }))).toMatchObject({ frenar: true, motivo: 'calidad_del_numero' });
        expect(evaluarFreno(base({ calidadNumero: 'RED' }))).toMatchObject({ frenar: true, motivo: 'calidad_del_numero' });
        expect(evaluarFreno(base({ calidadNumero: null }))).toEqual({ frenar: false });
    });

    it('FLAGGED y DOWNGRADE posteriores a la aprobación pausan; anteriores no', () => {
        expect(evaluarFreno(base({ eventos: [evNumero('FLAGGED')] }))).toMatchObject({ frenar: true, motivo: 'numero_marcado' });
        expect(evaluarFreno(base({ eventos: [evNumero('DOWNGRADE')] }))).toMatchObject({ frenar: true, motivo: 'numero_marcado' });
        expect(evaluarFreno(base({ eventos: [evNumero('FLAGGED', antes)] }))).toEqual({ frenar: false });
    });

    it('ONBOARDING, UPGRADE y ACCOUNT_DELETED no frenan', () => {
        expect(evaluarFreno(base({ eventos: [evNumero('ONBOARDING'), evNumero('UPGRADE')] }))).toEqual({ frenar: false });
        const borrada = { field: 'account_update', motivo: 'ACCOUNT_DELETED', nuevo_estado: 'ACCOUNT_DELETED', payload: { value: { event: 'ACCOUNT_DELETED' } }, created_at: despues };
        expect(evaluarFreno(base({ eventos: [borrada] }))).toEqual({ frenar: false });
    });

    it('la plantilla de la campaña en amarillo o fuera de APPROVED pausa; la de otra plantilla no', () => {
        const amarilla = (nombre: string) => ({
            field: 'message_template_quality_update', template_name: nombre, nuevo_estado: 'YELLOW',
            payload: { value: { message_template_name: nombre, new_quality_score: 'YELLOW', previous_quality_score: 'GREEN' } },
            created_at: despues,
        });
        expect(evaluarFreno(base({ eventos: [amarilla('monster_cierre_2026')] }))).toMatchObject({ frenar: true, motivo: 'calidad_de_plantilla' });
        expect(evaluarFreno(base({ eventos: [amarilla('pago_vence_hoy_v4')] }))).toEqual({ frenar: false });
        expect(evaluarFreno(base({ plantilla: { nombre: 'monster_cierre_2026', estado: 'PAUSED' } })))
            .toMatchObject({ frenar: true, motivo: 'plantilla_no_aprobada' });
    });

    it('bajas > 5 % o fallos > 20 % de lo enviado en 24 h (con base mínima de 20)', () => {
        // Las bajas solo frenan con evidencia: 100 envíos o 5 bajas. El lote piloto de 50 con 3 bajas (6 %) NO frena.
        expect(evaluarFreno(base({ enviados24h: 50, bajas24h: 3 }))).toEqual({ frenar: false });
        expect(evaluarFreno(base({ enviados24h: 50, bajas24h: 4 }))).toEqual({ frenar: false });
        expect(evaluarFreno(base({ enviados24h: 50, bajas24h: 5 }))).toMatchObject({ frenar: true, motivo: 'muchas_bajas' });
        expect(evaluarFreno(base({ enviados24h: 10, bajas24h: 2 }))).toEqual({ frenar: false });
        // Con muestra plena manda el 5 %.
        expect(evaluarFreno(base({ enviados24h: 100, bajas24h: 5 }))).toEqual({ frenar: false });
        expect(evaluarFreno(base({ enviados24h: 100, bajas24h: 6 }))).toMatchObject({ frenar: true, motivo: 'muchas_bajas' });
        expect(evaluarFreno(base({ enviados24h: 122, bajas24h: 6 }))).toEqual({ frenar: false });
        expect(evaluarFreno(base({ enviados24h: 122, bajas24h: 7 }))).toMatchObject({ frenar: true, motivo: 'muchas_bajas' });
        expect(bajasQueFaltanParaElFreno(50, 3)).toBe(2);
        expect(bajasQueFaltanParaElFreno(200, 4)).toBe(7);
        expect(bajasQueFaltanParaElFreno(50, 9)).toBe(0);
        expect(evaluarFreno(base({ enviados24h: 50, fallidos24h: 11 }))).toMatchObject({ frenar: true, motivo: 'muchos_fallos' });
        expect(evaluarFreno(base({ enviados24h: 50, fallidos24h: 10 }))).toEqual({ frenar: false });
    });
});
