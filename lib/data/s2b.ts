/**
 * StableText2Brick helpers shared by the pipeline (04-fetch-s2b) and the app.
 *
 * Structures are stored in NSHARDS shard files; a structure's shard is
 * derived from its id by FNV-1a hash, so the app can locate any structure
 * with zero index lookups.
 */

export const S2B_SHARDS = 474;

/** Listing shards: public/data/s2b/catalog-{000..009}.json (captions only). */
export const S2B_CATALOG_SHARDS = 10;

/** FNV-1a 32-bit hash. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const s2bShardOf = (id: string) => fnv1a(id) % S2B_SHARDS;
export const s2bShardPath = (id: string) =>
  `/models/s2b/shard-${String(s2bShardOf(id)).padStart(3, "0")}.json`;

/** ShapeNet synset id → human category name (the LegoGPT category set). */
export const SHAPENET_CATEGORIES: Record<string, string> = {
  "02691156": "airplane",
  "02747177": "trash bin",
  "02773838": "bag",
  "02801938": "basket",
  "02808440": "bathtub",
  "02818832": "bed",
  "02828884": "bench",
  "02843684": "birdhouse",
  "02871439": "bookshelf",
  "02876657": "bottle",
  "02880940": "bowl",
  "02924116": "bus",
  "02933112": "cabinet",
  "02942699": "camera",
  "02946921": "can",
  "02954340": "cap",
  "02958343": "car",
  "03001627": "chair",
  "03046257": "clock",
  "03085013": "keyboard",
  "03207941": "dishwasher",
  "03211117": "display",
  "03261776": "earphone",
  "03325088": "faucet",
  "03337140": "file cabinet",
  "03467517": "guitar",
  "03513137": "helmet",
  "03593526": "jar",
  "03624134": "knife",
  "03636649": "lamp",
  "03642806": "laptop",
  "03691459": "loudspeaker",
  "03710193": "mailbox",
  "03759954": "microphone",
  "03761084": "microwave",
  "03790512": "motorcycle",
  "03797390": "mug",
  "03928116": "piano",
  "03938244": "pillow",
  "03948459": "pistol",
  "03991062": "pot",
  "04004475": "printer",
  "04074963": "remote",
  "04090263": "rifle",
  "04099429": "rocket",
  "04225987": "skateboard",
  "04256520": "sofa",
  "04330267": "stove",
  "04379243": "table",
  "04401088": "telephone",
  "04460130": "tower",
  "04468005": "train",
  "04530566": "watercraft",
  "04554684": "washer",
};

export const s2bCategoryName = (id: string) => SHAPENET_CATEGORIES[id] ?? id;

/**
 * Deterministic display color per structure (the dataset is colorless):
 * a small pleasant LDraw-code palette selected by id hash.
 */
const DISPLAY_COLORS = [4, 14, 1, 2, 25, 71, 15, 27, 322, 19];
export const s2bDisplayColor = (id: string) =>
  DISPLAY_COLORS[fnv1a(id + "c") % DISPLAY_COLORS.length];
