// The BrewView logo: a cup with a rising bar chart for steam – what's brewing, at a glance.
// The cup takes the text colour (currentColor); the bars use --logo-accent.
export const logoMark = (size = 28) => `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <rect x="8.2" y="9" width="3.2" height="4" rx="1" fill="var(--logo-accent, #e2b04a)"/>
  <rect x="12.9" y="5.5" width="3.2" height="7.5" rx="1" fill="var(--logo-accent, #e2b04a)"/>
  <rect x="17.6" y="2" width="3.2" height="11" rx="1" fill="var(--logo-accent, #e2b04a)"/>
  <path d="M5 15h20v5.5A8.5 8.5 0 0 1 16.5 29h-3A8.5 8.5 0 0 1 5 20.5z" fill="currentColor"/>
  <path d="M25 17.2h1.6a3.4 3.4 0 0 1 0 6.8H24.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

export const logo = (size = 28) => `<span class="logo">${logoMark(size)}<span class="logo-word">Brew<span>View</span></span></span>`;
