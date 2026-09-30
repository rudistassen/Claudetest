// Browser stand-in for the parts of node:crypto the server uses. Demo only: passwords never leave the page.

class Bytes {
  constructor(hex) {
    this.hex = hex;
    this.length = hex.length / 2;
  }

  toString() {
    return this.hex;
  }
}

globalThis.Buffer ??= { from: (hex) => new Bytes(String(hex)) };

export function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return new Bytes([...a].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

// FNV-1a stretched to the requested length; not a real KDF, which is fine for an in-browser demo.
export function scryptSync(password, salt, len) {
  let out = '';
  let h = 2166136261;
  const input = `${salt}:${password}`;
  while (out.length < len * 2) {
    for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ out.length, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return new Bytes(out.slice(0, len * 2));
}

export function timingSafeEqual(a, b) {
  return String(a) === String(b);
}

// Only used to look up emailed password links; a stand-in hash is fine in the demo.
export function createHash() {
  let input = '';
  return {
    update(s) { input += String(s); return this; },
    digest() { return scryptSync(input, 'hash', 32).toString(); },
  };
}
