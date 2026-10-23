/**
 * Browser entry for headless snapshots (bundled into public/render-snap/snap.js).
 * Exposes one function the Chrome worker calls: window.__dbbSnap(ldraw, opts).
 * The renderer itself is lib/render/snapScene.ts, shared with the live
 * builder's client-side eyes.
 */
import { snapScene } from "./snapScene";
export type { SnapOpts } from "./snapScene";

declare global {
  interface Window {
    __dbbSnap?: typeof snapScene;
    __dbbSnapReady?: boolean;
  }
}
window.__dbbSnap = snapScene;
window.__dbbSnapReady = true;
