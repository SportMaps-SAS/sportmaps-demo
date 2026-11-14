/**
 * WhatsApp › Anuncios: sin la migración = aviso; sin conversaciones = vacío
 * explicativo; con datos = totales, una fila por anuncio con % y recaudo, y el
 * aviso del historial del celular. BFF moqueado: no sale nada.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const bff = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { Anuncios } from './Anuncios';
import { FILA_VACIA, type ResumenAnuncios } from './anunciosModelo';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';

const resumen = (x: Partial<ResumenAnuncios> = {}): ResumenAnuncios => ({
    disponible: true,
    rango: { desde: '2026-10-06', hasta: '2026-11-04' },
    sede: null,
    sedes: [{ id: 'B1', nombre: 'Suba' }],
    servicios: [{ id: 'S1', nombre: 'Clínica de diciembre', tipo: 'clase_extra', activo: true }],
    mapeos: [],
    anuncios: [],
    total: { ...FILA_VACIA },
    ...x,
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe('Anuncios', () => {
    it('pide el embudo de la escuela con el rango de los últimos 30 días', async () => {
        bff.get.mockResolvedValue(resumen());
        render(<Anuncios schoolId={ESCUELA} />);
        await waitFor(() => expect(bff.get).toHaveBeenCalled());
        expect(bff.get.mock.calls[0][0]).toMatch(new RegExp(`^/api/v1/whatsapp/${ESCUELA}/anuncios\\?desde=\\d{4}-\\d{2}-\\d{2}&hasta=\\d{4}-\\d{2}-\\d{2}$`));
    });

    it('sin la migración: aviso, sin tabla', async () => {
        bff.get.mockResolvedValue({ disponible: false });
        render(<Anuncios schoolId={ESCUELA} />);
        expect(await screen.findByText(/todavía no está activo/)).toBeTruthy();
    });

    it('sin conversaciones: el vacío explica qué va a aparecer', async () => {
        bff.get.mockResolvedValue(resumen());
        render(<Anuncios schoolId={ESCUELA} />);
        expect(await screen.findByText('Aún no hay conversaciones que lleguen de anuncios en estas fechas.')).toBeTruthy();
        expect(screen.queryByText('Por anuncio')).toBeNull();
    });

    it('con datos: totales, fila por anuncio con % y recaudo, y el aviso del historial', async () => {
        const anuncio = {
            ...FILA_VACIA, source_id: '120251275521150783', source_type: 'ad', headline: 'Aparta tu cupo ya mismo',
            source_url: 'https://www.instagram.com/p/DfTBcHIs92j/',
            conversaciones: 4, de_historial: 1, contestaron: 2, separaron_o_agendaron: 1, pagaron: 1, monto: 100000,
            pagos_por_motivo: [{ motivo: 'clase_extra', servicio_id: 'S1', servicio: 'Clínica de diciembre', conversaciones: 1, pagos: 1, monto: 100000 }],
        };
        bff.get.mockResolvedValue(resumen({
            anuncios: [anuncio],
            total: { ...anuncio, source_id: null, headline: null },
            mapeos: [{ source_id: '120251275521150783', destino: 'servicio', servicio_id: 'S1', nota: null, updated_at: null }],
        }));
        render(<Anuncios schoolId={ESCUELA} />);
        expect(await screen.findByText('Por anuncio')).toBeTruthy();
        // Escritorio y celular pintan el mismo anuncio.
        expect(screen.getAllByText('Aparta tu cupo ya mismo').length).toBeGreaterThan(0);
        expect(screen.getByText(/1 de estas 4 conversaciones llegaron antes de conectar/)).toBeTruthy();
        const tabla = screen.getByRole('table');
        const fila = within(tabla).getAllByRole('row')[1];
        expect(within(fila).getByText('50 %')).toBeTruthy();          // contestaron 2 de 4
        expect(within(fila).getAllByText('25 %').length).toBe(2);     // separaron y pagaron 1 de 4
        expect(within(fila).getByText(/Clínica de diciembre: 1/)).toBeTruthy();
        // El selector muestra el destino guardado.
        expect(within(fila).getByRole('combobox', { name: 'Este anuncio va a' }).textContent).toContain('Clínica de diciembre');
    });

    it('si el BFF falla: mensaje y reintentar', async () => {
        bff.get.mockRejectedValue(new Error('Error 500'));
        render(<Anuncios schoolId={ESCUELA} />);
        expect(await screen.findByText('No se pudo cargar el embudo de anuncios')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    });
});
