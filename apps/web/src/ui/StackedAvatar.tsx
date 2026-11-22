import {
  buildFigure,
  headPoint,
  type Look,
  lookAt,
  lookStep,
  renderStack,
  STRAIGHT,
  sameLook,
  stackSize,
  type View,
} from "@wizards-bot/avatar";
import type { Avatar } from "@wizards-bot/protocol";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useStill } from "../lib/motion";
import { watchPointer } from "../lib/pointer";
import { degrees, dragAngle, keyAngle, wrapAngle } from "../lib/turn";
import { cn } from "./index";

/** Canvas pixels per CSS pixel: a whole number, so every cube lands on whole screen pixels. */
const DENSITY = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));

/** By itself the figure turns in small steps, once round in 24 seconds. */
const IDLE_STEP = (Math.PI * 2) / 120;
const IDLE_MS = 200;

/** The angle a still figure stands at: turned a little, so the face and one side show. */
const STILL = -0.5;

/** CSS pixels from the head at which the head is turned most of the way towards the pointer. */
const LOOK_REACH = 160;
/** How much of the way to where it looks the head goes in one frame. */
const LOOK_EASE = 0.2;

/**
 * Where the head looks: towards the mouse pointer, turned from the body at `body`, and straight
 * ahead again once the pointer rests or is gone. It moves a little every frame while it has
 * further to go, and gives a new look only when that is drawn differently. The canvas is
 * measured once and again only after a scroll or a change of size.
 */
function useLook(
  canvas: RefObject<HTMLCanvasElement | null>,
  follows: boolean,
  body: number,
  head: { x: number; y: number },
): Look {
  const [look, setLook] = useState<Look>(STRAIGHT);
  const still = useStill();
  const bodyAt = useRef(body);
  const nudge = useRef<() => void>(() => undefined);
  useEffect(() => {
    bodyAt.current = body;
    nudge.current();
  }, [body]);

  useEffect(() => {
    const element = canvas.current;
    if (!(follows && element) || still) return;
    let place: DOMRect | null = null;
    let pointer: { x: number; y: number } | null = null;
    let now = STRAIGHT;
    let drawn = STRAIGHT;
    let frame = 0;
    const step = (): void => {
      frame = 0;
      place ??= element.getBoundingClientRect();
      const target = pointer
        ? lookAt(
            pointer.x - place.left - head.x,
            pointer.y - place.top - head.y,
            LOOK_REACH,
            bodyAt.current,
          )
        : STRAIGHT;
      const turn = now.turn + (target.turn - now.turn) * LOOK_EASE;
      const tilt = now.tilt + (target.tilt - now.tilt) * LOOK_EASE;
      const there = Math.abs(target.turn - turn) < 0.005 && Math.abs(target.tilt - tilt) < 0.02;
      now = there ? target : { turn, tilt };
      if (!sameLook(now, drawn)) {
        drawn = lookStep(now);
        setLook(drawn);
      }
      if (!there) frame = requestAnimationFrame(step);
    };
    nudge.current = () => {
      if (!frame) frame = requestAnimationFrame(step);
    };
    const moved = (): void => {
      place = null;
    };
    const sized = new ResizeObserver(moved);
    sized.observe(element);
    window.addEventListener("scroll", moved, { capture: true, passive: true });
    window.addEventListener("resize", moved, { passive: true });
    const stop = watchPointer((at) => {
      pointer = at;
      // The pointer is told of in a frame already: the head moves in this one.
      if (!frame) step();
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
      sized.disconnect();
      window.removeEventListener("scroll", moved, { capture: true });
      window.removeEventListener("resize", moved);
      nudge.current = () => undefined;
      setLook(STRAIGHT);
    };
  }, [canvas, follows, still, head.x, head.y]);
  return look;
}

/**
 * The person's avatar: a pixel figure drawn from stacked sprites, so it turns to any angle.
 * `view`: `head` is head and shoulders on a tile, for a small place beside a name; `body`
 * the whole figure, where there is room. `turns`: it follows a drag and the arrow keys (Home
 * shows the face), and until the person turns it, it turns slowly by itself, unless the system
 * asks for less motion. Without `turns` it stands still, turned a little towards the reader.
 * `follows`: its head turns towards the mouse pointer, also unless the system asks for less
 * motion.
 */
export function StackedAvatar({
  avatar,
  size,
  view = "body",
  turns,
  follows,
  label,
  className,
}: {
  avatar: Avatar;
  /** CSS pixels per cube of the figure, a whole number. */
  size: number;
  view?: View;
  turns?: boolean;
  follows?: boolean;
  /** What a screen reader calls it; without one the figure is decoration beside a name. */
  label?: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [angle, setAngle] = useState(turns ? 0 : STILL);
  /** The person has turned the figure: it no longer turns by itself. */
  const [held, setHeld] = useState(false);
  const drag = useRef<{ x: number; angle: number } | null>(null);
  const model = useMemo(() => buildFigure(avatar), [avatar]);
  const scale = size * DENSITY;
  // The canvas is a whole number of CSS pixels wide and high, so no cube falls between two.
  const picture = stackSize(model, scale, view);
  const width = Math.ceil(picture.width / DENSITY) * DENSITY;
  const height = Math.ceil(picture.height / DENSITY) * DENSITY;
  const head = useMemo(() => {
    const point = headPoint(model, scale, view);
    return { x: point.x / DENSITY, y: point.y / DENSITY };
  }, [model, scale, view]);
  const { turn, tilt } = useLook(canvas, follows ?? false, angle, head);

  useEffect(() => {
    const drawn = renderStack(model, { angle, scale, view, look: { turn, tilt } });
    const pixels = new ImageData(drawn.width, drawn.height);
    pixels.data.set(drawn.data);
    canvas.current?.getContext("2d")?.putImageData(pixels, 0, 0);
  }, [model, angle, scale, view, turn, tilt]);

  useEffect(() => {
    if (!turns || held || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const timer = setInterval(() => setAngle((a) => wrapAngle(a + IDLE_STEP)), IDLE_MS);
    return () => clearInterval(timer);
  }, [turns, held]);

  const style = { width: width / DENSITY, height: height / DENSITY };
  if (!turns) {
    return (
      <canvas
        ref={canvas}
        width={width}
        height={height}
        style={style}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        className={cn(
          "[image-rendering:pixelated]",
          view === "head" && "rounded-[22%] bg-paper-2",
          className,
        )}
      />
    );
  }
  return (
    <canvas
      ref={canvas}
      width={width}
      height={height}
      style={style}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={degrees(angle)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, angle };
        setHeld(true);
      }}
      onPointerMove={(e) => {
        const from = drag.current;
        if (from) {
          setAngle(dragAngle(from.angle, e.clientX - from.x, e.currentTarget.clientWidth));
        }
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        const next = keyAngle(angle, e.key);
        if (next !== null) {
          e.preventDefault();
          setAngle(next);
          setHeld(true);
        }
      }}
      // A sideways drag turns the figure; up and down still scrolls the page under a finger.
      className={cn(
        "cursor-grab touch-pan-y rounded-lg [image-rendering:pixelated] active:cursor-grabbing",
        className,
      )}
    />
  );
}
