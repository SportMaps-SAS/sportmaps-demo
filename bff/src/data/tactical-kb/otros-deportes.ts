/** Base táctica — voleibol, baloncesto y balonmano. Ver types.ts. */
import { DEFAULT_MOMENT_LABELS, type SportKnowledge } from './types';

export const VOLEIBOL_KB: SportKnowledge = {
  sport: 'voleibol',
  version: 'voleibol-2026-10-27',
  // En voleibol los «momentos» se nombran por fase del rally.
  momentLabels: {
    ataque_organizado: 'Ataque tras recepción (K1, side-out)',
    transicion_def_atq: 'Contraataque tras defensa (K2, transición)',
    defensa_organizada: 'Bloqueo y defensa',
    transicion_atq_def: 'Cobertura del ataque y recomposición',
    balon_parado: 'Saque y recepción del saque',
  },
  momentos: {
    ataque_organizado: [
      'Recepción alta y al centro (zona 2-3) para que el armador tenga todas las opciones.',
      'Ataque rápido del central para fijar el bloqueo y punta u opuesto con bloqueo de uno.',
    ],
    transicion_def_atq: [
      'Defensa alta al centro de la cancha propia; si el armador defendió, arma el líbero o el opuesto.',
      'Balón alto a la punta cuando la defensa sale mala; no forzar el rápido.',
    ],
    defensa_organizada: [
      'Bloqueo que cierra la diagonal y defensa que lee el hueco que deja (sistema con zona 6 adelantada o atrás).',
      'Un jugador para el balón tocado o la finta detrás del bloqueo.',
    ],
    transicion_atq_def: [
      'Cobertura del atacante en semicírculo, bajos, para el balón bloqueado.',
      'Volver rápido a la base de defensa antes del ataque rival.',
    ],
    balon_parado: [
      'Saque tenso a zonas de conflicto (entre receptores, zona 1 o 5) o al jugador que acaba de entrar.',
      'Formación de recepción que esconde al armador y deja la mayor parte al líbero y a los receptores fuertes.',
    ],
  },
  formaciones: [
    {
      key: 'vb-rotacion', label: 'Rotación base (zonas 1-6)',
      fortalezas: ['Posiciones reglamentarias claras para enseñar rotación.'],
      debilidades: ['No es formación de recepción: sin ajustes, el armador recibe el saque.'],
    },
    {
      key: 'vb-recepcion-w', label: 'Recepción en W',
      fortalezas: ['Cinco receptores cubren toda la cancha: buena para equipos en formación.', 'El armador queda libre para armar.'],
      debilidades: ['Huecos entre las filas de la W para saques tensos o flotantes.', 'Más jugadores que coordinar: choques en zonas de conflicto.'],
    },
  ],
};

export const BALONCESTO_KB: SportKnowledge = {
  sport: 'baloncesto',
  version: 'baloncesto-2026-10-27',
  momentLabels: { ...DEFAULT_MOMENT_LABELS, balon_parado: 'Saques de banda y de fondo' },
  momentos: {
    ataque_organizado: [
      'Espaciado (5 abiertos o 4 fuera y 1 dentro) y bloqueo directo para generar ventaja.',
      'Atacar la ayuda: pase extra al que queda libre.',
    ],
    transicion_def_atq: [
      'Rebote, pase de salida rápido y tres carriles llenos.',
      'Tráiler que llega para el tiro o el bloqueo en transición.',
    ],
    defensa_organizada: [
      'Ver balón y hombre; ayudas desde el lado débil y rotación.',
      'Cerrar el rebote defensivo (bloqueo de rebote).',
    ],
    transicion_atq_def: [
      'Tras el tiro, uno o dos regresan de una vez para frenar el balón.',
      'Proteger primero el aro, luego emparejar.',
    ],
    balon_parado: ['Saques de fondo y de banda con bloqueos indirectos ensayados.', 'En defensa, cambiar en bloqueos lejos del balón.'],
  },
  formaciones: [
    {
      key: 'bk-2-3', label: 'Zona 2-3',
      fortalezas: ['Protege la pintura y el rebote.', 'Fácil para equipos con pívots altos.'],
      debilidades: ['Tiros desde las esquinas y el poste alto libres.', 'Sufre contra buen pase y tiro exterior.'],
    },
    {
      key: 'bk-1-3-1', label: 'Zona 1-3-1',
      fortalezas: ['Presiona al base y cierra el poste alto.', 'Provoca trampas en las bandas.'],
      debilidades: ['Esquinas y rebote débil.', 'El jugador del fondo cubre mucho espacio.'],
    },
  ],
};

export const BALONMANO_KB: SportKnowledge = {
  sport: 'balonmano',
  version: 'balonmano-2026-10-27',
  momentLabels: { ...DEFAULT_MOMENT_LABELS, balon_parado: 'Golpes francos y 7 m' },
  momentos: {
    ataque_organizado: [
      'Circulación rápida de balón y cruces para fijar a dos defensores.',
      'Pivote que bloquea y abre espacio a los laterales; extremos fijando el ancho.',
    ],
    transicion_def_atq: [
      'Primera oleada: extremos que salen tras la parada o la pérdida rival.',
      'Segunda oleada con laterales y central antes de que la defensa se arme.',
    ],
    defensa_organizada: [
      'Desplazamientos laterales coordinados y ayudas al compañero que sale.',
      'Contacto al pivote y salir a los lanzadores de 9 m.',
    ],
    transicion_atq_def: [
      'Repliegue rápido al área; el más cercano frena al que sale en contraataque.',
      'Cambios de ataque-defensa rápidos si hay especialistas.',
    ],
    balon_parado: ['Golpes francos tras el pitazo final con bloqueo ensayado.', 'En el 7 m, variar el lanzamiento según el portero.'],
  },
  formaciones: [
    {
      key: 'bm-6-0', label: 'Defensa 6-0',
      fortalezas: ['Cierra el área y los lanzamientos de cerca.', 'Fácil de coordinar en línea.'],
      debilidades: ['Lanzamientos de 9 m libres si nadie sale.', 'Pasiva contra buenos lanzadores exteriores.'],
    },
    {
      key: 'bm-5-1', label: 'Defensa 5-1',
      fortalezas: ['El avanzado corta la circulación y presiona al central.', 'Provoca pérdidas para el contraataque.'],
      debilidades: ['Espacio a la espalda del avanzado para el pivote.', 'Exige mucha comunicación.'],
    },
  ],
};
