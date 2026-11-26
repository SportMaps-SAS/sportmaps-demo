// Tests del contrato de identidad del club (spec carnet-3d-club §10).
import { describe, it, expect } from 'vitest';
import {
  SPORTMAPS_BASE,
  TEXTO_CLARO,
  TEXTO_OSCURO,
  esHex,
  luminancia,
  razonContraste,
  textoSobre,
  avisoContrasteAcento,
  resolverIdentidad,
  iniciales,
  escudoPorDefecto,
} from './clubIdentity';

describe('contraste WCAG', () => {
  it('blanco contra negro = 21:1', () => {
    expect(razonContraste('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(razonContraste('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('un color contra sí mismo = 1:1', () => {
    expect(razonContraste('#248223', '#248223')).toBeCloseTo(1, 5);
  });

  it('luminancia: negro 0, blanco 1; hex inválido cae a negro', () => {
    expect(luminancia('#000000')).toBe(0);
    expect(luminancia('#FFFFFF')).toBeCloseTo(1, 5);
    expect(luminancia('rojo')).toBe(0);
  });

  it('caso conocido: #777777 sobre blanco ≈ 4.48', () => {
    expect(razonContraste('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});

describe('textoSobre', () => {
  it('fondo oscuro → texto claro; fondo claro → texto oscuro', () => {
    expect(textoSobre('#000000')).toBe(TEXTO_CLARO);
    expect(textoSobre('#1E3A8A')).toBe(TEXTO_CLARO);
    expect(textoSobre('#FFFFFF')).toBe(TEXTO_OSCURO);
    expect(textoSobre('#FDE047')).toBe(TEXTO_OSCURO);
  });
});

describe('avisoContrasteAcento', () => {
  it('sin aviso cuando el contraste alcanza 3:1', () => {
    expect(avisoContrasteAcento('#000000', '#FFFFFF')).toBeNull();
    expect(avisoContrasteAcento('#1E3A8A', '#FDE047')).toBeNull();
  });

  it('avisa cuando el acento casi no se distingue del principal', () => {
    const aviso = avisoContrasteAcento('#248223', '#2A8A2A');
    expect(aviso).not.toBeNull();
    expect(aviso).toMatch(/contraste 1\.\d:1/);
  });
});

describe('resolverIdentidad', () => {
  const escuela = {
    name: 'Club Deportivo Besser',
    logo_url: 'https://x.supabase.co/storage/v1/object/public/school-assets/logos/1/escudo.webp',
    branding_settings: { primary_color: '#1E3A8A', secondary_color: '#FFFFFF', accent_color: '#FDE047' },
  };

  it('sin complemento → igual salen los colores y el escudo del club (gratis desde 2026-11-26)', () => {
    const id = resolverIdentidad(escuela, false);
    expect(id).toMatchObject({ primario: '#1E3A8A', secundario: '#FFFFFF', acento: '#FDE047', conMarca: true });
    expect(id.escudoUrl).toBe(escuela.logo_url);
  });

  it('con complemento → colores y escudo del club', () => {
    const id = resolverIdentidad(escuela, true);
    expect(id).toMatchObject({ primario: '#1E3A8A', secundario: '#FFFFFF', acento: '#FDE047', conMarca: true });
    expect(id.escudoUrl).toBe(escuela.logo_url);
  });

  it('forzarMarca (vista previa sin complemento) pinta la identidad del club', () => {
    expect(resolverIdentidad(escuela, false, { forzarMarca: true }).conMarca).toBe(true);
  });

  it('sin acento guardado → usa el secundario; hex inválido → base', () => {
    const id = resolverIdentidad(
      { name: 'X', branding_settings: { primary_color: 'rojo', secondary_color: '#123456' } },
      true,
    );
    expect(id.primario).toBe(SPORTMAPS_BASE.primario);
    expect(id.acento).toBe('#123456');
    expect(id.escudoUrl).toBeNull();
  });

  it('sin branding_settings no revienta', () => {
    expect(resolverIdentidad({ name: 'X', branding_settings: null }, true).primario).toBe(SPORTMAPS_BASE.primario);
  });
});

describe('iniciales', () => {
  it('toma hasta 3 palabras e ignora las cortas (de, la, FC…)', () => {
    expect(iniciales('Escuela de Fútbol Monster')).toBe('EFM');
    expect(iniciales('Club Deportivo Besser')).toBe('CDB');
    expect(iniciales('Club Deportivo Besser', 2)).toBe('CD');
    expect(iniciales('Atlético La Paz')).toBe('AP');
  });

  it('quita tildes y conserva números', () => {
    expect(iniciales('Águilas 2010')).toBe('A2');
  });

  it('nombre sin palabras largas o vacío no queda en blanco', () => {
    expect(iniciales('FC')).toBe('F');
    expect(iniciales('?')).toBe('?');
  });

  it('nombre vacío → «?»', () => {
    expect(iniciales('')).toBe('?');
    expect(iniciales('  ')).toBe('?');
  });
});

describe('escudoPorDefecto', () => {
  it('es determinista y lleva iniciales y colores', () => {
    const a = escudoPorDefecto({ nombre: 'Club Carmel', primario: '#1E3A8A', secundario: '#FDE047' });
    const b = escudoPorDefecto({ nombre: 'Club Carmel', primario: '#1E3A8A', secundario: '#FDE047' });
    expect(a).toBe(b);
    expect(a.startsWith('data:image/svg+xml')).toBe(true);
    const svg = decodeURIComponent(a.split(',')[1]!);
    expect(svg).toContain('>CC<');
    expect(svg).toContain('#1E3A8A');
    expect(svg).toContain(`fill="${TEXTO_CLARO}"`);
  });
});

describe('esHex', () => {
  it('solo #RRGGBB', () => {
    expect(esHex('#a1B2c3')).toBe(true);
    expect(esHex('#fff')).toBe(false);
    expect(esHex('#fff; background:url(x)')).toBe(false);
    expect(esHex(null)).toBe(false);
  });
});
