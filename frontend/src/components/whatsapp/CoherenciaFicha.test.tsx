/**
 * WhatsApp › Configuración: aviso amarillo con las contradicciones del texto del
 * asistente contra el catálogo (frente B del blindaje de ventas, 2026-11-08).
 * BFF moqueado: no sale nada.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const bff = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));

import { CoherenciaFicha, type ContradiccionFicha } from './CoherenciaFicha';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const C1: ContradiccionFicha = {
    fuente: 'ficha', linea: 51, dice: 'Preventa: $300.000 hasta el 9 de noviembre', servicioId: 'S1',
    servicio: 'Clínica de armadores y atacantes', tipo: 'fecha_de_precio',
    catalogo: 'hasta el martes 10 de noviembre ($300.000; desde el miércoles 11 de noviembre, $350.000)',
    mensaje: 'Tu texto para el asistente dice “Preventa: $300.000 hasta el 9 de noviembre”; el catálogo de Clínica de armadores y atacantes dice hasta el martes 10 de noviembre ($300.000; desde el miércoles 11 de noviembre, $350.000).',
};
const C2: ContradiccionFicha = {
    ...C1, linea: 52, dice: 'Desde el 10 de noviembre: $350.000',
    mensaje: 'Tu texto para el asistente dice “Desde el 10 de noviembre: $350.000”; el catálogo de Clínica de armadores y atacantes dice desde el miércoles 11 de noviembre, $350.000 (hasta el martes 10 de noviembre, $300.000).',
};

beforeEach(() => vi.clearAllMocks());

describe('CoherenciaFicha', () => {
    it('una línea por contradicción, con el texto que devuelve el BFF', async () => {
        bff.get.mockResolvedValue({ servicios: 2, ficha: true, contradicciones: [C1, C2] });
        render(<CoherenciaFicha schoolId={ESCUELA} />);
        expect(await screen.findByText('Tu texto para el asistente no coincide con tu catálogo')).toBeTruthy();
        expect(screen.getByText(C1.mensaje)).toBeTruthy();
        expect(screen.getByText(C2.mensaje)).toBeTruthy();
        expect(bff.get).toHaveBeenCalledWith(`/api/v1/whatsapp/${ESCUELA}/coherencia-ficha`);
    });

    it('sin contradicciones no muestra nada', async () => {
        bff.get.mockResolvedValue({ servicios: 2, ficha: true, contradicciones: [] });
        const { container } = render(<CoherenciaFicha schoolId={ESCUELA} />);
        await waitFor(() => expect(bff.get).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
    });

    it('si la llamada falla (p. ej. 403 de un coach) no muestra nada', async () => {
        bff.get.mockRejectedValue(new Error('403'));
        const { container } = render(<CoherenciaFicha schoolId={ESCUELA} />);
        await waitFor(() => expect(bff.get).toHaveBeenCalled());
        expect(screen.queryByTestId('coherencia-ficha')).toBeNull();
        expect(container.innerHTML).toBe('');
    });
});
