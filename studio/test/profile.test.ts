// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRAVEL_PROFILES } from '../src/map/traversal.js';
import type { TravelProfile } from '../src/map/traversal.js';
import { ProfileSelector } from '../src/ui/profile.js';

let root: HTMLElement;
let changes: TravelProfile[];
let selector: ProfileSelector;

function radios(): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
}

function click(value: TravelProfile): void {
  const input = radios().find((radio) => radio.value === value);
  if (!input) {
    throw new Error(`no radio for ${value}`);
  }
  input.checked = true;
  input.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  changes = [];
  selector = new ProfileSelector(root, (profile) => changes.push(profile));
  selector.render('motorcar');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProfileSelector', () => {
  it('offers exactly Car, Bicycle and Foot, in that order', () => {
    expect(radios().map((radio) => radio.value)).toEqual([...TRAVEL_PROFILES]);
    expect(root.textContent).toContain('Car');
    expect(root.textContent).toContain('Bicycle');
    expect(root.textContent).toContain('Foot');
  });

  it('is a single labelled radio group', () => {
    // A fieldset with a legend is what lets a screen reader announce the
    // group, and one shared name is what makes the arrow keys work.
    expect(root.querySelector('fieldset')).not.toBeNull();
    expect(root.querySelector('legend')?.textContent).toBe('Travel profile');
    expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);
    for (const radio of radios()) {
      expect(radio.closest('label')).not.toBeNull();
    }
  });

  it('starts on Car', () => {
    expect(radios().find((radio) => radio.checked)?.value).toBe('motorcar');
  });

  it('reports each selection once', () => {
    click('bicycle');
    click('foot');
    expect(changes).toEqual(['bicycle', 'foot']);
  });

  it('renders a selection without reporting a change', () => {
    selector.render('foot');
    expect(radios().find((radio) => radio.checked)?.value).toBe('foot');
    expect(changes).toEqual([]);
  });

  it('never calls the API', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const profile of TRAVEL_PROFILES) {
      click(profile);
    }
    expect(changes).toEqual([...TRAVEL_PROFILES]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
