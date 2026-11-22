export { buildFigure, DEPTH, HEIGHT, WIDTH } from "./figure.ts";
export {
  type Look,
  lookAt,
  lookStep,
  MAX_TILT,
  MAX_TURN,
  STRAIGHT,
  sameLook,
  tiltHead,
} from "./look.ts";
export { colorOf, cubeAt, type HeadPlace, type Model, onHead, PART, partOf } from "./model.ts";
export { GARMENT, HAIR, SKIN } from "./palette.ts";
export {
  headPoint,
  type Picture,
  renderStack,
  type StackOptions,
  spriteSheet,
  stackSize,
  type View,
} from "./stack.ts";
export { DEFAULT_AVATAR, savedTraits } from "./traits.ts";
