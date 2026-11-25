import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JoinSchoolCodeBanner } from './JoinSchoolCodeBanner';

const myStatus = vi.fn();

vi.mock('@/lib/api/schoolJoin', () => ({
  schoolJoinApi: { myStatus: (...a: unknown[]) => myStatus(...a), cancel: vi.fn() },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <JoinSchoolCodeBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pendiente = (extra: Record<string, unknown> = {}) => ({
  has_school: false,
  requests: [{
    id: 'r1', status: 'pending', for_whom: 'child', athlete_name: 'Ana Prueba',
    created_at: hace(3), resolved_at: null, reject_reason: null,
    school_name: 'Academia X', logo_url: null, team_name: null, ...extra,
  }],
});

describe('JoinSchoolCodeBanner — solicitud pendiente', () => {
  beforeEach(() => {
    myStatus.mockReset();
    window.localStorage.clear();
  });

  it('dice quién la revisa y hace cuántos días se envió', async () => {
    myStatus.mockResolvedValue(pendiente({ school_whatsapp: '3001112233' }));
    montar();
    expect(await screen.findByText('En revisión por Academia X')).toBeTruthy();
    expect(screen.getByText(/enviada hace 3 días/)).toBeTruthy();
  });

  it('con WhatsApp de la escuela ofrece escribirle, con el enlace correcto', async () => {
    myStatus.mockResolvedValue(pendiente({ school_whatsapp: '300 111 2233' }));
    montar();
    const enlace = (await screen.findByRole('link', { name: /Escribirle a la escuela/ })) as HTMLAnchorElement;
    expect(enlace.href.startsWith('https://wa.me/573001112233?text=')).toBe(true);
    expect(enlace.target).toBe('_blank');
    expect(enlace.rel).toContain('noopener');
  });

  it('sin WhatsApp de la escuela (o base sin migrar) no muestra el botón', async () => {
    myStatus.mockResolvedValue(pendiente());
    montar();
    await screen.findByText('En revisión por Academia X');
    expect(screen.queryByRole('link', { name: /Escribirle a la escuela/ })).toBeNull();
  });
});
