/**
 * Editor del catálogo de servicios con los precios de M2 (plan maestro B4-front):
 * precio para afiliados, opciones, cambio por fecha y abono. Sin la migración
 * aplicada la tarjeta se ve y guarda como antes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast }));
vi.mock('@/hooks/useEntitlements', () => ({ useEntitlements: () => ({ hasAddon: () => false }) }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: { get: vi.fn(() => Promise.resolve([])) } }));

const db = vi.hoisted(() => ({
    items: [] as Record<string, unknown>[],
    sinM2: false,
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
}));

vi.mock('@/integrations/supabase/client', () => {
    const from = (table: string) => {
        let cols = '';
        const resultado = () => {
            if (table === 'school_tournament_items') {
                if (db.sinM2 && cols.includes('precio_afiliado')) return { data: null, error: { message: 'column "precio_afiliado" does not exist' } };
                return { data: db.items, error: null };
            }
            if (table === 'school_settings') return { data: { wa_ventas_habilitadas: false }, error: null };
            return { data: [], error: null };
        };
        const q: Record<string, unknown> = {};
        for (const m of ['eq', 'order']) q[m] = () => q;
        q.select = (c: string) => { cols = c; return q; };
        q.maybeSingle = () => Promise.resolve(resultado());
        q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, ko);
        q.update = (row: Record<string, unknown>) => { db.updates.push(row); return { eq: () => Promise.resolve({ error: null }) }; };
        q.insert = (row: Record<string, unknown>) => { db.inserts.push(row); return Promise.resolve({ error: null }); };
        return q;
    };
    return { supabase: { from } };
});

import { SellableCatalogCard } from './SellableCatalogCard';

const CLINICA = {
    id: 'c1', name: 'Clínica de armadores', price: 300_000, active: true, kind: 'clase_extra', description: null,
    image_url: null, starts_at: null, ends_at: null, capacity: 40, per_athlete: true, event_id: null,
    precio_afiliado: 250_000, opciones: null, precios_por_fecha: [{ desde: '2026-11-10', precio: 350_000 }], abono_minimo_pct: 50,
};

function renderCard() {
    return render(
        <MemoryRouter>
            <SellableCatalogCard
                schoolId="school-1"
                table="school_tournament_items"
                enabled
                title="Cobros sueltos"
                description="Torneos, clases extra…"
                itemLabel="cobro"
                withServiceFields
            />
        </MemoryRouter>,
    );
}

beforeEach(() => {
    db.items = [CLINICA];
    db.sinM2 = false;
    db.updates = [];
    db.inserts = [];
    toast.mockReset();
});

describe('SellableCatalogCard — precios especiales (M2)', () => {
    it('la lista resume los precios especiales del ítem', async () => {
        renderCard();
        expect(await screen.findByText('Clínica de armadores')).toBeInTheDocument();
        expect(screen.getByText(/Afiliados \$250\.000 · Desde 10 nov: \$350\.000 · Abono 50 %/)).toBeInTheDocument();
        // El tipo sale del catálogo único de motivos (insignia del ítem y selector del formulario).
        expect(within(screen.getByLabelText('Tipo de servicio')).getAllByRole('option').map((o) => o.textContent))
            .toEqual(['Torneo', 'Clase extra / clínica', 'Vacacional', 'Viaje', 'Otro']);
        expect(screen.getAllByText('Clase extra / clínica')).toHaveLength(2);
    });

    it('las cuatro secciones plegables, con su resumen', async () => {
        renderCard();
        await screen.findByText('Clínica de armadores');
        const precios = screen.getByTestId('precios-de-servicio');
        for (const titulo of ['Precio para afiliados', 'Opciones', 'Cambio de precio por fecha', 'Separar cupo con abono']) {
            expect(within(precios).getByText(titulo)).toBeInTheDocument();
        }
        // Formulario nuevo: todo cerrado y en «No».
        expect(within(precios).getAllByText('No')).toHaveLength(4);
    });

    it('editar carga los valores y guardar manda las columnas de M2', async () => {
        renderCard();
        await screen.findByText('Clínica de armadores');
        fireEvent.click(screen.getByRole('button', { name: 'Editar Clínica de armadores' }));
        expect(screen.getByLabelText('Precio para afiliados (COP)')).toHaveValue('250000');
        expect(screen.getByLabelText('Abono mínimo (% del precio)')).toHaveValue('50');

        // Vacacional por semanas: dos opciones, una sin precio de afiliado.
        fireEvent.click(screen.getByRole('button', { name: /Agregar opción/ }));
        fireEvent.change(screen.getByLabelText('Nombre de la opción 1'), { target: { value: '1 semana' } });
        fireEvent.change(screen.getByLabelText('Precio de la opción 1'), { target: { value: '100.000' } });
        fireEvent.change(screen.getByLabelText('Precio para afiliados de la opción 1'), { target: { value: '80.000' } });
        fireEvent.click(screen.getByRole('button', { name: /Agregar opción/ }));
        fireEvent.change(screen.getByLabelText('Nombre de la opción 2'), { target: { value: '2 semanas' } });
        fireEvent.change(screen.getByLabelText('Precio de la opción 2'), { target: { value: '140000' } });

        fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
        await waitFor(() => expect(db.updates).toHaveLength(1));
        expect(db.updates[0]).toMatchObject({
            kind: 'clase_extra',
            price: 300_000,
            precio_afiliado: 250_000,
            precios_por_fecha: [{ desde: '2026-11-10', precio: 350_000 }],
            abono_minimo_pct: 50,
            opciones: [
                { clave: '1_semana', etiqueta: '1 semana', precio: 100_000, precio_afiliado: 80_000 },
                { clave: '2_semanas', etiqueta: '2 semanas', precio: 140_000, precio_afiliado: null },
            ],
        });
    });

    it('un valor inválido no guarda y lo dice en español', async () => {
        renderCard();
        await screen.findByText('Clínica de armadores');
        fireEvent.change(screen.getByPlaceholderText('Nombre'), { target: { value: 'Vacacional' } });
        fireEvent.change(screen.getByPlaceholderText('Precio (COP)'), { target: { value: '100000' } });
        fireEvent.change(screen.getByLabelText('Abono mínimo (% del precio)'), { target: { value: '150' } });
        fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'El abono debe ser un porcentaje entre 1 y 100.' })));
        expect(db.inserts).toHaveLength(0);
    });

    it('sin la migración M2: ni secciones ni columnas nuevas, guarda como antes', async () => {
        db.sinM2 = true;
        db.items = [{ ...CLINICA, precio_afiliado: undefined, opciones: undefined, precios_por_fecha: undefined, abono_minimo_pct: undefined }];
        renderCard();
        await screen.findByText('Clínica de armadores');
        expect(screen.queryByTestId('precios-de-servicio')).not.toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText('Nombre'), { target: { value: 'Viaje a Cali' } });
        fireEvent.change(screen.getByPlaceholderText('Precio (COP)'), { target: { value: '500000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
        await waitFor(() => expect(db.inserts).toHaveLength(1));
        expect(db.inserts[0]).toMatchObject({ name: 'Viaje a Cali', price: 500_000, kind: 'torneo' });
        for (const col of ['precio_afiliado', 'opciones', 'precios_por_fecha', 'abono_minimo_pct']) {
            expect(db.inserts[0]).not.toHaveProperty(col);
        }
    });
});
