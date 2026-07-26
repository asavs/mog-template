import { describe, expect, it } from 'vitest';
import { SLOT_BINDINGS } from '../actions/defs.generated';
import { KEY_BINDINGS, MOUSE_BINDINGS, keyBindingFor, mouseBindingFor } from './keymap';

function allSlotRows() {
  return [
    ...KEY_BINDINGS.filter(row => row.binding.kind === 'slot'),
    ...MOUSE_BINDINGS,
  ];
}

describe('keymap data sanity', () => {
  it('binds every slot the action pipeline defines, exactly once', () => {
    const counts = new Map<string, number>();
    for (const row of allSlotRows()) {
      const slot = (row.binding as { slot: string }).slot;
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }

    for (const binding of SLOT_BINDINGS) {
      expect(counts.get(binding.slot), `slot "${binding.slot}" should be bound exactly once`).toBe(1);
    }
  });

  it('never binds a slot the action pipeline does not define', () => {
    const known = new Set(SLOT_BINDINGS.map(binding => binding.slot));
    for (const row of allSlotRows()) {
      const slot = (row.binding as { slot: string }).slot;
      expect(known.has(slot), `keymap binds unknown slot "${slot}"`).toBe(true);
    }
  });

  it('binds all four movement axes and jump exactly once', () => {
    const axes = KEY_BINDINGS.filter(row => row.binding.kind === 'movement');
    expect(axes).toHaveLength(4);
    const seen = new Set(axes.map(row => (row.binding as { axis: string }).axis));
    expect(seen).toEqual(new Set(['forward', 'backward', 'left', 'right']));

    const jumps = KEY_BINDINGS.filter(row => row.binding.kind === 'jump');
    expect(jumps).toHaveLength(1);
  });

  it('does not bind sprint by default (documented gap, not an oversight)', () => {
    for (const row of KEY_BINDINGS) {
      if (row.binding.kind === 'slot') {
        expect(row.binding.slot).not.toBe('sprint');
      }
    }
  });

  it('looks up bindings by code and by mouse button', () => {
    expect(keyBindingFor('KeyW')).toEqual({ kind: 'movement', axis: 'forward' });
    expect(keyBindingFor('Nonexistent')).toBeUndefined();
    expect(mouseBindingFor(0)).toEqual({ kind: 'slot', slot: 'primary' });
    expect(mouseBindingFor(2)).toEqual({ kind: 'slot', slot: 'block' });
    expect(mouseBindingFor(1)).toBeUndefined();
  });
});
