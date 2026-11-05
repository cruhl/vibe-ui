```json
{
  "preset": "caveman-os",
  "user": "scripted",
  "script": [
    {
      "action": "click-label",
      "settled": true,
      "label": "FIRE"
    },
    {
      "action": "click-label",
      "settled": true,
      "label": "MAKE FIRE"
    },
    {
      "action": "click-label",
      "settled": true,
      "label": "MAKE FIRE"
    },
    {
      "action": "click-label",
      "settled": true,
      "label": "X"
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
    "maxInputs": 4,
    "maxSeconds": 150
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

Opens FIRE, makes two fires and closes the window, waiting for each clip to settle before the next press, so every answer has a clean held frame for Jev to judge. Its hold deadline allows that wait.
