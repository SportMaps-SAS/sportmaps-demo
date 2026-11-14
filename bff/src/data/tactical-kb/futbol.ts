/** Base táctica — fútbol 11. Ver types.ts. */
import { DEFAULT_MOMENT_LABELS, type SportKnowledge } from './types';

export const FUTBOL_KB: SportKnowledge = {
  sport: 'futbol',
  version: 'futbol-2026-10-27',
  momentLabels: DEFAULT_MOMENT_LABELS,
  momentos: {
    ataque_organizado: [
      'Amplitud y profundidad: alguien fija cada banda y alguien amenaza la espalda de la defensa.',
      'Superioridad por dentro (3 contra 2 en el medio) y apoyos a la altura y detrás del balón.',
      'Atacar el espacio que deja el rival al salir a presionar; cambiar de orientación si una banda se cierra.',
    ],
    transicion_def_atq: [
      'Primer pase hacia adelante, lejos de la zona de presión, si el rival quedó desordenado.',
      'Si no hay ventaja, asegurar la posesión y reorganizar (no regalar el balón).',
      'Carreras en diagonal hacia el arco para estirar a la defensa rival.',
    ],
    defensa_organizada: [
      'Bloque compacto (unos 30-35 m entre la defensa y la delantera) y líneas que basculan juntas hacia el balón.',
      'Cerrar el centro primero y orientar al rival hacia la banda; cobertura y permuta detrás del que presiona.',
      'Decidir la altura del bloque (alto, medio, bajo) según la salida del rival.',
    ],
    transicion_atq_def: [
      'Presión inmediata los primeros segundos tras perder para recuperar o frenar el contraataque.',
      'Balance defensivo: al atacar quedan al menos 2-3 jugadores (centrales + un volante) para el contraataque.',
      'Repliegue por dentro, cerrando primero el carril central y la espalda de los laterales que subieron.',
    ],
    balon_parado: [
      'Corners y tiros libres: bloqueos, primer y segundo palo, alguien al rechace al borde del área.',
      'En defensa: marca mixta (zonal en el primer palo + individual a los cabeceadores) y dos para el contraataque.',
      'Saques de banda rápidos para aprovechar al rival desordenado.',
    ],
  },
  formaciones: [
    {
      key: '4-3-3', label: '4-3-3', lines: [4, 3, 3],
      fortalezas: ['Amplitud natural con los extremos y presión alta con tres puntas.', 'Triángulos en el medio para salir jugando.'],
      debilidades: ['Volante de contención solo: espacio a sus lados si los interiores suben.', 'Laterales expuestos si los extremos no repliegan.'],
    },
    {
      key: '4-4-2', label: '4-4-2', lines: [4, 4, 2],
      fortalezas: ['Dos líneas de cuatro muy equilibradas: fácil de enseñar y de bascular.', 'Dos delanteros para presionar la salida y atacar el área.'],
      debilidades: ['Inferioridad en el medio contra tres volantes.', 'Espacio entre líneas si los dos medios centrales se separan.'],
    },
    {
      key: '4-2-3-1', label: '4-2-3-1', lines: [4, 2, 3, 1],
      fortalezas: ['Doble pivote protege a los centrales y da salida limpia.', 'Media punta y extremos llenan el espacio entre líneas.'],
      debilidades: ['Delantero aislado si los de atrás no llegan.', 'Si el doble pivote sube, contraataque por el centro.'],
    },
    {
      key: '4-1-4-1', label: '4-1-4-1', lines: [4, 1, 4, 1],
      fortalezas: ['Muy compacto en defensa: dos líneas de cuatro con un pivote delante de la defensa.', 'Interiores que llegan al área.'],
      debilidades: ['Pocos jugadores arriba para presionar alto.', 'El pivote queda solo si lo fijan o lo sobrecargan.'],
    },
    {
      key: '4-5-1', label: '4-5-1', lines: [4, 5, 1],
      fortalezas: ['Domina el medio y cierra espacios.', 'Bueno para defender ventajas.'],
      debilidades: ['Poca presencia en el área rival.', 'Contraataques lentos si el punta no aguanta el balón.'],
    },
    {
      key: '4-4-1-1', label: '4-4-1-1', lines: [4, 4, 1, 1],
      fortalezas: ['Segundo delantero que conecta el medio con la punta.', 'Bloque de 4-4 sólido.'],
      debilidades: ['El segundo punta debe defender al pivote rival o queda inferioridad en el medio.'],
    },
    {
      key: '3-5-2', label: '3-5-2', lines: [3, 5, 2],
      fortalezas: ['Superioridad en el medio y dos puntas.', 'Carrileros dan amplitud sin quitar jugadores del centro.'],
      debilidades: ['Espalda de los carrileros: el rival ataca las bandas en transición.', 'Tres centrales contra un solo punta sobran.'],
    },
    {
      key: '3-4-3', label: '3-4-3', lines: [3, 4, 3],
      fortalezas: ['Muy ofensivo: tres puntas y carrileros para presionar arriba.', 'Muchas líneas de pase en ataque.'],
      debilidades: ['Medio de dos que se queda en inferioridad.', 'Bandas expuestas si los carrileros no regresan.'],
    },
    {
      key: '5-3-2', label: '5-3-2', lines: [5, 3, 2],
      fortalezas: ['Defensa del área muy sólida con cinco atrás.', 'Contraataque con dos puntas.'],
      debilidades: ['Cede el balón y el campo.', 'Si los carrileros no suben, el ataque es pobre.'],
    },
    {
      key: '5-4-1', label: '5-4-1', lines: [5, 4, 1],
      fortalezas: ['Bloque bajo casi impenetrable.', 'Ideal para cuidar un resultado.'],
      debilidades: ['Muy poco ataque; el punta pelea solo.', 'Invita a centros y remates de media distancia.'],
    },
    {
      key: '4-3-1-2', label: '4-3-1-2', lines: [4, 3, 1, 2],
      fortalezas: ['Rombo con enganche: juego interior y dos puntas.', 'Superioridad por el centro.'],
      debilidades: ['Sin extremos: la amplitud depende de los laterales.', 'Bandas vulnerables en defensa.'],
    },
    {
      key: '4-1-2-1-2', label: '4-1-2-1-2 (rombo)', lines: [4, 1, 2, 1, 2],
      fortalezas: ['Rombo: control del centro y apoyos cortos.', 'Dos puntas y un enganche cerca del área.'],
      debilidades: ['Estrecho: las bandas quedan para los laterales.', 'Los interiores sufren basculando a banda.'],
    },
  ],
};
