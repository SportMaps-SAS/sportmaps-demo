import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarksScorer } from './MarksScorer';
import { POINTS_8, type MarkEntry } from '@/lib/tournamentMarks';

function Harness() {
  const [entries, setEntries] = useState<MarkEntry[]>([
    { participant_id: 'a', name: 'Ana', marks: [] }, { participant_id: 'b', name: 'Bea', marks: [] }, { participant_id: 'c', name: 'Caro', marks: [] },
  ]);
  return <MarksScorer title="100 m" unit="time" entries={entries} onChange={setEntries} pointsByPosition={POINTS_8} />;
}

describe('<MarksScorer />', () => {
  it('carga tiempos, ordena solo y deja al DNS sin posición', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Intento 1 de Ana'), { target: { value: '12,40' } });
    fireEvent.change(screen.getByLabelText('Intento 1 de Bea'), { target: { value: '12.1' } });
    fireEvent.change(screen.getByLabelText('Estado de Caro'), { target: { value: 'dns' } });
    expect(screen.getByTestId('pos-b').textContent).toContain('1.º');
    expect(screen.getByTestId('pos-b').textContent).toContain('10 pts');
    expect(screen.getByTestId('pos-a').textContent).toContain('2.º');
    expect(screen.getByTestId('pos-c').textContent).toContain('—');
  });
});
