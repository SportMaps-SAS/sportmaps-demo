import { describe, expect, it, vi } from 'vitest';

// La lógica pura no toca la red ni Supabase: se aíslan los clientes.
vi.mock('@/lib/api/bffClient', () => ({ bffClient: {} }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  aceptaArchivo, esSoportesIncompletos, etiquetaSoporte, indexarEstado, llaveSujeto, mensajeErrorSoporte,
  textoInsignia, tiposFaltantesDeError, tipoSujetoDeAtleta, TIPOS_SOPORTE, validarArchivoSoporte,
  type EstadoSoportes,
} from '@/lib/api/soportes';

const MB = 1024 * 1024;

describe('validarArchivoSoporte', () => {
  it('imagen o PDF hasta 4 MB en documentos', () => {
    expect(validarArchivoSoporte('eps_certificate', { type: 'application/pdf', size: MB })).toBeNull();
    expect(validarArchivoSoporte('eps_certificate', { type: 'image/png', size: 4 * MB })).toBeNull();
  });
  it('más de 4 MB', () => {
    expect(validarArchivoSoporte('eps_certificate', { type: 'image/png', size: 4 * MB + 1 })).toMatch(/4 MB/);
  });
  it('fotos y firmas: solo imagen', () => {
    for (const t of ['athlete_photo', 'guardian_signature', 'athlete_signature']) {
      expect(validarArchivoSoporte(t, { type: 'application/pdf', size: 1000 })).toMatch(/solo admite imagen/);
      expect(validarArchivoSoporte(t, { type: 'image/webp', size: 1000 })).toBeNull();
      expect(aceptaArchivo(t)).not.toMatch(/pdf/);
    }
  });
  it('formato no permitido y archivo vacío', () => {
    expect(validarArchivoSoporte('good_standing_certificate', { type: 'application/zip', size: 1000 })).toMatch(/Formato no permitido/);
    expect(validarArchivoSoporte('good_standing_certificate', { type: 'image/png', size: 0 })).toMatch(/vacío/);
  });
});

describe('bloqueo SP001', () => {
  const rpc = new Error('SOPORTES_INCOMPLETOS: faltan 2 soporte(s): eps_certificate, athlete_signature');
  it('se detecta por el código SP001', () => {
    expect(esSoportesIncompletos({ code: 'SP001', message: 'x' })).toBe(true);
  });
  it('se detecta por el texto', () => {
    expect(esSoportesIncompletos(rpc)).toBe(true);
    expect(esSoportesIncompletos({ body: { codigo: 'SOPORTES_INCOMPLETOS', faltan: ['athlete_photo'] } })).toBe(true);
  });
  it('otros errores no son de soportes', () => {
    expect(esSoportesIncompletos(new Error('permission denied'))).toBe(false);
    expect(esSoportesIncompletos(null)).toBe(false);
  });
  it('lista lo que falta desde el mensaje, el DETAIL o el 409', () => {
    expect(tiposFaltantesDeError(rpc)).toEqual(['eps_certificate', 'athlete_signature']);
    expect(tiposFaltantesDeError({ message: 'x', details: '["athlete_photo","eps_certificate"]' })).toEqual(['athlete_photo', 'eps_certificate']);
    expect(tiposFaltantesDeError({ body: { faltan: ['good_standing_certificate'] } })).toEqual(['good_standing_certificate']);
    expect(tiposFaltantesDeError(new Error('otra cosa'))).toEqual([]);
  });
});

describe('etiquetas, índice e insignia', () => {
  it('los 7 tipos tienen etiqueta en español', () => {
    expect(TIPOS_SOPORTE).toHaveLength(7);
    for (const t of TIPOS_SOPORTE) expect(etiquetaSoporte(t)).not.toBe(t);
    expect(etiquetaSoporte('otro')).toBe('otro');
  });
  it('tipo de sujeto: adulto con cuenta = profile', () => {
    expect(tipoSujetoDeAtleta('adult')).toBe('profile');
    expect(tipoSujetoDeAtleta('child')).toBe('child');
    expect(tipoSujetoDeAtleta('unregistered')).toBe('unregistered');
  });
  const estado = (activo: boolean): EstadoSoportes => ({
    activo,
    requeridos: [...TIPOS_SOPORTE],
    resumen: { total: 1, completos: 0, incompletos: 1, sin_cuenta_incompletos: 0 },
    deportistas: [{
      subject_type: 'child', subject_id: 'c1', full_name: 'Ana', notify_profile_id: null,
      has_account: true, required_total: 7, present_total: 5, missing: ['eps_certificate', 'athlete_photo'], complete: false,
    }],
  });
  it('indexa solo si está activo', () => {
    expect(indexarEstado(estado(true)).get(llaveSujeto('child', 'c1'))?.full_name).toBe('Ana');
    expect(indexarEstado(estado(false)).size).toBe(0);
    expect(indexarEstado(null).size).toBe(0);
  });
  it('texto «Soportes X/7»', () => {
    expect(textoInsignia({ present_total: 5, required_total: 7 })).toBe('Soportes 5/7');
  });
  it('errores de subida en español', () => {
    expect(mensajeErrorSoporte({ status: 413 })).toMatch(/4 MB/);
    expect(mensajeErrorSoporte({ status: 400, body: { codigo: 'solo_imagen' } })).toMatch(/solo admite imagen/);
    expect(mensajeErrorSoporte({ status: 403 })).toMatch(/permiso/);
  });
});
