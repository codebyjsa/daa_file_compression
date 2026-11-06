import { type MapPreset } from './graphTypes.ts';
import { CITY_STREET_PRESETS } from './cityStreetGraphs.ts';

export const MAP_PRESETS: MapPreset[] = CITY_STREET_PRESETS;

export const NEW_DELHI_PRESET: MapPreset = CITY_STREET_PRESETS[0];
export const NYC_MANHATTAN_PRESET: MapPreset = CITY_STREET_PRESETS[1];
export const PARIS_ETOILE_PRESET: MapPreset = CITY_STREET_PRESETS[2];
export const BENGALURU_GRID_PRESET: MapPreset = CITY_STREET_PRESETS[3];

// Backwards-compatible aliases
export const CITY_DELIVERY_PRESET: MapPreset = CITY_STREET_PRESETS[0];
export const CAMPUS_NETWORK_PRESET: MapPreset = CITY_STREET_PRESETS[1];
