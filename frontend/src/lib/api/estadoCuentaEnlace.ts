/**
 * Cliente del enlace del estado de cuenta de una familia.
 *
 *   · Pública (sin sesión, el token es la credencial): GET /api/v1/public/estado-cuenta/:token
 *   · Administración (con sesión y x-school-id): POST /api/v1/estado-cuenta/enviar
 *
 * Contrato: bff/src/routes/estado-cuenta-enlace.routes.ts y
 * bff/src/services/estado-cuenta-enlace.contenido.ts. Plan:
 * docs/specs/estado-de-cuenta-envio-a-familias.md.
 */

import { bffClient, BFFError } from '@/lib/api/bffClient';

export interface AsistenciaMesPublica { asistio: number; tarde: number; excusada: number; falto: number; total: number }

export interface ResumenCuentaPublica {
    count_expected: number; total_expected: number;
    count_settled: number; total_settled: number;
    count_open: number; total_open: number;
    total_late_fees: number;
}

/** Un cobro tal como lo publica el BFF: ids opacos, sin rutas, sin nombre completo. */
export interface CobroPublicoEstado {
    id: string;
    status: string;
    amount: number | null;
    amount_paid: number | null;
    concept: string | null;
    due_date: string | null;
    payment_date: string | null;
    period_year: number | null;
    period_month: number | null;
    created_at: string;
    payment_method: string | null;
    payment_channel: string | null;
    payment_provider: string | null;
    /** 'recibido' si la escuela tiene el comprobante; la ruta del archivo nunca llega. */
    receipt_url: 'recibido' | null;
    wompi_reference: 'x' | null;
}

export interface AtletaPublicoEstado {
    nombre: string;
    resumen: ResumenCuentaPublica;
    cobros: CobroPublicoEstado[];
    asistencia: Record<string, AsistenciaMesPublica>;
}

export interface VistaEstadoCuentaPublica {
    escuela: { nombre: string; logoUrl: string | null; colorPrimario: string; mostrarMarcaSportmaps: boolean };
    generadoEn: string;
    periodo: { desde: string; hasta: string; meses: number };
    enlaceVenceEn: string;
    atletas: AtletaPublicoEstado[];
    pagarUrl: string | null;
}

const enc = encodeURIComponent;

export const obtenerEstadoCuentaPublico = (token: string) =>
    bffClient.get<VistaEstadoCuentaPublica>(`/api/v1/public/estado-cuenta/${enc(token)}`, undefined, 'public');

export type TipoAtletaEstado = 'hijo' | 'adulto' | 'ficha';

export type MotivoNoEnvio =
    | 'no_pertenece' | 'sin_correo' | 'fuera_de_horario' | 'ya_enviado_hoy' | 'contactada_hoy' | 'no_disponible' | 'fallo_envio';

export type RespuestaEnvio =
    | { ok: true; simulado: boolean; canal: 'correo'; destino: string; atletas: string[]; vigenciaDias: number }
    | { ok: false; motivo: MotivoNoEnvio; mensaje: string };

export interface PedidoEnvioEstado {
    atleta: { tipo: TipoAtletaEstado; id: string };
    /** false o ausente = simulación (no manda nada). */
    aplicar?: boolean;
    reenviar?: boolean;
}

/**
 * Simula o envía el estado de cuenta a la familia de un deportista. Los motivos por
 * los que NO se envía (sin correo, fuera de horario, ya enviado hoy…) llegan como
 * `{ ok: false, motivo, mensaje }` — no como excepción — para poder mostrarlos tal cual.
 * Un error de red o un 4xx/5xx sin ese formato sí lanza.
 */
export async function enviarEstadoCuenta(pedido: PedidoEnvioEstado): Promise<RespuestaEnvio> {
    try {
        return await bffClient.post<RespuestaEnvio>('/api/v1/estado-cuenta/enviar', pedido);
    } catch (e) {
        if (e instanceof BFFError) {
            const cuerpo = e.body as Partial<RespuestaEnvio> | null | undefined;
            if (cuerpo && cuerpo.ok === false && typeof cuerpo.motivo === 'string' && typeof cuerpo.mensaje === 'string') {
                return cuerpo as RespuestaEnvio;
            }
        }
        throw e;
    }
}
