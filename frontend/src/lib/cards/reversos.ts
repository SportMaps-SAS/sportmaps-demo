/**
 * Registro de reversos del carnet 3D por deporte (spec §7, D2).
 * Agregar un deporte = agregar una entrada. Lo que no esté registrado cae en
 * `generico`.
 */
import type { ComponentType } from 'react';
import { ReversoFutbol } from '@/components/cards/reversos/ReversoFutbol';
import { ReversoGenerico, type ReversoProps } from '@/components/cards/reversos/ReversoGenerico';

export type { ReversoProps };

export const REVERSOS: Record<string, ComponentType<ReversoProps>> = {
  futbol: ReversoFutbol,
  generico: ReversoGenerico,
};

/** «Fútbol», «FUTBOL», «futbol» → «futbol». */
export function claveDeporte(deporte: string | null | undefined): string {
  return String(deporte ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function reversoPara(deporte: string | null | undefined): ComponentType<ReversoProps> {
  return REVERSOS[claveDeporte(deporte)] ?? REVERSOS.generico;
}
