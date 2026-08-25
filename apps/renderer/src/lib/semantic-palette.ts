import type {
  ConcreteInterfaceThemeId,
  InterfacePreferences,
  SemanticHexColor,
  SemanticPalette,
} from '@openlab/protocol';

export const SEMANTIC_PALETTE_PRESETS = {
  'warm-paper': { neutral: '#6F7975', accent: '#568D78', success: '#3B765B', warning: '#98743B', danger: '#A75C52', info: '#52788E' },
  'cyan-night': { neutral: '#AAB9B4', accent: '#8DCEBD', success: '#79C7A5', warning: '#D5AD69', danger: '#E08B80', info: '#82B7D1' },
  'pure-white': { neutral: '#4F5855', accent: '#244A40', success: '#2F7456', warning: '#8A681F', danger: '#9D403A', info: '#3F6F8A' },
  butter: { neutral: '#747862', accent: '#6C8145', success: '#5F7D4F', warning: '#8A6D2F', danger: '#9F554D', info: '#627A88' },
  ming: { neutral: '#B0B6C4', accent: '#B7C2DF', success: '#84C4A7', warning: '#D9B574', danger: '#E7958D', info: '#8DBCE0' },
  absolutely: { neutral: '#6F7889', accent: '#5E72A1', success: '#4E806B', warning: '#947238', danger: '#AD584F', info: '#567DA4' },
  'ready-to-catch': { neutral: '#687B7B', accent: '#56868B', success: '#4E806D', warning: '#8F7137', danger: '#A9574F', info: '#4F7D96' },
  'angry-whale': { neutral: '#687B83', accent: '#47788D', success: '#4E7F69', warning: '#8E7033', danger: '#C45F55', info: '#47788D' },
  'new-warm-paper': { neutral: '#746E64', accent: '#74644E', success: '#58755F', warning: '#886C3F', danger: '#A2594F', info: '#637989' },
  'cyan-night-contrast': { neutral: '#D4E6DF', accent: '#9CF4E2', success: '#7DE6B5', warning: '#F1C678', danger: '#FF9B90', info: '#8FD5FF' },
  'coral-paper': { neutral: '#816C66', accent: '#AD6253', success: '#4F7C67', warning: '#93703B', danger: '#B14E49', info: '#5F7F92' },
} as const satisfies Record<ConcreteInterfaceThemeId, SemanticPalette>;

const THEME_SURFACES = {
  'warm-paper': ['#FAF9F5', '#FFFEFA'],
  'cyan-night': ['#192724', '#21312E'],
  'pure-white': ['#FFFFFF', '#FFFFFF'],
  butter: ['#FAF9E9', '#FFFEF0'],
  ming: ['#242731', '#2C303B'],
  absolutely: ['#F8F9FC', '#FFFFFF'],
  'ready-to-catch': ['#F7FBFA', '#FDFFFE'],
  'angry-whale': ['#F8FBFB', '#FFFFFF'],
  'new-warm-paper': ['#F8F5EE', '#FCFAF4'],
  'cyan-night-contrast': ['#0A211E', '#0F2A26'],
  'coral-paper': ['#FFF9F5', '#FFFDFB'],
} as const satisfies Record<ConcreteInterfaceThemeId, readonly [SemanticHexColor, SemanticHexColor]>;

export function resolveSemanticPalette(
  preferences: Pick<InterfacePreferences, 'semanticPaletteOverrides'>,
  theme: ConcreteInterfaceThemeId,
): SemanticPalette {
  return { ...SEMANTIC_PALETTE_PRESETS[theme], ...preferences.semanticPaletteOverrides[theme] };
}

function relativeLuminance(color: SemanticHexColor): number {
  const channels = color.slice(1).match(/.{2}/gu)?.map((value) => Number.parseInt(value, 16) / 255) ?? [0, 0, 0];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(left: SemanticHexColor, right: SemanticHexColor): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function minimumSemanticContrast(color: SemanticHexColor, theme: ConcreteInterfaceThemeId): number {
  return Math.min(...THEME_SURFACES[theme].map((surface) => contrastRatio(color, surface)));
}
