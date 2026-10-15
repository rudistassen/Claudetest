# Halloween treasure hunt

A phone-friendly website for a customer treasure hunt. Customers enter their email, get clues, find QR codes hidden around your premises (or around town) and scan them with their phone camera. When they've collected enough (6 by default) they get a claim code to show at the counter. Staff check the code on their own phone or tablet and mark the prize as claimed, so each email address can only win once.

It's a small Node.js app with its own SQLite database, built to run on [Railway](https://railway.com). It's separate from Cafe Ops and shares nothing with it.

## How it works

**Customers**
1. They scan the **Start** poster (at the counter or in the window) and enter their email. Ticking the marketing box is optional.
2. They solve a clue, find the hidden QR poster and scan it. If they scan a checkpoint before signing up, it's collected as soon as they enter their email.
3. They can find checkpoints in any order. The sample config has 8 checkpoints and they need 6, so not everyone crowds round the same spot.
4. After the 6th they see a claim code (e.g. `BOO-NMP48`) with a live clock.
5. Progress is saved on the server, so if they change phone they just enter the same email again.

**Staff** use `/staff.html` on a counter phone or tablet:
1. Sign in with the staff password.
2. Type the customer's claim code (or email) and tap **Check**. It shows *Winner — not claimed yet*, *Already claimed* or *Not won yet*.
3. Tap **Give prize & mark as claimed**. The customer's screen changes to "Prize claimed" within a few seconds.

**Admins** sign in on the same page with the admin password and also get:
- Totals: players, winners, prizes claimed, marketing opt-ins and scans per checkpoint.
- **Print QR posters**: an A4 Start poster plus one poster per checkpoint.
- **Download players (CSV)**: everyone's email, opt-in, progress and claim status.
- **Delete emails of people who didn't opt in**: use this after the hunt (see *Privacy* below).

## Setting up on Railway

You'll need a Railway account. Running a small app like this with a volume needs a paid plan: the Hobby plan costs about $5 a month, which includes some usage. Check [railway.com/pricing](https://railway.com/pricing) for current prices.

1. **Edit `hunt.config.js`**: hunt name, prize, `required`, dates and the checkpoints. Write clues for your own hiding places and **change every checkpoint `code`** to your own random letters and numbers (8 or more). Commit and push to GitHub.
2. **Create the service.** In Railway choose **New Project → Deploy from GitHub repo** and pick this repository. Then open the service's **Settings**:
   - **Source → Root Directory**: `/halloween-hunt`
   - **Source → Branch**: the branch that has the hunt on it (e.g. `main` once it's merged).
3. **Add a volume** so the database survives redeploys: right-click the service (or use the **+ Create** menu) → **Volume**, and set the mount path to `/data`.
4. **Add variables** under the service's **Variables** tab:

   | Variable | Value |
   | --- | --- |
   | `DB_PATH` | `/data/hunt.db` |
   | `STAFF_PASSWORD` | A password for counter staff (checking and claiming prizes). |
   | `ADMIN_PASSWORD` | A different, stronger password for you (totals, posters, email export). |

5. **Get a web address**: **Settings → Networking → Generate Domain**. You get something like `great-pumpkin-hunt.up.railway.app`. You can add your own domain there too, e.g. `hunt.yourcafe.co.uk`. Do this **before printing posters**, as the QR codes contain the address.
6. Open `https://<your address>/staff.html`, sign in with the admin password and choose **Print QR posters**. Check the web address at the top is your live address, then print. Use the test links in the table to try each checkpoint in a private browser window.
7. Hide the checkpoint posters where the clues point, put the Start poster somewhere visible, and give staff the staff password and the `/staff.html` link (add it to the home screen of the counter tablet).

Railway redeploys automatically whenever you push changes to the branch. If you change a checkpoint's code or the web address after printing, reprint that poster. Don't change a checkpoint's `id` once the hunt has started.

Keep the service at **one replica**: the SQLite database lives on the volume and can't be shared between copies.

## Privacy

You're collecting email addresses, so UK GDPR applies. The sign-up form shows the `privacyNote` from `hunt.config.js` and an unticked marketing opt-in box. Make sure the note matches what you'll actually do.

- Only email people about offers if they ticked the box (`marketing_opt_in` = `yes` in the CSV).
- When the hunt and prize claims are over, use **Delete emails of people who didn't opt in**. It keeps the totals but removes those addresses. After that, those people can no longer check or claim a prize.

## Limits to know about

- Email addresses aren't verified, so someone could play again with a made-up address. Checking emails would mean sending each player a code, which needs an email service (e.g. Resend or Postmark). That can be added if it becomes a problem.
- Hunt dates are checked on the server in UK time. Scans outside them are refused; prizes can still be claimed after the end date.

## Running it locally

Requires Node.js 22.13 or newer.

```bash
cd halloween-hunt
npm install
STAFF_PASSWORD=staff ADMIN_PASSWORD=admin npm start   # http://localhost:3000
npm test
```

The local database is saved to `halloween-hunt/data/hunt.db`. Scans are only accepted between the hunt dates, so change `startDate` to try it before then.

The QR code generator in `public/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT licence).
