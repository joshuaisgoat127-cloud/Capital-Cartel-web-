# Capital Cartel App

A private black-and-gold trading-alert web app with:

- Member sign-up and login
- Admin approval / decline controls
- Admin-only trade posting
- Live trade feed using Socket.IO
- Trade history and result statuses
- Browser push notifications using Web Push / VAPID
- Installable PWA manifest
- Password hashing with bcrypt
- JWT authentication stored in an HTTP-only cookie
- Local JSON persistence with no database setup required

## Fastest Windows setup

1. Install Node.js LTS from https://nodejs.org/ if it is not already installed.
2. Extract this ZIP to a normal folder.
3. Double-click `start.bat`.
4. The first run installs dependencies and starts the app.
5. Open `http://localhost:3000/setup.html`.
6. Create your owner/admin account.
7. Share `http://localhost:3000/signup.html` only for testing on the same computer.

Do **not** double-click the HTML files directly. This app has a backend, authentication and live notifications, so it must be started with Node.js.

## Making it available to members online

Deploy the folder to a Node.js host such as Render, Railway, Fly.io, a VPS, or another host that supports persistent Node processes and HTTPS. The start command is:

```bash
npm install
npm start
```

The server listens on `process.env.PORT`, so most hosts can provide the port automatically.

### Data persistence warning

By default, member accounts, trades and push subscriptions are saved under `data/store.json`. On a production host, make sure the `data` folder is on persistent storage. If your hosting provider wipes the filesystem during deploys, migrate the storage layer to a managed database before launch.

## Push notification requirements

Push works on localhost for development. In production, browsers require HTTPS. The app generates its own VAPID keys on first run and saves them to `data/config.json`.

For iPhone/iPad, web push generally works best after the web app is added to the Home Screen and notification permission is granted from the installed web app.

## Security notes before a public launch

- Use HTTPS.
- Set `COOKIE_SECURE=true` in production.
- Put the app behind a reputable host/reverse proxy.
- Back up the `data` directory.
- Consider moving from JSON storage to PostgreSQL/Supabase once member numbers grow.
- Review your local financial-services, advertising and privacy obligations before distributing trading signals commercially.

## Useful environment variables

```env
PORT=3000
VAPID_SUBJECT=mailto:admin@yourdomain.com
COOKIE_SECURE=true
```

## Folder map

- `server.js` — API, auth, member approvals, trades, sockets and push
- `public/index.html` — landing page
- `public/login.html` — member/admin login
- `public/signup.html` — membership request page
- `public/setup.html` — first-admin setup
- `public/dashboard.html` — approved member dashboard
- `public/admin.html` — admin dashboard
- `public/sw.js` — push notification service worker
- `public/styles.css` — complete black/gold design
- `data/` — local persistent app data after first run

## Important scope note

This app sends informational trading alerts. It does not connect to a broker or automatically place trades on a member's account. Broker integration should be added only through an authorized API and with appropriate legal/compliance review.
