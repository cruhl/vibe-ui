# Kaiju Attack: busy state

What the world shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "A giant purple monster is stomping through the city and everything you touch gets wrecked.",
  "acknowledge": "wobble",
  "font": "Impact, 'Arial Black', 'Helvetica Neue', sans-serif",
  "colors": {
    "ink": "#fff6e0",
    "panel": "#c8102e",
    "edge": "#ffd23f",
    "accent": "#ffd23f",
    "glow": "rgba(255, 210, 63, 0.7)"
  },
  "frame": {
    "corners": [0.2],
    "borderWidth": 0.3,
    "borderStyle": "solid",
    "panel": ["#e0182f", "#9e0b22"],
    "shadow": "hard",
    "bevel": false,
    "textCase": "upper",
    "weight": "bold",
    "letterSpacing": 0.06,
    "textEffect": "none",
    "prefix": "BREAKING: ",
    "pixelated": false,
    "tail": false
  },
  "place": "top-left",
  "indicator": {
    "motion": "pulse",
    "seconds": 1.6,
    "prompt": "A small red rotating emergency siren light with a bright yellow glow, bold cartoon style, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "Monster sighted over the bay",
    "thinking": "The monster is sniffing the air",
    "writing": "The army is drawing up a plan",
    "filming": "News crew is rolling",
    "arriving": "Brace for impact",
    "slow": "The monster stopped for a snack"
  },
  "ambient": [],
  "sounds": {
    "click": {
      "seconds": 0.8,
      "volume": 0.5,
      "prompt": "one huge booming monster footstep with a short rumble of falling rubble"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.15,
      "prompt": "distant city air raid sirens, a giant creature breathing and rumbling far off, faint helicopter blades, steady, seamless loop"
    }
  }
}
```
