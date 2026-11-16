/**
 * WhatsApp › Precios: la escuela ve y edita los valores que el bot usa para
 * reconocer pagos y responder precios. BFF moqueado (contrato de
 * `/:schoolId/precios`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { PreciosDelBot, leerMonto, marcasDe, pesos, type PreciosBot } from './PreciosDelBot';

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const BASE = `/api/v1/whatsapp/${ESC}/precios`;

const precios = (x: Partial<PreciosBot> = {}): PreciosBot => ({
    interruptores: { responde_precios: true, cobra_desde_comprobante: true },
    mensualidades: [
        { plan_id: 'p1', nombre: 'Formativo 2 días', precio: 310000 },
        { plan_id: 'p2', nombre: 'Becados', precio: 0 },
    ],
    matricula: { valor: 120000, valores_distintos: [120000], planes: 2 },
    clase_prueba: { valor: 25000, habilitada: true },
    articulos: [
        { id: 'a1', nombre: 'Uniforme', precio: 85000, activo: true },
        { id: 'a2', nombre: 'Balón viejo', precio: 60000, activo: false },
    ],
    servicios: [{
        id: 's1', nombre: 'Clínica de diciembre', tipo: 'clinica', precio: null, precio_afiliado: null, activo: true, vende_por_whatsapp: true,
        opciones: [{ clave: 'dia', etiqueta: 'Un día', precio: 90000, precio_afiliado: 70000 }],
    }],
    avisos: [],
    ...x,
});

const abrir = () => render(<MemoryRouter><PreciosDelBot schoolId={ESC} /></MemoryRouter>);

beforeEach(() => {
    vi.clearAllMocks();
});

describe('puras', () => {
    it('pesos: punto de miles y sin centavos', () => {
        expect(pesos(310000)).toBe('$310.000');
        expect(pesos(1250000)).toBe('$1.250.000');
        expect(pesos(900)).toBe('$900');
        expect(pesos(null)).toBe('Sin valor');
    });
    it('leerMonto acepta «310000», «310.000» y «$ 310.000»; vacío es sin valor', () => {
        expect(leerMonto('310000')).toBe(310000);
        expect(leerMonto('310.000')).toBe(310000);
        expect(leerMonto('$ 310.000')).toBe(310000);
        expect(leerMonto('1.250.000,00')).toBe(1250000);
        expect(leerMonto('  ')).toBeNull();
        expect(leerMonto('trescientos')).toBeUndefined();
        expect(leerMonto('31.00')).toBeUndefined();
    });
    it('las marcas dependen de los interruptores, del valor y de si está activo', () => {
        const prendidos = { responde_precios: true, cobra_desde_comprobante: true };
        expect(marcasDe({ tieneValor: true, interruptores: prendidos })).toEqual({
            reconoce: { si: true, texto: 'Lo reconoce en comprobantes' }, dice: { si: true, texto: 'Lo dice al responder' },
        });
        const sinValor = marcasDe({ tieneValor: false, interruptores: prendidos });
        expect(sinValor.reconoce).toEqual({ si: false, texto: 'No lo reconoce en comprobantes: no tiene valor' });
        expect(sinValor.dice.si).toBe(false);
        const apagado = marcasDe({ tieneValor: true, interruptores: { responde_precios: false, cobra_desde_comprobante: true } });
        expect(apagado.reconoce.si).toBe(true);
        expect(apagado.dice).toEqual({ si: false, texto: 'No lo dice al responder: lo apagaste arriba' });
        expect(marcasDe({ tieneValor: true, activo: false, interruptores: prendidos }).reconoce.texto).toContain('está desactivado');
        expect(marcasDe({ tieneValor: true, seOfrece: false, interruptores: prendidos })).toMatchObject({
            reconoce: { si: true }, dice: { si: false, texto: 'No lo dice al responder: no se vende por WhatsApp' },
        });
    });
});

describe('PreciosDelBot', () => {
    it('carga los precios de ESA escuela y pinta cada sección con sus montos', async () => {
        bff.get.mockResolvedValue(precios());
        abrir();
        expect(screen.getByRole('status')).toHaveTextContent('Cargando tus precios');
        const plan = await screen.findByTestId('plan-p1');
        expect(bff.get).toHaveBeenCalledWith(BASE);
        expect(plan).toHaveTextContent('Formativo 2 días');
        expect(plan).toHaveTextContent('$310.000');
        expect(plan).toHaveTextContent('Lo reconoce en comprobantes');
        expect(screen.getByTestId('plan-p2')).toHaveTextContent('No lo reconoce en comprobantes: no tiene valor');
        expect(screen.getByLabelText('Valor de la matrícula')).toHaveValue('120.000');
        expect(screen.getByLabelText('Valor de la clase de prueba')).toHaveValue('25.000');
        expect(screen.getByTestId('articulo-a1')).toHaveTextContent('$85.000');
        expect(screen.getByTestId('articulo-a2')).toHaveTextContent('Desactivado');
        expect(screen.getByTestId('articulo-a2')).toHaveTextContent('No lo dice al responder: está desactivado');
        const servicio = screen.getByTestId('servicio-s1');
        expect(servicio).toHaveTextContent('Según la opción');
        expect(servicio).toHaveTextContent('Un día');
        expect(servicio).toHaveTextContent('$90.000 · de la escuela: $70.000');
        expect(screen.getByRole('link', { name: /Editar en Equipos y Planes/ })).toHaveAttribute('href', '/offerings');
        expect(screen.getByRole('link', { name: /Editar en Finanzas › Pagos/ })).toHaveAttribute('href', '/payments-automation');
    });

    it('los avisos del BFF salen como alertas', async () => {
        bff.get.mockResolvedValue(precios({ avisos: [{ clave: 'montos_repetidos', texto: 'Dos de tus planes cuestan lo mismo: el bot te va a preguntar cuál es.' }] }));
        abrir();
        const aviso = await screen.findByTestId('aviso-montos_repetidos');
        expect(aviso).toHaveAttribute('role', 'alert');
        expect(aviso).toHaveTextContent('Dos de tus planes cuestan lo mismo');
    });

    it('matrícula: acepta «150.000», lo guarda como número y pinta lo que devuelve el BFF', async () => {
        bff.get.mockResolvedValue(precios());
        bff.put.mockResolvedValue(precios({ matricula: { valor: 150000, valores_distintos: [150000], planes: 2 } }));
        abrir();
        const campo = await screen.findByLabelText('Valor de la matrícula');
        const guardar = within(screen.getByTestId('sec-matricula')).getByRole('button', { name: 'Guardar' });
        expect(guardar).toBeDisabled(); // nada cambió todavía
        fireEvent.change(campo, { target: { value: '150.000' } });
        fireEvent.click(guardar);
        await waitFor(() => expect(bff.put).toHaveBeenCalledWith(`${BASE}/matricula`, { valor: 150000 }));
        await waitFor(() => expect(toastEstable.toast).toHaveBeenCalledWith({ title: 'Matrícula guardada' }));
        expect(campo).toHaveValue('150.000');
        expect(bff.get).toHaveBeenCalledTimes(1); // la respuesta ya trae todo: no se vuelve a pedir
    });

    it('matrícula: vacío se guarda como «sin valor» y un texto que no es número no se envía', async () => {
        bff.get.mockResolvedValue(precios());
        bff.put.mockResolvedValue(precios({ matricula: { valor: null, valores_distintos: [], planes: 2 } }));
        abrir();
        const campo = await screen.findByLabelText('Valor de la matrícula');
        const seccion = screen.getByTestId('sec-matricula');
        fireEvent.change(campo, { target: { value: 'ciento veinte' } });
        fireEvent.submit(campo.closest('form')!);
        expect(await within(seccion).findByRole('alert')).toHaveTextContent('Escribe solo el número');
        expect(bff.put).not.toHaveBeenCalled();
        fireEvent.change(campo, { target: { value: '' } });
        fireEvent.click(within(seccion).getByRole('button', { name: 'Guardar' }));
        await waitFor(() => expect(bff.put).toHaveBeenCalledWith(`${BASE}/matricula`, { valor: null }));
        await waitFor(() => expect(seccion).toHaveTextContent('No lo reconoce en comprobantes: no tiene valor'));
    });

    it('matrícula con valores distintos por plan: avisa que guardar los iguala', async () => {
        bff.get.mockResolvedValue(precios({ matricula: { valor: null, valores_distintos: [100000, 120000], planes: 3 } }));
        abrir();
        const aviso = await screen.findByTestId('matricula-distinta');
        expect(aviso).toHaveTextContent('$100.000, $120.000');
        expect(aviso).toHaveTextContent('todos tus planes quedan con ese mismo valor');
    });

    it('clase de prueba: guarda el valor', async () => {
        bff.get.mockResolvedValue(precios());
        bff.put.mockResolvedValue(precios({ clase_prueba: { valor: 30000, habilitada: true } }));
        abrir();
        fireEvent.change(await screen.findByLabelText('Valor de la clase de prueba'), { target: { value: '30000' } });
        fireEvent.click(within(screen.getByTestId('sec-clase-prueba')).getByRole('button', { name: 'Guardar' }));
        await waitFor(() => expect(bff.put).toHaveBeenCalledWith(`${BASE}/clase-prueba`, { valor: 30000 }));
    });

    it('artículos: agrega uno con nombre y precio', async () => {
        bff.get.mockResolvedValue(precios());
        bff.post.mockResolvedValue(precios({ articulos: [...precios().articulos, { id: 'a3', nombre: 'Medias', precio: 18000, activo: true }] }));
        abrir();
        fireEvent.click(await screen.findByRole('button', { name: /Agregar artículo/ }));
        const nuevo = screen.getByTestId('articulo-nuevo');
        fireEvent.click(within(nuevo).getByRole('button', { name: 'Agregar' }));
        expect(await within(nuevo).findByRole('alert')).toHaveTextContent('Escribe el nombre del artículo.');
        expect(bff.post).not.toHaveBeenCalled();
        fireEvent.change(within(nuevo).getByLabelText('Nombre'), { target: { value: ' Medias ' } });
        fireEvent.change(within(nuevo).getByLabelText('Precio'), { target: { value: '18.000' } });
        fireEvent.click(within(nuevo).getByRole('button', { name: 'Agregar' }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith(`${BASE}/articulos`, { nombre: 'Medias', precio: 18000 }));
        expect(await screen.findByTestId('articulo-a3')).toHaveTextContent('$18.000');
        expect(screen.queryByTestId('articulo-nuevo')).not.toBeInTheDocument();
    });

    it('artículos: edita el precio, desactiva y vuelve a activar; no hay cómo borrar', async () => {
        bff.get.mockResolvedValue(precios());
        abrir();
        const fila = await screen.findByTestId('articulo-a1');
        expect(screen.queryByRole('button', { name: /Borrar|Eliminar/ })).not.toBeInTheDocument();

        bff.patch.mockResolvedValueOnce(precios({ articulos: [{ id: 'a1', nombre: 'Uniforme', precio: 95000, activo: true }, precios().articulos[1]] }));
        fireEvent.click(within(fila).getByRole('button', { name: /Editar/ }));
        fireEvent.change(within(screen.getByTestId('articulo-a1')).getByLabelText('Precio'), { target: { value: '95000' } });
        fireEvent.click(within(screen.getByTestId('articulo-a1')).getByRole('button', { name: 'Guardar' }));
        await waitFor(() => expect(bff.patch).toHaveBeenCalledWith(`${BASE}/articulos/a1`, { nombre: 'Uniforme', precio: 95000 }));
        await waitFor(() => expect(screen.getByTestId('articulo-a1')).toHaveTextContent('$95.000'));

        bff.patch.mockResolvedValueOnce(precios({ articulos: [{ id: 'a1', nombre: 'Uniforme', precio: 95000, activo: false }, precios().articulos[1]] }));
        fireEvent.click(within(screen.getByTestId('articulo-a1')).getByRole('button', { name: 'Desactivar' }));
        await waitFor(() => expect(bff.patch).toHaveBeenLastCalledWith(`${BASE}/articulos/a1`, { activo: false }));
        await waitFor(() => expect(screen.getByTestId('articulo-a1')).toHaveTextContent('Desactivado'));

        bff.patch.mockResolvedValueOnce(precios());
        fireEvent.click(within(screen.getByTestId('articulo-a2')).getByRole('button', { name: 'Activar' }));
        await waitFor(() => expect(bff.patch).toHaveBeenLastCalledWith(`${BASE}/articulos/a2`, { activo: true }));
    });

    it('interruptores: apagar «responde precios» manda solo ese y cambia las marcas', async () => {
        bff.get.mockResolvedValue(precios());
        bff.put.mockResolvedValue(precios({ interruptores: { responde_precios: false, cobra_desde_comprobante: true } }));
        abrir();
        const responde = await screen.findByRole('switch', { name: 'El bot responde precios' });
        expect(responde).toBeChecked();
        expect(screen.getByRole('switch', { name: 'El bot registra el pago cuando llega el comprobante' })).toBeChecked();
        fireEvent.click(responde);
        await waitFor(() => expect(bff.put).toHaveBeenCalledWith(`${BASE}/interruptores`, { responde_precios: false }));
        await waitFor(() => expect(screen.getByRole('switch', { name: 'El bot responde precios' })).not.toBeChecked());
        const plan = screen.getByTestId('plan-p1');
        expect(plan).toHaveTextContent('No lo dice al responder: lo apagaste arriba');
        expect(plan).toHaveTextContent('Lo reconoce en comprobantes');
    });

    it('secciones vacías: cada una dice qué hacer', async () => {
        bff.get.mockResolvedValue(precios({
            mensualidades: [], articulos: [], servicios: [],
            matricula: { valor: null, valores_distintos: [], planes: 0 }, clase_prueba: { valor: null, habilitada: false },
        }));
        abrir();
        expect(await screen.findByText(/Todavía no tienes planes\. Créalos en Equipos y Planes/)).toBeInTheDocument();
        expect(screen.getByText(/Todavía no tienes artículos\. Agrega el uniforme/)).toBeInTheDocument();
        expect(screen.getByText(/Todavía no tienes servicios\. Créalos en Finanzas › Pagos/)).toBeInTheDocument();
        expect(screen.getByTestId('sec-matricula')).toHaveTextContent('Crea primero un plan');
        expect(screen.getByTestId('sec-clase-prueba')).toHaveTextContent('no está ofreciendo clase de prueba');
    });

    it('si guardar falla: avisa con el motivo en palabras y deja lo que había', async () => {
        bff.get.mockResolvedValue(precios());
        bff.put.mockRejectedValue(Object.assign(new Error('valor_invalido'), { body: { error: 'valor_invalido' } }));
        abrir();
        fireEvent.change(await screen.findByLabelText('Valor de la matrícula'), { target: { value: '5' } });
        fireEvent.click(within(screen.getByTestId('sec-matricula')).getByRole('button', { name: 'Guardar' }));
        await waitFor(() => expect(toastEstable.toast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'No se pudo guardar', variant: 'destructive', description: expect.stringContaining('Ese valor no es válido'),
        })));
        expect(screen.getByTestId('plan-p1')).toHaveTextContent('$310.000');
    });

    it('si el BFF falla al cargar: un mensaje y «Reintentar»', async () => {
        bff.get.mockRejectedValueOnce(new Error('500'));
        abrir();
        expect(await screen.findByText(/No pudimos cargar tus precios/)).toBeInTheDocument();
        bff.get.mockResolvedValue(precios());
        fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
        expect(await screen.findByTestId('plan-p1')).toBeInTheDocument();
        expect(bff.get).toHaveBeenCalledTimes(2);
    });
});
