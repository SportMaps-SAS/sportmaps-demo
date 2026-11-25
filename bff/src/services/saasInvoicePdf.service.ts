// saasInvoicePdf.service — genera el PDF del recibo SaaS que SportMaps le
// envía a una escuela por su mensualidad. El emisor es SportMaps, no la
// escuela — por eso NO usa resolveSchoolBranding(schoolId) (eso trae la
// marca de la escuela destinataria) sino los colores default de SportMaps.
// Diseño deliberadamente sobrio (fondo blanco, línea de acento en vez de
// banda sólida, cajas con borde fino) pensado para imprimirse bien.
//
// Los métodos de pago se leen de platform_config.platform_payment_accounts
// en cada generación — cambiar la cuenta ahí no requiere tocar este archivo.
//
// El logo (src/assets/sportmaps-logo.png) ya trae el wordmark "Sport Maps"
// integrado a la imagen — por eso el header no dibuja el nombre como texto
// aparte. Es un recorte (sharp .trim()) del logo vigente que subió el
// usuario; si se reemplaza el archivo, mantener la proporción ancho/alto
// para que el `height` fijo del header no lo deforme.

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { supabase } from '../config/supabase';
import { invoiceLines, SaasInvoiceLineItem } from './saasInvoicing.constants';

const SPORTMAPS_GREEN = '#248223';
const INK = '#1f2937';
const MUTED = '#6b7280';
const HAIRLINE = '#e5e7eb';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.sportmaps.co';

// Se lee una sola vez al arrancar el proceso; si el asset no está (falló el
// paso de copia del build), la generación del PDF sigue sin el logo en vez
// de tumbarse — un recibo sin ícono es mucho mejor que ninguno.
let cachedLogo: Buffer | null | undefined;
function loadLogo(): Buffer | null {
    if (cachedLogo !== undefined) return cachedLogo;
    try {
        cachedLogo = fs.readFileSync(path.join(__dirname, '../assets/sportmaps-logo.png'));
    } catch {
        cachedLogo = null;
    }
    return cachedLogo;
}

export interface PlatformPaymentAccount {
    id: string;
    type: string;
    label: string;
    value: string;
    holder_name: string;
    active: boolean;
}

export async function loadActivePaymentAccounts(): Promise<PlatformPaymentAccount[]> {
    const { data } = await supabase
        .from('platform_config')
        .select('value')
        .eq('key', 'platform_payment_accounts')
        .maybeSingle();
    const accounts = (data?.value as PlatformPaymentAccount[] | undefined) ?? [];
    return accounts.filter((a) => a.active);
}

function formatCop(cents: number): string {
    return `$${Math.round(cents / 100).toLocaleString('es-CO')}`;
}

function formatDate(d: string | Date): string {
    // Recibe fechas 'YYYY-MM-DD' (period_start/end, due_date), que new Date() lee como medianoche UTC:
    // se formatean en UTC para que no salgan con un día menos fuera de Render (p. ej. en hora de Colombia).
    return new Date(d).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export interface SaasInvoiceForPdf {
    id: string;
    invoice_number: string;
    plan_code: string;
    amount_cents: number;
    line_items?: SaasInvoiceLineItem[] | null;
    period_start: string;
    period_end: string;
    due_date: string;
    status: string;
}

export async function generateSaasInvoicePdf(invoice: SaasInvoiceForPdf, schoolName: string): Promise<Buffer> {
    const accounts = await loadActivePaymentAccounts();
    const lines = invoiceLines(invoice);
    const invoiceLink = `${FRONTEND_URL.replace(/\/$/, '')}/facturacion/recibo/${invoice.id}`;
    const logo = loadLogo();
    const qrPng = await QRCode.toBuffer(invoiceLink, { width: 140, margin: 0 });

    return new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 60 });
        const chunks: Buffer[] = [];
        doc.on('data', (c) => chunks.push(c as Buffer));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // ── Header: logo (ya trae el wordmark) + línea de acento ──
        if (logo) {
            doc.image(logo, 60, 50, { height: 34 });
        } else {
            doc.fillColor(INK).fontSize(17).font('Helvetica-Bold').text('SportMaps', 60, 55);
        }
        doc.fillColor(MUTED).fontSize(9).font('Helvetica')
           .text('Factura de mensualidad SaaS', 60, 92);

        doc.fillColor(MUTED).fontSize(9).font('Helvetica')
           .text('N.° de factura', doc.page.width - 220, 55, { width: 160, align: 'right' });
        doc.fillColor(INK).fontSize(12).font('Helvetica-Bold')
           .text(invoice.invoice_number, doc.page.width - 220, 69, { width: 160, align: 'right' });

        const accentY = 112;
        doc.rect(60, accentY, doc.page.width - 120, 2.5).fill(SPORTMAPS_GREEN);
        doc.y = accentY + 28;

        // ── Datos de la escuela ──
        doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold').text('PARA', 60, doc.y, { characterSpacing: 0.5 });
        doc.fillColor(INK).fontSize(13).font('Helvetica').text(schoolName, 60, doc.y + 2);
        doc.moveDown(1.8);

        // ── Tabla detalle (plan + adicionales) / período / vencimiento — filas con hairline ──
        const rows: [string, string][] = [
            ...lines.map((l): [string, string] => [l.label, formatCop(l.amount_cents)]),
            ['Período facturado', `${formatDate(invoice.period_start)} — ${formatDate(invoice.period_end)}`],
            ['Fecha de vencimiento', formatDate(invoice.due_date)],
        ];
        for (const [label, value] of rows) {
            const y = doc.y;
            doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(label, 60, y, { width: 180 });
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(value, 260, y, { width: doc.page.width - 320 });
            doc.moveDown(0.65);
            doc.moveTo(60, doc.y).lineTo(doc.page.width - 60, doc.y).strokeColor(HAIRLINE).lineWidth(0.75).stroke();
            doc.moveDown(0.65);
        }
        doc.moveDown(0.6);

        // ── Total: caja con borde fino, monto en verde marca ──
        const boxY = doc.y;
        const boxH = 58;
        doc.roundedRect(60, boxY, doc.page.width - 120, boxH, 6).lineWidth(1).strokeColor(HAIRLINE).stroke();
        doc.fillColor(MUTED).fontSize(9).font('Helvetica').text('TOTAL A PAGAR', 80, boxY + 14, { characterSpacing: 0.5 });
        doc.fillColor(SPORTMAPS_GREEN).fontSize(22).font('Helvetica-Bold').text(formatCop(invoice.amount_cents), 80, boxY + 27);
        doc.y = boxY + boxH + 30;

        // ── Cómo pagar ──
        doc.fillColor(INK).fontSize(11).font('Helvetica-Bold').text('Cómo pagar', 60, doc.y);
        doc.moveDown(0.7);
        if (accounts.length === 0) {
            doc.fillColor(MUTED).fontSize(10).font('Helvetica')
               .text('Escríbenos para confirmar el método de pago vigente.');
        }
        for (const acc of accounts) {
            const y = doc.y;
            doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text(acc.label, 60, y);
            doc.fillColor(INK).fontSize(10).font('Helvetica').text(`Llave: ${acc.value}`, 60, doc.y);
            doc.fillColor(MUTED).fontSize(8.5).font('Helvetica').text(`A nombre de ${acc.holder_name}`, 60, doc.y);
            doc.moveDown(1);
        }
        doc.moveDown(0.3);
        doc.fillColor(MUTED).fontSize(8.5).font('Helvetica')
           .text('Envía el comprobante de pago por WhatsApp o correo para que confirmemos tu factura.', 60, doc.y, { width: doc.page.width - 120 });

        // ── Divisor + QR a la factura online (mismo link que se manda por email/WhatsApp) ──
        const dividerY = doc.page.height - 150;
        doc.moveTo(60, dividerY).lineTo(doc.page.width - 60, dividerY).strokeColor(HAIRLINE).lineWidth(0.75).stroke();

        const qrY = dividerY + 20;
        doc.image(qrPng, 60, qrY, { width: 56, height: 56 });
        doc.fillColor(MUTED).fontSize(8).font('Helvetica')
           .text('Ver factura y estado de pago', 128, qrY + 12, { width: doc.page.width - 200 });
        doc.fillColor(INK).fontSize(8).font('Helvetica-Bold')
           .text(invoiceLink, 128, doc.y, { width: doc.page.width - 200 });

        // ── Footer ──
        doc.fillColor('#9ca3af').fontSize(7.5).font('Helvetica')
           .text('SportMaps · Este es un recibo interno, no una factura electrónica DIAN.', 60, doc.page.height - 45,
                 { width: doc.page.width - 120, align: 'center' });

        doc.end();
    });
}
