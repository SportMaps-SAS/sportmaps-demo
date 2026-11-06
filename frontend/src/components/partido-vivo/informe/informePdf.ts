/** PDF A4 del informe (jsPDF, cargado solo al exportar). Logo y color primario de la escuela. */
import type { InformeModel } from './informeModel';

export interface InformeBranding { logoUrl?: string | null; primaryColor?: string | null; schoolName?: string | null }

const M = 15;

function hexToRgb(hex: string | null | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return [30, 64, 120];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function cargarLogo(url: string): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const blob = await (await fetch(url)).blob();
    const data: string = await new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob);
    });
    const dim: { w: number; h: number } = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res({ w: i.width, h: i.height }); i.onerror = rej; i.src = data;
    });
    return { data, ...dim };
  } catch { return null; }
}

export async function generarInformePdf(i: InformeModel, b: InformeBranding = {}): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const [r, g, bl] = hexToRgb(b.primaryColor);
  let y = M;
  const asegura = (h: number) => { if (y + h > H - M) { doc.addPage(); y = M; } };

  // Encabezado con el color de la escuela
  doc.setFillColor(r, g, bl);
  doc.rect(0, 0, W, 26, 'F');
  let x = M;
  const logo = b.logoUrl ? await cargarLogo(b.logoUrl) : null;
  if (logo) {
    const h = 18;
    const w = Math.min(30, (logo.w / logo.h) * h);
    try { doc.addImage(logo.data, 'PNG', M, 4, w, h); x = M + w + 4; } catch { /* sin logo */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.text(i.titulo, x, 13);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.text(i.partido, x, 20);
  doc.setTextColor(0, 0, 0);
  y = 34;

  const par = (k: string, v: string) => {
    asegura(6);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(`${k}:`, M, y);
    doc.setFont('helvetica', 'normal'); doc.text(v, M + 24, y);
    y += 5.5;
  };
  par('Fecha', i.fecha);
  if (i.hora) par('Hora', i.hora);
  par('Partido', i.partido);
  if (i.lugar) par('Lugar', i.lugar);
  par('Resultado', i.resultado);

  const seccion = (titulo: string, lineas: string[], vacio: string) => {
    asegura(14);
    y += 3;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(r, g, bl);
    doc.text(titulo, M, y); y += 1.5;
    doc.setDrawColor(r, g, bl); doc.line(M, y, W - M, y); y += 5;
    doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    for (const l of lineas.length ? lineas : (vacio ? [vacio] : [])) {
      for (const parte of doc.splitTextToSize(l, W - 2 * M) as string[]) { asegura(5); doc.text(parte, M, y); y += 5; }
    }
  };
  seccion('Alineación', i.alineacion, 'Sin titulares');
  seccion('Sustituciones', i.banca, 'Ninguno');
  seccion('Cambios realizados', i.cambios.flatMap((c) => [c.periodo, ...c.lineas.map((l) => `   ${l}`)]), 'Ninguno');
  seccion('Anotaciones', i.anotaciones, 'Ninguna');
  seccion('Goles en contra', i.golesContra, 'Ninguno');
  seccion('Amonestaciones', i.amonestaciones, 'Ninguna');
  seccion('Informe General', i.informeGeneral ? i.informeGeneral.split('\n') : [], '');
  if (i.duracion) seccion('Duración total', [i.duracion], '');
  seccion(
    'Minutos por jugador',
    i.minutos.map((m) => `${m.nombre}${m.dorsal != null ? ` ${m.dorsal}` : ''}: ${m.minutos} min (${m.pct}%)${m.origen ? ` · ${m.origen}` : ''}`),
    'Sin datos',
  );

  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p); doc.setFontSize(8); doc.setTextColor(120, 120, 120);
    doc.text(`${b.schoolName ?? ''} · Powered by SportMaps · ${p}/${n}`, W / 2, H - 6, { align: 'center' });
  }
  return doc.output('blob');
}
