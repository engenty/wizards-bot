import { describe, expect, it } from "vitest";
import { degrees, dragAngle, KEY_STEP, keyAngle, wrapAngle } from "./turn";

describe("wrapAngle", () => {
  it("keeps an angle within one turn", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0);
    expect(wrapAngle(-Math.PI / 2)).toBeCloseTo((Math.PI * 3) / 2);
    expect(wrapAngle(Math.PI * 5)).toBeCloseTo(Math.PI);
  });
});

describe("dragAngle", () => {
  it("turns the figure half round for a drag as wide as itself", () => {
    expect(dragAngle(0, -120, 120)).toBeCloseTo(Math.PI);
    expect(dragAngle(0, 60, 120)).toBeCloseTo((Math.PI * 3) / 2);
  });

  it("goes on from where the figure stood, and back to it", () => {
    const turned = dragAngle(1, 30, 120);
    expect(dragAngle(turned, -30, 120)).toBeCloseTo(1);
  });

  it("leaves a figure that has no width where it is", () => {
    expect(dragAngle(1, 30, 0)).toBe(1);
  });
});

describe("keyAngle", () => {
  it("turns a step with an arrow, sixteen steps for a whole turn", () => {
    let angle = 0;
    for (let i = 0; i < 16; i++) {
      angle = keyAngle(angle, "ArrowLeft") ?? angle;
    }
    expect(wrapAngle(angle + 0.001)).toBeCloseTo(0.001);
    expect(keyAngle(0, "ArrowRight")).toBeCloseTo(Math.PI * 2 - KEY_STEP);
  });

  it("shows the face with Home and leaves other keys alone", () => {
    expect(keyAngle(2, "Home")).toBe(0);
    expect(keyAngle(2, "Enter")).toBeNull();
  });
});

describe("degrees", () => {
  it("names an angle in whole degrees below 360", () => {
    expect(degrees(Math.PI)).toBe(180);
    expect(degrees(-Math.PI / 2)).toBe(270);
    expect(degrees(Math.PI * 2 - 0.0001)).toBe(0);
  });
});
