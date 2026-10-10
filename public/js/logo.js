// The Atlas logo: an "A" drawn like a mountain, with a gold star just above the peak – reaching the top.
// The mountain takes the text colour (currentColor); the star uses --logo-accent.
export const logoMark = (size = 28) => `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <path d="M3.5 29L14.3 9.2a2 2 0 0 1 3.4 0L28.5 29" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M9.6 22.5h12.8" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M16 .5l1.5 3.6 3.6 1.5-3.6 1.5L16 10.7l-1.5-3.6-3.6-1.5 3.6-1.5z" fill="var(--logo-accent, #e2b04a)"/>
</svg>`;

export const logo = (size = 28) => `<span class="logo">${logoMark(size)}<span class="logo-word">Atlas</span></span>`;
