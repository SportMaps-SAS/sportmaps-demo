import { describe, expect, it } from 'vitest';
import { buildSignupMetadata, resolveSignupSport } from './signupMetadata';

describe('buildSignupMetadata', () => {
  const base = {
    full_name: 'Persona De Prueba',
    phone: '3000000000',
    role: 'school',
    invitation_code: '',
    school_name: 'Academia Ficticia',
  };

  it('una academia conserva el deporte que eligió en el registro (hallazgo A)', () => {
    const md = buildSignupMetadata({ ...base, sport_id: 'a1b2', sport_name: 'Voleibol' });
    expect(md.sport_name).toBe('Voleibol');
    expect(md.sport_id).toBe('a1b2');
    expect(md.school_name).toBe('Academia Ficticia');
  });

  it('acepta el id numérico del catálogo de respaldo', () => {
    expect(buildSignupMetadata({ ...base, sport_id: 7, sport_name: 'Fútbol' }).sport_id).toBe(7);
  });

  it('recorta espacios y descarta nombres vacíos o absurdamente largos', () => {
    expect(buildSignupMetadata({ ...base, sport_name: '  Danza  ' }).sport_name).toBe('Danza');
    expect(buildSignupMetadata({ ...base, sport_name: '   ' })).not.toHaveProperty('sport_name');
    expect(buildSignupMetadata({ ...base, sport_name: 'x'.repeat(81) })).not.toHaveProperty('sport_name');
  });

  it('sin nombre de deporte no viaja un sport_id suelto', () => {
    expect(buildSignupMetadata({ ...base, sport_id: 'a1b2' })).not.toHaveProperty('sport_id');
  });

  it('otros roles no llevan deporte aunque venga en el formulario', () => {
    const md = buildSignupMetadata({ ...base, role: 'parent', sport_id: 'a1b2', sport_name: 'Voleibol' });
    expect(md).not.toHaveProperty('sport_name');
    expect(md).not.toHaveProperty('sport_id');
  });

  it('no engorda el JWT: categorías sugeridas, referido y tipo de escuela no viajan', () => {
    const md = buildSignupMetadata({
      ...base,
      sport_name: 'Voleibol',
      suggested_categories: ['Sub-13', 'Sub-15'],
      referral_code: 'ABC',
      school_type: 'venue',
    });
    expect(md).not.toHaveProperty('suggested_categories');
    expect(md).not.toHaveProperty('referral_code');
    expect(md).not.toHaveProperty('school_type');
  });
});

describe('resolveSignupSport', () => {
  const catalog = ['Fútbol', 'Voleibol', 'Danza'];

  it('prefiere el deporte guardado en la escuela', () => {
    expect(resolveSignupSport({ schoolSports: ['Voleibol'], metadataSport: 'Danza', catalog })).toBe('Voleibol');
  });

  it('cae al metadata de la sesión si la escuela aún no lo tiene', () => {
    expect(resolveSignupSport({ schoolSports: [], metadataSport: 'danza', catalog })).toBe('Danza');
    expect(resolveSignupSport({ schoolSports: null, metadataSport: ' Fútbol ', catalog })).toBe('Fútbol');
  });

  it('si el deporte no está en el selector, no precarga nada', () => {
    expect(resolveSignupSport({ schoolSports: ['Quidditch'], metadataSport: undefined, catalog })).toBe('');
    expect(resolveSignupSport({ schoolSports: null, metadataSport: 42, catalog })).toBe('');
  });
});

describe('buildSignupMetadata — consentimiento de WhatsApp', () => {
  const dueno = { full_name: 'Ana', role: 'school', school_name: 'Academia X' };

  it('viaja solo si la persona marcó la casilla', () => {
    expect(buildSignupMetadata({ ...dueno, whatsapp_consent: true }).whatsapp_consent).toBe(true);
    expect('whatsapp_consent' in buildSignupMetadata({ ...dueno, whatsapp_consent: false })).toBe(false);
    expect('whatsapp_consent' in buildSignupMetadata({ ...dueno })).toBe(false);
    expect('whatsapp_consent' in buildSignupMetadata({ ...dueno, whatsapp_consent: 'true' as unknown as boolean })).toBe(false);
  });

  it('solo para dueños de negocio: academia, club u organizador', () => {
    for (const role of ['school', 'facility_manager', 'organizer']) {
      expect(buildSignupMetadata({ role, whatsapp_consent: true }).whatsapp_consent).toBe(true);
    }
    for (const role of ['parent', 'athlete', 'coach', 'store_owner']) {
      expect('whatsapp_consent' in buildSignupMetadata({ role, whatsapp_consent: true })).toBe(false);
    }
  });
});
