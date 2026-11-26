/**
 * «Zona de juego» del reverso de fútbol (spec carnet-3d-club.md §2 D1, §7).
 *
 * La posición llega como texto libre (la escribe el personal en la inscripción)
 * o como código de alineación ('arquero' | 'defensa' | 'medio' | 'delantero').
 * Acá se traduce a una de las cuatro zonas de la mini cancha, con el lado
 * (izquierda/derecha) cuando el texto lo dice. Sin React.
 *
 * Números de camiseta usados como posición («el 9»): convención clásica
 * sudamericana — 1 arquero · 2, 3, 4 defensa · 5, 6, 8, 10 medio · 7, 9, 11
 * delantero (7 y 11 son extremos).
 */

export type Zona = 'arquero' | 'defensa' | 'medio' | 'delantero';
export type Lado = 'izquierda' | 'centro' | 'derecha';

export interface ZonaDeJuego {
  zona: Zona;
  lado: Lado;
  /** «Arquero», «Defensa», «Medio», «Delantero». */
  etiqueta: string;
}

export const ETIQUETA_ZONA: Record<Zona, string> = {
  arquero: 'Arquero',
  defensa: 'Defensa',
  medio: 'Medio',
  delantero: 'Delantero',
};

// Palabras completas (ya sin tildes, en minúscula). El orden de revisión es
// arquero → medio → delantero → defensa: «mediapunta» es medio aunque diga
// «punta», «volante defensivo» es medio aunque diga «defensivo».
const SINONIMOS: Array<[Zona, string[]]> = [
  ['arquero', ['arquero', 'arquera', 'portero', 'portera', 'guardameta', 'golero', 'golera', 'guardavalla', 'guardavallas', 'gk', 'por', 'pt']],
  ['medio', [
    'medio', 'media', 'medios', 'mediocampista', 'mediocampo', 'mediocentro', 'volante', 'centrocampista',
    'contencion', 'pivote', 'enganche', 'interior', 'mediapunta', 'creativo', 'creativa', 'organizador',
    'organizadora', 'mc', 'mcd', 'mco', 'mi', 'md', 'cm', 'dm', 'am', 'mid', 'cdm', 'cam', 'lm', 'rm',
  ]],
  ['delantero', [
    'delantero', 'delantera', 'atacante', 'punta', 'extremo', 'extrema', 'centrodelantero', 'centrodelantera',
    'ariete', 'goleador', 'goleadora', 'puntero', 'puntera', 'dc', 'del', 'ext', 'st', 'cf', 'fw', 'fwd', 'lw', 'rw',
  ]],
  ['defensa', [
    'defensa', 'defensor', 'defensora', 'defensas', 'central', 'zaguero', 'zaguera', 'lateral', 'carrilero',
    'carrilera', 'libero', 'stopper', 'marcador', 'marcadora', 'df', 'def', 'dfc', 'cb', 'lb', 'rb', 'lwb', 'rwb', 'li', 'ld',
  ]],
];

const IZQUIERDA = new Set(['izquierdo', 'izquierda', 'izq', 'zurdo', 'lb', 'lw', 'lm', 'lwb', 'li', 'mi']);
const DERECHA = new Set(['derecho', 'derecha', 'der', 'diestro', 'rb', 'rw', 'rm', 'rwb', 'ld', 'md']);

const POR_NUMERO: Record<string, { zona: Zona; lado: Lado }> = {
  '1': { zona: 'arquero', lado: 'centro' },
  '2': { zona: 'defensa', lado: 'derecha' },
  '3': { zona: 'defensa', lado: 'izquierda' },
  '4': { zona: 'defensa', lado: 'centro' },
  '5': { zona: 'medio', lado: 'centro' },
  '6': { zona: 'medio', lado: 'centro' },
  '8': { zona: 'medio', lado: 'centro' },
  '10': { zona: 'medio', lado: 'centro' },
  '7': { zona: 'delantero', lado: 'derecha' },
  '9': { zona: 'delantero', lado: 'centro' },
  '11': { zona: 'delantero', lado: 'izquierda' },
};

function tokens(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Posición libre → zona de la mini cancha. null si no se reconoce. */
export function zonaDeJuego(posicion: string | null | undefined): ZonaDeJuego | null {
  if (posicion == null) return null;
  const t = tokens(String(posicion));
  if (t.length === 0) return null;

  let zona: Zona | null = null;
  for (const [z, lista] of SINONIMOS) {
    if (t.some((w) => lista.includes(w))) { zona = z; break; }
  }

  let lado: Lado = 'centro';
  if (t.some((w) => IZQUIERDA.has(w))) lado = 'izquierda';
  else if (t.some((w) => DERECHA.has(w))) lado = 'derecha';

  if (!zona) {
    // «9», «el 9», «#10»: número clásico de la posición.
    const num = t.find((w) => /^[0-9]{1,2}$/.test(w) && POR_NUMERO[String(Number(w))]);
    if (num) {
      const p = POR_NUMERO[String(Number(num))];
      zona = p.zona;
      if (lado === 'centro') lado = p.lado;
    }
  }

  if (!zona) return null;
  if (zona === 'arquero') lado = 'centro';
  return { zona, lado, etiqueta: ETIQUETA_ZONA[zona] };
}

/**
 * Coordenadas del marcador en una cancha vertical de 100 × 140 (arco propio
 * abajo, se ataca hacia arriba).
 */
export function coordenadasZona(z: Pick<ZonaDeJuego, 'zona' | 'lado'>): { x: number; y: number } {
  const y: Record<Zona, number> = { arquero: 128, defensa: 100, medio: 70, delantero: 34 };
  const x: Record<Lado, number> = { izquierda: 24, centro: 50, derecha: 76 };
  return { x: x[z.lado], y: y[z.zona] };
}
