/**
 * The travel-profile selector.
 *
 * A native radio group inside a fieldset: arrow keys move between profiles,
 * the legend names the group for a screen reader, and the browser does the
 * roving-focus work that a bespoke widget would have to reimplement badly.
 *
 * Changing the selection is a local event. Nothing here queries anything.
 */

import { PROFILE_LABELS, TRAVEL_PROFILES, isTravelProfile } from '../map/traversal.js';
import type { TravelProfile } from '../map/traversal.js';
import { clear, element } from './dom.js';

const RADIO_GROUP_NAME = 'atlas-travel-profile';

export class ProfileSelector {
  private readonly inputs = new Map<TravelProfile, HTMLInputElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (profile: TravelProfile) => void,
  ) {
    this.build();
  }

  private build(): void {
    clear(this.root);
    this.inputs.clear();

    const fieldset = element('fieldset', 'profile-choices');
    const legend = element('legend', 'visually-hidden', 'Travel profile');
    fieldset.append(legend);

    for (const profile of TRAVEL_PROFILES) {
      const label = element('label', 'profile-choice');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = RADIO_GROUP_NAME;
      input.value = profile;
      input.addEventListener('change', () => {
        if (input.checked && isTravelProfile(input.value)) {
          this.onChange(input.value);
        }
      });
      label.append(input, document.createTextNode(PROFILE_LABELS[profile]));
      fieldset.append(label);
      this.inputs.set(profile, input);
    }

    this.root.append(fieldset);
  }

  /** Shows which profile is active, without emitting a change. */
  render(active: TravelProfile): void {
    for (const [profile, input] of this.inputs) {
      input.checked = profile === active;
    }
  }
}
