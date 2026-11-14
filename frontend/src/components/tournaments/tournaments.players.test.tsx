/** Equipos rápidos, nómina con vista previa, validación del carné y link del delegado. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
}));
// toast estable, como el hook real (si cambia en cada render, los useCallback que lo usan se recrean sin fin).
const toastFn = vi.hoisted(() => ({ toast: () => {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastFn }));
vi.mock('@/hooks/usePublicLive', () => ({ useNoIndex: () => {} }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) } } }));

import { QuickAddTeam } from './TournamentTeamsPanel';
import { RosterImporter } from './RosterImporter';
import TournamentCardValidationPage from '@/pages/events/TournamentCardValidationPage';
import TournamentTeamInvitePage from '@/pages/events/TournamentTeamInvitePage';

beforeEach(() => { get.mockReset(); post.mockReset(); });

describe('agregar equipos rápido', () => {
  it('Enter agrega y limpia; muestra el total', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    render(<QuickAddTeam total={3} onAdd={onAdd} />);
    expect(screen.getByTestId('teams-total').textContent).toBe('Total: 3');
    const input = screen.getByLabelText('Nombre del equipo') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Águilas' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith('Águilas'));
    await waitFor(() => expect(input.value).toBe(''));
  });
});

describe('nómina con vista previa', () => {
  const form = { required: ['full_name' as const], custom: [] };
  it('pegar lista → revisar → guardar; no guarda nada sin revisar', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RosterImporter form={form} onSave={onSave} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pegar lista' }));
    fireEvent.change(screen.getByLabelText('Lista de jugadores'), { target: { value: 'Ana\t7\nBea\t8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar lista' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('roster-preview').textContent).toContain('2 jugadores');
    fireEvent.change(screen.getByLabelText('Nombre fila 2'), { target: { value: 'Beatriz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar 2 jugadores' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toEqual([{ full_name: 'Ana', shirt_number: '7' }, { full_name: 'Beatriz', shirt_number: '8' }]);
  });
  it('la foto de la planilla solo se ofrece si hay lector', () => {
    const { rerender } = render(<RosterImporter form={form} onSave={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: 'Foto de la planilla' })).toBeNull();
    rerender(<RosterImporter form={form} onSave={vi.fn()} readPhoto={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Foto de la planilla' })).toBeTruthy();
  });
});

const at = (path: string, el: JSX.Element, route: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={el} /></Routes></MemoryRouter>);

describe('validación en cancha', () => {
  it('Habilitado con nombre de pila y equipo', async () => {
    get.mockResolvedValue({ tournament: { title: 'Copa', logo_url: null }, player: { first_name: 'Ana', photo_url: null, shirt_number: 7 }, team: { name: 'Halcones', logo_url: null }, category: 'Sub 14', status: 'habilitado', reasons: [], checked_at: new Date().toISOString() });
    at('/torneo/copa/validar/tok', <TournamentCardValidationPage />, '/torneo/:slug/validar/:token');
    await waitFor(() => expect(screen.getByTestId('card-status').textContent).toContain('Habilitado'));
    expect(get.mock.calls[0][0]).toBe('/api/v1/tournament-live/public/copa/validate/tok');
    expect(get.mock.calls[0][2]).toBe('public');
  });
  it('QR inventado → carné no válido', async () => {
    get.mockRejectedValue(new Error('404'));
    at('/torneo/copa/validar/x', <TournamentCardValidationPage />, '/torneo/:slug/validar/:token');
    await waitFor(() => expect(screen.getByTestId('card-invalid')).toBeTruthy());
  });
});

describe('link de inscripción del delegado', () => {
  const home = {
    tournament: { title: 'Copa', sport: 'Voleibol', slug: 'copa', event_date: null, logo_url: null, rules_url: 'https://r', attachments: [] },
    team: { id: 't', name: 'Halcones', logo_url: null, short_name: null, colors: null },
    category: { name: 'Sub 14', age_min: 12, age_max: 14 },
    form: { required: ['full_name'], custom: [] },
    players: [{ id: 'p', team_id: 't', full_name: 'Ana', shirt_number: 7 }],
    invite: { payment_status: 'not_required', payment_amount: null, roster_target: 12, completed_at: null, has_payment_proof: false },
    consent: { version: 'v1', text: 'Autorizo el tratamiento de datos.' },
  };
  it('el consentimiento no viene marcado y sin él no se envía; al enviar ofrece «Prueba gratis»', async () => {
    get.mockResolvedValue(home);
    post.mockResolvedValue({ signup_prefill: { club_name: 'Halcones', email: 'd@x.co' } });
    at('/torneo/copa/equipo/tok', <TournamentTeamInvitePage />, '/torneo/:slug/equipo/:token');
    await waitFor(() => expect(screen.getByText(/Inscripción de/)).toBeTruthy());
    expect(screen.getByText('2. Nómina · Total: 1 de 12')).toBeTruthy();
    const consent = screen.getByLabelText('Autorizo el tratamiento de datos') as HTMLInputElement;
    expect(consent.checked).toBe(false);
    const send = screen.getByRole('button', { name: 'Enviar inscripción' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByText('Leí y acepto el reglamento del torneo.'));
    fireEvent.click(consent);
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByText('¡Halcones quedó inscrito!')).toBeTruthy());
    expect(post.mock.calls[0][1]).toMatchObject({ rules_accepted: true, consent: true, consent_version: 'v1' });
    expect((screen.getByRole('link', { name: 'Prueba gratis' }) as HTMLAnchorElement).getAttribute('href')).toContain('email=d%40x.co');
  });
});
