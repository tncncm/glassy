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

export const PLAYER_COLOR_BODY = 0xffce45;
export const PLAYER_COLOR_OUTLINE = 0x2b1d00;
export const PLAYER_COLOR_LIMB = 0xe6a92e;
export const PLAYER_COLOR_EYE = 0x1a1400;

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
export const CROSSING_LEFT_BLOCK_CENTER_X_FRACTION = 0.07;
export const CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION = 0.93;
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
 * edges, derived from their own position/size fractions above so it can
 * never silently drift out of sync with where the blocks actually are. */
export const CROSSING_LEG_SPAN_FRACTION =
  CROSSING_RIGHT_BLOCK_CENTER_X_FRACTION -
  CROSSING_BLOCK_WIDTH_FRACTION / 2 -
  (CROSSING_LEFT_BLOCK_CENTER_X_FRACTION + CROSSING_BLOCK_WIDTH_FRACTION / 2);

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

export const CROSSING_COMBO_TEXT_SIZE = 16;
export const CROSSING_COMBO_TEXT_COLOR = 0xffffff;
export const CROSSING_COMBO_TEXT_OUTLINE_COLOR = 0x0c3542;
export const CROSSING_COMBO_TEXT_Y_PX = 30;

/* --- Reward for skill: perfect landings, streak combos, a clean (no-ghost)
 * crossing bonus. -------------------------------------------------------- */

/** A landing counts as PERFECT when the player's x is within this fraction
 * of the platform's own width from its center — e.g. 0.16 means "within the
 * middle 32% of the platform". */
export const CROSSING_PERFECT_LANDING_WIDTH_FRACTION = 0.16;
export const CROSSING_PERFECT_LANDING_BONUS = 40;
/** Each consecutive perfect landing adds this fraction to the bonus
 * multiplier (streak 1 = 1x, streak 2 = 1.35x, ...), capped below. Broken by
 * any non-perfect landing or the run ending. */
export const CROSSING_PERFECT_LANDING_COMBO_STEP = 0.35;
export const CROSSING_PERFECT_LANDING_COMBO_MAX_MULTIPLIER = 3;
/** Flat bonus for completing an entire leg without ever standing on a ghost
 * platform — rewards a leg crossed entirely on real, tracked traffic. */
export const CROSSING_NO_GHOST_CROSSING_BONUS = 80;

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
/* Debug overlay                                                       */
/* ------------------------------------------------------------------ */

export const DEBUG_TEXT_UPDATE_INTERVAL_SECONDS = 0.25;
export const DEBUG_TEXT_COLOR = 0x00ff66;
export const DEBUG_TEXT_SIZE = 12;
