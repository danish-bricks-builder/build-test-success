/**
 * Flatten an LDraw file (an .mpd with submodels included) into one list of part lines in
 * world coordinates — the form a one-shot prompt hands the model for an editing task.
 *
 *   npx tsx grader/flatten.ts public/models/omr/40013-1/40013-1.mpd > runs/_seeds/40013-1.ldr
 */
import { readFileSync } from "node:fs";
import { fromLdr, toLdr } from "../lib/ldraw/serialize";

const meta = JSON.parse(readFileSync("public/data/parts/meta.json", "utf8"));
const { parts } = fromLdr(readFileSync(process.argv[2], "utf8"), meta);
process.stdout.write(toLdr({ format: "danish-bricks/v1", name: process.argv[2].split("/").pop() ?? "set", baseplate: 0, parts }, meta));
