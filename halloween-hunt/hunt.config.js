// ---------------------------------------------------------------------------
// Halloween treasure hunt settings.
// ---------------------------------------------------------------------------
//
// This file stays on the server: customers never see the checkpoint codes.
// After editing it, push to GitHub and Railway redeploys automatically.
//
// Each checkpoint is a place you hide a QR code. The QR code opens the hunt
// with the checkpoint's secret `code`. Print the posters from /posters.html
// (sign in on /staff.html with the admin password first).
//
// - `id` identifies the checkpoint in the database. Don't change it once the
//   hunt has started, or scans of that checkpoint will stop counting.
// - `code` is printed in the QR code. Keep it hard to guess (letters and
//   numbers, 8 or more). You can change it, but then reprint that poster.
// - `clue` is shown to customers before they find the checkpoint.
// - `found` is the message shown when they scan it.
// - You can have more checkpoints than `required`, so customers can choose
//   which ones to find and nobody queues at the same spot.

export default {
  name: 'The Great Pumpkin Hunt',
  business: 'Our Cafe',
  intro:
    'Follow the spooky clues, find the hidden QR codes and scan them with your phone camera. ' +
    'Collect 6 to win a free treat!',

  // How many checkpoints a customer must find to win.
  required: 6,

  // What they win, and how to claim it.
  prize: 'a FREE hot chocolate or cookie',
  claimInstructions: 'Show this screen at the counter to claim your prize. One prize per email address.',

  // Shown under the email box when customers sign up.
  privacyNote:
    'We use your email only to run this hunt and make sure each person claims one prize. ' +
    'We delete it after the hunt unless you tick the box to hear about our offers.',
  marketingConsentLabel: 'Yes, email me about Our Cafe\'s offers and events. I can unsubscribe at any time.',

  // The hunt only accepts scans between these dates (inclusive, UK time).
  // Set either to null to leave it open-ended.
  startDate: '2026-10-24',
  endDate: '2026-11-01',
  timeZone: 'Europe/London',

  checkpoints: [
    {
      id: 'cauldron',
      code: 'ubiB4K6p',
      name: 'The Witch\'s Cauldron',
      clue: 'Where beans are ground and the steam does hiss, a bubbling brew you must not miss.',
      found: 'Double, double, toil and trouble — you found the cauldron!',
    },
    {
      id: 'bookshelf',
      code: 'NkqLFo27',
      name: 'The Haunted Bookshelf',
      clue: 'Stories sleep upon my shelves; read my spines, or find me yourselves.',
      found: 'The books whispered your name. Checkpoint found!',
    },
    {
      id: 'window',
      code: 'wne0Bxn4',
      name: 'The Ghostly Window',
      clue: 'I let in light but keep out the cold; look where the street meets glass, if you are bold.',
      found: 'Boo! A ghost was watching you through the glass.',
    },
    {
      id: 'seat',
      code: 'BMLII9xq',
      name: 'The Skeleton\'s Seat',
      clue: 'Rest your bones where the comfy cushions are; the skeleton\'s chair is never far.',
      found: 'The skeleton saved you a seat. Well done!',
    },
    {
      id: 'web',
      code: 'dctUaDdG',
      name: 'The Spider\'s Web',
      clue: 'High in a corner where the cobwebs grow, an eight-legged friend waits below.',
      found: 'You got caught in the web — in a good way!',
    },
    {
      id: 'pumpkins',
      code: '5lmSRzfZ',
      name: 'The Pumpkin Patch',
      clue: 'Round and orange, I sit outside the door; count the pumpkins, then look for one more.',
      found: 'You picked the perfect pumpkin!',
    },
    {
      id: 'bats',
      code: 'PB34zpiQ',
      name: 'The Bat Cave',
      clue: 'Hang upside down where the cups are stacked; the bats are hiding at the back.',
      found: 'Flap flap! You found the bat cave.',
    },
    {
      id: 'mummy',
      code: 'K2PP0v8r',
      name: 'The Mummy\'s Tomb',
      clue: 'Wrapped up tight like a sweet treat, find me where the cakes and pastries meet.',
      found: 'The mummy is un-wrapped — checkpoint found!',
    },
  ],
};
