# Secret Santa

A festive six-person gift exchange. Each person gives to two different people, never themselves, and receives exactly two gifts. The organizer presses a stocking button to save one permanent draw and email each participant their two names. Email signup does not require verification.

## Intended live setup

- **GitHub Pages** hosts `public/`, with automatic deployment from `main`.
- **Google Apps Script** stores the six signups and the draw in private Script Properties and sends emails from the organizer’s authorized Google account using MailApp. No phone numbers, SMS subscription, external email provider, or purchased domain is needed.
- Only the participant count and draw status are public. Names and email addresses are visible to the password-protected organizer. Assignments are never returned to the browser.
- The organizer’s Gmail account must authorize Google’s `script.send_mail` scope. The script does not request inbox-reading access.

### One-time Google setup

1. Open [Google Apps Script](https://script.google.com/home/start), create a project named **Secret Santa**, and put `google-apps-script/Code.js` into the editor’s `Code.gs` file.
2. In **Project Settings**, enable **Show appsscript.json manifest file in editor**. Replace that file with `google-apps-script/appsscript.json`.
3. In **Project Settings → Script properties**, add `ADMIN_PASSWORD` with a password of at least 10 characters. Keep it private; it never belongs in GitHub or `public/config.js`.
4. Choose **Deploy → New deployment → Web app**. Set **Execute as: Me** and **Who has access: Anyone** so the six participants do not need Google accounts. Complete Google’s authorization yourself after reviewing the requested email-sending permission. If a Google warning blocks this, stop and review the project and account configuration rather than bypassing a browser security interstitial.
5. Copy the deployed URL ending in `/exec` into `public/config.js` as `apiUrl`.
6. If you edit the backend later, update its existing deployment to a new version; preserve its deployment URL and Script Properties.

### GitHub setup

1. Create a dedicated repository named `secret-santa` under your GitHub account and push this project. Do not include `.env` or `data/`.
2. In the repository’s **Settings → Pages → Build and deployment**, choose **GitHub Actions**. The included workflow tests the app and publishes only `public/`.
3. Share the URL returned by the successful Pages deployment. Use the **Organizer** link for the workshop, which also works at `?organizer=1`.

The cross-origin Google endpoint and the real Google authorization/sending flow must be tested after deployment. Local mocked tests cannot establish that a Google account’s policies permit public web-app deployment or that a message arrived in a recipient’s inbox.

## Running a draw

Share the main page privately with the six participants. Each enters a distinct name and email address. As organizer, sign in, check all six entries, and remove/re-enroll any incorrect entries before drawing. Once all six have joined, press the stocking and confirm sending. The saved draw cannot be rerun or edited from the app.

Sending is limited to the six registered addresses and fixed assignment text. A completed send is never automatically repeated. If an execution is interrupted or the provider’s result is uncertain, the message is held for review; inspect Google’s execution records and the recipient’s inbox before taking recovery action. The retry button sends only entries that are known not to have been attempted. It never rerolls the draw.

Gmail daily quotas apply. The script checks that at least six recipient slots are available before drawing. “Email sent” means the mail service accepted the request; inbox delivery and spam placement are outside the app’s control.

This is a private, small-group exchange: anyone with the signup link can fill an open place, because verification was intentionally omitted. Share the link only with the participants. Organizer sessions expire within six hours and may expire earlier if Google evicts its temporary cache.

## Local development

Requires Node.js 24 or newer; no npm dependencies.

```powershell
Copy-Item .env.example .env
# Set ADMIN_PASSWORD in .env to a unique value of at least 16 characters.
npm start
npm test
```

Open `http://localhost:3000`. Local development uses the Node server and a private SQLite database in `data/`. Add `?live=1` to deliberately test the configured Google backend instead. Local email delivery is disabled unless an optional Resend key and approved sender are configured in `.env`. Tests inject a fake sender and send no real messages. This optional local adapter is not used by the Gmail production deployment.

Set `PUBLIC_ORIGIN` to the exact origin if changing local ports. Use HTTPS and a secure reverse proxy if separately deploying the Node adapter; set `HOST=0.0.0.0` only when that hosting setup requires it. The intended GitHub deployment publishes static assets, not the Node server.
