/**
 * The renderer every server-side caller uses (agents' eyes, thumbnails,
 * the visual judge, `dbb render`): our three.js pipeline in headless
 * Chrome (./chromium). LeoCAD was retired from rendering in Sept 2026.
 */
import * as chromium from "./chromium";

export type { RenderOptions, RenderedImage } from "./chromium";

export const renderModel = chromium.renderModel;

/** Can this machine render? (Chrome + local part library; false on Vercel.) */
export const renderAvailable = chromium.renderAvailable;

/** Scripts call this before they finish, so the headless browser doesn't keep the process alive. */
export const closeRenderer = chromium.closeRenderer;
