/**
 * Bandeja de solicitudes de plan: apagada = nada; vacío; orden y filtros;
 * dar_de_baja solo en retiro (desmarcada por defecto); aviso de payments_a_revisar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { BandejaSolicitudesPlan } from './BandejaSolicitudesPlan';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const sol = (id: string, tipo: string, estado: string, creada_at: string, extra = {}) => ({
    id, tipo, enrollment_id: 'E' + id, school_id: ESCUELA, estado, atleta_nombre: 'Atleta ' + id, desde: '2026-12-01', hasta: tipo === 'pausa' ? '2027-02-01' : null,
    motivo: tipo === 'pausa' ? 'injury' : null, detalle_motivo: 'Se lesionó', canal: 'whatsapp', solicitante_rol: 'parent', auto_aprobada: false,
    fuera_de_tope: false, nota_administracion: null, creada_at, resuelta_at: null, ...extra,
});

function montar(habilitado = true) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><BandejaSolicitudesPlan schoolId={ESCUELA} habilitado={habilitado} /></QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe('BandejaSolicitudesPlan', () => {
    it('apagada: no pinta nada ni llama al BFF', async () => {
        const { container } = montar(false);
        await new Promise((r) => setTimeout(r, 20));
        expect(container.textContent).toBe('');
        expect(bff.get).not.toHaveBeenCalled();
    });

    it('vacía: explica qué va a aparecer', async () => {
        bff.get.mockResolvedValue({ solicitudes: [] });
        montar();
        expect(await screen.findByText(/Aún no hay solicitudes/)).toBeTruthy();
        expect(bff.get).toHaveBeenCalledWith(`/api/v1/plan-requests/escuela/${ESCUELA}`);
    });

    it('error: aviso con reintentar', async () => {
        bff.get.mockRejectedValue(new Error('boom'));
        montar();
        expect(await screen.findByRole('alert')).toBeTruthy();
    });

    it('mezcla las tres clases, por resolver primero con insignia, y filtra por tipo', async () => {
        bff.get.mockResolvedValue({ solicitudes: [
            sol('1', 'pausa', 'aprobado', '2026-11-03T10:00:00Z'),
            sol('2', 'retiro', 'solicitado', '2026-11-02T10:00:00Z'),
            sol('3', 'reactivacion', 'solicitado', '2026-11-01T10:00:00Z'),
        ] });
        montar();
        const t = await screen.findAllByTestId('solicitud');
        expect(t.map((x) => x.getAttribute('data-tipo'))).toEqual(['reactivacion', 'retiro', 'pausa']);
        expect(screen.getByLabelText('2 por resolver')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Retiro' }));
        expect(screen.getAllByTestId('solicitud')).toHaveLength(1);
    });

    it('muestra el aviso de pausa fuera de tope', async () => {
        bff.get.mockResolvedValue({ solicitudes: [sol('1', 'pausa', 'solicitado', '2026-11-03T10:00:00Z', { fuera_de_tope: true })] });
        montar();
        expect(await screen.findByText(/pasa el tope de meses/)).toBeTruthy();
    });

    it('retiro: «dar de baja» viene desmarcada y viaja false; marcada viaja true; avisa payments_a_revisar', async () => {
        bff.get.mockResolvedValue({ solicitudes: [sol('2', 'retiro', 'solicitado', '2026-11-02T10:00:00Z')] });
        bff.post.mockResolvedValue({ payments_a_revisar: 2 });
        montar();
        await userEvent.click(await screen.findByRole('button', { name: /^Aprobar retiro/ }));
        const casilla = await screen.findByRole('checkbox', { name: /Dar de baja completa/ });
        expect(casilla.getAttribute('aria-checked')).toBe('false');
        expect(screen.getByText(/TODAS las inscripciones/)).toBeTruthy();
        await userEvent.click(casilla);
        await userEvent.click(screen.getByRole('button', { name: 'Aprobar solicitud' }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith(`/api/v1/plan-requests/retiro/2/resolver`, { decision: 'aprobar', dar_de_baja: true }));
        expect(await screen.findByText(/2 cobros quedaron sin anular/)).toBeTruthy();
    });

    it('pausa: no hay casilla de baja y el cuerpo no lleva dar_de_baja', async () => {
        bff.get.mockResolvedValue({ solicitudes: [sol('1', 'pausa', 'solicitado', '2026-11-03T10:00:00Z')] });
        bff.post.mockResolvedValue({});
        montar();
        await userEvent.click(await screen.findByRole('button', { name: /^Aprobar pausa/ }));
        expect(screen.queryByRole('checkbox')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Aprobar solicitud' }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/plan-requests/pausa/1/resolver', { decision: 'aprobar' }));
    });

    it('rechazar un retiro no lleva dar_de_baja', async () => {
        bff.get.mockResolvedValue({ solicitudes: [sol('2', 'retiro', 'solicitado', '2026-11-02T10:00:00Z')] });
        bff.post.mockResolvedValue({});
        montar();
        await userEvent.click(await screen.findByRole('button', { name: /^Rechazar retiro/ }));
        expect(screen.queryByRole('checkbox')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Rechazar solicitud' }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/plan-requests/retiro/2/resolver', { decision: 'rechazar' }));
    });
});
