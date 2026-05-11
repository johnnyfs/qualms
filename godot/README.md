# Godot Prototype

3D Ev-Nova-style prototype for the rebuilt game. Two modes share a single 3D scene. Orbital scale and body scale are decoupled:

- Orbits: `WORLD_UNITS_PER_AU = 640` (1 AU = 640 u → Pluto orbit ~25 000 u, full system ~50 000 u across).
- Body radii (flight): `radius_km × BODY_WORLD_UNITS_PER_KM × FACTOR`, where `FACTOR` is `STAR_VISIBILITY_FACTOR` (60) for stars and `BODY_VISIBILITY_FACTOR` (2400) otherwise. The Sun stays inside Mercury's perihelion.
- Body radii (map): each body's flight-mode size × `MAP_BODY_SCALE`, then clamped to `[MAP_MIN_BODY_RADIUS, MAP_MAX_BODY_RADIUS]` so Jupiter caps at Sun-sized and small bodies stay visible at the system zoom.

Modes:
- **Flight**: top-down ortho tracking the ship; arrow-key inertial controls; mouse wheel / `+`/`-` zoom. Default ortho 50.
- **Map**: camera pulled back to ortho 56 000 (Pluto orbit + margin), range 6 400 – 70 000. The ship model swaps for a directional icon. Bodies rescale via the map-mode formula.

Controls:
- Arrow keys: fly (flight mode only)
- `M`: toggle flight ↔ map
- Mouse wheel / `+` / `-`: zoom (range depends on mode)
- `{` / `}`: shrink / grow all body sizes live (1.2× per press) — for scale tuning

Run:

```sh
godot --path godot                  # starts in flight mode
godot --path godot -- --mode map    # starts in map mode
```

Scaling notes: in flight mode, planets/moons/stations share one visibility multiplier (`BODY_VISIBILITY_FACTOR = 2400` × runtime multiplier) and the Sun uses the smaller `STAR_VISIBILITY_FACTOR = 60`. In map mode, body sizes are clamped via `MAP_BODY_SCALE`/`MIN`/`MAX` — Jupiter and Saturn render at Sun-sized, all small bodies hit the visibility floor. Use `{` and `}` to dial flight-mode body sizes live. Default spawn is near Earth (orbit ~640 u from Sun).

Stations and small moons are sub-pixel at this factor; we'll add labels/markers later. If you need the cache rebuilt in a fresh worktree, run `godot --headless --path godot --import` once before first launch.

Story engine integration, NPC ships, stations beyond Belt Exchange, and combat are deliberately out of this pass.
