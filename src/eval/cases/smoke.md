```json
{
  "preset": "caveman-os",
  "user": "scripted",
  "script": [
    { "action": "click", "elementID": "fire", "intent": "open the fire program" },
    { "action": "wait", "seconds": 1 },
    { "action": "click", "elementID": "rock", "intent": "open the rock program" },
    { "action": "click", "elementID": "hunt", "intent": "open the hunt program" }
  ],
  "replay": null,
  "human": {
    "seed": 11,
    "reactionMs": { "mean": 400, "sd": 100 },
    "readingWordsPerMinute": 250,
    "glanceMs": 500,
    "fittsMs": { "a": 100, "b": 150 },
    "hesitation": { "chance": 0, "ms": { "mean": 0, "sd": 0 } },
    "misclick": { "chance": 0, "spread": 0 },
    "typingCharsPerSecond": 5,
    "idle": { "chance": 0, "ms": { "mean": 0, "sd": 0 } }
  },
  "limits": { "maxInputs": 3, "maxSeconds": 90 },
  "deadlines": {
    "firstClipSeconds": 20,
    "clickToFirstFrameSeconds": 12,
    "maxHoldSeconds": 3,
    "maxBlackFrames": 0,
    "readySeconds": 45
  }
}
```

A careful person who clicks the three desktop programs in turn to see that each one opens.
