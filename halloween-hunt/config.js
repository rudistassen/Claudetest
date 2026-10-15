// ---------------------------------------------------------------------------
// Halloween treasure hunt settings. This is the only file you need to edit.
// ---------------------------------------------------------------------------
//
// Each checkpoint is a place you hide a QR code. The QR code opens this site
// with the checkpoint's secret `code`, which marks it as found on the
// customer's phone. Print the QR posters from posters.html.
//
// - `code` is what makes a scan count, so keep it hard to guess (letters and
//   numbers, 8 or more). If you change a code, reprint that poster.
// - `clue` is shown to customers before they find the checkpoint.
// - `found` is the message shown when they scan it.
// - You can have more checkpoints than `required`, so customers can choose
//   which ones to find and nobody queues at the same spot.

window.HUNT_CONFIG = {
  name: 'The Great Pumpkin Hunt',
  business: 'Our Cafe',
  intro:
    'Follow the spooky clues, find the hidden QR codes and scan them with your phone camera. ' +
    'Collect 6 to win a free treat!',

  // How many checkpoints a customer must find to win.
  required: 6,

  // What they win, and how to claim it.
  prize: 'a FREE hot chocolate or cookie',
  claimInstructions: 'Show this screen at the counter to claim your prize. One prize per person.',

  // Staff enter this PIN on the customer's phone to mark the prize as claimed.
  // Change it before the hunt starts and tell your team.
  staffPin: '3110',

  // The hunt only accepts scans between these dates (inclusive, local time).
  // Set either to null to leave it open-ended.
  startDate: '2026-10-24',
  endDate: '2026-11-01',

  checkpoints: [
    {
      code: 'ubiB4K6p',
      name: 'The Witch\'s Cauldron',
      clue: 'Where beans are ground and the steam does hiss, a bubbling brew you must not miss.',
      found: 'Double, double, toil and trouble — you found the cauldron!',
    },
    {
      code: 'NkqLFo27',
      name: 'The Haunted Bookshelf',
      clue: 'Stories sleep upon my shelves; read my spines, or find me yourselves.',
      found: 'The books whispered your name. Checkpoint found!',
    },
    {
      code: 'wne0Bxn4',
      name: 'The Ghostly Window',
      clue: 'I let in light but keep out the cold; look where the street meets glass, if you are bold.',
      found: 'Boo! A ghost was watching you through the glass.',
    },
    {
      code: 'BMLII9xq',
      name: 'The Skeleton\'s Seat',
      clue: 'Rest your bones where the comfy cushions are; the skeleton\'s chair is never far.',
      found: 'The skeleton saved you a seat. Well done!',
    },
    {
      code: 'dctUaDdG',
      name: 'The Spider\'s Web',
      clue: 'High in a corner where the cobwebs grow, an eight-legged friend waits below.',
      found: 'You got caught in the web — in a good way!',
    },
    {
      code: '5lmSRzfZ',
      name: 'The Pumpkin Patch',
      clue: 'Round and orange, I sit outside the door; count the pumpkins, then look for one more.',
      found: 'You picked the perfect pumpkin!',
    },
    {
      code: 'PB34zpiQ',
      name: 'The Bat Cave',
      clue: 'Hang upside down where the cups are stacked; the bats are hiding at the back.',
      found: 'Flap flap! You found the bat cave.',
    },
    {
      code: 'K2PP0v8r',
      name: 'The Mummy\'s Tomb',
      clue: 'Wrapped up tight like a sweet treat, find me where the cakes and pastries meet.',
      found: 'The mummy is un-wrapped — checkpoint found!',
    },
  ],
};
