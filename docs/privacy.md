# Privacy policy of wizards.bot

Last changed: November 22, 2026

wizards.bot is a personal agent that runs on your own Bot Server: a program on your computer or on a server you rent. The apps for iPhone, iPad, Apple Watch and the browser are devices of that Bot Server. This page says what the apps and the Bot Server do with your data, who else can read it, and how you take a yes back or delete everything.

## Who runs what

- **Your Bot Server** runs on a computer or a server you choose. It keeps your agents, their memory, your conversations, your documents and files, and the keys to your accounts. You run it; the makers of wizards.bot have no server in between and no access to your Bot Server.
- **The apps** talk only to your Bot Server, at the address you paired them with. They send nothing to the makers of wizards.bot. There is no analytics, no advertising and no tracking, and no third-party code that collects data.

## What the apps send to your Bot Server

- What you write or say to your agents (speech is turned into text on the device), the files and photos you add, and your answers to your agents' questions.
- The device's name and, when you allow notifications, its push token, so the Bot Server can notify you.
- Which of calendar, reminders, contacts and the folders connected on the phone you allowed, by name only. The Bot Server never receives what they hold.
- The answer to a question an agent of yours handed to the phone. The model on the phone reads your calendar, reminders, contacts and the folders connected on the phone to answer it; only the answer goes to the Bot Server, and a file goes only after you said yes to it on the phone.

The apps keep a copy of your recent conversations on the device, and the phone keeps the list of what your agents asked it. That list never leaves the phone.

## Model services

Your Bot Server answers with models. Some run on your own computers (Ollama, the model of Apple Intelligence on your phone). Others belong to a company: Claude (Anthropic) and Codex (OpenAI) when you are signed in to them on a computer, or a gateway such as OpenRouter when you added one. These read what the Bot Server gives them for an answer: your messages, the files you added, the answers of your phone and what your agents found.

- Before anything you write on a device reaches such a company, the app shows which companies your Bot Server uses and asks for your yes. Nothing is sent before you answer. When your Bot Server starts to use another company, you are asked again.
- Each company handles what it reads under its own terms, which you accepted when you signed in to it or created its key. wizards.bot has no agreement with these companies and passes nothing to them itself.
- A photo of you for your avatar is looked at by a model on your own computer. Any other model sees it only after you said yes to that, and the Bot Server deletes the photo afterwards.

## Accounts and services you connect

When you connect an account or a service (a calendar, mail, Slack), your Bot Server talks to it with the sign-in or key you gave. The key stays on your Bot Server and no model reads it. A service signed in on the phone keeps its token in the phone's Keychain. Anything that changes something in such a service asks you first.

## What leaves your Bot Server on your word only

- A published link shows one document or artifact to anyone who has the link, for the time you chose, until you take it back.
- A copy you send goes to the Bot Server of a contact you connected with.
- Your agents write to an agent outside your Bot Server only after you said yes.

## Taking a yes back and deleting

- **Model services:** Settings, then "Where what you write goes", then "Take back". The next message asks again.
- **Calendar, reminders, contacts, camera, microphone, speech, local network:** in the system's Settings app, under wizards.bot.
- **An agent's questions to the phone:** the agent's Data on the phone.
- **This device:** Settings, then "Sign out". The device forgets the Bot Server and deletes its copy of your conversations and of what your agents asked it.
- **Everything:** your data is on your Bot Server's data folder (`WIZARDS_BOT_DATA`, by default `~/.wizards-bot`). Deleting that folder deletes your agents, conversations, files and keys. What a model service already read is deleted under that company's terms.

The Bot Server keeps your data until you delete it. It deletes a photo for your avatar once it has read it, and a file a device sent for a hand-off stays with the conversation it belongs to.

## Children

wizards.bot is not meant for children under 13 and does not knowingly ask them for data.

## Changes and contact

When this policy changes, the date at the top changes with it. Questions about privacy: CONTACT_ADDRESS.
