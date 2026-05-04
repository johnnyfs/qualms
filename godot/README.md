# Godot Prototype

This is now a 3D flight prototype for the rebuilt game. The default `flight` mode uses a ship-tracking overhead orthographic camera, a dark reference playfield, and the Canary ship model driven by arrow-key inertial controls.

The `map` mode is a live overhead system view. It hides the full-scale bodies and ship model, mirrors the current orbital positions as reduced solid-color icons, and shows the ship as a small directional marker.

Controls: arrow keys fly in flight mode, the mouse wheel or +/- adjusts flight zoom, `M` switches to map mode, and `F` returns to flight mode.

Run the current flight test:

```sh
godot --path godot -- --mode flight
```

Start directly in map mode:

```sh
godot --path godot -- --mode map
```

The first imported ship asset lives at `assets/ships/canary/canary.glb`. Story engine integration, orbitals, stations, and world content are deliberately out of this pass.
