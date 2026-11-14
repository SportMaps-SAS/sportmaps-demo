import { describe, it, expect } from 'vitest';
import { FORMATO_VIVO_DEFECTO, payloadFormatoVivo, validarFormatoVivo } from '@/components/partidos/partidoVivoAgenda';

describe('partidoVivoAgenda', () => {
  it('flag apagado: no manda columnas nuevas', () => {
    expect(payloadFormatoVivo(false, FORMATO_VIVO_DEFECTO)).toEqual({});
  });
  it('flag prendido: manda las 4 columnas, árbitro vacío = null', () => {
    expect(payloadFormatoVivo(true, FORMATO_VIVO_DEFECTO)).toEqual({
      live_periods_count: 2, live_period_minutes: 45, match_kind: 'official', referee_name: null,
    });
    expect(payloadFormatoVivo(true, { ...FORMATO_VIVO_DEFECTO, clase: 'practice', arbitro: '  Pérez ' }))
      .toMatchObject({ match_kind: 'practice', referee_name: 'Pérez' });
  });
  it('valida rangos del CHECK', () => {
    expect(validarFormatoVivo(FORMATO_VIVO_DEFECTO)).toBeNull();
    expect(validarFormatoVivo({ ...FORMATO_VIVO_DEFECTO, periodos: 0 })).not.toBeNull();
    expect(validarFormatoVivo({ ...FORMATO_VIVO_DEFECTO, periodos: 5 })).not.toBeNull();
    expect(validarFormatoVivo({ ...FORMATO_VIVO_DEFECTO, minutos: 4 })).not.toBeNull();
    expect(validarFormatoVivo({ ...FORMATO_VIVO_DEFECTO, minutos: 61 })).not.toBeNull();
    expect(validarFormatoVivo({ ...FORMATO_VIVO_DEFECTO, minutos: 4.5 })).not.toBeNull();
    expect(validarFormatoVivo({ ...FORMATO_VIVO_DEFECTO, arbitro: 'x'.repeat(121) })).not.toBeNull();
    expect(validarFormatoVivo({ ...FORMATO_VIVO_DEFECTO, periodos: 1, minutos: 60 })).toBeNull();
  });
});
