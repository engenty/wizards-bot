import {
  buildFigure,
  DEFAULT_AVATAR,
  renderStack,
  savedTraits,
  stackSize,
  type View,
} from "@wizards-bot/avatar";
import { encodePng } from "@wizards-bot/avatar/png";
import { Avatar, type AvatarFromSelfie } from "@wizards-bot/protocol";
import { generateText } from "ai";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import { PICTURES } from "../files/check.ts";
import type { Home } from "../home.ts";
import { newToken } from "../ids.ts";

// The person as a pixel figure. Its traits are kept, not a picture: a device draws the
// figure itself, or asks for one as a PNG. A selfie becomes traits by a model looking at it.

export class NoPictureModel extends Error {}
export class NotAPicture extends Error {}
/** Only a model outside the person's computer could look at the picture: the names of those models. */
export class LeavesHome extends Error {
  readonly models: string[];
  constructor(models: string[]) {
    super("leaves home");
    this.models = models;
  }
}

/** One trait with a style and a colour; what a model gets wrong is the plain figure's. */
const styled = <S extends z.ZodEnum, C extends z.ZodEnum>(
  shape: { style: S; color: C },
  plain: { style: z.infer<S>; color: z.infer<C> },
) =>
  z
    .object({ style: shape.style.catch(plain.style), color: shape.color.catch(plain.color) })
    .catch(plain);

/**
 * The traits as a model may give them, also in the shape traits once had: what it gets
 * wrong falls back to the plain figure.
 */
const Lenient = z.object({
  skin: Avatar.shape.skin.catch(DEFAULT_AVATAR.skin),
  hair: styled(Avatar.shape.hair.shape, DEFAULT_AVATAR.hair),
  glasses: Avatar.shape.glasses.catch("none"),
  beard: Avatar.shape.beard.catch("none"),
  hat: styled(Avatar.shape.hat.shape, { ...DEFAULT_AVATAR.hat, style: "none" }),
  top: styled(Avatar.shape.top.shape, DEFAULT_AVATAR.top),
  bottom: styled(Avatar.shape.bottom.shape, DEFAULT_AVATAR.bottom),
  shoes: styled(Avatar.shape.shoes.shape, DEFAULT_AVATAR.shoes),
  accessory: styled(Avatar.shape.accessory.shape, { ...DEFAULT_AVATAR.accessory, style: "none" }),
});

const options = (schema: { options: readonly string[] }): string => schema.options.join(" | ");
const { shape } = Avatar;

/** What the model is asked: only what a figure needs, in the words a figure knows. */
export const SELFIE_INSTRUCTIONS = `You look at a photo of a person and describe how to draw them as a small pixel figure.
Say only what is visible. Do not say who the person is, and nothing about them beyond these traits.
Answer with one JSON object and nothing else:
{
  "skin": ${options(shape.skin)},
  "hair": { "style": ${options(shape.hair.shape.style)}, "color": ${options(shape.hair.shape.color)} },
  "glasses": ${options(shape.glasses)},
  "beard": ${options(shape.beard)},
  "hat": { "style": ${options(shape.hat.shape.style)}, "color": <a colour below> },
  "top": { "style": ${options(shape.top.shape.style)}, "color": <a colour below> },
  "bottom": { "style": ${options(shape.bottom.shape.style)}, "color": <a colour below> },
  "shoes": { "style": ${options(shape.shoes.shape.style)}, "color": <a colour below> },
  "accessory": { "style": ${options(shape.accessory.shape.style)}, "color": <a colour below> }
}
Colours: ${options(shape.shoes.shape.color)}.
Hair: "buzz" is cropped close, "quiff" brushed up at the front, "curtains" parted in the middle and falling to both sides, "afro" a large round head of curls, "bob" to the chin, "long" past the shoulders, "pigtails" two tails at the sides. Top: "tank" has no sleeves, "stripes" is a striped long-sleeved top. Bottom: "wide" are wide-legged trousers, "longskirt" reaches the ankles. Hat: "brim" is a hat with a brim all round. Accessory: the one thing worn besides the clothes that stands out most, or "none".
Pick the closest value for each trait. What the photo does not show (often the legs and shoes), choose so that it suits the rest.`;

/** The traits in a model's answer, however it wrapped them. */
export function avatarFromAnswer(answer: string): Avatar | undefined {
  const from = answer.indexOf("{");
  const to = answer.lastIndexOf("}");
  if (from < 0 || to <= from) return undefined;
  try {
    return Lenient.parse(savedTraits(JSON.parse(answer.slice(from, to + 1))));
  } catch {
    return undefined;
  }
}

export class Avatars {
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
  }

  get(): Avatar | null {
    const saved = this.home.db.meta("person.avatar");
    const parsed = saved ? Avatar.safeParse(savedTraits(JSON.parse(saved))) : undefined;
    return parsed?.success ? parsed.data : null;
  }

  set(avatar: Avatar | null): void {
    this.home.db.setMeta("person.avatar", avatar ? JSON.stringify(avatar) : "");
    this.home.events.emit({ type: "avatar.updated", avatar });
  }

  /**
   * The figure as a PNG about `size` pixels high, turned by `degrees`: the whole of it, or
   * its head and shoulders in a square.
   */
  png(avatar: Avatar, degrees: number, size: number, view: View = "body"): Buffer {
    const model = buildFigure(avatar);
    const unit = stackSize(model, 1, view).height;
    const scale = Math.max(1, Math.min(24, Math.round(size / unit)));
    return encodePng(renderStack(model, { angle: (degrees * Math.PI) / 180, scale, view }));
  }

  /**
   * Has a model look at a picture of the person and name the figure's traits. A model on
   * the home's own computer is asked first. Any other model sees the picture only with
   * `anywhere`: without it, `LeavesHome` names the models that could, and the picture is
   * kept for the second try. In every other case the picture is deleted afterwards.
   * Nothing is saved here.
   */
  async fromSelfie(fileId: string, anywhere = false): Promise<AvatarFromSelfie> {
    const { home } = this;
    const file = home.files.get(fileId);
    const bytes = file && home.files.bytes(file.id);
    let keep = false;
    try {
      if (!file || !bytes || !PICTURES.includes(file.mime)) throw new NotAPicture();
      await home.models.refresh();
      const picture = { base64: bytes.toString("base64"), mime: file.mime };
      const { here, elsewhere } = home.models.forPictures();
      for (const ref of here) {
        const avatar = await this.look(ref, picture);
        if (avatar) return { avatar, model: ref, where: home.models.where };
      }
      if (!elsewhere.length) throw new NoPictureModel();
      if (!anywhere) {
        keep = true;
        throw new LeavesHome(elsewhere.map((model) => model.label));
      }
      for (const { ref } of elsewhere) {
        const avatar = await this.look(ref, picture);
        if (avatar) return { avatar, model: ref, where: "outside your computer" };
      }
      throw new NoPictureModel();
    } finally {
      if (file && !keep) home.files.remove(file.id);
    }
  }

  /** One model's reading of the picture, or nothing when it did not answer with traits. */
  private async look(
    ref: string,
    picture: { base64: string; mime: string },
  ): Promise<Avatar | undefined> {
    const { home } = this;
    const engine = home.models.engine(ref);
    if (!engine) return undefined;
    // A subscription client asks for its tools over MCP even when it gets none.
    const mcpToken = newToken();
    const conversationId = `avatar-${mcpToken.slice(0, 12)}`;
    home.mcp.open(mcpToken, { tools: [] });
    try {
      const { text } = await generateText({
        model: engine.model({ mcpToken, conversationId }) as never,
        system: SELFIE_INSTRUCTIONS,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this person as a pixel figure." },
              { type: "file", data: picture.base64, mediaType: picture.mime },
            ],
          },
        ],
        maxOutputTokens: 600,
      });
      const avatar = avatarFromAnswer(text);
      if (!avatar) console.error(`[avatar] ${ref} named no traits.`);
      return avatar;
    } catch (error) {
      console.error(`[avatar] ${ref} did not answer: ${(error as Error)?.message ?? error}`);
      return undefined;
    } finally {
      home.mcp.close(mcpToken);
      home.db.run("delete from meta where key like ?", `session.${conversationId}.%`);
    }
  }

  private tools(context: TurnContext): Tool[] {
    if (!context.agent.main) return [];
    return [
      defineTool({
        name: "avatar_set",
        description:
          "Set how the person looks as a pixel figure in their apps. When they send a photo of themselves and ask for an avatar, look at the photo and choose the closest value for each trait. Say nothing about who they are.",
        input: Avatar,
        label: () => "Drawing your avatar",
        run: async (avatar) => {
          this.set(avatar);
          return "The avatar is set. The person sees the figure in their app and can turn it.";
        },
      }),
    ];
  }
}
