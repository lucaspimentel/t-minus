// T-Minus's Astryx theme: the neutral theme plus the app's state colors (CLAUDE.md "Color
// carries state"; the same values as app.css --green / --amber / --red, [light, dark]).
import { defineTheme } from '@astryxdesign/core/theme';
import { themes, defaultThemeSlug } from './astryx-themes.js';

const green = ['#1b7f45', '#4cc47f'];
const amber = ['#a35f00', '#f0a830'];
const red = ['#c62828', '#ff6b6b'];

export const tMinusTheme = defineTheme({
  name: 't-minus',
  extends: themes[defaultThemeSlug],
  tokens: {
    '--color-text-success': green,
    '--color-text-warning': amber,
    '--color-text-error': red,
    '--color-success': green,
    '--color-warning': amber,
    '--color-error': red,
  },
  // Countdown and time colors: <Heading color="success|warning|error">.
  components: {
    heading: {
      'color:success': { color: 'var(--color-text-success)' },
      'color:warning': { color: 'var(--color-text-warning)' },
      'color:error': { color: 'var(--color-text-error)' },
    },
  },
});
