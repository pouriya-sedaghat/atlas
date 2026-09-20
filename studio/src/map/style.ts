/**
 * A blank, entirely local map style.
 *
 * Atlas Studio renders nothing but Atlas data. There is no base map, no tile
 * server and no API key: the background is a flat colour and every visible line
 * comes from the Atlas API.
 */

import type { StyleSpecification } from 'maplibre-gl';

export const BACKGROUND_COLOR = '#0c1017';

export const BLANK_STYLE: StyleSpecification = {
  version: 8,
  name: 'Atlas Blank',
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': BACKGROUND_COLOR },
    },
  ],
};
