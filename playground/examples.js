// Sample SVGs offered under the input. Each one converts with the lite build (no <style> CSS);
// smoke-test.mjs converts them all and checks the warnings each one is meant to show.

const GRADIENT = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <defs>
    <linearGradient id="bg" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7C4DFF"/>
      <stop offset="1" stop-color="#00C2FF"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse"
        gradientTransform="translate(15 11) scale(26)">
      <stop stop-color="#FFFFFF" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="4" y="4" width="40" height="40" rx="11" fill="url(#bg)"/>
  <rect x="4" y="4" width="40" height="40" rx="11" fill="url(#glow)"/>
  <path d="M26.5 10 15 27h7.5l-1 11L33 21h-7.5z" fill="#FFFFFF"/>
</svg>
`;

const STROKE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="10.5" cy="10.5" r="6.5"/>
  <line x1="15.5" y1="15.5" x2="21" y2="21"/>
  <path d="M8 10.5a2.5 2.5 0 0 1 2.5-2.5"/>
</svg>
`;

const CLIP = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <defs>
    <clipPath id="round">
      <circle cx="24" cy="24" r="20"/>
    </clipPath>
  </defs>
  <g clip-path="url(#round)">
    <rect width="48" height="48" fill="#FFD9A0"/>
    <circle cx="31" cy="17" r="6" fill="#FF8A3D"/>
    <path d="M0 42 15 22l9 12 6-7 18 22H0z" fill="#2E7D5B"/>
    <path d="M0 48 19 31l29 17z" fill="#1F5C43"/>
  </g>
</svg>
`;

const UNSUPPORTED = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <defs>
    <filter id="blur">
      <feGaussianBlur stdDeviation="2"/>
    </filter>
  </defs>
  <circle cx="24" cy="27" r="16" fill="#000000" opacity="0.25" filter="url(#blur)"/>
  <circle cx="24" cy="22" r="16" fill="#FF5A5F"/>
  <text x="24" y="26.5" font-size="11" font-weight="700" text-anchor="middle" fill="#FFFFFF">NEW</text>
</svg>
`;

// An existing Android drawable (the Material "favorite" shape): read as is, shown as Compose or SVG.
const DRAWABLE = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFE53935"
        android:pathData="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41 0.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
</vector>
`;

/** `fileName` is the name the download gets, as if the sample had been opened from a file. */
export const EXAMPLES = [
    { id: 'gradient', label: 'Gradient icon', fileName: 'gradient-icon.svg', svg: GRADIENT },
    { id: 'stroke', label: 'Stroke icon', fileName: 'search.svg', svg: STROKE },
    { id: 'clip', label: 'Clip path', fileName: 'landscape.svg', svg: CLIP },
    { id: 'unsupported', label: 'Text and filter', fileName: 'badge-new.svg', svg: UNSUPPORTED },
    { id: 'drawable', label: 'Android drawable', fileName: 'ic_favorite.xml', svg: DRAWABLE },
];
