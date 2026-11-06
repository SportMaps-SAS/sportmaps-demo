// Une las partes grabadas en un solo video por manual, con su .srt (2026-11-04).
// Un video por PDF: manual-acudiente-v2, manual-deportista-v2 y manual-entrenador-v2.
// Las partes quedan en trabajo/video-raw-partes (ignorado por git).
//
//   node docs/manuales/_src/manuales-v2-video/unir.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repo } from '../_video/lib.mjs';
import { here } from './comun.mjs';

const MANUALES = {
  'manual-acudiente-v2': ['acudiente-1-inicio-y-calendario', 'acudiente-2-hijos', 'acudiente-3-partidos-y-convocatorias', 'acudiente-4-pagos', 'acudiente-5-unirse-con-el-codigo'],
  'manual-deportista-v2': ['deportista-1-hoy-y-entrenos', 'deportista-2-progreso-y-carnet', 'deportista-3-pagos', 'deportista-4-mas-y-ayuda'],
  'manual-entrenador-v2': ['entrenador-1-hoy-y-equipos', 'entrenador-2-partidos', 'entrenador-3-sesiones', 'entrenador-4-asistencia', 'entrenador-5-calendario', 'entrenador-6-planillas-y-mas'],
};
const LOCAL = process.env.LOCALAPPDATA || '';
const bin = (n) => { const p = path.join(LOCAL, 'ffmpeg', 'bin', n + '.exe'); return fs.existsSync(p) ? p : n; };
const VID = path.join(repo, 'docs/manuales/video');
const PARTES = path.join(here, 'trabajo', 'video-raw-partes'); fs.mkdirSync(PARTES, { recursive: true });

// Las partes recien grabadas salen en video/: se mueven a trabajo/partes.
for (const partes of Object.values(MANUALES)) for (const p of partes) for (const ext of ['.mp4', '.srt']) {
  const de = path.join(VID, p + ext);
  if (fs.existsSync(de)) fs.renameSync(de, path.join(PARTES, p + ext));
}

const seg = (f) => Number(execFileSync(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
const aMs = (t) => { const [h, m, r] = t.split(':'); const [s, ms] = r.split(','); return (+h * 3600 + +m * 60 + +s) * 1000 + +ms; };
const aSrt = (ms) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');

/** Frases de hasta 120 letras, cortando en punto, dos puntos o coma: más largas no caben en la franja. */
function partir(frase, max = 120) {
  if (frase.length <= max) return [frase];
  const piezas = frase.match(/[^.:?!,;]+[.:?!,;]*\s*/g) ?? [frase];
  const tramos = []; let actual = '';
  for (const p of piezas) {
    if (actual && (actual + p).trim().length > max) { tramos.push(actual.trim()); actual = ''; }
    actual += p;
  }
  if (actual.trim()) tramos.push(actual.trim());
  return tramos;
}

for (const [nombre, partes] of Object.entries(MANUALES)) {
  const faltan = partes.filter((p) => !fs.existsSync(path.join(PARTES, p + '.mp4')));
  if (faltan.length) { console.log(`⏭  ${nombre}: faltan ${faltan.join(', ')}`); continue; }
  const lista = path.join(PARTES, nombre + '.txt');
  fs.writeFileSync(lista, partes.map((p) => `file '${p}.mp4'`).join('\n'));
  const mp4 = path.join(VID, nombre + '.mp4');
  const crudo = path.join(PARTES, nombre + '-crudo.mp4');
  execFileSync(bin('ffmpeg'), ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', crudo], { stdio: 'inherit' });
  let desfase = 0, n = 0; const srt = [];
  for (const p of partes) {
    const texto = fs.readFileSync(path.join(PARTES, p + '.srt'), 'utf8').trim();
    for (const b of texto.split(/\r?\n\r?\n/)) {
      const [, tiempo, ...t] = b.split(/\r?\n/);
      const [a, z] = tiempo.split(' --> ');
      // Cada tramo dura en proporción a sus letras, para que siga a la voz.
      const tramos = partir(t.join(' '));
      const total = tramos.reduce((s, x) => s + x.length, 0);
      let ini = aMs(a); const dur = aMs(z) - ini;
      for (const x of tramos) {
        const fin = ini + dur * (x.length / total);
        srt.push(`${++n}\n${aSrt(Math.round(ini + desfase))} --> ${aSrt(Math.round(fin + desfase))}\n${x}\n`);
        ini = fin;
      }
    }
    desfase += Math.round(seg(path.join(PARTES, p + '.mp4')) * 1000);
  }
  const srtFinal = mp4.replace(/\.mp4$/, '.srt');
  fs.writeFileSync(srtFinal, srt.join('\n'));
  // Se recorta la franja de las partes y se vuelve a poner con los subtítulos ya partidos.
  execFileSync(bin('ffmpeg'), ['-y', '-loglevel', 'error', '-i', crudo,
    '-vf', `crop=780:1560:0:0,pad=780:1860:0:0:color=0x0f2614,subtitles='${path.basename(srtFinal)}':original_size=780x1860:force_style='FontName=Arial,FontSize=7,Bold=1,PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=0,Shadow=0,Alignment=2,MarginL=8,MarginR=8,MarginV=7'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', mp4], { stdio: 'inherit', cwd: VID });
  fs.rmSync(crudo);
  console.log(`✅ ${nombre}.mp4 · ${(desfase / 60000).toFixed(1)} min · ${n} frases`);
}
