/**
 * POI catalog v1 (requirements "Map catalog v1").
 *
 * Rendering: every value under CATALOG_POI_KEYS is imported and eligible in tiles (generic icon
 * fallback for values without a dedicated icon). Runtime Overpass selection is bounded by the
 * finite VALUE_ALLOWLIST below plus fixed presets; client input never becomes raw QL.
 */
export const CATALOG_VERSION = 'seyra-catalog-1.0.0';

export const CATALOG_POI_KEYS = [
  'amenity',
  'shop',
  'tourism',
  'leisure',
  'office',
  'healthcare',
  'craft',
  'historic',
  'emergency',
  'public_transport',
] as const;
export type CatalogPoiKey = (typeof CATALOG_POI_KEYS)[number];

/** Finite allowlist for the key/value selector of the bounded POI endpoint. */
export const VALUE_ALLOWLIST: Readonly<Record<CatalogPoiKey, readonly string[]>> = Object.freeze({
  amenity: [
    'atm', 'bank', 'bar', 'bench', 'bicycle_parking', 'bus_station', 'cafe', 'car_rental', 'car_wash',
    'charging_station', 'cinema', 'clinic', 'college', 'community_centre', 'courthouse', 'dentist',
    'doctors', 'drinking_water', 'driving_school', 'embassy', 'fast_food', 'fire_station', 'food_court',
    'fountain', 'fuel', 'hospital', 'ice_cream', 'kindergarten', 'library', 'marketplace', 'mosque',
    'nursing_home', 'parking', 'pharmacy', 'place_of_worship', 'police', 'post_box', 'post_office',
    'prison', 'pub', 'public_bath', 'recycling', 'restaurant', 'school', 'shelter', 'social_facility',
    'taxi', 'telephone', 'theatre', 'toilets', 'townhall', 'university', 'veterinary', 'waste_disposal',
  ],
  shop: [
    'bakery', 'beauty', 'bicycle', 'books', 'butcher', 'car', 'car_parts', 'car_repair', 'chemist',
    'clothes', 'computer', 'confectionery', 'convenience', 'cosmetics', 'department_store', 'electronics',
    'florist', 'furniture', 'gift', 'greengrocer', 'hairdresser', 'hardware', 'jewelry', 'kiosk',
    'mall', 'mobile_phone', 'motorcycle', 'optician', 'pastry', 'shoes', 'sports', 'stationery',
    'supermarket', 'tailor', 'tyres', 'variety_store',
  ],
  tourism: [
    'apartment', 'attraction', 'camp_site', 'guest_house', 'hostel', 'hotel', 'information', 'motel',
    'museum', 'picnic_site', 'viewpoint', 'zoo',
  ],
  leisure: [
    'fitness_centre', 'garden', 'park', 'pitch', 'playground', 'sports_centre', 'stadium',
    'swimming_pool',
  ],
  office: ['company', 'educational_institution', 'government', 'insurance', 'lawyer', 'ngo', 'telecommunication'],
  healthcare: ['clinic', 'dentist', 'doctor', 'hospital', 'laboratory', 'pharmacy', 'rehabilitation'],
  craft: ['carpenter', 'electrician', 'plumber', 'shoemaker', 'tailor'],
  historic: ['archaeological_site', 'building', 'castle', 'memorial', 'monument', 'ruins'],
  emergency: ['ambulance_station', 'defibrillator', 'fire_hydrant', 'phone'],
  public_transport: ['platform', 'station', 'stop_position'],
});

export interface PoiPreset {
  readonly id: string;
  readonly label: { readonly fa: string; readonly en: string };
  /** Each filter is an exact key=value pair from the catalog allowlist. */
  readonly filters: readonly { readonly key: CatalogPoiKey; readonly value: string }[];
}

export const POI_PRESETS: readonly PoiPreset[] = Object.freeze([
  { id: 'hospitals', label: { fa: 'بیمارستان', en: 'Hospitals' }, filters: [{ key: 'amenity', value: 'hospital' }, { key: 'healthcare', value: 'hospital' }] },
  { id: 'pharmacies', label: { fa: 'داروخانه', en: 'Pharmacies' }, filters: [{ key: 'amenity', value: 'pharmacy' }, { key: 'healthcare', value: 'pharmacy' }] },
  { id: 'police', label: { fa: 'پلیس', en: 'Police' }, filters: [{ key: 'amenity', value: 'police' }] },
  { id: 'fire_stations', label: { fa: 'آتش‌نشانی', en: 'Fire stations' }, filters: [{ key: 'amenity', value: 'fire_station' }] },
  { id: 'fuel', label: { fa: 'جایگاه سوخت', en: 'Fuel' }, filters: [{ key: 'amenity', value: 'fuel' }] },
  { id: 'parking', label: { fa: 'پارکینگ', en: 'Parking' }, filters: [{ key: 'amenity', value: 'parking' }] },
  { id: 'schools', label: { fa: 'مدرسه', en: 'Schools' }, filters: [{ key: 'amenity', value: 'school' }] },
  {
    id: 'food',
    label: { fa: 'غذا', en: 'Food' },
    filters: [
      { key: 'amenity', value: 'restaurant' },
      { key: 'amenity', value: 'fast_food' },
      { key: 'amenity', value: 'cafe' },
      { key: 'amenity', value: 'food_court' },
    ],
  },
]);

/** POIs drawn from zoom 12; every other catalog POI becomes eligible at zoom 16. */
export const MAJOR_POIS: Readonly<Partial<Record<CatalogPoiKey, readonly string[]>>> = Object.freeze({
  amenity: ['hospital', 'university', 'college', 'fuel', 'police', 'fire_station', 'townhall', 'bus_station', 'place_of_worship', 'mosque', 'courthouse', 'marketplace'],
  healthcare: ['hospital'],
  tourism: ['museum', 'attraction', 'hotel', 'zoo'],
  public_transport: ['station'],
  leisure: ['stadium'],
  historic: ['castle', 'monument', 'archaeological_site'],
  emergency: ['ambulance_station'],
  shop: ['mall', 'department_store'],
});

export function isAllowlisted(key: string, value: string): key is CatalogPoiKey {
  return (CATALOG_POI_KEYS as readonly string[]).includes(key) && VALUE_ALLOWLIST[key as CatalogPoiKey].includes(value);
}
