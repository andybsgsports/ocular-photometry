// Runtime and model are served from this site (see vendor/mediapipe/README.md),
// so the page never loads code from a third-party host.
export const MP_VERSION = '1.0.1';
const VENDOR = new URL('../vendor/mediapipe/', import.meta.url);
export const WASM_BASE = new URL('wasm', VENDOR).href;
export const BUNDLE_URL = new URL('vision_bundle.mjs', VENDOR).href;
export const MODEL_URL = new URL('face_landmarker.task', VENDOR).href;

export async function createLandmarker({ onStage = () => {} } = {}) {
  onStage('Loading vision runtime…');
  const { FaceLandmarker, FilesetResolver } = await import(BUNDLE_URL);
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  onStage('Loading face model (3.7 MB)…');
  const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  try {
    return await make('GPU');
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU', err);
    return await make('CPU');
  }
}

// MediaPipe face mesh indices.
export const IDX = Object.freeze({
  rightIris: 468, leftIris: 473,
  rightOuter: 33, rightInner: 133, rightUpper: 159, rightLower: 145,
  leftInner: 362, leftOuter: 263, leftUpper: 386, leftLower: 374,
  rightRing: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  leftRing: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398],
});

function irisOffset(lm, iris, cornerA, cornerB, upper, lower) {
  const w = lm[cornerB].x - lm[cornerA].x;
  const h = lm[lower].y - lm[upper].y;
  if (Math.abs(w) < 1e-4 || h < 0.005) return null;
  return { x: (lm[iris].x - lm[cornerA].x) / w, y: (lm[iris].y - lm[upper].y) / h };
}

export function readEyes(result) {
  const lm = result?.faceLandmarks?.[0];
  if (!lm) return null;
  let left = null, right = null;
  for (const c of result.faceBlendshapes?.[0]?.categories ?? []) {
    if (c.categoryName === 'eyeBlinkLeft') left = c.score;
    else if (c.categoryName === 'eyeBlinkRight') right = c.score;
  }
  if (left == null || right == null) return null;
  const gr = irisOffset(lm, IDX.rightIris, IDX.rightOuter, IDX.rightInner, IDX.rightUpper, IDX.rightLower);
  const gl = irisOffset(lm, IDX.leftIris, IDX.leftInner, IDX.leftOuter, IDX.leftUpper, IDX.leftLower);
  const gaze = gr && gl ? { x: (gr.x + gl.x) / 2, y: (gr.y + gl.y) / 2 } : null;
  return {
    closure: (left + right) / 2,
    closureL: left,
    closureR: right,
    gazeX: gaze?.x ?? null,
    gazeY: gaze?.y ?? null,
    landmarks: lm,
  };
}
