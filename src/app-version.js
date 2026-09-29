import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A short fingerprint of the app's screens (everything in public/). It changes whenever a new version is deployed,
 *  so open copies of BrewView (phones especially) can tell they're out of date and refresh themselves. */
export function appVersion(dir) {
  const hash = createHash('sha1');
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(dir, full)).update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}
