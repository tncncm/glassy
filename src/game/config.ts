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

export const PLAYER_X_FRACTION = 0.24;
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

/** How far beyond the right edge obstacles spawn, and how far beyond the
 * left edge they're recycled — both in px, both comfortably off-screen. */
export const OBSTACLE_SPAWN_MARGIN = 30;
export const OBSTACLE_DESPAWN_MARGIN = 80;

/** Initial empty run before the first obstacle, in px, so the player always
 * gets a moment to get their bearings after Play. */
export const OBSTACLE_INITIAL_SPAWN_DISTANCE = 520;

export const OBSTACLE_COLOR_BLOCK = 0x36e5c8;
export const OBSTACLE_COLOR_SPIKE = 0xff5470;
export const OBSTACLE_COLOR_OUTLINE = 0x08251f;
export const OBSTACLE_CORNER_RADIUS = 6;

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
 * platform" and can no longer resolve as a tap-jump. */
export const DRAG_THRESHOLD_PX = 16;
export const KEYBOARD_GROUND_STEP_PX = 28;

/* ------------------------------------------------------------------ */
/* Debug overlay                                                       */
/* ------------------------------------------------------------------ */

export const DEBUG_TEXT_UPDATE_INTERVAL_SECONDS = 0.25;
export const DEBUG_TEXT_COLOR = 0x00ff66;
export const DEBUG_TEXT_SIZE = 12;
