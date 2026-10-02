# UI-automation log (OOTP 27, 2026-10-02)

Running notes from driving OOTP 27 from outside the game. Times are wall clock on this machine.

| When | Observation | Consequence for an automation tier |
|---|---|---|
| 10:0x | Clicks posted by the generic desktop-control tool are ignored by OOTP's custom UI (the cursor moves, nothing happens). Hardware-level SendInput from a helper process works. | A product would need its own input injector, not a stock automation library. |
| 10:0x | OOTP exposes no accessibility tree: no control names, no text, no hit targets. Every step needs a screenshot and pixel coordinates. | Recipes are tied to one resolution, one skin, one language, one font setting. |
| 10:1x | SetForegroundWindow from the helper fails whenever another app owns the foreground; needed three fallback techniques (AttachThreadInput, SwitchToThisWindow, ALT tap) plus the desktop tool's own "open application" to get OOTP in front. | Any other app the user touches mid-run breaks the sequence. |
| 10:2x | The assistant's own window is topmost and covers the right 40 percent of the screen (logical x >= 999). Clicks there land on the assistant, not OOTP. Added a WindowFromPoint guard that refuses such clicks. | Screen real estate must be reserved for the game; a topmost helper window is incompatible with full-screen OOTP. |
| 10:2x | Escape does not close an open OOTP dropdown; a click on empty page space does. | No keyboard shortcuts to lean on; every dismissal is a positioned click. |
