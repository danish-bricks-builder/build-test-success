#!/usr/bin/env sh
# The part data the grader reads, from Danish Bricks Builder's public data bucket:
#   data/parts/meta.json         part sizes (footprint, height)                 1.3 MB
#   data/parts/index.json        part numbers and names                          6.5 MB
#   data/parts/connections.json  the connector library (studs, tubes, pins, …)  20 MB
#   data/inv/31009-1.json        the inventory of the set behind the dinosaur task
# Voxel shapes are fetched one file per part by grade.ts as it meets them, into data/parts/voxels/. See DATA-LICENSES.md for where this data comes from.
set -e
cd "$(dirname "$0")"
ORIGIN="${DATA_ORIGIN:-https://pub-09680f02457547f9bd4034ba506c47d7.r2.dev}"
mkdir -p data/parts/voxels data/inv
for f in parts/meta.json parts/index.json parts/connections.json inv/31009-1.json; do
  if [ -f "data/$f" ]; then echo "have  data/$f"; continue; fi
  echo "fetch data/$f"
  curl -fsSL "$ORIGIN/data/$f" -o "data/$f.part" && mv "data/$f.part" "data/$f"
done
echo "done"
