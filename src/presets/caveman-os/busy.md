# Caveman OS: busy state

What the interface shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "An operating system carved from stone, for cavemen.",
  "acknowledge": "wobble",
  "font": "Papyrus, 'Copperplate', fantasy",
  "colors": {
    "ink": "#ffffff",
    "panel": "#6b6560",
    "edge": "#2e2a27",
    "accent": "#e07a2a",
    "glow": "rgba(255, 140, 40, 0.8)"
  },
  "frame": {
    "corners": [1.2, 0.8, 1.4, 0.9],
    "borderWidth": 0.35,
    "borderStyle": "solid",
    "panel": ["#6b6560"],
    "shadow": "soft",
    "bevel": true,
    "textCase": "upper",
    "weight": "bold",
    "letterSpacing": 0,
    "textEffect": "emboss",
    "prefix": "",
    "pixelated": false,
    "tail": false
  },
  "place": "bottom-right",
  "indicator": {
    "motion": "spin",
    "seconds": 9,
    "prompt": "A round carved stone sundial disc seen from straight above, grey granite with chiseled tick marks and a pointed stone gnomon, chunky cartoon style, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "WAKE UP ROCK",
    "thinking": "OOG THINK",
    "writing": "CARVE ROCK",
    "filming": "PAINT ON WALL",
    "arriving": "SUN ALMOST THERE",
    "slow": "ROCK SLOW TODAY"
  },
  "ambient": [
    {
      "kind": "waver",
      "color": "rgba(255, 130, 40, 0.2)",
      "x": 15,
      "y": 30,
      "width": 60,
      "height": 55,
      "opacity": 1,
      "seconds": 1.7,
      "blend": "screen"
    }
  ],
  "sounds": {
    "click": {
      "seconds": 0.5,
      "volume": 0.5,
      "prompt": "a single short knock of one stone tapping another stone, dry clack"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.2,
      "prompt": "a small campfire crackling inside a cave with soft wind outside, steady, seamless loop"
    }
  }
}
```
