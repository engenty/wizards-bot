# Notifications

The Bot Server notifies you in two cases, and nowhere else:

|                     | When                                                                             | How it arrives                                                                           |
| ------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| something needs you | an agent put a card into the chat that waits: an approval, a question, a sign-in | time-sensitive, with the card's buttons. It comes through in a Focus and in quiet hours. |
| an agent answered   | a reply, a result, a scheduled task's report                                     | a normal notification. Silent in the device's quiet hours.                               |

- A card with at most two buttons and no fields is answered on the notification itself, on the
  phone and on the watch.
- The first answer wins. Every other device then drops the notification and shows the card as
  answered.
- The app's badge is the number of cards that wait.
- An agent answering another agent notifies nobody. You hear of it when the first agent reports.
- A quiet task notifies you only when its run ends with an answer or a card. When nothing needs
  you, the run leaves a note: one line in the conversation, no notification, not counted as
  unread. A quiet run that failed leaves its line the same way.
- Longer work notifies you once, at its end, not after each of its turns. A card in between
  notifies you as every card does.
- A task the Bot Server paused, because it failed three times in a row or what it waits for is gone,
  is something that needs you: a card with "Try again" and "Remove task".
- The offer of a morning look in a new Bot Server is a card that does not notify.
- A reply to a message from Slack, email, WhatsApp or Signal goes back there. What an agent
  starts by itself goes to your devices. Without a push key it goes to the channel you used last.

## Push to the phone

Apple delivers a push only from a holder of a signing key of the app's developer account. The
Bot Server sends pushes itself, so it needs that key once:

1. In the Apple developer account: Certificates, Identifiers & Profiles → Keys → new key with
   "Apple Push Notifications service (APNs)". Download the `.p8` file, note the key id.
2. On the Bot Server's computer:

```bash
wizards-bot push --key AuthKey_ABC123.p8 --key-id ABC123 --team-id 7X9X3MSWJA
```

Without the key the app still notifies while it runs, from the event stream.

## Quiet hours

A device sets them with `PATCH /v1/device` (`quiet: { from, to, timezone }`). In those hours the
Bot Server pushes only what needs you.
