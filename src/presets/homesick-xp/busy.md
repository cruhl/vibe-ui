# Windows XD: busy state

What the interface shows while it works on an answer, written once as content. Code only plays it:
the indicator art and sounds in `busy/` are painted and recorded from the prompts below.

```json
{
  "pitch": "A cozy Windows XP desktop from 2003, until a friend on Messenger sends FREE SMILEYS.",
  "acknowledge": "press",
  "font": "Tahoma, Verdana, 'Segoe UI', sans-serif",
  "colors": {
    "ink": "#000000",
    "panel": "#ffffe1",
    "edge": "#000000",
    "accent": "#245edb",
    "glow": "rgba(255, 255, 255, 0.5)"
  },
  "frame": {
    "corners": [0.8],
    "borderWidth": 0.08,
    "borderStyle": "solid",
    "panel": ["#ffffe1"],
    "shadow": "soft",
    "bevel": false,
    "textCase": "as-written",
    "weight": "normal",
    "letterSpacing": 0,
    "textEffect": "none",
    "prefix": "",
    "pixelated": false,
    "tail": true
  },
  "place": "bottom-right",
  "indicator": {
    "motion": "flip",
    "seconds": 1.8,
    "prompt": "A glossy Windows XP style hourglass icon from 2003, gold wooden frame, blue glass bulbs with pale sand running through, soft shading, centered, isolated on a plain white background"
  },
  "phases": {
    "opening": "Windows is starting up...",
    "thinking": "Windows is thinking about it...",
    "writing": "Preparing your desktop...",
    "filming": "Copying files...",
    "arriving": "Almost there...",
    "slow": "This is taking longer than usual. Scanning for viruses..."
  },
  "ambient": [
    {
      "kind": "drift",
      "color": "rgba(255, 255, 255, 0.12)",
      "x": 50,
      "y": 50,
      "width": 100,
      "height": 100,
      "opacity": 1,
      "seconds": 18,
      "blend": "normal"
    }
  ],
  "sounds": {
    "click": {
      "seconds": 0.5,
      "volume": 0.5,
      "prompt": "a single soft plastic computer mouse click, crisp and short, no reverb"
    },
    "bed": {
      "seconds": 10,
      "volume": 0.18,
      "prompt": "a quiet beige desktop computer from 2003 idling: soft fan whir and an occasional gentle hard drive seek, steady, seamless loop"
    }
  }
}
```
