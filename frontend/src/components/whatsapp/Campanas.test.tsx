/**
 * WhatsApp › Campañas (plan B5 T5): apagadas = un aviso; borrador = «Lista: N
 * personas · Aprobar y enviar» con la declaración; en curso = avance y Pausar;
 * en pausa = el motivo y Reanudar. BFF moqueado: no sale nada.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { Campanas, enviadosDe, motivoDePausa, type ResumenCampanas } from './Campanas';

const avance = (x: Partial<Record<string, number>> = {}) => ({
    total: 0, pendiente: 0, enviando: 0, enviado: 0, incierto: 0, fallido: 0, omitido: 0,
    respondio_si: 0, respondio_luego: 0, baja: 0, ...x,
});

const encendidas = (campanas: any[], extra: Partial<ResumenCampanas> = {}): ResumenCampanas => ({
    disponible: true, habilitadas: true, integracion: 'ok',
    ajustes: { base_consentimiento: 'contacto_previo_declarado', tope_diario: 200, lote_piloto: 50, pausada: false, pausa_motivo: null },
    audiencia: { total: 120, porInteres: { clase_prueba: 70, clinica: 50 }, porSede: {} },
    sedes: [],
    plantillas: [{ nombre: 'monster_cierre_2026', idioma: 'es_CO', estado: 'APPROVED', lista: true, motivo: null, texto: '¡Hola {{1}}!', botones: [] }],
    declaracion: { version: 'contacto_previo_v1', texto: 'Declaro que las personas de esta lista le escribieron a Monster…' },
    campanas,
    ...extra,
});

const borrador = {
    id: 'c1', nombre: 'Cierre 2026', plantilla: 'monster_cierre_2026', estado: 'borrador', filtro: {},
    respuesta_si: null, destinatarios: null, aprobada_at: null, vence_at: null, pausa_motivo: null,
    conteo_previsto: 120, avance: null,
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('puras', () => {
    it('enviados cuenta lo que salió, con o sin respuesta', () => {
        expect(enviadosDe(avance({ enviado: 3, respondio_si: 2, respondio_luego: 1, baja: 1, pendiente: 9, fallido: 4 }))).toBe(7);
        expect(enviadosDe(null)).toBe(0);
    });
    it('el motivo de pausa en palabras de la escuela', () => {
        expect(motivoDePausa('calidad_del_numero')).toBe('Meta bajó la calidad de tu número');
        expect(motivoDePausa('raro')).toBe('revisa la campaña');
    });
});

describe('Campanas', () => {
    it('apagadas: un aviso y nada más', async () => {
        bff.get.mockResolvedValue({ disponible: true, habilitadas: false });
        render(<Campanas schoolId="s1" />);
        expect(await screen.findByText(/apagadas para tu escuela/)).toBeTruthy();
        expect(screen.queryByText(/Aprobar y enviar/)).toBeNull();
        expect(bff.get).toHaveBeenCalledWith('/api/v1/whatsapp/s1/campanas');
    });

    it('borrador: «Lista: 120 personas»; aprobar exige la declaración y manda declaracion_aceptada', async () => {
        bff.get.mockResolvedValue(encendidas([borrador]));
        bff.post.mockResolvedValue({ destinatarios: 120 });
        render(<Campanas schoolId="s1" />);
        expect(await screen.findByText('Lista: 120 personas')).toBeTruthy();
        expect(screen.getByText(/120 personas te escribieron/)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Aprobar y enviar' }));
        const enviar = screen.getByRole('button', { name: /Aprobar y enviar a 120 personas/ }) as HTMLButtonElement;
        expect(enviar.disabled).toBe(true);
        fireEvent.click(screen.getByLabelText('Confirmo la declaración'));
        expect(enviar.disabled).toBe(false);
        fireEvent.click(enviar);
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/whatsapp/s1/campanas/c1/aprobar', { declaracion_aceptada: true }));
        await waitFor(() => expect(toastEstable.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Aprobada para 120 personas' })));
    });

    it('con base de opt-in no hay declaración que aceptar', async () => {
        bff.get.mockResolvedValue(encendidas([borrador], { declaracion: null }));
        bff.post.mockResolvedValue({ destinatarios: 120 });
        render(<Campanas schoolId="s1" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Aprobar y enviar' }));
        expect(screen.queryByLabelText('Confirmo la declaración')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Aprobar y enviar a 120 personas/ }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/whatsapp/s1/campanas/c1/aprobar', { declaracion_aceptada: false }));
    });

    it('en curso: avance, respuestas y Pausar', async () => {
        bff.get.mockResolvedValue(encendidas([{
            ...borrador, estado: 'enviando', conteo_previsto: null, destinatarios: 120,
            avance: avance({ total: 120, enviado: 40, respondio_si: 6, respondio_luego: 3, baja: 1, pendiente: 70 }),
        }]));
        bff.post.mockResolvedValue({});
        render(<Campanas schoolId="s1" />);
        expect(await screen.findByText('Enviados 50 de 120')).toBeTruthy();
        expect(screen.getByText('70 por enviar')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Pausar/ }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/whatsapp/s1/campanas/c1/pausar', {}));
    });

    it('en pausa por el freno: el motivo y Reanudar', async () => {
        bff.get.mockResolvedValue(encendidas([{
            ...borrador, estado: 'pausada', pausa_motivo: 'numero_marcado', conteo_previsto: null, destinatarios: 120,
            avance: avance({ total: 120, enviado: 20 }),
        }], { ajustes: { base_consentimiento: 'contacto_previo_declarado', tope_diario: 200, lote_piloto: 50, pausada: true, pausa_motivo: 'numero_marcado' } }));
        bff.post.mockResolvedValue({});
        render(<Campanas schoolId="s1" />);
        expect(await screen.findByText(/Tus campañas están en pausa/)).toBeTruthy();
        expect(screen.getAllByText(/Meta marcó tu número/).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: /Reanudar/ }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/whatsapp/s1/campanas/c1/reanudar', {}));
    });

    it('crear: nombre, mensaje aprobado e intereses', async () => {
        bff.get.mockResolvedValue(encendidas([]));
        bff.post.mockResolvedValue({ campana: { id: 'n1' } });
        render(<Campanas schoolId="s1" />);
        fireEvent.click(await screen.findByRole('button', { name: /Nueva campaña/ }));
        fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Clínica noviembre' } });
        fireEvent.change(screen.getByLabelText(/Mensaje/), { target: { value: 'monster_cierre_2026' } });
        fireEvent.click(screen.getByRole('button', { name: 'Clínica / vacacional' }));
        fireEvent.click(screen.getByRole('button', { name: 'Crear borrador' }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/whatsapp/s1/campanas', {
            nombre: 'Clínica noviembre', plantilla: 'monster_cierre_2026', filtro: { intereses: ['clinica'] }, respuesta_si: null,
        }));
    });
});
