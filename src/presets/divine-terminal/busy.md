# Divine Terminal: busy state

What the interface shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "A 16 color TempleOS style terminal built for God. You are God.",
  "acknowledge": "brighten",
  "font": "'Courier New', ui-monospace, monospace",
  "colors": {
    "ink": "#0000aa",
    "panel": "#ffffff",
    "edge": "#0000aa",
    "accent": "#aa0000",
    "glow": "rgba(255, 215, 0, 0.85)"
  },
  "frame": {
    "corners": [0],
    "borderWidth": 0.45,
    "borderStyle": "double",
    "panel": ["#ffffff"],
    "shadow": "none",
    "bevel": false,
    "textCase": "upper",
    "weight": "bold",
    "letterSpacing": 0.06,
    "textEffect": "none",
    "prefix": "",
    "pixelated": true,
    "tail": false
  },
  "place": "bottom",
  "indicator": {
    "motion": "pulse",
    "seconds": 1.8,
    "prompt": "A glowing golden halo ring in chunky low resolution pixel art, bright yellow and white pixels with a soft pixel glow, seen slightly from above, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "IN THE BEGINNING",
    "thinking": "HE CONSIDERETH THY REQUEST",
    "writing": "AND IT WAS WRITTEN",
    "filming": "AND HE MADE IT SO",
    "arriving": "BEHOLD, IT COMETH",
    "slow": "BLESSED ARE THE PATIENT"
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
      "kind": "pulse",
      "color": "rgba(255, 215, 0, 0.22)",
      "x": 72,
      "y": 45,
      "width": 30,
      "height": 40,
      "opacity": 1,
      "seconds": 3.2,
      "blend": "normal"
    }
  ],
  "sounds": {
    "click": {
      "seconds": 0.5,
      "volume": 0.4,
      "prompt": "a single short bright small bell ding, pure and clean, like a heavenly chime"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.15,
      "prompt": "a soft ethereal choir pad drone, distant heavenly voices holding one warm chord, calm, seamless loop"
    }
  }
}
```
