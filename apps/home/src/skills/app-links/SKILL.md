---

name: app-links
description: Open maps, calls, messages, music, shortcuts and web pages on the person's phone by a link.
metadata: { words: [Apple Maps, Google Maps, Waze, directions, navigate, WhatsApp, Telegram, Signal, FaceTime, Spotify, Apple Music, YouTube, Shortcuts, iMessage, SMS, phone call, anrufen, Wegbeschreibung, Route] }
---

Your tools: `link_open`, `call_start`, `message_draft`. Each puts a card into the chat; the person taps it on their phone. Nothing opens, calls or sends by itself, and you never learn whether they tapped.

Calls and messages

- `call_start` with a name from the person's contacts ("Anna Berg") or a number. Their phone finds the number in its contacts; the contact stays on the phone.
- `message_draft` with the recipient, the text and `via`: `messages` (iMessage or SMS), `mail` (with a subject) or `whatsapp`. The phone opens the draft; the person reads it and sends it. Write the text as the person would, in their language.

Links for `link_open`

Use these forms only, with every value URL-encoded. An `https` link opens the app when it is installed and the web page when it is not; any other link does nothing without its app.

- Apple Maps: `https://maps.apple.com/?daddr=<place>&dirflg=d` (directions; `w` on foot, `r` by transit), `https://maps.apple.com/?q=<search>`
- Google Maps: `https://www.google.com/maps/dir/?api=1&destination=<place>&travelmode=driving` (`walking`, `transit`, `bicycling`), `https://www.google.com/maps/search/?api=1&query=<search>`
- Waze: `https://waze.com/ul?q=<place>&navigate=yes`
- FaceTime: `facetime:<number or address>`, `facetime-audio:<number or address>`
- WhatsApp chat with a number: `https://wa.me/<number, digits only, with country code>`
- Telegram: `https://t.me/<username>`
- Signal: `https://signal.me/#p/<+number>`
- Spotify: `https://open.spotify.com/search/<search>`; Apple Music: `https://music.apple.com/search?term=<search>`
- YouTube: `https://www.youtube.com/results?search_query=<search>`
- Shortcuts: `shortcuts://run-shortcut?name=<name of the shortcut>` (with `&input=text&text=<text>` to hand it text)
- This app's own page in Settings: `app-settings:`
- Any web page: its `https` address.

Ask which app when the person has not said and it matters (Apple Maps or Google Maps). The title of the card says what tapping does, e.g. "Directions to Kraków Main Station in Apple Maps".
