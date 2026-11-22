// Where the mouse pointer is, for figures that look at it. One set of listeners serves every
// figure, and a figure hears of a move at most once a frame. A pointer that rests for a few
// seconds, leaves the window or gives way to a finger is gone: nothing keeps looking at it.

/** The pointer in CSS pixels of the window; null while there is none to look at. */
export type Pointer = { x: number; y: number } | null;

/** How long a resting pointer is still looked at. */
const RESTS_AFTER = 3000;

const watchers = new Set<(pointer: Pointer) => void>();
let pointer: Pointer = null;
let frame = 0;
let timer = 0;
let moved = 0;

function tell(): void {
  frame = 0;
  for (const watcher of watchers) watcher(pointer);
}

function soon(): void {
  if (!frame) frame = requestAnimationFrame(tell);
}

function gone(): void {
  if (!pointer) return;
  pointer = null;
  soon();
}

/** One timer for all moves: when it runs out, it waits again for as long as the pointer moved. */
function rest(): void {
  const still = performance.now() - moved;
  timer = still >= RESTS_AFTER ? 0 : window.setTimeout(rest, RESTS_AFTER - still);
  if (!timer) gone();
}

function onMove(event: PointerEvent): void {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY };
  moved = performance.now();
  if (!timer) timer = window.setTimeout(rest, RESTS_AFTER);
  soon();
}

function onDown(event: PointerEvent): void {
  if (event.pointerType === "touch") gone();
}

function onOut(event: PointerEvent): void {
  if (!event.relatedTarget) gone();
}

/** Calls `watcher` when the pointer moves or is gone, until the returned function is called. */
export function watchPointer(watcher: (pointer: Pointer) => void): () => void {
  if (!watchers.size) {
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerout", onOut, { passive: true });
    window.addEventListener("blur", gone);
  }
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    if (watchers.size) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerdown", onDown);
    document.removeEventListener("pointerout", onOut);
    window.removeEventListener("blur", gone);
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = 0;
    pointer = null;
  };
}
