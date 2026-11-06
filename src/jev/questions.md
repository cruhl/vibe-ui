# Jev questions

Each line is `key: text`. Jev reads the frame as `frame` and the person's recent inputs as `recent`. Code fills `{look}` with a thing's look sentence and `{label}` with its printed label. The `degradation-` lines are the score's levels, crisp to badly degraded. The `point` question reads the whole frame as `frame` and a crop of it around the spot the person chose as `crop`; code fills `{look}` and `{state}` with each thing in view. `point-field` asks, of the same spot, whether it is a place made for typed words.

box: In `frame`: {look}
present: Is this in `frame`: {look}
labeled: Is {label} visible in `frame`?
next: The person is choosing things in the video shown in `frame`; `recent` is what they did lately. Which will they most likely do next?
degradation: How degraded is the picture in `frame` compared with a clean, sharp video frame?
degradation-0: A crisp clean picture: sharp edges, solid colors, every word legible.
degradation-1: Slightly soft or smeared in a few places, words still legible.
degradation-2: Clearly smeared, warped or noisy, some words hard to read.
degradation-3: Badly degraded: melted shapes, broken outlines, words unreadable.
point: `crop` is cut from `frame` around the spot the person chose. Which of these is at the very center of `crop`?
point-thing: {look}
point-thing-now: {look}, {state}
point-open: Open background or empty space, with no particular thing at the center
point-field: Is the very center of `crop` on a field, box or bar made for typing words into, such as a text field, a search bar, a password box or a compose box?
