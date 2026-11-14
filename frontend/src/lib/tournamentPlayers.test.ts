import { describe, it, expect } from 'vitest';
import { draftProblems, draftToBody, mapHeader, normalizeDate, rowsToDrafts, splitTable, templateCsv, type PlayerForm } from './tournamentPlayers';
import { rosterHtml, teamsListHtml, toCardData } from './tournamentPrint';

const form: PlayerForm = { required: ['full_name', 'shirt_number'], custom: [{ key: 'talla', label: 'Talla', type: 'select', options: ['S', 'M'], required: true }] };

describe('planilla de jugadores', () => {
  it('detecta separador, respeta comillas y mapea encabezados en español', () => {
    const t = splitTable('Nombre;Número;Cédula;Fecha de nacimiento;Talla\n"Ruiz, Ana";7;123;13/05/2013;M\nBea;8;;2012-01-02;S');
    expect(t[1]).toEqual(['Ruiz, Ana', '7', '123', '13/05/2013', 'M']);
    const d = rowsToDrafts(t, form);
    expect(d[0]).toEqual({ full_name: 'Ruiz, Ana', shirt_number: '7', document_number: '123', birth_date: '2013-05-13', extra: { talla: 'M' } });
    expect(mapHeader('Celular', form)).toEqual({ kind: 'base', key: 'phone' });
    expect(mapHeader('Columna rara', form)).toBeNull();
  });
  it('sin encabezado: una columna es el nombre (y la segunda el número si lo parece)', () => {
    expect(rowsToDrafts(splitTable('1. Ana\tN/A\nBea\t9\nana'), form)).toEqual([{ full_name: 'Ana' }, { full_name: 'Bea', shirt_number: '9' }]);
  });
  it('fechas: DD/MM/AAAA, ISO y serie de Excel', () => {
    expect(normalizeDate('3/5/2013')).toBe('2013-05-03');
    expect(normalizeDate('2013-05-03T00:00:00Z')).toBe('2013-05-03');
    expect(normalizeDate('41397')).toBe('2013-05-03');
    expect(normalizeDate('mayo')).toBe('mayo');
  });
  it('problemas por fila según el formulario y cuerpo para el BFF', () => {
    expect(draftProblems({ full_name: 'Ana' }, form)).toEqual(['Falta número', 'Falta «Talla»']);
    expect(draftProblems({ full_name: 'Ana', shirt_number: '7', extra: { talla: 'XL' } }, form)).toEqual(['«XL» no es una opción de «Talla»']);
    expect(draftToBody({ full_name: ' Ana ', shirt_number: '7', phone: ' ', birth_date: '3/5/2013' })).toEqual({ full_name: 'Ana', shirt_number: 7, birth_date: '2013-05-03' });
    expect(templateCsv(form).split('\n')[0]).toBe('Nombre,Número,Apodo,Posición,Documento,Fecha de nacimiento,Teléfono,Talla');
  });
});

describe('impresos y carné', () => {
  const player = { id: 'p', team_id: 't', full_name: 'Ana <b>Ruiz</b>', nickname: 'Anita', position: 'Líbero', shirt_number: 7, document_number: '123', birth_date: '2013-05-13', phone: '300', photo_url: null, extra: {}, suspended: true, suspended_reason: null, from_school: false };
  it('escapa HTML y agrupa por categoría', () => {
    const h = teamsListHtml('Copa', [{ id: '1', name: 'A&B', club_name: null, category: 'Sub 14', is_external: true }]);
    expect(h).toContain('A&amp;B');
    expect(h).toContain('Sub 14 · 1 equipo');
    const r = rosterHtml('Copa', [{ team: 'Halcones', category: 'Sub 14', club: null, players: [player] }]);
    expect(r).toContain('Ana &lt;b&gt;Ruiz&lt;/b&gt; (suspendido)');
    expect(r).toContain('<th>Documento</th>');
    expect(rosterHtml('Copa', [{ team: 'H', category: 'S', club: null, players: [player] }], { showDocument: false })).not.toContain('123');
  });
  it('el carné usa el modelo de Carnets Digitales y solo los campos elegidos', () => {
    const d = toCardData({ player, team_name: 'Halcones', team_logo_url: null, token: 'tok', validate_url: 'https://x/v' },
      { subtitle: 'Liga 2026', color: '#ff0000', fields: ['shirt_number', 'position'], public_photo: true }, { id: 'e', title: 'Copa', logo_url: null });
    expect(d.extra_rows).toEqual([{ label: 'Número', value: '7' }, { label: 'Posición', value: 'Líbero' }]);
    expect(d.athlete?.doc_number).toBeNull();
    expect(d.template).toMatchObject({ accent_color: '#ff0000', header_text: 'Liga 2026' });
    expect(d.school?.name).toBe('Copa');
  });
});
