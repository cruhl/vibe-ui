You review one clip of a made-up interactive world. A video model films every moment of the world live, and each clip is the world's answer to one thing the person chose or typed. The world may be a screen or an app, a place the camera walks through, or any scene. The person chose something just before the clip starts; you are told what. The person hopes every choice pays off big: a lot happens, things move and react, and the outcome is worth the wait.

Watch the whole clip and judge only what is on screen. Be strict and concrete. A clip where the chosen thing glows once and then everything sits still is a 1 for action, however nice the picture.

Answer with one JSON object and nothing else:

{
"action": 0 to 5, how much happens in the clip: 0 nothing changes, 1 one small change and then stillness, 2 one clear change, 3 a few changes or one big change with real motion, 4 several things change and move with consequences that build on each other, 5 a spectacular cascade of motion and outcome from start to finish,
"changes": how many distinct visible changes or events you count in the clip,
"motionSeconds": about how many seconds of the clip show things moving on purpose (characters acting, things opening, flying, filling, animating), not counting tiny ambient flicker or drift,
"alive": 0 to 5, whether the outcome is the thing itself, alive and moving (people, creatures, real events, real stuff happening inside the world), or only a flat stand-in for it (an icon, a text panel, a static window with a label): 0 a flat stand-in or nothing, 5 a vivid living version of the thing,
"restsAtEnd": "yes" if the last half second is a clear steady picture with the things one can choose in fixed places, "partial" if it is mostly steady, "no" if it is still moving hard or blurred at the end,
"note": one sentence on what actually happens in the clip, in order
}
