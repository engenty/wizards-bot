# wizards.bot for iPhone, iPad and Apple Watch

The app is a device of your home. It shows one chat with your agent, the cards the agent sends, and
a document beside the chat when there is one. The watch app talks to your agent and answers cards.

What a home and its devices say to each other is in `docs/protocol.md`. The Swift types in
`Shared/Protocol` mirror `packages/protocol/src/index.ts`.

## What you need

- Xcode 26 or newer. The project has no packages and no other tools.
- A home that listens, in development on `http://localhost:4747`. Without one, choose
  "Use this device only" on the first screen.

## What stays on the phone

The phone keeps its own data: the calendar, the reminders, the contacts, folders connected on
the phone (iCloud Drive, On My iPhone or any other place in Files, kept as a bookmark) and
services signed in on the phone (an MCP server, its token in the phone's Keychain,
`Phone/MCPClient.swift`). The model
on the phone (`App/Services/OnDeviceAgent.swift`) works on them with the phone's tools
(`Phone/PhoneTools.swift`, wrapped for the model in `App/Services/PhoneModelTools.swift`): it
answers the person when the home is out of reach, and it answers the questions the home's agents
hand to the phone (a hand-off, `App/Model/HandoffDesk.swift`). Only the answer goes to the home.

- Every change (a calendar entry, a reminder) and every file that would leave the phone asks the
  person on the phone first.
- The first question of an agent asks whether that agent may ask this phone. The agent's "Data"
  shows the yes, lets the person take it back, and lists what was asked and what went back. That
  list stays on the phone.
- The home only learns what the phone offers (`PUT /v1/device/resources`): which of calendar,
  reminders and contacts the person did not refuse, and the names of the connected folders.
- A silent push from the home wakes the app for a hand-off; what needs the person then waits as a
  notification.
- A card of the skill `app-links` opens a link, a call or a message draft when the person taps
  it (`Phone/PhoneAction.swift`, `App/UI/PhoneActionSheet.swift`): the phone finds the number in
  its contacts and opens the system's own form; the person sends.
- The answers are kept short: the model reads about 4 000 tokens in all, tool descriptions
  included. A tool's answer lists at most 15 lines and reads a file 1 500 characters at a time.

## Build and run

Open `WizardsBot.xcodeproj` and run the scheme `wizards` (iPhone, iPad) or `wizardsWatch`.

From a terminal, in this folder:

```sh
xcodebuild -project WizardsBot.xcodeproj -scheme wizards \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build build

xcodebuild -project WizardsBot.xcodeproj -scheme wizardsWatch \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' -derivedDataPath build build
```

Start the app in a simulator that is running:

```sh
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/wizards.app
xcrun simctl launch booted bot.wizards
xcrun simctl io booted screenshot pairing.png
```

A pairing link connects the app without typing. `wizards-bot pair` prints the code:

```sh
xcrun simctl openurl booted 'wizardsbot://pair?home=http://localhost:4747&code=K7QM-2RXD'
```

The watch gets its home from the phone. In simulators this works when the watch simulator is
paired with the phone simulator (`xcrun simctl list pairs`) and both apps are open.

## Test

```sh
xcodebuild -project WizardsBot.xcodeproj -scheme wizards \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build test
```

The tests decode every JSON example of `docs/protocol.md`, read the file itself when it is there,
and check unknown part types, card kinds and event types. The phone's tools are tested against a
made-up calendar (`FakePhoneData`) and folders in a temporary directory: short answers, nothing
changed or sent without a yes, nothing read outside a folder. They also cover the event stream parser,
the reconnect pauses and the sentence splitter for speech.

## Where things are

| Folder | What it holds |
|---|---|
| `App` | the iOS app: `Model` (state), `Services` (voice, notifications, the model on this device), `UI` |
| `Watch` | the watch app |
| `Shared` | used by both: protocol types, the home client, the event stream, the engenty figures, speech |
| `Phone` | what the phone keeps and its tools: calendar, reminders and contacts behind `PhoneData`, the folders connected on the phone, the tools of the phone's model; built into the app and the tests |
| `Notify` | notification categories, shared with the notification service |
| `NotificationService` | gives a pushed card its buttons |
| `Tests` | Swift Testing |
| `Config` | Info.plist additions and entitlements |

The project uses folders that Xcode keeps in step with the disk. A new file in one of these
folders is part of its targets without editing the project.

## Good to know

- English is the source language. German is in `App/Localizable.xcstrings` and
  `Watch/Localizable.xcstrings`. `xcodebuild` does not add new texts to these files: add them by
  hand, or build once in Xcode.
- The model on this device needs Apple Intelligence. The app treats a Simulator as having no
  model: it lacks the model's safety assets and every answer fails. A hand-off to a Simulator is
  therefore answered "could not work on it"; try hand-offs on a phone.
- Calendar, reminders and contacts ask for permission the first time the phone's agent needs
  them. The texts are in `Config/Info.plist` and `App/InfoPlist.xcstrings`.
- Speech is turned into text on the device only. A language without on-device recognition gets a
  plain message instead of being sent away.
- Pushes need a real device, a signing team with push, and a home with an APNs key. Without them
  the app posts local notifications while it runs.
