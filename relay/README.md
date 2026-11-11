# Celeste's relay

Lets the Celeste app on a phone reach Celeste on a computer when they are not on the same Wi-Fi. It is a small Cloudflare Worker with one Durable Object per computer. The design is in `docs/PHONE_PLAN.md`, section 7.1.

## What it does, and what it can't see

- The computer and the phone each open a WebSocket **outward** to the relay. The relay passes text between them.
- Everything it passes is sealed end to end with the keys the phone and the computer agreed when they paired on the Wi-Fi. The relay can read none of it.
- It sees who is connected and when, and how much is sent. It stores one thing per computer: a hash of that computer's room secret.
- A phone can't be paired through the relay, and the app can't be downloaded through it. Both happen only on the Wi-Fi.

## The rules

They are in `src/rules.ts`, shared with the stand-in the desktop's tests use (`src/core/testing/relay.ts`).

- A room's name and its secret come from the computer's private key. The first computer to come to a room owns it.
- A room no computer ever came to takes no phones.
- At most 8 phones in a room. A phone that sends too much too fast is closed.
- A room whose computer has not come back for 60 days is forgotten.

## Run it locally

No Cloudflare account is needed for this.

```bash
npm --prefix relay install
```

```bash
npm run verify:relay
```

`verify:relay` starts the Worker in Cloudflare's own runtime on this computer and runs the computer's bridge and a stand-in phone through it.

To try it with the real app, start the relay and point Celeste at it:

```bash
npm --prefix relay run dev
```

Then start Celeste with `CELESTE_RELAY_URL=ws://<this computer's address>:8787`. The phone learns the address the next time it connects on the Wi-Fi.

## Deploy it

The project's relay is at `wss://celeste-relay.celesteapp.workers.dev` (`DEFAULT_RELAY_URL`). To run your own, or to redeploy, you need a Cloudflare account (the free plan is enough, and it asked for no card).

```bash
npm --prefix relay run deploy
```

Wrangler prints the Worker's address, like `https://celeste-relay.<account>.workers.dev`. Put it in `DEFAULT_RELAY_URL` in `src/shared/phone.ts` as `wss://...`, and say in `PRIVACY.md` what the relay sees before releasing.

## What it costs

Cloudflare's free plan allows 100,000 requests a day and 13,000 GB-seconds a day for Durable Objects, shared by everyone who uses the relay. A new connection is one request. Incoming messages count 20 to 1, outgoing ones are free, and a room that is idle is asleep and costs nothing ("ping" is answered without waking it).

## Waking a closed app (Firebase)

When the computer has an approval, a question or a request for a phone, it asks the relay to wake the phone through Firebase Cloud Messaging (FCM). The relay sends **one data message holding one sealed box**: Google sees the phone's token and a block of bytes, never what is inside. The app wakes, opens the box with its own key and shows the notification.

The relay needs the Firebase **service account key** (a JSON file from Firebase console, Project settings, Service accounts, Generate new private key). It is a **secret**: keep it out of the repository, and give it to the Worker like this (from a terminal in this folder, pointing at the file):

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < C:\path\to\the-key.json
```

Without it the relay answers every wake with `NOT_CONFIGURED`, and everything else works. Limits: 240 wakes an hour per computer, and a box of at most 3,500 characters (Firebase carries about 4 KB).

The app's background service has no WebSocket, so it answers the computer with an HTTP request to the relay (`POST /v1/<room>/rpc`, the same sealed request as on the Wi-Fi). At most 120 a minute per room.

## Not here yet

- The direct link for files (step A4c). Until then files go through the relay in sealed parts.
