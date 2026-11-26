import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const getSession = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), auth: { getSession: () => getSession() } },
}));

import { filasDatosDeportista, mapearCarnet3D, resolverConMarca, type VerifyCarnet3D } from './useCarnet3D';
import { SPORTMAPS_BASE } from '@/lib/cards/clubIdentity';
import type { CardBackData } from '@/lib/cards/contratos';

const verify: VerifyCarnet3D = {
  found: true,
  status: 'active',
  viewer: 'guardian',
  qr_token: '11111111-2222-3333-4444-555555555555',
  codigo: 'SM-2026-00042',
  numero: 7,
  posicion: 'Extremo derecho',
  valid_until: '2026-12-31',
  school: {
    id: 'esc-1',
    name: 'Club Deportivo Besser',
    slug: 'besser',
    logo_url: 'https://x/escudo.png',
    branding_settings: { primary_color: '#0A2A66', secondary_color: '#FFFFFF', accent_color: '#E11D48' },
  },
  athlete: { kind: 'child', full_name: 'Juan Pérez', avatar_url: 'https://x/foto.jpg', blood_type: 'O+', eps_name: 'Sura', doc_type: 'TI', doc_number: '123' },
  team_name: 'Sub-12',
  branch_name: 'Sede Norte',
  fee_status: 'overdue',
};

const back: CardBackData = {
  found: true,
  deporte: 'futbol',
  zona_de_juego: { posicion: 'Delantero', numero: 11, origen: 'alineaciones' },
  estadisticas: [],
  origen: 'generico',
};

describe('mapearCarnet3D', () => {
  it('arma el frente con lo de verify y el reverso de card_back_data', () => {
    const d = mapearCarnet3D(verify, back, true)!;
    expect(d).toMatchObject({
      nombre: 'Juan Pérez',
      fotoUrl: 'https://x/foto.jpg',
      numero: 7,
      posicion: 'Extremo derecho',
      categoria: 'Sub-12',
      codigo: 'SM-2026-00042',
      qrToken: verify.qr_token,
    });
    expect(d.reverso).toBe(back);
    expect(d.identidad).toMatchObject({ nombre: 'Club Deportivo Besser', primario: '#0A2A66', acento: '#E11D48', escudoUrl: 'https://x/escudo.png', conMarca: true });
  });

  it('sin complemento: igual salen colores y escudo del club (gratis desde 2026-11-26)', () => {
    const d = mapearCarnet3D(verify, back, false)!;
    expect(d.identidad.conMarca).toBe(true);
  });

  it('número y posición caen a la zona de juego si verify no los trae (número como texto también)', () => {
    const d = mapearCarnet3D({ ...verify, numero: null, posicion: null }, back, false)!;
    expect(d.numero).toBe(11);
    expect(d.posicion).toBe('Delantero');
    expect(mapearCarnet3D({ ...verify, numero: '23' }, null, false)!.numero).toBe(23);
  });

  it('reverso solo si card_back_data dijo found', () => {
    expect(mapearCarnet3D(verify, { found: false }, false)!.reverso).toBeNull();
    expect(mapearCarnet3D(verify, null, false)!.reverso).toBeNull();
  });

  it('revocado, vencido o no encontrado → null (vista clásica de estado)', () => {
    expect(mapearCarnet3D({ found: true, status: 'revoked', codigo: 'SM-2026-00001' } as VerifyCarnet3D, null, false)).toBeNull();
    expect(mapearCarnet3D({ found: true, status: 'expired' } as VerifyCarnet3D, null, false)).toBeNull();
    expect(mapearCarnet3D({ found: false, status: 'error' } as VerifyCarnet3D, null, false)).toBeNull();
    expect(mapearCarnet3D(null, null, false)).toBeNull();
  });

  it('nunca lleva pagos ni habilitación', () => {
    const d = mapearCarnet3D(verify, back, true)!;
    expect(JSON.stringify(d)).not.toMatch(/fee_status|overdue|monthly_fee|last_payment/);
  });

  it('campos vacíos quedan null y el nombre nunca queda vacío', () => {
    const d = mapearCarnet3D({ ...verify, athlete: { kind: 'child', full_name: '  ', avatar_url: '' }, team_name: null, codigo: null }, null, false)!;
    expect(d.nombre).toBe('Deportista');
    expect(d.fotoUrl).toBeNull();
    expect(d.categoria).toBeNull();
    expect(d.codigo).toBeNull();
  });
});

describe('filasDatosDeportista', () => {
  it('acudiente/personal: los privados que la escuela encendió, sin pagos', () => {
    const filas = filasDatosDeportista(verify);
    const etiquetas = filas.map((f) => f.etiqueta);
    expect(etiquetas).toEqual(['Documento', 'RH', 'EPS', 'Sede', 'Vigente hasta']);
    expect(filas[0].valor).toBe('TI 123');
    expect(JSON.stringify(filas)).not.toMatch(/overdue|Cuota/);
  });

  it('público: solo sede y vigencia aunque la respuesta trajera más', () => {
    const etiquetas = filasDatosDeportista({ ...verify, viewer: 'public' }).map((f) => f.etiqueta);
    expect(etiquetas).toEqual(['Sede', 'Vigente hasta']);
  });

  it('carnet no vigente → nada', () => {
    expect(filasDatosDeportista({ found: true, status: 'revoked' })).toEqual([]);
  });
});

describe('resolverConMarca', () => {
  beforeEach(() => {
    rpc.mockReset();
    getSession.mockReset();
  });

  it('identidad del club gratis: siempre true con escuela, sin consultar planes', async () => {
    await expect(resolverConMarca({ id: 'esc-1', slug: 'besser' })).resolves.toBe(true);
    await expect(resolverConMarca({ id: 'esc-1' })).resolves.toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sin escuela → false', async () => {
    await expect(resolverConMarca(null)).resolves.toBe(false);
  });
});
