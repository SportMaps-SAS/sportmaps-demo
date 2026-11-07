/** Ayudas solo para las pruebas de los bloques de la familia. */
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';

export const PROHIBIDAS = /mora|deuda|atraso|vencid|multa|recargo/i;

export function renderConQuery(ui: ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
