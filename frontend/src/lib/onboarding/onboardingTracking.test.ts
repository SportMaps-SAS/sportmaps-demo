import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _reiniciarVistos, buildOnboardingRpcArgs, trackOnboarding } from './onboardingTracking';

beforeEach(() => _reiniciarVistos());

describe('trackOnboarding', () => {
  it('manda un evento por acción con los argumentos de la RPC', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    expect(trackOnboarding(send, { type: 'onboarding_step_completed', flow: 'school', step: 'plan' })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ p_event_type: 'onboarding_step_completed', p_flow: 'school', p_step: 'plan', p_extra: {} });
  });

  it('«visto» se manda una sola vez por paso y sesión (nada de eventos por render)', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const evt = { type: 'onboarding_step_viewed', flow: 'school', step: 'branch' } as const;
    expect(trackOnboarding(send, evt)).toBe(true);
    expect(trackOnboarding(send, evt)).toBe(false);
    expect(trackOnboarding(send, evt)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    // otro paso u otro flujo sí cuentan
    expect(trackOnboarding(send, { ...evt, step: 'model' })).toBe(true);
    expect(trackOnboarding(send, { ...evt, flow: 'venue' })).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('completado y saltado no se deduplican: son acciones', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    trackOnboarding(send, { type: 'onboarding_step_skipped', flow: 'school', step: 'coach' });
    trackOnboarding(send, { type: 'onboarding_step_skipped', flow: 'school', step: 'coach' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('onboarding_finished no necesita paso y lleva cómo terminó', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    expect(trackOnboarding(send, { type: 'onboarding_finished', flow: 'school', extra: { how: 'later' } })).toBe(true);
    expect(send).toHaveBeenCalledWith({ p_event_type: 'onboarding_finished', p_flow: 'school', p_step: null, p_extra: { how: 'later' } });
  });

  it('un paso mal formado no se envía', () => {
    const send = vi.fn();
    expect(trackOnboarding(send, { type: 'onboarding_step_completed', flow: 'school', step: 'Paso Raro!' })).toBe(false);
    expect(trackOnboarding(send, { type: 'onboarding_step_completed', flow: 'school' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('nunca rompe la pantalla: ni si el envío falla ni si lanza', async () => {
    const rechaza = vi.fn().mockRejectedValue(new Error('red'));
    expect(() => trackOnboarding(rechaza, { type: 'onboarding_step_completed', flow: 'school', step: 'plan' })).not.toThrow();
    const lanza = vi.fn(() => { throw new Error('boom'); });
    expect(() => trackOnboarding(lanza, { type: 'onboarding_step_completed', flow: 'school', step: 'plan' })).not.toThrow();
    await Promise.resolve();
  });
});

describe('buildOnboardingRpcArgs — no filtra datos personales', () => {
  it('descarta claves raras y recorta textos largos; solo pasan strings, números y booleanos', () => {
    const args = buildOnboardingRpcArgs({
      type: 'onboarding_finished',
      flow: 'school',
      extra: {
        how: 'later',
        'Correo Raro': 'x',
        n: 3,
        ok: true,
        largo: 'x'.repeat(100),
        obj: { a: 1 } as unknown as string,
      },
    });
    expect(args.p_extra).toEqual({ how: 'later', n: 3, ok: true, largo: 'x'.repeat(40) });
  });
});
