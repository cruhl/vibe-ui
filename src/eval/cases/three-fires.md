```json
{
  "preset": "caveman-os",
  "user": "llm",
  "human": {
    "seed": 7,
    "reactionMs": { "mean": 450, "sd": 120 },
    "readingWordsPerMinute": 230,
    "glanceMs": 700,
    "fittsMs": { "a": 120, "b": 160 },
    "hesitation": { "chance": 0.15, "ms": { "mean": 900, "sd": 300 } },
    "misclick": { "chance": 0.08, "spread": 0.9 },
    "typingCharsPerSecond": 5,
    "idle": { "chance": 0.05, "ms": { "mean": 2500, "sd": 800 } }
  },
  "limits": { "maxInputs": 6, "maxSeconds": 110 },
  "deadlines": {
    "firstClipSeconds": 20,
    "clickToFirstFrameSeconds": 12,
    "maxHoldSeconds": 3,
    "maxBlackFrames": 0,
    "readySeconds": 45
  }
}
```

You are a curious caveman trying a computer for the first time. You click big pictures, read slowly, and get excited when something happens.

Goal: make three fires, then shut the computer down. You are done when the screen shows three fires made and the computer is off, or when you run out of inputs.
