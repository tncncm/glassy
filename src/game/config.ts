/**
 * Glassy — every gameplay tunable lives here. Nothing under src/game/entities
 * or src/game/systems hardcodes a magic number; they import from this file so
 * the whole feel of the runner can be re-tuned in one place.
 *
 * Units: pixels, seconds, px/s, px/s^2 unless noted otherwise. All motion is
 * delta-time based so these numbers describe *rates*, not per-frame deltas.
 */

/* ------------------------------------------------------------------ */
/* Frame timing                                                        */
/* ------------------------------------------------------------------ */

/** Hard cap on a single frame's dt. A backgrounded tab regaining focus (or a
 * long GC pause) reports a huge elapsedMS on the next rAF; without this cap
 * that would be fed straight into `position += speed * dt` and tunnel the
 * player clean through an obstacle. 0.05s = a 20fps floor. */
export const MAX_DELTA_SECONDS = 0.05;

/* ------------------------------------------------------------------ */
/* Ground line (the draggable virtual platform)                        */
/* ------------------------------------------------------------------ */

/** Ground line vertical position is stored as a fraction of canvas height so
 * it survives resize/orientation-change without a jump or extra bookkeeping. */
export const GROUND_Y_MIN_FRACTION = 0.32;
export const GROUND_Y_MAX_FRACTION = 0.88;
export const GROUND_Y_DEFAULT_FRACTION = 0.72;

/** Exponential-smoothing rate (1/s) the *visual* ground line chases the drag
 * target with — gives the platform a light, responsive-but-not-jittery feel. */
export const GROUND_LERP_RATE = 12;

/* --- Horizon hint bias (camera-estimated horizon nudging the ground target) */

/**
 * Below this confidence the horizon estimate is ignored outright — a noisy
 * single-frame estimate must never be allowed to tug the ground line.
 *
 * Measured, not guessed: on real motorway footage (tools/video-sim) a solid
 * lock on the crash barrier reports ~0.32 mean confidence, because cluster
 * averaging deliberately flattens the peak it scores against. This sat at
 * 0.35 and silently rejected almost every good estimate. Fog and pure noise
 * still report null outright, so they never reach this check.
 */
export const HORIZON_HINT_MIN_CONFIDENCE = 0.22;
/** Seconds after any manual ground-line drag (pointer or keyboard) during
 * which the horizon hint is ignored entirely. The player's own placement of
 * the platform always wins over a passive camera guess. */
export const HORIZON_HINT_LOCKOUT_SECONDS = 4;
/** Exponential rate (1/s, used with expDecay like GROUND_LERP_RATE) at which
 * an *accepted* hint pulls `groundYTargetFraction` toward it. This is
 * deliberately much slower than GROUND_LERP_RATE (12): GROUND_LERP_RATE only
 * smooths the *visual* line chasing its target, whereas this rate moves the
 * target itself, so it must be slow enough that a noisy or drifting horizon
 * estimate can never read as a snap or a fight with the player — at 0.15/s
 * the target closes half the gap to the hint roughly every 4.6s. */
export const HORIZON_HINT_BIAS_RATE = 0.15;

export const GROUND_LINE_THICKNESS = 3;
export const GROUND_LINE_GLOW_THICKNESS = 14;
export const GROUND_LINE_COLOR = 0xffffff;
export const GROUND_LINE_ALPHA = 0.65;
export const GROUND_LINE_GLOW_ALPHA = 0.12;
/** Half-width, in px, of a soft dark strip under the line so the player and
 * obstacles keep contrast even against a bright/busy camera feed. */
export const GROUND_SHADOW_HEIGHT = 10;
export const GROUND_SHADOW_ALPHA = 0.16;

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

/** The passenger sits on the right of the car and looks out the right-hand
 * window, so "ahead" (the direction of travel, and the direction the player
 * character faces) reads as LEFT on screen, and stationary scenery in the
 * camera feed flows left → right (approaching from the front, receding to
 * the back). The player sits toward the right edge so incoming obstacles —
 * spawned off the left edge, traveling left → right, matching that flow —
 * get the ~76% of screen width to their left as runway. */
export const PLAYER_X_FRACTION = 0.76;
export const PLAYER_WIDTH = 34;
export const PLAYER_HEIGHT = 46;
export const PLAYER_LEG_LENGTH = 16;
export const PLAYER_LEG_WIDTH = 7;

/** Forgiving AABB inset — players hate pixel-perfect collision. */
export const PLAYER_COLLISION_INSET_X = 7;
export const PLAYER_COLLISION_INSET_TOP = 9;
export const PLAYER_COLLISION_INSET_BOTTOM = 2;

/** px/s^2, downward. */
export const GRAVITY = 2600;
/** px/s upward impulse of the primary jump — this single number (with
 * GRAVITY) drives the whole solvability derivation in util/solvability.ts. */
export const JUMP_VELOCITY = 980;

export const DOUBLE_JUMP_ENABLED = true;
/** Slightly weaker than the primary jump so it reads as a "second wind", not
 * a free repeat, and so it can't be chained to trivialise height limits. */
export const DOUBLE_JUMP_VELOCITY = 740;

/** Grace window after walking off a ledge during which a jump still fires. */
export const COYOTE_TIME_SECONDS = 0.08;
/** Grace window a jump press is remembered before landing, so an early tap
 * still launches the instant the player touches down. */
export const JUMP_BUFFER_SECONDS = 0.12;

/** Squash/stretch: exponential return-to-rest rate (1/s) of the scale spring. */
export const SQUASH_STRETCH_RATE = 16;
export const JUMP_SQUASH_SCALE_X = 1.22;
export const JUMP_SQUASH_SCALE_Y = 0.8;
export const LAND_SQUASH_SCALE_X = 1.32;
export const LAND_SQUASH_SCALE_Y = 0.7;

/** Leg-swing phase speed at BASE_WORLD_SPEED, radians/s; scaled live by the
 * current speed ratio so the run cycle visually speeds up with difficulty. */
export const RUN_CYCLE_BASE_SPEED = 10;
export const RUN_LEG_SWING_RADIANS = 0.62;
/** Airborne leg tuck angle (both legs pull back together). */
export const AIRBORNE_LEG_ANGLE = -0.5;

export const PLAYER_COLOR_BODY = 0xffce45;
export const PLAYER_COLOR_OUTLINE = 0x2b1d00;
export const PLAYER_COLOR_LIMB = 0xe6a92e;
export const PLAYER_COLOR_EYE = 0x1a1400;

/* ------------------------------------------------------------------ */
/* Dash — forward burst + brief invulnerability                        */
/* ------------------------------------------------------------------ */

/** Extra world-speed multiplier at the instant a dash triggers (so effective
 * speed peaks at `1 + DASH_PEAK_BOOST`, i.e. 2.2x) — chosen to read as a
 * clear surge without being so fast the ramping-past-obstacles scenery
 * becomes an unreadable blur. Decays via expDecay, not a hard cutoff. */
export const DASH_PEAK_BOOST = 1.2;
/** Exponential decay rate (1/s) of the speed boost back to 0 — at this rate
 * the boost is ~98.5% gone by DASH_DURATION_SECONDS, which is what makes
 * that constant a meaningful "duration" despite the decay never technically
 * reaching exactly 0. */
export const DASH_DECAY_RATE = 6;
/** Nominal total duration (s) of the visible dash effect (speed trail etc.),
 * i.e. how long DASH_DECAY_RATE takes to make the boost negligible. Must
 * stay LARGER than DASH_INVULN_SECONDS — see that constant's comment — so
 * the trail visibly outlasts the window where it's actually safe. */
export const DASH_DURATION_SECONDS = 0.7;
/**
 * Invulnerability window (s), strictly SHORTER than DASH_DURATION_SECONDS so
 * dashing can't be spammed as a permanent free pass — the flashy tail end of
 * the trail is cosmetic only, not safe.
 *
 * This single number is also a solvability input (see util/solvability.ts):
 * it is what lets the WIDE obstacle type exist at all. A wide obstacle is,
 * by construction, too wide for a jump to clear (wider than
 * OBSTACLE_MAX_WIDTH_CAP) — the ONLY way past it is to be invulnerable for
 * its entire pass time. `maxDashClearableObstacleWidth()` inverts
 * `passTime = (width + PLAYER_WIDTH) / worldSpeed <= DASH_INVULN_SECONDS`
 * using the *unboosted* world speed (a deliberately conservative bound: the
 * real dash is faster than this during the window, so this is guaranteed
 * safe even if the boost had already fully decayed, which it hasn't). At
 * BASE_WORLD_SPEED (the slowest — and therefore worst-case — speed the ramp
 * ever produces) this yields a comfortably non-empty width range; see the
 * derivation for the proof it stays non-empty as speed increases.
 */
export const DASH_INVULN_SECONDS = 0.5;
/** Cooldown (s) before another dash can trigger, counted from the previous
 * trigger. Deliberately close to but longer than DASH_DURATION_SECONDS so a
 * dash reads as a discrete, spend-and-recover burst rather than a toggle. */
export const DASH_COOLDOWN_SECONDS = 0.9;

/** Squash/stretch target on dash trigger — elongated and flattened, reusing
 * the existing squash spring (SQUASH_STRETCH_RATE) for the "lunge" read
 * instead of any new relax code. */
export const DASH_SQUASH_SCALE_X = 1.5;
export const DASH_SQUASH_SCALE_Y = 0.72;

/** Pre-created motion-trail streaks behind the player, visible only while
 * dashBoost is active; count is small and fixed (pool, not per-frame alloc). */
export const DASH_TRAIL_STREAK_COUNT = 4;
export const DASH_TRAIL_STREAK_SPACING_PX = 11;
export const DASH_TRAIL_STREAK_LENGTH_PX = 18;
export const DASH_TRAIL_STREAK_THICKNESS_PX = 5;
export const DASH_TRAIL_MAX_ALPHA = 0.45;
export const DASH_TRAIL_COLOR = 0xffffff;

/** Small pre-created "ready" dot above the player's head — the visual tell
 * for ready-vs-charging cooldown state. */
export const DASH_INDICATOR_RADIUS = 4;
/** Extra px above the player's head (beyond PLAYER_HEIGHT) the dot floats. */
export const DASH_INDICATOR_OFFSET_Y = 12;
export const DASH_INDICATOR_READY_COLOR = 0x5be8ff;
export const DASH_INDICATOR_CHARGING_COLOR = 0x2c3b45;
export const DASH_INDICATOR_READY_ALPHA = 0.95;
export const DASH_INDICATOR_CHARGING_ALPHA_MIN = 0.25;

/** Flat score bonus for dashing through an obstacle during the
 * invulnerability window (once per obstacle, not per frame of overlap). */
export const DASH_THROUGH_BONUS_SCORE = 25;
/** Screen-shake trauma added (not overwritten — see SHAKE_DECAY_RATE) when
 * dashing through an obstacle; softer than a full collision's trauma. */
export const DASH_THROUGH_SHAKE_TRAUMA = 0.5;

/* ------------------------------------------------------------------ */
/* Slam (ground pound)                                                 */
/* ------------------------------------------------------------------ */

/** Forced downward px/s the instant a slam triggers — roughly double
 * JUMP_VELOCITY (980) so it reads as an unmistakably faster, more violent
 * descent than simply falling from the jump arc's own apex ever produces. */
export const SLAM_DROP_SPEED = 1900;
/** Screen-shake trauma added on slam landing — stronger than a dash-through
 * bonus, short of a full collision. */
export const SLAM_SHAKE_TRAUMA = 0.7;

export const SLAM_PARTICLE_COUNT = 18;
export const SLAM_PARTICLE_SPEED_MIN = 120;
export const SLAM_PARTICLE_SPEED_MAX = 340;
export const SLAM_PARTICLE_LIFETIME_SECONDS = 0.5;
export const SLAM_PARTICLE_COLOR = 0x8fe3ff;
/** The shockwave should hug the ground (a flattened ring), not a full
 * spherical burst — this multiplies the vertical component of each
 * particle's launch velocity down after the angle is picked. */
export const SLAM_PARTICLE_VERTICAL_SQUASH = 0.35;

/* ------------------------------------------------------------------ */
/* World speed / difficulty ramp                                       */
/* ------------------------------------------------------------------ */

/** px/s at score 0. */
export const BASE_WORLD_SPEED = 320;
/** Asymptotic cap — the ramp approaches but never reaches this. */
export const MAX_WORLD_SPEED = 760;
/** Higher = slower ramp. World speed follows
 * `BASE + (MAX - BASE) * (1 - exp(-score / SPEED_RAMP_SCORE_CONSTANT))`. */
export const SPEED_RAMP_SCORE_CONSTANT = 420;

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/** Score units per second while running at BASE_WORLD_SPEED; scales up with
 * the live speed ratio so faster running scores faster too. */
export const SCORE_PER_SECOND_AT_BASE_SPEED = 10;
/** Cadence, in score units, at which the milestone chime fires. */
export const SCORE_MILESTONE_STEP = 100;

/* ------------------------------------------------------------------ */
/* Obstacles                                                           */
/* ------------------------------------------------------------------ */

export const OBSTACLE_POOL_SIZE = 14;

export const OBSTACLE_MIN_WIDTH = 26;
/** Absolute upper bound regardless of what solvability would otherwise allow. */
export const OBSTACLE_MAX_WIDTH_CAP = 72;
export const OBSTACLE_MIN_HEIGHT = 28;
export const OBSTACLE_MAX_HEIGHT_CAP = 108;

/** How far beyond the left edge obstacles spawn, and how far beyond the
 * right edge they're recycled — both in px, both comfortably off-screen.
 * (Obstacles travel left → right, matching the passing-scenery direction —
 * see PLAYER_X_FRACTION's comment.) */
export const OBSTACLE_SPAWN_MARGIN = 30;
export const OBSTACLE_DESPAWN_MARGIN = 80;

/** Initial empty run before the first obstacle, in px, so the player always
 * gets a moment to get their bearings after Play. */
export const OBSTACLE_INITIAL_SPAWN_DISTANCE = 520;

export const OBSTACLE_COLOR_BLOCK = 0x36e5c8;
export const OBSTACLE_COLOR_SPIKE = 0xff5470;
export const OBSTACLE_COLOR_WIDE = 0x9b6bff;
export const OBSTACLE_COLOR_OVERHEAD = 0xff9d3d;
export const OBSTACLE_COLOR_OUTLINE = 0x08251f;
export const OBSTACLE_CORNER_RADIUS = 6;

/** Selection weights for the four obstacle kinds, sampled by
 * cumulative-sum — must sum to 1. `block`/`spike` are the original
 * jump-clearable kinds; `wide` rewards a dash, `overhead` rewards staying
 * grounded (or slamming back down promptly). Kept a minority of spawns each
 * so the core jump loop — already validated as fun — stays the backbone of
 * the run rather than being diluted. */
export const OBSTACLE_WEIGHT_BLOCK = 0.4;
export const OBSTACLE_WEIGHT_SPIKE = 0.3;
export const OBSTACLE_WEIGHT_WIDE = 0.15;
export const OBSTACLE_WEIGHT_OVERHEAD = 0.15;

/** Low/wide "wall" obstacle — too wide for any jump to clear (see
 * WIDE_OBSTACLE_WIDTH_MARGIN_PX in the solvability section below), meant to
 * be dashed through during invulnerability. Height is a visual choice only
 * (clearing it is about timing the dash, not height) but kept low so it
 * reads as a wall to blast through rather than something to jump at. */
export const WIDE_OBSTACLE_MIN_HEIGHT = OBSTACLE_MIN_HEIGHT;
export const WIDE_OBSTACLE_MAX_HEIGHT = 56;

/** Overhead hazard — hangs down from off the top of the screen to a fixed
 * clearance above the ground line (see OVERHEAD_HAZARD_CLEARANCE_PX in
 * util/solvability.ts), cleared by staying grounded. Width is a visual
 * choice only, same reasoning as the wide obstacle above. */
export const OVERHEAD_HAZARD_MIN_WIDTH = 60;
export const OVERHEAD_HAZARD_MAX_WIDTH = 120;
/** Generous fixed draw height so the hazard's body always reaches off the
 * top of the viewport regardless of device height or where the ground line
 * has been dragged to — pure overdraw, not a gameplay tunable (compare
 * GROUND_LINE_OVERDRAW_PX in Game.ts, same idea). */
export const OVERHEAD_HAZARD_DRAW_HEIGHT = 1400;
/** Width of each triangular "icicle" tooth along the hazard's bottom edge —
 * purely decorative, sized to always divide evenly-ish into the hazard's
 * width range above. */
export const OVERHEAD_HAZARD_TOOTH_WIDTH = 16;

/* ------------------------------------------------------------------ */
/* Solvability safety margins — see util/solvability.ts for the derivation. */
/* ------------------------------------------------------------------ */

/** The player's x is fixed — the world scrolls under it — so clearing an
 * obstacle means staying airborne, above its height, for the entire window
 * its box overlaps the player's column, not "outrunning" it horizontally.
 * This single dial governs both the width and height derivation in
 * util/solvability.ts: it's the fraction of the jump's theoretical
 * hang-time-above-height budget we actually rely on, leaving the rest as
 * margin for a jump triggered slightly early or late. */
export const JUMP_ARC_SAFETY_FACTOR = 0.6;
/** Extra time (seconds), beyond the jump's own flight time, reserved between
 * landing from one obstacle and needing to react to the next. */
export const GAP_REACTION_TIME_SECONDS = 0.35;
/** Overall multiplier applied on top of the derived minimum gap. */
export const GAP_SAFETY_FACTOR = 1.2;
/** Extra random slack layered on top of the minimum-safe gap when spawning,
 * expressed as a multiplier range so spacing doesn't feel metronomic. */
export const GAP_RANDOM_EXTRA_MIN = 1;
export const GAP_RANDOM_EXTRA_MAX = 1.5;

/** Minimum px a `wide` obstacle's width must exceed OBSTACLE_MAX_WIDTH_CAP
 * by. `maxClearableObstacleWidth()` is architecturally bounded above by
 * OBSTACLE_MAX_WIDTH_CAP no matter what the jump kinematics are (its own
 * `clamp` upper bound), so `OBSTACLE_MAX_WIDTH_CAP + this` is a width no
 * jump can ever clear, by construction, without needing to re-derive
 * anything if JUMP_VELOCITY/GRAVITY ever change. */
export const WIDE_OBSTACLE_WIDTH_MARGIN_PX = 20;
/** Absolute upper bound on a `wide` obstacle's width, regardless of how much
 * headroom `maxDashClearableObstacleWidth()` would otherwise allow at high
 * world speed — keeps the wall from growing absurdly long late in a run. */
export const WIDE_OBSTACLE_MAX_WIDTH_CAP = 170;

/** Extra px of clearance, beyond the player's own standing collision
 * height, an `overhead` hazard's danger edge sits above the ground line —
 * see `OVERHEAD_HAZARD_CLEARANCE_PX` in util/solvability.ts, which derives
 * the base requirement from PLAYER_HEIGHT/PLAYER_COLLISION_INSET_TOP; this
 * is just the safety margin on top, same role as JUMP_ARC_SAFETY_FACTOR's
 * slack but for a fixed geometric fit instead of a timed arc. */
export const OVERHEAD_CLEARANCE_MARGIN_PX = 10;

/* ------------------------------------------------------------------ */
/* Scene-detection-driven spawns                                       */
/*                                                                      */
/* Object detection (src/vision/ObjectDetector.ts) is a FLAVOUR input,  */
/* never a spawn command — see Game.ts#onSceneDetections. A detection   */
/* only ever REQUESTS a themed shape/kind; the existing pooled systems  */
/* (ObstacleSystem for `vehicle`, PickupSystem below for `person`/      */
/* `sign`) still decide *when* anything actually spawns, on exactly the */
/* same solvability-derived cadence they already used before this      */
/* feature existed. That's what makes "detection off => byte-identical  */
/* gameplay" true almost for free: with zero requests queued, both      */
/* systems fall back to their pre-existing behaviour untouched.         */
/* ------------------------------------------------------------------ */

/** Detections below this confidence are ignored outright — a low-score
 * false positive (e.g. a shadow briefly read as a "sign") must never be
 * allowed to spawn anything. */
export const DETECTION_MIN_SCORE = 0.55;

/** Per-`DetectedKind` debounce, seconds. The detector samples at ~3Hz and
 * the same real-world object is typically visible for many samples in a
 * row, so without this a truck sitting in frame for two seconds would
 * queue a hazard request on nearly every sample. Only the first accepted
 * detection of a kind within this window becomes a spawn request; this
 * alone bounds even a pathological 20-detections-in-one-second burst (any
 * mix of kinds) to at most one accepted request per kind — at most 3
 * total, since there are only 3 `DetectedKind`s. */
export const DETECTION_KIND_COOLDOWN_SECONDS = 3.5;

/** Max requests allowed to sit queued, waiting for the next solvability-
 * safe obstacle spawn slot, before further requests of that kind are
 * simply dropped. Small on purpose: this is a second, independent cap on
 * top of the cooldown above, not the primary defence against a burst. */
export const DETECTION_VEHICLE_QUEUE_CAP = 2;
export const DETECTION_PICKUP_QUEUE_CAP = 1;

/* --- `vehicle` → hazard ------------------------------------------------ */

/** A detection-requested `vehicle` hazard is sized within the SAME
 * solvability-derived envelope as `block`/`spike` — see
 * maxClearableObstacleWidth/maxClearableObstacleHeight in
 * util/solvability.ts — so it is always jump-clearable, never a free
 * pass. It's biased toward the upper portion of that envelope (rather
 * than sampled across the full range like block/spike) so it reads as
 * "bulkier", matching a real vehicle's bulk, while never exceeding the
 * width/height a jump can already handle. Expressed as a fraction so it
 * stays correct at any world speed without re-deriving anything. */
export const OBSTACLE_VEHICLE_SIZE_BIAS_MIN = 0.55;

export const OBSTACLE_COLOR_VEHICLE_BODY = 0x4a5568;
export const OBSTACLE_COLOR_VEHICLE_ACCENT = 0xff6b4a;
export const OBSTACLE_COLOR_VEHICLE_WHEEL = 0x1a1f26;

/* --- `person` → collectible, `sign` → power-up ------------------------- */

export const PICKUP_POOL_SIZE = 8;
export const PICKUP_RADIUS_COLLECTIBLE = 13;
export const PICKUP_RADIUS_POWERUP = 15;

/** Minimum world-space px between one pickup spawn and the next, so two
 * requests queued close together (e.g. a person then a sign inside the
 * same debounce window) never spawn stacked on each other. Deliberately
 * NOT derived from jump kinematics like minSafeGap: missing a pickup has
 * no failure consequence, so this is a legibility choice, not a safety
 * one — pickups never go through the same solvability gate hazards do
 * because they cannot end the run. */
export const PICKUP_MIN_SPACING_PX = 260;

export const PICKUP_SPAWN_MARGIN = 30;
export const PICKUP_DESPAWN_MARGIN = 80;

/** Float height above the ground line, as a fraction of the primary
 * jump's apex height (see PRIMARY_JUMP_ARC in util/solvability.ts) so a
 * pickup always sits somewhere a full jump COULD reach — self-adjusting
 * if JUMP_VELOCITY/GRAVITY are ever retuned, same philosophy as every
 * other derived bound in this file. Purely a "worth chasing" placement
 * choice, not a solvability requirement, since skipping a pickup is safe. */
export const PICKUP_HEIGHT_APEX_FRACTION_MIN = 0.2;
export const PICKUP_HEIGHT_APEX_FRACTION_MAX = 0.78;

export const PICKUP_COLLECTIBLE_COLOR = 0xff6ec7;
export const PICKUP_COLLECTIBLE_OUTLINE = 0x5c1440;
export const PICKUP_POWERUP_COLOR = 0x5be8ff;
export const PICKUP_POWERUP_OUTLINE = 0x0c3542;
/** Small contrasting bolt icon drawn on the power-up — visual shorthand
 * for "dash recharge" (see POWERUP_SCORE_BONUS and Player.grantDashRecharge). */
export const PICKUP_POWERUP_BOLT_COLOR = 0x0c3542;

/** Flat score bonus on pickup. Collectible pays more than the power-up
 * because the power-up's main value is the dash recharge itself, not the
 * points — see the choice rationale in Game.ts#onSceneDetections' doc. */
export const COLLECTIBLE_SCORE_BONUS = 35;
export const POWERUP_SCORE_BONUS = 15;

/** Gentle bobbing so pickups read as floating collectibles, not static
 * geometry — purely cosmetic, layered on top of the world-scroll x
 * movement every frame; not a per-frame allocation (just a phase field). */
export const PICKUP_BOB_SPEED = 3.2;
export const PICKUP_BOB_AMPLITUDE_PX = 6;

/* ------------------------------------------------------------------ */
/* Particles                                                           */
/* ------------------------------------------------------------------ */

export const PARTICLE_POOL_SIZE = 48;
export const PARTICLE_RADIUS = 4;

export const DUST_PARTICLE_COUNT = 6;
export const DUST_SPEED_MIN = 40;
export const DUST_SPEED_MAX = 130;
export const DUST_LIFETIME_SECONDS = 0.4;
export const DUST_COLOR = 0xffffff;

export const COLLISION_PARTICLE_COUNT = 20;
export const COLLISION_SPEED_MIN = 90;
export const COLLISION_SPEED_MAX = 320;
export const COLLISION_LIFETIME_SECONDS = 0.6;
export const COLLISION_COLOR_A = 0xff5470;
export const COLLISION_COLOR_B = 0xffce45;

export const PARTICLE_GRAVITY = 900;
/** Per-second velocity damping factor (higher = particles slow down faster). */
export const PARTICLE_DRAG_PER_SECOND = 2.4;

/** Pickup-collection sparkle (see ParticleSystem.spawnSparkle) — shared
 * count/speed/lifetime for both pickup kinds; the caller supplies the color
 * (PICKUP_COLLECTIBLE_COLOR / PICKUP_POWERUP_COLOR below) so this stays one
 * set of tunables instead of two near-duplicates. */
export const PICKUP_PARTICLE_COUNT = 10;
export const PICKUP_PARTICLE_SPEED_MIN = 60;
export const PICKUP_PARTICLE_SPEED_MAX = 220;
export const PICKUP_PARTICLE_LIFETIME_SECONDS = 0.45;

/* ------------------------------------------------------------------ */
/* Screen shake                                                        */
/* ------------------------------------------------------------------ */

/** Trauma decay rate, 1/s. */
export const SHAKE_DECAY_RATE = 5.5;
export const SHAKE_MAGNITUDE_PX = 16;
export const COLLISION_SHAKE_TRAUMA = 1;

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

export const TAP_MAX_DURATION_MS = 220;
export const TAP_MAX_MOVEMENT_PX = 12;
/** Vertical movement, px, past which a pointer gesture commits to "drag the
 * platform" (grounded) or "slam" (airborne, downward only) and can no longer
 * resolve as a tap-jump. */
export const DRAG_THRESHOLD_PX = 16;
/** Horizontal movement, px, past which a pointer gesture commits to "dash"
 * and can no longer resolve as a tap-jump or a ground drag — same magnitude
 * as DRAG_THRESHOLD_PX so the two axes feel equally sensitive to commit to. */
export const SWIPE_THRESHOLD_PX = 24;
export const KEYBOARD_GROUND_STEP_PX = 28;

/* ------------------------------------------------------------------ */
/* Windscreen platforms — src/game/systems/PlatformSystem.ts           */
/*                                                                      */
/* VisionMode 'windscreen' turns each STABLE TrackedObject into a real  */
/* landing surface (see Game.ts's onTrackedObjects and the one-way      */
/* surface-resolution block in Game.ts's update()). Nothing here is a   */
/* solvability concern in the util/solvability.ts sense: a platform can */
/* only ever ADD a place to stand, never a hazard (touching one never   */
/* ends the run, unlike an Obstacle) and never a barrier (one-way:      */
/* landable only from above, so it can never block the only route or    */
/* trap the player — see the one-way selection rule in Game.ts).        */
/* ------------------------------------------------------------------ */

/** Max simultaneous platforms — "a handful", per the brief. The pool is
 * fixed size and never grows; a track arriving once the pool is full is
 * simply ignored until a slot frees up (see PlatformSystem.onTrackedObjects). */
export const PLATFORM_POOL_SIZE = 6;

/** Exponential follow rate (1/s, used with expDecay like GROUND_LERP_RATE)
 * a platform's rendered/collidable box chases its latest tracked position
 * at. The tracker only reports "a few times a second" (types.ts), so this
 * is deliberately much slower than GROUND_LERP_RATE (12): at that rate the
 * box would all but snap to each new sample within a frame or two, which —
 * given how sparse the samples are — would read as a stepped jump wearing a
 * thin coat of smoothing, not the continuous glide the brief asks for. At
 * 5/s the box is still visibly gliding when the next sample lands (assuming
 * ~3-5Hz), so consecutive updates blend into one continuous motion instead
 * of a series of catch-up snaps. */
export const PLATFORM_FOLLOW_LERP_RATE = 5;

/** Seconds a platform survives with no matching TrackedObject update before
 * being fully retired to the pool. Deliberately generous — a real detector
 * dropping a track for a frame or two (occlusion, a momentary bad frame)
 * must not yank the ground out from under a standing player. This is a
 * separate, much longer grace period than the jump/ground-line's own
 * COYOTE_TIME_SECONDS, which stays tiny and input-focused as before. The
 * platform remains fully SOLID for this entire window — only its visual
 * fades (see PLATFORM_FADE_SECONDS) — so "solid" and "visible" never
 * disagree with each other. */
export const PLATFORM_GRACE_SECONDS = 0.9;

/** Portion of PLATFORM_GRACE_SECONDS, at its tail end, during which the
 * platform's alpha ramps from 1 to 0 — the visual warning that a track is
 * about to disappear, so a player standing on it sees it going before it's
 * gone, rather than a platform vanishing (or a player falling) with no cue.
 * Kept strictly <= PLATFORM_GRACE_SECONDS. */
export const PLATFORM_FADE_SECONDS = 0.45;

/** Small px epsilon around "the player's previous foot position is at or
 * above a platform's top edge" — the one-way landing test in Game.ts. Just
 * large enough to absorb interpolation jitter for a player standing still on
 * a platform (so they don't spuriously fall through it), but far too small
 * to let a player standing on the ground "snap" onto a platform that
 * appears meaningfully above their current feet — that must still be
 * reached by actually jumping, same as any other elevated surface. This is
 * also what guarantees a platform spawning exactly under/at a standing
 * player is harmless: it can only become their ground if its top is
 * essentially where their feet already are. */
export const PLATFORM_ONE_WAY_TOLERANCE_PX = 6;

/** Forgiving horizontal inset added to a platform's landing X-span before
 * testing whether the player's column overlaps it — same "players hate
 * pixel-perfect collision" reasoning as PLAYER_COLLISION_INSET_X. */
export const PLATFORM_LANDING_MARGIN_PX = 10;

/** Flat, modest score bonus awarded once per landing on a real vehicle
 * (checked via Player.justLanded — covers both an ordinary landing and a
 * slam-landing onto one). Deliberately a flat one-time award rather than a
 * per-second rate, so riding a platform can't be passively farmed for score
 * — same "reward the event, not the dwell time" choice as
 * DASH_THROUGH_BONUS_SCORE. */
export const PLATFORM_LANDING_SCORE_BONUS = 20;

/* --- Platform visuals — legible over arbitrary camera video, reusing the */
/* ground line's "bright core + soft glow" language so a platform reads as */
/* "the same kind of thing as the ground" at a glance. */

/** Low-alpha fill so the camera feed (the real vehicle) stays visible
 * through the platform's body — this is an outline drawn over reality, not
 * an opaque shape replacing it. Reuses the cyan already used for the dash
 * indicator/power-up pickup, consistent with this palette's existing
 * "cyan = helpful/interactive" association. */
export const PLATFORM_FILL_COLOR = 0x5be8ff;
export const PLATFORM_FILL_ALPHA = 0.14;
export const PLATFORM_OUTLINE_COLOR = 0x0c3542;
export const PLATFORM_OUTLINE_ALPHA = 0.9;
export const PLATFORM_OUTLINE_WIDTH = 2;
/** The actual landing-surface indicator: a bright bar along the top edge,
 * mirroring GROUND_LINE_COLOR/GROUND_LINE_GLOW_THICKNESS's core+glow pair. */
export const PLATFORM_TOP_BAR_COLOR = 0x5be8ff;
export const PLATFORM_TOP_BAR_THICKNESS = 3;
export const PLATFORM_TOP_BAR_GLOW_THICKNESS = 14;
export const PLATFORM_TOP_BAR_ALPHA = 0.85;
export const PLATFORM_TOP_BAR_GLOW_ALPHA = 0.22;
/** How far the top bar extends past the box's own left/right edges — pure
 * legibility, same idea as GROUND_LINE_OVERDRAW_PX in Game.ts. */
export const PLATFORM_TOP_BAR_OVERHANG_PX = 6;

/* ------------------------------------------------------------------ */
/* Crossing mode — src/game/systems/CrossingSystem.ts and the           */
/* crossing-only methods on src/game/entities/Player.ts.                */
/*                                                                       */
/* A different game sharing this engine (see GameMode in types.ts):     */
/* nothing scrolls; the player crosses the STATIC camera frame left to  */
/* right, then right to left, endlessly, by walking and aim-jumping     */
/* across real tracked vehicles turned into platforms. 'runner' mode    */
/* never reads anything below this point, and nothing above this point */
/* is read by crossing mode — the two games are tuned independently.    */
/* ------------------------------------------------------------------ */

/* --- Start/goal anchor blocks — fixed, always present regardless of
 * detection. Both position AND size are stored as fractions of the canvas
 * (the same convention TrackedObject/Platform already use) so they survive
 * resize/orientation-change with no extra bookkeeping. */
export const CROSSING_BLOCK_WIDTH_FRACTION = 0.1;
export const CROSSING_BLOCK_HEIGHT_FRACTION = 0.055;
/** Vertical center of both blocks — "a sensible height in the road area",
 * deliberately close to where the runner's own ground line defaults to
 * (GROUND_Y_DEFAULT_FRACTION) so the two modes feel like the same world. */
export const CROSSING_BLOCK_CENTER_Y_FRACTION = 0.62;
export const CROSSING_LEFT_BLOCK_CENTER_X_FRACTION = 0.07;
export const CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION = 0.93;
/** Palettes (see Platform.setPalette) applied to whichever block is
 * currently the player's start vs. their goal — swapped, not redrawn, when
 * a crossing completes (see CrossingSystem.completeCrossing). Distinct hue
 * FAMILIES (green vs. gold), not just different shades, so they read apart
 * at a glance even on a small phone screen. */
export const CROSSING_BLOCK_START_FILL = 0x2ecc71;
export const CROSSING_BLOCK_START_TOP_BAR = 0x8fffb0;
export const CROSSING_BLOCK_GOAL_FILL = 0xffb020;
export const CROSSING_BLOCK_GOAL_TOP_BAR = 0xffd23f;

/* --- Player walk/jump kinematics ---------------------------------- */

/** px/s lateral speed while grounded and holding a walk input. */
export const CROSSING_WALK_SPEED = 210;
/** Fraction of canvasWidth a single FULL-POWER jump can cover on level
 * ground. `crossingMaxJumpSpeed` in util/solvability.ts inverts the classic
 * projectile range formula (range = v^2/g) to derive the launch-speed cap
 * from this fraction, so "a single jump can't cross the whole screen" stays
 * true on every device/orientation instead of baking in a fixed px number
 * that would be trivial on a phone and impossible on a tablet. */
export const CROSSING_MAX_JUMP_HORIZONTAL_FRACTION = 0.4;
/** Minimum fraction of a jump's launch speed that must point upward,
 * regardless of how flat/downward the raw drag or keyboard aim was.
 * Guarantees every jump has real liftoff (feet visibly leave the surface
 * before falling again), which is also what keeps the landing-assist magnet
 * (CROSSING_LANDING_ASSIST_*) from being able to immediately re-catch the
 * platform a jump just launched from — see CrossingSystem's landing-assist
 * doc for the full argument. */
export const CROSSING_MIN_JUMP_VERTICAL_FRACTION = 0.18;
/** Grace window after walking off a platform's edge during which a jump
 * still fires — deliberately more generous than the runner's
 * COYOTE_TIME_SECONDS: an aim-and-release gesture takes longer to execute
 * than a tap, so the window it can still land in must be longer too. */
export const CROSSING_COYOTE_TIME_SECONDS = 0.2;
/** Grace window a completed aim-and-release is remembered before landing,
 * so a jump released a moment before touchdown still fires the instant the
 * player is grounded/within coyote time, rather than being silently eaten. */
export const CROSSING_JUMP_BUFFER_SECONDS = 0.2;

/* --- Aim gesture (touch) -------------------------------------------- */

/** Past this drag distance (px) a pointer gesture commits to AIMING instead
 * of walking — short of this it reads as "hold to walk". Same
 * threshold-then-commit shape InputSystem already uses for runner gestures,
 * see that file's doc for the crossing-mode gesture set in full. */
export const CROSSING_AIM_DEADZONE_PX = 14;
/** Drag distance (px) that reads as FULL power (100%); clamped above this so
 * dragging off-canvas doesn't over-charge the jump. */
export const CROSSING_AIM_MAX_DRAG_PX = 160;

/* --- Aim gesture (keyboard) ------------------------------------------ */

/** Seconds of holding Space to reach full power. */
export const CROSSING_KEYBOARD_CHARGE_SECONDS = 1.1;

/* --- Landing assist — deliberately generous. The tracker reports at 6Hz
 * with interpolation (~150ms of real lag is normal), and real vehicles
 * drift unpredictably between samples, so aiming at a moving target with no
 * help would be genuinely unfair, not just hard. If a descending trajectory
 * passes within this box of a platform's top edge, CrossingSystem snaps the
 * player onto it outright (see resolveCrossingSurface in Game.ts). */
export const CROSSING_LANDING_ASSIST_VERTICAL_PX = 46;
export const CROSSING_LANDING_ASSIST_HORIZONTAL_PX = 34;

/* --- Trajectory preview arc — dotted, pooled, cheap to draw ---------- */

export const CROSSING_PREVIEW_DOT_COUNT = 14;
export const CROSSING_PREVIEW_DOT_RADIUS = 3;
export const CROSSING_PREVIEW_DOT_COLOR = 0xffffff;
export const CROSSING_PREVIEW_DOT_ALPHA = 0.75;
/** Seconds of flight the preview samples across, evenly spaced across the
 * dot count — independent of the actual jump's own flight time so the dots
 * always read as one smooth, evenly-spaced arc regardless of power. Dots
 * past the point the arc leaves the canvas are simply hidden. */
export const CROSSING_PREVIEW_DURATION_SECONDS = 1.4;

/* --- Ghost platform fallback — the crossing-mode equivalent of the
 * runner's derived obstacle spacing (util/solvability.ts): if real tracking
 * goes quiet, the level must still be solvable. See
 * CrossingSystem.maybeSpawnGhostChain's doc for the full derivation. */

/** Seconds with no STABLE tracked object update at all before the fallback
 * engages — "a few seconds", per the brief. */
export const CROSSING_GHOST_TRIGGER_SECONDS = 3.5;
/** Fraction of the full-power max reach actually budgeted between two
 * consecutive ghost platforms — leaves margin the same way GAP_SAFETY_FACTOR
 * does for the runner, so a hop timed slightly early or late still lands. */
export const CROSSING_GHOST_GAP_SAFETY_FACTOR = 0.62;
/** Hard cap on simultaneous ghost platforms. The chain spawned by
 * maybeSpawnGhostChain is sized to the live canvas width but never asked to
 * exceed this pool — see that method's doc for why it never needs to. */
export const CROSSING_GHOST_POOL_SIZE = 6;
export const CROSSING_GHOST_WIDTH_FRACTION = 0.1;
export const CROSSING_GHOST_HEIGHT_FRACTION = 0.05;
/** Gentle side-to-side drift so a ghost platform reads as "moving like
 * traffic" rather than static geometry. Small relative to
 * CROSSING_GHOST_GAP_SAFETY_FACTOR's own margin so it can never itself
 * widen a gap past what a full-power jump can cover. */
export const CROSSING_GHOST_DRIFT_RANGE_PX = 16;
export const CROSSING_GHOST_DRIFT_SPEED_RADIANS_PER_SECOND = 0.9;
/** Palette (see Platform.setPalette) that gives ghost platforms a distinct
 * violet hue from real tracked ones (PLATFORM_FILL_COLOR's cyan) — the
 * player must always be able to tell what's real. Reuses the runner's own
 * "wide obstacle" violet (OBSTACLE_COLOR_WIDE) for palette consistency
 * across modes rather than inventing an unrelated purple. */
export const CROSSING_GHOST_FILL = 0x9b6bff;
export const CROSSING_GHOST_TOP_BAR = 0xc9adff;

/* --- Edge-carry loss telegraph — a platform (real or ghost) drifting the
 * standing player horizontally off the visible frame is a legitimate loss,
 * but must be visibly telegraphed first — see updateCrossing in Game.ts. */
export const CROSSING_EDGE_MARGIN_PX = 40;
export const CROSSING_EDGE_WARNING_SECONDS = 1.1;
/** Tint the player's body flashes toward while the edge-carry warning is
 * counting down — 0 (start of warning) is untinted (0xffffff = no-op tint). */
export const CROSSING_EDGE_WARNING_TINT = 0xff4a4a;

/* --- Fall-below-frame loss -------------------------------------------- */

/** Player's top must fall this far past canvasHeight before the run ends —
 * a small buffer so the character is clearly, unambiguously gone (matches
 * the spirit of every other *_DESPAWN_MARGIN in this file) rather than
 * ending the instant a single pixel crosses the edge. */
export const CROSSING_FALL_MARGIN_PX = 60;

/* --- Scoring ------------------------------------------------------------ */

export const CROSSING_SCORE_PER_SECOND = 4;
export const CROSSING_SCORE_PER_PIXEL_PROGRESS = 0.05;
export const CROSSING_SCORE_BONUS_PER_CROSSING = 150;

/* ------------------------------------------------------------------ */
/* Debug overlay                                                       */
/* ------------------------------------------------------------------ */

export const DEBUG_TEXT_UPDATE_INTERVAL_SECONDS = 0.25;
export const DEBUG_TEXT_COLOR = 0x00ff66;
export const DEBUG_TEXT_SIZE = 12;
