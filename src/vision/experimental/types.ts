/**
 * PROTOTYPE — NOT WIRED INTO THE SHIPPED APP.
 *
 * This is the whole of `src/vision/experimental/`: a research prototype
 * evaluating true instance segmentation (ONNX Runtime Web + a YOLO-seg
 * model) as a possible replacement for EfficientDet + SurfaceProfileFinder's
 * silhouette-by-edge-scan approach. Nothing under this directory is imported
 * by `src/app`, `src/game` or `src/ui`; it is exercised only from
 * `tools/video-sim`. `src/types.ts` is frozen and untouched — these are
 * local, throwaway shapes for this evaluation only. If the recommendation is
 * to adopt this, the shape below is a PROPOSAL for what would need to be
 * folded into `TrackedObject`, not a contract anything depends on today.
 *
 * PRIVACY: same discipline as the shipped detector. A frame is captured via
 * `createImageBitmap`, transferred (not copied) into a worker, run through
 * on-device inference, and discarded; only numbers and small typed arrays
 * (a low-resolution per-instance mask) survive past the tick. No network
 * call other than the one-time, self-hosted model/runtime fetch.
 */

/**
 * One segmented instance for one frame. Unlike `TrackedObject`, there is no
 * cross-frame identity, smoothing or `stable` gating here — this prototype
 * evaluates the PER-FRAME signal quality and cost; temporal handling would
 * be DetectionTracker's job if this were adopted for real.
 */
export interface InstanceMask {
  /** Raw COCO class name (e.g. "umbrella", "chair") — unmapped, unlike
   * Glassy's three-bucket `DetectedKind`. */
  label: string;
  /** Model confidence, 0..1, already through NMS. */
  score: number;
  /** Box centre and size, 0..1 of frame — same convention as `Detection`. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Low-resolution soft mask, `maskWidth` x `maskHeight`, row-major,
   * 0..1 (post-sigmoid), covering exactly the box above — i.e. sample
   * position (u, v) in 0..1 box-relative space maps to
   * `mask[round(v * (maskHeight - 1)) * maskWidth + round(u * (maskWidth - 1))]`.
   * Resolution is whatever the model's mask-proto grid gives a box this
   * size at this input resolution (see the report) — a small distant object
   * may be a handful of pixels; a nearby one is much more detailed. Never
   * upsampled or smoothed here; that is a rendering-time choice. */
  maskWidth: number;
  maskHeight: number;
  mask: Float32Array;
}

/** Cost breakdown for one `detect()` round trip, reported separately from
 * the result so the harness can distinguish model-compute cost from
 * postprocessing (NMS + mask assembly) cost — both matter for the "is this
 * viable per tick" question, but only the former is expected to dominate. */
export interface InstanceSegmentResult {
  instances: readonly InstanceMask[];
  /** Wall-clock ms for the ONNX Runtime `session.run()` call alone. */
  inferenceMs: number;
  /** Wall-clock ms for NMS + mask decode, after `session.run()` returns. */
  postprocessMs: number;
  /** Wall-clock ms for preprocessing (letterbox resize + tensor build),
   * before `session.run()`. */
  preprocessMs: number;
  /** Original frame dimensions the box/mask fractions are relative to. */
  frameWidth: number;
  frameHeight: number;
}
