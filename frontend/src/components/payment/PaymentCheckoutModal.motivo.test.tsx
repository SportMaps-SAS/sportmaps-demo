/**
 * PaymentCheckoutModal con el catálogo único de motivos (plan B4 T5):
 * motivo preseleccionado por enlace de cobro y el bug L8 (los ítems del
 * catálogo de servicios se cobraban siempre como 'torneo').
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'parent-1', email: 'p@x.co', user_metadata: {} } }) }));
vi.mock('@/hooks/useSchoolInvoicingActive', () => ({
    useSchoolInvoicingActive: () => ({ active: false }),
    mustAskBillingData: () => false,
}));
vi.mock('@/hooks/useWompiCheckout', () => ({ useWompiCheckout: () => ({ startSchoolPayment: vi.fn(), loading: false }) }));
vi.mock('@/hooks/usePaymentPeriod', () => ({
    useNextUnpaidPeriod: () => ({ period: null }),
    fetchPeriodStatus: vi.fn(),
    isPeriodActive: () => false,
}));
vi.mock('@/pwa/reloadGuard', () => ({ blockPwaReload: vi.fn(), unblockPwaReload: vi.fn() }));
vi.mock('@/lib/api/glosas', () => ({ autoEvaluate: vi.fn(() => Promise.resolve()) }));
vi.mock('@/components/checkout/MercadoPagoBrick', () => ({ default: () => null }));
vi.mock('@/components/billing/BillingDetailsForm', () => ({ BillingDetailsForm: () => null }));
vi.mock('@/components/common/FileUpload', () => ({
    FileUpload: ({ onUploadComplete }: { onUploadComplete: (url: string) => void }) => (
        <button type="button" onClick={() => onUploadComplete('https://x.co/comprobante.png')}>subir comprobante</button>
    ),
}));
vi.mock('@/lib/earlyPaymentDiscount', async (orig) => {
    const real = await orig<typeof import('@/lib/earlyPaymentDiscount')>();
    return { ...real, hasEarlierUnpaidPayment: () => Promise.resolve(false) };
});

const db = vi.hoisted(() => ({
    items: [] as Record<string, unknown>[],
    /** true = la migración M2 no está aplicada: pedir sus columnas da 400. */
    sinM2: false,
    inserts: [] as Record<string, unknown>[],
}));

vi.mock('@/integrations/supabase/client', () => {
    const SETTINGS = {
        merchandise_enabled: false, tournament_charges_enabled: true, wompi_enabled: false,
        allow_installments: false, online_fee_pct: 3, payment_accounts: [],
        bank_name: 'Bancolombia', bank_account_number: '123',
    };
    const PROFILE = { full_name: 'P', document_type: 'CC', document_number: '1', billing_address: 'x', billing_city_dane: '11001' };
    const from = (table: string) => {
        let cols = '';
        const resultado = () => {
            if (table === 'school_tournament_items') {
                if (db.sinM2 && cols.includes('precio_afiliado')) return { data: null, error: { code: '42703', message: 'column does not exist' } };
                // Como PostgREST: solo las columnas pedidas.
                const pedidas = cols.split(',').map((c) => c.trim());
                return { data: db.items.map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => pedidas.includes(k)))), error: null };
            }
            if (table === 'school_settings') return { data: SETTINGS, error: null };
            if (table === 'profiles') return { data: PROFILE, error: null };
            return { data: [], error: null };
        };
        const q: Record<string, unknown> = {};
        for (const m of ['eq', 'in', 'neq', 'order', 'limit', 'is']) q[m] = () => q;
        q.select = (c: string) => { cols = c; return q; };
        q.maybeSingle = () => Promise.resolve(resultado());
        q.single = () => Promise.resolve(resultado());
        q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, ko);
        q.insert = (payload: Record<string, unknown>) => {
            db.inserts.push(payload);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'pay-new' }, error: null }) }) };
        };
        q.update = () => q;
        return q;
    };
    return {
        supabase: {
            from,
            auth: { getUser: () => Promise.resolve({ data: { user: { id: 'parent-1' } } }) },
        },
    };
});

import { PaymentCheckoutModal } from './PaymentCheckoutModal';

const CATALOGO = [
    { id: 't1', name: 'Copa Halloween', price: 50_000, kind: 'torneo' },
    {
        id: 'c1', name: 'Clínica de armadores', price: 300_000, kind: 'clase_extra',
        precio_afiliado: 250_000, precios_por_fecha: [{ desde: '2026-11-10', precio: 350_000 }], opciones: null,
    },
    {
        id: 'v1', name: 'Vacacional Suba', price: 100_000, kind: 'vacacional', precio_afiliado: null,
        opciones: [
            { clave: '1_semana', etiqueta: '1 semana', precio: 100_000, precio_afiliado: 80_000 },
            { clave: '2_semanas', etiqueta: '2 semanas', precio: 140_000, precio_afiliado: 120_000 },
        ],
    },
];

function renderModal(props: Partial<React.ComponentProps<typeof PaymentCheckoutModal>> = {}) {
    return render(
        <MemoryRouter>
            <PaymentCheckoutModal
                open
                onOpenChange={vi.fn()}
                studentId="child-1"
                childId="child-1"
                schoolId="school-1"
                amount={180_000}
                concept="Plan Sub-12"
                mode="create"
                {...props}
            />
        </MemoryRouter>,
    );
}

/** El selector «Tipo de Pago» es el primer combobox del formulario. */
const selectorDeTipo = () => screen.getAllByRole('combobox')[0];

beforeEach(() => {
    db.items = CATALOGO;
    db.sinM2 = false;
    db.inserts = [];
});

describe('PaymentCheckoutModal — motivo preseleccionado', () => {
    it('entra por un enlace de clínica: abre en «Clases extra y clínicas» y solo muestra esos ítems', async () => {
        renderModal({ initialConceptType: 'clase_extra' });
        expect(await screen.findByText('Clínica de armadores')).toBeInTheDocument();
        expect(selectorDeTipo()).toHaveTextContent('Clases extra y clínicas');
        expect(screen.queryByText('Copa Halloween')).not.toBeInTheDocument();
        expect(screen.queryByText('Vacacional Suba')).not.toBeInTheDocument();
    });

    it('sin enlace abre en la mensualidad, como siempre', async () => {
        renderModal();
        await waitFor(() => expect(selectorDeTipo()).toHaveTextContent('Mensualidad (Plan Sub-12)'));
        expect(screen.queryByText('Copa Halloween')).not.toBeInTheDocument();
    });

    it('un motivo que la escuela no ofrece cae en la mensualidad', async () => {
        db.items = CATALOGO.filter((i) => i.kind !== 'vacacional');
        renderModal({ initialConceptType: 'vacacional' });
        await waitFor(() => expect(selectorDeTipo()).toHaveTextContent('Mensualidad (Plan Sub-12)'));
    });
});

describe('PaymentCheckoutModal — el servicio se cobra con su kind (bug L8)', () => {
    async function pagarPrimerItem(nombre: string) {
        fireEvent.click(await screen.findByText(nombre));
        fireEvent.click(await screen.findByText('subir comprobante'));
        const pagar = await screen.findByRole('button', { name: /^Pagar \$/ });
        await waitFor(() => expect(pagar).not.toBeDisabled());
        fireEvent.click(pagar);
        await waitFor(() => expect(db.inserts).toHaveLength(1));
        return db.inserts[0];
    }

    it('la clínica sale como clase_extra, exenta del período y con precio de afiliado', async () => {
        renderModal({ initialConceptType: 'clase_extra' });
        const fila = await pagarPrimerItem('Clínica de armadores');
        expect(fila).toMatchObject({
            payment_category: 'clase_extra',
            period_uniqueness_exempt: true,
            amount: 250_000,
            concept: 'Clases extra y clínicas: Clínica de armadores x1',
            status: 'awaiting_approval',
        });
    });

    it('el vacacional sale como vacacional con el precio de la opción para afiliados', async () => {
        renderModal({ initialConceptType: 'vacacional' });
        const fila = await pagarPrimerItem('Vacacional Suba');
        expect(fila).toMatchObject({
            payment_category: 'vacacional',
            amount: 80_000,
            concept: 'Vacacionales: Vacacional Suba (1 semana) x1',
        });
    });

    it('el torneo sigue saliendo como torneo, con el concepto de siempre', async () => {
        renderModal({ initialConceptType: 'torneo' });
        const fila = await pagarPrimerItem('Copa Halloween');
        expect(fila).toMatchObject({ payment_category: 'torneo', period_uniqueness_exempt: true, amount: 50_000, concept: 'Torneos: Copa Halloween x1' });
    });

    it('sin la migración M2: lee el catálogo igual y cobra el precio de siempre', async () => {
        db.sinM2 = true;
        renderModal({ initialConceptType: 'clase_extra' });
        const fila = await pagarPrimerItem('Clínica de armadores');
        expect(fila).toMatchObject({ payment_category: 'clase_extra', amount: 300_000 });
    });
});
