/** A whole turn, in radians. */
const TURN = Math.PI * 2;

/** One press of an arrow key turns the figure by this much: sixteen presses go round. */
export const KEY_STEP = TURN / 16;

/** An angle as the same direction within one turn, from 0 up to a whole turn. */
export function wrapAngle(angle: number): number {
  return ((angle % TURN) + TURN) % TURN;
}

/**
 * The angle of a figure that is dragged sideways: its own width under the finger is half a
 * turn, so the side that is grabbed follows the pointer.
 */
export function dragAngle(from: number, dx: number, width: number): number {
  return width > 0 ? wrapAngle(from - (dx / width) * Math.PI) : from;
}

/** The angle after a key: the arrows turn a step, Home shows the face. Any other key: null. */
export function keyAngle(angle: number, key: string): number | null {
  if (key === "ArrowLeft") {
    return wrapAngle(angle + KEY_STEP);
  }
  if (key === "ArrowRight") {
    return wrapAngle(angle - KEY_STEP);
  }
  return key === "Home" ? 0 : null;
}

/** An angle in whole degrees, 0 to 359, as a screen reader says it. */
export function degrees(angle: number): number {
  return Math.round((wrapAngle(angle) / TURN) * 360) % 360;
}
