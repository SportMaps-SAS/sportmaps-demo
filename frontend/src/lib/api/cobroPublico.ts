/**
 * Cliente del enlace público de un cobro (/p/:token). Sin sesión: el token es
 * la credencial (bffClient en modo 'public', no adjunta JWT ni x-school-id).
 * Contrato: bff/src/routes/cobro-enlace-publico.routes.ts.
 */

import { bffClient, BFFError, BFF_URL } from '@/lib/api/bffClient';
import type { DatosFactura, ResumenFacturaPublica } from '@/lib/facturaElectronica';

export type EstadoCobro = 'pendiente' | 'vencido' | 'en_revision' | 'pagado' | 'abono' | 'anulado' | 'rechazado';

export interface VistaCobroPublico {
    escuela: { nombre: string; logoUrl: string | null };
    concepto: string;
    periodo: string | null;
    deportista: string | null;
    estado: EstadoCobro;
    monto: number;
    /**
     * Recargo por mora ya sumado en `monto` (payments.late_fee_amount; la mora
     * nunca cancela, apply_late_fees() lo suma al cobro). Solo informativo.
     * Opcional: un BFF anterior no lo manda.
     */
    late_fee_amount?: number | null;
    fechaVencimiento: string | null;
    fechaPago: string | null;
    enlaceVenceEn: string;
    enLinea: null | { proveedor: 'wompi'; recargoPct: number; recargo: number; total: number };
    transferencia: {
        cuentas: { tipo: string; titular: string | null; numero: string }[];
        whatsappComprobante: string | null;
        /** Imagen del QR de pago que cargó la escuela (p.ej. Bre-B). */
        qrEscuelaUrl?: string | null;
        /**
         * Link de pago genérico de la escuela (p.ej. Wompi de Dynasty). El
         * acudiente escribe el valor; la escuela concilia con el comprobante.
         * Opcional: un BFF anterior no lo manda.
         */
        linkDePago?: string | null;
    };
    /**
     * wa.me con «… ACTIVAR AVISOS» prellenado para dar el consentimiento desde
     * WhatsApp. null si ya lo dio o la escuela no tiene WhatsApp. Opcional: un
     * BFF anterior no lo manda.
     */
    whatsappAvisos?: string | null;
    /**
     * El cobro acepta subir aquí la foto/PDF del comprobante (escuelas sin
     * WhatsApp). Opcional: un BFF anterior no lo manda.
     */
    subirComprobante?: boolean;
    /** Otros cobros por pagar del mismo pagador, cada uno con su enlace. */
    otrosPendientes?: {
        token: string;
        concepto: string;
        periodo: string | null;
        deportista: string | null;
        monto: number;
        fechaVencimiento: string | null;
        vencido: boolean;
    }[];
}

export interface CheckoutCobroPublico {
    provider: 'wompi';
    publicKey: string;
    reference: string;
    signature: string;
    amountInCents: number;
    total: number;
    reused: boolean;
}

const enc = encodeURIComponent;

export const obtenerCobroPublico = (token: string) =>
    bffClient.get<VistaCobroPublico>(`/api/v1/public/cobro/${enc(token)}`, undefined, 'public');

export const iniciarPagoCobroPublico = (token: string) =>
    bffClient.post<CheckoutCobroPublico>(`/api/v1/public/cobro/${enc(token)}/pagar`, {}, undefined, 'public');

/**
 * Abre el Widget de Wompi con la firma que calculó el BFF.
 *
 * No reusa openWompiCheckout (lib/api/wompi.ts) a propósito: ese camino arma
 * customerData con el correo del usuario logueado — aquí no hay sesión ni correo
 * (el enlace no expone datos del acudiente). Sin customerData el Widget los pide.
 * Misma regla que allá: llave y firma vienen SOLO del BFF.
 */
export function abrirWidgetWompi(
    c: CheckoutCobroPublico,
    redirectUrl: string,
): Promise<{ status?: string } | null> | null {
    // Devuelve null SIN abrir si el script del Widget no cargó (el llamador lo
    // carga antes con cargarWidgetWompi, lib/wompiWidget.ts).
    // Si abre, la promesa resuelve solo cuando hay transacción: si la familia
    // cierra el Widget sin pagar, Wompi no llama al callback y la promesa queda
    // pendiente — por eso el llamador no bloquea la UI esperándola.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WidgetCheckout = (window as any).WidgetCheckout;
    if (!WidgetCheckout) return null;
    let checkout: { open: (cb: (r: { transaction?: { status?: string } }) => void) => void };
    try {
        checkout = new WidgetCheckout({
            currency: 'COP',
            amountInCents: c.amountInCents,
            reference: c.reference,
            publicKey: c.publicKey,
            signature: { integrity: c.signature },
            redirectUrl,
        });
    } catch {
        return null;
    }
    return new Promise((resolve) => {
        checkout.open((r) => resolve(r?.transaction ?? null));
    });
}

// ─── Factura electrónica del pagador de este cobro ──────────────────────────
// Resumen SIEMPRE enmascarado; guardar va por el token (el cuerpo no puede
// elegir a quién se le guardan los datos).

export const obtenerFacturaPublica = (token: string) =>
    bffClient.get<ResumenFacturaPublica>(`/api/v1/public/cobro/${enc(token)}/factura`, undefined, 'public');

export const guardarFacturaPublica = (token: string, datos: DatosFactura) =>
    bffClient.put<{ ok: true }>(`/api/v1/public/cobro/${enc(token)}/factura`, datos, undefined, 'public');

// ─── Comprobante por el enlace (escuelas sin WhatsApp) ──────────────────────

/** Mismo tope que el BFF (MAX_BYTES_COMPROBANTE). */
export const MAX_BYTES_COMPROBANTE = 6 * 1024 * 1024;
const TIPOS_COMPROBANTE = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

/**
 * Foto de cámara muy pesada → JPEG más liviano (lado mayor 2000 px). El OCR lee
 * igual y el tope del BFF no la rechaza. PDFs y archivos chicos van tal cual.
 */
async function achicarSiHaceFalta(f: File): Promise<Blob> {
    if (f.size <= MAX_BYTES_COMPROBANTE || !f.type.startsWith('image/')) return f;
    try {
        const bmp = await createImageBitmap(f);
        const escala = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * escala);
        canvas.height = Math.round(bmp.height * escala);
        canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
        return blob ?? f;
    } catch {
        return f;
    }
}

/** Sube el comprobante del cobro del token. El cuerpo es el archivo crudo. */
export async function subirComprobanteCobroPublico(
    token: string,
    archivo: File,
): Promise<{ ok: true; estado: 'en_revision' | 'pagado' | 'rechazado' }> {
    const tipo = archivo.type === 'image/jpg' ? 'image/jpeg' : archivo.type;
    if (!TIPOS_COMPROBANTE.includes(tipo)) {
        throw new BFFError(415, 'Solo se aceptan imágenes (JPG, PNG, WEBP) o PDF.');
    }
    const cuerpo = await achicarSiHaceFalta(archivo);
    if (cuerpo.size > MAX_BYTES_COMPROBANTE) {
        throw new BFFError(413, 'El archivo es muy pesado (máximo 6 MB). Sube una captura de pantalla.');
    }
    const resp = await fetch(`${BFF_URL}/api/v1/public/cobro/${enc(token)}/comprobante`, {
        method: 'POST',
        headers: { 'Content-Type': cuerpo.type || tipo },
        body: cuerpo,
    });
    let body: any = null;
    try { body = await resp.json(); } catch { body = null; }
    if (!resp.ok) throw new BFFError(resp.status, body?.error ?? `Error ${resp.status}`, body);
    return body;
}
