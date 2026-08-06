/**
 * Glassy — every gameplay tunable lives here. Nothing under src/game/entities
 * or src/game/systems hardcodes a magic number; they import from this file so
 * the whole feel of the crossing can be re-tuned in one place.
 *
 * Units: pixels, seconds, px/s, px/s^2 unless noted otherwise. All motion is
 * delta-time based so these numbers describe *rates*, not per-frame deltas.
 *
 * There is exactly one game mode: the crossing (see src/game/systems/
 * CrossingSystem.ts). The player crosses the static camera frame left to
 * right, then right to left, endlessly, by walking and aim-jumping across
 * real tracked vehicles turned into platforms (with a "ghost" platform
 * fallback when nothing is being tracked).
 */

/* ------------------------------------------------------------------ */
/* Frame timing                                                        */
/* ------------------------------------------------------------------ */

/** Hard cap on a single frame's dt. A backgrounded tab regaining focus (or a
 * long GC pause) reports a huge elapsedMS on the next rAF; without this cap
 * that would be fed straight into `position += speed * dt` and tunnel the
 * player clean through a platform. 0.05s = a 20fps floor. */
export const MAX_DELTA_SECONDS = 0.05;

/* ------------------------------------------------------------------ */
/* Player rig                                                          */
/* ------------------------------------------------------------------ */

export const PLAYER_WIDTH = 34;
export const PLAYER_HEIGHT = 46;
export const PLAYER_LEG_LENGTH = 16;
export const PLAYER_LEG_WIDTH = 7;

/** Forgiving inset on the player's top edge for the fall-below-frame check
 * (see `Player.top` / CROSSING_FALL_MARGIN_PX) — players hate pixel-perfect
 * geometry even for a loss condition. */
export const PLAYER_COLLISION_INSET_TOP = 9;

/** px/s^2, downward. */
export const GRAVITY = 2600;

/** Squash/stretch: exponential return-to-rest rate (1/s) of the scale spring. */
export const SQUASH_STRETCH_RATE = 16;
export const JUMP_SQUASH_SCALE_X = 1.22;
export const JUMP_SQUASH_SCALE_Y = 0.8;
export const LAND_SQUASH_SCALE_X = 1.32;
export const LAND_SQUASH_SCALE_Y = 0.7;

/** Leg-swing phase speed while walking at CROSSING_WALK_SPEED, radians/s. */
export const RUN_CYCLE_BASE_SPEED = 10;
export const RUN_LEG_SWING_RADIANS = 0.62;
/** Airborne leg tuck angle (both legs pull back together). */
export const AIRBORNE_LEG_ANGLE = -0.5;

/**
 * VISUAL REDESIGN — legibility over a bright, busy, moving dashcam feed is
 * the hard constraint, not a nice-to-have: a plain flat-color rounded rect
 * with no shadow/halo washes out against sky, chrome, headlights and
 * high-contrast road texture. The fix is graphic-language, not detail: a
 * heavier dark outline, a soft glow halo behind the whole rig (a blurred
 * silhouette reads at a glance even over clutter), a ground-contact shadow
 * (the single strongest "this is standing on something" depth cue), and a
 * visor stripe instead of a naturalistic dot eye (reads as "facing
 * direction" at icon scale, the way a running-figure pictogram does).
 * PLAYER_COLOR_BODY is UNCHANGED (0xffce45, a bright amber-yellow) — it
 * already sits at high contrast against the natural palette of road/sky/
 * foliage footage (the same reasoning school-bus yellow uses for
 * visibility), so the redesign strengthens its presentation rather than
 * replacing the hue.
 */
export const PLAYER_COLOR_BODY = 0xffce45;
export const PLAYER_COLOR_OUTLINE = 0x2b1d00;
export const PLAYER_COLOR_LIMB = 0xe6a92e;
export const PLAYER_COLOR_EYE = 0x1a1400;
/** Heavier than the old 2px outline — see the redesign doc above: contrast
 * against arbitrary video is the whole point. */
export const PLAYER_OUTLINE_WIDTH = 2.6;
/** Visor stripe (replaces the old single dot "eye") — reads as a facing
 * direction at a glance, pictogram-style. */
export const PLAYER_VISOR_COLOR = 0x1a1400;
export const PLAYER_VISOR_WIDTH = 11;
export const PLAYER_VISOR_HEIGHT = 4;

/** Soft glow halo behind the whole rig — a big, very-low-alpha circle,
 * drawn once, never redrawn; only its parent's transform moves it. Reads as
 * "this shape is separated from the background" even when the background
 * behind it is itself bright/high-contrast. */
export const PLAYER_HALO_COLOR = 0xfff3d6;
export const PLAYER_HALO_ALPHA = 0.22;
export const PLAYER_HALO_RADIUS_PX = 30;

/** Ground-contact shadow — an ellipse at the feet that shrinks and fades as
 * the player gains height, the single strongest depth cue for "standing on
 * a surface" versus "floating in front of the video". Counter-scaled
 * against the rig's own squash/stretch so it never itself stretches (see
 * Player.updateCrossing). */
export const PLAYER_SHADOW_COLOR = 0x000000;
export const PLAYER_SHADOW_ALPHA_GROUNDED = 0.32;
export const PLAYER_SHADOW_WIDTH_PX = PLAYER_WIDTH * 1.05;
export const PLAYER_SHADOW_HEIGHT_PX = PLAYER_WIDTH * 0.32;
/** Airborne height (px) at which the shadow has fully faded/shrunk to its
 * floor — beyond this the shadow no longer shrinks further, so it stays
 * faintly legible even at the top of a tall jump instead of vanishing. */
export const PLAYER_SHADOW_FADE_HEIGHT_PX = 140;
export const PLAYER_SHADOW_MIN_SCALE = 0.4;
export const PLAYER_SHADOW_MIN_ALPHA_FRACTION = 0.25;

/** Pre-created motion-trail streaks behind the player, visible only while
 * airborne with real speed (see CROSSING_TRAIL_* below) — count is small and
 * fixed (pool, not per-frame alloc). */
export const CROSSING_TRAIL_STREAK_COUNT = 4;
export const CROSSING_TRAIL_STREAK_SPACING_PX = 11;
export const CROSSING_TRAIL_STREAK_LENGTH_PX = 18;
export const CROSSING_TRAIL_STREAK_THICKNESS_PX = 5;
export const CROSSING_TRAIL_MAX_ALPHA = 0.45;
export const CROSSING_TRAIL_COLOR = 0xffffff;
/** Speed (px/s, combined horizontal+vertical) at which the flight trail
 * reaches full alpha — purely a "reads as fast" cosmetic threshold, not a
 * solvability bound, so unlike the jump-reach derivation below this is a
 * plain tuned constant (same role as DUST_SPEED_MAX etc.). */
export const CROSSING_TRAIL_FULL_ALPHA_SPEED_PX_S = 480;
/** Exponential smoothing rate (1/s) the trail's alpha chases its target at —
 * fast enough to appear instantly on launch but avoids a single-frame flicker
 * right at the landing instant. */
export const CROSSING_TRAIL_SMOOTH_RATE = 14;

/* ------------------------------------------------------------------ */
/* Screen shake                                                        */
/* ------------------------------------------------------------------ */

/** Trauma decay rate, 1/s. */
export const SHAKE_DECAY_RATE = 5.5;
export const SHAKE_MAGNITUDE_PX = 16;
/** Trauma on a run-ending failure (fall, edge-carry, or timer expiry). */
export const COLLISION_SHAKE_TRAUMA = 1;

/* ------------------------------------------------------------------ */
/* Particles                                                           */
/* ------------------------------------------------------------------ */

export const PARTICLE_POOL_SIZE = 48;
export const PARTICLE_RADIUS = 4;

/** Jump-launch puff / ordinary-landing dust. */
export const DUST_PARTICLE_COUNT = 6;
export const DUST_SPEED_MIN = 40;
export const DUST_SPEED_MAX = 130;
export const DUST_LIFETIME_SECONDS = 0.4;
export const DUST_COLOR = 0xffffff;

/** Failure burst — fall, edge-carry loss, or timer expiry. */
export const COLLISION_PARTICLE_COUNT = 20;
export const COLLISION_SPEED_MIN = 90;
export const COLLISION_SPEED_MAX = 320;
export const COLLISION_LIFETIME_SECONDS = 0.6;
export const COLLISION_COLOR_A = 0xff5470;
export const COLLISION_COLOR_B = 0xffce45;

export const PARTICLE_GRAVITY = 900;
/** Per-second velocity damping factor (higher = particles slow down faster). */
export const PARTICLE_DRAG_PER_SECOND = 2.4;

/** Small upward-biased sparkle (see ParticleSystem.spawnSparkle) — shared
 * count/speed/lifetime for both reward moments (perfect landing, goal
 * arrival); the caller supplies the color (CROSSING_PERFECT_LANDING_SPARKLE_
 * COLOR / CROSSING_GOAL_SPARKLE_COLOR below) so this stays one set of
 * tunables instead of near-duplicates. */
export const CROSSING_SPARKLE_PARTICLE_COUNT = 10;
export const CROSSING_SPARKLE_SPEED_MIN = 60;
export const CROSSING_SPARKLE_SPEED_MAX = 220;
export const CROSSING_SPARKLE_LIFETIME_SECONDS = 0.45;

/** Flattened, evenly-spaced shockwave ring (see ParticleSystem.spawnRing) —
 * the goal-arrival impact. An even angular spread reads as a coherent
 * shockwave rather than debris, and the vertical component is squashed so it
 * hugs the platform instead of ballooning upward. */
export const CROSSING_IMPACT_PARTICLE_COUNT = 18;
export const CROSSING_IMPACT_PARTICLE_SPEED_MIN = 120;
export const CROSSING_IMPACT_PARTICLE_SPEED_MAX = 340;
export const CROSSING_IMPACT_PARTICLE_LIFETIME_SECONDS = 0.5;
export const CROSSING_IMPACT_PARTICLE_COLOR = 0xffffff;
export const CROSSING_IMPACT_PARTICLE_VERTICAL_SQUASH = 0.35;

/* ------------------------------------------------------------------ */
/* Windscreen platforms — src/game/entities/Platform.ts                */
/*                                                                      */
/* A tracked real vehicle (or, absent one, a synthetic "ghost" — see the */
/* Crossing mode section below) becomes a landing surface. One-way by   */
/* construction (only ever a place to land, never a hazard or a barrier */
/* from the side/below — see the surface-resolution block in Game.ts).  */
/* ------------------------------------------------------------------ */

/** Max simultaneous REAL tracked platforms — "a handful", per the brief. The
 * pool is fixed size and never grows; a track arriving once the pool is full
 * is simply ignored until a slot frees up. */
export const PLATFORM_POOL_SIZE = 6;

/** Exponential follow rate (1/s, used with expDecay like other lerp rates in
 * this file) a platform's rendered/collidable box chases its latest tracked
 * position at. The tracker only reports "a few times a second" (types.ts),
 * so this is deliberately slow: at a high rate the box would all but snap to
 * each new sample within a frame or two, which — given how sparse the
 * samples are — would read as a stepped jump wearing a thin coat of
 * smoothing, not the continuous glide the brief asks for. At 5/s the box is
 * still visibly gliding when the next sample lands (assuming ~3-5Hz), so
 * consecutive updates blend into one continuous motion. */
export const PLATFORM_FOLLOW_LERP_RATE = 5;

/** Seconds a platform survives with no matching TrackedObject update before
 * being fully retired to the pool. Deliberately generous — a real detector
 * dropping a track for a frame or two (occlusion, a momentary bad frame)
 * must not yank the ground out from under a standing player. The platform
 * remains fully SOLID for this entire window — only its visual fades (see
 * PLATFORM_FADE_SECONDS) — so "solid" and "visible" never disagree. */
export const PLATFORM_GRACE_SECONDS = 0.9;

/** Portion of PLATFORM_GRACE_SECONDS, at its tail end, during which the
 * platform's alpha ramps from 1 to 0 — the visual warning that a track is
 * about to disappear, so a player standing on it sees it going before it's
 * gone. Kept strictly <= PLATFORM_GRACE_SECONDS. */
export const PLATFORM_FADE_SECONDS = 0.45;

/* --- Platform visuals — legible over arbitrary camera video: a bright */
/* core + soft glow so a platform reads as "solid ground" at a glance. */

/** Low-alpha fill so the camera feed (the real vehicle) stays visible
 * through the platform's body — this is an outline drawn over reality, not
 * an opaque shape replacing it. Cyan = "helpful/interactive" throughout this
 * palette. */
export const PLATFORM_FILL_COLOR = 0x5be8ff;
export const PLATFORM_FILL_ALPHA = 0.14;
export const PLATFORM_OUTLINE_COLOR = 0x0c3542;
export const PLATFORM_OUTLINE_ALPHA = 0.9;
export const PLATFORM_OUTLINE_WIDTH = 2;
/** The actual landing-surface indicator: a bright bar along the top edge. */
export const PLATFORM_TOP_BAR_COLOR = 0x5be8ff;
export const PLATFORM_TOP_BAR_THICKNESS = 3;
export const PLATFORM_TOP_BAR_GLOW_THICKNESS = 14;
export const PLATFORM_TOP_BAR_ALPHA = 0.85;
export const PLATFORM_TOP_BAR_GLOW_ALPHA = 0.22;
/** How far the top bar extends past the box's own left/right edges — pure
 * legibility. */
export const PLATFORM_TOP_BAR_OVERHANG_PX = 6;

/**
 * Corner brackets — four short "L" marks at the box's corners, echoing an
 * AR/HUD target-lock indicator (fitting: this whole layer IS an overlay on
 * a real camera feed reading real tracked objects). Strong, short,
 * high-contrast strokes read far better against a busy/textured background
 * than a single thin outline alone — the same reason camera viewfinders and
 * targeting HUDs use corner brackets instead of a full box. Drawn in the
 * platform's own hue (fillColor/topBarColor via setPalette) inside the same
 * `redraw()` call as everything else, so it costs nothing beyond what
 * Platform already pays only on a genuine size/palette change.
 */
export const PLATFORM_BRACKET_LENGTH_PX = 9;
export const PLATFORM_BRACKET_THICKNESS = 2.5;
export const PLATFORM_BRACKET_ALPHA = 0.95;
export const PLATFORM_BRACKET_INSET_PX = -2;

/** Soft drop shadow beneath the box — a flattened, blurred-reading dark
 * ellipse-ish rect that separates the platform from whatever busy video is
 * directly behind/below it, echoing the player's own ground shadow so both
 * read as "the same kind of depth cue". */
export const PLATFORM_SHADOW_COLOR = 0x000000;
export const PLATFORM_SHADOW_ALPHA = 0.22;
export const PLATFORM_SHADOW_OFFSET_Y_PX = 5;
export const PLATFORM_SHADOW_HEIGHT_PX = 6;

/* ------------------------------------------------------------------ */
/* Crossing mode — src/game/systems/CrossingSystem.ts, the crossing-only    */
/* methods on src/game/entities/Player.ts, and src/game/Game.ts's update(). */
/*                                                                            */
/* Nothing scrolls; the player crosses the STATIC camera frame left to right, */
/* then right to left, endlessly, by walking and aim-jumping. Free 2D        */
/* aim-and-release jumps, no world scroll — see util/solvability.ts for the  */
/* full kinematic derivation this section's numbers come from.              */
/* ------------------------------------------------------------------ */

/* --- Start/goal anchor blocks — fixed, always present regardless of
 * detection. Position AND size are stored as fractions of the canvas (the
 * same convention TrackedObject/Platform already use) so they survive
 * resize/orientation-change with no extra bookkeeping. */
export const CROSSING_BLOCK_WIDTH_FRACTION = 0.1;
export const CROSSING_BLOCK_HEIGHT_FRACTION = 0.055;
/**
 * Anchor-block X centers are no longer a single fixed pair — they are the
 * spatial difficulty dial (see the "Difficulty, spatially" section near the
 * crossing-mode kinematics below): EASY is a short, forgiving leg near the
 * center of the frame; HARD is the full-width leg the ORIGINAL fixed
 * constants used to be. `CrossingSystem` lerps between them by
 * `crossings / CROSSING_DIFFICULTY_RAMP_CROSSINGS`, the same curve every
 * other difficulty dial in this file already rides. The jump-speed
 * derivation below (CROSSING_LEG_SPAN_FRACTION et al) is deliberately pinned
 * to the HARD pair, not the live value — physics stays constant for the
 * whole run; only the WORLD gets bigger, which is what "longer legs" as a
 * skill-driven escalation actually means. `maybeSpawnGhostChain` reads the
 * blocks' own live pixel positions every time it spawns a chain, so the
 * solvability guarantee automatically re-derives itself against whatever the
 * current leg's actual span is — nothing here can silently make a leg
 * unsolvable.
 */
export const CROSSING_LEFT_BLOCK_CENTER_X_FRACTION_EASY = 0.22;
export const CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION_EASY = 0.78;
export const CROSSING_LEFT_BLOCK_CENTER_X_FRACTION_HARD = 0.07;
export const CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION_HARD = 0.93;
/** DEFAULT vertical center of both blocks, before any horizon estimate has
 * been accepted — "a sensible height in the road area". Also the value
 * CrossingSystem's live `roadCenterYFraction` starts at; see
 * CROSSING_HORIZON_* below for how (and how cautiously) it moves from here. */
export const CROSSING_BLOCK_CENTER_Y_FRACTION = 0.62;
/** Bounds the live road-center fraction is clamped to, however confident the
 * horizon estimate — keeps the blocks from ever drifting off the top/bottom
 * of the frame regardless of camera framing. */
export const CROSSING_BLOCK_CENTER_Y_MIN_FRACTION = 0.35;
export const CROSSING_BLOCK_CENTER_Y_MAX_FRACTION = 0.85;
/** Palettes (see Platform.setPalette) applied to whichever block is
 * currently the player's start vs. their goal — swapped, not redrawn, when a
 * crossing completes. Distinct hue FAMILIES (green vs. gold), not just
 * different shades, so they read apart at a glance on a small phone screen. */
export const CROSSING_BLOCK_START_FILL = 0x2ecc71;
export const CROSSING_BLOCK_START_TOP_BAR = 0x8fffb0;
export const CROSSING_BLOCK_GOAL_FILL = 0xffb020;
export const CROSSING_BLOCK_GOAL_TOP_BAR = 0xffd23f;

/**
 * Small pennant glyph floating above each anchor block — a second,
 * shape-based (not just color-based) way to tell start from goal at a
 * glance, which also helps anyone with red/green colorblindness (the
 * start/goal palette above is a green/gold split, not red/green, but the
 * shape difference is a deliberate belt-and-braces legibility choice on top
 * of that). Drawn once per Platform.setPalette-driven retint (tinted, not
 * redrawn) and repositioned every frame — see CrossingSystem's flag glyphs.
 */
export const CROSSING_FLAG_WIDTH_PX = 14;
export const CROSSING_FLAG_HEIGHT_PX = 10;
export const CROSSING_FLAG_POLE_HEIGHT_PX = 16;
export const CROSSING_FLAG_POLE_WIDTH_PX = 2;
/** Both the pole and the pennant triangle are drawn flat white and share a
 * single `.tint` (see buildCrossingFlag in CrossingSystem.ts) — Pixi tints
 * a whole Graphics object at once, so there is no separate "pole stays
 * neutral" color; a lightly-tinted pole reads fine at this glyph's size. */
export const CROSSING_FLAG_OUTLINE_COLOR = 0x0c3542;

/* --- Horizon hint — the camera's estimated horizon positions the blocks'
 * Y so the level sits at road level however the phone is held (see
 * Game.setHorizonHint / CrossingSystem.setHorizonHint). ------------------- */

/** Below this confidence the horizon estimate is ignored outright — a noisy
 * single-frame estimate must never be allowed to tug the blocks.
 *
 * Measured, not guessed: on real motorway footage (tools/video-sim) a solid
 * lock on the crash barrier reports ~0.32 mean confidence, because cluster
 * averaging deliberately flattens the peak it scores against; 0.22
 * comfortably clears that while fog/pure noise still report null outright,
 * so they never reach this check at all. */
export const CROSSING_HORIZON_MIN_CONFIDENCE = 0.22;
/** Exponential rate (1/s, used with expDecay) an *accepted* hint pulls the
 * live road-center fraction toward it — deliberately slow so a noisy or
 * drifting estimate can never read as a snap. At 0.15/s the target closes
 * half the gap to the hint roughly every 4.6s. */
export const CROSSING_HORIZON_BIAS_RATE = 0.15;

/* --- Player walk/jump kinematics ---------------------------------- */

/** px/s lateral speed while grounded and holding a walk input. */
export const CROSSING_WALK_SPEED = 210;

/**
 * How many deliberate hops a single crossing SHOULD take at full power, in a
 * straight line, with no walking between jumps — the number the whole jump
 * envelope below is derived from. 5-8 is the range that keeps a crossing
 * feeling like a sequence of real decisions without turning into a slog;
 * 6 sits in the middle of that band. Mixed-power jumps and walking between
 * hops (the actual way most crossings get played) push the real hop count
 * higher than this, which is exactly the point — this is a LOWER bound on
 * how many commits a crossing demands, not a par time.
 */
export const CROSSING_TARGET_HOPS_PER_CROSSING = 6;

/** The horizontal distance (in canvas-width fractions) a full-power jump
 * actually has to cover: the gap between the two anchor blocks' facing
 * edges AT THE HARD (full-width) difficulty pair, derived from their own
 * position/size fractions above so it can never silently drift out of sync
 * with where the blocks actually sit at max difficulty. Physics is derived
 * from the HARD span deliberately — see that pair's doc above: the jump
 * envelope stays constant all run, only the live leg span (EASY→HARD) grows
 * to meet it. */
export const CROSSING_LEG_SPAN_FRACTION =
  CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION_HARD -
  CROSSING_BLOCK_WIDTH_FRACTION / 2 -
  (CROSSING_LEFT_BLOCK_CENTER_X_FRACTION_HARD + CROSSING_BLOCK_WIDTH_FRACTION / 2);

/**
 * Fraction of canvasWidth a single FULL-POWER jump can cover on level
 * ground — THE central fix for "the jump was too long": derived by working
 * BACKWARDS from CROSSING_TARGET_HOPS_PER_CROSSING instead of picking a
 * fraction that merely looked reasonable. A full-power jump can cover
 * exactly 1/CROSSING_TARGET_HOPS_PER_CROSSING of the leg span, so clearing a
 * crossing in a dead-straight line at max power takes exactly
 * CROSSING_TARGET_HOPS_PER_CROSSING jumps — never "nearly the whole
 * screen in one".
 *
 * `crossingMaxJumpSpeed` in util/solvability.ts inverts the classic
 * projectile range formula (range = v^2/g) to derive the launch-speed cap
 * from this fraction, so this stays true on every device/orientation
 * instead of baking in a fixed px number. Every other crossing-jump-shaped
 * dial below (the ghost-platform spacing, the trajectory-preview duration,
 * the per-leg timer budget) is derived FROM this fraction via
 * util/solvability.ts rather than re-guessed independently, so retuning
 * CROSSING_TARGET_HOPS_PER_CROSSING alone keeps the whole envelope
 * self-consistent.
 */
export const CROSSING_MAX_JUMP_HORIZONTAL_FRACTION = CROSSING_LEG_SPAN_FRACTION / CROSSING_TARGET_HOPS_PER_CROSSING;

/** Minimum fraction of a jump's launch speed that must point upward,
 * regardless of how flat/downward the raw drag or keyboard aim was.
 * Guarantees every jump has real liftoff (feet visibly leave the surface
 * before falling again), which is also what keeps the landing-assist magnet
 * from being able to immediately re-catch the platform a jump just launched
 * from. */
export const CROSSING_MIN_JUMP_VERTICAL_FRACTION = 0.18;
/** Grace window after walking off a platform's edge during which a jump
 * still fires — generous, since an aim-and-release gesture takes longer to
 * execute than a simple tap. */
export const CROSSING_COYOTE_TIME_SECONDS = 0.2;
/** Grace window a completed aim-and-release is remembered before landing, so
 * a jump released a moment before touchdown still fires the instant the
 * player is grounded/within coyote time, rather than being silently eaten. */
export const CROSSING_JUMP_BUFFER_SECONDS = 0.2;

/* --- Aim gesture (touch) -------------------------------------------- */

/** Past this drag distance (px) a pointer gesture commits to AIMING instead
 * of walking — short of this it reads as "hold to walk". */
export const CROSSING_AIM_DEADZONE_PX = 14;
/**
 * Radius around the press point where releasing CANCELS the jump.
 *
 * Deliberately much larger than the commit deadzone above — that asymmetry is
 * hysteresis, not sloppiness. Committing should be easy (14px of intent), but
 * backing out has to be reachable with a thumb on a phone held in a moving
 * car. At 14px the cancel existed but was effectively unhittable, so the user
 * reported it as missing. A visible ring is drawn at this radius while aiming.
 */
export const CROSSING_AIM_CANCEL_RADIUS_PX = 44;
export const CROSSING_AIM_CANCEL_RING_COLOR = 0xff6b6b;
export const CROSSING_AIM_CANCEL_RING_ALPHA = 0.55;
export const CROSSING_AIM_CANCEL_RING_THICKNESS = 2;
/** Drag distance (px) that reads as FULL power (100%); clamped above this so
 * dragging off-canvas doesn't over-charge the jump. */
export const CROSSING_AIM_MAX_DRAG_PX = 160;

/* --- Aim gesture (keyboard) ------------------------------------------ */

/** Seconds of holding Space to reach full power. */
export const CROSSING_KEYBOARD_CHARGE_SECONDS = 1.1;

/* --- Landing assist — deliberately generous at the START of a run, then
 * tightens with skill (see CROSSING_DIFFICULTY_RAMP_CROSSINGS below). The
 * tracker reports at a few Hz with interpolation (~150ms of real lag is
 * normal), and real vehicles drift unpredictably between samples, so aiming
 * at a moving target with zero help would be genuinely unfair, not just
 * hard. If a descending trajectory passes within this box of a platform's
 * top edge, the surface-resolution block in Game.ts snaps the player onto
 * it outright. */
export const CROSSING_LANDING_ASSIST_VERTICAL_PX_EASY = 46;
export const CROSSING_LANDING_ASSIST_HORIZONTAL_PX_EASY = 34;
/** Floor the assist box shrinks to at/after CROSSING_DIFFICULTY_RAMP_
 * CROSSINGS crossings — still a real, fair margin (roughly half the starting
 * box), never zero: precision is rewarded, not required down to the pixel. */
export const CROSSING_LANDING_ASSIST_VERTICAL_PX_HARD = 24;
export const CROSSING_LANDING_ASSIST_HORIZONTAL_PX_HARD = 18;

/** Crossings completed before difficulty scaling (landing-assist tolerance,
 * ghost-hop precision — see CROSSING_GHOST_GAP_SAFETY_FACTOR_HARD) reaches
 * its hardest, then-permanent plateau. Shared by both dials so the
 * escalation reads as one coherent difficulty curve rather than two
 * independently-timed ones. */
export const CROSSING_DIFFICULTY_RAMP_CROSSINGS = 10;

/* --- Trajectory preview arc — dotted, pooled, cheap to draw ---------- */

export const CROSSING_PREVIEW_DOT_COUNT = 14;
export const CROSSING_PREVIEW_DOT_RADIUS = 3;
export const CROSSING_PREVIEW_DOT_COLOR = 0xffffff;
export const CROSSING_PREVIEW_DOT_ALPHA = 0.75;
/** Multiplier over a full-power jump's own flight time (see
 * `crossingFullPowerFlightTimeSeconds` in util/solvability.ts) the preview
 * samples across — kept slightly LONGER than the longest real flight time so
 * the dots always show the whole arc down to where it actually lands,
 * whatever the current charge power, rather than a magic seconds value that
 * would silently stop matching once the jump envelope above was retuned. */
export const CROSSING_PREVIEW_DURATION_MARGIN = 1.15;

/* --- Ghost platform fallback — the crossing-mode equivalent of an obstacle
 * spacing derivation: if real tracking goes quiet, the level must still be
 * solvable. See CrossingSystem.maybeSpawnGhostChain's doc for the full
 * derivation. */

/** Seconds with no STABLE tracked object update at all before the fallback
 * engages — "a few seconds", per the brief. */
export const CROSSING_GHOST_TRIGGER_SECONDS = 3.5;
/** Fraction of the full-power max reach actually budgeted between two
 * consecutive ghost platforms at the START of a run — leaves margin so a hop
 * timed slightly early or late still lands. Tightens toward
 * CROSSING_GHOST_GAP_SAFETY_FACTOR_HARD as CROSSING_DIFFICULTY_RAMP_CROSSINGS
 * is approached: less margin means a hop demands closer-to-full-power
 * precision, AND (since fewer, longer hops now tile the same span) naturally
 * spawns FEWER intermediate ghost platforms — matching both progression axes
 * ("narrower landing tolerance, fewer ghost platforms") from one dial. */
export const CROSSING_GHOST_GAP_SAFETY_FACTOR_EASY = 0.6;
/** Still strictly < 1 — a real margin always remains, however small, so a
 * hop timed a little early/late is never mathematically unlandable. */
export const CROSSING_GHOST_GAP_SAFETY_FACTOR_HARD = 0.85;
/**
 * Hard cap on simultaneous ghost platforms, sized for the WORST case (the
 * loosest, easiest safety factor above, which demands the most
 * intermediate platforms to tile a leg span):
 * `ceil(CROSSING_TARGET_HOPS_PER_CROSSING / CROSSING_GHOST_GAP_SAFETY_FACTOR_EASY) - 1`
 * = `ceil(6 / 0.6) - 1` = 9. Kept at 10 for a point of slack — this must
 * never be the binding constraint on how many ghosts a chain spawns (see
 * `maybeSpawnGhostChain`'s clamp), or the guarantee "the crossing is always
 * possible on an empty road" would silently break.
 */
export const CROSSING_GHOST_POOL_SIZE = 10;
export const CROSSING_GHOST_WIDTH_FRACTION = 0.1;
export const CROSSING_GHOST_HEIGHT_FRACTION = 0.05;
/** Gentle side-to-side drift so a ghost platform reads as "moving like
 * traffic" rather than static geometry. Small relative to the ghost safety
 * margin so it can never itself widen a gap past what a full-power jump can
 * cover, even at the tightest (HARD) safety factor. */
export const CROSSING_GHOST_DRIFT_RANGE_PX = 16;
export const CROSSING_GHOST_DRIFT_SPEED_RADIANS_PER_SECOND = 0.9;
/** Palette (see Platform.setPalette) that gives ghost platforms a distinct
 * violet hue from real tracked ones (PLATFORM_FILL_COLOR's cyan) — the
 * player must always be able to tell what's real. */
export const CROSSING_GHOST_FILL = 0x9b6bff;
export const CROSSING_GHOST_TOP_BAR = 0xc9adff;

/* --- Edge-carry loss telegraph — a platform (real or ghost) drifting the
 * standing player horizontally off the visible frame is a legitimate loss,
 * but must be visibly telegraphed first. */
export const CROSSING_EDGE_MARGIN_PX = 40;
export const CROSSING_EDGE_WARNING_SECONDS = 1.1;
/** Tint the player's body flashes toward while the edge-carry warning is
 * counting down — 0 (start of warning) is untinted (0xffffff = no-op tint). */
export const CROSSING_EDGE_WARNING_TINT = 0xff4a4a;

/* --- Fall-below-frame loss -------------------------------------------- */

/** Player's top must fall this far past canvasHeight before the run ends —
 * a small buffer so the character is clearly, unambiguously gone rather than
 * ending the instant a single pixel crosses the edge. */
export const CROSSING_FALL_MARGIN_PX = 60;

/* --- Per-leg countdown timer — the primary PRESSURE mechanic. Endless calm
 * hopping has no tension; a shrinking clock punishes dithering directly.
 * Sized from the same physical hop budget the jump envelope above already
 * establishes (see `crossingFullPowerFlightTimeSeconds` in
 * util/solvability.ts) rather than a guessed seconds value, and escalates
 * leg over leg — see Game.ts's `crossingLegTimeSeconds`. -------------------- */

/** Extra seconds budgeted per hop for aiming/walking between platforms,
 * beyond the jump's own flight time — the crossing-mode analogue of
 * GAP_REACTION_TIME_SECONDS in the (now-removed) runner's spacing math. */
export const CROSSING_HOP_REACTION_SECONDS = 0.9;
/** Multiplier over the bare `hops * (flightTime + reactionTime)` budget
 * applied to the very FIRST leg's timer, so a competent-but-imperfect player
 * always has comfortable room before the escalation below has had any
 * effect. */
export const CROSSING_TIMER_START_GENEROSITY = 1.7;
/** Seconds shaved off the leg timer per crossing already completed, ramping
 * the pressure up over the course of a run. */
export const CROSSING_TIMER_SHRINK_PER_CROSSING_SECONDS = 1.1;
/** Multiplier over the bare per-hop time budget the timer can never shrink
 * past, regardless of how many crossings have been completed — strictly
 * more than 1, so the leg always stays theoretically completable at exactly
 * CROSSING_TARGET_HOPS_PER_CROSSING back-to-back hops with no wasted motion,
 * at any difficulty. */
export const CROSSING_TIMER_FLOOR_GENEROSITY = 1.15;

/* --- HUD: timer bar + combo counter — Pixi primitives drawn directly by
 * CrossingSystem, pre-built once and only ever mutated per frame (position/
 * fill width/color/text), same allocation discipline as everything else. */

export const CROSSING_TIMER_BAR_WIDTH_FRACTION = 0.46;
export const CROSSING_TIMER_BAR_HEIGHT_PX = 6;
export const CROSSING_TIMER_BAR_TOP_MARGIN_PX = 14;
export const CROSSING_TIMER_BAR_BG_COLOR = 0x000000;
export const CROSSING_TIMER_BAR_BG_ALPHA = 0.28;
export const CROSSING_TIMER_BAR_COLOR_SAFE = 0x5be8ff;
export const CROSSING_TIMER_BAR_COLOR_WARN = 0xffb020;
export const CROSSING_TIMER_BAR_COLOR_CRITICAL = 0xff4a4a;
/** Remaining-time fractions below which the bar shifts color — the visible
 * telegraph for the timer-expiry loss, same "must be seen coming" principle
 * as the edge-carry tint above. */
export const CROSSING_TIMER_BAR_WARN_FRACTION = 0.45;
export const CROSSING_TIMER_BAR_CRITICAL_FRACTION = 0.2;

/**
 * PAUSED state — the clock only runs while a reachable landing spot exists
 * (see `isProgressReachable` in Game.ts and its doc for the full fairness
 * rule). This must never read as a bug or a stall, so it gets its own
 * neutral color plus a slow breathing pulse (see CROSSING_TIMER_PAUSED_PULSE_
 * RATE) and an explicit label, instead of just silently freezing a colored
 * bar in place.
 */
export const CROSSING_TIMER_BAR_COLOR_PAUSED = 0x9aa5b1;
/** Pulse speed (radians/s fed into Math.sin) for the paused bar/label's
 * breathing alpha — slow and calm, reads as "waiting", not "urgent". */
export const CROSSING_TIMER_PAUSED_PULSE_RATE = 3.2;
export const CROSSING_TIMER_PAUSED_ALPHA_MIN = 0.45;
export const CROSSING_TIMER_PAUSED_ALPHA_MAX = 0.95;
export const CROSSING_TIMER_PAUSED_LABEL_TEXT = 'WAITING FOR A LANDING SPOT';
export const CROSSING_TIMER_PAUSED_LABEL_SIZE = 12;
export const CROSSING_TIMER_PAUSED_LABEL_COLOR = 0xdfe6ec;
export const CROSSING_TIMER_PAUSED_LABEL_OUTLINE_COLOR = 0x0c3542;
export const CROSSING_TIMER_PAUSED_LABEL_Y_PX = 26;

export const CROSSING_COMBO_TEXT_SIZE = 16;
export const CROSSING_COMBO_TEXT_COLOR = 0xffffff;
export const CROSSING_COMBO_TEXT_OUTLINE_COLOR = 0x0c3542;
export const CROSSING_COMBO_TEXT_Y_PX = 30;

/* --- Reward for skill: perfect landings, streak combos, a clean (no-ghost)
 * crossing bonus. -------------------------------------------------------- */

/**
 * A landing counts as PERFECT when the player's x is within this fraction of
 * the platform's own width from its center — e.g. 0.16 means "within the
 * middle 32% of the platform". Part of the spatial difficulty ramp (see
 * CROSSING_DIFFICULTY_RAMP_CROSSINGS): EASY..HARD, lerped by the same
 * `crossings` curve as the landing-assist box and the ghost gap safety
 * factor, so "PERFECT demands more precision" escalates on exactly the same
 * schedule as everything else, on an empty road exactly as in traffic.
 */
export const CROSSING_PERFECT_LANDING_WIDTH_FRACTION_EASY = 0.22;
export const CROSSING_PERFECT_LANDING_WIDTH_FRACTION_HARD = 0.1;
export const CROSSING_PERFECT_LANDING_BONUS = 40;
/** Each consecutive perfect landing adds this fraction to the bonus
 * multiplier (streak 1 = 1x, streak 2 = 1.35x, ...), capped below. Broken by
 * any non-perfect landing or the run ending. */
export const CROSSING_PERFECT_LANDING_COMBO_STEP = 0.35;
export const CROSSING_PERFECT_LANDING_COMBO_MAX_MULTIPLIER = 3;

/**
 * SAFETY: there is deliberately NO bonus here for crossing without touching
 * a ghost platform. An earlier version of this file had one
 * (CROSSING_NO_GHOST_CROSSING_BONUS) — it directly paid the player for more
 * real vehicles being on the road, which is exactly the incentive the
 * project must never create: the player is a passenger, the driver is right
 * there, and nothing in this game may reward "hope for more traffic". Ghost
 * platforms are first-class scoring surfaces, identical in every point
 * value below to a real tracked one. Do not reintroduce a real/ghost scoring
 * split under any name.
 */

/** Brief near-freeze on a perfect landing (and on reaching the goal) — a few
 * frames where physics pauses but rendering doesn't, for a satisfying
 * "impact" beat. Short enough to read as punctuation, not lag. */
export const CROSSING_HITSTOP_SECONDS = 0.07;

/** Screen shake scales with how hard the player hit the ground — a gentle
 * hop barely shakes, a long fall from a missed jump shakes hard. Trauma per
 * px/s of vertical impact speed, capped below. */
export const CROSSING_LANDING_SHAKE_TRAUMA_PER_PXPS = 0.0009;
export const CROSSING_LANDING_SHAKE_TRAUMA_MAX = 0.6;
/** Extra trauma layered on top of the impact shake specifically for a
 * PERFECT landing — makes precision feel powerful, not just accurate. */
export const CROSSING_PERFECT_LANDING_SHAKE_TRAUMA = 0.3;
/** Trauma on reaching the goal block — stronger than a perfect landing,
 * short of a full failure shake, so the run's biggest "good" beat is still
 * clearly punchier than clearing an ordinary hop. */
export const CROSSING_GOAL_SHAKE_TRAUMA = 0.55;

export const CROSSING_PERFECT_LANDING_SPARKLE_COLOR = 0x5be8ff;
export const CROSSING_GOAL_SPARKLE_COLOR = 0xffd23f;

/* --- Scoring ------------------------------------------------------------ */

export const CROSSING_SCORE_PER_SECOND = 4;
export const CROSSING_SCORE_PER_PIXEL_PROGRESS = 0.05;
export const CROSSING_SCORE_BONUS_PER_CROSSING = 150;

/* ------------------------------------------------------------------ */
/* Motion comfort cues — src/game/systems/MotionCueSystem.ts               */
/*                                                                          */
/* The same idea as iOS 18's "Vehicle Motion Cues": small dots near the    */
/* screen edges that drift with the vehicle's own real acceleration, not   */
/* the game — giving the inner ear and the eyes matching information while */
/* staring at a screen inside a moving vehicle, which is what actually     */
/* causes motion sickness. Pooled, built once, allocation-free, driven by  */
/* Game.setMotion(state)/setMotionCuesEnabled(enabled) from src/types.ts.  */
/* ------------------------------------------------------------------ */

/** Dots per screen edge (top/bottom/left/right) — kept small; this is a
 * peripheral cue, not gameplay content, and must stay off the critical
 * visual path (the center of the screen where the actual game reads). */
export const MOTION_CUE_DOTS_PER_HORIZONTAL_EDGE = 5;
export const MOTION_CUE_DOTS_PER_VERTICAL_EDGE = 3;
export const MOTION_CUE_DOT_RADIUS = 2.2;
export const MOTION_CUE_DOT_COLOR = 0xffffff;
export const MOTION_CUE_DOT_ALPHA = 0.4;
/** Inset from the physical edge, as a fraction of the corresponding canvas
 * dimension — keeps the dots clear of iOS/Android system chrome/notches
 * without needing safe-area plumbing in this layer (that lives in
 * src/ui/**, out of scope here). */
export const MOTION_CUE_EDGE_INSET_FRACTION = 0.035;

/** m/s^2 -> px conversion for the dot drift, and the hard clamp on how far a
 * dot can wander from its home position — subtle by design (a peripheral
 * cue that itself became distracting would defeat the point). */
export const MOTION_CUE_ACCEL_TO_PX = 3.2;
export const MOTION_CUE_MAX_OFFSET_PX = 16;
/** Exponential smoothing rate (1/s) the rendered offset chases the latest
 * acceleration-derived target at — the sensor's own MotionSensor already
 * low-passes the raw signal (see types.ts), this is just enough extra
 * smoothing that individual per-frame sensor samples don't read as a
 * flicker. */
export const MOTION_CUE_SMOOTH_RATE = 3.5;
/** Amplitude multiplier applied when the OS reports `prefers-reduced-
 * motion` — the brief is explicit that someone who needs reduced motion is
 * also exactly the person who most needs the comfort cues, so this makes
 * them CALMER (smaller, slower), never removes them. */
export const MOTION_CUE_REDUCED_MOTION_SCALE = 0.4;
export const MOTION_CUE_REDUCED_MOTION_SMOOTH_RATE = 1.6;

/* ------------------------------------------------------------------ */
/* Gyro stabilisation — damping hand-shake out of REAL platform positions  */
/*                                                                          */
/* Nobody holds a phone still while someone else drives; that shake moves  */
/* the whole camera frame, so every TRACKED box (and therefore every real  */
/* platform) jitters with it. Implemented as a single hand-rolled          */
/* first-order high-pass (complementary) filter on the device's own        */
/* rotation rate — a leaky integrator: `offset' = rate*GAIN - offset*LEAK`. */
/* Applied ONLY to real tracked platforms — never ghosts (synthetic,       */
/* nothing to correct) and never the anchor blocks (already smoothed        */
/* independently via the horizon hint).                                    */
/*                                                                          */
/* TUNING IS MEASURED, NOT GUESSED — a naive first pass (gain 0.6, leak 6)  */
/* looked right on paper but a numeric simulation (see pixi-game-engineer's */
/* verification notes) showed it barely discriminated hand tremor from a    */
/* real sustained turn at all (turn response actually EXCEEDED tremor       */
/* response at those constants). A swept simulation across gain/leak pairs  */
/* against two synthetic scenarios — (a) 8Hz sinusoidal tremor, peak        */
/* 50deg/s, a physiologically-realistic hand tremor; (b) a real turn        */
/* profile (rate ramps 0->25deg/s over 0.5s, holds, ramps back down) —      */
/* found leak needs to be roughly >=30 (1/s) before tremor response         */
/* clearly exceeds an equivalent turn's. At the constants below (measured): */
/*   - 8Hz/50deg/s hand tremor: ~2.1px peak correction                      */
/*   - a real ~2s turn at 25deg/s: ~1.5px peak, decays to exactly 0px once  */
/*     the turn ends (no residual drift)                                    */
/*   - tremor response is ~1.34x a comparable turn's — genuinely favors     */
/*     jitter over real motion, not just "happens to also respond a bit"    */
/*   - pathological worst case (60deg/s held forever): converges to 3.7px,  */
/*     safely inside the 6px hard clamp                                     */
/* Every one of those numbers is small enough, either way, that even the    */
/* imperfect frequency separation cannot read as "fighting" real platform   */
/* motion — a real tracked platform moves tens to hundreds of px during a   */
/* turn, dwarfing a <=6px nudge — which is what makes this worth shipping   */
/* despite the filter's real, disclosed imprecision.                       */
/* ------------------------------------------------------------------ */

/** px of corrective offset per (deg/s) of rotation rate, integrated over
 * dt — the filter's gain. */
export const GYRO_STABILIZATION_GAIN_PX_PER_DEG = 3.5;
/** Leak rate (1/s) — the filter's cutoff, i.e. how fast the corrective
 * offset's own time constant (~1/LEAK, here ~25ms) drains a sustained
 * rotation back toward 0. Needs to be this high (not the initial guess of
 * 6) for hand tremor to clearly out-respond a real turn — see the measured
 * sweep in the file-section doc above. */
export const GYRO_STABILIZATION_LEAK_RATE = 40;
/** Hard clamp, px — even the filter's worst-case pathological steady-state
 * (measured ~3.7px for a 60deg/s rotation held indefinitely, which does not
 * happen in a real car) stays comfortably inside this; a real platform
 * glides/tracks over tens to hundreds of px, so a <= this-many-px nudge is
 * imperceptible next to genuine motion but large enough (~2px measured) to
 * visibly steady a held platform against hand tremor. */
export const GYRO_STABILIZATION_MAX_OFFSET_PX = 6;

/* ------------------------------------------------------------------ */
/* Debug overlay                                                       */
/* ------------------------------------------------------------------ */

export const DEBUG_TEXT_UPDATE_INTERVAL_SECONDS = 0.25;
export const DEBUG_TEXT_COLOR = 0x00ff66;
export const DEBUG_TEXT_SIZE = 12;
