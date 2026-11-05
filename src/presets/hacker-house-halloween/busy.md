# Hacker House Halloween: busy state

What the world shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "Walk into the most San Francisco Halloween party ever, where every guest has a pitch and every costume comes alive.",
  "acknowledge": "wobble",
  "font": "'Space Grotesk', 'Avenir Next', 'Helvetica Neue', sans-serif",
  "colors": {
    "ink": "#fff4e6",
    "panel": "#1a0f2e",
    "edge": "#ff8a1f",
    "accent": "#ff8a1f",
    "glow": "rgba(190, 110, 255, 0.75)"
  },
  "frame": {
    "corners": [0.5],
    "borderWidth": 0.15,
    "borderStyle": "solid",
    "panel": ["#2a1548", "#120a22"],
    "shadow": "glow",
    "bevel": false,
    "textCase": "as-written",
    "weight": "bold",
    "letterSpacing": 0.02,
    "textEffect": "glow",
    "prefix": "",
    "pixelated": false,
    "tail": false
  },
  "place": "bottom-left",
  "indicator": {
    "motion": "bob",
    "seconds": 1.8,
    "prompt": "A small cute glowing carved jack o lantern wearing tiny black VR goggles, bright orange, soft 3D cartoon style, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "Your robotaxi is pulling up",
    "thinking": "Someone is warming up a pitch",
    "writing": "Drafting the term sheet",
    "filming": "Everyone is filming this",
    "arriving": "The fog is rolling in",
    "slow": "The party is fundraising"
  },
  "ambient": [
    {
      "kind": "flicker",
      "color": "rgba(190, 110, 255, 0.10)",
      "x": 50,
      "y": 50,
      "width": 100,
      "height": 100,
      "opacity": 0.14,
      "seconds": 4,
      "blend": "screen"
    }
  ],
  "sounds": {
    "click": {
      "seconds": 0.8,
      "volume": 0.45,
      "prompt": "a short bright electronic robotaxi door chime with a quick burst of party crowd cheering"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.15,
      "prompt": "muffled house music bass thumping through the walls of an old house at a crowded party, people laughing and talking, a distant foghorn, steady, seamless loop"
    }
  }
}
```
