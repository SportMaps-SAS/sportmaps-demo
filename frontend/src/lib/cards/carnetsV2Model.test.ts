import { describe, expect, it } from 'vitest';
import {
  CAMPOS_CARNET,
  ERROR_FALTA_FOTO,
  alternarCampo,
  camposVisibles,
  carnetsDelEquipo,
  deportistaDeEjemplo,
  esConstanciaPendiente,
  mensajeErrorEmision,
  objetivosEmision,
  parametrosEmision,
  qrPrincipal,
  quienPidio,
  resolverPlantilla,
  resumenCamposEncendidos,
  resumenCobertura,
  seccionesVisibles,
  tituloPorAprobar,
  vigenciaPorDefecto,
  type DeportistaCarnet,
} from './carnetsV2Model';
import { resolverIdentidad } from './clubIdentity';

const dep = (p: Partial<DeportistaCarnet>): DeportistaCarnet => ({
  kind: 'child', athlete_id: 'a', full_name: 'X', avatar_url: 'https://x/f.png', team_id: 't1',
  team_name: 'Sub-12', branch_name: null, issuable: true, card_status: null, has_active_card: false, ...p,
});

describe('resumenCobertura', () => {
  it('cuenta con y sin carnet como en el lienzo', () => {
    const r = resumenCobertura({ conCarnet: 412, total: 450, sinCarnet: 38, noEmitibles: 0 });
    expect(r.titulo).toBe('412 de 450 deportistas tienen carnet');
    expect(r.pct).toBe(92);
    expect(r.detalle).toContain('38 sin carnet');
  });
  it('singular y escuela vacía', () => {
    expect(resumenCobertura({ conCarnet: 1, total: 1, sinCarnet: 0, noEmitibles: 0 }).titulo).toBe('1 de 1 deportista tiene carnet');
    expect(resumenCobertura({ conCarnet: 0, total: 0, sinCarnet: 0, noEmitibles: 0 }).pct).toBe(0);
  });
  it('menciona a los que no tienen cuenta', () => {
    expect(resumenCobertura({ conCarnet: 5, total: 10, sinCarnet: 5, noEmitibles: 2 }).detalle).toContain('2 sin cuenta');
  });
});

describe('objetivosEmision', () => {
  it('solo emite a quien se puede y no tiene carnet vigente; separa los que no tienen foto', () => {
    const r = objetivosEmision([
      dep({ athlete_id: '1' }),
      dep({ athlete_id: '2', avatar_url: null }),
      dep({ athlete_id: '3', has_active_card: true, card_status: 'active' }),
      dep({ athlete_id: '4', issuable: false, kind: 'unregistered' }),
    ]);
    expect(r.listos.map((a) => a.athlete_id)).toEqual(['1', '2']);
    expect(r.sinFoto.map((a) => a.athlete_id)).toEqual(['2']);
    expect(r.yaTienen).toBe(1);
    expect(r.sinCuenta).toBe(1);
  });
});

describe('parametrosEmision', () => {
  it('manda el id en la columna del tipo de deportista', () => {
    expect(parametrosEmision('s', { kind: 'child', athlete_id: 'c' }, 'tpl', '2027-01-01')).toMatchObject({
      p_child_id: 'c', p_profile_id: null, p_unregistered_athlete_id: null, p_template_id: 'tpl', p_valid_until: '2027-01-01', p_photo_url: null,
    });
    expect(parametrosEmision('s', { kind: 'profile', athlete_id: 'p' }, null, 'x').p_profile_id).toBe('p');
    expect(parametrosEmision('s', { kind: 'unregistered', athlete_id: 'u' }, null, 'x').p_unregistered_athlete_id).toBe('u');
  });
});

describe('mensajeErrorEmision', () => {
  it('falta de foto → el texto del lienzo', () => {
    expect(mensajeErrorEmision({ message: 'athlete photo required' })).toBe(ERROR_FALTA_FOTO);
  });
  it('permiso y genérico, nunca el mensaje técnico', () => {
    expect(mensajeErrorEmision({ message: 'Forbidden: school admin only', code: '42501' })).toMatch(/permiso/);
    expect(mensajeErrorEmision({ message: 'duplicate key value violates…' })).not.toMatch(/duplicate/);
  });
});

describe('plantillas y vigencia', () => {
  it('«default» resuelve a la predeterminada o a null', () => {
    expect(resolverPlantilla('default', [{ id: 'a', is_default: false }, { id: 'b', is_default: true }])).toBe('b');
    expect(resolverPlantilla('default', [])).toBeNull();
    expect(resolverPlantilla('a', [])).toBe('a');
  });
  it('vigencia por defecto = un año', () => {
    expect(vigenciaPorDefecto(new Date('2026-11-26T12:00:00Z'))).toBe('2027-11-26');
  });
});

describe('carnetsDelEquipo', () => {
  it('filtra por cualquiera de los tres ids', () => {
    const base = { qr_token: 'q', status: 'active', issued_at: '', valid_until: '', athlete_name: '', team_name: null };
    const cs = [
      { ...base, id: '1', child_id: 'c1', profile_id: null },
      { ...base, id: '2', child_id: null, profile_id: 'p1' },
      { ...base, id: '3', child_id: null, profile_id: null, unregistered_athlete_id: 'u1' },
      { ...base, id: '4', child_id: 'otro', profile_id: null },
    ];
    expect(carnetsDelEquipo(cs, ['c1', 'p1', 'u1']).map((c) => c.id)).toEqual(['1', '2', '3']);
  });
});

describe('datos del carnet (show_fields)', () => {
  it('sin plantilla usa los valores por defecto', () => {
    const c = camposVisibles(null);
    expect(c.doc_number).toBe(true);
    expect(c.blood_type).toBe(false);
  });
  it('lo guardado manda y se ignora basura', () => {
    const c = camposVisibles({ blood_type: true, eps: 'si' as unknown as boolean });
    expect(c.blood_type).toBe(true);
    expect(c.eps).toBe(false);
  });
  it('alternar un campo conserva los que la pantalla no muestra (fee_status, photo…)', () => {
    const antes = camposVisibles({ fee_status: false });
    const despues = alternarCampo(antes, 'eps', true);
    expect(despues.eps).toBe(true);
    expect(despues.fee_status).toBe(false);
    expect(despues.photo).toBe(true);
    expect(antes.eps).toBe(false);
  });
  it('la pantalla muestra los siete de la spec §4.1', () => {
    expect(CAMPOS_CARNET.map((c) => c.clave)).toEqual(['doc_number', 'branch', 'valid_until', 'blood_type', 'eps', 'tshirt_size', 'emergency_contact']);
  });
  it('resumen corto', () => {
    expect(resumenCamposEncendidos(camposVisibles({ doc_number: false, branch: false, valid_until: false }))).toBe('Ningún dato adicional');
    expect(resumenCamposEncendidos(camposVisibles({ blood_type: true, eps: true }))).toBe('Documento, Sede, Vigencia del carnet…');
  });
});

describe('constancias', () => {
  it('pendientes, título y quién la pidió', () => {
    expect(esConstanciaPendiente('pending_review')).toBe(true);
    expect(esConstanciaPendiente('pending_payment')).toBe(true);
    expect(esConstanciaPendiente('issued')).toBe(false);
    expect(tituloPorAprobar(0)).toBe('Nada por aprobar');
    expect(tituloPorAprobar(1)).toBe('1 por aprobar');
    expect(tituloPorAprobar(3)).toBe('3 por aprobar');
    expect(quienPidio({ requested_by_name: 'Mauricio', created_by_school: false })).toBe('la pidió Mauricio');
    expect(quienPidio({ requested_by_name: null, created_by_school: true })).toBe('la emitió la escuela');
  });
});

describe('seccionesVisibles', () => {
  it('la escuela ve solo los módulos encendidos', () => {
    const s = seccionesVisibles('school', (k) => k !== 'documentos_constancias');
    expect(s).toEqual({ carnets: true, constancias: false, qr: true, ninguna: false });
  });
  it('todo apagado → ninguna', () => {
    expect(seccionesVisibles('school_admin', () => false).ninguna).toBe(true);
  });
  it('roles fuera del apagado por módulo lo ven todo (como ModuleGate)', () => {
    expect(seccionesVisibles('super_admin', () => false).ninguna).toBe(false);
  });
});

describe('deportistaDeEjemplo', () => {
  it('usa la identidad resuelta y no trae token real', () => {
    const id = resolverIdentidad({ name: 'Club Besser' }, false);
    const d = deportistaDeEjemplo(id, new Date('2026-05-01T00:00:00Z'));
    expect(d.identidad.conMarca).toBe(false);
    expect(d.qrToken).toBeNull();
    expect(d.codigo).toBe('SM-2026-00001');
  });
});

describe('qrPrincipal', () => {
  it('prefiere el general activo, ignora los apagados', () => {
    const q = (id: string, active: boolean, target_type: string) => ({ id, active, target_type });
    expect(qrPrincipal([q('a', true, 'team'), q('b', false, 'open'), q('c', true, 'open')])?.id).toBe('c');
    expect(qrPrincipal([q('a', true, 'team')])?.id).toBe('a');
    expect(qrPrincipal([q('a', false, 'open')])).toBeNull();
  });
});
