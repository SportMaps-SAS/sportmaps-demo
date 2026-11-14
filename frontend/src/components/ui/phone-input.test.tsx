import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PhoneInput, isValidPhone } from './phone-input';

describe('isValidPhone', () => {
  it('acepta E.164 de 8 a 15 dígitos', () => {
    expect(isValidPhone('+573001234567')).toBe(true);
    expect(isValidPhone('+12345678')).toBe(true);
    expect(isValidPhone('+123456789012345')).toBe(true);
  });
  it('rechaza cortos, largos, sin + o vacíos', () => {
    expect(isValidPhone('+1234567')).toBe(false);
    expect(isValidPhone('+1234567890123456')).toBe(false);
    expect(isValidPhone('573001234567')).toBe(false);
    expect(isValidPhone('')).toBe(false);
    expect(isValidPhone(undefined)).toBe(false);
  });
});

describe('PhoneInput validación suave', () => {
  it('muestra «Número incompleto» con dígitos pero total < 8', () => {
    render(<PhoneInput value="+57300" onChange={vi.fn()} />);
    expect(screen.getByText('Número incompleto')).toBeInTheDocument();
  });
  it('no muestra error con el campo vacío ni con número válido', () => {
    const { rerender } = render(<PhoneInput value="+57" onChange={vi.fn()} />);
    expect(screen.queryByText('Número incompleto')).toBeNull();
    rerender(<PhoneInput value="+573001234567" onChange={vi.fn()} />);
    expect(screen.queryByText('Número incompleto')).toBeNull();
  });
  it('muestra error con más de 15 dígitos', () => {
    render(<PhoneInput value="+5730012345678901" onChange={vi.fn()} />);
    expect(screen.getByText('Número incompleto')).toBeInTheDocument();
  });
  it('showValidation={false} lo desactiva', () => {
    render(<PhoneInput value="+57300" onChange={vi.fn()} showValidation={false} />);
    expect(screen.queryByText('Número incompleto')).toBeNull();
  });
});
