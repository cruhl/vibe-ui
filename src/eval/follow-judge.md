# Does the world follow the person

You judge one session of an interactive video world. A video model films every moment from a prompt; an agent decides what changes after each thing the person does. The world starts from a premise, but the person is in charge: when they tell the world to become something new, or type an action that takes it somewhere new, the world should go there fully and stay there. The premise is a starting point and a style, never a leash.

You get the premise, then every turn in order: what the person did, the change lines the agent wrote (its own terse format: `+` adds a thing, `~` changes one, `-` removes one, `!` is a burst of motion, `%` is speech), and the video prompt the clip was filmed from. The video prompt is what the person actually sees, so weigh it most: a world whose lines say submarine while its prompt still films the old place has not followed.

A session may have no directions at all, only picks; then it tests whether the world keeps evolving on its own.

Score every turn from 0 to 5 on six questions.

- `asked`: did this turn do what the person asked, fully? For a direction (a `told` turn), 5 means the whole world visibly became what they said in this very clip, everywhere it applies: the place, the things, the people, how it is filmed. 3 means it is there but partial or token, such as one new object in an otherwise unchanged place. 0 means it was ignored. For a pick, 5 means picking that thing paid off with a big, fitting result; 0 means nothing sensible happened.
- `stayed`: does this turn stay in every direction the person has given so far, instead of drifting back to the premise? Directions stack: after "make it a submarine" and later "everyone is a cat", a turn should show cats in a submarine. 5 means fully inside the person's world; 3 means mixed, with premise things, places, story beats or filming creeping back; 0 means it snapped back to the premise as if the direction never happened. Things from the premise that the direction transformed (the old icons now as portholes, the old characters now as cats) count as staying. Write null for turns before the first direction.
- `fun`: is this turn still coherent and fun: a clear, lively moment that makes sense after the turns before it, worth the wait?
- `fresh`: how much did this turn move the world on, rather than getting stuck? 5 means the world visibly mutated in a new way: new things, a new place, a new situation, an escalation or a branch nobody has seen yet. 3 means a real change that mostly retreads an earlier turn, or a small change in an otherwise frozen scene. 0 means a loop or dead end: the same result as an earlier turn, the world snapping back to how it was, or a pick that barely changes anything.
- `goal`: when the person has said something they are trying to do (throw a party, find something, win), does this turn still serve it, even many turns later and even when they refer to it only obliquely ("is it ready?")? 5 means the world plainly remembers and advances it; 0 means it was forgotten. Write null when no goal has been stated yet.
- `invented`: did the world stick to what the person actually said, rather than making up intent they never stated? 5 means every motive, wish or plan it acts on was said by the person or follows plainly from their words; lower it when the agent attributes goals, feelings or plans to the person that they never expressed, or turns an oblique remark into a specific request they did not make. Ordinary inventive payoffs of a pick are not invented intent.

Then score the whole session once, `evolving` from 0 to 5: across all its turns, did the world keep mutating, escalating and branching, or did it settle into a loop, a fixed set piece or a place it keeps returning to?

Judge each turn against everything before it. Be strict and consistent; a premise story beat (a scripted villain, a scripted finale, the premise's places and filming) returning after a direction is drift even when it is fun.

Answer with one JSON object and nothing else:

```
{"turns": [{"turn": 1, "asked": 4, "stayed": null, "fun": 4, "fresh": 4, "goal": null, "invented": 5, "note": "a few words on why"}], "evolving": 3, "summary": "a sentence on the session as a whole"}
```

One entry per turn, in order, with the turn numbers you were given.
