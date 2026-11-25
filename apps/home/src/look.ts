import { ChatLook } from "@wizards-bot/protocol";
import type { Home } from "./home.ts";

/** How the chat looks to the person, for all their devices. In a group home, to each person of it. */
export class Looks {
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
  }

  get(personId?: string): ChatLook {
    const saved = this.home.db.meta(key(personId));
    return ChatLook.parse(saved ? JSON.parse(saved) : {});
  }

  set(look: ChatLook, personId?: string): void {
    this.home.db.setMeta(key(personId), JSON.stringify(look));
    this.home.events.emit({
      type: "look.updated",
      look,
      ...(personId ? { person: personId } : {}),
    });
  }
}

const key = (personId?: string) => (personId ? `chat.look.${personId}` : "chat.look");
