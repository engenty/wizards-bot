# Reaching your Bot Server away from home

A Bot Server on a computer at home is reached on that network only. In the setup's last step
(and by asking the main agent, `address_switch`), the person can pick **Away from home
too**: the Bot Server then gets a name at `wizards.host`, such as `k7qf2mxd3a.wizards.host`,
and the phone reaches it there from anywhere. It is off until the person switches it on. A Bot
Server on wizards.bot, or one started with an address of its own (`WIZARDS_BOT_URL`), does not
offer it.

On the home network the apps already use https: the Bot Server answers it with a key it made
itself, and the apps trust that key alone, by the print in the pairing QR (`docs/protocol.md`,
"On the person's network"). A browser on the network uses http.

## What happens when it is switched on

1. **frpc.** The Bot Server downloads frpc ([frp](https://github.com/fatedier/frp), Apache-2.0)
   at the version the relay runs (0.72.0) from frp's release on GitHub, for this computer's
   system and processor, and keeps it only when its sha256 is the one frp published
   (`apps/home/src/tunnel/frpc.ts`). It lives in the data folder, `tunnel/frp/0.72.0/frpc`.
   `WIZARDS_BOT_FRPC` names an frpc to use instead.
2. **The name.** The Bot Server makes an Ed25519 key of its own, `tunnel/claim.pem` (0600), once.
   The name is made from it: the first 10 characters of base32 of the sha256 of its public key.
   The Bot Server claims that name at `https://wizards.host` (`WIZARDS_TUNNEL_URL` changes it)
   with a signature of the key, no account and no sign-in, and gets a key for the relay
   (`tunnel/tunnel.json`, 0600). The same key always gets the same name.
3. **The certificate.** The Bot Server makes a private key for the name (`tunnel/key.pem`, 0600)
   and sends the relay a certificate request for it; the relay has Let's Encrypt sign it and
   hands back the certificate (`tunnel/cert.pem`). The private key never leaves the computer.
   The certificate is renewed 30 days before it ends; frpc reads the new one without a restart.
4. **The connection.** frpc runs as a child of the Bot Server. It keeps one connection open to
   the relay, over port 443. When a phone opens `https://<name>`, the relay passes the connection
   through unread, and frpc ends TLS on this computer with the name's certificate and hands the
   request to the Bot Server on `127.0.0.1`. frpc that ends is started again, after one second,
   then longer, up to a minute.

Switching it off stops frpc. The claim key and the name stay, so switching it on again gives
the same name. Deleting the data folder's `tunnel/claim.pem` gives up the name.

The setup shows the state: `off`, `starting`, `on`, `refused` (the relay said no, with its
sentence) or `failed` (the relay or GitHub did not answer, or frpc did not start; tried again
later). Once it is on, the pairing QR and code lead to `https://<name>`, so a phone added then
reaches the Bot Server at home and away.

## What leaves the computer

- **The name and the connection.** The relay at wizards.host knows the name, that this
  computer is connected, the addresses of those who open the name, the times and the amount of
  data. It does not see paths, messages or tokens: TLS ends on this computer.
- Nothing else: no computer name, no account, no device.
- The relay runs wizards.host's DNS, so it could get a certificate for the name itself. Every
  certificate is public in the Certificate Transparency logs (crt.sh), so such a certificate
  would be visible.

The Bot Server's own rules stay as they are: every route needs a device's token, pairing needs
a code that works once, homes sign their requests.

## The Mac app

frpc is not part of the app. The home fetches it into its data folder the first time the person
switches the address on, so the app's bundle stays unchanged and its signature intact. A file
the home downloads itself carries no quarantine flag, so Gatekeeper does not check it, and frp's
builds for Apple silicon carry the ad-hoc signature macOS asks of every program there.
