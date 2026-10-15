# Halloween treasure hunt

A phone-friendly website for a customer treasure hunt. Customers get clues, find QR codes hidden around your premises (or around town), and scan them with their phone camera. When they've collected enough (6 by default), the site shows a prize screen to show at the counter.

It is a static site: plain HTML, CSS and JavaScript. No server, database or app download is needed.

| File | What it is |
| --- | --- |
| `config.js` | **The only file to edit**: hunt name, prize, number to collect, staff PIN, dates, and the checkpoints (secret code, clue, message when found). |
| `index.html` | The page customers use: clues, progress pumpkins and the prize screen. |
| `posters.html` | Printable A4 posters: one "Start" poster with the clues QR code, and one QR poster per checkpoint. It also lists a test link for each checkpoint. |

## How it works for customers

1. They scan the **Start** poster (at the counter or in the window) and see all the clues.
2. They solve a clue, find the hidden QR poster and scan it. The site says they've found it and lights up a pumpkin.
3. They can find checkpoints in any order. The sample config has 8 checkpoints and customers need 6, so not everyone crowds round the same spot.
4. After the 6th, the prize screen appears with a claim code (e.g. `BOO-NWYXC`) and a live ticking clock, so staff can tell it's the real page and not a screenshot.
5. Staff tap **Staff: mark as claimed** and enter the staff PIN. The screen then shows "Prize claimed", so it can't be used twice on that phone.

Progress is saved on the customer's phone (browser storage), so they should use the same phone and browser throughout.

## Setting it up

1. Edit `config.js`: name, prize, `required`, `staffPin`, `startDate`/`endDate` and the checkpoints. Write clues for your own hiding places. **Change the checkpoint codes** to your own random letters and numbers (8 or more characters).
2. Publish the `halloween-hunt` folder online. Any static host works, for example:
   - **Netlify Drop**: drag the folder onto https://app.netlify.com/drop.
   - **GitHub Pages**: turn on Pages for this branch in the repository settings. The hunt is then at `https://<user>.github.io/<repo>/halloween-hunt/`.
   - **Your existing website**: upload the folder, e.g. to `yourcafe.co.uk/halloween-hunt/`.
3. Open `posters.html` **on the published site**, check the web address box shows the live address, and print. Use the test links in the table to try each checkpoint (in a private window, so you don't use up your own progress).
4. Hide the checkpoint posters where the clues point, and put the Start poster somewhere visible. Tell staff the PIN.

If you change a checkpoint's code or the web address after printing, reprint that poster.

## Limits to know about

- There's no server, so the checkpoint codes are in `config.js`, which a determined, tech-savvy person could read. For a free cookie that's normally fine. The clock and claim code stop simple screenshot sharing.
- Clearing browser data, or using a different phone, starts the hunt again (and could allow a second prize). The staff PIN and "one prize per person" wording help, and staff can also note claim codes.
- Scans outside `startDate`–`endDate` are refused (based on the phone's date).

The QR code generator in `vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT licence).
