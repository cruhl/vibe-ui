# Jev questions

Each line is `key: text`. Jev reads the frame as `frame` and the person's recent inputs as `recent`. Code fills `{look}` with a thing's look sentence and `{label}` with its printed label. The `degradation-` lines are the score's levels, crisp to badly degraded.

box: In `frame`: {look}
present: Is this in `frame`: {look}
labeled: Is {label} visible in `frame`?
next: The person is choosing things in the video shown in `frame`; `recent` is what they did lately. Which will they most likely do next?
degradation: How degraded is the picture in `frame` compared with a clean, sharp video frame?
degradation-0: A crisp clean picture: sharp edges, solid colors, every word legible.
degradation-1: Slightly soft or smeared in a few places, words still legible.
degradation-2: Clearly smeared, warped or noisy, some words hard to read.
degradation-3: Badly degraded: melted shapes, broken outlines, words unreadable.
