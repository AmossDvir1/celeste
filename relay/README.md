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

This needs a Cloudflare account (the free plan is enough) and is done by the project's owner.

```bash
npm --prefix relay run deploy
```

Wrangler prints the Worker's address, like `https://celeste-relay.<account>.workers.dev`. Put it in `DEFAULT_RELAY_URL` in `src/shared/phone.ts` as `wss://...`, and say in `PRIVACY.md` what the relay sees before releasing.

## What it costs

Cloudflare's free plan allows 100,000 requests a day and 13,000 GB-seconds a day for Durable Objects, shared by everyone who uses the relay. A new connection is one request. Incoming messages count 20 to 1, outgoing ones are free, and a room that is idle is asleep and costs nothing ("ping" is answered without waking it).

## Not here yet

- Push notifications (step A4b): the relay asking Firebase Cloud Messaging to wake a closed app.
- The direct link for files (step A4c). Until then files go through the relay in sealed parts.
