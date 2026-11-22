# App Review: what Apple asks of the iOS app

Checked on 2026-11-22 against the pages as they stood that day:

| Page                                                                                                                                                                               | Date on the page                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)                                                                                                  | "Last Updated: October 16, 2026" |
| [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)                                                                                                  | none; read 2026-11-22            |
| [Requesting access to protected resources](https://developer.apple.com/documentation/uikit/requesting-access-to-protected-resources) (purpose strings)                             | none; read 2026-11-22            |
| [Acceptable use requirements for the Foundation Models framework](https://developer.apple.com/apple-intelligence/acceptable-use-requirements-for-the-foundation-models-framework/) | none; read 2026-11-22            |
| [WeatherKit, get started](https://developer.apple.com/weatherkit/get-started/) (attribution)                                                                                       | none; read 2026-11-22            |

The quotes are a few words each; the numbers lead to the full text. Status: **met**, **met now**
(met by the change of 2026-11-22), **not used** (the app does not use what the rule is about),
**for you** (needs the person, see the list at the end), **risk** (met as we read it, a reviewer
may read it otherwise).

## The rules

### Privacy (5.1)

| Rule                                       | What it says                                                                                                                                                                                 | wizards.bot                                                                                                                                                                                                                                                                                                                                                           | Status                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 5.1.1(i) Privacy policy                    | a link "in the App Store Connect metadata field and within the app"; says what is collected, who it is shared with, how to delete and revoke consent                                         | `docs/privacy.md`; the app carries a copy (`apps/ios/App/privacy.md`, a test keeps them equal) under Settings → Privacy and in the consent screen; the web app shows the same file. The hosted address for App Store Connect and the contact address in the last line are missing.                                                                                    | met now; for you                    |
| 5.1.1(ii) Permission                       | consent for collection, "an easily accessible and understandable way to withdraw consent", purpose strings that "clearly and completely describe" the use                                    | the consent screen (below); Settings → "Where what you write goes" → Take back. Purpose strings say what happens with the data, each in English and German (table below).                                                                                                                                                                                             | met now                             |
| 5.1.1(iii) Data minimization               | ask only for what the core needs; prefer the out-of-process picker                                                                                                                           | photos through `PhotosPicker`, files through the Files picker, no library access; calendar, reminders, contacts are asked for the first time the phone's agent needs them                                                                                                                                                                                             | met                                 |
| 5.1.1(iv) Access                           | do not force consent; offer alternatives                                                                                                                                                     | every permission is optional; "Not now" on the consent screen leaves the message unsent, the app still reads, answers cards and works with the phone's own model when the home is away                                                                                                                                                                                | met                                 |
| 5.1.1(v) Account sign-in                   | no login without account features; account creation requires deletion in the app                                                                                                             | there is no account: a device pairs with the person's home by a code. Settings → Sign out makes the device forget the home and deletes its copy of the conversations and of what agents asked it. Deleting the home's data is in the privacy policy.                                                                                                                  | met                                 |
| 5.1.1(viii) Compiling personal information | no data compiled from sources other than the person, without consent                                                                                                                         | the agents work on what the person gives them and their own accounts                                                                                                                                                                                                                                                                                                  | met                                 |
| 5.1.2(i) Data use and sharing              | "clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission"; ATT for tracking; no system feature may be required | the consent screen names every company whose models the home uses and asks before anything goes; no tracking, no ATT needed; push and every permission are optional. The same sentence limits sharing to improving the app or ads; we read sharing with the model service the person chose as the app's function, which is what the "third-party AI" clause is about. | met now; risk (the second sentence) |
| 5.1.2(ii) No repurposing                   | data collected for one purpose not used for another without consent                                                                                                                          | the developer collects nothing; the home uses data for the person's own requests                                                                                                                                                                                                                                                                                      | met                                 |
| 5.1.2(v) Contacts and messages             | contact someone only "at the explicit initiative of that user", one at a time, showing the message first                                                                                     | a call or message from a card opens the system's own form with the text filled in; the person sends                                                                                                                                                                                                                                                                   | met                                 |
| 5.1.2(vi) HomeKit, HealthKit, camera data  | not for marketing or data mining                                                                                                                                                             | none of HomeKit, HealthKit or ARKit is used; camera pictures go only where the person sends them                                                                                                                                                                                                                                                                      | met                                 |
| 5.1.3 Health                               | no health data to third parties for ads or mining; no health data in iCloud                                                                                                                  | HealthKit is not used. The roadmap keeps it for a health feature the person asks for, never to a third party, asked every time                                                                                                                                                                                                                                        | not used                            |
| 5.1.4 Kids                                 | privacy policy; care with children's data                                                                                                                                                    | not for the Kids category; the policy says not for children under 13                                                                                                                                                                                                                                                                                                  | met; for you (age rating)           |
| 5.1.5 Location Services                    | only "when it is directly relevant"; notify and get consent before collecting                                                                                                                | the app does not use location. The roadmap plans "while in use" only, no "Always" (2.5.4 also limits background use)                                                                                                                                                                                                                                                  | not used                            |

### Performance (2)

| Rule                                                       | What it says                                                                                                                  | wizards.bot                                                                                                                                                                                                                                                                                                                                                                                              | Status                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 2.1(a) App completeness                                    | final versions; "include demo account info (and turn on your back-end service!)"; a demo mode needs Apple's prior approval    | the app needs a home. A demo home takes the pairing code `WIZARDS_BOT_DEMO_CODE`, which works again and again and does not run out, so a reviewer can pair whenever they review (`apps/home/src/config.ts`, tested). The demo home must run on a server with a model (a gateway key) for the whole review. Without a home, "Use this device only" works with Apple Intelligence on a device that has it. | met now (code); for you (server) |
| 2.3 Accurate metadata                                      | screenshots show the app in use, no other platforms' names                                                                    | App Store Connect                                                                                                                                                                                                                                                                                                                                                                                        | for you                          |
| 2.5.1 Public APIs; HomeKit and HealthKit for their purpose | "the HomeKit framework should provide home automation services; and HealthKit should be used for health and fitness purposes" | public APIs only; neither HomeKit nor HealthKit. Home devices are reached at the home as a connection (Home Assistant over MCP)                                                                                                                                                                                                                                                                          | met; not used                    |
| 2.5.2 Self-contained                                       | may not "download, install, or execute code which introduces or changes features"                                             | artifacts are pages an agent wrote for the person (a chart, a 3D scene). They run in a `WKWebView` with no script bridge, a non-persistent store, only when the home serves them with a `sandbox` policy, and a link opens in Safari (`ArtifactView.swift`). They are content like a document and change nothing of the app.                                                                             | met; risk                        |
| 2.5.4 Background services                                  | "only use background services for their intended purposes"                                                                    | one mode, `remote-notification`: a silent push wakes the app for a hand-off from the person's own agent and to clear answered cards. No audio, location or VoIP in the background                                                                                                                                                                                                                        | met                              |
| 2.5.6 Web browsing                                         | WebKit for web content                                                                                                        | artifacts use `WKWebView`; links open in Safari                                                                                                                                                                                                                                                                                                                                                          | met                              |
| 2.5.14 Recording                                           | "explicit user consent and a clear visual and/or audible indication" for camera and microphone                                | the system asks first; the microphone runs only while the person holds or turns on talking, which the composer shows, and iOS shows its indicator                                                                                                                                                                                                                                                        | met                              |
| 2.5.15 Files                                               | pickers include the Files app and iCloud                                                                                      | `fileImporter` for files and folders                                                                                                                                                                                                                                                                                                                                                                     | met                              |

### Design (4)

| Rule                       | What it says                                                                                                                                                                            | wizards.bot                                                                                                                                                                                                                                                                                                                                                                                    | Status                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 4.2 Minimum functionality  | "beyond a repackaged website", lasting utility                                                                                                                                          | native SwiftUI: chat with cards, documents, voice, the phone's own model with calendar, reminders, contacts and folders, hand-offs, notifications, a watch app                                                                                                                                                                                                                                 | met                                              |
| 4.2.3(i) Works on its own  | "work on its own without requiring installation of another app"                                                                                                                         | the home is not an app on the phone; the app pairs with it like a mail app with a mail account. Alone it runs "Use this device only" with Apple Intelligence                                                                                                                                                                                                                                   | met; risk on a device without Apple Intelligence |
| 4.5.4 Push                 | not required; no marketing without opt-in                                                                                                                                               | optional; only the person's own agents push, never marketing                                                                                                                                                                                                                                                                                                                                   | met                                              |
| 4.7 Mini apps, chatbots    | software not in the binary must follow the guidelines; 4.7.2 no native APIs exposed; 4.7.3 no data or permissions shared without consent each time; 4.7.4 an index with universal links | artifacts expose no native API (no bridge) and get no permission or data of the app. They are not offered software: each is made for one person in their own home, so there is nothing to index. Should a reviewer count the agent as a chatbot under 4.7.1: the model services' own filters apply, there are no other users, and a contact is removed by asking the agent (`contact_remove`). | met; risk                                        |
| 4.8 Login services         | a third-party login needs Sign in with Apple or an equal option                                                                                                                         | no login at all                                                                                                                                                                                                                                                                                                                                                                                | not used                                         |
| 1.2 User-generated content | AI content creation apps need filtering, reporting, blocking, published contact                                                                                                         | what the agents make stays with the person. Content from other people arrives only from contacts the person connected (a sent copy, a shared agent); `contact_remove` ends that. A report goes nowhere: there is no shared service. Published contact information is missing (privacy policy, last line).                                                                                      | risk; for you (contact)                          |

### Apple's frameworks

| Page                             | What it says                                                                                                                                     | wizards.bot                                                                                                                                                                                                    | Status   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Foundation Models acceptable use | prohibited uses, among them circumventing the "safety policies, guardrails", decisions without human supervision in high-risk domains            | the phone's model answers the person and the person's own agents; a guardrail refusal is passed on as it is (`OnDeviceAgent.swift`), nothing is worked around; every change on the phone asks the person first | met      |
| WeatherKit attribution           | display "the Apple Weather trademark" and "the legal link to other data sources"                                                                 | WeatherKit is not used yet; the roadmap row for weather says every place that shows it names Apple Weather and links the sources                                                                               | not used |
| App privacy details              | declare what is "collected": sent off the device so that "you and/or your third-party partners" can access it longer than needed for the request | see the table below                                                                                                                                                                                            | for you  |

## The consent

Data leaves the phone for the person's home, and from there may reach Claude (Anthropic), Codex
(OpenAI) or a gateway (OpenRouter, Vercel, OpenAI's or Anthropic's own address). Ollama on the
person's computer and the phone's own model read it where they are.

- **The home names the services.** Each model source carries `service` when it sends to a
  company outside the person's computers; `Models.services` lists them, which are in use (among
  the models the home would try) and when and on which device the person said yes
  (`apps/home/src/models/services.ts`, `docs/protocol.md` → Models).
- **The yes is kept per home** and counts for all devices of the person. A service that comes
  into use later (a gateway added, Codex signed in) asks again. One company is one yes: Claude and
  Anthropic's own address are both Anthropic.
- **The home refuses before it keeps anything.** While a service in use has no yes, a phone, a
  watch or a browser gets 409 `needs_consent` for a message, for what the phone wrote while the
  home was away, for a hand-off's answer and for a card answer with typed text. A computer (a
  terminal, a linked computer) is the person's own and is not asked.
- **The iPhone asks before it sends.** It knows the services from `/v1/models` and shows
  "Where what you write goes" before the first message: the home's address, each company with
  the sources that send to it, what may reach them, that Ollama and the phone's model need no
  yes, a link to the privacy policy, "Allow" and "Not now". "Not now" keeps the message unsent,
  with "Send again". A hand-off from an agent waits for the same answer; without a yes the phone
  declines it and nothing of the phone leaves. Settings shows each service with its yes and
  "Take back". The watch says to allow it on the iPhone.
- **The web app** shows the same dialog when the home answers `needs_consent`, sends the message
  after the yes, and lists the services with "Take back" in Settings.

Screenshots of the iPhone (Simulator, iPhone 17, English and German) are with the session's
notes; the consent screen, the settings and the privacy policy were checked against a test home
with Claude Code and Codex signed in: nothing was stored before the yes, "Take back" cleared it.

## Purpose strings

| Key                                     | English                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NSCameraUsageDescription`              | The camera reads the code that connects this device to your home, and takes the photos you send to your agents. A photo goes to your home only when you send it. |
| `NSMicrophoneUsageDescription`          | The microphone hears what you say to your agent instead of typing. It is turned into text on this device, and only the text is sent.                             |
| `NSSpeechRecognitionUsageDescription`   | What you say is turned into text on this device, never by a service elsewhere. The text goes to your agent like a message you typed.                             |
| `NSLocalNetworkUsageDescription`        | wizards.bot talks to your home when it runs on a computer in your network.                                                                                       |
| `NSCalendarsFullAccessUsageDescription` | Your agents ask this phone about your calendar. It is read here, and only the answer goes to your home. A new or changed entry asks you first.                   |
| `NSRemindersFullAccessUsageDescription` | Your agents ask this phone about your reminders. They are read here, and only the answer goes to your home. A new or changed reminder asks you first.            |
| `NSContactsUsageDescription`            | Your agents ask this phone about your contacts. They are read here, and only the answer goes to your home.                                                       |

German is in `apps/ios/App/InfoPlist.xcstrings`. No other protected resource is used: no
location, photo library, health, home, motion, Bluetooth, music or tracking.

## App privacy details

Apple counts data as collected when it leaves the device so that the developer or the
developer's partners can read it longer than one request. The app sends to one place only: the
person's own home, which the person runs and the developer cannot reach. There is no analytics,
no advertising, no crash reporting and no third-party SDK. The model services are chosen and
signed in to by the person in their own home; the developer has no agreement with them.

| Data                                                                      | Leaves the device to                                                | Collected (Apple's sense) | Linked to the person | Tracking |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- | -------------------- | -------- |
| Messages, spoken text (Other User Content)                                | the person's home; from there the model services the person allowed | no                        | –                    | no       |
| Photos and files the person adds (Photos or Videos, Other User Content)   | the person's home, when sent                                        | no                        | –                    | no       |
| Calendar, reminders, contacts (Contacts, Other User Content)              | never as such; only an answer of the phone's model, to the home     | no                        | –                    | no       |
| Device name, push token (Device ID)                                       | the person's home                                                   | no                        | –                    | no       |
| Location, health, browsing, purchases, financial, diagnostics, usage data | not read or sent                                                    | no                        | –                    | no       |

Answer in App Store Connect: **Data Not Collected**. This changes as soon as the developer runs
a home for people (a hosted home, a demo home that keeps what reviewers write) or adds crash
reporting: then Other User Content, Photos or Videos and Contacts are collected, linked to the
person, for App Functionality, and not used for tracking.

## What the reviewer needs

Review notes, to fill in once the demo home runs:

- wizards.bot is a device of the person's own home (a program on their computer or server). To
  review it, connect it to our demo home: on the first screen, enter the address
  `https://<demo address>` and the code `<demo code>`. The code works every time.
- The first message shows where messages go (5.1.2(i)): the demo home answers with
  `<gateway and model>`. Tap Allow to talk to the agent, or Not now to see that nothing is sent.
- Calendar, reminders and contacts are asked for when an agent asks the phone, for example
  "What is on my calendar tomorrow?" – the phone's own model reads them and only the answer
  goes to the home. This needs Apple Intelligence on the device.
- Artifacts (ask "draw a chart of …") are web pages the agent wrote,
  shown closed off from the app (2.5.2, 4.7).
- The background mode `remote-notification` wakes the app when one of the person's agents hands
  it a question (2.5.4).

## What is left for you

1. **Contact address.** Replace `CONTACT_ADDRESS` in the last line of `docs/privacy.md` (and copy
   the file to `apps/ios/App/privacy.md`) with an address that answers. 1.2 and 5.1.1(i) ask for
   it.
2. **A hosted privacy policy.** Put `docs/privacy.md` at a public address (e.g.
   `https://wizards.bot/privacy`) and enter it in App Store Connect → App Privacy → Privacy Policy
   URL. The app shows its own copy; App Store Connect needs the address.
3. **The demo home.** A home on a server (`docs/vps.md`) with `WIZARDS_BOT_URL`, a gateway with a
   key and credit for the review, and `WIZARDS_BOT_DEMO_CODE` set to a code of at least 8 letters
   and digits. Keep it running until the review is done; it must hold no one's real data. Put its
   address and the code into the review notes above.
4. **App Store Connect entries.** App privacy: "Data Not Collected" (see above); age rating
   questionnaire (the agents' models can write anything a general chat model writes – answer
   the questions on unrestricted web access and generated content honestly); category
   (Productivity); screenshots of the app in use with made-up data (2.3.3, 2.3.9).
5. **Decide on contacts for the first version.** Sending copies and sharing agents between homes
   brings other people's content into the app (1.2). Either keep it and state in the review
   notes that only connected contacts can send and `contact_remove` blocks them, or leave it out
   of the first version.
6. **On a real iPhone with Apple Intelligence:** a hand-off with the consent waiting (the
   notification "Where what you write goes" while the app is in the background), and "Use this
   device only" for a reviewer without a home.
7. **Push.** An APNs key for the demo home if the reviewer should see notifications
   (`docs/notifications.md`); without it the app notifies while it runs.
