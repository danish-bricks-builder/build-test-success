#!/usr/bin/env sh
# The part data the grader and the environment read, from Danish Bricks Builder's public data
# bucket, laid out under public/ exactly as the environment code expects:
#   public/data/parts/meta.json         part sizes                                   1.3 MB
#   public/data/parts/index.json        part numbers and names                       6.5 MB
#   public/data/parts/palette.json      the builder's part palette (the catalog the agent searches)
#   public/data/parts/connections.json  the connector library                        20 MB
#   public/data/inv/31009-1.json        inventory of the set behind the dinosaur task
#   public/data/omr-index.json + public/models/omr/40013-1/  the official set the edit task starts from
# Voxel shapes are fetched one file per part as they are met (public/data/parts/voxels/).
#   sh scripts/fetch-data.sh --eyes   also fetches what the agent's render_view needs: LDConfig.ldr and the
#                             packed part files (~12 MB), so the environment can render with Chrome.
# See DATA-LICENSES.md for where this data comes from.
set -e
cd "$(dirname "$0")"
ORIGIN="${DATA_ORIGIN:-https://pub-09680f02457547f9bd4034ba506c47d7.r2.dev}"
UA="build-test-success/1.0"
get() { # get <bucket path> <local path>
  if [ -f "$2" ]; then echo "have  $2"; return; fi
  echo "fetch $2"; mkdir -p "$(dirname "$2")"
  curl -fsSL -A "$UA" "$ORIGIN/$1" -o "$2.part" && mv "$2.part" "$2"
}
for f in parts/meta.json parts/index.json parts/palette.json parts/connections.json inv/31009-1.json omr-index.json; do
  get "data/$f" "public/data/$f"
done
mkdir -p public/data/parts/voxels
# voxel shapes for every part in the builder's palette: the environment's collision and stability
# checks silently degrade for a part without one, so fetch them up front (one small file per part)
for p in $(python3 -c "import json;print(' '.join(r['p'] for r in json.load(open('public/data/parts/palette.json'))))"); do
  [ -f "public/data/parts/voxels/$p.json" ] || { curl -fsSL -A "$UA" "$ORIGIN/data/parts/voxels/$p.json" -o "public/data/parts/voxels/$p.json.part" 2>/dev/null && mv "public/data/parts/voxels/$p.json.part" "public/data/parts/voxels/$p.json" || rm -f "public/data/parts/voxels/$p.json.part"; }
done
echo "voxels: $(ls public/data/parts/voxels | wc -l | tr -d ' ') parts"
# the edit task's set: its main file name comes from the index
SET=40013-1
FILE=$(python3 -c "import json;print(json.load(open('public/data/omr-index.json')).get('$SET','$SET.mpd'))")
get "models/omr/$SET/$FILE" "public/models/omr/$SET/$FILE"
if [ "$1" = "--eyes" ]; then
  get "ldraw/LDConfig.ldr" "public/ldraw/LDConfig.ldr"
  get "ldraw-packed/manifest.json" "public/ldraw-packed/manifest.json"
  for p in $(python3 -c "import json;print(' '.join(json.load(open('public/ldraw-packed/manifest.json'))))"); do
    get "ldraw-packed/$p.dat" "public/ldraw-packed/$p.dat"
  done
fi
echo "done"
