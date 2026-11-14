/** Base táctica — fútbol 7, fútbol 5 y futsal. Ver types.ts. */
import { DEFAULT_MOMENT_LABELS, type SportKnowledge } from './types';

export const FUTBOL7_KB: SportKnowledge = {
  sport: 'futbol7',
  version: 'futbol7-2026-10-27',
  momentLabels: DEFAULT_MOMENT_LABELS,
  momentos: {
    ataque_organizado: [
      'Cancha corta: abrir bien a las bandas para que el rival no cierre el centro.',
      'Arquero como primer pase: salir jugando por los defensas abiertos.',
      'Triángulos de pase y desmarques de apoyo y de ruptura alternados.',
    ],
    transicion_def_atq: [
      'Pocos pases hasta el área: el campo es corto y el rival tarda poco en volver.',
      'El delantero fija a los defensas; los volantes llegan de segunda línea.',
    ],
    defensa_organizada: [
      'Compactar entre líneas y presionar al poseedor con ayuda cercana.',
      'Proteger el centro del área: los remates de media distancia son peligrosos en cancha corta.',
    ],
    transicion_atq_def: [
      'Al perder, presionar ya al poseedor; los demás cierran líneas de pase.',
      'Nunca suben los dos defensas a la vez.',
    ],
    balon_parado: [
      'Corners cortos y jugadas ensayadas simples; uno al rechace.',
      'En defensa, marca individual a los que cabecean y uno cerca del poste.',
    ],
  },
  formaciones: [
    {
      key: 'f7-2-3-1', label: '2-3-1', lines: [2, 3, 1],
      fortalezas: ['Equilibrada: tres en el medio con volantes que dan amplitud.', 'Fácil de enseñar en escuelas.'],
      debilidades: ['Dos defensas expuestos si los volantes de banda no regresan.', 'Delantero solo contra dos defensas.'],
    },
    {
      key: 'f7-3-2-1', label: '3-2-1', lines: [3, 2, 1],
      fortalezas: ['Línea de tres que cubre el ancho; laterales que pueden subir.', 'Sólida contra rivales rápidos.'],
      debilidades: ['Medio de dos en inferioridad contra un 2-3-1.', 'Poca llegada al área.'],
    },
  ],
};

export const FUTBOL5_KB: SportKnowledge = {
  sport: 'futbol5',
  version: 'futbol5-2026-10-27',
  momentLabels: DEFAULT_MOMENT_LABELS,
  momentos: {
    ataque_organizado: [
      'Rotaciones constantes para sacar de posición a la marca; paredes y uno-dos.',
      'Ocupar el ancho: dos abiertos y uno de pivote o arriba.',
    ],
    transicion_def_atq: [
      'Salida rápida en 2 contra 1: conducir hacia un defensor y soltar en el momento justo.',
      'El arquero inicia rápido con la mano hacia el que queda libre.',
    ],
    defensa_organizada: [
      'Defensa en rombo o cuadrado: presión al balón y cobertura en diagonal.',
      'No dejar que giren de cara al arco; cerrar el pase al pívot.',
    ],
    transicion_atq_def: [
      'Siempre un último hombre atrás al atacar.',
      'Tras pérdida, falta táctica lejos del área si el rival queda en superioridad (sin pegar).',
    ],
    balon_parado: [
      'Saques de banda y de esquina con jugadas cortas ensayadas (bloqueo y descarga).',
      'Defender el segundo palo y el rechace.',
    ],
  },
  formaciones: [
    {
      key: 'f5-1-2-1', label: '1-2-1 (rombo)', lines: [1, 2, 1],
      fortalezas: ['Cubre todas las alturas: último, dos alas y pívot.', 'Rotaciones naturales.'],
      debilidades: ['Si el último sube, la espalda queda vacía.', 'El pívot solo depende de que lo encuentren.'],
    },
    {
      key: 'f5-2-2', label: '2-2 (cuadrado)', lines: [2, 2],
      fortalezas: ['Muy sólido atrás con dos defensas.', 'Fácil de cubrir en diagonal.'],
      debilidades: ['Centro vacío entre las dos líneas.', 'Poca profundidad en ataque.'],
    },
  ],
};

export const FUTSAL_KB: SportKnowledge = {
  sport: 'futsal',
  version: 'futsal-2026-10-27',
  momentLabels: DEFAULT_MOMENT_LABELS,
  momentos: {
    ataque_organizado: [
      'Rotaciones 3-1 o 4-0: paralelas, diagonales y bloqueos para generar el 2 contra 1.',
      'Pívot que fija de espaldas y descarga; segundo palo siempre ocupado.',
      'Arquero-jugador (5 contra 4) cuando hace falta el gol.',
    ],
    transicion_def_atq: [
      'Contraataque en 2 contra 1 o 3 contra 2 con carriles separados.',
      'Saque rápido del arquero al ala que se abre.',
    ],
    defensa_organizada: [
      'Presión por zonas (alta, media, en propio campo) según el marcador y el rival.',
      'Cambios de marca ante bloqueos; cierre siempre en cobertura.',
    ],
    transicion_atq_def: [
      'El cierre no pierde su posición; el último en atacar es el primero en defender.',
      'Repliegue en diagonal hacia el centro del área.',
    ],
    balon_parado: [
      'Corners, bandas y tiros libres con jugadas ensayadas (bloqueo y remate al segundo palo).',
      'Defender en zona con uno libre para el rechace; atención al doble penalti.',
    ],
  },
  formaciones: [
    {
      key: 'fs-1-2-1', label: '1-2-1 (rombo / 3-1)', lines: [1, 2, 1],
      fortalezas: ['Base del 3-1: cierre, dos alas y pívot.', 'Buen equilibrio entre ataque y cobertura.'],
      debilidades: ['Si el pívot no aguanta, el equipo no sale.', 'Alas exigidas en ida y vuelta.'],
    },
    {
      key: 'fs-2-2', label: '2-2 (cuadrado)', lines: [2, 2],
      fortalezas: ['Defensa cuadrada muy cubierta.', 'Bueno para iniciar con pases cortos.'],
      debilidades: ['Poca presencia en el área rival.', 'Previsible si no hay rotaciones.'],
    },
  ],
};
