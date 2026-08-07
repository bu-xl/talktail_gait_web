# Review-layout media sources

Panes stay black until a clinic session finishes (`analyze_done`).

| Pane | Source |
|------|--------|
| 1 | Web: pressure GIF from pad frames |
| 2-1 | back `/uploads/...` (original phone video) |
| 2-2 | ai-server `result_video` (skeleton overlay) |
| 3-1 | ai-server `result_angle_pawy` (`*_angle_pawy.mp4`) |
| 3-2 | ai-server `result_stride` (`*_stride.png`) |
| Report | `result_cyclogram` video + `result_derived` JSON (wired later) |

Disk layout:

```
results/<YYMMDD>/<HHMMSS>/
  result_video/
  result_keypoints/
  result_derived/
  result_cyclogram/
  result_stride/
  result_angle_pawy/
```
