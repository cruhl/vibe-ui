```json
{
  "preset": "caveman-os",
  "user": "scripted",
  "script": [
    {
      "action": "click-label",
      "label": "FIRE"
    },
    {
      "action": "click-label",
      "label": "ROCK"
    },
    {
      "action": "click-label",
      "label": "START"
    },
    {
      "action": "click-label",
      "label": "X"
    },
    {
      "action": "click-label",
      "label": "FIRE"
    },
    {
      "action": "click-label",
      "label": "MAKE FIRE"
    },
    {
      "action": "click-label",
      "label": "X"
    },
    {
      "action": "click-label",
      "label": "START"
    },
    {
      "action": "click-label",
      "label": "FIRE"
    },
    {
      "action": "click-label",
      "label": "START"
    },
    {
      "action": "click-label",
      "label": "ROCK"
    },
    {
      "action": "click-label",
      "label": "MAKE FIRE"
    },
    {
      "action": "click-label",
      "label": "MAKE FIRE"
    },
    {
      "action": "click-label",
      "label": "SMASH"
    }
  ],
  "replay": null,
  "human": {
    "seed": 11,
    "reactionMs": {
      "mean": 400,
      "sd": 100
    },
    "readingWordsPerMinute": 250,
    "glanceMs": 500,
    "fittsMs": {
      "a": 100,
      "b": 150
    },
    "hesitation": {
      "chance": 0,
      "ms": {
        "mean": 0,
        "sd": 0
      }
    },
    "misclick": {
      "chance": 0,
      "spread": 0
    },
    "typingCharsPerSecond": 5,
    "idle": {
      "chance": 0,
      "ms": {
        "mean": 0,
        "sd": 0
      }
    }
  },
  "limits": {
    "maxInputs": 14,
    "maxSeconds": 300
  },
  "deadlines": {
    "firstClipSeconds": 20,
    "clickToFirstFrameSeconds": 12,
    "maxHoldSeconds": 3,
    "maxBlackFrames": 0,
    "readySeconds": 45
  }
}
```

The fourteen clicks of the 2026-11-02T23-46-53-729Z run, by printed label, so both projectors see the same input sequence. A label that is absent once the screen settles is skipped and logged.
