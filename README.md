# Steward of a Hold

A tiny **idle town-builder** set in the world of [`xan-world-sim`](../xan-world-sim).
You pick one of the seats the world-sim generated, and idle it from a lonely
hall into a thriving hold — its geography *is* its economy.

No backend, no build step, no dependencies. **Open `index.html`** (double-click,
or serve the folder) and play. Saves live in `localStorage`, one per hold.

## The idea

The sim is used as a **data quarry**, not a live service: a single run is dumped
to `data/world.js` (`window.WORLD`), and this game only ever *reads* it — it
never writes back. From the snapshot's per-cell grids (elevation, rock, salt,
river, road) and seat/realm/feature lists, each seat is derived into a playable
hold:

| The sim says… | …the hold gets |
|---|---|
| fertile ground, river, lake | **food** (Farmstead, Fishing Wharf) |
| forest | **timber** (Sawmill) |
| mountain, foothill, cliff | **stone** (Quarry) |
| mountain, volcano | **ore** (Deep Mine) |
| salt field / a Saltern seat | **salt** (Saltern) |
| roads, passes, a Capital | **coin** (Market) |
| dragon dens / nests / rookeries nearby, war pressure | **danger** (raids) |
| ancestry (Northern / Coastal / cradle) & tier (march / saltern / capital / …) | starting lean & bonuses |

Population staffs the works (efficiency = folk ÷ jobs), food feeds them, a Market
lets a stone-poor forest hall sell timber and buy the stone it lacks, and a
Palisade blunts the raids that fall on frontier holds. Close the tab and the
hold keeps working — offline progress is folded in when you return.

## Layout

```
index.html          screens + DOM shell
style.css           styling
data/world.js        window.WORLD — one dumped run of xan-world-sim (seed 42)
js/world.js          read-only adapter: snapshot → holds (economy, danger, lore)
js/map.js            paints the continent + the seat picker
js/game.js           the idle engine (production, pop, trade, raids, offline, save)
js/app.js            screens + render/tick loop
```

## Regenerating the world

The data is one run of the sim, dumped via its WASM node bridge:

```bash
cd ../xan-world-sim
./web/build.sh                              # builds web/xan.wasm (once)
printf 'window.WORLD =\n' > ../xan-hold/data/world.js
node web/parity.cjs 42 0 >> ../xan-hold/data/world.js   # seed 42, kya 0 (now)
printf ';\n' >> ../xan-hold/data/world.js
```

Change the seed for a different continent (and a different set of holds).
