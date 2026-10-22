# Data licenses

The code in this repository is MIT. The part data it reads (fetched by `fetch-data.sh`, not
stored here) is derived from other people's work and keeps their licenses:

| data | derived from | license |
|---|---|---|
| `data/parts/meta.json`, `data/parts/voxels.json`, `data/parts/voxels/*` | part geometry from the [LDraw Parts Library](https://www.ldraw.org) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| `data/parts/index.json`, `data/inv/*.json` | the [Rebrickable](https://rebrickable.com/downloads/) catalog and set inventories | CC BY |
| `data/parts/connections.json` | connector annotations from the [LDCad Shadow Library](http://www.melkert.net/LDCad/tech/shadowLib) by Roland Melkert | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) — this derivative is shared under the same license |

The models in `records/*.ldr` were produced by the experiments described in the paper and are
released with the code.

LEGO® is a trademark of the LEGO Group of companies, which does not sponsor, authorize or
endorse this work.
