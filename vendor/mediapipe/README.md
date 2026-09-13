# Vendored MediaPipe

Self-hosted so the page never loads code from a third-party host.

| File | Source |
| --- | --- |
| `vision_bundle.mjs`, `wasm/*` | `@mediapipe/tasks-vision@1.0.1` (npm), Apache License 2.0 |
| `face_landmarker.task` | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`, Apache License 2.0 |

`vision_bundle.mjs` is byte-identical to the package file except that the trailing
`//# sourceMappingURL=` comment is removed (the map is not shipped). Both the SIMD and
no-SIMD wasm builds are included; the runtime picks one at load time.

To update:

```sh
npm pack @mediapipe/tasks-vision@<version>
tar xzf mediapipe-tasks-vision-<version>.tgz
cp package/vision_bundle.mjs vendor/mediapipe/
cp package/wasm/vision_wasm_internal.{js,wasm} package/wasm/vision_wasm_nosimd_internal.{js,wasm} vendor/mediapipe/wasm/
sed -i '/^\/\/# sourceMappingURL=/d' vendor/mediapipe/vision_bundle.mjs
```

Then update the version in this file and in `js/landmarker.js`.
