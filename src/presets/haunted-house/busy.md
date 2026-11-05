# Haunted House: busy state

What the world shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "Walk through a house so haunted that everything you touch comes screaming to life.",
  "acknowledge": "wobble",
  "font": "'Cinzel', 'Trajan Pro', 'Book Antiqua', Georgia, serif",
  "colors": {
    "ink": "#e6f1ff",
    "panel": "#10141f",
    "edge": "#5f7a99",
    "accent": "#9cff9a",
    "glow": "rgba(156, 255, 154, 0.7)"
  },
  "frame": {
    "corners": [0.3],
    "borderWidth": 0.2,
    "borderStyle": "double",
    "panel": ["#1a2030", "#0b0e16"],
    "shadow": "glow",
    "bevel": false,
    "textCase": "upper",
    "weight": "normal",
    "letterSpacing": 0.12,
    "textEffect": "glow",
    "prefix": "",
    "pixelated": false,
    "tail": false
  },
  "place": "bottom-left",
  "indicator": {
    "motion": "bob",
    "seconds": 2.2,
    "prompt": "A small cute glowing white ghost with big round dark eyes and a wavy trailing tail, soft painterly style, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "Creaking open the front door",
    "thinking": "The ghosts are whispering about you",
    "writing": "Rattling the chains",
    "filming": "The portraits are watching",
    "arriving": "Something is coming",
    "slow": "The dead take their time"
  },
  "ambient": [
    {
      "kind": "flicker",
      "color": "rgba(200, 220, 255, 0.12)",
      "x": 50,
      "y": 50,
      "width": 100,
      "height": 100,
      "opacity": 0.18,
      "seconds": 5,
      "blend": "screen"
    }
  ],
  "sounds": {
    "click": {
      "seconds": 0.8,
      "volume": 0.45,
      "prompt": "a single old door hinge creaking open slowly with a faint ghostly whisper"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.15,
      "prompt": "haunted house at night, howling wind, distant thunder, rain on windows, faint low ghostly moans, steady, seamless loop"
    }
  }
}
```
