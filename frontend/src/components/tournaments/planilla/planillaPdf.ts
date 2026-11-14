/** Dibuja una PlanillaModel en un PDF A4 (jsPDF, cargado solo al imprimir). */
import type { PlanillaBlock, PlanillaModel } from './planillaModel';

type Doc = import('jspdf').jsPDF;

const M = 10;          // margen (mm)
const ROW = 6;         // alto de fila
const TITLE = 6;       // alto del título de un bloque
const GAP = 4;

function fit(doc: Doc, text: string, width: number): string {
  if (!text) return '';
  if (doc.getTextWidth(text) <= width) return text;
  let t = text;
  while (t.length > 1 && doc.getTextWidth(`${t}…`) > width) t = t.slice(0, -1);
  return `${t}…`;
}

function drawBlock(doc: Doc, b: PlanillaBlock, x: number, y: number, w: number, pageH: number, newPage: () => number): number {
  const total = b.widths.reduce((a, v) => a + v, 0) || 1;
  const cols = b.widths.map((v) => (v / total) * w);
  const headRow = (yy: number) => {
    doc.setFillColor(235, 238, 242);
    doc.rect(x, yy, w, ROW, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
    let cx = x;
    b.columns.forEach((c, i) => { doc.text(fit(doc, c, cols[i] - 2), cx + 1, yy + 4.2); cx += cols[i]; });
    doc.rect(x, yy, w, ROW);
    return yy + ROW;
  };
  if (y + TITLE + ROW * 2 > pageH - M) y = newPage();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text(fit(doc, b.title, w), x, y + 4);
  y += TITLE;
  if (b.columns.length > 1 || b.columns[0]) y = headRow(y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  for (let r = 0; r < b.rows; r++) {
    if (y + ROW > pageH - M) { y = newPage(); y = headRow(y); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); }
    let cx = x;
    for (let c = 0; c < cols.length; c++) {
      doc.rect(cx, y, cols[c], ROW);
      const v = b.prefill?.[r]?.[c];
      if (v) doc.text(fit(doc, v, cols[c] - 2), cx + 1, y + 4.2);
      cx += cols[c];
    }
    y += ROW;
  }
  return y;
}

export function renderPlanilla(doc: Doc, model: PlanillaModel): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const W = pageW - 2 * M;
  const newPage = () => { doc.addPage(); return M; };

  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(model.title, M, M + 5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
  doc.text('SportMaps · planilla oficial del partido', pageW - M, M + 5, { align: 'right' });
  let y = M + 9;

  // Encabezado: dos columnas de «etiqueta: valor» (en blanco = línea para escribir).
  const colW = W / 2;
  model.header.forEach(([label, value], i) => {
    const cx = M + (i % 2) * colW;
    const cy = y + Math.floor(i / 2) * 7;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text(`${label}:`, cx, cy + 4.5);
    const lw = doc.getTextWidth(`${label}: `);
    doc.setFont('helvetica', 'normal');
    if (value) doc.text(fit(doc, value, colW - lw - 4), cx + lw, cy + 4.5);
    doc.setDrawColor(160); doc.line(cx + lw, cy + 5.5, cx + colW - 4, cy + 5.5); doc.setDrawColor(0);
  });
  y += Math.ceil(model.header.length / 2) * 7 + GAP;

  for (let i = 0; i < model.blocks.length; i++) {
    const b = model.blocks[i];
    const pair = b.half && model.blocks[i + 1]?.half ? model.blocks[i + 1] : null;
    if (pair) {
      const half = (W - GAP) / 2;
      const startPage = doc.getNumberOfPages();
      const y1 = drawBlock(doc, b, M, y, half, pageH, newPage);
      const pageAfterFirst = doc.getNumberOfPages();
      if (pageAfterFirst !== startPage) {
        // El primero no cupo entero: el segundo va debajo, no al lado.
        y = drawBlock(doc, pair, M, y1 + GAP, W, pageH, newPage) + GAP;
      } else {
        const y2 = drawBlock(doc, pair, M + half + GAP, y, half, pageH, newPage);
        y = Math.max(y1, y2) + GAP;
      }
      i++;
    } else {
      y = drawBlock(doc, b, M, y, W, pageH, newPage) + GAP;
    }
  }

  // Firmas
  if (y + 18 > pageH - M) y = newPage();
  y += 10;
  const sw = W / model.signatures.length;
  doc.setFontSize(8);
  model.signatures.forEach((s, i) => {
    const cx = M + i * sw;
    doc.line(cx + 3, y, cx + sw - 3, y);
    doc.text(fit(doc, s, sw - 6), cx + sw / 2, y + 4, { align: 'center' });
  });
}

export async function downloadPlanilla(model: PlanillaModel, fileName: string): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  renderPlanilla(doc, model);
  doc.save(fileName);
}
