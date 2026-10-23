/**
 * Motors. The parts library draws a motor as ONE part, but its output turns: an axle in a motor's output is
 * not keyed to whatever holds the motor. This says which of a motor's connectors are on that turning output,
 * so a reader of the contact geometry can treat them as a bearing instead of a weld.
 */
import { connFrame, mulMV, type LocalConnector } from "@/lib/editor2/kinematics";

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
export const connectorAxis = (c: LocalConnector): V3 => unit(mulMV(connFrame(c).r, [0, 1, 0]));

/**
 * Motors whose output is a DISC with pin holes that turns with the axle hole (Powered Up large / XL / angular):
 * the holes within this radius of the output axis belong to the output. For any other motor only the axle
 * hole itself turns; its neighbours are part of the housing.
 */
const OUTPUT_DISC_RADIUS: Record<string, number> = { "22169": 22, "22172": 22, "54696": 22, "54675": 22, "88017": 22, "88018": 22 };

/** Which of a motor's connectors are on its turning output (and the axle hole they turn about), or null when the part is not a motor that can be read. */
export function motorOutput(part: string, name: string, cs: LocalConnector[]): { rotor: Set<number>; at: LocalConnector } | null {
  // (catalogue names read "Motor, Medium, Power Functions, … and 20cm Wire": the wire is part of the motor)
  if (!/\bmotor\b/i.test(name) || /motor cover|decorative|connecting rod|axle (bush|hub)|boat (rudder|propeller)/i.test(name)) return null;
  // the output is where an axle goes in: a female connector with a cross ("A") section
  const holes = cs.filter((c) => c.kind === "cyl" && c.gender === "F" && /(^|\s)A\s/.test(c.secs ?? ""));
  if (!holes.length) return null;
  const at = holes[0], dir = connectorAxis(at);
  const disc = OUTPUT_DISC_RADIUS[part.replace(/c\d+$/, "")] ?? 0;
  const rotor = new Set<number>();
  cs.forEach((c, i) => {
    if (c.kind !== "cyl" || Math.abs(dot(connectorAxis(c), dir)) < 0.98) return;
    const d = sub(c.local as V3, at.local as V3), along = dot(d, dir);
    const off = Math.hypot(d[0] - dir[0] * along, d[1] - dir[1] * along, d[2] - dir[2] * along);
    if (off <= 1 || (off <= disc && Math.abs(along) <= 24)) rotor.add(i); // on the axis (either end of a through shaft), or on the disc
  });
  return { rotor, at };
}
