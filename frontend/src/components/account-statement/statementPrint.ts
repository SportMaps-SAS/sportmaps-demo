/**
 * Versión imprimible del estado de cuenta (la misma para la escuela y para el
 * acudiente). Se resuelve 100 % en el navegador: ventana nueva + window.print()
 * (decisión de la mig. 20260827231724, sin backend de PDF).
 */
import { formatCurrency } from '@/lib/utils';
import { etiquetaAsistencia } from './estadoCuentaModel';

export interface StatementData {
  athlete_name: string;
  summary: {
    count_expected: number; total_expected: number;
    count_settled: number;  total_settled: number;
    count_open: number;     total_open: number;
    total_late_fees: number;
  };
  meses: Array<{ periodo: string; status: string | null }>;
  events: Array<{
    tipo: 'pago' | 'sesion'; fecha: string; status: string | null;
    amount: number | null; amount_paid: number | null; attendance_status: string | null;
  }>;
}

export const STATUS_LABELS: Record<string, string> = {
  paid: 'Pagado', partial: 'Abono parcial', pending: 'Pendiente', overdue: 'Vencido',
  awaiting_approval: 'En revisión', glosado: 'En aclaración', cancelled: 'Cancelado', rejected: 'Rechazado',
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

export function buildStatementPrintHtml(data: StatementData, months: number, generated = new Date().toLocaleString('es-CO')): string {
  const mesesRows = data.meses.map((m) => `<tr><td>${esc(m.periodo)}</td><td>${esc(STATUS_LABELS[m.status || ''] || 'Sin cobro')}</td></tr>`).join('');
  const eventRows = data.events.map((ev) => `
      <tr>
        <td>${new Date(ev.fecha).toLocaleDateString('es-CO')}</td>
        <td>${ev.tipo === 'pago' ? 'Pago' : 'Sesión'}</td>
        <td>${esc(ev.tipo === 'pago' ? (STATUS_LABELS[ev.status || ''] || ev.status) : etiquetaAsistencia(ev.attendance_status).label)}</td>
        <td>${ev.tipo === 'pago' && ev.amount != null ? formatCurrency(ev.amount) : ''}</td>
      </tr>`).join('');
  const name = esc(data.athlete_name);

  return `
<!DOCTYPE html><html lang="es">
<head>
  <meta charset="utf-8">
  <title>Estado de Cuenta — ${name}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; padding: 28px; }
    .header h1 { font-size: 20px; color: #1a3d6b; }
    .meta { font-size: 11px; color: #666; margin: 6px 0 22px; }
    h2 { font-size: 12px; font-weight: 700; margin: 20px 0 8px; color: #1a3d6b;
         border-bottom: 2px solid #e8eef5; padding-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }
    .kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; }
    .kpi-label { font-size: 9px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
    .kpi-value { font-size: 20px; font-weight: 700; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 11px; }
    th { background: #f3f4f6; text-align: left; padding: 6px 8px; font-size: 9px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: 0.4px; }
    td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; }
    tr:nth-child(even) td { background: #fafafa; }
    .footer { text-align: center; font-size: 10px; color: #aaa; margin-top: 36px; border-top: 1px solid #e5e7eb; padding-top: 14px; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <div class="header"><h1>Estado de Cuenta — ${name}</h1></div>
  <p class="meta">Generado el ${esc(generated)} · últimos ${months} meses en el detalle (el resumen es histórico completo)</p>

  <h2>Resumen</h2>
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Facturado</div><div class="kpi-value">${formatCurrency(data.summary.total_expected)}</div></div>
    <div class="kpi"><div class="kpi-label">Cobrado</div><div class="kpi-value">${formatCurrency(data.summary.total_settled)}</div></div>
    <div class="kpi"><div class="kpi-label">Saldo pendiente</div><div class="kpi-value">${formatCurrency(data.summary.total_open)}</div></div>
    <div class="kpi"><div class="kpi-label">Mora aplicada</div><div class="kpi-value">${formatCurrency(data.summary.total_late_fees)}</div></div>
  </div>

  <h2>Meses (últimos ${months})</h2>
  <table><thead><tr><th>Período</th><th>Estado</th></tr></thead><tbody>${mesesRows}</tbody></table>

  <h2>Detalle — pagos y sesiones</h2>
  <table><thead><tr><th>Fecha</th><th>Tipo</th><th>Estado</th><th>Monto</th></tr></thead><tbody>${eventRows}</tbody></table>

  <div class="footer">SportMaps — Estado de cuenta generado automáticamente.</div>
</body></html>`;
}

/**
 * Abre la ventana de impresión. Devuelve false si el navegador (o el visor de
 * la app) bloqueó la ventana: quien llama decide cómo avisarle a la persona.
 */
export function printStatement(data: StatementData, months: number): boolean {
  let win: Window | null = null;
  try {
    win = window.open('', '_blank');
  } catch {
    win = null;
  }
  if (!win) return false;
  win.document.write(buildStatementPrintHtml(data, months));
  win.document.close();
  const w = win;
  setTimeout(() => {
    try { w.print(); } catch { /* algunos visores bloquean print(): queda la ventana para imprimir a mano */ }
  }, 400);
  return true;
}
