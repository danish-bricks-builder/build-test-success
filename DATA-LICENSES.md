# Data licenses

The code in this repository is MIT. The part data it reads (fetched by `fetch-data.sh`, not
stored here) is derived from other people's work and keeps their licenses:

| data | derived from | license |
|---|---|---|
| `public/data/parts/meta.json`, `public/data/parts/voxels/*`, `public/ldraw-packed/*` | part geometry from the [LDraw Parts Library](https://www.ldraw.org) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| `public/data/parts/index.json`, `public/data/parts/palette.json`, `public/data/inv/*.json`, `public/models/omr/*` | the [Rebrickable](https://rebrickable.com/downloads/) catalog and set inventories | CC BY |
| `public/data/parts/connections.json` | connector annotations from the [LDCad Shadow Library](http://www.melkert.net/LDCad/tech/shadowLib) by Roland Melkert | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) — this derivative is shared under the same license |

The official set under `public/models/omr/` is an LDraw OMR file (CC BY, per-file author credit inside). The models in `results/runs/*.ldr` were produced by the experiments described in the paper and are
released with the code.

LEGO® is a trademark of the LEGO Group of companies, which does not sponsor, authorize or
endorse this work.
