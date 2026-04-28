extends Node2D

const AU_KM := 149597870.7
const SYSTEM_RADIUS_AU := 50.0
const MIN_VIEW_RADIUS_AU := 0.035
const ORBIT_SEGMENTS := 192
const SIM_SECONDS_PER_REAL_SECOND := 36000.0
const THRUST_KM_S2 := 0.004
const TURN_RADIANS_PER_SECOND := 2.7
const VIEW_TURN_RADIANS_PER_SECOND := 1.45
const ZOOM_STEPS_PER_SECOND := 0.65
const ORBIT_RATE_AT_1_AU := TAU / 120.0
const MIN_ORBIT_RATE_AXIS_AU := 0.2
const FIRST_TIME_SPEED_KEY := KEY_A
const LAST_TIME_SPEED_KEY := KEY_Z
const TIME_SPEED_KEYS := "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const LANDING_THRESHOLD_AU := 0.025

@export var system_data_path := "res://data/sol_like_system.json"

var system_name := "Unloaded System"
var bodies: Array[Dictionary] = []
var root_body: Dictionary = {}
var ship_position_au := Vector2(1.02, -0.025)
var ship_velocity_km_s := Vector2.ZERO
var ship_heading := -PI * 0.5
var zoom_amount := 0.06
var view_rotation := 0.0
var selected_body_id := ""
var time_speed_index := 0
var landed_body_id := ""
var _font: Font


func _ready() -> void:
	_font = ThemeDB.fallback_font
	_load_system(system_data_path)
	_update_orbit_positions()
	_place_ship_near_body("earth")
	queue_redraw()


func _process(delta: float) -> void:
	_update_orbits(delta)
	if _is_landed():
		_update_landed_ship()
	else:
		_update_ship(delta)
	_update_view(delta)
	queue_redraw()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		var key_event := event as InputEventKey
		if _is_landed():
			if key_event.keycode == KEY_ESCAPE:
				_take_off()
				get_viewport().set_input_as_handled()
			return

		if key_event.keycode == KEY_TAB:
			_select_next_orbital(-1 if key_event.shift_pressed else 1)
			get_viewport().set_input_as_handled()
			return

		if key_event.keycode == KEY_L:
			_try_land()
			get_viewport().set_input_as_handled()
			return

		if key_event.keycode >= FIRST_TIME_SPEED_KEY and key_event.keycode <= LAST_TIME_SPEED_KEY:
			time_speed_index = key_event.keycode - FIRST_TIME_SPEED_KEY
			get_viewport().set_input_as_handled()


func _draw() -> void:
	var viewport_size := get_viewport_rect().size
	draw_rect(Rect2(Vector2.ZERO, viewport_size), Color("#071018"))
	_draw_starfield(viewport_size)
	_draw_orbits()
	_draw_bodies()
	_draw_ship()
	_draw_hud(viewport_size)
	if _is_landed():
		_draw_landing_window(viewport_size)


func _load_system(path: String) -> void:
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		push_error("Could not read system data: %s" % path)
		return

	var parsed = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("System data is not a JSON object: %s" % path)
		return

	system_name = parsed.get("name", "Unnamed System")
	root_body = parsed.get("root", {})
	bodies.clear()
	_flatten_body(root_body, Vector2.ZERO, -1, 0)


func _flatten_body(body: Dictionary, parent_position: Vector2, parent_index: int, depth: int) -> void:
	var phase := deg_to_rad(float(body.get("phase_degrees", 0.0)))
	var position := _orbit_point(parent_position, body, phase)
	var entry := body.duplicate(true)
	entry["position_au"] = position
	entry["orbit_angle"] = phase
	entry["parent_index"] = parent_index
	entry["angular_velocity_rad_per_second"] = _angular_velocity_rad_per_second(entry)
	entry["depth"] = depth
	entry["index"] = bodies.size()
	entry.erase("children")
	bodies.append(entry)

	var child_parent_index: int = entry["index"]
	for child in body.get("children", []):
		if typeof(child) == TYPE_DICTIONARY:
			_flatten_body(child, position, child_parent_index, depth + 1)


func _place_ship_near_body(body_id: String) -> void:
	for body in bodies:
		if String(body.get("id", "")) == body_id:
			var body_position: Vector2 = body.get("position_au", Vector2.ZERO)
			ship_position_au = body_position + Vector2(0.018, -0.012)
			return


func _update_ship(delta: float) -> void:
	if Input.is_key_pressed(KEY_LEFT):
		ship_heading -= TURN_RADIANS_PER_SECOND * delta
	if Input.is_key_pressed(KEY_RIGHT):
		ship_heading += TURN_RADIANS_PER_SECOND * delta

	var heading_vector := Vector2(cos(ship_heading), sin(ship_heading))
	if Input.is_key_pressed(KEY_UP):
		ship_velocity_km_s += heading_vector * THRUST_KM_S2 * SIM_SECONDS_PER_REAL_SECOND * delta
	if Input.is_key_pressed(KEY_DOWN):
		ship_velocity_km_s -= heading_vector * THRUST_KM_S2 * SIM_SECONDS_PER_REAL_SECOND * delta

	ship_position_au += ship_velocity_km_s * SIM_SECONDS_PER_REAL_SECOND * delta / AU_KM


func _update_orbits(delta: float) -> void:
	var multiplier := _time_speed_multiplier()
	for i in range(bodies.size()):
		var body := bodies[i]
		var angular_velocity := float(body.get("angular_velocity_rad_per_second", 0.0))
		if angular_velocity == 0.0:
			continue

		body["orbit_angle"] = fposmod(float(body.get("orbit_angle", 0.0)) + angular_velocity * multiplier * delta, TAU)
		bodies[i] = body

	_update_orbit_positions()


func _update_orbit_positions() -> void:
	for i in range(bodies.size()):
		var body := bodies[i]
		var parent_index := int(body.get("parent_index", -1))
		var parent_position := Vector2.ZERO
		if parent_index >= 0 and parent_index < bodies.size():
			parent_position = bodies[parent_index].get("position_au", Vector2.ZERO)

		body["position_au"] = _orbit_point(parent_position, body, float(body.get("orbit_angle", 0.0)))
		bodies[i] = body


func _update_landed_ship() -> void:
	var landed_body := _body_by_id(landed_body_id)
	if landed_body.is_empty():
		landed_body_id = ""
		return

	ship_position_au = landed_body.get("position_au", ship_position_au)
	ship_velocity_km_s = Vector2.ZERO


func _update_view(delta: float) -> void:
	var zoom_delta := 0.0
	if Input.is_key_pressed(KEY_EQUAL) or Input.is_key_pressed(KEY_PLUS) or Input.is_key_pressed(KEY_KP_ADD):
		zoom_delta -= ZOOM_STEPS_PER_SECOND * delta
	if Input.is_key_pressed(KEY_MINUS) or Input.is_key_pressed(KEY_KP_SUBTRACT):
		zoom_delta += ZOOM_STEPS_PER_SECOND * delta
	zoom_amount = clampf(zoom_amount + zoom_delta, 0.0, 1.0)

	if Input.is_key_pressed(KEY_BRACKETLEFT):
		view_rotation -= VIEW_TURN_RADIANS_PER_SECOND * delta
	if Input.is_key_pressed(KEY_BRACKETRIGHT):
		view_rotation += VIEW_TURN_RADIANS_PER_SECOND * delta


func _draw_orbits() -> void:
	for body in bodies:
		var semi_major_axis := _semi_major_axis_au(body)
		if semi_major_axis <= 0.0:
			continue

		var parent_index := int(body.get("parent_index", -1))
		if parent_index < 0 or parent_index >= bodies.size():
			continue

		var parent_position: Vector2 = bodies[parent_index]["position_au"]
		var orbit_color := Color(0.42, 0.55, 0.68, 0.34)
		if body.get("type", "") == "moon":
			orbit_color = Color(0.55, 0.60, 0.66, 0.42)
		if body.get("type", "") == "station":
			orbit_color = Color(0.38, 0.86, 0.78, 0.45)

		var points := PackedVector2Array()
		var segments := _orbit_segment_count(semi_major_axis)
		for i in range(segments + 1):
			var angle := TAU * float(i) / float(segments)
			var point_au := _orbit_point(parent_position, body, angle)
			points.append(_to_screen(point_au))
		draw_polyline(points, orbit_color, 1.0, true)


func _draw_bodies() -> void:
	for body in bodies:
		var body_type := String(body.get("type", "planet"))
		var position_au: Vector2 = body.get("position_au", Vector2.ZERO)
		var screen_position := _to_screen(position_au)
		var radius := _body_radius_px(body)
		var color := Color(String(body.get("color", "#ffffff")))

		if body_type == "station":
			_draw_station(screen_position, radius, color)
		else:
			draw_circle(screen_position, radius + 1.5, Color(0.0, 0.0, 0.0, 0.45))
			draw_circle(screen_position, radius, color)
			if body.get("rings", false):
				draw_arc(screen_position, radius * 1.9, -0.45, PI + 0.45, 96, Color(0.78, 0.75, 0.62, 0.72), 2.0, true)

		if _should_label_body(body):
			draw_string(_font, screen_position + Vector2(radius + 5.0, -radius - 3.0), String(body.get("name", "")), HORIZONTAL_ALIGNMENT_LEFT, -1.0, 12, Color(0.77, 0.85, 0.91, 0.78))

		if String(body.get("id", "")) == selected_body_id:
			_draw_selection_marker(screen_position, radius)


func _draw_station(position: Vector2, radius: float, color: Color) -> void:
	var body := PackedVector2Array([
		position + Vector2(0.0, -radius),
		position + Vector2(radius, 0.0),
		position + Vector2(0.0, radius),
		position + Vector2(-radius, 0.0)
	])
	draw_colored_polygon(body, color)
	draw_polyline(PackedVector2Array([
		position + Vector2(-radius * 1.9, 0.0),
		position + Vector2(-radius * 0.85, 0.0),
		position + Vector2(radius * 0.85, 0.0),
		position + Vector2(radius * 1.9, 0.0)
	]), Color(0.78, 0.95, 1.0, 0.85), 2.0, true)
	draw_circle(position, radius * 0.33, Color("#071018"))


func _draw_selection_marker(position: Vector2, radius: float) -> void:
	var marker_radius := maxf(radius + 8.0, 14.0)
	draw_arc(position, marker_radius, 0.0, TAU, 72, Color("#f2d16b"), 2.0, true)
	draw_line(position + Vector2(marker_radius + 4.0, 0.0), position + Vector2(marker_radius + 13.0, 0.0), Color("#f2d16b"), 2.0, true)
	draw_line(position - Vector2(marker_radius + 4.0, 0.0), position - Vector2(marker_radius + 13.0, 0.0), Color("#f2d16b"), 2.0, true)
	draw_line(position + Vector2(0.0, marker_radius + 4.0), position + Vector2(0.0, marker_radius + 13.0), Color("#f2d16b"), 2.0, true)
	draw_line(position - Vector2(0.0, marker_radius + 4.0), position - Vector2(0.0, marker_radius + 13.0), Color("#f2d16b"), 2.0, true)


func _draw_ship() -> void:
	var position := _to_screen(ship_position_au)
	var visible_heading := ship_heading + view_rotation
	var forward := Vector2(cos(visible_heading), sin(visible_heading))
	var right := forward.orthogonal()
	var length := 18.0
	var width := 10.0
	var points := PackedVector2Array([
		position + forward * length,
		position - forward * length * 0.6 + right * width,
		position - forward * length * 0.25,
		position - forward * length * 0.6 - right * width
	])
	draw_colored_polygon(points, Color("#d9f0ff"))
	draw_polyline(PackedVector2Array([points[0], points[1], points[2], points[3], points[0]]), Color("#27435b"), 1.5, true)

	var exhaust_start := position - forward * 11.0
	if Input.is_key_pressed(KEY_UP):
		draw_line(exhaust_start, exhaust_start - forward * 18.0, Color("#ffbd59"), 3.0, true)
	if Input.is_key_pressed(KEY_DOWN):
		draw_line(position + forward * 12.0, position + forward * 27.0, Color("#76c9ff"), 2.0, true)


func _draw_hud(viewport_size: Vector2) -> void:
	var velocity := ship_velocity_km_s.length()
	var view_radius := _view_radius_au()
	var scale_label := _scale_label(view_radius)
	var hud_color := Color(0.84, 0.91, 0.96, 0.9)
	var muted := Color(0.52, 0.63, 0.71, 0.9)
	var y := 26.0

	draw_string(_font, Vector2(18.0, y), "Dark Qualms", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 18, hud_color)
	y += 22.0
	draw_string(_font, Vector2(18.0, y), system_name, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, muted)
	y += 24.0
	draw_string(_font, Vector2(18.0, y), "Velocity  %s" % _format_speed(velocity), HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, hud_color)
	y += 19.0
	draw_string(_font, Vector2(18.0, y), "Scale     %s radius" % scale_label, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, hud_color)
	y += 19.0
	draw_string(_font, Vector2(18.0, y), "Zoom      %d%%   Full view %.0f AU" % [roundi((1.0 - zoom_amount) * 100.0), SYSTEM_RADIUS_AU], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, muted)
	y += 19.0
	draw_string(_font, Vector2(18.0, y), "Time      %s  %dx" % [TIME_SPEED_KEYS.substr(time_speed_index, 1), _time_speed_multiplier()], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, hud_color)
	y += 19.0
	draw_string(_font, Vector2(18.0, y), "Target    %s" % _target_label(), HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, hud_color)
	y += 19.0
	draw_string(_font, Vector2(18.0, y), "Landing   %s" % _landing_label(), HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, hud_color)

	var bar_width := 220.0
	var bar_origin := Vector2(18.0, y + 16.0)
	draw_line(bar_origin, bar_origin + Vector2(bar_width, 0.0), Color(0.45, 0.58, 0.68, 0.75), 3.0, true)
	draw_circle(bar_origin, 4.0, Color(0.45, 0.58, 0.68, 0.95))
	draw_circle(bar_origin + Vector2(bar_width, 0.0), 4.0, Color(0.45, 0.58, 0.68, 0.95))
	draw_string(_font, bar_origin + Vector2(0.0, 18.0), "close", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 11, muted)
	draw_string(_font, bar_origin + Vector2(bar_width - 31.0, 18.0), "pluto", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 11, muted)
	draw_circle(bar_origin + Vector2(bar_width * zoom_amount, 0.0), 6.0, Color("#f2d16b"))

	var ship_au := "Ship AU  %.3f, %.3f" % [ship_position_au.x, ship_position_au.y]
	draw_string(_font, Vector2(18.0, viewport_size.y - 22.0), ship_au, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 13, muted)


func _draw_landing_window(viewport_size: Vector2) -> void:
	var panel_size := Vector2(minf(viewport_size.x - 80.0, 620.0), minf(viewport_size.y - 80.0, 520.0))
	var panel_position := (viewport_size - panel_size) * 0.5
	var panel := Rect2(panel_position, panel_size)
	var landed_body := _body_by_id(landed_body_id)
	var title := "Landed"
	if not landed_body.is_empty():
		title = "Landed: %s" % String(landed_body.get("name", "unknown"))

	draw_rect(Rect2(Vector2.ZERO, viewport_size), Color(0.0, 0.0, 0.0, 0.48))
	draw_rect(panel, Color("#101820"))
	draw_rect(panel, Color("#435a68"), false, 2.0)
	draw_string(_font, panel_position + Vector2(24.0, 34.0), title, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 20, Color(0.86, 0.93, 0.97, 0.95))

	var image_rect := Rect2(panel_position + Vector2(24.0, 58.0), Vector2(panel_size.x - 48.0, panel_size.y * 0.42))
	draw_rect(image_rect, Color.BLACK)
	draw_rect(image_rect, Color("#26323c"), false, 1.0)

	var menu_y := image_rect.position.y + image_rect.size.y + 34.0
	var menu_color := Color(0.84, 0.91, 0.96, 0.92)
	draw_string(_font, Vector2(panel_position.x + 36.0, menu_y), "1. option", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, menu_color)
	draw_string(_font, Vector2(panel_position.x + 36.0, menu_y + 30.0), "2. option", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, menu_color)
	draw_string(_font, Vector2(panel_position.x + 36.0, menu_y + 60.0), "3. option", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, menu_color)
	draw_string(_font, Vector2(panel_position.x + 36.0, menu_y + 90.0), "4. option", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, menu_color)
	draw_string(_font, Vector2(panel_position.x + 36.0, panel.end.y - 28.0), "(Esc) Take off", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 15, Color(0.74, 0.84, 0.90, 0.95))


func _draw_starfield(viewport_size: Vector2) -> void:
	var count := 120
	for i in range(count):
		var x := fposmod(float((i * 928371 + 421) % 10000) / 10000.0 * viewport_size.x + view_rotation * 17.0, viewport_size.x)
		var y := fposmod(float((i * 492113 + 977) % 10000) / 10000.0 * viewport_size.y + zoom_amount * 29.0, viewport_size.y)
		var alpha := 0.18 + float((i * 37) % 100) / 450.0
		draw_circle(Vector2(x, y), 1.0, Color(0.74, 0.84, 0.94, alpha))


func _to_screen(world_au: Vector2) -> Vector2:
	var viewport_size := get_viewport_rect().size
	var relative := (world_au - ship_position_au).rotated(-view_rotation)
	return viewport_size * 0.5 + relative * _pixels_per_au()


func _pixels_per_au() -> float:
	var viewport_size := get_viewport_rect().size
	var usable_radius_px := minf(viewport_size.x, viewport_size.y) * 0.45
	return usable_radius_px / _view_radius_au()


func _view_radius_au() -> float:
	return MIN_VIEW_RADIUS_AU * pow(SYSTEM_RADIUS_AU / MIN_VIEW_RADIUS_AU, zoom_amount)


func _orbit_point(parent_position: Vector2, body: Dictionary, eccentric_anomaly: float) -> Vector2:
	var semi_major_axis := _semi_major_axis_au(body)
	if semi_major_axis <= 0.0:
		return parent_position

	var eccentricity := _eccentricity(body)
	var major_axis := _major_axis_vector(body)
	var minor_axis := major_axis.orthogonal()
	var semi_minor_axis := semi_major_axis * _minor_axis_ratio(body)
	var ellipse_center := parent_position - major_axis * semi_major_axis * eccentricity
	return ellipse_center + major_axis * semi_major_axis * cos(eccentric_anomaly) + minor_axis * semi_minor_axis * sin(eccentric_anomaly)


func _semi_major_axis_au(body: Dictionary) -> float:
	return float(body.get("semi_major_axis_au", body.get("orbital_distance_au", 0.0)))


func _eccentricity(body: Dictionary) -> float:
	if not body.has("eccentricity") and body.has("minor_axis_ratio"):
		var ratio := clampf(float(body["minor_axis_ratio"]), 0.05, 1.0)
		return sqrt(1.0 - ratio * ratio)

	return clampf(float(body.get("eccentricity", 0.0)), 0.0, 0.95)


func _minor_axis_ratio(body: Dictionary) -> float:
	if body.has("minor_axis_ratio"):
		return clampf(float(body["minor_axis_ratio"]), 0.05, 1.0)

	var eccentricity := _eccentricity(body)
	return sqrt(1.0 - eccentricity * eccentricity)


func _major_axis_vector(body: Dictionary) -> Vector2:
	var angle := deg_to_rad(float(body.get("major_axis_degrees", 0.0)))
	return Vector2(cos(angle), sin(angle))


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


func _time_speed_multiplier() -> int:
	return time_speed_index + 1


func _select_next_orbital(direction: int) -> void:
	var orbitals := _orbitals_by_distance()
	if orbitals.is_empty():
		selected_body_id = ""
		return

	if selected_body_id.is_empty():
		selected_body_id = String(orbitals[0 if direction > 0 else orbitals.size() - 1]["id"])
		return

	for i in range(orbitals.size()):
		if String(orbitals[i]["id"]) == selected_body_id:
			var next_index := posmod(i + direction, orbitals.size())
			selected_body_id = String(orbitals[next_index]["id"])
			return

	selected_body_id = String(orbitals[0]["id"])


func _orbitals_by_distance() -> Array[Dictionary]:
	var orbitals: Array[Dictionary] = []
	for body in bodies:
		if int(body.get("parent_index", -1)) < 0:
			continue

		var position: Vector2 = body.get("position_au", Vector2.ZERO)
		var entry := {
			"id": String(body.get("id", "")),
			"body": body,
			"distance_au": position.distance_to(ship_position_au)
		}
		orbitals.append(entry)

	orbitals.sort_custom(_compare_orbital_distance)
	return orbitals


func _compare_orbital_distance(a: Dictionary, b: Dictionary) -> bool:
	return float(a["distance_au"]) < float(b["distance_au"])


func _target_label() -> String:
	var selected_body := _selected_body()
	if selected_body.is_empty():
		return "none"

	var position: Vector2 = selected_body.get("position_au", Vector2.ZERO)
	var distance := position.distance_to(ship_position_au)
	return "%s  %s" % [String(selected_body.get("name", "unknown")), _scale_label(distance)]


func _landing_label() -> String:
	if _is_landed():
		var landed_body := _body_by_id(landed_body_id)
		if landed_body.is_empty():
			return "landed"
		return "landed at %s" % String(landed_body.get("name", "unknown"))

	var selected_body := _selected_body()
	if selected_body.is_empty():
		return "select target"

	var distance := _distance_to_body(selected_body)
	if distance <= LANDING_THRESHOLD_AU:
		return "press L"

	return "%s away" % _scale_label(distance - LANDING_THRESHOLD_AU)


func _try_land() -> void:
	var selected_body := _selected_body()
	if selected_body.is_empty():
		return

	if _distance_to_body(selected_body) > LANDING_THRESHOLD_AU:
		return

	landed_body_id = String(selected_body.get("id", ""))
	_update_landed_ship()


func _take_off() -> void:
	landed_body_id = ""


func _is_landed() -> bool:
	return not landed_body_id.is_empty()


func _distance_to_body(body: Dictionary) -> float:
	var position: Vector2 = body.get("position_au", Vector2.ZERO)
	return position.distance_to(ship_position_au)


func _selected_body() -> Dictionary:
	return _body_by_id(selected_body_id)


func _body_by_id(body_id: String) -> Dictionary:
	if body_id.is_empty():
		return {}

	for body in bodies:
		if String(body.get("id", "")) == body_id:
			return body

	return {}


func _body_radius_px(body: Dictionary) -> float:
	var body_type := String(body.get("type", "planet"))
	var radius_km := maxf(float(body.get("radius_km", 1.0)), 1.0)
	var zoom_visibility := lerpf(1.0, 0.72, zoom_amount)

	if body_type == "star":
		return clampf(11.0 + sqrt(radius_km / 28000.0) * 2.2, 14.0, 32.0) * zoom_visibility
	if body_type == "station":
		return clampf(6.0 + sqrt(radius_km / 120.0), 7.0, 12.0) * zoom_visibility
	if body_type == "moon":
		return clampf(3.0 + sqrt(radius_km / 1700.0) * 2.0, 3.2, 8.0) * zoom_visibility
	return clampf(4.0 + sqrt(radius_km / 6371.0) * 3.0, 4.5, 14.5) * zoom_visibility


func _orbit_segment_count(distance_au: float) -> int:
	if distance_au < 0.01:
		return 48
	if distance_au < 0.2:
		return 72
	if distance_au < 3.0:
		return 128
	return ORBIT_SEGMENTS


func _should_label_body(body: Dictionary) -> bool:
	var body_type := String(body.get("type", "planet"))
	if body_type == "star":
		return zoom_amount >= 0.08
	if body_type == "station":
		return zoom_amount <= 0.62
	if body_type == "moon":
		return zoom_amount <= 0.45
	return zoom_amount >= 0.18 or _semi_major_axis_au(body) <= 2.0


func _format_speed(speed_km_s: float) -> String:
	if speed_km_s >= 1000.0:
		return "%.2f Mm/s" % (speed_km_s / 1000.0)
	return "%.1f km/s" % speed_km_s


func _scale_label(radius_au: float) -> String:
	if radius_au < 0.01:
		return "%.0f thousand km" % (radius_au * AU_KM / 1000.0)
	if radius_au < 1.0:
		return "%.3f AU" % radius_au
	if radius_au < 10.0:
		return "%.2f AU" % radius_au
	return "%.1f AU" % radius_au
