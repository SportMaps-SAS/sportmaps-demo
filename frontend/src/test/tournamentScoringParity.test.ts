import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Los motores viven en el BFF y se copian al frontend (cola offline del anotador).
// Si esta prueba falla: copiar el archivo del BFF encima de la copia del frontend.
const norm = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');

describe('motor de marcador: BFF y frontend idénticos', () => {
  it('los dos archivos son iguales', () => {
    expect(norm('../lib/tournamentScoring.ts')).toBe(norm('../../../bff/src/services/tournament/scoring.shared.ts'));
  });
  it('ranking por marca (atletismo): BFF y frontend iguales', () => {
    expect(norm('../lib/tournamentMarks.ts')).toBe(norm('../../../bff/src/services/tournament/marks.shared.ts'));
  });
});
