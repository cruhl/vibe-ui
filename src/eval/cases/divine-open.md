```json
{
  "preset": "divine-terminal",
  "user": "scripted",
  "script": [
    {
      "action": "click-label",
      "settled": true,
      "label": "SMITE"
    },
    {
      "action": "click-label",
      "settled": true,
      "label": "X"
    },
    {
      "action": "click-label",
      "settled": true,
      "label": "PRAYERS"
    },
    {
      "action": "click-label",
      "settled": true,
      "label": "X"
    },
    {
      "action": "click-label",
      "settled": true,
      "label": "MIRACLES"
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
    "maxInputs": 5,
    "maxSeconds": 170
  },
  "deadlines": {
    "firstClipSeconds": 30,
    "clickToFirstFrameSeconds": 15,
    "maxHoldSeconds": 8,
    "maxBlackFrames": 0,
    "readySeconds": 60
  }
}
```

Opens three Divine Terminal programs one after another, closing each window in between and waiting for each clip to settle, so every window opening has a clean held frame for Jev to check that the change was filmed.
