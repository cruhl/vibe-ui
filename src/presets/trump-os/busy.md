# Trump OS: busy state

What the interface shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "Log in as Trump the morning after the midterms. The OS insists he won.",
  "acknowledge": "wobble",
  "font": "Georgia, 'Times New Roman', serif",
  "colors": {
    "ink": "#1a1200",
    "panel": "#e9c45a",
    "edge": "#8a6a12",
    "accent": "#9e1b1b",
    "glow": "rgba(255, 223, 120, 0.9)"
  },
  "frame": {
    "corners": [0.6],
    "borderWidth": 0.3,
    "borderStyle": "solid",
    "panel": ["#fbe7a1", "#e9c45a", "#b8892a"],
    "shadow": "soft",
    "bevel": true,
    "textCase": "upper",
    "weight": "bold",
    "letterSpacing": 0.05,
    "textEffect": "none",
    "prefix": "",
    "pixelated": false,
    "tail": false
  },
  "place": "top",
  "indicator": {
    "motion": "twinkle",
    "seconds": 1.6,
    "prompt": "A shiny polished gold four pointed sparkle star with bright white glints, luxurious metallic gold, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "LOGGING IN. THE GREATEST LOGIN IN HISTORY",
    "thinking": "THINKING. VERY STABLE GENIUS THINKING",
    "writing": "WRITING A BEAUTIFUL TRUTH",
    "filming": "LOADING. RIGGED, BUT LOADING",
    "arriving": "HERE IT COMES. HUGE",
    "slow": "SO DARK OUTSIDE, SO EARLY"
  },
  "ambient": [
    {
      "kind": "shimmer",
      "color": "rgba(255, 245, 200, 0.22)",
      "x": 50,
      "y": 50,
      "width": 100,
      "height": 100,
      "opacity": 1,
      "seconds": 5.5,
      "blend": "screen"
    }
  ],
  "sounds": {
    "click": {
      "seconds": 0.6,
      "volume": 0.45,
      "prompt": "a short bright cash register cha ching with a tiny coin jingle"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.14,
      "prompt": "a quiet luxury hotel lobby ambience: soft distant murmur, faint marble echo and a gentle fountain, steady, seamless loop"
    }
  }
}
```
