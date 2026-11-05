# I'M IN: busy state

What the interface shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "A 1990s movie hacker OS where everything glows, beeps and works dramatically.",
  "acknowledge": "brighten",
  "font": "'Courier New', Menlo, ui-monospace, monospace",
  "colors": {
    "ink": "#39ff6a",
    "panel": "rgba(0, 8, 2, 0.88)",
    "edge": "#39ff6a",
    "accent": "#b6ffc8",
    "glow": "rgba(57, 255, 106, 0.75)"
  },
  "frame": {
    "corners": [0],
    "borderWidth": 0.08,
    "borderStyle": "solid",
    "panel": ["rgba(0, 8, 2, 0.88)"],
    "shadow": "glow",
    "bevel": false,
    "textCase": "upper",
    "weight": "normal",
    "letterSpacing": 0.04,
    "textEffect": "glow",
    "prefix": "> ",
    "pixelated": false,
    "tail": false
  },
  "place": "bottom-left",
  "indicator": {
    "motion": "spin",
    "seconds": 5,
    "prompt": "A glowing bright green wireframe globe made of thin neon lines, latitude and longitude grid, hacker movie style, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "ESTABLISHING UPLINK",
    "thinking": "CRACKING THE ALGORITHM",
    "writing": "COMPILING THE HACK",
    "filming": "UPLOADING THE VIRUS",
    "arriving": "BYPASSING THE LAST FIREWALL",
    "slow": "THEY ARE ON TO US. REROUTING"
  },
  "ambient": [
    {
      "kind": "scanlines",
      "color": "rgba(0, 0, 0, 0.14)",
      "x": 50,
      "y": 50,
      "width": 100,
      "height": 100,
      "opacity": 1,
      "seconds": 7,
      "blend": "normal"
    },
    {
      "kind": "flicker",
      "color": "rgba(255, 255, 255, 0.035)",
      "x": 50,
      "y": 50,
      "width": 100,
      "height": 100,
      "opacity": 1,
      "seconds": 2.3,
      "blend": "normal"
    }
  ],
  "sounds": {
    "click": {
      "seconds": 0.5,
      "volume": 0.45,
      "prompt": "a short bright digital computer terminal beep blip, 1990s hacker movie interface sound"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.16,
      "prompt": "a low electronic server room hum with faint rhythmic data chirps and soft modem noise, steady, seamless loop"
    }
  }
}
```
