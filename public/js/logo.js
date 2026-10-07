// The Atlas logo: a globe – every site and everything going on, in one place – with a gold guiding star.
// The globe takes the text colour (currentColor); the star uses --logo-accent.
export const logoMark = (size = 28) => `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <circle cx="14.5" cy="17.5" r="11.2" fill="none" stroke="currentColor" stroke-width="3"/>
  <path d="M14.5 6.3c-4.4 3-6.2 7-6.2 11.2s1.8 8.2 6.2 11.2c4.4-3 6.2-7 6.2-11.2s-1.8-8.2-6.2-11.2z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M3.8 17.5h21.4" stroke="currentColor" stroke-width="2.4"/>
  <path d="M26 .8l1.9 4.6 4.6 1.9-4.6 1.9L26 13.8l-1.9-4.6-4.6-1.9 4.6-1.9z" fill="var(--logo-accent, #e2b04a)"/>
</svg>`;

export const logo = (size = 28) => `<span class="logo">${logoMark(size)}<span class="logo-word">Atlas</span></span>`;
