# Third-party detection models

These weights power the on-device "find faces" helper. They are served from
this origin and run in the visitor's browser — no image data is ever sent
anywhere. From the [OpenCV Zoo](https://github.com/opencv/opencv_zoo)
(repository state `47534e27c9851bb1128ccc0102f1145e27f23f98`).

| File                                | Model               | Upstream                                                                                                    | License                            |
| ----------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `face_detection_yunet_2023mar.onnx` | YuNet face detector | [`models/face_detection_yunet`](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT — see `LICENSE-face-yunet.txt` |

YuNet is by Wei Wu, Hanyang Peng and Shiqi Yu — _"YuNet: A Tiny Millisecond-level
Face Detector"_, Machine Intelligence Research, 2023. The licence is permissive
and compatible with this project's MIT licence. The model was not modified; the
`.onnx` file is byte-for-byte upstream.

## Why there is no licence-plate model here

`src/lib/detect.ts` carries a working decoder for OpenCV Zoo's LPD-YuNet plate
detector, but the weights are deliberately **not** shipped and no page enables
plate detection.

That model is trained on Chinese plates, and upstream warns results elsewhere
"may be limited". Measured against 35 openly-licensed UK/EU/US car photos on
2026-08-12, it found a plate in only 9 of them — 8 of 24 UK and **0 of 9 US** —
roughly 35% recall. Lowering the confidence threshold raised the hit rate but
began producing degenerate full-image boxes, which is worse than nothing for
redaction. Where it did fire it was accurate; it simply does not recognise most
Western plates.

Shipping it would have meant a button that silently misses two thirds of the
plates it promises to find. The decoder stays so a better, permissively licensed
model can be dropped in later.
