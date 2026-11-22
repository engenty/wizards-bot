# A home on a server

A home on a server is reachable from everywhere: your phone away from home, your channels'
webhooks, other people's homes. It has no models of its own.

```bash
docker build -t wizards-bot .
```

```bash
docker run -d --name wizards-bot --restart unless-stopped -p 4747:4747 -v wizards-bot:/data -e WIZARDS_BOT_URL=https://me.example.com wizards-bot
```

Put it behind a proxy that ends TLS (Caddy, Traefik, Coolify) and forwards to port 4747.
`WIZARDS_BOT_URL` is the address others reach it at; your handle becomes `you@me.example.com`.
The event stream and the link are long-lived connections: the proxy must not buffer them or cut
them after a minute.

Then:

1. `docker exec -it wizards-bot wizards-bot pair` shows a code. Pair your phone with it.
2. On your computer, `wizards-bot link https://me.example.com <code>` with a second code. While
   it runs, the home uses your computer's Ollama and subscriptions.
3. In the chat: "add OpenRouter" (or another gateway) for the hours your computer is off.

`/data` holds the database, the home's key and the key that encrypts your secrets. Back it up
as one.

## A demo home for App Review

App Review pairs the iOS app with a home that runs for the whole review. Start one with
`-e WIZARDS_BOT_DEMO_CODE=<at least 8 letters and digits>`: that code pairs any number of devices
and does not run out. Add a gateway with a key, keep no one's real data in it, and put its address
and the code into the review notes ([app-review.md](app-review.md)).
