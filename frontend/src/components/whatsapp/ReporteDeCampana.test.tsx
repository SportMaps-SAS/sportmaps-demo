/**
 * WhatsApp › Campañas › Reporte (F0.5): números arriba, lo que falta por salir
 * con fechas, no enviados con motivo, fallidos con qué hacer y quién lo corrige,
 * y el freno. Y el botón «Ver reporte» de la tarjeta. BFF moqueado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { ReporteDeCampana, etiquetaDeQuien, type ReporteCampana } from './ReporteDeCampana';
import { Campanas, campanaDelEnlace } from './Campanas';

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CAMP = '11111111-1111-4111-8111-111111111111';

const reporte = (x: Partial<ReporteCampana> = {}): ReporteCampana => ({
    campana: { id: CAMP, nombre: 'Clínica de diciembre', plantilla: 'monster_clinica', estado: 'enviando', aprobada_at: '2026-11-17T12:00:00Z', vence_at: null, pausa_motivo: null, servicio_id: 'serv-1' },
    generado_at: '2026-11-17T15:00:00Z',
    resumen: {
        destinatarios: 120, enviados: 48, entregados: 45, leidos: 30,
        respondieron: { si: 9, luego: 4, total: 13 }, bajas_promos: 2, pagaron: { cantidad: 3, desde: '2026-11-17T12:00:00Z', hasta: '2026-11-17T15:00:00Z' },
    },
    por_salir: {
        total: 62, en_horario_ahora: true, proxima_ventana_at: '2026-11-17T15:00:00Z', nota: null,
        grupos: [
            { motivo: 'en_fila', texto: 'En fila: salen de a poco, según el cupo de cada día', cantidad: 50, sale_desde_at: '2026-11-17T15:00:00Z', sale_hasta_at: null, cuando: 'Hoy, de a poco y en horario de envío', despues_de_vencer: false },
            { motivo: 'frecuencia', texto: 'Ya recibieron otra campaña tuya hace poco: esperan los días mínimos entre una campaña y otra', cantidad: 12, sale_desde_at: '2026-11-23T12:00:00Z', sale_hasta_at: null, cuando: 'Desde el lunes 23 de noviembre, 7:00 a. m.', despues_de_vencer: false },
        ],
    },
    no_enviados: {
        total: 5,
        grupos: [
            { motivo: 'ya_compro', texto: 'Ya pagaron o abonaron lo que ofrece esta campaña', que_hacer: 'No tienes que hacer nada.', quien: 'escuela', requiere_accion: false, cantidad: 3 },
            { motivo: 'marca_manual', texto: 'Están marcados como familia', que_hacer: 'Cámbiale la marca desde el chat.', quien: 'escuela', requiere_accion: true, cantidad: 2 },
        ],
    },
    fallidos: {
        total: 4,
        grupos: [
            { clave: 'meta_131026', codigo: 131026, texto: 'El mensaje no se pudo entregar a ese número', que_hacer: 'Revisa el número del contacto.', quien: 'escuela', requiere_accion: true, cantidad: 3 },
            { clave: 'meta_190', codigo: 190, texto: 'Se venció el permiso que conecta tu número con SportMaps', que_hacer: 'El equipo de SportMaps ya recibió el aviso.', quien: 'sportmaps', requiere_accion: false, cantidad: 1 },
        ],
    },
    inciertos: { cantidad: 1, texto: 'No sabemos si salieron: el envío se interrumpió a la mitad', que_hacer: 'No se reenvían.', quien: 'sportmaps' },
    freno: {
        enviados_24h: 50, bajas_24h: 2, fallidos_24h: 4, bajas_que_faltan: 3, fallos_que_faltan: 8, en_el_limite: false,
        texto: 'En las últimas 24 horas salieron 50 mensajes de campaña desde tu número.',
    },
    lista_de_espera: null,
    ...x,
});

const abrir = () => render(<ReporteDeCampana schoolId={ESC} campanaId={CAMP} nombre="Clínica de diciembre" abierto onCerrar={() => undefined} />);

beforeEach(() => {
    vi.clearAllMocks();
});

describe('puras', () => {
    it('la etiqueta dice quién lo corrige, o que no hay nada que hacer', () => {
        expect(etiquetaDeQuien({ quien: 'escuela', requiere_accion: true })).toBe('Lo puedes corregir tú');
        expect(etiquetaDeQuien({ quien: 'escuela', requiere_accion: false })).toBe('No tienes que hacer nada');
        expect(etiquetaDeQuien({ quien: 'sportmaps' })).toBe('Lo revisa SportMaps');
    });
    it('el enlace ?campana=<id> solo vale si es un uuid', () => {
        expect(campanaDelEnlace(`?tab=campanas&campana=${CAMP}`)).toBe(CAMP);
        expect(campanaDelEnlace('?tab=campanas&campana=<script>')).toBeNull();
        expect(campanaDelEnlace('?tab=campanas')).toBeNull();
    });
});

describe('ReporteDeCampana', () => {
    it('pide el reporte de ESA campaña y pinta los números grandes', async () => {
        bff.get.mockResolvedValue(reporte());
        abrir();
        await screen.findByText('Reporte de «Clínica de diciembre»');
        expect(bff.get).toHaveBeenCalledWith(`/api/v1/whatsapp/${ESC}/campanas/${CAMP}/reporte`);
        await waitFor(() => expect(screen.getByTestId('num-enviados')).toHaveTextContent('48'));
        expect(screen.getByTestId('num-destinatarios')).toHaveTextContent('120');
        expect(screen.getByTestId('num-entregados')).toHaveTextContent('45');
        expect(screen.getByTestId('num-leidos')).toHaveTextContent('30');
        expect(screen.getByTestId('num-respondieron')).toHaveTextContent('13');
        expect(screen.getByTestId('num-respondieron')).toHaveTextContent('Sí: 9 · Más adelante: 4');
        expect(screen.getByTestId('num-pagaron')).toHaveTextContent('3');
        expect(screen.getByTestId('num-bajas')).toHaveTextContent('2');
    });

    it('lo que falta por salir, con la fecha', async () => {
        bff.get.mockResolvedValue(reporte());
        abrir();
        const sec = await screen.findByTestId('sec-por-salir');
        expect(sec).toHaveTextContent('62');
        expect(sec).toHaveTextContent('Cuándo: Hoy, de a poco y en horario de envío.');
        expect(sec).toHaveTextContent('Cuándo: Desde el lunes 23 de noviembre, 7:00 a. m..');
        expect(sec).toHaveTextContent('Nunca en domingos ni festivos');
    });

    it('no enviados y fallidos: motivo, qué hacer y la etiqueta de quién lo corrige', async () => {
        bff.get.mockResolvedValue(reporte());
        abrir();
        const no = await screen.findByTestId('sec-no-enviados');
        expect(no).toHaveTextContent('Ya pagaron o abonaron lo que ofrece esta campaña');
        expect(within(no).getByText('No tienes que hacer nada')).toBeInTheDocument();
        expect(within(no).getByText('Lo puedes corregir tú')).toBeInTheDocument();

        const fallaron = screen.getByTestId('sec-fallaron');
        expect(fallaron).toHaveTextContent('5'); // 4 fallidos + 1 incierto
        expect(fallaron).toHaveTextContent('Qué hacer: Revisa el número del contacto.');
        expect(fallaron).toHaveTextContent('Código de Meta: 131026');
        expect(within(fallaron).getAllByText('Lo revisa SportMaps')).toHaveLength(2); // el token y los inciertos
        expect(within(fallaron).getAllByText('Lo puedes corregir tú')).toHaveLength(1);
        expect(fallaron).toHaveTextContent('No sabemos si salieron');
    });

    it('qué tan cerca del freno', async () => {
        bff.get.mockResolvedValue(reporte());
        abrir();
        const freno = await screen.findByTestId('sec-freno');
        expect(freno).toHaveTextContent('En las últimas 24 horas salieron 50 mensajes');
        expect(screen.getByTestId('num-bajas-faltan')).toHaveTextContent('3');
        expect(screen.getByTestId('num-fallos-faltan')).toHaveTextContent('8');
    });

    it('sin dato: entregados, leídos y pagaron muestran «—», no cero; sin servicio no hay «pagaron»', async () => {
        bff.get.mockResolvedValue(reporte({
            resumen: { destinatarios: 10, enviados: 4, entregados: null, leidos: null, respondieron: { si: 0, luego: 0, total: 0 }, bajas_promos: 0, pagaron: null },
            freno: null,
        }));
        abrir();
        await waitFor(() => expect(screen.getByTestId('num-entregados')).toHaveTextContent('—'));
        expect(screen.getByTestId('num-entregados')).toHaveTextContent('Sin dato todavía');
        expect(screen.getByTestId('num-pagaron')).toHaveTextContent('—');
        expect(screen.getByTestId('sec-freno')).toHaveTextContent('No pudimos leer este dato ahora.');

        bff.get.mockResolvedValue(reporte({ campana: { ...reporte().campana, servicio_id: null } }));
        fireEvent.click(screen.getByRole('button', { name: /Actualizar/ }));
        await waitFor(() => expect(screen.queryByTestId('num-pagaron')).not.toBeInTheDocument());
    });

    it('todo en cero: lo dice en palabras', async () => {
        bff.get.mockResolvedValue(reporte({
            por_salir: { total: 0, en_horario_ahora: true, proxima_ventana_at: '2026-11-17T15:00:00Z', nota: null, grupos: [] },
            no_enviados: { total: 0, grupos: [] },
            fallidos: { total: 0, grupos: [] },
            inciertos: { cantidad: 0, texto: '', que_hacer: '', quien: 'sportmaps' },
        }));
        abrir();
        expect(await screen.findByText('No queda nada por salir.')).toBeInTheDocument();
        expect(screen.getByText('A nadie de la lista se le dejó de enviar.')).toBeInTheDocument();
        expect(screen.getByText('Ningún mensaje ha fallado.')).toBeInTheDocument();
    });

    it('campaña en pausa: la nota va en lo que falta por salir', async () => {
        bff.get.mockResolvedValue(reporte({
            por_salir: { ...reporte().por_salir, nota: 'La campaña está en pausa: nada sale hasta que la reanudes.' },
        }));
        abrir();
        expect(await screen.findByText('La campaña está en pausa: nada sale hasta que la reanudes.')).toBeInTheDocument();
    });

    it('si el BFF falla: un mensaje y «Reintentar»', async () => {
        bff.get.mockRejectedValueOnce(new Error('500'));
        abrir();
        fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
        bff.get.mockResolvedValue(reporte());
        await waitFor(() => expect(screen.getByTestId('num-enviados')).toHaveTextContent('48'));
        expect(bff.get).toHaveBeenCalledTimes(2);
    });
});

describe('Campanas › botón «Ver reporte»', () => {
    const avance = { total: 10, pendiente: 6, enviando: 0, enviado: 4, incierto: 0, fallido: 0, omitido: 0, respondio_si: 0, respondio_luego: 0, baja: 0 };
    const campana = (id: string, estado: string) => ({
        id, nombre: `Campaña ${estado}`, plantilla: 'monster_cierre_2026', estado, filtro: {}, respuesta_si: null,
        destinatarios: 10, aprobada_at: estado === 'borrador' ? null : '2026-11-17T12:00:00Z', vence_at: null, pausa_motivo: null,
        conteo_previsto: estado === 'borrador' ? 10 : null, avance: estado === 'borrador' ? null : avance,
    });
    const resumen = {
        disponible: true, habilitadas: true, integracion: 'ok',
        ajustes: { base_consentimiento: 'contacto_previo_declarado', tope_diario: 200, lote_piloto: 50, pausada: false, pausa_motivo: null },
        audiencia: { total: 10, porInteres: {}, porSede: {} }, sedes: [], plantillas: [], declaracion: null,
        campanas: [campana('c-borrador', 'borrador'), campana('c-enviando', 'enviando'), campana('c-pausada', 'pausada'),
            campana('c-terminada', 'terminada'), campana('c-cancelada', 'cancelada')],
    };

    it('sale en las campañas aprobadas, en curso, en pausa y terminadas; no en borradores ni canceladas', async () => {
        bff.get.mockImplementation(async (url: string) => (url.endsWith('/reporte') ? reporte() : resumen));
        render(<Campanas schoolId={ESC} />);
        await screen.findByTestId('campana-c-enviando');
        for (const id of ['c-enviando', 'c-pausada', 'c-terminada']) {
            expect(within(screen.getByTestId(`campana-${id}`)).getByRole('button', { name: /Ver reporte/ })).toBeInTheDocument();
        }
        for (const id of ['c-borrador', 'c-cancelada']) {
            expect(within(screen.getByTestId(`campana-${id}`)).queryByRole('button', { name: /Ver reporte/ })).not.toBeInTheDocument();
        }
    });

    it('al tocarlo abre el reporte de esa campaña', async () => {
        bff.get.mockImplementation(async (url: string) => (url.endsWith('/reporte') ? reporte() : resumen));
        render(<Campanas schoolId={ESC} />);
        fireEvent.click(within(await screen.findByTestId('campana-c-terminada')).getByRole('button', { name: /Ver reporte/ }));
        await waitFor(() => expect(bff.get).toHaveBeenCalledWith(`/api/v1/whatsapp/${ESC}/campanas/c-terminada/reporte`));
        expect(await screen.findByTestId('sec-freno')).toBeInTheDocument();
    });
});
