/**
 * WhatsApp › Seguimiento: pide los últimos 14 días; contadores arriba; una fila por
 * conversación (roja si espera > 2 h o tiene pendientes de la escuela); «solo sin
 * responder» vuelve a pedir; clic abre la conversación; «Descargar CSV» pide el
 * formato csv. BFF moqueado: no sale nada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const bff = vi.hoisted(() => ({ get: vi.fn(), getBlob: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { SeguimientoConversaciones } from './SeguimientoConversaciones';
import { haceCuanto, telefonoLegible, type FilaSeguimiento, type RespuestaSeguimiento } from './seguimientoModelo';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CLINICA = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';

const fila = (x: Partial<FilaSeguimiento> = {}): FilaSeguimiento => ({
    conversacionId: 'c-1',
    contacto: { nombre: 'Laura Pérez', telefono: '573124567890' },
    tipoContacto: 'desconocido',
    tema: { tipo: 'servicio', servicioId: CLINICA, nombre: 'Clínica de armadores y atacantes' },
    primerMensaje: { fecha: '2026-11-08T13:00:00Z', texto: '¿Cuánto cuesta la clínica?' },
    ultimoMensaje: { fecha: '2026-11-08T13:00:00Z', de: 'persona', texto: '¿Cuánto cuesta la clínica?' },
    mensajes: { persona: 1, escuela: 0, bot: 0 },
    respondioEscuela: false,
    respondioBot: false,
    esperandoDesde: '2026-11-08T13:00:00Z',
    esperandoMin: 300,
    datosDePagoEnviados: false,
    comprobanteRecibido: false,
    comprobantes: 0,
    comprobanteEstado: null,
    cobro: null,
    pendientesEscuela: [],
    alerta: true,
    tomada: false,
    ...x,
});

const respuesta = (x: Partial<RespuestaSeguimiento> = {}): RespuestaSeguimiento => ({
    rango: { desde: '2026-10-26', hasta: '2026-11-08' },
    servicios: [{ id: CLINICA, nombre: 'Clínica de armadores y atacantes' }],
    resumen: {
        escribieron: 2, respondioEscuela: 1, respondioBot: 1, nadieRespondio: 1, sinResponder: 1, esperandoMas2h: 1,
        conPendientes: 1, conDatosDePago: 1, conComprobante: 1, conCobro: 1,
    },
    filas: [
        fila({ pendientesEscuela: [{ texto: '¿Se puede ir solo el 22?', desde: '2026-11-08T12:00:00Z' }] }),
        fila({
            conversacionId: 'c-2', contacto: { nombre: 'Andrés', telefono: '573001112233' }, alerta: false,
            ultimoMensaje: { fecha: '2026-11-08T14:00:00Z', de: 'escuela', texto: 'Hola Andrés, te paso los datos' },
            respondioEscuela: true, esperandoDesde: null, esperandoMin: null, datosDePagoEnviados: true,
            comprobanteRecibido: true, comprobantes: 1, comprobanteEstado: 'Aplicado a un cobro',
            cobro: { monto: 300000, estado: 'awaiting_approval', tipo: 'clase_extra', concepto: 'Clínica de armadores', fecha: '2026-11-08T14:10:00Z', cuantos: 1 },
        }),
    ],
    avisos: [],
    ...x,
});

beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('SeguimientoConversaciones', () => {
    it('pide los últimos 14 días de la escuela', async () => {
        bff.get.mockResolvedValue(respuesta());
        render(<SeguimientoConversaciones schoolId={ESCUELA} />);
        await waitFor(() => expect(bff.get).toHaveBeenCalled());
        const url = String(bff.get.mock.calls[0][0]);
        expect(url).toMatch(new RegExp(`^/api/v1/whatsapp/${ESCUELA}/seguimiento\\?desde=\\d{4}-\\d{2}-\\d{2}&hasta=\\d{4}-\\d{2}-\\d{2}$`));
        const qs = new URLSearchParams(url.split('?')[1]);
        const dias = (Date.parse(qs.get('hasta')!) - Date.parse(qs.get('desde')!)) / 86_400_000 + 1;
        expect(dias).toBe(14);
    });

    it('contadores arriba y una fila por conversación, en rojo la que espera o tiene pendientes', async () => {
        bff.get.mockResolvedValue(respuesta());
        render(<SeguimientoConversaciones schoolId={ESCUELA} />);
        expect(await screen.findByText('Respondió la escuela')).toBeTruthy();
        expect(screen.getByText('Sin responder')).toBeTruthy();
        expect(screen.getByText('1 esperan > 2 h · 1 con pendientes')).toBeTruthy();

        const tabla = screen.getByRole('table');
        const filas = within(tabla).getAllByRole('row').slice(1);
        expect(filas).toHaveLength(2);
        expect(filas[0].getAttribute('data-alerta')).toBe('si');
        expect(filas[1].getAttribute('data-alerta')).toBe('no');
        expect(within(filas[0]).getByText('Laura Pérez')).toBeTruthy();
        expect(within(filas[0]).getByText('5 h')).toBeTruthy();
        expect(within(filas[0]).getByText(/¿Se puede ir solo el 22\?/)).toBeTruthy();
        expect(within(filas[1]).getByText('Escuela')).toBeTruthy();
        expect(within(filas[1]).getByText(/Por validar/)).toBeTruthy();
        expect(within(filas[1]).getByText(/Comprobante: Aplicado a un cobro/)).toBeTruthy();
        // El celular pinta las mismas conversaciones como tarjetas.
        expect(screen.getAllByText('Andrés').length).toBe(2);
    });

    it('«Solo sin responder» vuelve a pedir con el filtro', async () => {
        bff.get.mockResolvedValue(respuesta());
        render(<SeguimientoConversaciones schoolId={ESCUELA} />);
        await screen.findByRole('table');
        fireEvent.click(screen.getByRole('switch'));
        await waitFor(() => expect(bff.get).toHaveBeenCalledTimes(2));
        expect(String(bff.get.mock.calls[1][0])).toContain('soloSinResponder=1');
    });

    it('clic en una fila abre la conversación en el buzón', async () => {
        bff.get.mockResolvedValue(respuesta());
        const abrir = vi.fn();
        render(<SeguimientoConversaciones schoolId={ESCUELA} onAbrirConversacion={abrir} />);
        const tabla = await screen.findByRole('table');
        fireEvent.click(within(tabla).getByRole('button', { name: /Abrir la conversación con Andrés/ }));
        expect(abrir).toHaveBeenCalledWith('c-2');
    });

    it('«Descargar CSV» pide el formato csv con los mismos filtros', async () => {
        bff.get.mockResolvedValue(respuesta());
        bff.getBlob.mockResolvedValue(new Blob(['﻿Contacto;Teléfono'], { type: 'text/csv' }));
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
        render(<SeguimientoConversaciones schoolId={ESCUELA} />);
        await screen.findByRole('table');
        fireEvent.click(screen.getByRole('button', { name: /Descargar CSV/ }));
        await waitFor(() => expect(bff.getBlob).toHaveBeenCalled());
        expect(String(bff.getBlob.mock.calls[0][0])).toMatch(/\/seguimiento\?desde=.*&formato=csv$/);
    });

    it('sin conversaciones: el vacío explica qué va a aparecer', async () => {
        bff.get.mockResolvedValue(respuesta({ filas: [], resumen: { ...respuesta().resumen, escribieron: 0 } }));
        render(<SeguimientoConversaciones schoolId={ESCUELA} />);
        expect(await screen.findByText('Nadie escribió en estas fechas.')).toBeTruthy();
        expect(screen.queryByRole('table')).toBeNull();
    });

    it('error del BFF: aviso en palabras de la escuela y reintentar', async () => {
        bff.get.mockRejectedValue(new Error('rango_demasiado_largo'));
        render(<SeguimientoConversaciones schoolId={ESCUELA} />);
        expect(await screen.findByText('El rango puede tener hasta 31 días.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    });
});

describe('seguimientoModelo', () => {
    it('haceCuanto y telefonoLegible', () => {
        expect(haceCuanto(45)).toBe('45 min');
        expect(haceCuanto(300)).toBe('5 h');
        expect(haceCuanto(60 * 72)).toBe('3 días');
        expect(haceCuanto(null)).toBe('');
        expect(telefonoLegible('573124567890')).toBe('+57 312 456 7890');
    });
});
