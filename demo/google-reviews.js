// Pretend Google Maps listings and reviews for the demo's sites (see src/google-reviews.js).
import { memoryPlaces } from '../src/google-reviews.js';

const WORDS = [
  [5, 'Best flat white in town and the team always remember my order. Cosy spot to work for an hour.'],
  [5, 'Lovely staff, spotless tables and the cinnamon buns are unreal. Will be back!'],
  [4, 'Great coffee, a bit of a queue at lunchtime but it moved quickly.'],
  [5, 'Dog friendly, great music and brilliant oat lattes.'],
  [3, 'Coffee was good but our sandwiches took nearly 20 minutes on a quiet morning.'],
  [2, 'Asked for extra hot and it came lukewarm. The table by the door was sticky too.'],
  [4, ''],
  [5, 'Took the kids for hot chocolate after school – staff were so patient with them.'],
  [1, 'Waited 15 minutes, order was wrong and nobody apologised. Disappointing.'],
  [4, 'Solid breakfast and a friendly welcome. Wish they opened a bit earlier.'],
];
const PEOPLE = ['Sophie M', 'Tom Hughes', 'Priya K', 'Daniel O', 'Ellie Carter', 'Marcus B', 'Aisha R', 'Ben T', 'Hannah W', 'Josh P', 'Megan L', 'Olu A'];

export function demoPlaces(sites, now = Date.now()) {
  return memoryPlaces(sites.map((site, i) => {
    const reviews = Array.from({ length: 5 }, (_, k) => {
      const [rating, text] = WORDS[(i * 3 + k * 7) % WORDS.length];
      return {
        id: `places/demo-${i}/reviews/${k}`,
        author: PEOPLE[(i * 5 + k) % PEOPLE.length],
        author_url: null,
        author_photo: null,
        rating,
        text,
        published_at: new Date(now - ((k * 5 + i * 2) * 86400000 + (k + 1) * 3600000)).toISOString(),
        review_url: null,
      };
    });
    return {
      place_id: `DemoPlace${String(i).padStart(4, '0')}${site.name.replace(/\W/g, '')}`,
      name: `Brew & Barrel ${site.name}`,
      address: `${10 + i} ${site.name}, Brightwell BW${i + 1} 4QA`,
      rating: [4.6, 4.4, 4.7, 4.2, 4.5, 4.8, 4.3][i % 7],
      count: [312, 187, 425, 96, 241, 158, 73][i % 7],
      reviews,
    };
  }));
}
