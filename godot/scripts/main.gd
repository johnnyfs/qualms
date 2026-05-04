extends Node3D

const MODE_FLIGHT := "flight"
const MODE_MAP := "map"
const SHIP_MODEL_PATH := "res://assets/ships/canary/canary.glb"
const SYSTEM_DATA_PATH := "res://data/sol_like_system.json"
const SHIP_ALTITUDE := 0.75
const SHIP_DISPLAY_SIZE := 3.2
const FLIGHT_CAMERA_HEIGHT := 42.0
const FLIGHT_CAMERA_ORTHOGRAPHIC_SIZE := 30.0
const MIN_FLIGHT_CAMERA_ORTHOGRAPHIC_SIZE := 7.0
const MAX_FLIGHT_CAMERA_ORTHOGRAPHIC_SIZE := 104.0
const MAP_CAMERA_HEIGHT := 210.0
const MAP_CAMERA_MARGIN := 14.0
const MAP_MIN_CAMERA_ORTHOGRAPHIC_SIZE := 28.0
const MAP_ICON_ALTITUDE := 1.2
const MAP_SHIP_ICON_ALTITUDE := 1.75
const ZOOM_UNITS_PER_SECOND := 42.0
const TURN_RADIANS_PER_SECOND := 2.7
const THRUST_UNITS_PER_SECOND_SQUARED := 18.0
const MAX_SPEED_UNITS_PER_SECOND := 34.0
const MODEL_YAW_OFFSET := PI * 0.5
const THRUST_BLUE := Color(0.24, 0.76, 1.0, 0.62)
const MAIN_ENGINE_Z := -1.7
const RCS_SIDE_X := 0.58
const RCS_NOSE_Z := 1.42
const RCS_REAR_Z := -1.42
const AU_TO_WORLD_UNITS := 1.6
const MOON_AU_TO_WORLD_UNITS := 350.0
const MIN_LOCAL_ORBIT_RADIUS := 0.85
const ORBIT_SEGMENTS := 160
const ORBIT_RATE_AT_1_AU := TAU / 120.0
const MIN_ORBIT_RATE_AXIS_AU := 0.2
const PLAYFIELD_SIZE := 140.0
const GRID_STEP := 5.0
const STAR_COUNT := 190

@export_enum("flight", "map") var startup_mode := "flight"

@onready var ship_root: Node3D = $ShipRoot
@onready var camera: Camera3D = $Camera3D
@onready var hud_label: Label = $HUD/DebugLabel

var active_mode := MODE_FLIGHT
var ship_heading := 0.0
var ship_velocity := Vector3.ZERO
var ship_model: Node3D
var camera_size := FLIGHT_CAMERA_ORTHOGRAPHIC_SIZE
var system_name := "Unloaded System"
var bodies: Array[Dictionary] = []
var system_root: Node3D
var map_root: Node3D
var map_body_icons: Dictionary = {}
var map_ship_icon: Node3D
var main_thrust: GPUParticles3D
var main_thrust_light: OmniLight3D
var rcs_jets: Dictionary = {}


func _ready() -> void:
	_ready_flight_scene()
	_set_active_mode(_resolve_start_mode())


func _ready_flight_scene() -> void:
	ship_root.visible = true
	_configure_world()
	_configure_camera()
	_configure_hud()
	_build_playfield()
	_build_reference_grid()
	_build_starfield()
	_load_system(SYSTEM_DATA_PATH)
	_build_main_thrust()
	_build_rcs_jets()
	_load_ship_model()
	_place_ship_near_body("earth")
	_build_map_icons()
	_update_ship_transform()
	_update_camera()
	_update_hud()


func _process(delta: float) -> void:
	_update_orbits(delta)
	if active_mode == MODE_FLIGHT:
		_update_zoom(delta)
		_update_ship(delta)
	else:
		_coast_ship(delta)
	_update_map_icons()
	_update_camera()
	_update_hud()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey:
		var key_event := event as InputEventKey
		if key_event.pressed and not key_event.echo:
			if key_event.keycode == KEY_M:
				_set_active_mode(MODE_MAP)
				get_viewport().set_input_as_handled()
				return
			if key_event.keycode == KEY_F:
				_set_active_mode(MODE_FLIGHT)
				get_viewport().set_input_as_handled()
				return

	if active_mode == MODE_FLIGHT and event is InputEventMouseButton and event.pressed:
		var mouse_event := event as InputEventMouseButton
		if mouse_event.button_index == MOUSE_BUTTON_WHEEL_UP:
			_apply_zoom_step(-4.0)
			get_viewport().set_input_as_handled()
		elif mouse_event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_apply_zoom_step(4.0)
			get_viewport().set_input_as_handled()


func _resolve_start_mode() -> String:
	var resolved_mode := String(startup_mode).strip_edges().to_lower()
	var env_mode := OS.get_environment("QUALMS_START_MODE").strip_edges().to_lower()
	if not env_mode.is_empty():
		resolved_mode = env_mode

	var args := OS.get_cmdline_user_args()
	for i in range(args.size()):
		var arg := String(args[i]).strip_edges().to_lower()
		if arg == "--flight" or arg == "--ship" or arg == "--space":
			resolved_mode = MODE_FLIGHT
		elif arg == "--map":
			resolved_mode = MODE_MAP
		elif arg.begins_with("--mode="):
			resolved_mode = arg.substr(7).strip_edges()
		elif arg == "--mode" and i + 1 < args.size():
			resolved_mode = String(args[i + 1]).strip_edges().to_lower()

	if resolved_mode == MODE_MAP:
		return MODE_MAP
	return MODE_FLIGHT


func _update_ship(delta: float) -> void:
	var turning_left := Input.is_key_pressed(KEY_LEFT)
	var turning_right := Input.is_key_pressed(KEY_RIGHT)
	if turning_left:
		ship_heading += TURN_RADIANS_PER_SECOND * delta
	if turning_right:
		ship_heading -= TURN_RADIANS_PER_SECOND * delta

	var forward := _heading_forward()
	var forward_thrust := Input.is_key_pressed(KEY_UP)
	if forward_thrust:
		ship_velocity += forward * THRUST_UNITS_PER_SECOND_SQUARED * delta

	if ship_velocity.length() > MAX_SPEED_UNITS_PER_SECOND:
		ship_velocity = ship_velocity.normalized() * MAX_SPEED_UNITS_PER_SECOND

	var next_position := ship_root.position + ship_velocity * delta
	next_position.y = SHIP_ALTITUDE
	ship_root.position = next_position
	_update_ship_transform()
	_update_main_thrust(forward_thrust)
	_update_rcs_jets(turning_left, turning_right)


func _coast_ship(delta: float) -> void:
	var next_position := ship_root.position + ship_velocity * delta
	next_position.y = SHIP_ALTITUDE
	ship_root.position = next_position
	_update_ship_transform()
	_update_main_thrust(false)
	_update_rcs_jets(false, false)


func _update_ship_transform() -> void:
	ship_root.rotation.y = ship_heading
	ship_root.position.y = SHIP_ALTITUDE


func _heading_forward() -> Vector3:
	return Vector3(sin(ship_heading), 0.0, cos(ship_heading)).normalized()


func _update_zoom(delta: float) -> void:
	var zoom_delta := 0.0
	if Input.is_key_pressed(KEY_EQUAL) or Input.is_key_pressed(KEY_PLUS) or Input.is_key_pressed(KEY_KP_ADD):
		zoom_delta -= ZOOM_UNITS_PER_SECOND * delta
	if Input.is_key_pressed(KEY_MINUS) or Input.is_key_pressed(KEY_KP_SUBTRACT):
		zoom_delta += ZOOM_UNITS_PER_SECOND * delta

	if zoom_delta != 0.0:
		_apply_zoom_step(zoom_delta)


func _apply_zoom_step(zoom_delta: float) -> void:
	camera_size = clampf(
		camera_size + zoom_delta,
		MIN_FLIGHT_CAMERA_ORTHOGRAPHIC_SIZE,
		MAX_FLIGHT_CAMERA_ORTHOGRAPHIC_SIZE
	)
	if active_mode == MODE_FLIGHT:
		camera.size = camera_size


func _set_active_mode(mode: String) -> void:
	active_mode = MODE_MAP if mode == MODE_MAP else MODE_FLIGHT
	if system_root != null:
		system_root.visible = active_mode == MODE_FLIGHT
	if map_root != null:
		map_root.visible = active_mode == MODE_MAP
	ship_root.visible = active_mode == MODE_FLIGHT
	if active_mode == MODE_MAP:
		_update_main_thrust(false)
		_update_rcs_jets(false, false)
	_update_map_icons()
	_update_camera()


func _update_camera() -> void:
	if active_mode == MODE_MAP:
		_update_map_camera()
	else:
		_update_flight_camera()


func _update_flight_camera() -> void:
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = camera_size
	camera.near = 0.05
	camera.far = 800.0
	camera.current = true
	camera.global_position = ship_root.global_position + Vector3(0.0, FLIGHT_CAMERA_HEIGHT, 0.0)
	camera.rotation = Vector3(-PI * 0.5, 0.0, 0.0)


func _update_map_camera() -> void:
	var bounds := _map_bounds()
	var center := bounds.position + bounds.size * 0.5
	var viewport_size := get_viewport().get_visible_rect().size
	var aspect := 1.0
	if viewport_size.y > 0.0:
		aspect = maxf(viewport_size.x / viewport_size.y, 0.01)

	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = maxf(
		MAP_MIN_CAMERA_ORTHOGRAPHIC_SIZE,
		maxf(bounds.size.y, bounds.size.x / aspect) + MAP_CAMERA_MARGIN
	)
	camera.near = 0.05
	camera.far = 900.0
	camera.current = true
	camera.global_position = Vector3(center.x, MAP_CAMERA_HEIGHT, center.y)
	camera.rotation = Vector3(-PI * 0.5, 0.0, 0.0)


func _map_bounds() -> Rect2:
	var has_position := false
	var min_position := Vector2.ZERO
	var max_position := Vector2.ZERO

	for body in bodies:
		var body_node := body.get("node") as Node3D
		if body_node != null:
			var body_position := Vector2(body_node.global_position.x, body_node.global_position.z)
			if has_position:
				min_position.x = minf(min_position.x, body_position.x)
				min_position.y = minf(min_position.y, body_position.y)
				max_position.x = maxf(max_position.x, body_position.x)
				max_position.y = maxf(max_position.y, body_position.y)
			else:
				min_position = body_position
				max_position = body_position
				has_position = true

	var ship_position := Vector2(ship_root.global_position.x, ship_root.global_position.z)
	if has_position:
		min_position.x = minf(min_position.x, ship_position.x)
		min_position.y = minf(min_position.y, ship_position.y)
		max_position.x = maxf(max_position.x, ship_position.x)
		max_position.y = maxf(max_position.y, ship_position.y)
	else:
		min_position = ship_position
		max_position = ship_position

	return Rect2(min_position, max_position - min_position)


func _configure_world() -> void:
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color(0.004, 0.006, 0.011)
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color(0.55, 0.67, 0.78)
	environment.ambient_light_energy = 0.26

	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	world_environment.environment = environment
	add_child(world_environment)

	var key_light := DirectionalLight3D.new()
	key_light.name = "KeyLight"
	key_light.rotation_degrees = Vector3(-62.0, -28.0, 0.0)
	key_light.light_energy = 1.7
	add_child(key_light)


func _configure_camera() -> void:
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera_size = FLIGHT_CAMERA_ORTHOGRAPHIC_SIZE
	camera.size = camera_size
	camera.near = 0.05
	camera.far = 800.0
	camera.current = true
	camera.position = Vector3(0.0, FLIGHT_CAMERA_HEIGHT, 0.0)
	camera.rotation = Vector3(-PI * 0.5, 0.0, 0.0)


func _configure_hud() -> void:
	hud_label.position = Vector2(18.0, 18.0)
	hud_label.size = Vector2(420.0, 88.0)
	hud_label.add_theme_color_override("font_color", Color(0.78, 0.87, 0.93, 0.9))
	hud_label.add_theme_font_size_override("font_size", 15)


func _build_playfield() -> void:
	var plane := MeshInstance3D.new()
	plane.name = "Playfield"

	var mesh := PlaneMesh.new()
	mesh.size = Vector2(PLAYFIELD_SIZE, PLAYFIELD_SIZE)
	plane.mesh = mesh
	plane.position.y = -0.08

	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = Color(0.007, 0.012, 0.018)
	plane.material_override = material
	add_child(plane)


func _build_reference_grid() -> void:
	var grid := MeshInstance3D.new()
	grid.name = "ReferenceGrid"

	var mesh := ImmediateMesh.new()
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.albedo_color = Color(0.17, 0.28, 0.35, 0.42)

	var half_size := PLAYFIELD_SIZE * 0.5
	mesh.surface_begin(Mesh.PRIMITIVE_LINES)
	var line_count := int(PLAYFIELD_SIZE / GRID_STEP)
	for i in range(line_count + 1):
		var offset := -half_size + GRID_STEP * float(i)
		mesh.surface_add_vertex(Vector3(offset, -0.04, -half_size))
		mesh.surface_add_vertex(Vector3(offset, -0.04, half_size))
		mesh.surface_add_vertex(Vector3(-half_size, -0.04, offset))
		mesh.surface_add_vertex(Vector3(half_size, -0.04, offset))
	mesh.surface_end()

	grid.mesh = mesh
	grid.material_override = material
	add_child(grid)


func _build_starfield() -> void:
	var star_mesh := SphereMesh.new()
	star_mesh.radius = 0.045
	star_mesh.height = 0.09
	star_mesh.radial_segments = 8
	star_mesh.rings = 4

	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = Color(0.66, 0.78, 0.88, 0.82)

	var multimesh := MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.mesh = star_mesh
	multimesh.instance_count = STAR_COUNT

	var rng := RandomNumberGenerator.new()
	rng.seed = 53021940
	var half_size := PLAYFIELD_SIZE * 0.5
	for i in range(STAR_COUNT):
		var x := rng.randf_range(-half_size, half_size)
		var z := rng.randf_range(-half_size, half_size)
		var scale := rng.randf_range(0.45, 1.45)
		var basis := Basis.IDENTITY.scaled(Vector3.ONE * scale)
		multimesh.set_instance_transform(i, Transform3D(basis, Vector3(x, 0.01, z)))

	var starfield := MultiMeshInstance3D.new()
	starfield.name = "Starfield"
	starfield.multimesh = multimesh
	starfield.material_override = material
	add_child(starfield)


func _build_map_icons() -> void:
	map_root = Node3D.new()
	map_root.name = "MapRoot"
	map_root.visible = false
	add_child(map_root)

	map_body_icons.clear()
	for body in bodies:
		var icon := _create_map_body_icon(body)
		map_root.add_child(icon)
		map_body_icons[String(body.get("id", ""))] = icon

	map_ship_icon = _create_map_ship_icon()
	map_root.add_child(map_ship_icon)
	_update_map_icons()


func _create_map_body_icon(body: Dictionary) -> Node3D:
	var icon_root := Node3D.new()
	icon_root.name = "%s MapIcon" % String(body.get("name", "Body"))

	var mesh_instance := MeshInstance3D.new()
	mesh_instance.name = "IconMesh"
	var body_type := String(body.get("type", "planet"))
	if body_type == "station":
		var box_mesh := BoxMesh.new()
		box_mesh.size = Vector3.ONE * (_map_body_icon_radius(body) * 1.65)
		mesh_instance.mesh = box_mesh
	else:
		var sphere_mesh := SphereMesh.new()
		var radius := _map_body_icon_radius(body)
		sphere_mesh.radius = radius
		sphere_mesh.height = radius * 2.0
		sphere_mesh.radial_segments = 16
		sphere_mesh.rings = 8
		mesh_instance.mesh = sphere_mesh
		mesh_instance.position.y = radius

	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = Color(String(body.get("color", "#ffffff")))
	material.emission_enabled = body_type == "star"
	if material.emission_enabled:
		material.emission = material.albedo_color
		material.emission_energy_multiplier = 0.65
	mesh_instance.material_override = material

	icon_root.add_child(mesh_instance)
	return icon_root


func _map_body_icon_radius(body: Dictionary) -> float:
	var body_type := String(body.get("type", "planet"))
	if body_type == "star":
		return 0.72
	if body_type == "moon":
		return 0.22
	if body_type == "station":
		return 0.30
	return 0.38


func _create_map_ship_icon() -> Node3D:
	var icon_root := Node3D.new()
	icon_root.name = "ShipMapIcon"

	var mesh_instance := MeshInstance3D.new()
	mesh_instance.name = "IconMesh"

	var mesh := ImmediateMesh.new()
	mesh.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
	mesh.surface_add_vertex(Vector3(0.0, 0.0, 0.82))
	mesh.surface_add_vertex(Vector3(-0.46, 0.0, -0.48))
	mesh.surface_add_vertex(Vector3(0.46, 0.0, -0.48))
	mesh.surface_end()
	mesh_instance.mesh = mesh

	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	material.albedo_color = Color(1.0, 0.84, 0.28)
	material.emission_enabled = true
	material.emission = Color(1.0, 0.62, 0.18)
	material.emission_energy_multiplier = 0.35
	mesh_instance.material_override = material

	icon_root.add_child(mesh_instance)
	return icon_root


func _update_map_icons() -> void:
	if map_root == null:
		return

	for body in bodies:
		var icon := map_body_icons.get(String(body.get("id", ""))) as Node3D
		var body_node := body.get("node") as Node3D
		if icon != null and body_node != null:
			icon.global_position = Vector3(
				body_node.global_position.x,
				MAP_ICON_ALTITUDE,
				body_node.global_position.z
			)

	if map_ship_icon != null:
		map_ship_icon.global_position = Vector3(
			ship_root.global_position.x,
			MAP_SHIP_ICON_ALTITUDE,
			ship_root.global_position.z
		)
		map_ship_icon.rotation.y = ship_heading


func _load_system(path: String) -> void:
	system_root = Node3D.new()
	system_root.name = "SystemRoot"
	add_child(system_root)

	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		push_error("Could not read system data: %s" % path)
		return

	var parsed = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("System data is not a JSON object: %s" % path)
		return

	system_name = String(parsed.get("name", "Unnamed System"))
	bodies.clear()
	var root = parsed.get("root", {})
	if typeof(root) == TYPE_DICTIONARY:
		_build_body(root, -1)
		_update_orbits(0.0)


func _build_body(body_data: Dictionary, parent_index: int) -> void:
	var entry := body_data.duplicate(true)
	entry["parent_index"] = parent_index
	entry["index"] = bodies.size()
	entry["orbit_angle"] = deg_to_rad(float(entry.get("phase_degrees", 0.0)))
	entry["display_radius_units"] = _body_radius_units(entry)
	entry["orbit_radius_units"] = _orbit_radius_units(entry, parent_index)
	entry["angular_velocity_rad_per_second"] = _angular_velocity_rad_per_second(entry)
	entry.erase("children")

	var parent_node := system_root
	if parent_index >= 0:
		parent_node = bodies[parent_index]["node"] as Node3D

	var body_node := _create_body_node(entry)
	parent_node.add_child(body_node)
	entry["node"] = body_node
	bodies.append(entry)

	if parent_index >= 0:
		_create_orbit_ring(entry, parent_node)

	var body_index := int(entry["index"])
	for child in body_data.get("children", []):
		if typeof(child) == TYPE_DICTIONARY:
			_build_body(child, body_index)


func _create_body_node(body: Dictionary) -> Node3D:
	var body_node := Node3D.new()
	body_node.name = String(body.get("name", "Body"))

	var body_type := String(body.get("type", "planet"))
	var radius := float(body.get("display_radius_units", 0.4))
	var mesh_instance := MeshInstance3D.new()
	mesh_instance.name = "Sphere"

	var mesh := SphereMesh.new()
	mesh.radius = radius
	mesh.height = radius * 2.0
	mesh.radial_segments = 32 if body_type != "moon" else 16
	mesh.rings = 16 if body_type != "moon" else 8
	mesh_instance.mesh = mesh
	mesh_instance.position.y = radius

	var material := StandardMaterial3D.new()
	if body_type == "star":
		var star_color := Color(String(body.get("color", "#ffd166")))
		material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		material.albedo_color = star_color
		material.emission_enabled = true
		material.emission = star_color
		material.emission_energy_multiplier = 1.0
	else:
		material.albedo_color = Color(String(body.get("color", "#ffffff")))
		material.roughness = 0.9
	mesh_instance.material_override = material
	body_node.add_child(mesh_instance)

	if body_type == "star":
		var sun_light := OmniLight3D.new()
		sun_light.name = "SunLight"
		sun_light.position = Vector3(0.0, 7.0, 0.0)
		sun_light.light_color = Color(String(body.get("color", "#ffd166")))
		sun_light.light_energy = 8.0
		sun_light.omni_range = 92.0
		body_node.add_child(sun_light)

	return body_node


func _create_orbit_ring(body: Dictionary, parent_node: Node3D) -> void:
	var ring := MeshInstance3D.new()
	ring.name = "%s Orbit" % String(body.get("name", "Body"))

	var mesh := ImmediateMesh.new()
	mesh.surface_begin(Mesh.PRIMITIVE_LINES)
	for i in range(ORBIT_SEGMENTS):
		var angle_a := TAU * float(i) / float(ORBIT_SEGMENTS)
		var angle_b := TAU * float(i + 1) / float(ORBIT_SEGMENTS)
		mesh.surface_add_vertex(_orbit_point(body, angle_a) + Vector3(0.0, 0.02, 0.0))
		mesh.surface_add_vertex(_orbit_point(body, angle_b) + Vector3(0.0, 0.02, 0.0))
	mesh.surface_end()
	ring.mesh = mesh

	var body_type := String(body.get("type", "planet"))
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	if body_type == "moon":
		material.albedo_color = Color(0.6, 0.68, 0.72, 0.32)
	else:
		material.albedo_color = Color(0.32, 0.48, 0.58, 0.38)
	ring.material_override = material
	parent_node.add_child(ring)


func _update_orbits(delta: float) -> void:
	for i in range(bodies.size()):
		var body := bodies[i]
		var angular_velocity := float(body.get("angular_velocity_rad_per_second", 0.0))
		if angular_velocity != 0.0:
			body["orbit_angle"] = fposmod(float(body.get("orbit_angle", 0.0)) + angular_velocity * delta, TAU)
			bodies[i] = body

		var body_node := body.get("node") as Node3D
		if body_node == null:
			continue
		if int(body.get("parent_index", -1)) < 0:
			body_node.position = Vector3.ZERO
		else:
			body_node.position = _orbit_point(body, float(body.get("orbit_angle", 0.0)))


func _place_ship_near_body(body_id: String) -> void:
	var body := _body_by_id(body_id)
	if body.is_empty():
		return

	var body_node := body.get("node") as Node3D
	if body_node == null:
		return

	ship_root.global_position = body_node.global_position + Vector3(1.25, SHIP_ALTITUDE, 0.85)
	ship_velocity = Vector3.ZERO


func _body_by_id(body_id: String) -> Dictionary:
	for body in bodies:
		if String(body.get("id", "")) == body_id:
			return body
	return {}


func _orbit_point(body: Dictionary, eccentric_anomaly: float) -> Vector3:
	var semi_major_axis := float(body.get("orbit_radius_units", 0.0))
	if semi_major_axis <= 0.0:
		return Vector3.ZERO

	var eccentricity := _eccentricity(body)
	var major_axis := _major_axis_vector(body)
	var minor_axis := Vector3(-major_axis.z, 0.0, major_axis.x)
	var semi_minor_axis := semi_major_axis * sqrt(1.0 - eccentricity * eccentricity)
	var ellipse_center := -major_axis * semi_major_axis * eccentricity
	return ellipse_center + major_axis * semi_major_axis * cos(eccentric_anomaly) + minor_axis * semi_minor_axis * sin(eccentric_anomaly)


func _semi_major_axis_au(body: Dictionary) -> float:
	return float(body.get("semi_major_axis_au", body.get("orbital_distance_au", 0.0)))


func _eccentricity(body: Dictionary) -> float:
	return clampf(float(body.get("eccentricity", 0.0)), 0.0, 0.95)


func _major_axis_vector(body: Dictionary) -> Vector3:
	var angle := deg_to_rad(float(body.get("major_axis_degrees", 0.0)))
	return Vector3(cos(angle), 0.0, sin(angle)).normalized()


func _body_radius_units(body: Dictionary) -> float:
	var body_type := String(body.get("type", "planet"))
	var radius_km := maxf(float(body.get("radius_km", 1.0)), 1.0)

	if body_type == "star":
		return 0.82
	if body_type == "moon":
		return clampf(0.15 + sqrt(radius_km / 1737.0) * 0.08, 0.15, 0.34)
	if body_type == "station":
		return 0.28
	return clampf(0.28 + sqrt(radius_km / 6371.0) * 0.18, 0.32, 1.25)


func _orbit_radius_units(body: Dictionary, parent_index: int) -> float:
	var semi_major_axis_au := _semi_major_axis_au(body)
	if parent_index < 0:
		return 0.0

	var parent_body := bodies[parent_index]
	if String(parent_body.get("type", "")) != "star":
		var parent_radius := float(parent_body.get("display_radius_units", 0.5))
		var body_radius := float(body.get("display_radius_units", 0.2))
		var minimum_radius := parent_radius + body_radius + MIN_LOCAL_ORBIT_RADIUS
		return maxf(semi_major_axis_au * MOON_AU_TO_WORLD_UNITS, minimum_radius)

	return semi_major_axis_au * AU_TO_WORLD_UNITS


func _angular_velocity_rad_per_second(body: Dictionary) -> float:
	if int(body.get("parent_index", -1)) < 0:
		return 0.0
	if body.has("angular_velocity_rad_per_second"):
		return float(body["angular_velocity_rad_per_second"])
	if body.has("orbit_rate"):
		return float(body["orbit_rate"])

	var semi_major_axis := maxf(_semi_major_axis_au(body), MIN_ORBIT_RATE_AXIS_AU)
	var direction := -1.0 if bool(body.get("retrograde", false)) else 1.0
	return direction * ORBIT_RATE_AT_1_AU / pow(semi_major_axis, 1.5)


func _build_main_thrust() -> void:
	var particle_mesh := CapsuleMesh.new()
	particle_mesh.radius = 0.045
	particle_mesh.height = 0.46
	particle_mesh.radial_segments = 8
	particle_mesh.rings = 4

	var particle_material := StandardMaterial3D.new()
	particle_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	particle_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	particle_material.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	particle_material.vertex_color_use_as_albedo = true
	particle_material.albedo_color = THRUST_BLUE
	particle_material.emission_enabled = true
	particle_material.emission = Color(0.34, 0.82, 1.0)
	particle_material.emission_energy_multiplier = 1.25
	particle_mesh.material = particle_material

	var process_material := ParticleProcessMaterial.new()
	process_material.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_POINT
	process_material.direction = Vector3(0.0, 0.0, -1.0)
	process_material.spread = 6.0
	process_material.gravity = Vector3.ZERO
	process_material.initial_velocity_min = 2.6
	process_material.initial_velocity_max = 4.8
	process_material.damping_min = 4.5
	process_material.damping_max = 7.5
	process_material.scale_min = 0.75
	process_material.scale_max = 1.65
	process_material.lifetime_randomness = 0.42
	process_material.color = THRUST_BLUE
	process_material.color_ramp = _particle_fade_ramp(THRUST_BLUE)

	main_thrust = GPUParticles3D.new()
	main_thrust.name = "MainThrust"
	main_thrust.position = Vector3(0.0, 0.0, MAIN_ENGINE_Z)
	main_thrust.amount = 42
	main_thrust.lifetime = 0.44
	main_thrust.randomness = 0.45
	main_thrust.explosiveness = 0.0
	main_thrust.fixed_fps = 60
	main_thrust.local_coords = false
	main_thrust.draw_order = GPUParticles3D.DRAW_ORDER_LIFETIME
	main_thrust.transform_align = GPUParticles3D.TRANSFORM_ALIGN_Y_TO_VELOCITY
	main_thrust.process_material = process_material
	main_thrust.draw_passes = 1
	main_thrust.draw_pass_1 = particle_mesh
	main_thrust.trail_enabled = true
	main_thrust.trail_lifetime = 0.13
	main_thrust.visibility_aabb = AABB(Vector3(-4.0, -1.5, -7.0), Vector3(8.0, 3.0, 10.0))
	main_thrust.emitting = false
	ship_root.add_child(main_thrust)

	main_thrust_light = OmniLight3D.new()
	main_thrust_light.name = "MainThrustLight"
	main_thrust_light.position = Vector3(0.0, 0.0, MAIN_ENGINE_Z)
	main_thrust_light.omni_range = 3.0
	main_thrust_light.light_color = Color(0.3, 0.78, 1.0)
	main_thrust_light.light_energy = 0.0
	ship_root.add_child(main_thrust_light)


func _build_rcs_jets() -> void:
	rcs_jets["nose_left"] = _create_rcs_jet("NoseLeftRcs", Vector3(-RCS_SIDE_X, 0.05, RCS_NOSE_Z), Vector3.LEFT)
	rcs_jets["nose_right"] = _create_rcs_jet("NoseRightRcs", Vector3(RCS_SIDE_X, 0.05, RCS_NOSE_Z), Vector3.RIGHT)
	rcs_jets["rear_left"] = _create_rcs_jet("RearLeftRcs", Vector3(-RCS_SIDE_X, 0.05, RCS_REAR_Z), Vector3.LEFT)
	rcs_jets["rear_right"] = _create_rcs_jet("RearRightRcs", Vector3(RCS_SIDE_X, 0.05, RCS_REAR_Z), Vector3.RIGHT)


func _create_rcs_jet(jet_name: String, local_position: Vector3, direction: Vector3) -> GPUParticles3D:
	var particle_mesh := SphereMesh.new()
	particle_mesh.radius = 0.055
	particle_mesh.height = 0.11
	particle_mesh.radial_segments = 8
	particle_mesh.rings = 4

	var particle_material := StandardMaterial3D.new()
	particle_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	particle_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	particle_material.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	particle_material.vertex_color_use_as_albedo = true
	particle_material.albedo_color = Color(1.0, 1.0, 1.0, 0.55)
	particle_material.emission_enabled = true
	particle_material.emission = Color.WHITE
	particle_material.emission_energy_multiplier = 0.75
	particle_mesh.material = particle_material

	var process_material := ParticleProcessMaterial.new()
	process_material.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_POINT
	process_material.direction = direction.normalized()
	process_material.spread = 7.0
	process_material.gravity = Vector3.ZERO
	process_material.initial_velocity_min = 4.3
	process_material.initial_velocity_max = 6.2
	process_material.damping_min = 15.0
	process_material.damping_max = 20.0
	process_material.scale_min = 0.55
	process_material.scale_max = 1.0
	process_material.lifetime_randomness = 0.35
	process_material.color = Color(1.0, 1.0, 1.0, 0.7)
	process_material.color_ramp = _particle_fade_ramp(Color(1.0, 1.0, 1.0, 0.72))

	var jet := GPUParticles3D.new()
	jet.name = jet_name
	jet.position = local_position
	jet.amount = 10
	jet.lifetime = 0.18
	jet.randomness = 0.35
	jet.explosiveness = 0.0
	jet.fixed_fps = 60
	jet.local_coords = false
	jet.draw_order = GPUParticles3D.DRAW_ORDER_LIFETIME
	jet.process_material = process_material
	jet.draw_passes = 1
	jet.draw_pass_1 = particle_mesh
	jet.visibility_aabb = AABB(Vector3(-3.0, -1.0, -3.0), Vector3(6.0, 2.0, 6.0))
	jet.emitting = false
	ship_root.add_child(jet)
	return jet


func _particle_fade_ramp(start_color: Color) -> GradientTexture1D:
	var gradient := Gradient.new()
	gradient.set_color(0, start_color)
	gradient.set_color(1, Color(start_color.r, start_color.g, start_color.b, 0.0))

	var texture := GradientTexture1D.new()
	texture.gradient = gradient
	return texture


func _load_ship_model() -> void:
	var packed_scene := load(SHIP_MODEL_PATH)
	if packed_scene is PackedScene:
		var model_instance: Node = (packed_scene as PackedScene).instantiate()
		if model_instance is Node3D:
			var visual_root := Node3D.new()
			visual_root.name = "CanaryVisual"
			visual_root.rotation.y = MODEL_YAW_OFFSET
			ship_root.add_child(visual_root)

			ship_model = model_instance as Node3D
			ship_model.name = "Canary"
			visual_root.add_child(ship_model)
			_fit_ship_model(ship_model)
			return

	push_warning("Could not load ship model at %s. Using placeholder mesh." % SHIP_MODEL_PATH)
	_create_placeholder_ship()


func _fit_ship_model(model_root: Node3D) -> void:
	var bounds := AABB()
	var has_bounds := false
	var root_inverse := model_root.global_transform.affine_inverse()

	for child in model_root.find_children("*", "MeshInstance3D", true, false):
		var mesh_instance := child as MeshInstance3D
		var local_bounds := mesh_instance.get_aabb()
		var root_space_bounds := root_inverse * mesh_instance.global_transform * local_bounds
		if has_bounds:
			bounds = bounds.merge(root_space_bounds)
		else:
			bounds = root_space_bounds
			has_bounds = true

	if not has_bounds:
		return

	var max_axis := maxf(bounds.size.x, maxf(bounds.size.y, bounds.size.z))
	if max_axis <= 0.0:
		return

	var center := bounds.position + bounds.size * 0.5
	var scale_factor := SHIP_DISPLAY_SIZE / max_axis
	model_root.position = -center * scale_factor
	model_root.scale = Vector3.ONE * scale_factor


func _create_placeholder_ship() -> void:
	var placeholder := MeshInstance3D.new()
	placeholder.name = "PlaceholderShip"

	var mesh := PrismMesh.new()
	mesh.size = Vector3(1.15, 0.45, 2.7)
	placeholder.mesh = mesh

	var material := StandardMaterial3D.new()
	material.albedo_color = Color(0.95, 0.82, 0.28)
	material.metallic = 0.15
	material.roughness = 0.42
	placeholder.material_override = material
	ship_root.add_child(placeholder)


func _update_main_thrust(forward_thrust: bool) -> void:
	if main_thrust == null or main_thrust_light == null:
		return
	main_thrust.emitting = forward_thrust
	main_thrust.amount_ratio = 1.0 if forward_thrust else 0.0
	main_thrust_light.light_energy = 0.5 if forward_thrust else 0.0


func _update_rcs_jets(turning_left: bool, turning_right: bool) -> void:
	var left_only := turning_left and not turning_right
	var right_only := turning_right and not turning_left

	_set_rcs_emitting("nose_left", right_only)
	_set_rcs_emitting("rear_right", right_only)
	_set_rcs_emitting("nose_right", left_only)
	_set_rcs_emitting("rear_left", left_only)


func _set_rcs_emitting(jet_id: String, emitting: bool) -> void:
	var jet := rcs_jets.get(jet_id) as GPUParticles3D
	if jet == null:
		return
	jet.emitting = emitting


func _update_hud() -> void:
	var speed := ship_velocity.length()
	if active_mode == MODE_MAP:
		hud_label.text = "Dark Qualms map prototype\n%s\nVelocity  %.1f u/s\nShip      %.1f, %.1f\nOrbitals  %d\nZoom      %.0f" % [
			system_name,
			speed,
			ship_root.position.x,
			ship_root.position.z,
			bodies.size(),
			camera.size
		]
		return

	hud_label.text = "Dark Qualms flight prototype\n%s\nVelocity  %.1f u/s\nPosition  %.1f, %.1f\nZoom      %.0f" % [
		system_name,
		speed,
		ship_root.position.x,
		ship_root.position.z,
		camera.size
	]
